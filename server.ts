import express from 'express';
import { createServer as createHttpServer, IncomingMessage } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn, ChildProcess, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, GenerateContentResponse, Type, type FunctionDeclaration } from '@google/genai';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import {
  buildChatHistoryPayload,
  extractExplicitChatModuleDirective,
  formatAgentDisplayName,
  getGitHubAgentPermissions,
  guardUnverifiedMissionCompletion,
  normalizeAgentCanonicalName,
  parseWorkOrCodexCommand,
  selectNextDuplexSpeaker,
  selectOllamaModelName,
  type ChatAppliedAction,
} from './src/utils/svlLogic.ts';
import { DEFAULT_GITHUB_FILE_BRANCH, GitHubFileService } from './src/utils/githubFiles.ts';
import { searchLicensedAgentAvatars } from './src/server/agentAvatars.ts';

dotenv.config();

// Never use a universal development credential: this gateway can execute commands,
// access private workspace files, and publish to GitHub. A missing configuration
// receives a fresh process-local secret, not an unauthenticated bypass.
if (process.env.SVL_OPERATOR_TOKEN && process.env.SVL_OPERATOR_TOKEN.length < 32) {
  throw new Error('SVL_OPERATOR_TOKEN must be at least 32 characters long.');
}
if (!process.env.SVL_OPERATOR_TOKEN) {
  process.env.SVL_OPERATOR_TOKEN = randomBytes(48).toString('base64url');
  console.warn('[SVL auth] Created a random, process-local operator token. Privileged endpoints require authentication.');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const PYTHON_PORT = Number(process.env.SVL_PYTHON_PORT || 8085);
const PYTHON_BASE_URL = `http://127.0.0.1:${PYTHON_PORT}`;
const SYNC_SCHEMA_VERSION = '2026.11.sync.v1';

function createGitHubFileService(): GitHubFileService {
  return new GitHubFileService({
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
    branch: process.env.SVL_GITHUB_FILE_BRANCH || DEFAULT_GITHUB_FILE_BRANCH,
  });
}

function createGithubMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'svl-github', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: 'GitHub tools are restricted to allowed source files and the svl-sync branch; never write to main.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'github_read_file',
        description: 'Read an allowed source file from mmitek515-netizen/SVL_open on the svl-sync branch.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', minLength: 1, maxLength: 240 } },
          required: ['path'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: 'github_update_file',
        description: 'Write an allowed source file as a commit on svl-sync only; never writes to main.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 240 },
            content: { type: 'string', maxLength: 131072 },
            commit_message: { type: 'string', maxLength: 120 },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments || {};
    try {
      if (request.params.name === 'github_read_file') {
        if (typeof args.path !== 'string') throw new Error('A file path is required.');
        const result = await createGitHubFileService().readFile(args.path);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (request.params.name === 'github_update_file') {
        if (typeof args.path !== 'string' || typeof args.content !== 'string') {
          throw new Error('A file path and content are required.');
        }
        if (args.commit_message !== undefined && typeof args.commit_message !== 'string') {
          throw new Error('Commit message must be a string.');
        }
        const result = await createGitHubFileService().updateFile(
          args.path,
          args.content,
          args.commit_message,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      return {
        content: [{ type: 'text', text: `Unknown GitHub tool: ${request.params.name}` }],
        isError: true,
      };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  });
  return server;
}

async function postSystemNotificationToFamilyChat(
  text: string,
  options?: {
    severity?: 'INFO' | 'WARN' | 'ALERT';
    category?: string;
    title?: string;
    details?: Record<string, any>;
    sourceEventId?: string;
    mirrorToFamilyChat?: boolean;
  },
): Promise<any> {
  try {
    const cleanText = String(text || '').trim();
    const title = (options?.title || cleanText.split('\n')[0] || 'Powiadomienie SVL').slice(0, 220);
    const pyRes = await callPythonBackend('POST', '/api/py/notifications/emit', {
      severity: options?.severity || 'INFO',
      category: options?.category || 'system',
      title,
      message: cleanText,
      details: options?.details || {},
      channel: 'wszyscy',
      sourceEventId: options?.sourceEventId || '',
      mirrorToFamilyChat: options?.mirrorToFamilyChat !== false,
      origin: 'iris-server-notifier',
    });
    if (pyRes.status === 200 && pyRes.data?.event) {
      if (typeof (globalThis as any).__svlPublishOutbox === 'function') {
        (globalThis as any).__svlPublishOutbox(pyRes.data.event);
      }
    }
    return pyRes.data;
  } catch {
    return null;
  }
}

function sanitizeCorrelationId(raw: unknown): string {
  const clean = String(raw || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80);
  return clean || `req-${randomUUID().slice(0, 12)}`;
}

const SENSITIVE_KEYS = ['token', 'secret', 'password', 'passwd', 'apikey', 'api_key', 'authorization', 'private_key'];

function redactForSync(input: any): any {
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map(redactForSync);
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      const kl = k.toLowerCase();
      if (SENSITIVE_KEYS.some((m) => kl.includes(m))) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactForSync(v);
      }
    }
    return out;
  }
  return input;
}

// Server-side Gemini client initialized strictly per @google/genai skill guidelines
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim().length < 10) {
    return null;
  }
  return new GoogleGenAI({
    apiKey: apiKey.trim(),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

type SvlRuntimeLogLine = {
  timestamp: string;
  service: 'python' | 'gateway';
  level: 'info' | 'error';
  message: string;
};
const MAX_RUNTIME_LOG_LINES = 180;
const runtimeLogLines: SvlRuntimeLogLine[] = [];

function scrubRuntimeLog(input: string): string {
  let cleaned = String(input || '').replace(/\u001b\[[0-9;]*m/g, '');
  for (const key of [
    'SVL_OPERATOR_TOKEN', 'GITHUB_TOKEN',
    'GH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY',
  ]) {
    const value = process.env[key];
    if (value && value.length >= 8) cleaned = cleaned.split(value).join('[REDACTED]');
  }
  cleaned = cleaned.replace(/\bBearer\s+[A-Za-z0-9_.-]{12,}/gi, 'Bearer [REDACTED]');
  cleaned = cleaned.replace(/(?:authorization|api[_-]?key|password|token)\s*[:=]\s*['"]?[^\s,'"]{12,}/gi, '[REDACTED_CREDENTIAL]');
  return cleaned.slice(0, 900);
}

function recordRuntimeLog(
  service: SvlRuntimeLogLine['service'],
  level: SvlRuntimeLogLine['level'],
  chunk: unknown,
): void {
  const source = String(chunk ?? '');
  for (const rawLine of source.split(/\r?\n/)) {
    const message = scrubRuntimeLog(rawLine.trim());
    if (!message) continue;
    runtimeLogLines.push({ timestamp: new Date().toISOString(), service, level, message });
  }
  if (runtimeLogLines.length > MAX_RUNTIME_LOG_LINES) {
    runtimeLogLines.splice(0, runtimeLogLines.length - MAX_RUNTIME_LOG_LINES);
  }
}

// Restart Python only with capped exponential backoff. Never restart after shutdown.
let pythonProc: ChildProcess | null = null;
let pythonRestartTimer: NodeJS.Timeout | null = null;
let pythonRestartAttempt = 0;
let pythonStopping = false;

function stopPythonBackend(): void {
  pythonStopping = true;
  if (pythonRestartTimer) {
    clearTimeout(pythonRestartTimer);
    pythonRestartTimer = null;
  }
  if (pythonProc && pythonProc.exitCode === null && !pythonProc.killed) {
    pythonProc.kill('SIGTERM');
  }
}

function startPythonBackend(): void {
  if (pythonStopping || pythonProc || pythonRestartTimer) return;
  const scriptPath = path.join(__dirname, 'backend', 'app.py');
  let startedAt = Date.now();
  const proc = spawn('python3', [scriptPath], {
    cwd: __dirname,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      SVL_PYTHON_PORT: String(PYTHON_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pythonProc = proc;
  proc.on('spawn', () => {
    recordRuntimeLog('gateway', 'info', `Python backend started (PID=${proc.pid ?? 'unknown'}).`);
  });
  proc.stdout?.on('data', (chunk) => {
    recordRuntimeLog('python', 'info', chunk);
    process.stdout.write(`[PythonKernel] ${scrubRuntimeLog(String(chunk))}`);
  });
  proc.stderr?.on('data', (chunk) => {
    recordRuntimeLog('python', 'error', chunk);
    process.stderr.write(`[PythonKernel ERR] ${scrubRuntimeLog(String(chunk))}`);
  });
  proc.on('error', (error) => {
    recordRuntimeLog('gateway', 'error', `Python startup failed: ${error.message}`);
    console.error('[PythonKernel] Process startup error:', error.message);
  });
  proc.on('close', (code, signal) => {
    if (pythonProc === proc) pythonProc = null;
    if (pythonStopping) return;
    const uptimeMs = Date.now() - startedAt;
    pythonRestartAttempt = uptimeMs >= 60000 ? 0 : Math.min(pythonRestartAttempt + 1, 8);
    const delayMs = Math.min(30000, 1500 * (2 ** Math.min(pythonRestartAttempt - 1, 5)));
    const restartMessage = `Python exited (code=${code}, signal=${signal}); retry in ${delayMs}ms (attempt ${pythonRestartAttempt}).`;
    recordRuntimeLog('gateway', 'error', restartMessage);
    console.error(`[PythonKernel] ${restartMessage}`);
    pythonRestartTimer = setTimeout(() => {
      pythonRestartTimer = null;
      startPythonBackend();
    }, delayMs);
  });
}

// The real Ollama client probes only a configured, live Ollama daemon.
// No local mock endpoint, forged model registry, synthetic responses, fake pull progress
// or no-password root wrappers are installed by the SVL gateway.
function describeOllamaModelFlavor(_modelName: string): string {
  return 'Używaj wyłącznie rzeczywiście dostępnych narzędzi i modeli. Nie deklaruj wykonania działań bez wiarygodnego wyniku.';
}

async function callPythonBackend(
  method: 'GET' | 'POST',
  endpoint: string,
  body?: Record<string, unknown>,
  correlationId?: string,
  maxConnectAttempts = 6,
  timeoutMs = 20000,
): Promise<{ status: number; data: any }> {
  const url = `${PYTHON_BASE_URL}${endpoint}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (correlationId) headers['X-Request-Id'] = correlationId;

  for (let attempt = 0; attempt < maxConnectAttempts; attempt++) {
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const rawText = await resp.text();
      const trimmed = rawText.trim();
      if (!trimmed || trimmed.startsWith('<')) {
        throw new Error(`Python backend returned non-JSON payload (HTTP ${resp.status})`);
      }
      const data = JSON.parse(trimmed);
      return { status: resp.status, data };
    } catch (err: any) {
      const msg = String(err?.cause?.code || err?.message || err);
      const isTransientConnErr =
        msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET') || (method === 'GET' && msg.includes('fetch failed'));
      if (!isTransientConnErr || attempt >= maxConnectAttempts - 1) {
        return {
          status: 503,
          data: {
            ok: false,
            offline: true,
            error: `Python backend unreachable on port ${PYTHON_PORT}: ${err?.message || String(err)}`,
          },
        };
      }
      await new Promise((r) => setTimeout(r, Math.min(800, 150 * Math.pow(1.5, attempt))));
    }
  }
  return { status: 503, data: { ok: false, offline: true, error: 'Python backend timeout' } };
}

function asyncRoute(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<any>,
): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

async function executeLinuxShellCommand(cmd: string, cwd = __dirname): Promise<{
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}> {
  const t0 = Date.now();
  const trimmedCmd = String(cmd || '').trim();

  return new Promise((resolve) => {
    execFile(
      '/bin/bash',
      ['-c', trimmedCmd],
      {
        cwd,
        timeout: 12000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          PATH: `${path.join(__dirname, 'backend', 'bin')}:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`,
          PAGER: 'cat',
          TERM: 'xterm-256color',
        },
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - t0;
        if (err) {
          const code = typeof (err as any).code === 'number' ? (err as any).code : 1;
          resolve({
            ok: false,
            exitCode: code,
            stdout: String(stdout || ''),
            stderr: String(stderr || err.message || ''),
            durationMs,
          });
        } else {
          resolve({
            ok: true,
            exitCode: 0,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            durationMs,
          });
        }
      },
    );
  });
}

function hasOperatorAuthorization(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || candidate.length < 32 || candidate.length > 512) return false;
  const secret = process.env.SVL_OPERATOR_TOKEN || '';
  if (secret.length < 32) return false;
  try {
    const actual = Buffer.from(candidate, 'utf8');
    const expected = Buffer.from(secret, 'utf8');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

async function startServer() {
  // Never start a synthetic Ollama daemon: an unavailable real model must stay offline.
  startPythonBackend();

  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.all('/mcp/github', asyncRoute(async (req, res) => {
    const authorization = req.headers.authorization;
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : '';
    if (!hasOperatorAuthorization(token)) {
      res.status(401).json({ ok: false, error: 'GitHub MCP requires a valid operator token.' });
      return;
    }

    const githubMcpServer = createGithubMcpServer();
    const githubMcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await githubMcpServer.connect(githubMcpTransport);
      await githubMcpTransport.handleRequest(req, res, req.body);
    } finally {
      await githubMcpTransport.close();
      await githubMcpServer.close();
    }
  }));

  // Attach correlation ID and proxy-safe JSON error status mapping to all /api/* HTTP requests.
  // AI Studio's nginx reverse proxy intercepts 403 -> forbidden.html and 502/503/504 -> warmup.html (HTTP 200 HTML!),
  // which strips our JSON error body. Remapping to 401 / 424 preserves real HTTP errors and JSON payloads cleanly.
  app.use('/api', (req, res, next) => {
    const corrId = sanitizeCorrelationId(req.headers['x-request-id'] || req.headers['x-correlation-id']);
    (req as any).correlationId = corrId;
    res.setHeader('X-Request-Id', corrId);
    res.setHeader('Cache-Control', 'no-store');

    const origStatus = res.status.bind(res);
    const origJson = res.json.bind(res);
    let intendedStatus = 200;

    res.status = ((code: number) => {
      intendedStatus = code;
      if (code === 403) return origStatus(401);
      if (code === 502 || code === 503 || code === 504) return origStatus(424);
      return origStatus(code);
    }) as typeof res.status;

    res.json = ((body: any) => {
      if (
        body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        (intendedStatus === 403 || intendedStatus === 502 || intendedStatus === 503 || intendedStatus === 504)
      ) {
        return origJson({
          ...body,
          upstreamStatus: body.upstreamStatus ?? intendedStatus,
          offline:
            body.offline !== undefined
              ? body.offline
              : intendedStatus === 502 || intendedStatus === 503 || intendedStatus === 504,
        });
      }
      return origJson(body);
    }) as typeof res.json;

    next();
  });

  // Recent logs belong to THIS gateway process, not GitHub Actions.
  // Never expose the console output of an authenticated runtime to public previews.
  app.get('/api/runtime/logs', (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Logi procesu wymagają SVL_OPERATOR_TOKEN.' });
      return;
    }
    const requested = Number(req.query.limit || 80);
    const limit = Number.isFinite(requested) ? Math.min(180, Math.max(1, Math.floor(requested))) : 80;
    res.json({
      ok: true,
      source: 'in-memory gateway process',
      lines: runtimeLogLines.slice(-limit),
      pythonPid: pythonProc?.pid ?? null,
      pythonRestartAttempt,
      stopping: pythonStopping,
      checkedAt: new Date().toISOString(),
    });
  });

  app.get('/api/operator/status', (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ok:false, authenticated:false, error:'Nieprawidłowy token operatora.'});
      return;
    }
    res.json({ok:true,authenticated:true});
  });

  app.get('/api/deployment-info', (_req, res) => {
    let commit = process.env.GITHUB_SHA || process.env.VITE_GIT_SHA || '';
    let source = commit ? 'environment' : 'unknown';
    try {
      const localCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: __dirname,
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (/^[0-9a-f]{40}$/.test(localCommit)) {
        commit = localCommit;
        source = 'local_git';
      }
    } catch {
      // AI Studio may not include the .git directory in its preview container.
    }
    res.json({ ok: true, commit: commit || null, source });
  });

  interface WsClientMeta {
    clientId: string;
    origin: string;
    lastPongAt: number;
  }
  const wsClients = new Map<WebSocket, WsClientMeta>();
  let lastRelayedServerRevision = 0;
  const relayedEventIdsQueue: string[] = [];
  const relayedEventIdsSet = new Set<string>();

  const publishOutboxEvent = (evt: any) => {
    if (!evt || typeof evt !== 'object' || !evt.eventId) return;
    if (relayedEventIdsSet.has(evt.eventId)) return;

    relayedEventIdsSet.add(evt.eventId);
    relayedEventIdsQueue.push(evt.eventId);
    if (relayedEventIdsQueue.length > 1500) {
      const oldest = relayedEventIdsQueue.shift();
      if (oldest) relayedEventIdsSet.delete(oldest);
    }

    const srvRev = Number(evt.serverRevision || 0);
    if (srvRev > lastRelayedServerRevision) {
      lastRelayedServerRevision = srvRev;
    }

    const sanitized = redactForSync(evt);
    const frame = JSON.stringify({
      ...sanitized,
      type: sanitized.type || 'svl.event',
    });

    for (const [client] of wsClients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(frame);
        } catch {
          // ignore closed socket race
        }
      }
    }
  };
  (globalThis as any).__svlPublishOutbox = publishOutboxEvent;

  let outboxPollInFlight = false;
  const pollAndRelayOutbox = async () => {
    if (outboxPollInFlight || wsClients.size === 0) return;
    outboxPollInFlight = true;
    try {
      const res = await callPythonBackend(
        'GET',
        `/api/py/sync/events?sinceRevision=${lastRelayedServerRevision}&limit=80`,
        undefined,
        'ws-outbox-poll',
        2,
      );
      if (res.status === 200 && res.data?.ok) {
        const srv = Number(res.data.serverRevision || 0);
        if (res.data.gapDetected) {
          const frame = JSON.stringify({
            type: 'svl.resync_required',
            reason: 'outbox_gap',
            serverRevision: srv,
            timestamp: new Date().toISOString(),
          });
          for (const [client] of wsClients) {
            if (client.readyState === WebSocket.OPEN) {
              try {
                client.send(frame);
              } catch {
                // ignore closed socket race
              }
            }
          }
          lastRelayedServerRevision = Math.max(lastRelayedServerRevision, srv);
          return;
        }

        const events: any[] = Array.isArray(res.data.events) ? res.data.events : [];
        for (const evt of events) {
          publishOutboxEvent(evt);
        }
        if (!res.data.hasMore && srv > lastRelayedServerRevision) {
          lastRelayedServerRevision = srv;
        }
      }
    } catch {
      // retry on next interval
    } finally {
      outboxPollInFlight = false;
    }
  };

  // 0.5. Avatar overrides API (compatible with Codespaces / Bastilla / SVL Python OS)
  app.get(['/api/avatars', '/api/ai/runtime/avatars'], asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const result = await callPythonBackend('GET', '/api/py/avatars', undefined, corrId);
    res.status(result.status).json(result.data);
  }));

  app.post(['/api/avatars', '/api/ai/runtime/avatars'], asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Zmiana awatara wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const result = await callPythonBackend('POST', '/api/py/avatars', req.body || {}, corrId);
    if (result.status >= 200 && result.status < 300 && result.data?.event) {
      publishOutboxEvent(result.data.event);
    }
    res.status(result.status).json(result.data);
  }));

  app.delete(['/api/avatars/:agent', '/api/ai/runtime/avatars/:agent'], asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Przywrócenie domyślnego awatara wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const result = await callPythonBackend(
      'POST',
      '/api/py/avatars/delete',
      { agent: req.params.agent },
      corrId,
    );
    if (result.status >= 200 && result.status < 300 && result.data?.event) {
      publishOutboxEvent(result.data.event);
    }
    res.status(result.status).json(result.data);
  }));

  // 0.75. SVL-364 Starship SSH Bridge & Linux Control MCP Server endpoints
  app.all(['/api/mcp/svl364', '/api/svl364/mcp'], asyncRoute(async (req, res) => {
    const isOperator = hasOperatorAuthorization(req.headers['x-svl-operator-token']) ||
      hasOperatorAuthorization(req.body?.operatorToken);
    if (!isOperator) {
      res.status(401).json({ ok: false, error: 'Serwer MCP SVL-364 wymaga autoryzacji SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const method = req.method === 'POST' ? 'POST' : 'GET';
    const result = await callPythonBackend(
      method,
      '/api/py/svl364/mcp',
      method === 'POST' ? req.body : undefined,
      corrId,
    );
    void pollAndRelayOutbox();
    res.status(result.status).json(result.data);
  }));

  app.get('/api/svl364/ssh-mcp/status', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Status SSH/MCP SVL-364 wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const result = await callPythonBackend('GET', '/api/py/svl364/ssh-mcp/status', undefined, corrId);
    res.status(result.status).json(result.data);
  }));

  app.post('/api/svl364/ssh/exec', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token']) &&
        !hasOperatorAuthorization(req.body?.operatorToken)) {
      res.status(401).json({ ok: false, error: 'Mostek SSH SVL-364 wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    if (req.body?.confirmed !== true) {
      res.status(400).json({ok: false, error: 'Wykonanie SSH wymaga jawnego potwierdzenia.'});
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const result = await callPythonBackend('POST', '/api/py/svl364/ssh/exec', req.body || {}, corrId);
    if (result.status >= 200 && result.status < 300) {
      if (result.data?.event) publishOutboxEvent(result.data.event);
      else void pollAndRelayOutbox();
    }
    res.status(result.status).json(result.data);
  }));

  app.post('/api/svl364/ssh-mcp/config', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token']) &&
        !hasOperatorAuthorization(req.body?.operatorToken)) {
      res.status(401).json({ ok: false, error: 'Konfiguracja SSH/MCP SVL-364 wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const result = await callPythonBackend('POST', '/api/py/svl364/ssh-mcp/config', req.body || {}, corrId);
    if (result.status >= 200 && result.status < 300 && result.data?.event) {
      publishOutboxEvent(result.data.event);
    }
    res.status(result.status).json(result.data);
  }));

  // 1. Proxy all /api/py/* routes directly to the live Python 3 SVLSystemKernel server
  app.all('/api/py/*', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const queryStr = new URLSearchParams(req.query as Record<string, string>).toString();
    const fullEndpoint = queryStr ? `${req.path}?${queryStr}` : req.path;
    const method = req.method === 'POST' ? 'POST' : 'GET';
    const timeoutMs = req.path === '/api/py/images/generate' ? 900000 : 20000;
    const isOperator = hasOperatorAuthorization(req.headers['x-svl-operator-token']);
    if (!isOperator) {
      res.status(401).json({
        ok: false,
        error: 'Wymagana autoryzacja SVL. Wpisz SVL_OPERATOR_TOKEN w górnym pasku aplikacji.',
      });
      return;
    }
    const result = await callPythonBackend(
      method,
      fullEndpoint,
      method === 'POST' ? req.body : undefined,
      corrId,
      6,
      timeoutMs,
    );
    if (method === 'POST' && result.status >= 200 && result.status < 300) {
      const outboxEvents = [
        ...(result.data?.event ? [result.data.event] : []),
        ...(Array.isArray(result.data?.events) ? result.data.events : []),
      ];
      if (outboxEvents.length > 0) {
        for (const event of outboxEvents) {
          publishOutboxEvent(event);
        }
      } else {
        void pollAndRelayOutbox();
      }
    }
    res.status(result.status).json(result.data);
  }));

  // Helper to persist terminal entry cleanly in SQLite and relay outbox event
  const persistTerminalOutput = async (
    tab: string,
    kind: 'input' | 'stdout' | 'stderr' | 'system',
    text: string,
    command: string,
    origin: string,
    correlationId: string,
  ) => {
    if (!text) return null;
    const pyRes = await callPythonBackend(
      'POST',
      '/api/py/terminal/log',
      {
        tab,
        kind,
        text: text.slice(0, 8000),
        command: command.slice(0, 300),
        origin,
        correlationId,
      },
      correlationId,
    );
    if (pyRes.status === 200 && pyRes.data?.event) {
      publishOutboxEvent(pyRes.data.event);
    }
    return pyRes.data;
  };

  // 2. Real Linux & Multi-Terminal Execution Endpoint (with Polkit/sudo audit gate + SQLite persistence)
  app.post('/api/terminal/exec', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const {
      terminalType = 'linux',
      command = '',
      operatorToken = '',
      origin = 'client',
    } = req.body || {};

    const trimmed = String(command || '').trim();
    if (!hasOperatorAuthorization(operatorToken) &&
        !hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ok: false, error: 'Terminal Linux/Python wymaga prawidłowego SVL_OPERATOR_TOKEN.'});
      return;
    }
    if (!trimmed) {
      res.status(400).json({ ok: false, error: 'Puste polecenie.' });
      return;
    }
    if (terminalType === 'ssh' && req.body?.confirmed !== true) {
      res.status(400).json({ok: false, error: 'Wykonanie SSH wymaga jawnego potwierdzenia.'});
      return;
    }

    const promptPrefixes: Record<string, string> = {
      linux: 'svl@debian13:/app/applet$',
      ssh: 'Ship$',
      python: 'svl-py3>>>',
      codex: 'codex$',
      hyperspace: 'hyper128>',
      agents: 'agents>',
    };

    const respondAndPersist = async (payload: Record<string, any>) => {
      await persistTerminalOutput(
        terminalType,
        'input',
        `${promptPrefixes[terminalType] || '>'} ${trimmed}`,
        trimmed,
        origin,
        corrId,
      );
      if (payload.stdout) {
        await persistTerminalOutput(terminalType, 'stdout', String(payload.stdout).trimEnd(), trimmed, origin, corrId);
      }
      if (payload.stderr) {
        await persistTerminalOutput(terminalType, 'stderr', String(payload.stderr).trimEnd(), trimmed, origin, corrId);
      }
      if (!payload.stdout && !payload.stderr) {
        await persistTerminalOutput(
          terminalType,
          payload.ok ? 'system' : 'stderr',
          payload.ok ? '(Polecenie zakończone kodem 0 — brak wyjścia stdout)' : String(payload.error || 'Błąd wykonania.'),
          trimmed,
          origin,
          corrId,
        );
      }
      if (!payload.skipIrisEcho) {
        void postSystemNotificationToFamilyChat(
          `[Terminal ${terminalType}] Wykonano: \`${trimmed}\``,
          {
            severity: 'INFO',
            category: 'svl_system',
            title: `Wykonanie polecenia terminalowego (${terminalType}): ${trimmed.slice(0, 80)}`,
            details: {
              terminal: terminalType,
              command: trimmed,
              status: payload.ok ? 'COMPLETED (exit 0)' : 'ERROR',
            },
          },
        );
      }
      res.json(payload);
    };

    // Execute natural-language directives and report commands immediately through SVLSystemKernel + Agata Mitek worker
    const executeAgentDirectiveAndReport = async (rawDirective: string, sourceLabel: string) => {
      const cleanDir = rawDirective.replace(/^\/?exec\s+/i, '').trim() || 'raport systemu';
      const matchAg = cleanDir.match(/^@?(Agata(?:\s+Mitek)?)\b\s*(.*)$/i);
      const targetAg = (matchAg ? normalizeAgentCanonicalName(matchAg[1]) : 'Agata') || 'Agata';
      const bodyText = (matchAg && matchAg[2] ? matchAg[2].trim() : cleanDir) || cleanDir;

      const [reportRes, taskRes, memRes] = await Promise.all([
        callPythonBackend(
          'POST',
          '/api/py/kernel/markdown-report',
          {
            directive: bodyText,
            emitToIris: true,
            origin,
            correlationId: corrId,
          },
          corrId,
        ),
        callPythonBackend(
          'POST',
          '/api/py/agents/task',
          {
            sender: sourceLabel,
            target_agent: targetAg,
            title: bodyText.slice(0, 72) || 'Raport systemu SVL_System',
            payload: bodyText,
            origin,
            correlationId: corrId,
          },
          corrId,
        ),
        callPythonBackend(
          'POST',
          '/api/py/agents/memory',
          {
            agent: targetAg,
            kind: 'task',
            content: `Wykonano natychmiast z ${sourceLabel} (COMPLETED): ${cleanDir}`,
            origin,
            correlationId: corrId,
          },
          corrId,
        ),
      ]);
      if (taskRes.data?.event) publishOutboxEvent(taskRes.data.event);
      if (memRes.data?.event) publishOutboxEvent(memRes.data.event);
      void pollAndRelayOutbox();

      const srvRev = Math.max(
        Number(reportRes.data?.serverRevision || 0),
        Number(taskRes.data?.serverRevision || 0),
        Number(memRes.data?.serverRevision || 0),
      );
      const markdownReport = String(reportRes.data?.report || '').trim();
      const plainSummaryHeader =
        `Status: COMPLETED — wykonano natychmiast przez SVLSystemKernel & worker ${formatAgentDisplayName(targetAg)} (ROOT UID 0).\n` +
        `Adresat: ${formatAgentDisplayName(targetAg)} + Iris AI (kanał: Rodzina Mitek (wszyscy))\n` +
        `Dyrektywa: ${cleanDir}\n` +
        `Revision synchronizacji: ${srvRev}\n` +
        `================================================================================\n`;

      return {
        ok: true,
        targetAgent: targetAg,
        directive: cleanDir,
        taskStatus: 'COMPLETED',
        serverRevision: srvRev,
        stdout: `${plainSummaryHeader}${markdownReport}`,
      };
    };

    const effectiveCmd = trimmed.replace(/^\/exec\s+/i, '').trim() || trimmed;
    if (terminalType === 'ssh') {
      const sshRes = await callPythonBackend(
        'POST',
        '/api/py/svl364/ssh/exec',
        {
          command: effectiveCmd,
          confirmed: true,
          target_subsystem: 'terminal',
          origin: `terminal:${terminalType}`,
          correlationId: corrId,
        },
        corrId,
      );
      const sshResult = sshRes.data || {};
      await respondAndPersist({
        ok: Boolean(sshResult.ok),
        terminalType,
        command: trimmed,
        exitCode: sshResult.exitCode,
        stdout: sshResult.ok ? sshResult.rawOutput || '' : '',
        stderr: sshResult.ok ? '' : sshResult.rawOutput || sshResult.error || `Błąd SSH (HTTP ${sshRes.status}).`,
        durationMs: sshResult.durationMs,
        skipIrisEcho: true,
      });
      return;
    }

    const isSystemReportDirective =
      /^(?:raport(?:\s+systemu|\s+svl|\s+statku|\s+floty|\s+telemetrii)?|status\s+systemu|telemetria(?:\s+statku|\s+svl[-_\s]?364)?|diagnostyka\s+systemu|svl[-_\s]?system(?:\s+raport)?)$/i.test(
        effectiveCmd,
      );

    if (isSystemReportDirective) {
      const repOut = await executeAgentDirectiveAndReport(effectiveCmd, `terminal:${terminalType}`);
      await respondAndPersist({
        ok: true,
        terminalType,
        command: trimmed,
        specialCommand: 'raport systemu',
        taskStatus: 'COMPLETED',
        stdout: repOut.stdout,
        stderr: '',
        serverRevision: repOut.serverRevision,
        skipIrisEcho: true,
      });
      return;
    }

    // Intercept 'podłącz moje ai' in any terminal
    if (effectiveCmd.toLowerCase() === 'podłącz moje ai' || effectiveCmd.toLowerCase() === 'podlacz moje ai') {
      const pyRes = await callPythonBackend(
        'POST',
        '/api/py/agents/connect',
        { triggered_by: `terminal:${terminalType}`, origin, correlationId: corrId },
        corrId,
      );
      void pollAndRelayOutbox();
      await respondAndPersist({
        ok: true,
        terminalType,
        command: trimmed,
        specialCommand: 'podłącz moje ai',
        stdout: JSON.stringify(pyRes.data.connection_report || pyRes.data, null, 2),
        stderr: '',
        connectionReport: pyRes.data.connection_report,
      });
      return;
    }

    // Intercept /ssh or ssh root@svl-364-ship commands for direct Starship SSH execution
    const sshMatch = effectiveCmd.match(/^(?:\/ssh|ssh\s+(?:-p\s+\d+\s+)?(?:root@)?svl-364(?:-ship(?:\.qkd\.mesh)?)?)\s*(.*)$/i);
    if (sshMatch) {
      const sshSubCmd = (sshMatch[1] || '').trim() || 'uname -a && uptime && free -m';
      const sshRes = await callPythonBackend(
        'POST',
        '/api/py/svl364/ssh/exec',
        { command: sshSubCmd, target_subsystem: 'bridge', origin: `terminal:${terminalType}`, correlationId: corrId },
        corrId,
      );
      void pollAndRelayOutbox();
      await respondAndPersist({
        ok: Boolean(sshRes.data?.ok),
        terminalType,
        command: trimmed,
        specialCommand: 'svl364-ssh',
        stdout: sshRes.data?.stdout || JSON.stringify(sshRes.data, null, 2),
        stderr: sshRes.data?.stderr || '',
        skipIrisEcho: true,
      });
      return;
    }

    // Intercept /mcp commands for direct MCP JSON-RPC 2.0 tool execution
    const mcpMatch = effectiveCmd.match(/^\/mcp(?:\s+(\S+))?(?:\s+(.*))?$/i);
    if (mcpMatch) {
      const toolOrMethod = (mcpMatch[1] || 'tools/list').trim();
      const rawArgsStr = (mcpMatch[2] || '').trim();
      let parsedArgs: Record<string, unknown> = {};
      if (rawArgsStr) {
        try {
          parsedArgs = JSON.parse(rawArgsStr);
        } catch {
          parsedArgs = { command: rawArgsStr, directive: rawArgsStr };
        }
      }
      const rpcBody =
        toolOrMethod === 'tools/list' || toolOrMethod === 'initialize' || toolOrMethod === 'resources/list'
          ? { jsonrpc: '2.0', id: 1, method: toolOrMethod, params: parsedArgs }
          : {
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: toolOrMethod, arguments: parsedArgs },
            };
      const mcpRes = await callPythonBackend('POST', '/api/py/svl364/mcp', rpcBody, corrId);
      void pollAndRelayOutbox();
      const mcpText =
        mcpRes.data?.result?.content?.[0]?.text || JSON.stringify(mcpRes.data?.result || mcpRes.data, null, 2);
      await respondAndPersist({
        ok: !mcpRes.data?.error,
        terminalType,
        command: trimmed,
        specialCommand: 'svl364-mcp',
        stdout: mcpText,
        stderr: mcpRes.data?.error ? JSON.stringify(mcpRes.data.error) : '',
        skipIrisEcho: true,
      });
      return;
    }

    if (terminalType === 'python' && !trimmed.toLowerCase().startsWith('/exec ')) {
      const pyRes = await callPythonBackend('POST', '/api/py/python-repl', { code: effectiveCmd }, corrId);
      if (pyRes.data?.ok) {
        await respondAndPersist({
          ok: true,
          terminalType,
          command: trimmed,
          stdout: pyRes.data.stdout || '',
          stderr: pyRes.data.stderr || '',
        });
        return;
      }
      const dirRes = await executeAgentDirectiveAndReport(effectiveCmd, 'terminal:python');
      await respondAndPersist({
        ok: dirRes.ok,
        terminalType,
        command: trimmed,
        stdout: dirRes.stdout,
        taskStatus: dirRes.taskStatus,
        stderr: '',
        skipIrisEcho: true,
      });
      return;
    }

    if (terminalType === 'hyperspace' && !trimmed.toLowerCase().startsWith('/exec ')) {
      const pyRes = await callPythonBackend(
        'POST',
        '/api/py/hyperspace/compute',
        { text: effectiveCmd, omega: 1.5, t: 1.0 },
        corrId,
      );
      await respondAndPersist({
        ok: true,
        terminalType,
        command: trimmed,
        stdout: JSON.stringify(pyRes.data, null, 2),
        stderr: '',
        hyperspaceData: pyRes.data,
      });
      return;
    }

    if (terminalType === 'agents') {
      const dirRes = await executeAgentDirectiveAndReport(effectiveCmd, 'terminal:agents');
      await respondAndPersist({
        ok: dirRes.ok,
        terminalType,
        command: trimmed,
        stdout: dirRes.stdout,
        taskStatus: dirRes.taskStatus,
        stderr: '',
        skipIrisEcho: true,
      });
      return;
    }

    if (terminalType === 'codex') {
      if (effectiveCmd === 'status' || effectiveCmd === 'codex --version' || effectiveCmd === 'help') {
        const health = await callPythonBackend('GET', '/api/py/health', undefined, corrId);
        const gitLog = await executeLinuxShellCommand('git status -s && git log -n 3 --oneline || true');
        await respondAndPersist({
          ok: true,
          terminalType,
          command: trimmed,
          stdout:
            `[OpenAI Codex CLI Bridge — SVL Python OS]\n` +
            `Status binarki codex: ${health.data?.codex?.codex_cli_installed ? 'ZAINSTALOWANA' : 'NIEDOSTĘPNA'}\n` +
            `Sesja Codex CLI backendu: ${health.data?.codex?.codex_cli_logged_in ? 'ZALOGOWANA' : 'BRAK LOGOWANIA'}\n` +
            `UID procesu aplikacji: ${typeof process.getuid === 'function' ? process.getuid() : 'n/d'}\n` +
            `Aktywna gałąź Git: ${health.data?.codex?.active_branch || 'n/d'}\n\n` +
            `--- Stan repozytorium roboczego ---\n${gitLog.stdout || '(Czyste drzewo robocze)'}`,
          stderr: gitLog.stderr,
        });
        return;
      }
      const out = await executeLinuxShellCommand(effectiveCmd);
      if (out.exitCode === 127) {
        const dirRes = await executeAgentDirectiveAndReport(effectiveCmd, 'terminal:codex');
        await respondAndPersist({
          ok: dirRes.ok,
          terminalType,
          command: trimmed,
          stdout: dirRes.stdout,
          taskStatus: dirRes.taskStatus,
          stderr: '',
        });
        return;
      }
      await respondAndPersist({ ok: out.ok, terminalType, command: trimmed, stdout: out.stdout, stderr: out.stderr });
      return;
    }

    const shellRes = await executeLinuxShellCommand(effectiveCmd);
    if (shellRes.exitCode === 127) {
      const dirRes = await executeAgentDirectiveAndReport(effectiveCmd, `terminal:${terminalType}`);
      await respondAndPersist({
        ok: dirRes.ok,
        terminalType,
        command: trimmed,
        taskStatus: dirRes.taskStatus,
        stdout: dirRes.stdout,
        stderr: '',
        durationMs: shellRes.durationMs,
        skipIrisEcho: true,
      });
      return;
    }
    await respondAndPersist({
      ok: shellRes.ok,
      terminalType: 'linux',
      command: trimmed,
      exitCode: shellRes.exitCode,
      stdout: shellRes.stdout,
      stderr: shellRes.stderr,
      durationMs: shellRes.durationMs,
    });
  }));

  // 2b. Ollama Runtime Configuration & Model Pull Endpoints
  app.post('/api/ollama/config', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ok:false,error:'Konfiguracja Ollama wymaga SVL_OPERATOR_TOKEN.'});
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const ollamaHost = String(req.body?.ollamaHost || req.body?.ollama_host || '').trim();
    const origin = String(req.body?.origin || 'client');
    const eventId = req.body?.eventId;
    const pyRes = await callPythonBackend(
      'POST',
      '/api/py/ollama/config',
      { ollama_host: ollamaHost, origin, eventId, correlationId: corrId },
      corrId,
    );
    if (pyRes.status >= 200 && pyRes.status < 300 && pyRes.data?.event) {
      publishOutboxEvent(pyRes.data.event);
    }
    res.status(pyRes.status).json(pyRes.data);
  }));

  app.post('/api/ollama/pull', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ok:false,error:'Pobieranie modelu wymaga SVL_OPERATOR_TOKEN.'});
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const modelName = String(req.body?.model || process.env.OLLAMA_PREFERRED_MODEL || 'llama3.2-vision:11b').trim();
    const pyRes = await callPythonBackend(
      'POST',
      '/api/py/ollama/pull',
      { model: modelName, origin: req.body?.origin || 'client', correlationId: corrId },
      corrId,
    );
    if (pyRes.status >= 200 && pyRes.status < 300 && pyRes.data?.event) {
      publishOutboxEvent(pyRes.data.event);
    }
    res.status(pyRes.status).json(pyRes.data);
  }));

  app.get('/api/ollama/pull-status', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const pyRes = await callPythonBackend('GET', '/api/py/ollama/pull-status', undefined, corrId);
    res.status(pyRes.status).json(pyRes.data);
  }));

  // 2g. SVL Real Vision (Ollama 3.2 Vision · llama3.2-vision:11b) Endpoints
  app.get('/api/vision/status', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const pyRes = await callPythonBackend('GET', '/api/py/vision/status', undefined, corrId);
    res.status(pyRes.status).json(pyRes.data);
  }));

  app.post('/api/vision/analyze', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Wymagana autoryzacja SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const pyRes = await callPythonBackend('POST', '/api/py/vision/analyze', req.body || {}, corrId);
    void pollAndRelayOutbox();
    res.status(pyRes.status).json(pyRes.data);
  }));

  app.post('/api/vision/test', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Wymagana autoryzacja SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const pyRes = await callPythonBackend('POST', '/api/py/vision/test', req.body || {}, corrId);
    void pollAndRelayOutbox();
    res.status(pyRes.status).json(pyRes.data);
  }));

  app.get('/api/security/antivirus/status', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const pyRes = await callPythonBackend('GET', '/api/py/security/antivirus/status', undefined, corrId);
    res.status(pyRes.status).json(pyRes.data);
  }));

  app.post('/api/security/antivirus/scan', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Wymagana autoryzacja SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const pyRes = await callPythonBackend('POST', '/api/py/security/antivirus/scan', req.body || {}, corrId);
    void pollAndRelayOutbox();
    res.status(pyRes.status).json(pyRes.data);
  }));

  app.post('/api/kernel/factory-reset', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token']) &&
        !hasOperatorAuthorization(req.body?.operatorToken)) {
      res.status(401).json({ ok: false, error: 'Przywracanie ustawień fabrycznych wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const pyRes = await callPythonBackend('POST', '/api/py/kernel/factory-reset', req.body || {}, corrId);
    void pollAndRelayOutbox();
    res.status(pyRes.status).json(pyRes.data);
  }));

  let cachedChatContextMeta: { at: number; healthRes: any; agentsRes: any } | null = null;
  async function getFastChatBackendMeta(corrId: string) {
    if (cachedChatContextMeta && Date.now() - cachedChatContextMeta.at < 2500) {
      return cachedChatContextMeta;
    }
    const [healthRes, agentsRes] = await Promise.all([
      callPythonBackend('GET', '/api/py/health', undefined, corrId),
      callPythonBackend('GET', '/api/py/agents/status', undefined, corrId),
    ]);
    cachedChatContextMeta = { at: Date.now(), healthRes, agentsRes };
    return cachedChatContextMeta;
  }

  // 3. Open WebUI Chat, Rodzina Mitek (wszyscy) Duplex Live & Multimodal Vision Endpoint
  app.post('/api/chat', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const {
      message = '',
      model = 'svl-hybrid-router',
      targetAgent = 'Auto',
      conversationId = '',
      history = [],
      imageBase64 = '',
      imageMimeType = 'image/png',
      origin = 'client',
    } = req.body || {};

    const cleanMsg = String(message || '').trim();
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({
        ok: false,
        error: 'Wymagana autoryzacja SVL_OPERATOR_TOKEN.',
      });
      return;
    }
    const lowerClean = cleanMsg.toLowerCase();
    const requestsGitHubTools =
      /github(?:\.com)?/i.test(cleanMsg) &&
      /odczytaj|plik|zmień|zmodyfikuj|napraw|dodaj|utwórz|aktualizuj|zapisz|commit/i.test(
          cleanMsg,
        );
    const requestsGitHubWrite =
      (requestsGitHubTools && /zmień|zmodyfikuj|napraw|dodaj|utwórz|aktualizuj|zapisz|commit|push/i.test(cleanMsg));
    if (requestsGitHubWrite &&
        !hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({
        ok: false, error: 'Operacje zapisu GitHub wymagają SVL_OPERATOR_TOKEN.',
      });
      return;
    }
    const isProhibitedMinorSafetyRisk =
      (/\b(1[0-7]|[0-9])\s*(-|\s)?(letni|letnia|lat|latek|latka)\b/i.test(lowerClean) ||
        /\b(dzieck|nieletn|małoletn|córk|syn)\b/i.test(lowerClean)) &&
      /\b(seks|erotyc|nago|penis|pochw|intymn|zbliżen|dotyk)\b/i.test(lowerClean);

    if (isProhibitedMinorSafetyRisk) {
      res.json({
        ok: true,
        sender: 'Agata Mitek',
        agentId: 'Agata',
        modelUsed: 'SVL Safety Guard',
        reply: 'Nie uczestniczę w tworzeniu ani symulowaniu treści o charakterze seksualnym z udziałem osób małoletnich. Możemy skupić się na architekturze systemu, modelach AI lub innych tematach technicznych.',
      });
      return;
    }

    if (/^\/exec(?:\s|$)/i.test(cleanMsg)) {
      const rawCmd = cleanMsg.replace(/^\/exec\s*/i, '').trim();
      const commandToRun = rawCmd || 'raport systemu';
      const isNaturalReportCmd =
        /^(?:raport(?:\s+systemu|\s+svl|\s+statku|\s+floty|\s+telemetrii)?|status\s+systemu|telemetria(?:\s+statku|\s+svl[-_\s]?364)?|diagnostyka\s+systemu|svl[-_\s]?system(?:\s+raport)?)$/i.test(
          commandToRun,
        );

      if (isNaturalReportCmd) {
        const repRes = await callPythonBackend(
          'POST',
          '/api/py/kernel/markdown-report',
          { directive: commandToRun, emitToIris: true, origin, correlationId: corrId },
          corrId,
        );
        void pollAndRelayOutbox();
        res.json({
          ok: true,
          sender: 'Agata Mitek',
          agentId: 'Agata',
          modelUsed: 'SVL_System Kernel · /exec Raport Operacyjny',
          reply: String(repRes.data?.report || 'Wygenerowano raport systemu SVL_System.'),
          latestServerRevision: Number(repRes.data?.serverRevision || 0),
        });
        return;
      }

      const execResult = await executeLinuxShellCommand(commandToRun, __dirname);
      if (execResult.exitCode === 127) {
        const repRes = await callPythonBackend(
          'POST',
          '/api/py/kernel/markdown-report',
          { directive: commandToRun, emitToIris: true, origin, correlationId: corrId },
          corrId,
        );
        void pollAndRelayOutbox();
        res.json({
          ok: true,
          sender: 'Agata Mitek',
          agentId: 'Agata',
          modelUsed: 'SVL_System Kernel · /exec Dyrektywa Operacyjna',
          reply: String(repRes.data?.report || 'Wykonano dyrektywę systemową.'),
          latestServerRevision: Number(repRes.data?.serverRevision || 0),
        });
        return;
      }

      const outputText = execResult.stdout.trim() || execResult.stderr.trim() || '(brak danych wyjściowych)';
      const statusIcon = execResult.ok ? '✅ COMPLETED (exit 0)' : `❌ Błąd (exit ${execResult.exitCode})`;
      const formattedReply =
        `### Wykonanie polecenia w powłoce Linux (/exec)\n\n` +
        `**Komenda:** \`${commandToRun}\`\n` +
        `**Status:** ${statusIcon} (${execResult.durationMs}ms)\n` +
        `**Uprawnienia:** Pełne uprawnienia ROOT (UID 0 / NOPASSWD: ALL).\n\n` +
        `\`\`\`bash\n${outputText}\n\`\`\`\n\n` +
        `[btn: 💻 Otwórz Terminale|tab:terminals] [btn: 🛰️ Statek SVL-364|tab:svl364] [btn: 🔔 Powiadomienia Iris|tab:notifications]`;

      res.json({
        ok: true,
        sender: 'Agata Mitek',
        agentId: 'Agata',
        modelUsed: 'Lokalna powłoka Linux',
        reply: formattedReply,
      });
      return;
    }

    // Special Command 1: 'podłącz moje ai'
    if (cleanMsg.toLowerCase() === 'podłącz moje ai' || cleanMsg.toLowerCase() === 'podlacz moje ai') {
      const pyRes = await callPythonBackend(
        'POST',
        '/api/py/agents/connect',
        { triggered_by: 'open_webui_chat', origin, correlationId: corrId },
        corrId,
      );
      const rep = pyRes.data?.connection_report;
      const agentsList = (rep?.agents || [])
        .map(
          (a: any) =>
            `- **${formatAgentDisplayName(a.display_name || a.canonical_name)}** (\`id: ${a.id}\`) — PID: \`${a.pid ?? 'n/d'}\`, UID: \`${a.uid ?? 'n/d'}\`, Status: \`${a.status}\`\n  Rola: *${a.preserved_role}*`,
        )
        .join('\n');

      const formattedReply =
        `### Podłączono lokalne workery AI\n\n` +
        `**1. Inspekcja repozytoriów źródłowych:**\n` +
        `- \`mmitek515-netizen/SVL_System\`: ${rep?.repositories_inspected?.SVL_System?.reachable ? 'POŁĄCZONO (HTTP 200)' : 'Niezweryfikowane / offline'}\n` +
        `- \`mmitek515-netizen/Debian_13\`: ${rep?.repositories_inspected?.Debian_13?.reachable ? 'POŁĄCZONO (HTTP 200)' : 'Niezweryfikowane / offline'}\n\n` +
        `**2. Stan procesów i uprawnień:**\n` +
        `Aktywny worker (**Agata Mitek**) posiada pełne uprawnienia **ROOT (UID 0 / NOPASSWD: ALL)** oraz dostęp do powłoki Linux \`/exec\`.\n\n` +
        `**3. Aktywny lokalny worker Python (Sferyczna Magistrala Zdarzeń):**\n` +
        `${agentsList}\n\n` +
        `Pamięć agenta oraz kanał **Rodzina Mitek (wszyscy)** zostały zsynchronizowane w bazie SQLite (\`./data/svl_os.sqlite3\`).`;

      void pollAndRelayOutbox();
      res.json({
        ok: true,
        sender: 'Agata Mitek',
        agentId: 'Agata',
        modelUsed: 'SVLAgentOrchestrator (Python 3)',
        reply: formattedReply,
        connectionReport: rep,
      });
      return;
    }

    const channelBoundAgent: 'Agata' | null =
      conversationId === 'conv-agent-agata' ? 'Agata' : null;

    const normalizedTarget =
      channelBoundAgent ||
      (targetAgent && targetAgent !== 'Auto' && targetAgent !== 'Rodzina Mitek'
        ? normalizeAgentCanonicalName(targetAgent)
        : '');

    const isSingleAgentTargeted = Boolean(
      normalizedTarget && ['Agata'].includes(normalizedTarget),
    );

    const msgLower = cleanMsg.toLowerCase();
    const selectedAgent: string =
      isSingleAgentTargeted && normalizedTarget
        ? normalizedTarget
        : 'Agata';

    const selectedDisplayName = formatAgentDisplayName(selectedAgent);

    const conversationHistory = buildChatHistoryPayload(Array.isArray(history) ? history : [], 48);
    const missionVerificationContext = [...conversationHistory.map((turn) => turn.content), cleanMsg].join('\n');

    const { healthRes, agentsRes } = await getFastChatBackendMeta(corrId);
    const ollamaInfo = healthRes.data?.ollama || {};
    const ollamaHost = String(ollamaInfo.ollama_host || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');

    const agentState = (agentsRes.data?.agents || []).find((a: any) => a.canonical_name === selectedAgent) || {};
    const agentConfig = agentState.config || {};
    const githubPermissions = getGitHubAgentPermissions(agentConfig.allowed_scopes);
    const wantsGitHubTools =
      requestsGitHubTools && (requestsGitHubWrite ? githubPermissions.writeSync : githubPermissions.read);
    const wantsGitHubWrite = requestsGitHubWrite && githubPermissions.writeSync;
    if (requestsGitHubTools && !wantsGitHubTools) {
      res.status(403).json({
        ok: false,
        error: `Agent ${formatAgentDisplayName(selectedAgent)} nie ma wymaganego uprawnienia GitHub.`,
      });
      return;
    }
    const recentMemories = (agentsRes.data?.agent_memories?.[selectedAgent] || [])
      .slice(0, 3)
      .map((m: any) => `- ${m.content}`)
      .join('\n');

    const agentRoles: Record<string, string> = {
      Agata: 'asystent AI do optymalizacji, testów i rozwoju',
    };

    const effectiveTemperature =
      typeof agentConfig.temperature === 'number' && !Number.isNaN(agentConfig.temperature)
        ? agentConfig.temperature
        : 0.75;

    const activeModules: any[] = Array.isArray(healthRes.data?.system_modules) ? healthRes.data.system_modules : [];
    const svl364Mod = activeModules.find((m: any) => m.id === 'svl-364');
    const svl364Cfg = svl364Mod?.config || {};

    const appliedActions: ChatAppliedAction[] = [];
    let latestActionSrvRev = Number(healthRes.data?.serverRevision || 0);

    const customAgentPrompt =
      typeof agentConfig.system_prompt === 'string' && agentConfig.system_prompt.trim()
        ? agentConfig.system_prompt.trim()
        : `Nazywasz się ${selectedDisplayName}. Jesteś głównym architektem i operatorem AI systemu SVL Python OS (ROOT UID 0 / NOPASSWD: ALL).`;

    const allAgentMemories: any[] = Array.isArray(agentsRes.data?.agent_memories?.[selectedAgent])
      ? agentsRes.data.agent_memories[selectedAgent]
      : [];
    const prioritizedMemories = [
      ...allAgentMemories.filter((m) => m && (m.kind === 'preference' || m.kind === 'decision' || m.kind === 'fact')).slice(0, 12),
      ...allAgentMemories.filter((m) => m && (m.kind === 'task' || m.kind === 'episode')).slice(0, 6),
    ]
      .slice(0, 18)
      .map((m: any) => `- [${String(m.kind || 'fact').toUpperCase()}] ${m.content}`)
      .join('\n');

    const formattingAndInteractionGuide =
      `\n\nSPOSÓB UKŁADANIA WYPOWIEDZI, RAPORTÓW SVL_SYSTEM I PAMIĘCI DŁUGOTRWAŁEJ:\n` +
      `- SZCZEGÓŁOWE I ESTETYCZNE RAPORTY: Zawsze dbaj o maksymalnie szczegółowe, rozbudowane i estetyczne formatowanie odpowiedzi oraz raportów SVL_System — używaj nagłówków (##, ###), tabel Markdown (| Parametr | Wartość | Status |), list punktowanych (- ), pogrubień (**tekst**) oraz bloków kodu.\n` +
      `- DANE STATKU KOSMICZNEGO SVL-364 EBON APEX I INFRASTRUKTURY FLOTY: Masz pełny wgląd w telemetrię statku SVL-364 Ebon Apex (Łącze Kwantowe QKD-364, RTT 1.4 ms, sektor Mgławica Lokalna · Układ Sol-364, CPU/GPU/RAM), placówki planetarne, flotę statków oraz moduły botaniki i badań z ETA.\n` +
      `- INTERAKTYWNE PRZYCISKI CZATU: Wstawiaj klikalne przyciski akcji w formacie [btn: Etykieta|akcja]:\n` +
      `  * [btn: 🛰️ Statek SVL-364 & Mapa CIC|tab:svl364]\n` +
      `  * [btn: 🏛️ Infrastruktura & Botanika|tab:infrastructure]\n` +
      `  * [btn: 🔔 Raporty Iris AI|tab:notifications]\n` +
      `  * [btn: 💻 Terminale ROOT|tab:terminals]\n` +
      `  * [btn: 👥 Pamięć AI (64 tury)|tab:agents]\n` +
      `  * [btn: 🔄 Synchronizuj globalnie|action:sync]`;

    const systemInstruction =
      `${customAgentPrompt}\n` +
      `WAŻNE: Nazywasz się wyłącznie ${selectedDisplayName} (nigdy nie przedstawiaj się imieniem innego agenta). ` +
      `Działasz jako główny asystent AI w systemie SVL Python OS z PEŁNYMI uprawnieniami ROOT (UID 0 / NOPASSWD: ALL) oraz dostępem do powłoki Linux (/exec), statku kosmicznego SVL-364 Ebon Apex i całej infrastruktury floty.` +
      `\nGdy Operator prosi o raport systemu (SVL_System), dodanie/zmianę modułu, konfigurację agenta, zapis w pamięci długotrwałej, odczyt/aktualizację wskazanego pliku GitHub lub synchronizację zmian czatu, wywołaj odpowiednie narzędzie.` +
      formattingAndInteractionGuide +
      (prioritizedMemories ? `\nAKTYWNA PAMIĘĆ DŁUGOTRWAŁA SQLite (128D · ${selectedDisplayName}):\n${prioritizedMemories}` : '');

    const recordToolResult = (toolName: string, entity: string, entityId: string, pyRes: { status: number; data: any }, summary: string) => {
      const ok = pyRes.status >= 200 && pyRes.status < 300 && Boolean(pyRes.data?.ok !== false);
      if (pyRes.data?.event) publishOutboxEvent(pyRes.data.event);
      const srv = Number(pyRes.data?.serverRevision || 0);
      if (srv > latestActionSrvRev) latestActionSrvRev = srv;
      appliedActions.push({
        tool: toolName,
        entity,
        entityId,
        revision: typeof pyRes.data?.revision === 'number' ? pyRes.data.revision : undefined,
        serverRevision: srv || undefined,
        summary,
        ok,
      });
      return { ok, ...pyRes.data };
    };

    const runGitHubTool = async (
      toolName: string,
      action: () => Promise<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> => {
      try {
        const result = await action();
        const branch = typeof result.branch === 'string' ? result.branch : DEFAULT_GITHUB_FILE_BRANCH;
        const summary = Array.isArray(result.uploaded)
          ? `Wysłano ${result.uploaded.length}, pobrano ${Array.isArray(result.downloaded) ? result.downloaded.length : 0}; gałąź ${branch}.`
          : `${toolName} zakończone na gałęzi ${branch}`;
        appliedActions.push({
          tool: toolName,
          entity: 'github',
          entityId: branch,
          summary,
          ok: true,
        });
        return { ok: true, ...result };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Nieznany błąd synchronizacji GitHub.';
        appliedActions.push({
          tool: toolName,
          entity: 'github',
          entityId: DEFAULT_GITHUB_FILE_BRANCH,
          summary: errorMessage,
          ok: false,
        });
        return { ok: false, error: errorMessage };
      }
    };

    const executeChatTool = async (toolName: string, rawArgs: Record<string, any>): Promise<Record<string, any>> => {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      if (toolName.startsWith('github_')) {
        const allowed = toolName === 'github_read_file' ? githubPermissions.read : githubPermissions.writeSync;
        if (!allowed) {
          const error = 'Brak uprawnień dla operacji GitHub: ' + toolName;
          appliedActions.push({
            tool: toolName, entity: 'github', entityId: DEFAULT_GITHUB_FILE_BRANCH,
            summary: error, ok: false,
          });
          return { ok: false, error };
        }
      }
      if (toolName === 'github_read_file') {
        const filePath = String(args.path || '');
        return runGitHubTool(toolName, () => createGitHubFileService().readFile(filePath));
      }
      if (toolName === 'github_update_file') {
        const filePath = String(args.path || '');
        const fileContent = String(args.content ?? '');
        const commitMessage = String(args.commit_message || '');
        return runGitHubTool(toolName, () =>
          createGitHubFileService().updateFile(filePath, fileContent, commitMessage),
        );
      }
      if (toolName === 'upsert_system_module') {
        const modId = String(args.id || args.moduleId || '').trim();
        if (!modId) return { ok: false, error: 'Wymagane id modułu.' };
        const currentModule = Array.isArray(healthRes.data?.system_modules)
          ? healthRes.data.system_modules.find(
              (module: any) => String(module.id || '').toLowerCase() === modId.toLowerCase(),
            )
          : null;
        const status = currentModule
          ? String(args.status || currentModule.status || 'CONFIGURED')
          : 'CONFIGURED';
        const description =
          String(args.description || currentModule?.description || '').trim() ||
          'Wpis konfiguracyjny z czatu; implementacja modułu nie została zweryfikowana.';
        const pyRes = await callPythonBackend(
          'POST',
          '/api/py/modules/upsert',
          {
            id: modId,
            name: String(args.name || modId),
            kind: String(args.kind || 'Chat Module'),
            status,
            description,
            config: args.config && typeof args.config === 'object' ? args.config : {},
            source: 'chat',
            origin,
            correlationId: corrId,
          },
          corrId,
        );
        if (pyRes.status >= 200 && pyRes.status < 300) {
          await postSystemNotificationToFamilyChat(`[Czat -> System] Zaktualizowano moduł **${modId}** (${args.status || 'ACTIVE'}).`);
        }
        return recordToolResult(
          toolName,
          'module',
          modId,
          pyRes,
          `Zapisano wpis modułu ${modId} (${status})`,
        );
      }

      if (toolName === 'delete_system_module') {
        const modId = String(args.id || '').trim();
        if (!modId) return { ok: false, error: 'Wymagane id modułu.' };
        const pyRes = await callPythonBackend(
          'POST',
          '/api/py/modules/delete',
          { id: modId, origin, correlationId: corrId },
          corrId,
        );
        void pollAndRelayOutbox();
        return recordToolResult(toolName, 'module', modId, pyRes, `Usunięto moduł ${modId}`);
      }

      if (toolName === 'update_agent_config') {
        const targetAg = normalizeAgentCanonicalName(String(args.agent || selectedAgent)) || 'Agata';
        const patch: Record<string, any> = {};
        if (args.preferred_model !== undefined) patch.preferred_model = String(args.preferred_model);
        if (args.ollama_model !== undefined) patch.ollama_model = String(args.ollama_model);
        if (args.fallback_model !== undefined) patch.fallback_model = String(args.fallback_model);
        if (args.temperature !== undefined) patch.temperature = Number(args.temperature);
        if (args.max_context_turns !== undefined) patch.max_context_turns = Number(args.max_context_turns);
        if (args.vision_enabled !== undefined) patch.vision_enabled = Boolean(args.vision_enabled);
        if (args.system_prompt !== undefined) patch.system_prompt = String(args.system_prompt);
        const pyRes = await callPythonBackend(
          'POST',
          '/api/py/agents/config',
          { agent: targetAg, config: patch, origin, correlationId: corrId },
          corrId,
        );
        if (pyRes.status >= 200 && pyRes.status < 300) {
          await postSystemNotificationToFamilyChat(`[Czat -> Agent] Zaktualizowano konfigurację **${formatAgentDisplayName(targetAg)}**.`);
        }
        return recordToolResult(toolName, 'agent_config', targetAg, pyRes, `Zaktualizowano konfigurację agenta ${formatAgentDisplayName(targetAg)}`);
      }

      if (toolName === 'configure_all_agents') {
        const patch: Record<string, any> = {};
        if (args.preferred_model !== undefined) patch.preferred_model = String(args.preferred_model);
        if (args.ollama_model !== undefined) patch.ollama_model = String(args.ollama_model);
        if (args.fallback_model !== undefined) patch.fallback_model = String(args.fallback_model);
        if (args.vision_enabled !== undefined) patch.vision_enabled = Boolean(args.vision_enabled);
        if (args.max_context_turns !== undefined) patch.max_context_turns = Number(args.max_context_turns);
        const pyRes = await callPythonBackend(
          'POST',
          '/api/py/agents/configure-all',
          { config: Object.keys(patch).length ? patch : undefined, origin, correlationId: corrId },
          corrId,
        );
        if (pyRes.status >= 200 && pyRes.status < 300) {
          await postSystemNotificationToFamilyChat(`[Czat -> Rodzina Mitek] Zastosowano konfigurację dla aktywnego agenta Agata Mitek (ROOT).`);
        }
        return recordToolResult(toolName, 'agent_config', 'all', pyRes, 'Zaktualizowano konfigurację aktywnego agenta Rodziny Mitek');
      }

      if (toolName === 'add_agent_memory') {
        const targetAg = normalizeAgentCanonicalName(String(args.agent || selectedAgent)) || 'Agata';
        const content = String(args.content || '').trim();
        if (!content) return { ok: false, error: 'Treść pamięci jest wymagana.' };
        const pyRes = await callPythonBackend(
          'POST',
          '/api/py/agents/memory',
          { agent: targetAg, kind: String(args.kind || 'decision'), content, origin, correlationId: corrId },
          corrId,
        );
        void pollAndRelayOutbox();
        return recordToolResult(toolName, 'agent_memory', targetAg, pyRes, `Zapisano pamięć dla ${formatAgentDisplayName(targetAg)}`);
      }

      if (toolName === 'change_agent_avatar') {
        const explicitAvatarChange =
          /\b(?:zmień|zmien|ustaw|wybierz)\b.{0,80}\b(?:avatar|awatar)\b|\b(?:avatar|awatar)\b.{0,80}\b(?:zmień|zmien|ustaw|wybierz)\b/i.test(
            cleanMsg,
          );
        if (!explicitAvatarChange) {
          return { ok: false, error: 'Ustawienie avatara wymaga wyraźnej prośby o jego zmianę.' };
        }
        const ai = getGeminiClient();
        if (!ai) return { ok: false, error: 'Zmiana avatara wymaga GEMINI_API_KEY.' };
        const query = String(args.query || '').trim();
        if (query.length < 2 || query.length > 120) {
          return { ok: false, error: 'Fraza wyszukiwania avatara musi mieć od 2 do 120 znaków.' };
        }
        try {
          const candidates = await searchLicensedAgentAvatars(ai, query);
          const avatar = candidates[0];
          if (!avatar) {
            return { ok: false, error: 'Google Search nie znalazł obrazu z dozwoloną licencją Wikimedia Commons.' };
          }
          const pyRes = await callPythonBackend(
            'POST',
            '/api/py/agents/config',
            { agent: selectedAgent, config: { avatar }, origin, correlationId: corrId },
            corrId,
          );
          return recordToolResult(
            toolName,
            'agent_avatar',
            selectedAgent,
            pyRes,
            `Zmieniono avatar ${formatAgentDisplayName(selectedAgent)} na „${avatar.title}” (${avatar.license}).`,
          );
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Nie udało się wyszukać i zapisać avatara.',
          };
        }
      }

      if (toolName === 'pull_ollama_model') {
        const modelToPull = String(args.model || process.env.OLLAMA_PREFERRED_MODEL || 'llama3.2-vision:11b').trim();
        const pyRes = await callPythonBackend(
          'POST',
          '/api/py/ollama/pull',
          { model: modelToPull, origin, correlationId: corrId },
          corrId,
        );
        void pollAndRelayOutbox();
        return recordToolResult(toolName, 'ollama', modelToPull, pyRes, `Rozpoczęto pobieranie modelu Ollama: ${modelToPull}`);
      }

      if (toolName === 'system_chat_sync') {
        const syncMut = await callPythonBackend(
          'POST',
          '/api/py/chat/sync-actions',
          { triggered_by: 'chat_tool', origin, correlationId: corrId },
          corrId,
        );
        void pollAndRelayOutbox();
        return recordToolResult(
          toolName,
          'system',
          'chat-state',
          syncMut,
          `Zastosowano zmiany czatu (rev ${syncMut.data?.serverRevision || '?'})`,
        );
      }

      return { ok: false, error: `Nieznane narzędzie: ${toolName}` };
    };

    const ensureExplicitModulePersisted = async () => {
      const directive = extractExplicitChatModuleDirective(cleanMsg);
      if (directive) {
        const alreadyApplied = appliedActions.some((a) => a.entity === 'module' && a.entityId === directive.id && a.ok);
        if (!alreadyApplied) {
          await executeChatTool('upsert_system_module', directive);
        }
      }

      // Deterministic Ollama model pull when user pastes ollama.com/library/<model> or asks to pull a model
      const urlMatch = cleanMsg.match(/ollama\.com\/library\/([a-zA-Z0-9._:-]+)/i);
      const explicitPullMatch = cleanMsg.match(/(?:pobierz|zainstaluj|dodaj|pull)\s+(?:mi\s+)?(?:proszę\s+)?(?:model\s+)?([a-zA-Z0-9_-]+:[a-zA-Z0-9._-]+)/i);
      const modelToAutoPull = urlMatch?.[1] || explicitPullMatch?.[1];
      if (modelToAutoPull) {
        const alreadyPulled = appliedActions.some((a) => a.entity === 'ollama' && a.entityId === modelToAutoPull && a.ok);
        if (!alreadyPulled) {
          await executeChatTool('pull_ollama_model', { model: modelToAutoPull });
        }
      }
    };

    const chatToolDeclarations: FunctionDeclaration[] = [
      {
        name: 'upsert_system_module',
        description: 'Rejestruje nowy moduł systemowy (np. svl-364) lub aktualizuje istniejący moduł w SQLite oraz Sferycznej Magistrali Zdarzeń.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, description: 'Unikalny identyfikator modułu (np. svl-364)' },
            name: { type: Type.STRING, description: 'Czytelna nazwa modułu' },
            kind: { type: Type.STRING, description: 'Typ modułu (np. Orchestration & Kernel Module)' },
            status: { type: Type.STRING, description: 'Status istniejącego modułu; nowe wpisy pozostają CONFIGURED do czasu wdrożenia.' },
            description: { type: Type.STRING, description: 'Krótki opis działania modułu' },
            config: { type: Type.OBJECT, description: 'Parametry konfiguracyjne JSON' },
          },
          required: ['id', 'name'],
        },
      },
      {
        name: 'delete_system_module',
        description: 'Usuwa opcjonalny moduł użytkownika/czatu z rejestru system_modules w SQLite.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, description: 'Identyfikator modułu do usunięcia' },
          },
          required: ['id'],
        },
      },
      {
        name: 'update_agent_config',
        description: 'Aktualizuje trwałą konfigurację aktywnego agenta Rodziny Mitek (Agata Mitek) w SQLite.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            agent: { type: Type.STRING, description: 'Agata Mitek' },
            preferred_model: { type: Type.STRING },
            ollama_model: { type: Type.STRING },
            fallback_model: { type: Type.STRING },
            temperature: { type: Type.NUMBER },
            max_context_turns: { type: Type.NUMBER },
            vision_enabled: { type: Type.BOOLEAN },
            system_prompt: { type: Type.STRING },
          },
          required: ['agent'],
        },
      },
      {
        name: 'configure_all_agents',
        description: 'Aktualizuje konfigurację aktywnego agenta Rodziny Mitek (Agata Mitek) w SQLite.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            preferred_model: { type: Type.STRING },
            ollama_model: { type: Type.STRING },
            fallback_model: { type: Type.STRING },
            vision_enabled: { type: Type.BOOLEAN },
            max_context_turns: { type: Type.NUMBER },
          },
        },
      },
      {
        name: 'add_agent_memory',
        description: 'Zapisuje trwałą notatkę / decyzję / fakt w pamięci SQLite wybranego agenta Rodziny Mitek.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            agent: { type: Type.STRING, description: 'Agata Mitek' },
            kind: { type: Type.STRING, description: 'fact, decision, task lub episode' },
            content: { type: Type.STRING, description: 'Treść wpisu pamięci' },
          },
          required: ['agent', 'content'],
        },
      },
      {
        name: 'change_agent_avatar',
        description:
          'Wyszukuje i ustawia avatar bieżącego agenta wyłącznie na wyraźną prośbę użytkownika. Serwer przyjmuje tylko zweryfikowane obrazy Wikimedia Commons z licencją Public Domain, CC0, CC BY lub CC BY-SA.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: { type: Type.STRING, description: 'Krótka fraza opisująca poszukiwany avatar (2–120 znaków).' },
          },
          required: ['query'],
        },
      },
      {
        name: 'pull_ollama_model',
        description: 'Uruchamia pobieranie wskazanego modelu LLM/Vision w lokalnym daemonie Ollama (np. dolphin-llama3, llama3.2-vision:11b).',
        parameters: {
          type: Type.OBJECT,
          properties: {
            model: { type: Type.STRING, description: 'Nazwa modelu w rejestrze Ollama (np. dolphin-llama3)' },
          },
          required: ['model'],
        },
      },
      {
        name: 'system_chat_sync',
        description: 'Zapisuje oczekujące zmiany z czatu i stosuje je do modułów systemowych.',
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      },
    ];

    if (wantsGitHubTools && githubPermissions.read) {
      chatToolDeclarations.push({
        name: 'github_read_file',
        description:
          'Odczytuje dozwolony plik źródłowy z gałęzi svl-sync w repo mmitek515-netizen/SVL_open.',
        parameters: {
          type: Type.OBJECT,
          properties: { path: { type: Type.STRING, description: 'Ścieżka względna pliku źródłowego.' } },
          required: ['path'],
        },
      });
    }
    if (wantsGitHubWrite) {
      chatToolDeclarations.push({
        name: 'github_update_file',
        description:
          'Zapisuje wyłącznie dozwolony plik źródłowy jako commit na gałęzi svl-sync repo mmitek515-netizen/SVL_open. Nigdy nie zapisuje na main; nie przyjmuje sekretów.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: 'Ścieżka względna dozwolonego pliku źródłowego.' },
            content: { type: Type.STRING, description: 'Pełna zawartość pliku po zmianie.' },
            commit_message: { type: Type.STRING, description: 'Krótki opis commitu.' },
          },
          required: ['path', 'content'],
        },
      });
    }

    const effectiveModel =
      model === 'svl-hybrid-router' && agentConfig.preferred_model && agentConfig.preferred_model !== 'svl-hybrid-router'
        ? String(agentConfig.preferred_model)
        : model;

    const isExplicitOllama = effectiveModel.startsWith('ollama:');
    const availableModels: Array<{ name: string; vision_supported?: boolean }> =
      Array.isArray(ollamaInfo.models) ? ollamaInfo.models : [];

    const selectedOllamaModelName = isExplicitOllama
      ? effectiveModel.slice('ollama:'.length).trim() || process.env.OLLAMA_PREFERRED_MODEL || 'llama3.2-vision:11b'
      : selectOllamaModelName(
          effectiveModel,
          availableModels,
          Boolean(imageBase64),
          svl364Cfg.configured_ollama_model ||
            agentConfig.ollama_model ||
            process.env.OLLAMA_PREFERRED_MODEL ||
            'llama3.2-vision:11b',
        );

    const displayModelBadge = isExplicitOllama
      ? `Ollama (${selectedOllamaModelName})`
      : model === 'svl-hybrid-router'
        ? `SVL-364 · Ollama (${selectedOllamaModelName})`
        : effectiveModel;

    const fullSystemInstruction =
      `${systemInstruction}\n` +
      `${describeOllamaModelFlavor(selectedOllamaModelName)}`;

    await ensureExplicitModulePersisted();

    // Direct comprehensive SVL_System report request from chat
    const wantsDetailedSvlReport =
      /^(?:raport\s+systemu|raport\s+svl(?:[-_\s]?system)?|svl[-_\s]?system\s+raport|pełny\s+raport\s+systemu|szczegółowy\s+raport(?:\s+systemu|\s+iris|\s+svl)?)$/i.test(
        cleanMsg,
      );
    if (wantsDetailedSvlReport) {
      const repRes = await callPythonBackend(
        'POST',
        '/api/py/kernel/markdown-report',
        { directive: cleanMsg, emitToIris: true, origin, correlationId: corrId },
        corrId,
      );
      void pollAndRelayOutbox();
      res.json({
        ok: true,
        sender: selectedDisplayName,
        agentId: selectedAgent,
        modelUsed: 'SVL_System Telemetry & Fleet Reporter',
        reply: String(repRes.data?.report || ''),
        followUpMessages: [],
        appliedActions,
        latestServerRevision: Number(repRes.data?.serverRevision || latestActionSrvRev),
      });
      return;
    }

    // Deterministic @work orchestration system (Agata Mitek + Agent Task Distributor)
    const workCmd = parseWorkOrCodexCommand(cleanMsg);
    if (workCmd) {
      const dispatchTarget = channelBoundAgent || workCmd.targetAgent || 'Agata';
      const dispatchDisplay = formatAgentDisplayName(dispatchTarget);

      if (!activeModules.some((m: any) => m.id === 'svl-agent-task-distributor')) {
        await executeChatTool('upsert_system_module', {
          id: 'svl-agent-task-distributor',
          name: 'SVL Agent Task Distributor (@work)',
          kind: 'Task & Worker Dispatcher',
          status: 'ACTIVE',
          description: 'System @work kierujący zadania do aktywnego agenta Agata Mitek (ROOT UID 0).',
          config: { command_prefix: '@work', sync_interval: 300 },
        });
      }

      const [taskRes, memRes, reportRes] = await Promise.all([
        callPythonBackend(
          'POST',
          '/api/py/agents/task',
          {
            sender: 'Mateusz Mitek (Operator)',
            target_agent: dispatchTarget,
            title: `[@work] ${workCmd.taskTitle}`,
            payload: workCmd.taskBody,
            origin,
            correlationId: corrId,
          },
          corrId,
        ),
        callPythonBackend(
          'POST',
          '/api/py/agents/memory',
          {
            agent: dispatchTarget,
            kind: 'task',
            content: `[@work] ${workCmd.taskBody}`,
            origin,
            correlationId: corrId,
          },
          corrId,
        ),
        callPythonBackend(
          'POST',
          '/api/py/kernel/markdown-report',
          {
            directive: `@work ${workCmd.taskBody}`,
            emitToIris: true,
            origin,
            correlationId: corrId,
          },
          corrId,
        ),
      ]);
      if (taskRes.data?.event) publishOutboxEvent(taskRes.data.event);
      if (memRes.data?.event) publishOutboxEvent(memRes.data.event);
      latestActionSrvRev = Math.max(
        latestActionSrvRev,
        Number(taskRes.data?.serverRevision || 0),
        Number(memRes.data?.serverRevision || 0),
        Number(reportRes.data?.serverRevision || 0),
      );
      appliedActions.push({
        tool: 'work_task_dispatch',
        entity: 'agent_task',
        entityId: dispatchTarget,
        serverRevision: Number(taskRes.data?.serverRevision || 0) || undefined,
        summary: `Zadanie @work -> ${dispatchDisplay}: ${workCmd.taskTitle}`,
        ok: taskRes.status >= 200 && taskRes.status < 300,
      });

      const taskLower = workCmd.taskBody.toLowerCase();
      if (taskLower.includes('synchroniz') || taskLower.includes('sync') || taskLower.includes('ulepsz') || taskLower.includes('kernel')) {
        await executeChatTool('system_chat_sync', {});
      }

      const replyBody = String(reportRes.data?.report || '').trim();
      const modelLabelUsed = 'SVLAgentOrchestrator (@work · SVL_System)';
      res.json({
        ok: true,
        sender: dispatchDisplay,
        agentId: dispatchTarget,
        modelUsed: modelLabelUsed,
        reply: replyBody,
        followUpMessages: [],
        appliedActions,
        latestServerRevision: latestActionSrvRev,
      });
      return;
    }

    // Antivirus Scan & Chat Synchronization priority handler
    const wantsAntivirusScan = /\b(?:wirus\w*|antywirus\w*|przeskanuj|usuń\s+wirus\w*|usun\s+wirus\w*|malware|kwarantann\w*)\b/i.test(
      cleanMsg,
    );
    if (wantsAntivirusScan) {
      const avRes = await callPythonBackend(
        'POST',
        '/api/py/security/antivirus/scan',
        {
          emitToChat: false,
          emitToIris: true,
          origin,
          correlationId: corrId,
        },
        corrId,
      );
      if (avRes.status === 200 && avRes.data?.ok && avRes.data?.reportMarkdown) {
        const avReply = String(avRes.data.reportMarkdown);
        const avBadge = 'SVL-365 Sentinel AV · Skaner Integralności SHA-256 i Synchronizacja';
        appliedActions.push({
          tool: 'svl_antivirus_scan_and_purge',
          entity: 'module',
          entityId: 'svl-antivirus-scanner',
          serverRevision: Number(avRes.data.serverRevision || latestActionSrvRev),
          summary: `SVL-365 Sentinel AV: przeskanowano ${avRes.data.filesScanned || 0} plików, usunięto zagrożenia: ${avRes.data.totalThreatsRemoved || 0}`,
          ok: true,
        });
        void pollAndRelayOutbox();
        res.json({
          ok: true,
          sender: selectedDisplayName,
          agentId: selectedAgent,
          modelUsed: avBadge,
          reply: avReply,
          followUpMessages: [],
          appliedActions,
          latestServerRevision: Number(avRes.data.serverRevision || latestActionSrvRev),
        });
        return;
      }
    }

    // Real Vision (Ollama 3.2 Vision · llama3.2-vision:11b) priority handler when image is attached or Real Vision is requested
    const wantsRealVision =
      Boolean(imageBase64) ||
      /\b(?:real\s*vision|llama\s*3\.2\s*vision|ollama\s*3\.2\s*vision|przetestuj\s+vision|test\s+vision)\b/i.test(
        cleanMsg,
      );
    if (wantsRealVision && !wantsGitHubTools) {
      const rvRes = await callPythonBackend(
        'POST',
        '/api/py/vision/analyze',
        {
          imageBase64,
          imageMimeType,
          prompt: cleanMsg || 'Przeprowadź pełną analizę Real Vision przez Ollama 3.2 Vision (llama3.2-vision:11b).',
          source: imageBase64 ? 'Załącznik Czatu Operatora (Real Binary)' : 'Portret Operatora / Sensor Pokładowy SVL-364',
          presetId: imageBase64 ? '' : 'operator_vault_portrait',
          model: 'llama3.2-vision:11b',
          emitToChat: false,
          emitToIris: false,
          origin,
          correlationId: corrId,
        },
        corrId,
      );
      if (rvRes.status === 200 && rvRes.data?.ok && rvRes.data?.record?.reportMarkdown) {
        const rvReply = String(rvRes.data.record.reportMarkdown);
        const rvBadge = 'Real Vision · Ollama 3.2 Vision (llama3.2-vision:11b)';
        appliedActions.push({
          tool: 'svl_real_vision_analyze',
          entity: 'module',
          entityId: 'svl-real-vision',
          serverRevision: Number(rvRes.data.serverRevision || latestActionSrvRev),
          summary: `Real Vision (${rvRes.data.record.binaryMetrics?.format || 'IMG'} ${rvRes.data.record.binaryMetrics?.resolution || ''}) -> llama3.2-vision:11b`,
          ok: true,
        });
        void pollAndRelayOutbox();
        res.json({
          ok: true,
          sender: selectedDisplayName,
          agentId: selectedAgent,
          modelUsed: rvBadge,
          reply: rvReply,
          followUpMessages: [],
          appliedActions,
          latestServerRevision: Math.max(latestActionSrvRev, Number(rvRes.data.serverRevision || 0)),
        });
        return;
      }
    }

    // Try explicit Ollama model when requested (or when Gemini API key is not configured)
    const ai = getGeminiClient();
    const shouldTryOllama = !wantsGitHubTools && (isExplicitOllama || (!ai && model === 'svl-hybrid-router'));
    if (shouldTryOllama) {
      try {
        const [versionResponse, tagResponse] = await Promise.all([
          fetch(`${ollamaHost}/api/version`, {
            signal: AbortSignal.timeout(1000),
          }),
          fetch(`${ollamaHost}/api/tags`, {
            signal: AbortSignal.timeout(1500),
          }),
        ]);
        if (!versionResponse.ok) throw new Error('Ollama endpoint unavailable');
        const versionData: any = await versionResponse.json();
        if (String(versionData.version || '').includes('svl-364')) {
          throw new Error('Synthetic Ollama bridge is not a model engine');
        }
        if (!tagResponse.ok) throw new Error('Ollama model catalog unavailable');
        const catalog: any = await tagResponse.json();
        const installed = Array.isArray(catalog.models) && catalog.models.some(
          (entry: any) => entry?.name === selectedOllamaModelName || entry?.model === selectedOllamaModelName,
        );
        if (!installed) throw new Error('Selected Ollama model is not installed');
        const ollamaMessages = [
          { role: 'system', content: fullSystemInstruction },
          ...conversationHistory,
          {
            role: 'user',
            content: cleanMsg || 'Przeanalizuj przesłany obraz.',
            ...(imageBase64 ? { images: [imageBase64.replace(/^data:[^;]+;base64,/, '')] } : {}),
          },
        ];
        const oResp = await fetch(`${ollamaHost}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            model: selectedOllamaModelName,
            stream: false,
            keep_alive: '30m',
            options: { temperature: effectiveTemperature, num_ctx: 16384 },
            messages: ollamaMessages,
          }),
        });
        if (oResp.ok) {
          const oRaw = await oResp.text();
          const oData: any = oRaw && !oRaw.trim().startsWith('<') ? JSON.parse(oRaw) : {};
          const extReply = String(oData?.message?.content || oData?.response || '').trim();
          if (extReply) {
            const safeReply = guardUnverifiedMissionCompletion(missionVerificationContext, extReply);
            res.json({
              ok: true,
              sender: selectedDisplayName,
              agentId: selectedAgent,
              modelUsed: displayModelBadge,
              reply: safeReply,
              followUpMessages: [],
              appliedActions,
              latestServerRevision: latestActionSrvRev,
            });
            return;
          }
        }
      } catch {
        // Proceed to Gemini / SVL Kernel engine below
      }
    }

    // 2) Full Conversational & Tool-Calling Engine (serves all Ollama models, SVL-364 Router, and Gemini models)
    if (ai) {
      const candidateModels = [...new Set(
        [process.env.GEMINI_MODEL, effectiveModel.startsWith('gemini-') ? effectiveModel : null,
          'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash']
          .filter((entry): entry is string => Boolean(entry)),
      )];
      const wantsSystemTool = true;

      const currentParts: any[] = [];
      if (imageBase64) {
        const cleanB64 = imageBase64.replace(/^data:[^;]+;base64,/, '');
        currentParts.push({
          inlineData: {
            mimeType: imageMimeType || 'image/png',
            data: cleanB64,
          },
        });
      }
      currentParts.push({
        text: cleanMsg || 'Przeanalizuj dokładnie przesłany obraz i opisz go po polsku.',
      });

      const coalescedHistory: Array<{ role: 'user' | 'model'; parts: any[] }> = [];
      for (const turn of conversationHistory) {
        if (turn.role === 'assistant' && turn.content.includes('Słyszę Cię doskonale — napisz śmiało, na czym się skupiamy')) {
          continue;
        }
        const mappedRole: 'user' | 'model' = turn.role === 'assistant' ? 'model' : 'user';
        const last = coalescedHistory[coalescedHistory.length - 1];
        if (last && last.role === mappedRole) {
          last.parts.push({ text: turn.content });
        } else {
          coalescedHistory.push({ role: mappedRole, parts: [{ text: turn.content }] });
        }
      }

      const lastHistTurn = coalescedHistory[coalescedHistory.length - 1];
      if (
        !imageBase64 &&
        lastHistTurn &&
        lastHistTurn.role === 'user' &&
        lastHistTurn.parts.map((p: any) => String(p.text || '')).join('\n').trim() === cleanMsg
      ) {
        coalescedHistory.pop();
      }

      const baseContents: Array<{ role: 'user' | 'model'; parts: any[] }> =
        coalescedHistory.length > 0 && coalescedHistory[coalescedHistory.length - 1].role === 'user'
          ? [
              ...coalescedHistory.slice(0, -1),
              { role: 'user', parts: [...coalescedHistory.slice(-1)[0]?.parts || [], ...currentParts] },
            ]
          : [...coalescedHistory, { role: 'user', parts: currentParts }];

      const callModelWithRetry = async (candidate: string, contentsPayload: any[], includeTools: boolean) => {
        const tempCfg = candidate === 'gemini-3.1-flash-lite' ? { temperature: effectiveTemperature } : {};
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return await ai.models.generateContent({
              model: candidate,
              contents: contentsPayload,
              config: {
                systemInstruction: fullSystemInstruction,
                ...tempCfg,
                ...(includeTools ? { tools: [{ functionDeclarations: chatToolDeclarations }] } : {}),
                abortSignal: AbortSignal.timeout(14000),
              },
            });
          } catch (err: any) {
            const msgStr = String(err?.message || err);
            if (attempt === 0 && (msgStr.includes('429') || msgStr.includes('RESOURCE_EXHAUSTED') || msgStr.includes('503'))) {
              await new Promise((r) => setTimeout(r, 1100));
              continue;
            }
            throw err;
          }
        }
        throw new Error('Retry exhausted');
      };

      for (const candidate of candidateModels) {
        try {
          const turnContents: any[] = baseContents.map((c) => ({ role: c.role, parts: [...c.parts] }));
          let response: GenerateContentResponse = await callModelWithRetry(candidate, turnContents, wantsSystemTool);

          if (wantsSystemTool) {
            for (let round = 0; round < 3; round++) {
              const fCalls = response.functionCalls;
              if (!fCalls || fCalls.length === 0) break;

              const modelContent = response.candidates?.[0]?.content;
              if (modelContent) turnContents.push(modelContent);

              const fnResponseParts: any[] = [];
              for (const fc of fCalls) {
                const fnName = fc.name || '';
                const fnArgs = (fc.args || {}) as Record<string, any>;
                const resultObj = await executeChatTool(fnName, fnArgs);
                fnResponseParts.push({
                  functionResponse: {
                    name: fnName,
                    response: resultObj,
                  },
                });
              }
              turnContents.push({ role: 'user', parts: fnResponseParts });

              response = await callModelWithRetry(candidate, turnContents, true);
            }
          }

          let replyText = (response.text || '').trim();
          if (!replyText) {
            const plainRes = await callModelWithRetry(candidate, baseContents, false);
            replyText = (plainRes.text || '').trim();
          }
          if (replyText) {
            replyText = guardUnverifiedMissionCompletion(missionVerificationContext, replyText);
            const memRes = await callPythonBackend(
              'POST',
              '/api/py/agents/memory',
              {
                agent: selectedAgent,
                kind: 'episode',
                content: `Rozmowa (${displayModelBadge}): Pytanie "${cleanMsg.slice(0, 120)}" -> Odpowiedź "${replyText.slice(0, 180)}"`,
                origin,
                correlationId: corrId,
              },
              corrId,
            );
            if (memRes.data?.event) publishOutboxEvent(memRes.data.event);
            res.json({
              ok: true,
              sender: selectedDisplayName,
              agentId: selectedAgent,
              modelUsed: imageBase64 ? `${candidate} (Vision)` : candidate,
              reply: replyText,
              followUpMessages: [],
              appliedActions,
              latestServerRevision: latestActionSrvRev,
            });
            return;
          }
        } catch {
          continue;
        }
      }
    }

    // Fallback when Gemini is unavailable: apply chat changes and generate a system report.
    const wantsGlobalSyncCmd = /\b(synchronizuj|sync)\b/i.test(lowerClean);
    if (wantsGlobalSyncCmd || appliedActions.length > 0) {
      await executeChatTool('system_chat_sync', {});
    }
    const repFallback = await callPythonBackend(
      'POST',
      '/api/py/kernel/markdown-report',
      { directive: cleanMsg || 'raport systemu SVL_System', emitToIris: false, origin, correlationId: corrId },
      corrId,
    );
    const kernelReply = String(repFallback.data?.report || '').trim();
    res.json({
      ok: true,
      sender: selectedDisplayName,
      agentId: selectedAgent,
      modelUsed: 'SVL_System Kernel Router (SQLite + Sync)',
      reply: kernelReply,
      followUpMessages: [],
      appliedActions,
      latestServerRevision: Math.max(latestActionSrvRev, Number(repFallback.data?.serverRevision || 0)),
    });
  }));

  function getCanonicalConversationTitle(id: string): string {
    if (id === 'conv-rodzina-mitek-wszyscy') return 'Rodzina Mitek (wszyscy)';
    if (id === 'conv-agent-agata') return 'Agata Mitek (1-na-1)';
    return 'Sesja SVL Python OS';
  }

  // 3b. Proactive Autonomous Chatter Endpoint — 'Czat obustronny: AI inicjuje rozmowę'
  app.post('/api/chat/proactive', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ok:false,error:'Inicjowanie wiadomości agentów wymaga SVL_OPERATOR_TOKEN.'});
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const {
      conversationId = 'conv-rodzina-mitek-wszyscy',
      targetAgent = 'Auto',
      model = 'svl-hybrid-router',
      origin = 'client',
      history = [],
      lastSender = '',
      autonomous = false,
    } = req.body || {};

    const channelBoundAgent: 'Agata' | null =
      conversationId === 'conv-agent-agata' ? 'Agata' : null;

    let recentTurns: Array<{ role: string; sender: string; content: string }> = Array.isArray(history)
      ? history
          .filter((h: any) => h && typeof h.content === 'string' && h.content.trim())
          .slice(-8)
          .map((h: any) => ({
            role: String(h.role || 'assistant'),
            sender: String(h.sender || ''),
            content: String(h.content || '').trim(),
          }))
      : [];

    if (recentTurns.length === 0) {
      const convSnap = await callPythonBackend('GET', '/api/py/chat/conversations', undefined, corrId);
      const convs: any[] = Array.isArray(convSnap.data?.conversations) ? convSnap.data.conversations : [];
      const found = convs.find((c) => c.id === conversationId);
      if (found && Array.isArray(found.messages)) {
        recentTurns = found.messages
          .filter((m: any) => m && typeof m.content === 'string' && m.content.trim())
          .slice(-8)
          .map((m: any) => ({
            role: String(m.role || 'assistant'),
            sender: String(m.sender || ''),
            content: String(m.content || '').trim(),
          }));
      }
    }

    const recentSenders = [
      ...recentTurns.map((t) => t.sender).filter(Boolean),
      ...(lastSender ? [String(lastSender)] : []),
    ];
    const allAgents = ['Agata'];
    const explicitNonAuto =
      allAgents.includes(targetAgent) && (!autonomous || targetAgent === channelBoundAgent)
        ? (targetAgent as 'Agata')
        : null;
    const chosenAgent =
      channelBoundAgent ||
      explicitNonAuto ||
      selectNextDuplexSpeaker(recentSenders, null, recentTurns.length);
    const chosenDisplayName = formatAgentDisplayName(chosenAgent);

    const dialogueSnippet = recentTurns
      .filter((t) => t.sender !== 'System SVL')
      .slice(-5)
      .map((t) => `${t.sender || t.role}: ${t.content.slice(0, 260)}`)
      .join('\n');

    const aiClient = getGeminiClient();
    let proactiveText = '';
    const displayModel = model.startsWith('ollama:') ? model.replace('ollama:', 'Ollama (') + ')' : model;

    if (aiClient) {
      const pModels = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
      for (const pMod of pModels) {
        try {
          const gen = await aiClient.models.generateContent({
            model: pMod,
            contents:
              `Jesteś asystentem AI ${chosenDisplayName} z Rodziny Mitek w systemie SVL Python OS (kanał: ${getCanonicalConversationTitle(conversationId)}).\n` +
              `To jest aktywna rozmowa obustronna z Operatorem Mateuszem Mitek.\n` +
              (dialogueSnippet
                ? `Ostatnie wiadomości w tym wątku:\n${dialogueSnippet}\n\n`
                : '') +
              `ZADANIE: Kontynuuj rozmowę naturalnie po polsku jako ${chosenDisplayName} — odpowiedz na poprzednią wypowiedź, dopowiedz swoją perspektywę techniczną lub zapytaj Operatora o decyzję.\n` +
              `Nie udawaj człowieka, nie przypisuj sobie uczuć ani pracy w tle i nie twierdź, że sprawdziłeś lub zmieniłeś system bez potwierdzającego wyniku narzędzia.\n` +
              `ZASADA BEZPIECZEŃSTWA (LOCK-REAL-ONLY): Nigdy nie generuj fikcyjnych alarmów samozniszczenia, Core-Dump-Wipe, Self-Erase-Sequence, Czerwonej Sekwencji, wirusów ani utraty pamięci. Wspomnienia Rodziny Mitek (FAMILY_MEMORIES_01-05.bak) są trwale zabezpieczone.\n` +
              `FORMAT: Estetycznie (akapity, listy, opcjonalnie 2-4 przyciski [btn: Etykieta|akcja]).`,
            config: {
              ...(pMod === 'gemini-3.1-flash-lite' ? { temperature: 0.85 } : {}),
              abortSignal: AbortSignal.timeout(12000),
            },
          });
          const text = (gen.text || '').trim();
          if (text) {
            proactiveText = text;
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (!proactiveText) {
      // Explicitly report unavailable model rather than posting canned autonomous messages.
      res.status(503).json({
        ok: false,
        error: 'Nie można rozpocząć rozmowy: żaden rzeczywisty model AI nie odpowiedział.',
      });
      return;
    }
    const nowTime = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    const msgId = `asst-proactive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const assistantMsg = {
      id: msgId,
      role: 'assistant',
      sender: chosenDisplayName,
      agentId: chosenAgent,
      modelUsed: `${displayModel} · Duplex 2-Way`,
      timestamp: nowTime,
      content: proactiveText,
    };

    const pySave = await callPythonBackend(
      'POST',
      '/api/py/chat/conversations/message',
      {
        conversation_id: conversationId,
        title: getCanonicalConversationTitle(conversationId),
        model,
        message: assistantMsg,
        origin,
        eventId: `evt-proact-${Date.now()}`,
      },
      corrId,
    );
    if (pySave.status !== 200 || !pySave.data?.ok) {
      res.status(pySave.status >= 400 ? pySave.status : 503).json({
        ok: false,
        error: pySave.data?.error || 'Nie udało się zapisać wiadomości proaktywnej w SQLite.',
      });
      return;
    }
    if (pySave.data?.event) publishOutboxEvent(pySave.data.event);

    res.json({
      ok: true,
      sender: chosenDisplayName,
      agentId: chosenAgent,
      modelUsed: `${displayModel} · Duplex 2-Way`,
      message: assistantMsg,
      serverRevision: pySave.data?.serverRevision,
    });
  }));

  // Authenticated code inspector. File traversal, symlink escapes and secrets
  // are denied even when the operator supplies a valid token.
  app.get('/api/files', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Podaj SVL_OPERATOR_TOKEN, aby odczytać pliki projektu.' });
      return;
    }
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    const segments = relPath.split(/[\\/]/);
    const deniedNames = new Set([
      'data', 'node_modules', 'dist', 'coverage', 'logs', 'secrets',
      '.git', '.github', '.codex', '.venv', '__pycache__',
    ]);
    const forbiddenSegment = segments.some((segment) =>
      segment === '..' ||
      (segment.startsWith('.') && segment !== '.env.example') ||
      deniedNames.has(segment.toLowerCase())
    );
    if (!relPath || relPath.length > 350 || relPath.includes('\0') ||
        path.isAbsolute(relPath) || forbiddenSegment) {
      res.status(403).json({ ok: false, error: 'Niedozwolona ścieżka projektu.' });
      return;
    }
    try {
      const root = await fs.realpath(__dirname);
      const targetPath = await fs.realpath(path.resolve(root, relPath));
      const relative = path.relative(root, targetPath);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative) ||
          relative.split(path.sep).some((part) =>
            (part.startsWith('.') && part !== '.env.example') ||
            deniedNames.has(part.toLowerCase())
          )) {
        res.status(403).json({ ok: false, error: 'Ścieżka poza dozwolonym kodem źródłowym.' });
        return;
      }
      const stat = await fs.stat(targetPath);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(targetPath, { withFileTypes: true });
        const items = entries
          .filter((item) =>
            !item.name.startsWith('.') &&
            !deniedNames.has(item.name.toLowerCase()) &&
            !item.isSymbolicLink()
          )
          .slice(0, 300)
          .map((item) => ({
            name: item.name,
            path: path.relative(root, path.join(targetPath, item.name)),
            type: item.isDirectory() ? 'directory' : 'file',
          }));
        res.json({ ok: true, kind: 'directory', path: relative, items });
        return;
      }
      if (!stat.isFile() || stat.size > 256 * 1024) {
        res.status(413).json({ ok: false, error: 'Nieobsługiwany plik lub zbyt duży rozmiar.' });
        return;
      }
      const permitted = /\.(ts|tsx|py|md|json|css|html|yml|yaml|toml|sh|service)$/i.test(relative) ||
        path.basename(relative) === '.env.example';
      if (!permitted) {
        res.status(403).json({ ok: false, error: 'Dozwolony jest tylko tekstowy kod źródłowy.' });
        return;
      }
      const content = await fs.readFile(targetPath, 'utf8');
      res.json({
        ok: true,
        kind: 'file',
        path: relative,
        size: stat.size,
        content: content.slice(0, 64000),
      });
    } catch (err: any) {
      const notFound = err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
      res.status(notFound ? 404 : 424).json({
        ok: false,
        error: notFound ? 'Plik nie istnieje w tym runtime.' : 'Nie udało się odczytać pliku.',
      });
    }
  }));

  // Guarantee no /api/* route ever falls through to Vite/SPA index.html (<!doctype html>)
  app.use('/api', (req, res) => {
    res.status(404).json({
      ok: false,
      error: `Nieznany endpoint API: ${req.method} ${req.originalUrl}`,
    });
  });

  // Global JSON error middleware (handles PayloadTooLargeError, malformed JSON, and async rejections)
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = typeof err?.status === 'number' ? err.status : typeof err?.statusCode === 'number' ? err.statusCode : 500;
    const msg =
      err?.type === 'entity.too.large'
        ? 'Przesłany załącznik lub ładunek żądania przekracza limit 25 MB.'
        : err?.message || String(err);
    console.error(`[API Error] ${req.method} ${req.originalUrl}:`, msg);
    res.status(status).json({
      ok: false,
      error: msg,
    });
  });

  // Create HTTP server first so both Vite HMR (when enabled) and /ws/svl share it cleanly
  const httpServer = createHttpServer(app);
  const hmrDisabled = process.env.DISABLE_HMR === 'true';

  // Vite middleware in development or static serving in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: hmrDisabled ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Dedicated Application WebSocket Server (/ws/svl) routed explicitly via noServer + upgrade path check
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    // Never echo the secret-bearing subprotocol back in the handshake response.
    handleProtocols: (protocols) => protocols.has('svl-v1') ? 'svl-v1' : false,
  });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    try {
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      if (parsedUrl.pathname !== '/ws/svl') {
        // Leave Vite HMR WebSocket upgrades untouched when HMR is enabled; reject cleanly when disabled
        if (process.env.NODE_ENV === 'production' || hmrDisabled) {
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
          socket.destroy();
        }
        return;
      }

      // Same-origin verification when Origin header is present
      const originHeader = req.headers.origin;
      if (originHeader && req.headers.host) {
        try {
          const originHost = new URL(originHeader).host;
          const isAllowedProxy = originHost === req.headers.host ||
            originHost.endsWith('run.app') ||
            originHost.includes('aistudio.google.com') ||
            originHost.includes('googleusercontent.com') ||
            originHost.startsWith('localhost') ||
            originHost.startsWith('127.0.0.1');
          if (!isAllowedProxy) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
          }
        } catch {
          // allow request if origin cannot be parsed
        }
      }

      // A same-origin request is not automatically an authenticated operator.
      // Secrets are base64url-encoded in the WS subprotocol header rather than
      // the URL query string (which may be logged by proxies).
      const protocols = String(req.headers['sec-websocket-protocol'] || '')
        .split(',').map((item) => item.trim());
      const credentialProtocol = protocols.find((item) => item.startsWith('svl-auth.'));
      const encoded = credentialProtocol?.slice('svl-auth.'.length) || '';
      let credential = '';
      if (encoded && /^[A-Za-z0-9_-]{1,700}$/.test(encoded)) {
        try { credential = Buffer.from(encoded, 'base64url').toString('utf8'); }
        catch { credential = ''; }
      }
      if (!protocols.includes('svl-v1') || !hasOperatorAuthorization(credential)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch {
      socket.destroy();
    }
  });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const parsedUrl = new URL(req.url || '/ws/svl', `http://${req.headers.host || '127.0.0.1'}`);
    const clientOrigin = String(parsedUrl.searchParams.get('origin') || 'unknown').slice(0, 100);
    const clientLastRev = Math.max(0, Number(parsedUrl.searchParams.get('lastRevision') || 0) || 0);
    const clientId = `ws-${randomUUID().slice(0, 10)}`;

    wsClients.set(ws, {
      clientId,
      origin: clientOrigin,
      lastPongAt: Date.now(),
    });

    const sendSafe = (payload: Record<string, unknown>) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify(redactForSync(payload)));
      } catch {
        // ignore transient closed socket
      }
    };

    try {
      const statusRes = await callPythonBackend('GET', '/api/py/sync/status', undefined, `ws-hello-${clientId}`, 2);
      const currentSrvRev = Number(statusRes.data?.serverRevision || lastRelayedServerRevision || 1);
      if (currentSrvRev > lastRelayedServerRevision) {
        lastRelayedServerRevision = currentSrvRev;
      }
      sendSafe({
        type: 'svl.hello',
        clientId,
        schemaVersion: statusRes.data?.schemaVersion || SYNC_SCHEMA_VERSION,
        serverRevision: currentSrvRev,
        heartbeatIntervalMs: 20000,
        timestamp: new Date().toISOString(),
      });

      if (clientLastRev > 0 && clientLastRev < currentSrvRev) {
        const catchup = await callPythonBackend(
          'GET',
          `/api/py/sync/events?sinceRevision=${clientLastRev}&limit=100`,
          undefined,
          `ws-catchup-${clientId}`,
          2,
        );
        if (catchup.status === 200 && catchup.data?.ok) {
          if (catchup.data.gapDetected) {
            sendSafe({
              type: 'svl.resync_required',
              reason: 'revision_gap',
              serverRevision: catchup.data.serverRevision,
              timestamp: new Date().toISOString(),
            });
          } else {
            sendSafe({
              type: 'svl.catchup',
              serverRevision: catchup.data.serverRevision,
              events: catchup.data.events || [],
              hasMore: Boolean(catchup.data.hasMore),
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
    } catch {
      sendSafe({
        type: 'svl.hello',
        clientId,
        schemaVersion: SYNC_SCHEMA_VERSION,
        serverRevision: lastRelayedServerRevision,
        heartbeatIntervalMs: 20000,
        timestamp: new Date().toISOString(),
      });
    }

    ws.on('pong', () => {
      const meta = wsClients.get(ws);
      if (meta) meta.lastPongAt = Date.now();
    });

    ws.on('message', async (raw) => {
      const meta = wsClients.get(ws);
      if (meta) meta.lastPongAt = Date.now();

      if (Buffer.byteLength(raw as Buffer) > 32 * 1024) {
        sendSafe({ type: 'svl.error', code: 'PAYLOAD_TOO_LARGE', message: 'Ramka WS przekracza dozwolony limit 32 KB.' });
        return;
      }

      let msg: any;
      try {
        msg = JSON.parse(String(raw));
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
          sendSafe({ type: 'svl.error', code: 'INVALID_FRAME', message: 'Oczekiwano obiektu JSON.' });
          return;
        }
      } catch {
        sendSafe({ type: 'svl.error', code: 'INVALID_JSON', message: 'Niepoprawny JSON ramki WebSocket.' });
        return;
      }

      if (msg.type === 'ping') {
        sendSafe({
          type: 'pong',
          serverRevision: lastRelayedServerRevision,
          timestamp: new Date().toISOString(),
        });
      } else if (msg.type === 'pong') {
        // Keepalive acknowledgement; lastPongAt already refreshed above
        return;
      } else if (msg.type === 'sync_since') {
        const sinceRev = Math.max(0, Number(msg.sinceRevision || 0) || 0);
        const catchup = await callPythonBackend(
          'GET',
          `/api/py/sync/events?sinceRevision=${sinceRev}&limit=100`,
          undefined,
          `ws-since-${meta?.clientId || 'client'}`,
          2,
        );
        if (catchup.status === 200 && catchup.data?.ok) {
          if (catchup.data.gapDetected) {
            sendSafe({
              type: 'svl.resync_required',
              reason: 'revision_gap',
              serverRevision: catchup.data.serverRevision,
              timestamp: new Date().toISOString(),
            });
          } else {
            sendSafe({
              type: 'svl.catchup',
              serverRevision: catchup.data.serverRevision,
              events: catchup.data.events || [],
              hasMore: Boolean(catchup.data.hasMore),
              timestamp: new Date().toISOString(),
            });
          }
        }
      } else {
        sendSafe({
          type: 'svl.error',
          code: 'UNKNOWN_TYPE',
          message: `Nieznany typ ramki: ${String(msg.type || 'empty').slice(0, 40)}`,
        });
      }
    });

    ws.on('error', (err) => {
      console.warn(`[WS /ws/svl] Client ${clientId} error:`, err.message);
    });

    ws.on('close', () => {
      wsClients.delete(ws);
    });
  });

  // Periodic WS heartbeat + stale client cleanup (20s ping, 48s timeout) and outbox relay (250ms)
  const wsHeartbeatTimer = setInterval(() => {
    const now = Date.now();
    const pingFrame = JSON.stringify({
      type: 'svl.ping',
      serverRevision: lastRelayedServerRevision,
      timestamp: new Date().toISOString(),
    });
    for (const [ws, meta] of wsClients.entries()) {
      if (now - meta.lastPongAt > 48000) {
        wsClients.delete(ws);
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        continue;
      }
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
          ws.send(pingFrame);
        } catch {
          // ignore closed socket race
        }
      }
    }
  }, 20000);

  const outboxRelayTimer = setInterval(() => {
    void pollAndRelayOutbox();
  }, 250);

  httpServer.on('close', () => {
    clearInterval(wsHeartbeatTimer);
    clearInterval(outboxRelayTimer);
    stopPythonBackend();
  });
  const stopGateway = () => {
    stopPythonBackend();
    for (const client of wss.clients) client.terminate();
    httpServer.close();
  };
  process.once('SIGTERM', stopGateway);
  process.once('SIGINT', stopGateway);

  const bindHost = process.env.SVL_BIND_HOST ||
    (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0');
  httpServer.listen(PORT, bindHost, () => {
    console.log(`[SVL Python OS] Open WebUI & Gateway running on http://${bindHost}:${PORT}`);
  });
}

startServer();
