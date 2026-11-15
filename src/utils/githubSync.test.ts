import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  containsLikelySecret,
  GitHubSyncError,
  GitHubSyncService,
  isAllowedGithubSyncPath,
} from './githubSync';

function blobSha(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

const secretFixture = ['const apiKey = ', "'abcdefghijklmnop';"].join('');

async function initializeGitWorkspace(root: string, filePath: string, content: string): Promise<void> {
  const absolutePath = path.join(root, filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf8');
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'SVL Sync Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'svl-sync-test@example.invalid'], { cwd: root });
  execFileSync('git', ['add', filePath], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'Initial sync fixture'], { cwd: root });
}

function automaticSyncFetcher(options: {
  baseFiles: Record<string, string>;
  remoteFiles: Record<string, string>;
  requests?: Array<{ url: string; method: string; body: any }>;
}): typeof fetch {
  const requests = options.requests || [];
  const toTree = (files: Record<string, string>) =>
    Object.entries(files).map(([filePath, content]) => ({
      path: filePath,
      mode: '100644',
      type: 'blob',
      sha: blobSha(content),
      size: Buffer.byteLength(content, 'utf8'),
    }));

  return async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    requests.push({ url: String(input), method, body });

    if (url.pathname === '/repos/mmitek515-netizen/SVL_open') {
      return Response.json({ default_branch: 'main' });
    }
    if (url.pathname.endsWith('/branches/main')) {
      return Response.json({ commit: { sha: 'main-commit' } });
    }
    if (url.pathname.endsWith('/branches/svl-sync')) {
      return Response.json({ commit: { sha: 'sync-commit' } });
    }
    if (url.pathname.includes('/compare/')) {
      return Response.json({ status: 'identical' });
    }
    if (url.pathname.endsWith('/merges')) return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/git/trees/main-commit')) {
      return Response.json({ tree: toTree(options.baseFiles), truncated: false });
    }
    if (url.pathname.endsWith('/git/trees/sync-commit')) {
      return Response.json({ tree: toTree(options.remoteFiles), truncated: false });
    }
    if (url.pathname.includes('/git/blobs/')) {
      const sha = url.pathname.split('/').pop();
      const content = [...Object.values(options.baseFiles), ...Object.values(options.remoteFiles)]
        .find((candidate) => blobSha(candidate) === sha);
      if (content === undefined) return Response.json({ message: 'Not Found' }, { status: 404 });
      return Response.json({
        encoding: 'base64',
        content: Buffer.from(content, 'utf8').toString('base64'),
      });
    }
    if (url.pathname.includes('/contents/')) {
      const filePath = decodeURIComponent(url.pathname.split('/contents/')[1]);
      const existing = options.remoteFiles[filePath];
      if (method === 'GET') {
        if (existing === undefined) return Response.json({ message: 'Not Found' }, { status: 404 });
        return Response.json({ sha: blobSha(existing) });
      }
      if (method === 'PUT') return Response.json({ commit: { sha: 'write-commit' } }, { status: 201 });
      if (method === 'DELETE') return Response.json({ commit: { sha: 'delete-commit' } });
    }
    return Response.json({ message: `Unexpected request ${method} ${url}` }, { status: 500 });
  };
}

test('GitHub sync only accepts repository source paths and rejects secrets/automation files', () => {
  assert.equal(isAllowedGithubSyncPath('src/utils/svlLogic.ts'), true);
  assert.equal(isAllowedGithubSyncPath('../.env'), false);
  assert.equal(isAllowedGithubSyncPath('.env.example'), true);
  assert.equal(isAllowedGithubSyncPath('backend/.env.example'), true);
  assert.equal(isAllowedGithubSyncPath('Dockerfile'), true);
  assert.equal(isAllowedGithubSyncPath('deploy/systemd/svl-python-os.service'), true);
  assert.equal(isAllowedGithubSyncPath('.github/workflows/release.yml'), false);
  assert.equal(isAllowedGithubSyncPath('package.json'), true);
  assert.equal(isAllowedGithubSyncPath('bun.lock'), true);
  assert.equal(isAllowedGithubSyncPath('bun.lockb'), false);
  assert.equal(isAllowedGithubSyncPath('data/agent-memory.json'), false);
  assert.equal(containsLikelySecret('GEMINI_API_KEY="MY_GEMINI_API_KEY"'), false);
  assert.equal(containsLikelySecret('GEMINI_API_KEY="actual-secret-value-123"'), true);
  assert.throws(() => new GitHubSyncService({ token: 'test-token', branch: 'main' }), GitHubSyncError);
});

test('GitHub writes create/update content only on the dedicated sync branch', async () => {
  const requests: Array<{ url: string; method: string; body: any }> = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    requests.push({ url, method, body });

    if (url.endsWith('/repos/mmitek515-netizen/SVL_open')) {
      return Response.json({ default_branch: 'main' });
    }
    if (url.endsWith('/branches/svl-sync')) {
      return requests.some((request) => request.url.endsWith('/git/refs'))
        ? Response.json({ commit: { sha: 'sync-sha' } })
        : Response.json({ message: 'Not Found' }, { status: 404 });
    }
    if (url.endsWith('/branches/main')) {
      return Response.json({ commit: { sha: 'main-sha' } });
    }
    if (url.endsWith('/git/refs')) {
      return Response.json({ ref: 'refs/heads/svl-sync' }, { status: 201 });
    }
    if (url.endsWith('/merges')) {
      return Response.json({ sha: 'merge-sha' }, { status: 201 });
    }
    if (url.includes('/contents/src/utils/sample.ts?ref=svl-sync')) {
      return Response.json({ message: 'Not Found' }, { status: 404 });
    }
    if (url.endsWith('/contents/src/utils/sample.ts') && method === 'PUT') {
      return Response.json({ commit: { sha: 'commit-sha' } }, { status: 201 });
    }
    return Response.json({ message: `Unexpected request ${method} ${url}` }, { status: 500 });
  };

  const service = new GitHubSyncService({ token: 'test-token', fetcher });
  const result = await service.updateFile('src/utils/sample.ts', 'export const value = 1;');

  assert.deepEqual(result, {
    path: 'src/utils/sample.ts',
    branch: 'svl-sync',
    commitSha: 'commit-sha',
  });
  const write = requests.find((request) => request.method === 'PUT');
  assert.equal(write?.body.branch, 'svl-sync');
  assert.equal(write?.body.content, Buffer.from('export const value = 1;').toString('base64'));
  assert.equal(requests.some((request) => request.body.ref === 'refs/heads/svl-sync'), true);
});

test('GitHub sync refuses secret-bearing files before making API requests', async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests += 1;
    return Response.json({});
  };
  const service = new GitHubSyncService({ token: 'test-token', fetcher });

  await assert.rejects(
    service.updateFile('src/config.ts', secretFixture),
    GitHubSyncError,
  );
  assert.equal(requests, 0);
});

test('GitHub sync does not pass secret-bearing file content into chat', async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/repos/mmitek515-netizen/SVL_open')) {
      return Response.json({ default_branch: 'main' });
    }
    if (url.endsWith('/branches/svl-sync') || url.endsWith('/branches/main')) {
      return Response.json({ commit: { sha: 'branch-sha' } });
    }
    if (url.endsWith('/merges')) return new Response(null, { status: 204 });
    if (url.includes('/contents/src/config.ts?ref=svl-sync')) {
      return Response.json({
        size: 40,
        encoding: 'base64',
        content: Buffer.from(secretFixture).toString('base64'),
      });
    }
    return Response.json({ message: 'Unexpected request' }, { status: 500 });
  };
  const service = new GitHubSyncService({ token: 'test-token', fetcher });

  await assert.rejects(service.readFile('src/config.ts'), /appears to contain a secret/);
});

test('GitHub update rejects merge conflicts without attempting a file write', async () => {
  let writeAttempted = false;
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/repos/mmitek515-netizen/SVL_open')) {
      return Response.json({ default_branch: 'main' });
    }
    if (url.endsWith('/branches/svl-sync') || url.endsWith('/branches/main')) {
      return Response.json({ commit: { sha: 'branch-sha' } });
    }
    if (url.endsWith('/merges')) {
      return Response.json({ message: 'Conflict' }, { status: 409 });
    }
    if (init.method === 'PUT') writeAttempted = true;
    return Response.json({ message: 'Unexpected request' }, { status: 500 });
  };
  const service = new GitHubSyncService({ token: 'test-token', fetcher });

  await assert.rejects(service.updateFile('src/utils/sample.ts', 'export const value = 1;'), /Merge conflict/);
  assert.equal(writeAttempted, false);
});

test('automatic sync downloads remote-only changes into clean local files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svl-github-sync-'));
  try {
    await initializeGitWorkspace(root, 'src/sample.ts', 'export const value = 1;');
    const service = new GitHubSyncService({
      token: 'test-token',
      fetcher: automaticSyncFetcher({
        baseFiles: { 'src/sample.ts': 'export const value = 1;' },
        remoteFiles: { 'src/sample.ts': 'export const value = 2;' },
      }),
    });

    const result = await service.syncWorkspace(root);

    assert.deepEqual(result.downloaded, ['src/sample.ts']);
    assert.deepEqual(result.conflicts, []);
    assert.equal(await fs.readFile(path.join(root, 'src/sample.ts'), 'utf8'), 'export const value = 2;');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('automatic sync pulls default-branch updates instead of uploading a stale checkout', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svl-github-sync-'));
  const requests: Array<{ url: string; method: string; body: any }> = [];
  try {
    await initializeGitWorkspace(root, 'src/sample.ts', 'export const value = 1;');
    const fetcher = automaticSyncFetcher({
      baseFiles: { 'src/sample.ts': 'export const value = 2;' },
      remoteFiles: { 'src/sample.ts': 'export const value = 2;' },
      requests,
    });
    const aheadFetcher: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/compare/')) {
        requests.push({ url: String(input), method: init.method || 'GET', body: {} });
        return Response.json({ status: 'ahead' });
      }
      return fetcher(input, init);
    };
    const service = new GitHubSyncService({ token: 'test-token', fetcher: aheadFetcher });

    const result = await service.syncWorkspace(root);

    assert.deepEqual(result.downloaded, ['src/sample.ts']);
    assert.equal(requests.some((request) => request.method === 'PUT'), false);
    assert.equal(await fs.readFile(path.join(root, 'src/sample.ts'), 'utf8'), 'export const value = 2;');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('automatic sync uploads local-only changes only to the sync branch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svl-github-sync-'));
  const requests: Array<{ url: string; method: string; body: any }> = [];
  try {
    await initializeGitWorkspace(root, 'src/sample.ts', 'export const value = 1;');
    await fs.writeFile(path.join(root, 'src/sample.ts'), 'export const value = 2;', 'utf8');
    const service = new GitHubSyncService({
      token: 'test-token',
      fetcher: automaticSyncFetcher({
        baseFiles: { 'src/sample.ts': 'export const value = 1;' },
        remoteFiles: { 'src/sample.ts': 'export const value = 1;' },
        requests,
      }),
    });

    const result = await service.syncWorkspace(root);

    assert.deepEqual(result.uploaded, ['src/sample.ts']);
    assert.equal(requests.some((request) => request.method === 'PUT' && request.body.branch === 'svl-sync'), true);
    assert.equal(requests.some((request) => request.method === 'PUT' && request.body.branch === 'main'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('automatic sync preserves both sides when local and remote edits conflict', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svl-github-sync-'));
  const requests: Array<{ url: string; method: string; body: any }> = [];
  try {
    await initializeGitWorkspace(root, 'src/sample.ts', 'export const value = 1;');
    await fs.writeFile(path.join(root, 'src/sample.ts'), 'export const value = 2;', 'utf8');
    const service = new GitHubSyncService({
      token: 'test-token',
      fetcher: automaticSyncFetcher({
        baseFiles: { 'src/sample.ts': 'export const value = 1;' },
        remoteFiles: { 'src/sample.ts': 'export const value = 3;' },
        requests,
      }),
    });

    const result = await service.syncWorkspace(root);

    assert.deepEqual(result.conflicts, ['src/sample.ts']);
    assert.equal(await fs.readFile(path.join(root, 'src/sample.ts'), 'utf8'), 'export const value = 2;');
    assert.equal(requests.some((request) => ['PUT', 'DELETE'].includes(request.method)), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('automatic sync does not overwrite a remote edit made after its tree snapshot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svl-github-sync-'));
  const requests: Array<{ url: string; method: string; body: any }> = [];
  const baseFetcher = automaticSyncFetcher({
    baseFiles: { 'src/sample.ts': 'export const value = 1;' },
    remoteFiles: { 'src/sample.ts': 'export const value = 1;' },
    requests,
  });
  try {
    await initializeGitWorkspace(root, 'src/sample.ts', 'export const value = 1;');
    await fs.writeFile(path.join(root, 'src/sample.ts'), 'export const value = 2;', 'utf8');
    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/contents/src/sample.ts') && init.method !== 'PUT') {
        requests.push({ url: String(input), method: init.method || 'GET', body: {} });
        return Response.json({ sha: blobSha('export const value = 3;') });
      }
      return baseFetcher(input, init);
    };
    const service = new GitHubSyncService({ token: 'test-token', fetcher });

    const result = await service.syncWorkspace(root);

    assert.deepEqual(result.conflicts, ['src/sample.ts']);
    assert.equal(requests.some((request) => request.method === 'PUT'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
