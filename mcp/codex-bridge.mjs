/**
 * SVL_open MCP -> Codex CLI authenticated with ChatGPT OAuth on the host.
 * Stateless Streamable HTTP, compatible with legacy MCP clients (2025-06-18).
 * Never proxies or exposes ChatGPT OAuth credentials.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const HOST = process.env.SVL_MCP_HOST || '127.0.0.1';
const PORT = Number(process.env.SVL_MCP_PORT || 8787);
const TOKEN = process.env.SVL_MCP_TOKEN || '';
const WORKDIR = path.resolve(process.env.SVL_MCP_WORKDIR || '/opt/svl-python-os');
const CODEX_HOME = process.env.CODEX_HOME || '/var/lib/svl-os/codex';
const ENABLE_WRITE = process.env.SVL_MCP_ENABLE_WRITE === 'true';
const ALLOWED_ORIGINS = new Set((process.env.SVL_MCP_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
const MAX_BODY = 24 * 1024;
const MAX_PROMPT = 8000;
const MAX_OUTPUT = 256 * 1024;
const TIMEOUT_MS = 180_000;
let running = false;

if (TOKEN.length < 32 || !Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('MCP not started: set SVL_MCP_TOKEN (>=32 chars) and a valid SVL_MCP_PORT');
  process.exit(1);
}
if (HOST !== '127.0.0.1' && HOST !== '::1' && process.env.SVL_MCP_ALLOW_REMOTE !== 'true') {
  console.error('MCP remote binding requires SVL_MCP_ALLOW_REMOTE=true');
  process.exit(1);
}
function authenticated(header = '') {
  const actual = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(TOKEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function codexEnvironment() {
  const names = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'];
  const env = Object.fromEntries(names.filter(k => process.env[k] != null).map(k => [k, process.env[k]]));
  env.CODEX_HOME = CODEX_HOME;
  return env;
}
function runCodex(args, stdin = '', maxTime = 12_000) {
  return new Promise(resolve => {
    const child = spawn('codex', args, {
      cwd: WORKDIR,
      env: codexEnvironment(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let total = 0;
    let timedOut = false;
    let truncated = false;
    let done = false;
    const complete = code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, truncated });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, maxTime);
    const consume = (buffer, stream) => {
      total += buffer.length;
      if (!truncated) {
        if (stream === 'stdout') stdout += buffer.toString('utf8');
        else stderr += buffer.toString('utf8');
      }
      if (total > MAX_OUTPUT) {
        truncated = true;
        child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', b => consume(b, 'stdout'));
    child.stderr.on('data', b => consume(b, 'stderr'));
    child.on('error', () => complete(127));
    child.on('close', code => complete(code ?? 1));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}
function parseAgentMessage(output) {
  let answer = '';
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'item.completed' && event?.item?.type === 'agent_message') {
        answer = String(event.item.text || '');
      }
    } catch { /* only agent text is surfaced */ }
  }
  return answer.slice(0, 24000);
}
async function getSvlBackend(relativePath) {
  const port = Number(process.env.SVL_PYTHON_PORT || 8085);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid configured Python port');
  }
  const response = await fetch('http://127.0.0.1:' + port + relativePath, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error('SVL backend returned HTTP ' + response.status);
  return response.json();
}

const tools = [
  {
    name: 'svl_sync_status',
    description: 'Read the actual authoritative global synchronization revision from the SVL Python/SQLite backend.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'svl_agents_status',
    description: 'Read agent names and runtime status in SVL_open without exposing agent memories or credentials.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'codex_status',
    description: 'Check if Codex CLI is installed and logged in under the MCP service account. Never reveals credentials.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'codex_task',
    description: 'Run a bounded Codex coding task. Read-only unless workspace-write is explicitly enabled by the administrator.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: MAX_PROMPT },
        write: { type: 'boolean', default: false },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
];
const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const toolReply = (value, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  isError,
});
async function handleRpc(msg) {
  if (!msg || Array.isArray(msg) || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const { id, method } = msg;
  if (id === undefined) return null;
  if (!['string', 'number'].includes(typeof id)) return rpcError(null, -32600, 'Invalid request id');
  if (method === 'initialize') {
    const requested = String(msg.params?.protocolVersion || '2025-06-18');
    const version = ['2025-06-18', '2025-11-25'].includes(requested) ? requested : '2025-06-18';
    return reply(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'svl-open-codex-mcp', version: '1.0.0' },
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools });
  if (method === 'prompts/list') return reply(id, { prompts: [] });
  if (method === 'resources/list') return reply(id, { resources: [] });
  if (method !== 'tools/call') return rpcError(id, -32601, 'Method not found');
  const name = msg.params?.name;
  const args = msg.params?.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return rpcError(id, -32602, 'Invalid parameters');
  }
  if (name === 'svl_sync_status') {
    try {
      const data = await getSvlBackend('/api/py/sync/status');
      return reply(id, toolReply({
        ok: data.ok === true,
        schemaVersion: data.schemaVersion,
        serverRevision: data.serverRevision,
        revision: data.revision,
      }));
    } catch {
      return reply(id, toolReply({ error: 'SVL Python backend is not reachable on loopback' }, true));
    }
  }
  if (name === 'svl_agents_status') {
    try {
      const data = await getSvlBackend('/api/py/agents/status');
      const entries = Array.isArray(data.agents)
        ? data.agents.map(agent => [String(agent?.canonical_name || agent?.name || 'unknown'), agent])
        : Object.entries(data.agents || {});
      const agents = entries.slice(0, 25).map(([name, agent]) => ({
        name,
        status: typeof agent === 'object' && agent !== null
          ? String(agent.status || agent.state || 'unknown').slice(0, 80)
          : String(agent).slice(0, 80),
      }));
      return reply(id, toolReply({
        serverRevision: data.serverRevision,
        connected_at: data.connected_at,
        agents,
      }));
    } catch {
      return reply(id, toolReply({ error: 'SVL agents backend is not reachable on loopback' }, true));
    }
  }
  if (name === 'codex_status') {
    const version = await runCodex(['--version']);
    const login = version.code === 0 ? await runCodex(['login', 'status']) : { code: 127 };
    return reply(id, toolReply({
      installed: version.code === 0,
      loggedIn: login.code === 0,
      version: version.code === 0 ? version.stdout.trim().slice(0, 120) : null,
      workspace: WORKDIR,
      writableTasksEnabled: ENABLE_WRITE,
      loginHint: login.code !== 0 ? 'Run codex login --device as svlos, using the service CODEX_HOME.' : undefined,
    }));
  }
  if (name === 'codex_task') {
    const prompt = args.prompt;
    const write = args.write ?? false;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT || typeof write !== 'boolean') {
      return rpcError(id, -32602, 'Invalid prompt or write flag');
    }
    if (write && !ENABLE_WRITE) {
      return reply(id, toolReply({ error: 'Writing tasks are disabled by the server administrator' }, true));
    }
    if (running) return reply(id, toolReply({ error: 'Codex task already running; retry later' }, true));
    running = true;
    try {
      const sandbox = write ? 'workspace-write' : 'read-only';
      const result = await runCodex(
        ['exec', '--json', '--sandbox', sandbox, '--skip-git-repo-check', '-'],
        prompt,
        TIMEOUT_MS,
      );
      const message = parseAgentMessage(result.stdout);
      if (result.code !== 0 || result.timedOut || result.truncated) {
        return reply(id, toolReply({
          error: result.timedOut ? 'Codex execution timed out'
            : result.truncated ? 'Codex output exceeded limit'
              : 'Codex execution failed; inspect the host service logs',
          exitCode: result.code,
        }, true));
      }
      return reply(id, toolReply({
        ok: true,
        sandbox,
        answer: message || 'Codex completed without a final message',
      }));
    } finally { running = false; }
  }
  return rpcError(id, -32602, 'Unknown tool');
}
function send(res, status, body = null) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (body === null) { res.writeHead(status); res.end(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.url !== '/mcp') return send(res, 404, { error: 'Not found' });
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'Origin denied' });
    if (!authenticated(req.headers.authorization)) return send(res, 401, { error: 'Unauthorized' });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(res, 405, { error: 'Method not allowed' });
    }
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return send(res, 415, { error: 'Content-Type must be application/json' });
    }
    const accept = String(req.headers.accept || '');
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      return send(res, 406, { error: 'Accept must include application/json and text/event-stream' });
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) return send(res, 413, { error: 'Payload too large' });
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return send(res, 400, rpcError(null, -32700, 'Parse error')); }
    const methodHeader = req.headers['mcp-method'];
    const nameHeader = req.headers['mcp-name'];
    if (methodHeader && methodHeader !== body?.method) {
      return send(res, 400, { error: 'MCP method header mismatch' });
    }
    if (nameHeader && body?.method === 'tools/call' && nameHeader !== body?.params?.name) {
      return send(res, 400, { error: 'MCP name header mismatch' });
    }
    const answer = await handleRpc(body);
    send(res, answer === null ? 202 : 200, answer);
  } catch (err) {
    console.error('MCP request failed:', err instanceof Error ? err.message : 'unknown error');
    if (!res.headersSent) send(res, 500, rpcError(null, -32603, 'Internal error'));
    else res.destroy();
  }
});
server.requestTimeout = 190_000;
server.headersTimeout = 20_000;
server.listen(PORT, HOST, () => {
  console.log('SVL Codex MCP listening on ' + HOST + ':' + PORT + '/mcp (write=' + ENABLE_WRITE + ')');
});
