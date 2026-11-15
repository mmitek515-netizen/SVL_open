import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SVL_GITHUB_REPOSITORY = 'mmitek515-netizen/SVL_open';
export const DEFAULT_GITHUB_SYNC_BRANCH = 'svl-sync';
export const MAX_GITHUB_SYNC_FILE_BYTES = 128 * 1024;

type GitHubApiResult = {
  status: number;
  ok: boolean;
  data: any;
};

type GitHubTreeFile = {
  sha: string;
  size: number;
};

type WorkspaceFile = GitHubTreeFile & {
  content: string;
};

type WorkspaceSnapshot = {
  files: Map<string, WorkspaceFile>;
  headFiles: Map<string, string>;
  headCommit?: string;
};

type BranchSnapshot = {
  commitSha: string;
  files: Map<string, GitHubTreeFile>;
};

export class GitHubSyncError extends Error {}

export function isAllowedGithubSyncPath(rawPath: string): boolean {
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

function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function scanWorkspace(rootPath: string): Promise<WorkspaceSnapshot> {
  const root = path.resolve(rootPath);
  const files = new Map<string, WorkspaceFile>();
  const headFiles = new Map<string, string>();
  let headCommit: string | undefined;
  try {
    headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!/^[a-f0-9]{40}$/i.test(headCommit)) headCommit = undefined;
    if (headCommit) {
      const output = execFileSync('git', ['ls-tree', '-rz', '--full-tree', 'HEAD'], {
        cwd: root,
        timeout: 5000,
        maxBuffer: 20 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString('utf8');
      for (const record of output.split('\0')) {
        const separator = record.indexOf('\t');
        if (separator < 0) continue;
        const metadata = record.slice(0, separator).split(' ');
        const filePath = record.slice(separator + 1);
        if (metadata[1] === 'blob' && isAllowedGithubSyncPath(filePath)) {
          headFiles.set(filePath, metadata[2]);
        }
      }
    }
  } catch {
    headCommit = undefined;
    headFiles.clear();
  }

  const skippedDirectories = new Set([
    '.git',
    '.github',
    'node_modules',
    'dist',
    'build',
    'coverage',
    'data',
    '__pycache__',
    '.venv',
    'venv',
    'env',
    '.tox',
    '.cache',
    '.mypy_cache',
    '.pytest_cache',
    '.ruff_cache',
    '__pypackages__',
  ]);
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name.toLowerCase())) await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const filePath = path.relative(root, absolutePath).split(path.sep).join('/');
      if (!isAllowedGithubSyncPath(filePath)) continue;
      const stat = await fs.stat(absolutePath);
      if (stat.size > MAX_GITHUB_SYNC_FILE_BYTES) {
        files.set(filePath, { sha: '', size: stat.size, content: '' });
        continue;
      }
      const content = await fs.readFile(absolutePath, 'utf8');
      files.set(filePath, {
        sha: gitBlobSha(content),
        size: Buffer.byteLength(content, 'utf8'),
        content,
      });
    }
  };

  await visit(root);
  return { files, headFiles, headCommit };
}

export class GitHubSyncService {
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
    this.branch = options.branch || DEFAULT_GITHUB_SYNC_BRANCH;
    this.fetcher = options.fetcher || fetch;

    if (this.repository !== SVL_GITHUB_REPOSITORY) {
      throw new GitHubSyncError(`Repository sync is restricted to ${SVL_GITHUB_REPOSITORY}.`);
    }
    if (
      !/^[A-Za-z0-9._/-]{1,100}$/.test(this.branch) ||
      this.branch.startsWith('/') ||
      this.branch.endsWith('/') ||
      this.branch.includes('..') ||
      ['main', 'master'].includes(this.branch.toLowerCase())
    ) {
      throw new GitHubSyncError('Invalid GitHub sync branch name.');
    }
  }

  private async request(
    path: string,
    init: RequestInit = {},
    allowPublic = false,
  ): Promise<GitHubApiResult> {
    if (!this.token && !allowPublic) {
      throw new GitHubSyncError('GitHub sync is unavailable: GITHUB_TOKEN is not configured on the server.');
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'SVL-Python-OS-Sync',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

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
        throw new GitHubSyncError(`GitHub API returned invalid JSON (${response.status}).`);
      }
    }
    return { status: response.status, ok: response.ok, data };
  }

  private async ensureBranch(): Promise<string> {
    const repoResult = await this.request(`/repos/${this.repository}`);
    if (!repoResult.ok) {
      throw new GitHubSyncError(`Cannot read repository metadata (GitHub API ${repoResult.status}).`);
    }
    const defaultBranch = String(repoResult.data?.default_branch || '');
    if (!defaultBranch) throw new GitHubSyncError('GitHub repository has no default branch.');
    if (this.branch === defaultBranch) {
      throw new GitHubSyncError('The sync branch must be different from the repository default branch.');
    }

    let syncBranch = await this.request(
      `/repos/${this.repository}/branches/${encodeURIComponent(this.branch)}`,
    );
    if (syncBranch.status === 404) {
      const sourceBranch = await this.request(
        `/repos/${this.repository}/branches/${encodeURIComponent(defaultBranch)}`,
      );
      if (!sourceBranch.ok) {
        throw new GitHubSyncError(`Cannot read default branch (GitHub API ${sourceBranch.status}).`);
      }
      const created = await this.request(`/repos/${this.repository}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({
          ref: `refs/heads/${this.branch}`,
          sha: sourceBranch.data?.commit?.sha,
        }),
      });
      if (!created.ok && created.status !== 422) {
        throw new GitHubSyncError(`Cannot create sync branch (GitHub API ${created.status}).`);
      }
      syncBranch = await this.request(
        `/repos/${this.repository}/branches/${encodeURIComponent(this.branch)}`,
      );
    }
    if (!syncBranch.ok) {
      throw new GitHubSyncError(`Cannot read sync branch (GitHub API ${syncBranch.status}).`);
    }
    return defaultBranch;
  }

  async syncDefaultBranch(): Promise<{ repository: string; branch: string; defaultBranch: string }> {
    const defaultBranch = await this.ensureBranch();
    const merge = await this.request(`/repos/${this.repository}/merges`, {
      method: 'POST',
      body: JSON.stringify({
        base: this.branch,
        head: defaultBranch,
        commit_message: `Sync ${defaultBranch} into ${this.branch}`,
      }),
    });
    if (!merge.ok && merge.status !== 204) {
      if (merge.status === 409) {
        throw new GitHubSyncError(
          `Merge conflict: ${defaultBranch} was not merged into ${this.branch}; no changes were overwritten.`,
        );
      }
      throw new GitHubSyncError(`Cannot sync default branch (GitHub API ${merge.status}).`);
    }
    return {
      repository: this.repository,
      branch: this.branch,
      defaultBranch,
    };
  }

  private async getBranchTree(branch: string, allowPublic = false): Promise<BranchSnapshot> {
    const branchResult = await this.request(
      `/repos/${this.repository}/branches/${encodeURIComponent(branch)}`,
      {},
      allowPublic,
    );
    if (!branchResult.ok) {
      throw new GitHubSyncError(`Cannot read ${branch} branch (GitHub API ${branchResult.status}).`);
    }
    const commitSha = String(branchResult.data?.commit?.sha || '');
    if (!commitSha) throw new GitHubSyncError(`GitHub returned no commit for ${branch}.`);

    const treeResult = await this.request(
      `/repos/${this.repository}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`,
      {},
      allowPublic,
    );
    if (!treeResult.ok) {
      throw new GitHubSyncError(`Cannot read ${branch} tree (GitHub API ${treeResult.status}).`);
    }
    if (treeResult.data?.truncated) {
      throw new GitHubSyncError(`GitHub returned a truncated tree for ${branch}; sync was stopped.`);
    }

    const files = new Map<string, GitHubTreeFile>();
    for (const entry of Array.isArray(treeResult.data?.tree) ? treeResult.data.tree : []) {
      const filePath = String(entry?.path || '');
      if (
        entry?.type !== 'blob' ||
        !isAllowedGithubSyncPath(filePath) ||
        !/^[a-f0-9]{40}$/i.test(String(entry?.sha || ''))
      ) {
        continue;
      }
      files.set(filePath, {
        sha: String(entry.sha),
        size: entry.mode === '120000'
          ? MAX_GITHUB_SYNC_FILE_BYTES + 1
          : Number(entry.size || 0),
      });
    }
    return { commitSha, files };
  }

  private async compareLocalHeadToDefault(
    localHead: string | undefined,
    defaultHead: string,
  ): Promise<'same' | 'default_ahead' | 'local_ahead' | 'diverged' | 'unknown'> {
    if (!localHead) return 'unknown';
    if (localHead === defaultHead) return 'same';

    const comparison = await this.request(
      `/repos/${this.repository}/compare/${encodeURIComponent(localHead)}...${encodeURIComponent(defaultHead)}`,
    );
    if (comparison.status === 404) return 'unknown';
    if (!comparison.ok) {
      throw new GitHubSyncError(`Cannot compare local and default branches (GitHub API ${comparison.status}).`);
    }
    switch (comparison.data?.status) {
      case 'identical':
        return 'same';
      case 'ahead':
        return 'default_ahead';
      case 'behind':
        return 'local_ahead';
      case 'diverged':
        return 'diverged';
      default:
        return 'unknown';
    }
  }

  private async readBlob(filePath: string, entry: GitHubTreeFile, allowPublic = false): Promise<string> {
    if (entry.size > MAX_GITHUB_SYNC_FILE_BYTES) {
      throw new GitHubSyncError(`File ${filePath} exceeds the ${MAX_GITHUB_SYNC_FILE_BYTES}-byte sync limit.`);
    }
    const result = await this.request(
      `/repos/${this.repository}/git/blobs/${encodeURIComponent(entry.sha)}`,
      {},
      allowPublic,
    );
    if (!result.ok) {
      throw new GitHubSyncError(`Cannot read ${filePath} blob (GitHub API ${result.status}).`);
    }
    if (result.data?.encoding !== 'base64' || typeof result.data?.content !== 'string') {
      throw new GitHubSyncError(`GitHub did not return ${filePath} as a base64 blob.`);
    }
    const bytes = Buffer.from(result.data.content.replace(/\s/g, ''), 'base64');
    if (bytes.byteLength > MAX_GITHUB_SYNC_FILE_BYTES) {
      throw new GitHubSyncError(`File ${filePath} exceeds the ${MAX_GITHUB_SYNC_FILE_BYTES}-byte sync limit.`);
    }
    const content = bytes.toString('utf8');
    if (containsLikelySecret(content)) {
      throw new GitHubSyncError(`File ${filePath} appears to contain a secret and was not synced.`);
    }
    return content;
  }

  private async getSyncBranchFileSha(filePath: string): Promise<string | undefined> {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const existing = await this.request(
      `/repos/${this.repository}/contents/${encodedPath}?ref=${encodeURIComponent(this.branch)}`,
    );
    if (existing.status === 404) return undefined;
    if (!existing.ok) {
      throw new GitHubSyncError(`Cannot check ${filePath} (GitHub API ${existing.status}).`);
    }
    return typeof existing.data?.sha === 'string' ? existing.data.sha : undefined;
  }

  private async updateFileOnSyncBranch(
    filePath: string,
    content: string,
    expectedSha: string | undefined,
  ): Promise<void> {
    if (!isAllowedGithubSyncPath(filePath)) {
      throw new GitHubSyncError('File path is not allowed for GitHub sync.');
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_GITHUB_SYNC_FILE_BYTES) {
      throw new GitHubSyncError(`File exceeds the ${MAX_GITHUB_SYNC_FILE_BYTES}-byte sync limit.`);
    }
    if (containsLikelySecret(content)) {
      throw new GitHubSyncError('File content appears to contain a secret; it was not sent to GitHub.');
    }

    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const existing = await this.request(
      `/repos/${this.repository}/contents/${encodedPath}?ref=${encodeURIComponent(this.branch)}`,
    );
    if (!existing.ok && existing.status !== 404) {
      throw new GitHubSyncError(`Cannot check existing file (GitHub API ${existing.status}).`);
    }
    if (
      (existing.ok && existing.data?.sha !== expectedSha) ||
      (!existing.ok && expectedSha !== undefined)
    ) {
      throw new GitHubSyncError(`Cannot update ${filePath}: the file changed concurrently; retry on the next sync.`);
    }
    const updated = await this.request(`/repos/${this.repository}/contents/${encodedPath}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `SVL auto sync: update ${filePath}`,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch: this.branch,
        ...(existing.ok && existing.data?.sha ? { sha: existing.data.sha } : {}),
      }),
    });
    if (!updated.ok) {
      throw new GitHubSyncError(
        `Cannot update ${filePath}: ${updated.status === 409 || updated.status === 422 ? 'the file changed concurrently; retry on the next sync.' : `GitHub API ${updated.status}.`}`,
      );
    }
  }

  private async deleteFileOnSyncBranch(filePath: string, expectedSha: string): Promise<void> {
    if (!isAllowedGithubSyncPath(filePath)) {
      throw new GitHubSyncError('File path is not allowed for GitHub sync.');
    }
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const existing = await this.request(
      `/repos/${this.repository}/contents/${encodedPath}?ref=${encodeURIComponent(this.branch)}`,
    );
    if (existing.status === 404) return;
    if (!existing.ok || !existing.data?.sha) {
      throw new GitHubSyncError(`Cannot check existing file (GitHub API ${existing.status}).`);
    }
    if (existing.data.sha !== expectedSha) {
      throw new GitHubSyncError(`Cannot delete ${filePath}: the file changed concurrently; retry on the next sync.`);
    }
    const deleted = await this.request(`/repos/${this.repository}/contents/${encodedPath}`, {
      method: 'DELETE',
      body: JSON.stringify({
        message: `SVL auto sync: delete ${filePath}`,
        sha: existing.data.sha,
        branch: this.branch,
      }),
    });
    if (!deleted.ok) {
      throw new GitHubSyncError(
        `Cannot delete ${filePath}: ${deleted.status === 409 || deleted.status === 422 ? 'the file changed concurrently; retry on the next sync.' : `GitHub API ${deleted.status}.`}`,
      );
    }
  }

  async syncWorkspace(rootPath: string, options: {applyRemoteChanges?: boolean} = {}): Promise<{
    repository: string;
    branch: string;
    defaultBranch: string;
    uploaded: string[];
    downloaded: string[];
    deletedLocally: string[];
    deletedRemotely: string[];
    conflicts: string[];
    skipped: string[];
  }> {
    // Automatic workspace sync must not merge branch histories or modify source files.
    const defaultBranch = await this.ensureBranch();
    const [baseSnapshot, remoteSnapshot, localSnapshot] = await Promise.all([
      this.getBranchTree(defaultBranch),
      this.getBranchTree(this.branch),
      scanWorkspace(rootPath),
    ]);
    const relation = await this.compareLocalHeadToDefault(
      localSnapshot.headCommit,
      baseSnapshot.commitSha,
    );
    const baseFiles = baseSnapshot.files;
    const remoteFiles = remoteSnapshot.files;
    const localFiles = localSnapshot.files;
    const root = path.resolve(rootPath);
    const uploaded: string[] = [];
    const downloaded: string[] = [];
    const deletedLocally: string[] = [];
    const deletedRemotely: string[] = [];
    const conflicts: string[] = [];
    const skipped: string[] = [];
    const allPaths = new Set([...baseFiles.keys(), ...remoteFiles.keys(), ...localFiles.keys()]);

    for (const filePath of allPaths) {
      const base = baseFiles.get(filePath);
      const remote = remoteFiles.get(filePath);
      const local = localFiles.get(filePath);
      const baseSha = base?.sha;
      const remoteSha = remote?.sha;
      const localSha = local?.sha;
      const headSha = localSnapshot.headFiles.get(filePath);
      const localIsClean = localSha === headSha;
      if (
        (base?.size ?? 0) > MAX_GITHUB_SYNC_FILE_BYTES ||
        (remote?.size ?? 0) > MAX_GITHUB_SYNC_FILE_BYTES ||
        (local?.size ?? 0) > MAX_GITHUB_SYNC_FILE_BYTES
      ) {
        skipped.push(filePath);
        continue;
      }
      if (localSha === remoteSha) continue;

      if (
        localIsClean &&
        relation === 'default_ahead'
      ) {
        if (!options.applyRemoteChanges) {
          skipped.push(filePath);
          continue;
        }
        const absolutePath = path.resolve(root, filePath);
        if (!absolutePath.startsWith(`${root}${path.sep}`)) {
          skipped.push(filePath);
          continue;
        }
        try {
          const currentContent = await fs.readFile(absolutePath, 'utf8');
          if (gitBlobSha(currentContent) !== localSha) {
            conflicts.push(filePath);
            continue;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || localSha !== undefined) throw error;
        }

        if (!remote) {
          if (localSha !== undefined) {
            if (await this.getSyncBranchFileSha(filePath) !== undefined) {
              conflicts.push(filePath);
              continue;
            }
            await fs.unlink(absolutePath);
            deletedLocally.push(filePath);
          }
          continue;
        }
        try {
          if (await this.getSyncBranchFileSha(filePath) !== remoteSha) {
            conflicts.push(filePath);
            continue;
          }
          const content = await this.readBlob(filePath, remote);
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          await fs.writeFile(absolutePath, content, 'utf8');
          downloaded.push(filePath);
        } catch (error) {
          if (error instanceof GitHubSyncError && /appears to contain a secret/.test(error.message)) {
            skipped.push(filePath);
            continue;
          }
          throw error;
        }
        continue;
      }

      if (
        localIsClean &&
        (relation === 'diverged' || relation === 'unknown') &&
        localSha !== baseSha
      ) {
        conflicts.push(filePath);
        continue;
      }

      if (
        relation === 'unknown' &&
        baseSha !== undefined &&
        localSha !== baseSha
      ) {
        conflicts.push(filePath);
        continue;
      }

      if (localSha === baseSha) {
        if (!options.applyRemoteChanges) {
          skipped.push(filePath);
          continue;
        }
        const absolutePath = path.resolve(root, filePath);
        if (!absolutePath.startsWith(`${root}${path.sep}`)) {
          skipped.push(filePath);
          continue;
        }
        try {
          const currentContent = await fs.readFile(absolutePath, 'utf8');
          if (gitBlobSha(currentContent) !== localSha) {
            conflicts.push(filePath);
            continue;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || localSha !== undefined) throw error;
        }

        if (!remote) {
          if (localSha !== undefined) {
            if (await this.getSyncBranchFileSha(filePath) !== undefined) {
              conflicts.push(filePath);
              continue;
            }
            await fs.unlink(absolutePath);
            deletedLocally.push(filePath);
          }
          continue;
        }
        try {
          if (await this.getSyncBranchFileSha(filePath) !== remoteSha) {
            conflicts.push(filePath);
            continue;
          }
          const content = await this.readBlob(filePath, remote);
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          await fs.writeFile(absolutePath, content, 'utf8');
          downloaded.push(filePath);
        } catch (error) {
          if (error instanceof GitHubSyncError && /appears to contain a secret/.test(error.message)) {
            skipped.push(filePath);
            continue;
          }
          throw error;
        }
        continue;
      }

      if (remoteSha === baseSha) {
        const absolutePath = path.resolve(root, filePath);
        if (!absolutePath.startsWith(`${root}${path.sep}`)) {
          skipped.push(filePath);
          continue;
        }
        if (!local) {
          if (!remoteSha) {
            conflicts.push(filePath);
            continue;
          }
          try {
            await this.deleteFileOnSyncBranch(filePath, remoteSha);
            deletedRemotely.push(filePath);
          } catch (error) {
            if (error instanceof GitHubSyncError && error.message.includes('changed concurrently')) {
              conflicts.push(filePath);
              continue;
            }
            throw error;
          }
          continue;
        }
        const latestContent = await fs.readFile(absolutePath, 'utf8');
        if (gitBlobSha(latestContent) !== localSha) {
          conflicts.push(filePath);
          continue;
        }
        if (containsLikelySecret(local.content)) {
          skipped.push(filePath);
          continue;
        }
        try {
          await this.updateFileOnSyncBranch(filePath, local.content, remoteSha);
          uploaded.push(filePath);
        } catch (error) {
          if (error instanceof GitHubSyncError && error.message.includes('changed concurrently')) {
            conflicts.push(filePath);
            continue;
          }
          throw error;
        }
        continue;
      }

      conflicts.push(filePath);
    }

    return {
      repository: this.repository,
      branch: this.branch,
      defaultBranch,
      uploaded,
      downloaded,
      deletedLocally,
      deletedRemotely,
      conflicts,
      skipped,
    };
  }

  async readFile(rawPath: string): Promise<{ path: string; branch: string; content: string }> {
    const filePath = String(rawPath || '').trim();
    if (!isAllowedGithubSyncPath(filePath)) {
      throw new GitHubSyncError('File path is not allowed for GitHub sync.');
    }
    await this.ensureBranch();

    const file = await this.request(
      `/repos/${this.repository}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.branch)}`,
    );
    if (!file.ok) throw new GitHubSyncError(`Cannot read ${filePath} (GitHub API ${file.status}).`);
    if (Number(file.data?.size || 0) > MAX_GITHUB_SYNC_FILE_BYTES) {
      throw new GitHubSyncError(`File exceeds the ${MAX_GITHUB_SYNC_FILE_BYTES}-byte sync limit.`);
    }
    if (file.data?.encoding !== 'base64' || typeof file.data?.content !== 'string') {
      throw new GitHubSyncError(`GitHub did not return ${filePath} as a base64 file.`);
    }
    const content = Buffer.from(file.data.content.replace(/\s/g, ''), 'base64').toString('utf8');
    if (containsLikelySecret(content)) {
      throw new GitHubSyncError(`File ${filePath} appears to contain a secret and was not read into chat.`);
    }
    return {
      path: filePath,
      branch: this.branch,
      content,
    };
  }

  async updateFile(
    rawPath: string,
    content: string,
    commitMessage = '',
  ): Promise<{ path: string; branch: string; commitSha: string }> {
    const filePath = String(rawPath || '').trim();
    const fileContent = String(content ?? '');
    if (!isAllowedGithubSyncPath(filePath)) {
      throw new GitHubSyncError('File path is not allowed for GitHub sync.');
    }
    if (Buffer.byteLength(fileContent, 'utf8') > MAX_GITHUB_SYNC_FILE_BYTES) {
      throw new GitHubSyncError(`File exceeds the ${MAX_GITHUB_SYNC_FILE_BYTES}-byte sync limit.`);
    }
    if (containsLikelySecret(fileContent)) {
      throw new GitHubSyncError('File content appears to contain a secret; it was not sent to GitHub.');
    }

    await this.ensureBranch();
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const existing = await this.request(
      `/repos/${this.repository}/contents/${encodedPath}?ref=${encodeURIComponent(this.branch)}`,
    );
    if (!existing.ok && existing.status !== 404) {
      throw new GitHubSyncError(`Cannot check existing file (GitHub API ${existing.status}).`);
    }

    const message = String(commitMessage || `SVL chat sync: update ${filePath}`)
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
      throw new GitHubSyncError(`Cannot update ${filePath}: ${detail}`);
    }
    return {
      path: filePath,
      branch: this.branch,
      commitSha: String(updated.data?.commit?.sha || ''),
    };
  }

  private static readonly mirrorLocks = new Map<string, Promise<any>>();

  private async ensurePublicGitMirrorBranch(cleanBranch: string): Promise<{
    mirrorDir: string;
    refName: string;
    commitSha: string;
    files: Map<string, GitHubTreeFile>;
    recentCommits: Array<{ sha: string; message: string; date: string; author: string }>;
  }> {
    const safeRepo = this.repository.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeBranch = cleanBranch.replace(/[^a-zA-Z0-9_-]/g, '_');
    const mirrorDir = path.join(os.tmpdir(), `svl-github-mirror-${safeRepo}-${safeBranch}`);
    const previous = GitHubSyncService.mirrorLocks.get(mirrorDir) || Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      await fs.mkdir(mirrorDir, { recursive: true });
      const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      try {
        await fs.access(path.join(mirrorDir, 'HEAD'));
      } catch {
        await execFileAsync('git', ['init', '--bare', mirrorDir], { timeout: 10000, env: gitEnv });
      }
      const refName = `refs/remotes/origin/${cleanBranch}`;
      const remoteUrl = `https://github.com/${this.repository}.git`;
      await execFileAsync(
        'git',
        ['-C', mirrorDir, 'fetch', '--depth=5', remoteUrl, `+refs/heads/${cleanBranch}:${refName}`],
        { timeout: 30000, env: gitEnv },
      );

      const { stdout: shaOut } = await execFileAsync(
        'git',
        ['-C', mirrorDir, 'rev-parse', refName],
        { timeout: 5000, env: gitEnv },
      );
      const commitSha = shaOut.trim();

    const { stdout: logOut } = await execFileAsync(
      'git',
      ['-C', mirrorDir, 'log', '-n', '5', '--format=%H%x1f%s%x1f%cI%x1f%an', refName],
      { timeout: 5000, env: gitEnv },
    );
    const recentCommits = logOut
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha = '', message = '', date = '', author = 'GitHub'] = line.split('\x1f');
        return {
          sha: sha.trim(),
          message: message.trim().slice(0, 140),
          date: date.trim(),
          author: author.trim() || 'GitHub',
        };
      });

    const { stdout: treeOut } = await execFileAsync(
      'git',
      ['-C', mirrorDir, 'ls-tree', '-rz', '--long', refName],
      { timeout: 10000, maxBuffer: 20 * 1024 * 1024, env: gitEnv },
    );
    const files = new Map<string, GitHubTreeFile>();
    for (const record of treeOut.split('\0')) {
      const sep = record.indexOf('\t');
      if (sep < 0) continue;
      const metaParts = record.slice(0, sep).trim().split(/\s+/);
      const mode = metaParts[0] || '';
      const objType = metaParts[1] || '';
      const sha = metaParts[2] || '';
      const rawSize = metaParts[3] || '0';
      const filePath = record.slice(sep + 1);
      if (objType !== 'blob' || !isAllowedGithubSyncPath(filePath) || !/^[a-f0-9]{40}$/i.test(sha)) {
        continue;
      }
      const parsedSize = mode === '120000'
        ? MAX_GITHUB_SYNC_FILE_BYTES + 1
        : Number(rawSize === '-' ? 0 : rawSize);
      files.set(filePath, { sha, size: parsedSize });
    }

      return { mirrorDir, refName, commitSha, files, recentCommits };
    });
    GitHubSyncService.mirrorLocks.set(mirrorDir, run);
    return run;
  }

  private async readGitMirrorBlob(mirrorDir: string, filePath: string, entry: GitHubTreeFile): Promise<string> {
    if (entry.size > MAX_GITHUB_SYNC_FILE_BYTES) {
      throw new GitHubSyncError(`File ${filePath} exceeds the ${MAX_GITHUB_SYNC_FILE_BYTES}-byte sync limit.`);
    }
    const { stdout } = await execFileAsync(
      'git',
      ['-C', mirrorDir, 'cat-file', 'blob', entry.sha],
      { encoding: 'buffer', timeout: 10000, maxBuffer: MAX_GITHUB_SYNC_FILE_BYTES * 2 },
    );
    const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout), 'utf8');
    if (bytes.byteLength > MAX_GITHUB_SYNC_FILE_BYTES) {
      throw new GitHubSyncError(`File ${filePath} exceeds the ${MAX_GITHUB_SYNC_FILE_BYTES}-byte sync limit.`);
    }
    const content = bytes.toString('utf8');
    if (containsLikelySecret(content)) {
      throw new GitHubSyncError(`File ${filePath} appears to contain a secret and was not synced.`);
    }
    return content;
  }

  async inspectRemoteChanges(
    rootPath: string,
    targetBranch = 'main',
  ): Promise<{
    repository: string;
    branch: string;
    commitSha: string;
    recentCommits: Array<{ sha: string; message: string; date: string; author: string }>;
    remoteOnly: string[];
    differing: string[];
    localOnly: string[];
    matchingCount: number;
  }> {
    const cleanBranch = String(targetBranch || 'main').trim() || 'main';
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(cleanBranch) || cleanBranch.includes('..')) {
      throw new GitHubSyncError('Nieprawidłowa nazwa gałęzi GitHub.');
    }

    const localSnapshot = await scanWorkspace(rootPath);
    let remoteCommitSha = '';
    let remoteFiles = new Map<string, GitHubTreeFile>();
    let recentCommits: Array<{ sha: string; message: string; date: string; author: string }> = [];

    const useDirectGitMirror = !this.token && this.fetcher === fetch;
    if (useDirectGitMirror) {
      const mirror = await this.ensurePublicGitMirrorBranch(cleanBranch);
      remoteCommitSha = mirror.commitSha;
      remoteFiles = mirror.files;
      recentCommits = mirror.recentCommits;
    } else {
      try {
        const [remoteSnapshot, commitsRes] = await Promise.all([
          this.getBranchTree(cleanBranch, true),
          this.request(
            `/repos/${this.repository}/commits?sha=${encodeURIComponent(cleanBranch)}&per_page=5`,
            {},
            true,
          ),
        ]);
        remoteCommitSha = remoteSnapshot.commitSha;
        remoteFiles = remoteSnapshot.files;
        recentCommits = Array.isArray(commitsRes.data)
          ? commitsRes.data.slice(0, 5).map((item: any) => ({
              sha: String(item?.sha || ''),
              message: String(item?.commit?.message || '').split(/\r?\n/)[0].slice(0, 140),
              date: String(item?.commit?.committer?.date || item?.commit?.author?.date || ''),
              author: String(item?.commit?.author?.name || item?.author?.login || 'GitHub'),
            }))
          : [];
      } catch (err) {
        if (this.fetcher === fetch) {
          const mirror = await this.ensurePublicGitMirrorBranch(cleanBranch);
          remoteCommitSha = mirror.commitSha;
          remoteFiles = mirror.files;
          recentCommits = mirror.recentCommits;
        } else {
          throw err;
        }
      }
    }

    const remoteOnly: string[] = [];
    const differing: string[] = [];
    const localOnly: string[] = [];
    let matchingCount = 0;

    for (const [filePath, remoteEntry] of remoteFiles.entries()) {
      const localEntry = localSnapshot.files.get(filePath);
      if (!localEntry) {
        remoteOnly.push(filePath);
      } else if (localEntry.sha !== remoteEntry.sha) {
        differing.push(filePath);
      } else {
        matchingCount += 1;
      }
    }
    for (const filePath of localSnapshot.files.keys()) {
      if (!remoteFiles.has(filePath)) {
        localOnly.push(filePath);
      }
    }

    return {
      repository: this.repository,
      branch: cleanBranch,
      commitSha: remoteCommitSha,
      recentCommits,
      remoteOnly: remoteOnly.sort(),
      differing: differing.sort(),
      localOnly: localOnly.sort(),
      matchingCount,
    };
  }

  async pullRemoteChanges(
    rootPath: string,
    options: { branch?: string; paths?: string[]; includeRemoteOnlyOnly?: boolean } = {},
  ): Promise<{
    repository: string;
    branch: string;
    commitSha: string;
    downloaded: string[];
    skipped: string[];
  }> {
    const cleanBranch = String(options.branch || 'main').trim() || 'main';
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(cleanBranch) || cleanBranch.includes('..')) {
      throw new GitHubSyncError('Nieprawidłowa nazwa gałęzi GitHub.');
    }
    const root = path.resolve(rootPath);
    const localSnapshot = await scanWorkspace(root);

    let remoteCommitSha = '';
    let remoteFiles = new Map<string, GitHubTreeFile>();
    let mirrorDir: string | null = null;

    const useDirectGitMirror = !this.token && this.fetcher === fetch;
    if (useDirectGitMirror) {
      const mirror = await this.ensurePublicGitMirrorBranch(cleanBranch);
      mirrorDir = mirror.mirrorDir;
      remoteCommitSha = mirror.commitSha;
      remoteFiles = mirror.files;
    } else {
      try {
        const remoteSnapshot = await this.getBranchTree(cleanBranch, true);
        remoteCommitSha = remoteSnapshot.commitSha;
        remoteFiles = remoteSnapshot.files;
      } catch (err) {
        if (this.fetcher === fetch) {
          const mirror = await this.ensurePublicGitMirrorBranch(cleanBranch);
          mirrorDir = mirror.mirrorDir;
          remoteCommitSha = mirror.commitSha;
          remoteFiles = mirror.files;
        } else {
          throw err;
        }
      }
    }

    const explicitPaths = Array.isArray(options.paths) && options.paths.length > 0
      ? new Set(options.paths.map((p) => String(p).trim()).filter(Boolean))
      : null;

    const downloaded: string[] = [];
    const skipped: string[] = [];

    for (const [filePath, remoteEntry] of remoteFiles.entries()) {
      if (explicitPaths && !explicitPaths.has(filePath)) continue;
      if (!isAllowedGithubSyncPath(filePath)) {
        skipped.push(filePath);
        continue;
      }
      if (remoteEntry.size > MAX_GITHUB_SYNC_FILE_BYTES) {
        skipped.push(filePath);
        continue;
      }
      const localEntry = localSnapshot.files.get(filePath);
      if (localEntry && localEntry.sha === remoteEntry.sha) continue;
      if (options.includeRemoteOnlyOnly && localEntry && !explicitPaths) {
        skipped.push(filePath);
        continue;
      }
      const absolutePath = path.resolve(root, filePath);
      if (!absolutePath.startsWith(`${root}${path.sep}`)) {
        skipped.push(filePath);
        continue;
      }
      try {
        const content = mirrorDir
          ? await this.readGitMirrorBlob(mirrorDir, filePath, remoteEntry)
          : await this.readBlob(filePath, remoteEntry, true);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, content, 'utf8');
        downloaded.push(filePath);
      } catch (error) {
        if (error instanceof GitHubSyncError && /appears to contain a secret/.test(error.message)) {
          skipped.push(filePath);
          continue;
        }
        throw error;
      }
    }

    return {
      repository: this.repository,
      branch: cleanBranch,
      commitSha: remoteCommitSha,
      downloaded,
      skipped,
    };
  }
}
