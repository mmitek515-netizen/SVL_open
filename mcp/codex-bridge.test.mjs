import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const secret = 'test-only-bearer-token-not-for-production-123456789';
const mockCodex = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('codex-cli MOCK\n');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write('Logged in using ChatGPT\n');
  process.exit(0);
}
if (args[0] === 'exec') {
  let prompt = '';
  process.stdin.on('data', chunk => { prompt += chunk.toString(); });
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Received: '+prompt.trim()}}) + '\n');
  });
} else {
  process.exit(2);
}
`;

async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function rpc(port, payload, bearer = secret) {
  const response = await fetch('http://127.0.0.1:' + port + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + bearer,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

test('SVL Codex MCP: initialization, tools, bearer auth and bounded readonly tasks', { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'svl-codex-mcp-'));
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'codex'), mockCodex, { mode: 0o755 });
  await chmod(path.join(bin, 'codex'), 0o755);
  const port = await availablePort();

  const child = spawn(process.execPath, [path.join(here, 'codex-bridge.mjs')], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      SVL_MCP_TOKEN: secret,
      SVL_MCP_HOST: '127.0.0.1',
      SVL_MCP_PORT: String(port),
      SVL_MCP_WORKDIR: dir,
      SVL_MCP_ENABLE_WRITE: 'false',
      CODEX_HOME: path.join(dir, 'codex-auth'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 5000);
    child.stdout.on('data', data => {
      if (String(data).includes('SVL Codex MCP listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('MCP exited '+code)); });
  });

  const unauthorized = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'initialize' }, 'invalid');
  assert.equal(unauthorized.status, 401);

  const init = await rpc(port, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  assert.equal(init.status, 200);
  assert.equal(init.data.result.protocolVersion, '2025-06-18');

  const list = await rpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.result.tools.map(x => x.name), ['svl_sync_status', 'svl_agents_status', 'codex_status', 'codex_task']);

  const status = await rpc(port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'codex_status', arguments: {} } });
  assert.equal(status.status, 200);
  const statusResult = JSON.parse(status.data.result.content[0].text);
  assert.equal(statusResult.installed, true);
  assert.equal(statusResult.loggedIn, true);
  assert.equal(statusResult.authenticationMode, 'chatgpt-cli');

  const read = await rpc(port, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'codex_task', arguments: { prompt: 'inspect source code' } } });
  assert.equal(read.status, 200);
  assert.equal(read.data.result.isError, false);
  assert.match(JSON.parse(read.data.result.content[0].text).answer, /Received: inspect source code/);

  const rejectedWrite = await rpc(port, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'codex_task', arguments: { prompt: 'change files', write: true } } });
  assert.equal(rejectedWrite.data.result.isError, true);

  const invalidPrompt = await rpc(port, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'codex_task', arguments: { prompt: '' } } });
  assert.equal(invalidPrompt.data.error.code, -32602);
});
