import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { spawn, ChildProcess, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, GenerateContentResponse } from '@google/genai';
import dotenv from 'dotenv';
import { buildChatHistoryPayload, selectOllamaModelName } from './src/utils/svlLogic.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const PYTHON_PORT = Number(process.env.SVL_PYTHON_PORT || 8085);
const PYTHON_BASE_URL = `http://127.0.0.1:${PYTHON_PORT}`;

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
): Promise<{ status: number; data: any }> {
  const url = `${PYTHON_BASE_URL}${endpoint}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const resp = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await resp.json();
      return { status: resp.status, data };
    } catch (err) {
      if (attempt === 7) {
        return {
          status: 503,
          data: { ok: false, error: `Python backend unreachable on port ${PYTHON_PORT}: ${String(err)}` },
        };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return { status: 503, data: { ok: false, error: 'Python backend timeout' } };
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
  app.use(express.json({ limit: '12mb' }));

  // 1. Proxy all /api/py/* routes directly to the live Python 3 SVLSystemKernel server
  app.all('/api/py/*', async (req, res) => {
    const queryStr = new URLSearchParams(req.query as Record<string, string>).toString();
    const fullEndpoint = queryStr ? `${req.path}?${queryStr}` : req.path;
    const method = req.method === 'POST' ? 'POST' : 'GET';
    const result = await callPythonBackend(method, fullEndpoint, method === 'POST' ? req.body : undefined);
    res.status(result.status).json(result.data);
  });

  // 2. Real Linux & Multi-Terminal Execution Endpoint (with Polkit/sudo audit gate)
  app.post('/api/terminal/exec', async (req, res) => {
    const {
      terminalType = 'linux',
      command = '',
      polkitConfirmed = false,
      operatorToken = '',
    } = req.body || {};

    const trimmed = String(command || '').trim();
    if (!trimmed) {
      res.status(400).json({ ok: false, error: 'Puste polecenie.' });
      return;
    }

    // Intercept 'podłącz moje ai' in any terminal!
    if (trimmed.toLowerCase() === 'podłącz moje ai' || trimmed.toLowerCase() === 'podlacz moje ai') {
      const pyRes = await callPythonBackend('POST', '/api/py/agents/connect', {
        triggered_by: `terminal:${terminalType}`,
      });
      res.json({
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
      const pyRes = await callPythonBackend('POST', '/api/py/python-repl', { code: trimmed });
      res.json({
        ok: pyRes.data.ok,
        terminalType,
        command: trimmed,
        stdout: pyRes.data.stdout || '',
        stderr: pyRes.data.stderr || '',
      });
      return;
    }

    if (terminalType === 'hyperspace') {
      const pyRes = await callPythonBackend('POST', '/api/py/hyperspace/compute', {
        text: trimmed,
        omega: 1.5,
        t: 1.0,
      });
      res.json({
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
      // Format: @AgentName task text OR broadcast
      const match = trimmed.match(/^@?(Aria|Alex|Astyria|Aurelius)\s+(.+)$/i);
      const targetAgent = match
        ? match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase()
        : 'Alex';
      const taskBody = match ? match[2] : trimmed;
      const pyRes = await callPythonBackend('POST', '/api/py/agents/task', {
        sender: 'operator_terminal',
        target_agent: targetAgent,
        title: taskBody.slice(0, 80),
        payload: taskBody,
      });
      res.json({
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
        const health = await callPythonBackend('GET', '/api/py/health');
        const gitLog = await executeLinuxShellCommand('git status -s && git log -n 3 --oneline || true');
        res.json({
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
      // Allow safe git inspection commands in Codex CLI terminal
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
        res.json({ ok: out.ok, terminalType, command: trimmed, stdout: out.stdout, stderr: out.stderr });
        return;
      }
      const out = await executeLinuxShellCommand(trimmed);
      res.json({ ok: out.ok, terminalType, command: trimmed, stdout: out.stdout, stderr: out.stderr });
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
      // Verify operatorToken with Python kernel
      const health = await callPythonBackend('GET', '/api/py/health');
      const expectedToken = health.data?.security?.demo_operator_token_for_local_testing || '';
      if (!operatorToken || operatorToken.trim() !== expectedToken) {
        res.status(403).json({
          ok: false,
          error: 'Odmowa Polkit/RBAC: nieprawidłowy SVL_OPERATOR_TOKEN.',
        });
        return;
      }
    }

    const shellRes = await executeLinuxShellCommand(trimmed);
    res.json({
      ok: shellRes.ok,
      terminalType: 'linux',
      command: trimmed,
      exitCode: shellRes.exitCode,
      stdout: shellRes.stdout,
      stderr: shellRes.stderr,
      durationMs: shellRes.durationMs,
    });
  });

  // 2b. Ollama Runtime Configuration & Model Pull Endpoints
  app.post('/api/ollama/config', async (req, res) => {
    const ollamaHost = String(req.body?.ollamaHost || req.body?.ollama_host || '').trim();
    const pyRes = await callPythonBackend('POST', '/api/py/ollama/config', { ollama_host: ollamaHost });
    res.status(pyRes.status).json(pyRes.data);
  });

  app.post('/api/ollama/pull', async (req, res) => {
    const modelName = String(req.body?.model || 'llama3.2-vision:11b').trim();
    const pyRes = await callPythonBackend('POST', '/api/py/ollama/pull', { model: modelName });
    res.status(pyRes.status).json(pyRes.data);
  });

  app.get('/api/ollama/pull-status', async (_req, res) => {
    const pyRes = await callPythonBackend('GET', '/api/py/ollama/pull-status');
    res.status(pyRes.status).json(pyRes.data);
  });

  // 3. Open WebUI Chat & Multimodal Vision Endpoint (supports 'podłącz moje ai', real Ollama /api/chat, and Gemini API)
  app.post('/api/chat', async (req, res) => {
    const {
      message = '',
      model = 'svl-hybrid-router',
      targetAgent = 'Auto',
      history = [],
      imageBase64 = '',
      imageMimeType = 'image/png',
    } = req.body || {};

    const cleanMsg = String(message || '').trim();
    if (!cleanMsg && !imageBase64) {
      res.status(400).json({ ok: false, error: 'Wiadomość nie może być pusta.' });
      return;
    }

    // Special Command 1: 'podłącz moje ai'
    if (cleanMsg.toLowerCase() === 'podłącz moje ai' || cleanMsg.toLowerCase() === 'podlacz moje ai') {
      const pyRes = await callPythonBackend('POST', '/api/py/agents/connect', {
        triggered_by: 'open_webui_chat',
      });
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
    await callPythonBackend('POST', '/api/py/agents/task', {
      sender: 'open_webui_chat',
      target_agent: selectedAgent,
      title: cleanMsg.slice(0, 72) || 'Analiza obrazu Vision',
      payload: cleanMsg,
    });

    const [healthRes, agentsRes] = await Promise.all([
      callPythonBackend('GET', '/api/py/health'),
      callPythonBackend('GET', '/api/py/agents/status'),
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
      Astyria: 'projektantka interfejsu Open WebUI, responsywności mobilnej/Android i doświadczenia użytkownika',
      Aurelius: 'strażnik bezpieczeństwa RBAC, zmiennych chronionych SVLProtectedVariable i audytu',
    };

    const effectiveTemperature =
      typeof agentConfig.temperature === 'number' && !Number.isNaN(agentConfig.temperature)
        ? agentConfig.temperature
        : 0.7;

    const basePersonaPrompt =
      agentConfig.system_prompt ||
      `Jesteś ${selectedAgent} (${agentRoles[selectedAgent] || 'agent systemu SVL Python OS'}).`;

    const systemInstruction =
      `${basePersonaPrompt}\n` +
      `Prowadzisz swobodną, naturalną i merytoryczną rozmowę po polsku z operatorem Mateuszem w interfejsie Open WebUI. ` +
      `Odpowiadaj bezpośrednio na pytanie lub temat rozmowy — bez sztywnych szablonów, bez sztucznych nagłówków technicznych ani zbędnych raportów, chyba że użytkownik wprost o nie prosi.\n` +
      `Stan rzeczywisty systemu (tylko jeśli użytkownik o niego pyta): OS=${hostInfo.os_pretty_name || 'Linux'}, Python=${hostInfo.python_version || '3'}, Ollama=${ollamaInfo.daemon_reachable ? `ONLINE (${ollamaHost})` : `OFFLINE (${ollamaHost})`}, PID workera=${agentState.pid || 'aktywny'}.` +
      (recentMemories ? `\nOstatnie fakty z Twojej pamięci SQLite:\n${recentMemories}` : '');

    // Determine effective model honoring agent config when router is active
    const effectiveModel =
      model === 'svl-hybrid-router' && agentConfig.preferred_model && agentConfig.preferred_model !== 'svl-hybrid-router'
        ? String(agentConfig.preferred_model)
        : model;

    const isExplicitOllama = effectiveModel.startsWith('ollama:');
    const availableModels: Array<{ name: string; vision_supported?: boolean }> = ollamaInfo.models || [];
    const hasPulledOllamaModels = availableModels.length > 0;
    let ollamaFailureReason: string | null = null;

    // 1) Real Ollama Path (explicit ollama:* selection OR svl-hybrid-router when Ollama has pulled models)
    if (isExplicitOllama || (effectiveModel === 'svl-hybrid-router' && ollamaInfo?.daemon_reachable && hasPulledOllamaModels)) {
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
          agentConfig.ollama_model || ollamaInfo.preferred_14b_vision_model || 'llama3.2-vision:11b',
        );

        try {
          const ollamaMessages = [
            { role: 'system', content: systemInstruction },
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
            signal: AbortSignal.timeout(180000),
            body: JSON.stringify({
              model: ollamaModel,
              stream: false,
              keep_alive: '10m',
              options: { temperature: effectiveTemperature },
              messages: ollamaMessages,
            }),
          });

          if (oResp.ok) {
            const oData: any = await oResp.json();
            const replyContent = String(oData?.message?.content || oData?.response || '').trim();
            if (replyContent) {
              void callPythonBackend('POST', '/api/py/agents/memory', {
                agent: selectedAgent,
                kind: 'episode',
                content: `Rozmowa (${ollamaModel}): Pytanie "${cleanMsg.slice(0, 90)}" -> Odpowiedź "${replyContent.slice(0, 120)}"`,
              });
              res.json({
                ok: true,
                sender: selectedAgent,
                agentId: selectedAgent === 'Aria' ? 'si_1' : selectedAgent,
                modelUsed: `Ollama (${ollamaModel})`,
                reply: replyContent,
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

    // 2) Server-Side Gemini API (supports multi-turn free conversation + Vision with automatic model fallback)
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
            : [preferredFallback, 'gemini-3.1-flash-lite', 'gemini-4-hydrogen', 'gemini-2.5-flash'],
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

      const contents = [
        ...conversationHistory.map((turn) => ({
          role: turn.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: turn.content }],
        })),
        { role: 'user', parts: currentParts },
      ];

      for (const candidate of candidateModels) {
        try {
          const response: GenerateContentResponse = await ai.models.generateContent({
            model: candidate,
            contents,
            config: {
              systemInstruction,
              temperature: effectiveTemperature,
              abortSignal: AbortSignal.timeout(15000),
            },
          });

          const replyText = (response.text || '').trim();
          if (replyText) {
            void callPythonBackend('POST', '/api/py/agents/memory', {
              agent: selectedAgent,
              kind: 'episode',
              content: `Rozmowa (${candidate}): Pytanie "${cleanMsg.slice(0, 90)}" -> Odpowiedź "${replyText.slice(0, 120)}"`,
            });
            res.json({
              ok: true,
              sender: selectedAgent,
              agentId: selectedAgent === 'Aria' ? 'si_1' : selectedAgent,
              modelUsed: imageBase64 ? `${candidate} (Native Vision)` : candidate,
              reply: replyText,
            });
            return;
          }
        } catch (err: any) {
          const errStr = String(err?.message || err);
          geminiErrors.push(`${candidate}: ${errStr.slice(0, 140)}`);
          console.warn(`[Chat] Gemini ${candidate} failed:`, errStr.slice(0, 180));
        }
      }
    } else {
      geminiErrors.push('Brak klucza GEMINI_API_KEY w środowisku serwera.');
    }

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
    });
  });

  // 4. Workspace File Explorer API (Read real project files, deployment configs, and Python modules)
  app.get('/api/files', async (req, res) => {
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
  });

  // Vite middleware in development or static serving in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
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

  const httpServer = createHttpServer(app);

  // Real WebSocket Server for interactive PTY/terminal streaming & Spherical Event Bus live push
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/svl' });
  wss.on('connection', (ws: WebSocket) => {
    ws.send(
      JSON.stringify({
        type: 'connected',
        timestamp: new Date().toISOString(),
        message: 'Połączono z magistralą WebSocket SVL Python OS (/ws/svl).',
      }),
    );

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'ping') {
          const status = await callPythonBackend('GET', '/api/py/agents/status');
          ws.send(JSON.stringify({ type: 'bus_snapshot', data: status.data }));
        }
      } catch {
        // ignore malformed frame
      }
    });
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[SVL Python OS] Open WebUI & Gateway running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
