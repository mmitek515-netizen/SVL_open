import express from 'express';
import { createServer as createHttpServer, IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn, ChildProcess, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, GenerateContentResponse, Type, type FunctionDeclaration } from '@google/genai';
import dotenv from 'dotenv';
import {
  buildChatHistoryPayload,
  extractExplicitChatModuleDirective,
  selectOllamaModelName,
  type ChatAppliedAction,
} from './src/utils/svlLogic.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const PYTHON_PORT = Number(process.env.SVL_PYTHON_PORT || 8085);
const PYTHON_BASE_URL = `http://127.0.0.1:${PYTHON_PORT}`;
const SYNC_SCHEMA_VERSION = '2026.11.sync.v1';

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
  const apiKey = process.env.GEMINI_API_KEY;
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

// Spawn and supervise the real Python 3 SVLSystemKernel backend process
let pythonProc: ChildProcess | null = null;

function startPythonBackend(): void {
  const scriptPath = path.join(__dirname, 'backend', 'app.py');
  pythonProc = spawn('python3', [scriptPath], {
    cwd: __dirname,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      SVL_PYTHON_PORT: String(PYTHON_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  pythonProc.stdout?.on('data', (chunk) => {
    process.stdout.write(`[PythonKernel] ${chunk}`);
  });
  pythonProc.stderr?.on('data', (chunk) => {
    process.stderr.write(`[PythonKernel ERR] ${chunk}`);
  });
  pythonProc.on('exit', (code) => {
    console.warn(`[PythonKernel] Process exited with code ${code}. Restarting in 1.5s...`);
    setTimeout(startPythonBackend, 1500);
  });
}

let ollamaProc: ChildProcess | null = null;
let ollamaSupervisorStarted = false;

async function ensureLocalOllamaDaemon(): Promise<void> {
  if (ollamaSupervisorStarted) return;
  ollamaSupervisorStarted = true;

  const checkAlive = async (): Promise<boolean> => {
    try {
      const resp = await fetch('http://127.0.0.1:11434/api/tags', {
        signal: AbortSignal.timeout(1200),
      });
      return resp.ok;
    } catch {
      return false;
    }
  };

  if (await checkAlive()) {
    console.log('[OllamaDaemon] Local Ollama daemon already active on 127.0.0.1:11434.');
    return;
  }

  const spawnDaemon = async () => {
    if (await checkAlive()) return;
    execFile('which', ['ollama'], async (whichErr, stdout) => {
      const binPath = String(stdout || '').trim();
      if (whichErr || !binPath) {
        setTimeout(spawnDaemon, 10000);
        return;
      }
      if (await checkAlive()) return;

      console.log(`[OllamaDaemon] Starting local Ollama daemon (${binPath} serve)...`);
      ollamaProc = spawn(binPath, ['serve'], {
        cwd: __dirname,
        env: {
          ...process.env,
          OLLAMA_HOST: '127.0.0.1:11434',
          OLLAMA_KEEP_ALIVE: '10m',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      ollamaProc.stdout?.on('data', (chunk) => {
        process.stdout.write(`[Ollama] ${chunk}`);
      });
      ollamaProc.stderr?.on('data', (chunk) => {
        const txt = String(chunk);
        if (!txt.includes('inference compute')) {
          process.stderr.write(`[Ollama] ${txt}`);
        }
      });
      ollamaProc.on('exit', (code) => {
        ollamaProc = null;
        console.warn(`[OllamaDaemon] Process exited with code ${code}. Retrying in 3s...`);
        setTimeout(spawnDaemon, 3000);
      });
    });
  };

  await spawnDaemon();
}

async function callPythonBackend(
  method: 'GET' | 'POST',
  endpoint: string,
  body?: Record<string, unknown>,
  correlationId?: string,
  maxConnectAttempts = 6,
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
        signal: AbortSignal.timeout(20000),
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

// High-risk command detector for Polkit / sudo administrative gate
const HIGH_RISK_PATTERNS = [
  /\bsudo\b/i,
  /\bpkexec\b/i,
  /\brm\s+(-[rRf]+\s+|\S+\s+-[rRf]+)/i,
  /\bsystemctl\s+(stop|restart|disable|mask|enable|start)\b/i,
  /\bapt(-get)?\s+(install|remove|purge|upgrade)\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bkill(all)?\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
];

export function requiresPolkitConfirmation(cmd: string): boolean {
  return HIGH_RISK_PATTERNS.some((re) => re.test(cmd));
}

async function executeLinuxShellCommand(cmd: string, cwd = __dirname): Promise<{
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    execFile(
      '/bin/bash',
      ['-c', cmd],
      {
        cwd,
        timeout: 12000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PAGER: 'cat', TERM: 'xterm-256color' },
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

async function startServer() {
  startPythonBackend();
  void ensureLocalOllamaDaemon();

  const app = express();
  app.use(express.json({ limit: '25mb' }));

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
        const events: any[] = Array.isArray(res.data.events) ? res.data.events : [];
        for (const evt of events) {
          publishOutboxEvent(evt);
        }
        const srv = Number(res.data.serverRevision || 0);
        if (srv > lastRelayedServerRevision) {
          lastRelayedServerRevision = srv;
        }
      }
    } catch {
      // retry on next interval
    } finally {
      outboxPollInFlight = false;
    }
  };

  // 1. Proxy all /api/py/* routes directly to the live Python 3 SVLSystemKernel server
  app.all('/api/py/*', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const queryStr = new URLSearchParams(req.query as Record<string, string>).toString();
    const fullEndpoint = queryStr ? `${req.path}?${queryStr}` : req.path;
    const method = req.method === 'POST' ? 'POST' : 'GET';
    const result = await callPythonBackend(method, fullEndpoint, method === 'POST' ? req.body : undefined, corrId);
    if (method === 'POST' && result.status >= 200 && result.status < 300) {
      if (result.data?.event) {
        publishOutboxEvent(result.data.event);
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
      polkitConfirmed = false,
      operatorToken = '',
      origin = 'client',
    } = req.body || {};

    const trimmed = String(command || '').trim();
    if (!trimmed) {
      res.status(400).json({ ok: false, error: 'Puste polecenie.' });
      return;
    }

    const promptPrefixes: Record<string, string> = {
      linux: 'root@svl-debian13:/app/applet#',
      python: 'svl-py3>>>',
      codex: 'codex@main$',
      hyperspace: 'hyper128>',
      agents: 'bus@agents>',
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
      if (!payload.stdout && !payload.stderr && !payload.requiresPolkit) {
        await persistTerminalOutput(
          terminalType,
          payload.ok ? 'system' : 'stderr',
          payload.ok ? '(Polecenie zakończone kodem 0 — brak wyjścia stdout)' : String(payload.error || 'Błąd wykonania.'),
          trimmed,
          origin,
          corrId,
        );
      }
      res.json(payload);
    };

    // Intercept 'podłącz moje ai' in any terminal
    if (trimmed.toLowerCase() === 'podłącz moje ai' || trimmed.toLowerCase() === 'podlacz moje ai') {
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

    if (terminalType === 'python') {
      const pyRes = await callPythonBackend('POST', '/api/py/python-repl', { code: trimmed }, corrId);
      await respondAndPersist({
        ok: pyRes.data.ok,
        terminalType,
        command: trimmed,
        stdout: pyRes.data.stdout || '',
        stderr: pyRes.data.stderr || '',
      });
      return;
    }

    if (terminalType === 'hyperspace') {
      const pyRes = await callPythonBackend(
        'POST',
        '/api/py/hyperspace/compute',
        { text: trimmed, omega: 1.5, t: 1.0 },
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
      const match = trimmed.match(/^@?(Aria|Alex|Astyria|Aurelius)\s+(.+)$/i);
      const targetAgent = match
        ? match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase()
        : 'Alex';
      const taskBody = match ? match[2] : trimmed;
      const pyRes = await callPythonBackend(
        'POST',
        '/api/py/agents/task',
        {
          sender: 'operator_terminal',
          target_agent: targetAgent,
          title: taskBody.slice(0, 80),
          payload: taskBody,
          origin,
          correlationId: corrId,
        },
        corrId,
      );
      if (pyRes.data?.event) publishOutboxEvent(pyRes.data.event);
      await respondAndPersist({
        ok: pyRes.data.ok,
        terminalType,
        command: trimmed,
        stdout: JSON.stringify(pyRes.data, null, 2),
        stderr: pyRes.data.error || '',
      });
      return;
    }

    if (terminalType === 'codex') {
      if (trimmed === 'status' || trimmed === 'codex --version' || trimmed === 'help') {
        const health = await callPythonBackend('GET', '/api/py/health', undefined, corrId);
        const gitLog = await executeLinuxShellCommand('git status -s && git log -n 3 --oneline || true');
        await respondAndPersist({
          ok: true,
          terminalType,
          command: trimmed,
          stdout:
            `[OpenAI Codex CLI Bridge — SVL Python OS]\n` +
            `Status binarki codex: ${health.data?.codex?.codex_cli_installed ? 'ZAINSTALOWANA' : 'Brak w PATH kontenera (gotowy instalator w deploy/install-debian13.sh: npm i -g @openai/codex)'}\n` +
            `Autoryzacja ChatGPT OAuth Device Flow: codex login --device\n` +
            `UWAGA: Subskrypcja ChatGPT nie oznacza automatycznego dostępu do płatnego klucza OPENAI_API_KEY.\n` +
            `Aktywna gałąź Git: ${health.data?.codex?.active_branch || 'main'}\n\n` +
            `--- Stan repozytorium roboczego ---\n${gitLog.stdout || '(Czyste drzewo robocze)'}`,
          stderr: gitLog.stderr,
        });
        return;
      }
      if (trimmed.startsWith('git ')) {
        if (/git\s+(push|commit|reset|clean)/i.test(trimmed) && !polkitConfirmed) {
          res.status(403).json({
            ok: false,
            requiresPolkit: true,
            reason: 'Operacja zapisu/publikacji na gałęzi main wymaga potwierdzenia operatora (Polkit/RBAC).',
          });
          return;
        }
        const out = await executeLinuxShellCommand(trimmed);
        await respondAndPersist({ ok: out.ok, terminalType, command: trimmed, stdout: out.stdout, stderr: out.stderr });
        return;
      }
      const out = await executeLinuxShellCommand(trimmed);
      await respondAndPersist({ ok: out.ok, terminalType, command: trimmed, stdout: out.stdout, stderr: out.stderr });
      return;
    }

    // Linux Root / System CLI with Polkit/sudo confirmation gate for high-risk commands
    if (requiresPolkitConfirmation(trimmed)) {
      if (!polkitConfirmed) {
        res.status(200).json({
          ok: false,
          requiresPolkit: true,
          command: trimmed,
          reason:
            'Wykryto operację administracyjną / wysokiego ryzyka (sudo/polkit/rm/systemctl/apt/chmod). Wymagane potwierdzenie i autoryzacja SVL_OPERATOR_TOKEN.',
        });
        return;
      }
      const verifyRes = await callPythonBackend(
        'POST',
        '/api/py/kernel/verify-token',
        { token: operatorToken },
        corrId,
      );
      if (!verifyRes.data?.valid) {
        res.status(403).json({
          ok: false,
          error: 'Odmowa Polkit/RBAC: nieprawidłowy SVL_OPERATOR_TOKEN.',
        });
        return;
      }
    }

    const shellRes = await executeLinuxShellCommand(trimmed);
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
    const corrId: string = (req as any).correlationId || '';
    const modelName = String(req.body?.model || 'llama3.2-vision:11b').trim();
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

  // 3. Open WebUI Chat & Multimodal Vision Endpoint (supports 'podłącz moje ai', real Ollama /api/chat, and Gemini API)
  app.post('/api/chat', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const {
      message = '',
      model = 'svl-hybrid-router',
      targetAgent = 'Auto',
      history = [],
      imageBase64 = '',
      imageMimeType = 'image/png',
      origin = 'client',
    } = req.body || {};

    const cleanMsg = String(message || '').trim();
    if (!cleanMsg && !imageBase64) {
      res.status(400).json({ ok: false, error: 'Wiadomość nie może być pusta.' });
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
            `- **${a.canonical_name}** (\`id: ${a.id}\`) — PID: \`${a.pid}\`, UID: \`${a.uid}\`, Status: \`${a.status}\`\n  Rola: *${a.preserved_role}*\n  Pochodzenie: \`${a.instance_origin}\` (${a.instance_label})`,
        )
        .join('\n');

      const formattedReply =
        `### Wykonano polecenie: \`podłącz moje ai\`\n\n` +
        `**1. Inspekcja repozytoriów źródłowych:**\n` +
        `- \`mmitek515-netizen/SVL_System\`: ${rep?.repositories_inspected?.SVL_System?.reachable ? 'POŁĄCZONO (HTTP 200)' : 'Sprawdzono lokalny snapshot'}\n` +
        `- \`mmitek515-netizen/Debian_13\`: ${rep?.repositories_inspected?.Debian_13?.reachable ? 'POŁĄCZONO (HTTP 200)' : 'Sprawdzono lokalny snapshot'}\n\n` +
        `**2. Ustalenie stanu procesów:**\n` +
        `${rep?.architectural_finding}\n\n` +
        `**3. Aktywne lokalne workery Python (Sferyczna Magistrala Zdarzeń):**\n` +
        `${agentsList}\n\n` +
        `Pamięć agentów została zainicjalizowana w bazie SQLite (\`./data/svl_os.sqlite3\`) wyłącznie z rzeczywistych danych repozytorium.`;

      void pollAndRelayOutbox();
      res.json({
        ok: true,
        sender: 'SVL System Kernel',
        agentId: 'system',
        modelUsed: 'SVLAgentOrchestrator (Python 3)',
        reply: formattedReply,
        connectionReport: rep,
      });
      return;
    }

    // Determine responding agent persona
    const selectedAgent =
      targetAgent && targetAgent !== 'Auto' && ['Aria', 'Alex', 'Astyria', 'Aurelius'].includes(targetAgent)
        ? targetAgent
        : cleanMsg.toLowerCase().includes('ollama') || cleanMsg.toLowerCase().includes('model') || imageBase64
          ? 'Aria'
          : cleanMsg.toLowerCase().includes('gui') || cleanMsg.toLowerCase().includes('interfejs')
            ? 'Astyria'
            : cleanMsg.toLowerCase().includes('bezpiecz') || cleanMsg.toLowerCase().includes('token') || cleanMsg.toLowerCase().includes('audyt')
              ? 'Aurelius'
              : 'Alex';

    // Record task in the selected agent's queue over the Spherical Event Bus
    const taskDispatchRes = await callPythonBackend(
      'POST',
      '/api/py/agents/task',
      {
        sender: 'open_webui_chat',
        target_agent: selectedAgent,
        title: cleanMsg.slice(0, 72) || 'Analiza obrazu Vision',
        payload: cleanMsg,
        origin,
        correlationId: corrId,
      },
      corrId,
    );
    if (taskDispatchRes.data?.event) publishOutboxEvent(taskDispatchRes.data.event);

    const [healthRes, agentsRes] = await Promise.all([
      callPythonBackend('GET', '/api/py/health', undefined, corrId),
      callPythonBackend('GET', '/api/py/agents/status', undefined, corrId),
    ]);
    const ollamaInfo = healthRes.data?.ollama || {};
    const hostInfo = healthRes.data?.host || {};
    const ollamaHost = String(ollamaInfo.ollama_host || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const conversationHistory = buildChatHistoryPayload(Array.isArray(history) ? history : [], 16);

    const agentState = (agentsRes.data?.agents || []).find((a: any) => a.canonical_name === selectedAgent) || {};
    const agentConfig = agentState.config || {};
    const recentMemories = (agentsRes.data?.agent_memories?.[selectedAgent] || [])
      .slice(0, 3)
      .map((m: any) => `- ${m.content}`)
      .join('\n');

    const agentRoles: Record<string, string> = {
      Aria: 'specjalistka od integracji modeli AI, lokalnej Ollamy (llama3.2-vision:11b), protokołu MCP i Vision',
      Alex: 'główny architekt systemu SVL Python OS, backendu Python/FastAPI i środowiska Linux Debian 13',
      Astyria: 'projektantka interfejsu Open WebUI, dostępności, responsywności mobilnej/Android i doświadczenia użytkownika',
      Aurelius: 'strażnik bezpieczeństwa RBAC, zmiennych chronionych SVLProtectedVariable i audytu',
    };

    const effectiveTemperature =
      typeof agentConfig.temperature === 'number' && !Number.isNaN(agentConfig.temperature)
        ? agentConfig.temperature
        : 0.7;

    const basePersonaPrompt =
      agentConfig.system_prompt ||
      `Jesteś ${selectedAgent} (${agentRoles[selectedAgent] || 'agent systemu SVL Python OS'}).`;

    const activeModules: any[] = Array.isArray(healthRes.data?.system_modules) ? healthRes.data.system_modules : [];
    const svl364Mod = activeModules.find((m: any) => m.id === 'svl-364');
    const svl364Cfg = svl364Mod?.config || {};
    const installedOllamaNames = (ollamaInfo?.models || []).map((m: any) => m.name).filter(Boolean);
    const realCpuCount = Number(hostInfo.cpu_count || os.cpus().length || 1);

    const systemInstruction =
      `${basePersonaPrompt}\n` +
      `Prowadzisz swobodną, naturalną i merytoryczną rozmowę po polsku z operatorem Mateuszem w interfejsie Open WebUI. ` +
      `Odpowiadaj bezpośrednio na pytanie lub temat rozmowy — bez sztywnych szablonów, bez sztucznych nagłówków technicznych.\n` +
      `ZASADY RZETELNOŚCI I NARZĘDZI SYSTEMOWYCH:\n` +
      `1. Masz dostęp do rzeczywistych narzędzi zmieniających stan SVL Python OS w bazie SQLite: upsert_system_module, delete_system_module, update_agent_config, configure_all_agents, add_agent_memory, dispatch_agent_task, pull_ollama_model.\n` +
      `2. Gdy operator prosi o dodanie/rejestrację/konfigurację modułu (np. svl-364 lub nowego modułu), zmianę konfiguracji agentów, pobranie nowego modelu Ollama (np. dolphin-llama3 lub llama3.2-vision:11b), zapisanie faktu lub zlecenie zadania, ZAWSZE wywołaj odpowiednie narzędzie.\n` +
      `3. NIGDY nie twierdź, że zmodyfikowałeś cgroups, systemd, nice/ionice lub bufory jądra Linux, jeśli nie wykonałeś rzeczywistego narzędzia — raportuj wyłącznie dokładnie te akcje i numery rewizji, które zwróciły narzędzia backendu.\n` +
      `4. NIGDY nie zmyślaj specyfikacji CPU, RAM, GPU ani obecności niepobranych modeli — podawaj wyłącznie faktyczne wartości ze stanu rzeczywistego poniżej.\n` +
      `Stan rzeczywisty systemu: OS=${hostInfo.os_pretty_name || 'Linux'}, Python=${hostInfo.python_version || '3'}, ` +
      `CPU=${realCpuCount} rdzeni, RAM=${ollamaInfo.host_ram_available_mb ?? hostInfo.telemetry?.ram_available_mb ?? '?'} MB wolne / ${ollamaInfo.host_ram_total_mb ?? hostInfo.telemetry?.ram_total_mb ?? '?'} MB total, ` +
      `Dysk=${ollamaInfo.host_disk_free_gb ?? hostInfo.telemetry?.disk_free_gb ?? '?'} GB wolne, GPU=${hostInfo.gpu_available ? hostInfo.gpu_info : 'BRAK (wyłącznie CPU)'}, ` +
      `Ollama=${ollamaInfo.daemon_reachable ? `ONLINE (${ollamaHost})` : `OFFLINE (${ollamaHost})`}, ` +
      `Pobrane modele Ollama=${installedOllamaNames.length ? installedOllamaNames.join(', ') : 'brak'}, ` +
      `PID workera=${agentState.pid || 'aktywny'}, aktywne moduły=${activeModules.map((m: any) => m.id).join(', ') || 'rdzeń'}.` +
      (recentMemories ? `\nOstatnie fakty z Twojej pamięci SQLite:\n${recentMemories}` : '');

    const appliedActions: ChatAppliedAction[] = [];
    let latestActionSrvRev = Number(healthRes.data?.serverRevision || 0);

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

    const executeChatTool = async (toolName: string, rawArgs: Record<string, any>): Promise<Record<string, any>> => {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      if (toolName === 'upsert_system_module') {
        const modId = String(args.id || args.moduleId || '').trim();
        if (!modId) return { ok: false, error: 'Wymagane id modułu.' };
        const pyRes = await callPythonBackend(
          'POST',
          '/api/py/modules/upsert',
          {
            id: modId,
            name: String(args.name || modId),
            kind: String(args.kind || 'Chat Module'),
            status: String(args.status || 'ACTIVE'),
            description: String(args.description || ''),
            config: args.config && typeof args.config === 'object' ? args.config : {},
            source: 'chat',
            origin,
            correlationId: corrId,
          },
          corrId,
        );
        return recordToolResult(
          toolName,
          'module',
          modId,
          pyRes,
          `Zapisano moduł ${modId} (${args.status || 'ACTIVE'})`,
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
        return recordToolResult(toolName, 'module', modId, pyRes, `Usunięto moduł ${modId}`);
      }

      if (toolName === 'update_agent_config') {
        const targetAg = String(args.agent || selectedAgent).trim();
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
        return recordToolResult(toolName, 'agent_config', targetAg, pyRes, `Zaktualizowano konfigurację agenta ${targetAg}`);
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
        void pollAndRelayOutbox();
        return recordToolResult(toolName, 'agent_config', 'all', pyRes, 'Zaktualizowano konfigurację wszystkich 4 agentów');
      }

      if (toolName === 'add_agent_memory') {
        const targetAg = String(args.agent || selectedAgent).trim();
        const content = String(args.content || '').trim();
        if (!content) return { ok: false, error: 'Treść pamięci jest wymagana.' };
        const pyRes = await callPythonBackend(
          'POST',
          '/api/py/agents/memory',
          { agent: targetAg, kind: String(args.kind || 'decision'), content, origin, correlationId: corrId },
          corrId,
        );
        return recordToolResult(toolName, 'agent_memory', targetAg, pyRes, `Zapisano pamięć dla ${targetAg}`);
      }

      if (toolName === 'dispatch_agent_task') {
        const targetAg = String(args.target_agent || selectedAgent).trim();
        const title = String(args.title || cleanMsg.slice(0, 72)).trim();
        const pyRes = await callPythonBackend(
          'POST',
          '/api/py/agents/task',
          {
            sender: 'chat_orchestrator',
            target_agent: targetAg,
            title,
            payload: String(args.payload || title),
            origin,
            correlationId: corrId,
          },
          corrId,
        );
        return recordToolResult(toolName, 'agent_task', targetAg, pyRes, `Zlecono zadanie do ${targetAg}: ${title.slice(0, 40)}`);
      }

      if (toolName === 'pull_ollama_model') {
        const modelToPull = String(args.model || '').trim();
        if (!modelToPull) return { ok: false, error: 'Nazwa modelu Ollama jest wymagana (np. dolphin-llama3).' };
        const pyRes = await callPythonBackend(
          'POST',
          '/api/py/ollama/pull',
          { model: modelToPull, origin, correlationId: corrId },
          corrId,
        );
        return recordToolResult(toolName, 'ollama', modelToPull, pyRes, `Uruchomiono pobieranie modelu Ollama: ${modelToPull}`);
      }

      return { ok: false, error: `Nieznane narzędzie: ${toolName}` };
    };

    const ensureExplicitModulePersisted = async () => {
      const directive = extractExplicitChatModuleDirective(cleanMsg);
      if (!directive) return;
      const alreadyApplied = appliedActions.some((a) => a.entity === 'module' && a.entityId === directive.id && a.ok);
      if (alreadyApplied) return;
      await executeChatTool('upsert_system_module', directive);
    };

    const chatToolDeclarations: FunctionDeclaration[] = [
      {
        name: 'upsert_system_module',
        description: 'Rejestruje nowy moduł systemowy (np. svl-364) lub aktualizuje istniejący moduł w SQLite oraz Sferycznej Magistrali Zdarzeń.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, description: 'Unikalny identyfikator modułu (np. svl-364)' },
            name: { type: Type.STRING, description: 'Czytelna nazwa modułu (np. SVL-364 Ebon Apex)' },
            kind: { type: Type.STRING, description: 'Typ modułu (np. Orchestration & Kernel Module)' },
            status: { type: Type.STRING, description: 'ACTIVE, CONFIGURED, STANDBY lub ARCHIVED' },
            description: { type: Type.STRING, description: 'Krótki opis działania modułu' },
            config: { type: Type.OBJECT, description: 'Parametry konfiguracyjne JSON np. async_event_bus_buffer, agent_max_context_turns' },
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
        description: 'Aktualizuje trwałą konfigurację wybranego agenta (Aria, Alex, Astyria, Aurelius) w SQLite.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            agent: { type: Type.STRING, description: 'Aria, Alex, Astyria lub Aurelius' },
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
        description: 'Aktualizuje wspólną konfigurację wszystkich czterech agentów jednocześnie w SQLite.',
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
        description: 'Zapisuje trwałą notatkę / decyzję / fakt w pamięci SQLite wybranego agenta.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            agent: { type: Type.STRING, description: 'Aria, Alex, Astyria lub Aurelius' },
            kind: { type: Type.STRING, description: 'fact, decision, task lub episode' },
            content: { type: Type.STRING, description: 'Treść wpisu pamięci' },
          },
          required: ['agent', 'content'],
        },
      },
      {
        name: 'dispatch_agent_task',
        description: 'Wysyła i zapisuje zadanie dla konkretnego agenta przez Sferyczną Magistralę Zdarzeń.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            target_agent: { type: Type.STRING, description: 'Aria, Alex, Astyria lub Aurelius' },
            title: { type: Type.STRING, description: 'Tytuł zadania' },
            payload: { type: Type.STRING, description: 'Szczegóły zadania' },
          },
          required: ['target_agent', 'title'],
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
    ];

    // Determine effective model honoring agent config when router is active
    const effectiveModel =
      model === 'svl-hybrid-router' && agentConfig.preferred_model && agentConfig.preferred_model !== 'svl-hybrid-router'
        ? String(agentConfig.preferred_model)
        : model;

    const isExplicitOllama = effectiveModel.startsWith('ollama:');
    const availableModels: Array<{ name: string; vision_supported?: boolean }> = ollamaInfo.models || [];
    const hasPulledOllamaModels = availableModels.length > 0;
    const hasPulledVisionModel = availableModels.some((m) => m.vision_supported);
    let ollamaFailureReason: string | null = null;

    // 1) Real Ollama Path (explicit ollama:* selection OR svl-hybrid-router when Ollama has suitable pulled models)
    if (
      isExplicitOllama ||
      (effectiveModel === 'svl-hybrid-router' &&
        ollamaInfo?.daemon_reachable &&
        hasPulledOllamaModels &&
        (!imageBase64 || hasPulledVisionModel))
    ) {
      if (!ollamaInfo?.daemon_reachable) {
        ollamaFailureReason =
          `Serwer Ollama pod adresem ${ollamaHost} jest nieosiągalny (${ollamaInfo?.error || 'connection refused'}). ` +
          `Uruchom Ollamę na hoście (ollama serve) lub ustaw zewnętrzny adres OLLAMA_HOST w ustawieniach połączenia Ollama.`;
        if (isExplicitOllama) {
          res.status(503).json({
            ok: false,
            error: ollamaFailureReason,
            ollama: ollamaInfo,
          });
          return;
        }
      } else {
        const requestedExplicitName = isExplicitOllama ? effectiveModel.slice('ollama:'.length) : '';
        const explicitModelMissing =
          isExplicitOllama &&
          requestedExplicitName &&
          !availableModels.some((m) => m.name === requestedExplicitName);

        if (explicitModelMissing) {
          const ps = ollamaInfo?.pull_state;
          const pullMsg = ps?.active
            ? `Trwa pobieranie modelu ${ps.model} (${ps.percent ?? 0}% — ${ps.status}). Poczekaj na ukończenie lub przełącz silnik na SVL Router.`
            : `Model '${requestedExplicitName}' nie został jeszcze pobrany w Ollama (${ollamaHost}). Kliknij 'Pobierz llama3.2-vision:11b' w panelu konfiguracji Ollama lub użyj SVL Router.`;
          res.status(409).json({
            ok: false,
            error: pullMsg,
            ollama: ollamaInfo,
          });
          return;
        }

        const ollamaModel = selectOllamaModelName(
          effectiveModel,
          availableModels,
          Boolean(imageBase64),
          agentConfig.ollama_model || svl364Cfg.configured_ollama_model || ollamaInfo.preferred_14b_vision_model || 'llama3.2-vision:11b',
        );

        try {
          await ensureExplicitModulePersisted();
          const ollamaMessages = [
            { role: 'system', content: systemInstruction },
            ...conversationHistory,
            {
              role: 'user',
              content: cleanMsg || 'Przeanalizuj przesłany obraz.',
              ...(imageBase64 ? { images: [imageBase64.replace(/^data:[^;]+;base64,/, '')] } : {}),
            },
          ];

          const dynamicThreads = Math.max(
            1,
            Number(svl364Cfg.max_cpu_threads || realCpuCount || os.cpus().length || 4),
          );
          const dynamicCtx = Math.max(2048, Number(svl364Cfg.ollama_num_ctx || 4096));

          const oResp = await fetch(`${ollamaHost}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(90000),
            body: JSON.stringify({
              model: ollamaModel,
              stream: false,
              keep_alive: '10m',
              options: {
                temperature: effectiveTemperature,
                num_ctx: dynamicCtx,
                ...(svl364Cfg.dynamic_resource_allocation !== false ? { num_thread: dynamicThreads } : {}),
              },
              messages: ollamaMessages,
            }),
          });

          if (oResp.ok) {
            const oRaw = await oResp.text();
            const oData: any = oRaw && !oRaw.trim().startsWith('<') ? JSON.parse(oRaw) : {};
            const replyContent = String(oData?.message?.content || oData?.response || '').trim();
            if (replyContent) {
              const memRes = await callPythonBackend(
                'POST',
                '/api/py/agents/memory',
                {
                  agent: selectedAgent,
                  kind: 'episode',
                  content: `Rozmowa (${ollamaModel}): Pytanie "${cleanMsg.slice(0, 90)}" -> Odpowiedź "${replyContent.slice(0, 120)}"`,
                  origin,
                  correlationId: corrId,
                },
                corrId,
              );
              if (memRes.data?.event) publishOutboxEvent(memRes.data.event);
              res.json({
                ok: true,
                sender: selectedAgent,
                agentId: selectedAgent === 'Aria' ? 'si_1' : selectedAgent,
                modelUsed: `Ollama (${ollamaModel})`,
                reply: replyContent,
                appliedActions,
                latestServerRevision: Math.max(latestActionSrvRev, Number(memRes.data?.serverRevision || 0)),
              });
              return;
            }
            ollamaFailureReason = `Ollama (${ollamaModel}) zwróciła pustą odpowiedź.`;
          } else {
            const errBody = await oResp.text().catch(() => '');
            ollamaFailureReason = `Ollama HTTP ${oResp.status} dla modelu '${ollamaModel}': ${errBody.slice(0, 240) || oResp.statusText}`;
          }
        } catch (err: any) {
          ollamaFailureReason = `Błąd komunikacji z Ollama (${ollamaHost}): ${err?.message || String(err)}`;
        }

        if (isExplicitOllama) {
          res.status(502).json({
            ok: false,
            error: ollamaFailureReason,
            ollama: ollamaInfo,
          });
          return;
        }
      }
    }

    // 2) Server-Side Gemini API (supports multi-turn free conversation, Function Calling & Vision)
    const ai = getGeminiClient();
    const geminiErrors: string[] = [];
    if (ai) {
      const preferredFallback = typeof agentConfig.fallback_model === 'string' && agentConfig.fallback_model.startsWith('gemini-')
        ? agentConfig.fallback_model
        : 'gemini-3.1-flash-lite';
      const candidateModels = Array.from(
        new Set(
          effectiveModel.startsWith('gemini-')
            ? [effectiveModel, preferredFallback, 'gemini-3.1-flash-lite', 'gemini-4-hydrogen']
            : [preferredFallback, 'gemini-3.1-flash-lite', 'gemini-4-hydrogen'],
        ),
      );

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
        text:
          cleanMsg ||
          'Przeanalizuj dokładnie przesłany obraz i opisz go po polsku.',
      });

      const coalescedHistory: Array<{ role: 'user' | 'model'; parts: any[] }> = [];
      for (const turn of conversationHistory) {
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
              { role: 'user', parts: [...coalescedHistory[coalescedHistory.length - 1].parts, ...currentParts] },
            ]
          : [...coalescedHistory, { role: 'user', parts: currentParts }];

      const isTransientGeminiError = (err: any) => {
        const txt = `${err?.name || ''} ${err?.message || err}`;
        return /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|DEADLINE_EXCEEDED|TimeoutError|AbortError|aborted|fetch failed|ECONNRESET/i.test(
          txt,
        );
      };

      for (const candidate of candidateModels) {
        const maxModelAttempts = candidate === candidateModels[0] ? 3 : 1;
        for (let attempt = 1; attempt <= maxModelAttempts; attempt++) {
          try {
            const turnContents: any[] = baseContents.map((c) => ({ role: c.role, parts: [...c.parts] }));
            let response: GenerateContentResponse = await ai.models.generateContent({
              model: candidate,
              contents: turnContents,
              config: {
                systemInstruction,
                temperature: effectiveTemperature,
                tools: [{ functionDeclarations: chatToolDeclarations }],
                abortSignal: AbortSignal.timeout(20000),
              },
            });

            for (let round = 0; round < 4; round++) {
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

              response = await ai.models.generateContent({
                model: candidate,
                contents: turnContents,
                config: {
                  systemInstruction,
                  temperature: effectiveTemperature,
                  tools: [{ functionDeclarations: chatToolDeclarations }],
                  abortSignal: AbortSignal.timeout(20000),
                },
              });
            }

            await ensureExplicitModulePersisted();
            const replyText = (response.text || '').trim();
            if (replyText) {
              const memRes = await callPythonBackend(
                'POST',
                '/api/py/agents/memory',
                {
                  agent: selectedAgent,
                  kind: 'episode',
                  content: `Rozmowa (${candidate}): Pytanie "${cleanMsg.slice(0, 90)}" -> Odpowiedź "${replyText.slice(0, 120)}"`,
                  origin,
                  correlationId: corrId,
                },
                corrId,
              );
              if (memRes.data?.event) publishOutboxEvent(memRes.data.event);
              res.json({
                ok: true,
                sender: selectedAgent,
                agentId: selectedAgent === 'Aria' ? 'si_1' : selectedAgent,
                modelUsed: imageBase64 ? `${candidate} (Native Vision)` : candidate,
                reply: replyText,
                appliedActions,
                latestServerRevision: Math.max(latestActionSrvRev, Number(memRes.data?.serverRevision || 0)),
              });
              return;
            }
          } catch (err: any) {
            const errStr = String(err?.message || err);
            geminiErrors.push(`${candidate}#${attempt}: ${errStr.slice(0, 140)}`);
            console.warn(`[Chat] Gemini ${candidate} attempt ${attempt} failed:`, errStr.slice(0, 180));
            if (attempt < maxModelAttempts && isTransientGeminiError(err)) {
              await new Promise((r) => setTimeout(r, 700 * attempt));
              continue;
            }
            break;
          }
        }
      }
    } else {
      geminiErrors.push('Brak klucza GEMINI_API_KEY w środowisku serwera.');
    }

    await ensureExplicitModulePersisted().catch(() => undefined);

    // 3) Honest diagnostic when no real LLM engine (neither Ollama nor Gemini) succeeded
    const reasons = [
      ollamaFailureReason || (!ollamaInfo?.daemon_reachable ? `Ollama (${ollamaHost}): offline` : null),
      geminiErrors.length ? geminiErrors.join('; ') : null,
    ]
      .filter(Boolean)
      .join(' | ');

    res.status(503).json({
      ok: false,
      error:
        `Nie udało się uzyskać odpowiedzi z żadnego silnika AI (${reasons}). ` +
        `Aby rozmawiać przez Ollamę, uruchom serwer Ollama lub podaj dostępny adres OLLAMA_HOST w konfiguracji. ` +
        `Dla rozmów chmurowych skonfiguruj aktywny klucz GEMINI_API_KEY.`,
      ollama: ollamaInfo,
      appliedActions,
    });
  }));

  // 4. Workspace File Explorer API (Read real project files, deployment configs, and Python modules)
  app.get('/api/files', asyncRoute(async (req, res) => {
    const relPath = String(req.query.path || '').replace(/^\/+/, '');
    const targetPath = path.resolve(__dirname, relPath);
    if (!targetPath.startsWith(__dirname)) {
      res.status(403).json({ ok: false, error: 'Access outside workspace denied.' });
      return;
    }

    try {
      const stat = await fs.stat(targetPath);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(targetPath, { withFileTypes: true });
        const items = entries
          .filter((e) => !['node_modules', '.git', 'dist', '.playwright-cli'].includes(e.name))
          .map((e) => ({
            name: e.name,
            path: path.relative(__dirname, path.join(targetPath, e.name)),
            type: e.isDirectory() ? 'directory' : 'file',
          }));
        res.json({ ok: true, kind: 'directory', path: relPath, items });
      } else {
        const content = await fs.readFile(targetPath, 'utf-8');
        res.json({
          ok: true,
          kind: 'file',
          path: relPath,
          size: stat.size,
          content: content.slice(0, 64000),
        });
      }
    } catch (err: any) {
      res.status(404).json({ ok: false, error: err?.message || 'File not found' });
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
        hmr: hmrDisabled ? false : { server: httpServer },
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
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

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
          if (originHost !== req.headers.host) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
          }
        } catch {
          socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
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

  // Periodic WS heartbeat + stale client cleanup (20s ping, 48s timeout) and outbox relay (1.8s)
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
  }, 1800);

  httpServer.on('close', () => {
    clearInterval(wsHeartbeatTimer);
    clearInterval(outboxRelayTimer);
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[SVL Python OS] Open WebUI & Gateway running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
