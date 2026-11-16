import { Buffer } from 'node:buffer';

export const SVL_GITHUB_REPOSITORY = 'mmitek515-netizen/SVL_open';
export const DEFAULT_GITHUB_FILE_BRANCH = 'svl-sync';
export const MAX_GITHUB_FILE_BYTES = 128 * 1024;

type GitHubApiResult = {
  status: number;
  ok: boolean;
  data: any;
};

export class GitHubFileError extends Error {}

export function isAllowedGitHubFilePath(rawPath: string): boolean {
  const filePath = String(rawPath || '').trim();
  if (!filePath || filePath.startsWith('/') || filePath.includes('\\')) return false;

  const parts = filePath.split('/');
  if (
    parts.some((part) => !part || part === '.' || part === '..') ||
    parts.some((part) =>
      [
        '.git',
        '.github',
        '.venv',
        '.tox',
        '.cache',
        '.mypy_cache',
        '.pytest_cache',
        '.ruff_cache',
        '__pycache__',
        '__pypackages__',
        'build',
        'coverage',
        'data',
        'dist',
        'env',
        'node_modules',
        'venv',
      ].includes(part.toLowerCase()),
    )
  ) {
    return false;
  }

  const lowerPath = filePath.toLowerCase();
  const basename = parts[parts.length - 1].toLowerCase();
  if (
    basename === '.env' ||
    (basename.startsWith('.env.') && basename !== '.env.example') ||
    basename === 'bun.lockb' ||
    /(?:secret|credential|private.?key|password|token)/i.test(basename)
  ) {
    return false;
  }

  return (
    basename === '.env.example' ||
    /^dockerfile(?:\.[a-z0-9._-]+)?$/i.test(basename) ||
    /\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|css|html|md|ya?ml|toml|sh|service|lock|svg)$/i.test(lowerPath)
  );
}

export function containsLikelySecret(content: string): boolean {
  const credentialAssignments = content.matchAll(
    /(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\s*[:=]\s*(['"])(?!\$\{)([^'"\r\n]{8,})\1/gi,
  );
  const hasNonPlaceholderCredential = Array.from(credentialAssignments).some((match) => {
    const value = match[2].trim();
    return !/^(?:<[^>]+>|\$\{[^}]+\}|(?:your|my|change|replace|example|placeholder|redacted)(?:[_-]|$))/i.test(
      value,
    );
  });
  return (
    /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/i.test(content) ||
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(content) ||
    hasNonPlaceholderCredential
  );
}

export class GitHubFileService {
  private readonly apiBase = 'https://api.github.com';
  private readonly repository: string;
  private readonly branch: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(options: {
    token: string;
    repository?: string;
    branch?: string;
    fetcher?: typeof fetch;
  }) {
    this.token = String(options.token || '').trim();
    this.repository = options.repository || SVL_GITHUB_REPOSITORY;
    this.branch = options.branch || DEFAULT_GITHUB_FILE_BRANCH;
    this.fetcher = options.fetcher || fetch;

    if (this.repository !== SVL_GITHUB_REPOSITORY) {
      throw new GitHubFileError(`Repository access is restricted to ${SVL_GITHUB_REPOSITORY}.`);
    }
    if (
      !/^[A-Za-z0-9._/-]{1,100}$/.test(this.branch) ||
      this.branch.startsWith('/') ||
      this.branch.endsWith('/') ||
      this.branch.includes('..') ||
      ['main', 'master'].includes(this.branch.toLowerCase())
    ) {
      throw new GitHubFileError('Invalid GitHub file branch name.');
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<GitHubApiResult> {
    if (!this.token) {
      throw new GitHubFileError('GitHub file access is unavailable: GITHUB_TOKEN is not configured on the server.');
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'SVL-Python-OS-Files',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${this.token}`,
    };
    const response = await this.fetcher(`${this.apiBase}${path}`, {
      ...init,
      signal: AbortSignal.timeout(12000),
      headers,
    });

    const text = await response.text();
    let data: any = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new GitHubFileError(`GitHub API returned invalid JSON (${response.status}).`);
      }
    }
    return { status: response.status, ok: response.ok, data };
  }

  private async ensureFileBranch(): Promise<void> {
    const repoResult = await this.request(`/repos/${this.repository}`);
    if (!repoResult.ok) {
      throw new GitHubFileError(`Cannot read repository metadata (GitHub API ${repoResult.status}).`);
    }
    const defaultBranch = String(repoResult.data?.default_branch || '');
    if (!defaultBranch) throw new GitHubFileError('GitHub repository has no default branch.');
    if (this.branch === defaultBranch) {
      throw new GitHubFileError('The file branch must be different from the repository default branch.');
    }

    let fileBranch = await this.request(
      `/repos/${this.repository}/branches/${encodeURIComponent(this.branch)}`,
    );
    if (fileBranch.status === 404) {
      const sourceBranch = await this.request(
        `/repos/${this.repository}/branches/${encodeURIComponent(defaultBranch)}`,
      );
      if (!sourceBranch.ok) {
        throw new GitHubFileError(`Cannot read default branch (GitHub API ${sourceBranch.status}).`);
      }
      const created = await this.request(`/repos/${this.repository}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({
          ref: `refs/heads/${this.branch}`,
          sha: sourceBranch.data?.commit?.sha,
        }),
      });
      if (!created.ok && created.status !== 422) {
        throw new GitHubFileError(`Cannot create file branch (GitHub API ${created.status}).`);
      }
      fileBranch = await this.request(
        `/repos/${this.repository}/branches/${encodeURIComponent(this.branch)}`,
      );
    }
    if (!fileBranch.ok) {
      throw new GitHubFileError(`Cannot read file branch (GitHub API ${fileBranch.status}).`);
    }
  }

  async readFile(rawPath: string): Promise<{ path: string; branch: string; content: string }> {
    const filePath = String(rawPath || '').trim();
    if (!isAllowedGitHubFilePath(filePath)) {
      throw new GitHubFileError('File path is not allowed for GitHub access.');
    }

    const file = await this.request(
      `/repos/${this.repository}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.branch)}`,
    );
    if (!file.ok) throw new GitHubFileError(`Cannot read ${filePath} (GitHub API ${file.status}).`);
    if (Number(file.data?.size || 0) > MAX_GITHUB_FILE_BYTES) {
      throw new GitHubFileError(`File exceeds the ${MAX_GITHUB_FILE_BYTES}-byte limit.`);
    }
    if (file.data?.encoding !== 'base64' || typeof file.data?.content !== 'string') {
      throw new GitHubFileError(`GitHub did not return ${filePath} as a base64 file.`);
    }
    const bytes = Buffer.from(file.data.content.replace(/\s/g, ''), 'base64');
    if (bytes.byteLength > MAX_GITHUB_FILE_BYTES) {
      throw new GitHubFileError(`File exceeds the ${MAX_GITHUB_FILE_BYTES}-byte limit.`);
    }
    const content = bytes.toString('utf8');
    if (containsLikelySecret(content)) {
      throw new GitHubFileError(`File ${filePath} appears to contain a secret and was not read into chat.`);
    }
    return { path: filePath, branch: this.branch, content };
  }

  async updateFile(
    rawPath: string,
    content: string,
    commitMessage = '',
  ): Promise<{ path: string; branch: string; commitSha: string }> {
    const filePath = String(rawPath || '').trim();
    const fileContent = String(content ?? '');
    if (!isAllowedGitHubFilePath(filePath)) {
      throw new GitHubFileError('File path is not allowed for GitHub access.');
    }
    if (Buffer.byteLength(fileContent, 'utf8') > MAX_GITHUB_FILE_BYTES) {
      throw new GitHubFileError(`File exceeds the ${MAX_GITHUB_FILE_BYTES}-byte limit.`);
    }
    if (containsLikelySecret(fileContent)) {
      throw new GitHubFileError('File content appears to contain a secret; it was not sent to GitHub.');
    }

    await this.ensureFileBranch();
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const existing = await this.request(
      `/repos/${this.repository}/contents/${encodedPath}?ref=${encodeURIComponent(this.branch)}`,
    );
    if (!existing.ok && existing.status !== 404) {
      throw new GitHubFileError(`Cannot check existing file (GitHub API ${existing.status}).`);
    }

    const message = String(commitMessage || `SVL chat update: ${filePath}`)
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 120);
    const updated = await this.request(`/repos/${this.repository}/contents/${encodedPath}`, {
      method: 'PUT',
      body: JSON.stringify({
        message,
        content: Buffer.from(fileContent, 'utf8').toString('base64'),
        branch: this.branch,
        ...(existing.ok && existing.data?.sha ? { sha: existing.data.sha } : {}),
      }),
    });
    if (!updated.ok) {
      const detail = updated.status === 409 || updated.status === 422
        ? 'The file changed concurrently; retry after reading the latest version.'
        : `GitHub API ${updated.status}.`;
      throw new GitHubFileError(`Cannot update ${filePath}: ${detail}`);
    }
    return {
      path: filePath,
      branch: this.branch,
      commitSha: String(updated.data?.commit?.sha || ''),
    };
  }
}
