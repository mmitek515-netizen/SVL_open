import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  containsLikelySecret,
  GitHubFileError,
  GitHubFileService,
  isAllowedGitHubFilePath,
} from './githubFiles';

const secretFixture = ['const apiKey = ', "'abcdefghijklmnop';"].join('');

test('GitHub file access accepts only allowed source paths and rejects secrets', () => {
  assert.equal(isAllowedGitHubFilePath('src/utils/svlLogic.ts'), true);
  assert.equal(isAllowedGitHubFilePath('../.env'), false);
  assert.equal(isAllowedGitHubFilePath('.env.example'), true);
  assert.equal(isAllowedGitHubFilePath('backend/.env.example'), true);
  assert.equal(isAllowedGitHubFilePath('Dockerfile'), true);
  assert.equal(isAllowedGitHubFilePath('.github/workflows/release.yml'), false);
  assert.equal(isAllowedGitHubFilePath('data/agent-memory.json'), false);
  assert.equal(containsLikelySecret('GEMINI_API_KEY="MY_GEMINI_API_KEY"'), false);
  assert.equal(containsLikelySecret('GEMINI_API_KEY="actual-secret-value-123"'), true);
  assert.throws(() => new GitHubFileService({ token: 'test-token', branch: 'main' }), GitHubFileError);
});

test('GitHub file reads are direct, branch-specific, and block secrets', async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const content = 'export const value = 42;';
  const fetcher: typeof fetch = async (input, init = {}) => {
    requests.push({ url: String(input), method: init.method || 'GET' });
    return Response.json({
      size: Buffer.byteLength(content),
      encoding: 'base64',
      content: Buffer.from(content).toString('base64'),
    });
  };
  const service = new GitHubFileService({ token: 'test-token', fetcher });

  assert.deepEqual(await service.readFile('src/utils/sample.ts'), {
    path: 'src/utils/sample.ts',
    branch: 'svl-sync',
    content,
  });
  assert.deepEqual(requests, [{
    url: 'https://api.github.com/repos/mmitek515-netizen/SVL_open/contents/src/utils/sample.ts?ref=svl-sync',
    method: 'GET',
  }]);

  const secretService = new GitHubFileService({
    token: 'test-token',
    fetcher: async () => Response.json({
      size: Buffer.byteLength(secretFixture),
      encoding: 'base64',
      content: Buffer.from(secretFixture).toString('base64'),
    }),
  });
  await assert.rejects(secretService.readFile('src/config.ts'), /appears to contain a secret/);
});

test('GitHub file updates create the dedicated branch and reject secret content before network access', async () => {
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
    if (url.includes('/contents/src/utils/sample.ts?ref=svl-sync')) {
      return Response.json({ message: 'Not Found' }, { status: 404 });
    }
    if (url.endsWith('/contents/src/utils/sample.ts') && method === 'PUT') {
      return Response.json({ commit: { sha: 'commit-sha' } }, { status: 201 });
    }
    return Response.json({ message: `Unexpected request ${method} ${url}` }, { status: 500 });
  };
  const service = new GitHubFileService({ token: 'test-token', fetcher });

  assert.deepEqual(await service.updateFile('src/utils/sample.ts', 'export const value = 1;'), {
    path: 'src/utils/sample.ts',
    branch: 'svl-sync',
    commitSha: 'commit-sha',
  });
  const write = requests.find((request) => request.method === 'PUT');
  assert.equal(write?.body.branch, 'svl-sync');
  assert.equal(write?.body.content, Buffer.from('export const value = 1;').toString('base64'));

  let secretRequests = 0;
  const secretService = new GitHubFileService({
    token: 'test-token',
    fetcher: async () => {
      secretRequests += 1;
      return Response.json({});
    },
  });
  await assert.rejects(secretService.updateFile('src/config.ts', secretFixture), GitHubFileError);
  assert.equal(secretRequests, 0);
});
