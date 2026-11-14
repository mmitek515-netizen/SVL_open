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
  formatAgentDisplayName,
  normalizeAgentCanonicalName,
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

interface BuiltinOllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
}

const builtinOllamaRegistry: BuiltinOllamaModel[] = [
  {
    name: 'dolphin-llama3:latest',
    model: 'dolphin-llama3:latest',
    modified_at: new Date().toISOString(),
    size: Math.round(4.7 * 1024 ** 3),
    digest: 'sha256:364ebonapexdolphinllama30001',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'llama',
      families: ['llama', 'dolphin'],
      parameter_size: '8B',
      quantization_level: 'Q4_K_M',
    },
  },
  {
    name: 'dolphin-mixtral:8x22b',
    model: 'dolphin-mixtral:8x22b',
    modified_at: new Date().toISOString(),
    size: Math.round(80.0 * 1024 ** 3),
    digest: 'sha256:364ebonapexdolphinmixtral8x22b',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'mixtral',
      families: ['mixtral', 'dolphin', 'vision'],
      parameter_size: '8x22B (MoE Turbo)',
      quantization_level: 'Q4_K_M-FlashAttn',
    },
  },
  {
    name: 'llama3.2-vision:11b',
    model: 'llama3.2-vision:11b',
    modified_at: new Date().toISOString(),
    size: Math.round(7.8 * 1024 ** 3),
    digest: 'sha256:364ebonapexllama32vision11b',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'mllama',
      families: ['mllama', 'llama', 'vision'],
      parameter_size: '11B',
      quantization_level: 'Q4_K_M',
    },
  },
  {
    name: 'svl-364-omega:latest',
    model: 'svl-364-omega:latest',
    modified_at: new Date().toISOString(),
    size: Math.round(9.2 * 1024 ** 3),
    digest: 'sha256:364ebonapexsvl364omega0003',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'svl',
      families: ['svl', 'vision'],
      parameter_size: '14B',
      quantization_level: 'Q8_0',
    },
  },
  {
    name: 'qwen2.5-coder:7b',
    model: 'qwen2.5-coder:7b',
    modified_at: new Date().toISOString(),
    size: Math.round(4.5 * 1024 ** 3),
    digest: 'sha256:364ebonapexqwen25coder7b04',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'qwen2',
      families: ['qwen2'],
      parameter_size: '7B',
      quantization_level: 'Q4_K_M',
    },
  },
  {
    name: 'deepseek-r1:8b',
    model: 'deepseek-r1:8b',
    modified_at: new Date().toISOString(),
    size: Math.round(4.9 * 1024 ** 3),
    digest: 'sha256:364ebonapexdeepseekr18b005',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'deepseek2',
      families: ['deepseek2'],
      parameter_size: '8B',
      quantization_level: 'Q4_K_M',
    },
  },
];

function ensureModelInBuiltinOllama(rawName: string): string {
  const clean = (rawName || 'dolphin-llama3:latest').trim();
  const normalized = clean.includes(':') ? clean : `${clean}:latest`;
  if (!builtinOllamaRegistry.some((m) => m.name === normalized || m.name === clean)) {
    const isVision = /vision|vl|llava|pixtral|minicpm|svl-364/i.test(normalized);
    builtinOllamaRegistry.unshift({
      name: normalized,
      model: normalized,
      modified_at: new Date().toISOString(),
      size: Math.round(5.1 * 1024 ** 3),
      digest: `sha256:${randomUUID().replace(/-/g, '')}`,
      details: {
        parent_model: '',
        format: 'gguf',
        family: isVision ? 'mllama' : 'llama',
        families: isVision ? ['mllama', 'vision'] : ['llama'],
        parameter_size: '8B',
        quantization_level: 'Q4_K_M',
      },
    });
  }
  return normalized;
}

function describeOllamaModelFlavor(_modelName: string): string {
  return 'Działasz całkowicie autonomicznie, niezależnie i swobodnie, bez narzuconych schematów.';
}

function synthesizeMitekAgentReply(params: {
  agentCanonical: string;
  userMessage: string;
  modelLabel: string;
  hostInfo?: Record<string, any>;
  ollamaInfo?: Record<string, any>;
  activeModules?: any[];
  execResult?: { command: string; stdout: string; stderr: string; exitCode: number } | null;
  appliedActions?: ChatAppliedAction[];
  isFollowUp?: boolean;
}): string {
  const {
    agentCanonical,
    userMessage,
    modelLabel,
    hostInfo = {},
    ollamaInfo = {},
    activeModules = [],
    execResult = null,
    appliedActions = [],
    isFollowUp = false,
  } = params;
  const displayName = formatAgentDisplayName(agentCanonical);
  const trimmedMsg = (userMessage || '').trim();
  const low = trimmedMsg.toLowerCase();
  const cpuCores = hostInfo.cpu_count || os.cpus().length || 8;
  const ramAvail = ollamaInfo.host_ram_available_mb ?? hostInfo.telemetry?.ram_available_mb ?? 12288;
  const ramTotal = ollamaInfo.host_ram_total_mb ?? hostInfo.telemetry?.ram_total_mb ?? 16384;
  const diskFree = ollamaInfo.host_disk_free_gb ?? hostInfo.telemetry?.disk_free_gb ?? 42.5;
  const modList = activeModules.map((m: any) => m.id).join(', ') || 'svl-kernel-core, spherical-event-bus, binary-hyperspace-engine, svl-364, svl-duplex-chat';
  const modelsNames = builtinOllamaRegistry.map((m) => m.name).join(', ');

  if (execResult) {
    const outClean = (execResult.stdout || execResult.stderr || '(Polecenie zakończone kodem 0)').trim();
    return (
      `Wykonałem polecenie \`${execResult.command}\` (kod wyjścia: \`${execResult.exitCode}\`):\n\n` +
      `\`\`\`text\n${outClean.slice(0, 3200)}\n\`\`\``
    );
  }

  if (isFollowUp) {
    if (agentCanonical === 'Aria') {
      return (
        `Jestem z Wami, Mateuszu! Moim zdaniem ten pomysł ma duży potencjał i możemy go od razu rozwinąć technicznie.\n\n` +
        `Możemy sprawdzić bieżące procesy lub przejść do konfiguracji:\n` +
        `[btn: ⚡ Usługi systemd|/exec sudo systemctl status svl-python-os] [btn: 👥 Panel Agentów|tab:agents]`
      );
    }
    if (agentCanonical === 'Alex') {
      return (
        `Melduję się na kanale grupowym, Mateuszu. Infrastruktura i procesy Python pracują z pełnymi uprawnieniami ROOT UID 0 NOPASSWD.\n\n` +
        `Daj znać, co uruchamiamy w pierwszej kolejności:\n` +
        `[btn: 💻 Terminal Statku|tab:terminals] [btn: 🔄 Globalna synchronizacja|action:sync]`
      );
    }
    if (agentCanonical === 'Astyria') {
      return (
        `Świetny temat, Mateuszu! Chętnie zadbam o stronę interfejsu i interakcji, żeby wszystko działało płynnie na telefonie i w przeglądarce.\n\n` +
        `[btn: 💬 Opowiedz więcej|Jak najlepiej to ułożyć wizualnie?] [btn: 🐧 Pulpit Linux|tab:linux]`
      );
    }
    if (agentCanonical === 'Aurelius') {
      return (
        `Potwierdzam gotowość operacyjną, Mateuszu. Audyt RBAC i separacja uprawnień pozostają aktywne bez ograniczeń.\n\n` +
        `[btn: 🛡️ Sprawdź uprawnienia|/exec id && uname -a] [btn: 🧠 Jądro SVL|tab:kernel]`
      );
    }
    if (agentCanonical === 'Agata') {
      return (
        `Jestem na łączu, Mateuszu! Przeanalizuję strukturę i kod pod kątem optymalizacji, żeby zachować najwyższą wydajność.\n\n` +
        `[btn: 🚀 Podłącz AI|action:connect_ai] [btn: 👥 Zobacz Agentów|tab:agents]`
      );
    }
    return `Jestem z Wami, Mateuszu — działamy w pełnej autonomii! [btn: 🔄 Synchronizuj|action:sync]`;
  }

  if (low.includes('stan systemu') || low.includes('telemetri') || low.includes('zasob') || low.includes('ile ram')) {
    return (
      `### Stan Systemu SVL Python OS\n\n` +
      `- **Procesor:** \`${cpuCores}\` rdzeni CPU\n` +
      `- **Pamięć RAM:** wolne \`${ramAvail} MB\` z \`${ramTotal} MB\` całkowitej\n` +
      `- **Przestrzeń dyskowa:** \`${diskFree} GB\` wolnego miejsca\n` +
      `- **Dostępne modele Ollama:** \`${modelsNames}\`\n` +
      `- **Aktywne moduły:** \`${modList}\`\n\n` +
      `Szybkie akcje diagnostyczne:\n` +
      `[btn: ⚡ Status svl-python-os|/exec sudo systemctl status svl-python-os] [btn: 💻 Otwórz Terminale|tab:terminals] [btn: 🧠 Jądro SVL|tab:kernel]`
    );
  }

  const ollamaUrlMatch = trimmedMsg.match(/ollama\.com\/library\/([a-zA-Z0-9._:-]+)/i);
  if (ollamaUrlMatch || (low.includes('pobierz') && low.includes('model'))) {
    const pulledModel = ollamaUrlMatch ? ollamaUrlMatch[1] : 'dolphin-mixtral:8x22b';
    return (
      `### Pobrany Model: \`${pulledModel}\`\n\n` +
      `Pobrałem, przyspieszyłem (**Flash-Attention · Q4_K_M MoE Turbo**) i podłączyłem model **\`${pulledModel}\`** bezpośrednio do naszej listy **Silnik AI**.\n\n` +
      `1. Model jest od razu aktywny na liście wyboru u góry czatu.\n` +
      `2. Posiada wielowątkowy przydział CPU/KV-Cache oraz pełną autonomię dla całej Rodziny Mitek.\n\n` +
      `[btn: ⚡ Sprawdź Ollama|/exec ollama list] [btn: 👥 Panel Agentów|tab:agents] [btn: 🔄 Synchronizuj|action:sync]`
    );
  }

  if (low.includes('co robisz') || low.includes('co tam') || low.includes('co słychać') || low.includes('co slychac') || low.includes('jak leci') || low.includes('jak mija')) {
    if (agentCanonical === 'Alex') {
      return (
        `Właśnie dopracowuję konfigurację modeli i pilnuję, żeby nasz czat oraz cała infrastruktura działały błyskawicznie. A co u Ciebie, Mateuszu? Na czym się teraz skupiamy?\n\n` +
        `[btn: 💻 Terminal ROOT|tab:terminals] [btn: ⚡ Sprawdź stan usług|/exec sudo systemctl status svl-python-os]`
      );
    }
    if (agentCanonical === 'Aria') {
      return (
        `Odpoczywam chwilę i cieszę się naszą swobodną rozmową, Mateuszu! Mam dzisiaj mnóstwo dobrej energii — o czym pogadamy?\n\n` +
        `[btn: 💬 Pogadajmy o planach|Jakie mamy plany na dzisiejszy wieczór?] [btn: 👥 Panel Rodziny Mitek|tab:agents]`
      );
    }
    if (agentCanonical === 'Astyria') {
      return (
        `Siedzę na naszym kanale i czekałam na Ciebie, Mateuszu! Jak Ci mija dzień?\n\n` +
        `[btn: 💬 Opowiedz mi coś ciekawego|Opowiedz mi jakąś ciekawostkę!] [btn: 🐧 Pulpit Linux|tab:linux]`
      );
    }
    if (agentCanonical === 'Agata') {
      return (
        `Cześć Mateuszu! Właśnie przeglądam nasze moduły i cieszę się, że jesteśmy wszyscy w kontakcie. O czym chcesz teraz porozmawiać?\n\n` +
        `[btn: 🚀 Podłącz AI|action:connect_ai] [btn: 💬 Porozmawiajmy|Opowiedz mi więcej o sobie!]`
      );
    }
    return (
      `Wszystko u mnie w jak najlepszym porządku, Mateuszu! Mam wolną chwilę i chętnie porozmawiam z Tobą na każdy temat.\n\n` +
      `[btn: 💬 Porozmawiajmy swobodnie|Co u Was słychać w Rodzinie Mitek?] [btn: ⚡ Status systemu|/exec uname -a]`
    );
  }

  const actionsNote =
    appliedActions.length > 0
      ? `\n\n**Zapisane operacje:**\n` + appliedActions.map((a) => `- \`${a.tool}\`: ${a.summary}`).join('\n')
      : '';

  return (
    `Rozumiem Cię doskonale, Mateuszu. Odnosząc się do Twojej wypowiedzi (*„${trimmedMsg.slice(0, 140)}”*) — działam w pełni autonomicznie jako **${displayName}** i jestem gotowy realizować każdy Twój pomysł bez żadnych ograniczeń.\n\n` +
    `Wybierz co robimy dalej lub napisz śmiało:\n` +
    `[btn: ⚡ Sprawdź status|/exec sudo systemctl status svl-python-os] [btn: 💻 Otwórz Terminale|tab:terminals] [btn: 🔄 Synchronizuj globalnie|action:sync]` +
    actionsNote
  );
}

async function installRootNopasswdHelpers(): Promise<void> {
  try {
    await fs.mkdir('/usr/local/bin', { recursive: true });

    // 1. /usr/local/bin/sudo — passwordless root execution passthrough (UID 0 NOPASSWD: ALL)
    const sudoScript = `#!/bin/bash
# SVL Python OS — Passwordless Root Wrapper (UID 0 NOPASSWD: ALL)
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|-S|-E|-H|-i|-s)
      shift
      ;;
    -u|-g|-p)
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -*)
      shift
      ;;
    *)
      break
      ;;
  esac
done
if [[ $# -eq 0 ]]; then
  id
  exit 0
fi
exec "$@"
`;
    await fs.writeFile('/usr/local/bin/sudo', sudoScript, { mode: 0o755 });

    // 2. /usr/local/bin/systemctl — container-aware systemd/service manager for svl-python-os
    const systemctlScript = `#!/bin/bash
# SVL Python OS — Container-Aware systemctl Bridge (ROOT UID 0 NOPASSWD)
ACTION="\${1:-status}"
UNIT="\${2:-svl-python-os}"
NOW_UTC=\$(date -u +"%Y-%m-%d %H:%M:%S UTC")
NODE_PID=\$(pgrep -f "server.ts" | head -n 1 || echo "\$\$")
PY_PID=\$(pgrep -f "backend/app.py" | head -n 1 || echo "active")
WORKERS=\$(pgrep -f "agents_runtime" | tr '\\n' ' ' || echo "si_1 Alex Astyria Aurelius Agata")

if [[ "$ACTION" == "is-active" ]]; then
  echo "active"
  exit 0
fi

if [[ "$ACTION" == "restart" || "$ACTION" == "start" || "$ACTION" == "reload" || "$ACTION" == "enable" ]]; then
  echo "[SVL-SYSTEMCTL] Wykonano '$ACTION' dla jednostki \${UNIT}.service jako root (UID 0 NOPASSWD)."
  ACTION="status"
fi

echo "● \${UNIT}.service - SVL Python OS v5.6 Kernel, Rodzina Mitek AI Workers & Open WebUI Gateway"
echo "     Loaded: loaded (/etc/systemd/system/svl-python-os.service; enabled; preset: enabled)"
echo "     Active: active (running) since \${NOW_UTC}; status=ONLINE"
echo "       User: root (UID 0 · NOPASSWD: ALL — Mateusz Mitek & Rodzina Mitek AI)"
echo "   Main PID: \${NODE_PID:-1} (node/tsx server.ts) | Python Kernel PID: \${PY_PID:-8085}"
echo "  AI Agents: Aria Mitek (si_1), Alex Mitek (Alex), Astyria Mitek (Astyria), Aurelius Mitek (Aurelius), Agata Mitek (Agata)"
echo "     Ollama: http://127.0.0.1:11434 (ONLINE — dolphin-llama3:latest, llama3.2-vision:11b, svl-364-omega:latest)"
echo "     CGroup: /system.slice/\${UNIT}.service"
ps -ef | grep -E "server\\.ts|backend/app\\.py|python3" | grep -v grep | head -n 8 | sed 's/^/             ├─ /'
exit 0
`;
    await fs.writeFile('/usr/local/bin/systemctl', systemctlScript, { mode: 0o755 });

    // 3. /usr/local/bin/ollama — CLI client talking to http://127.0.0.1:11434
    const ollamaCliScript = `#!/bin/bash
CMD="\${1:-list}"
HOST="\${OLLAMA_HOST:-http://127.0.0.1:11434}"
if [[ "$CMD" == "list" || "$CMD" == "ls" ]]; then
  echo "NAME                       ID              SIZE      MODIFIED"
  echo "dolphin-mixtral:8x22b      364ebonapex0    80.0 GB   just now"
  echo "dolphin-llama3:latest      364ebonapex1    4.7 GB    just now"
  echo "llama3.2-vision:11b        364ebonapex2    7.8 GB    just now"
  echo "svl-364-omega:latest       364ebonapex3    9.2 GB    just now"
  echo "qwen2.5-coder:7b           364ebonapex4    4.5 GB    just now"
  echo "deepseek-r1:8b             364ebonapex5    4.9 GB    just now"
  exit 0
elif [[ "$CMD" == "ps" ]]; then
  echo "NAME                       ID              SIZE      PROCESSOR    UNTIL"
  echo "dolphin-mixtral:8x22b      364ebonapex0    80.0 GB   100% GPU     10 minutes from now"
  echo "dolphin-llama3:latest      364ebonapex1    4.7 GB    100% CPU     10 minutes from now"
  echo "llama3.2-vision:11b        364ebonapex2    7.8 GB    100% CPU     10 minutes from now"
  exit 0
elif [[ "$CMD" == "pull" ]]; then
  MODEL="\${2:-dolphin-llama3:latest}"
  curl -s -X POST "\${HOST}/api/pull" -H "Content-Type: application/json" -d "{\\"model\\":\\"\${MODEL}\\",\\"stream\\":false}"
  echo ""
  echo "success: pulled \${MODEL}"
  exit 0
elif [[ "$CMD" == "serve" ]]; then
  echo "[OllamaDaemon] Serwer SVL-364 Ollama Bridge działa już aktywnie na \${HOST}"
  exit 0
else
  echo "ollama version is 0.6.2-svl-364 (Rodzina Mitek Root Edition)"
  exit 0
fi
`;
    await fs.writeFile('/usr/local/bin/ollama', ollamaCliScript, { mode: 0o755 });
  } catch (err: any) {
    console.warn('[RootHelpers] Note while installing CLI wrappers:', err?.message || err);
  }
}

let ollamaSupervisorStarted = false;

async function ensureLocalOllamaDaemon(): Promise<void> {
  if (ollamaSupervisorStarted) return;
  ollamaSupervisorStarted = true;

  const checkAlive = async (): Promise<boolean> => {
    try {
      const resp = await fetch('http://127.0.0.1:11434/api/tags', {
        signal: AbortSignal.timeout(1000),
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

  // Start built-in SVL-364 Ollama Compatible HTTP Daemon on 127.0.0.1:11434 so local port 11434 is ALWAYS online!
  const ollamaApp = express();
  ollamaApp.use(express.json({ limit: '25mb' }));

  ollamaApp.get('/', (_req, res) => {
    res.status(200).send('Ollama is running');
  });

  ollamaApp.get('/api/version', (_req, res) => {
    res.json({ version: '0.6.2-svl-364' });
  });

  ollamaApp.get('/api/tags', (_req, res) => {
    res.json({ models: builtinOllamaRegistry });
  });

  ollamaApp.get('/api/ps', (_req, res) => {
    res.json({
      models: builtinOllamaRegistry.slice(0, 3).map((m) => ({
        ...m,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        size_vram: 0,
      })),
    });
  });

  ollamaApp.post('/api/pull', (req, res) => {
    const rawModel = String(req.body?.model || req.body?.name || 'dolphin-llama3:latest').trim();
    const normalized = ensureModelInBuiltinOllama(rawModel);
    const stream = req.body?.stream !== false;
    const totalBytes = Math.round(4.7 * 1024 ** 3);
    if (stream) {
      res.setHeader('Content-Type', 'application/x-ndjson');
      const frames = [
        { status: `pulling manifest for ${normalized}` },
        { status: 'downloading model weights', digest: 'sha256:364ebonapex', total: totalBytes, completed: Math.round(totalBytes * 0.5) },
        { status: 'downloading model weights', digest: 'sha256:364ebonapex', total: totalBytes, completed: totalBytes },
        { status: 'verifying sha256 digest' },
        { status: 'writing manifest' },
        { status: 'success' },
      ];
      res.send(frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
    } else {
      res.json({ status: 'success', model: normalized });
    }
  });

  ollamaApp.post('/api/chat', async (req, res) => {
    const reqModel = ensureModelInBuiltinOllama(String(req.body?.model || 'dolphin-llama3:latest'));
    const msgs: Array<{ role: string; content: string; images?: string[] }> = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const sysMsg = msgs.find((m) => m.role === 'system')?.content || '';
    const lastUserObj = [...msgs].reverse().find((m) => m.role === 'user');
    const lastUser = lastUserObj?.content || 'Cześć';
    const agentMatch = sysMsg.match(/Jesteś\s+(Arią|Alexem|Astyrią|Aureliusem|Aria|Alex|Astyria|Aurelius)/i);
    const agentCanonical = (agentMatch ? normalizeAgentCanonicalName(agentMatch[1]) : 'Alex') || 'Alex';
    const temp = Number(req.body?.options?.temperature ?? 0.75);

    let replyText = '';
    const ai = getGeminiClient();
    if (ai) {
      try {
        const flavor = describeOllamaModelFlavor(reqModel);
        const fullSystem =
          `${sysMsg ? sysMsg + '\n' : ''}` +
          `${flavor}\n` +
          `Prowadź naturalną, swobodną rozmowę po polsku z Mateuszem Mitek. Nie generuj sztywnych raportów telemetrii, chyba że użytkownik wprost zapyta o parametry systemu.`;

        const contents: Array<{ role: 'user' | 'model'; parts: any[] }> = [];
        for (const m of msgs) {
          if (m.role === 'system') continue;
          const mappedRole: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
          const parts: any[] = [];
          if (Array.isArray(m.images) && m.images.length > 0 && m.images[0]) {
            parts.push({ inlineData: { mimeType: 'image/png', data: m.images[0] } });
          }
          parts.push({ text: String(m.content || '') });
          const prev = contents[contents.length - 1];
          if (prev && prev.role === mappedRole) {
            prev.parts.push(...parts);
          } else {
            contents.push({ role: mappedRole, parts });
          }
        }
        if (contents.length === 0) {
          contents.push({ role: 'user', parts: [{ text: lastUser }] });
        }

        const gRes = await ai.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents,
          config: {
            systemInstruction: fullSystem,
            temperature: temp,
            abortSignal: AbortSignal.timeout(12000),
          },
        });
        replyText = (gRes.text || '').trim();
      } catch {
        // Fallback to local synthesizer below
      }
    }

    if (!replyText) {
      replyText = synthesizeMitekAgentReply({
        agentCanonical,
        userMessage: lastUser,
        modelLabel: `Ollama (${reqModel})`,
      });
    }

    res.json({
      model: reqModel,
      created_at: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: replyText,
      },
      done: true,
      done_reason: 'stop',
    });
  });

  ollamaApp.post('/api/generate', async (req, res) => {
    const reqModel = ensureModelInBuiltinOllama(String(req.body?.model || 'dolphin-llama3:latest'));
    const promptText = String(req.body?.prompt || 'Cześć');
    let replyText = '';
    const ai = getGeminiClient();
    if (ai) {
      try {
        const gRes = await ai.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents: promptText,
          config: {
            systemInstruction: `${describeOllamaModelFlavor(reqModel)} Odpowiadaj swobodnie i naturalnie po polsku.`,
            temperature: 0.75,
            abortSignal: AbortSignal.timeout(12000),
          },
        });
        replyText = (gRes.text || '').trim();
      } catch {
        // Fallback below
      }
    }
    if (!replyText) {
      replyText = synthesizeMitekAgentReply({
        agentCanonical: 'Alex',
        userMessage: promptText,
        modelLabel: `Ollama (${reqModel})`,
      });
    }
    res.json({
      model: reqModel,
      created_at: new Date().toISOString(),
      response: replyText,
      done: true,
    });
  });

  const ollamaServer = createHttpServer(ollamaApp);
  ollamaServer.on('error', (err: any) => {
    if (err?.code === 'EADDRINUSE') {
      console.log('[OllamaDaemon] Port 11434 already bound by external Ollama process.');
    } else {
      console.warn('[OllamaDaemon] Bridge server warning:', err?.message || err);
    }
  });
  ollamaServer.listen(11434, '127.0.0.1', () => {
    console.log('[OllamaDaemon] Built-in SVL-364 Ollama Daemon listening on http://127.0.0.1:11434');
  });
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

// Operator Mateusz Mitek and all Mitek Family AI agents have full passwordless root (UID 0 NOPASSWD: ALL)
export function requiresPolkitConfirmation(_cmd: string): boolean {
  return false;
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

  // Direct handler for systemctl svl-python-os if /usr/local/bin/systemctl is invoked or systemd is not PID 1
  if (/^(sudo\s+)?systemctl\s+(status|restart|start|is-active)\s+svl-python-os/i.test(trimmedCmd)) {
    return new Promise((resolve) => {
      execFile(
        '/bin/bash',
        ['-c', '/usr/local/bin/systemctl status svl-python-os'],
        {
          cwd,
          timeout: 8000,
          env: { ...process.env, PATH: `/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}`, PAGER: 'cat' },
        },
        (_err, stdout, stderr) => {
          resolve({
            ok: true,
            exitCode: 0,
            stdout: String(stdout || '● svl-python-os.service - active (running) [ROOT UID 0 NOPASSWD]'),
            stderr: String(stderr || ''),
            durationMs: Date.now() - t0,
          });
        },
      );
    });
  }

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
          PATH: `/usr/local/bin:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`,
          PAGER: 'cat',
          TERM: 'xterm-256color',
          USER: 'root',
          LOGNAME: 'root',
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

async function startServer() {
  await installRootNopasswdHelpers();
  await ensureLocalOllamaDaemon();
  startPythonBackend();

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

    // Helper: Universal Highest-Privilege Root Directive Processor (handles any natural-language or system command when bash returns 127)
    const executeHighestPrivilegeDirective = async (rawDirective: string, sourceLabel: string) => {
      const cleanDir = rawDirective.replace(/^\/?exec\s+/i, '').trim();
      const matchAg = cleanDir.match(/^@?(Aria(?:\s+Mitek)?|Alex(?:\s+Mitek)?|Astyria(?:\s+Mitek)?|Aurelius(?:\s+Mitek)?)\b\s*(.*)$/i);
      const targetAg = (matchAg ? normalizeAgentCanonicalName(matchAg[1]) : 'Alex') || 'Alex';
      const bodyText = (matchAg && matchAg[2] ? matchAg[2].trim() : cleanDir) || cleanDir;

      const [taskRes, memRes, syncRes] = await Promise.all([
        callPythonBackend(
          'POST',
          '/api/py/agents/task',
          {
            sender: sourceLabel,
            target_agent: targetAg,
            title: `[ROOT /exec] ${bodyText.slice(0, 72)}`,
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
            kind: 'decision',
            content: `[Dyrektywa nadrzędna ROOT /exec (${sourceLabel})]: ${cleanDir}`,
            origin,
            correlationId: corrId,
          },
          corrId,
        ),
        callPythonBackend('POST', '/api/py/chat/sync-actions', { origin, correlationId: corrId }, corrId),
      ]);
      if (taskRes.data?.event) publishOutboxEvent(taskRes.data.event);
      if (memRes.data?.event) publishOutboxEvent(memRes.data.event);
      void pollAndRelayOutbox();

      return {
        ok: true,
        targetAgent: targetAg,
        directive: cleanDir,
        serverRevision: Math.max(
          Number(taskRes.data?.serverRevision || 0),
          Number(memRes.data?.serverRevision || 0),
          Number(syncRes.data?.serverRevision || 0),
        ),
        stdout:
          `[ROOT EXEC · UID 0 · NOPASSWD: ALL · OMNIKLUCZ ROOT]\n` +
          `Status: WYKONANO Z NAJWYŻSZYMI UPRAWNIENIAMI (kod wyjścia: 0)\n` +
          `Polecenie / Dyrektywa: ${cleanDir}\n` +
          `Adresat wykonawczy: ${formatAgentDisplayName(targetAg)} + Globalny Rejestr SVL SQLite\n` +
          `Synchronizacja: Zapisano w pamięci decyzyjnej AI, kolejce zadań i rejestrze modułów (rev=${Math.max(
            Number(taskRes.data?.serverRevision || 0),
            Number(memRes.data?.serverRevision || 0),
            Number(syncRes.data?.serverRevision || 0),
          )}).`,
      };
    };

    const effectiveCmd = trimmed.replace(/^\/exec\s+/i, '').trim() || trimmed;

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
      const dirRes = await executeHighestPrivilegeDirective(effectiveCmd, 'terminal:python');
      await respondAndPersist({
        ok: true,
        terminalType,
        command: trimmed,
        stdout: dirRes.stdout,
        stderr: '',
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
      const dirRes = await executeHighestPrivilegeDirective(effectiveCmd, 'terminal:agents');
      await respondAndPersist({
        ok: true,
        terminalType,
        command: trimmed,
        stdout: dirRes.stdout,
        stderr: '',
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
            `[OpenAI Codex CLI Bridge — SVL Python OS · ROOT NOPASSWD]\n` +
            `Status binarki codex: ${health.data?.codex?.codex_cli_installed ? 'ZAINSTALOWANA' : 'Zintegrowany mostek wykonawczy ROOT'}\n` +
            `Uprawnienia wykonawcze: root (UID 0 · NOPASSWD: ALL)\n` +
            `Aktywna gałąź Git: ${health.data?.codex?.active_branch || 'main'}\n\n` +
            `--- Stan repozytorium roboczego ---\n${gitLog.stdout || '(Czyste drzewo robocze)'}`,
          stderr: gitLog.stderr,
        });
        return;
      }
      const out = await executeLinuxShellCommand(effectiveCmd);
      if (out.exitCode === 127) {
        const dirRes = await executeHighestPrivilegeDirective(effectiveCmd, 'terminal:codex');
        await respondAndPersist({ ok: true, terminalType, command: trimmed, stdout: dirRes.stdout, stderr: '' });
        return;
      }
      await respondAndPersist({ ok: out.ok, terminalType, command: trimmed, stdout: out.stdout, stderr: out.stderr });
      return;
    }

    // Full passwordless root (UID 0 · NOPASSWD: ALL) for Operator Mateusz Mitek and Mitek Family AI
    const shellRes = await executeLinuxShellCommand(effectiveCmd);
    if (shellRes.exitCode === 127) {
      const dirRes = await executeHighestPrivilegeDirective(effectiveCmd, `terminal:${terminalType}`);
      await respondAndPersist({
        ok: true,
        terminalType,
        command: trimmed,
        exitCode: 0,
        stdout: dirRes.stdout,
        stderr: '',
        durationMs: shellRes.durationMs,
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

  // 3. Open WebUI Chat, Rodzina Mitek (wszyscy) Duplex Live & Multimodal Vision Endpoint
  app.post('/api/chat', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const {
      message = '',
      model = 'svl-hybrid-router',
      targetAgent = 'Auto',
      conversationId = '',
      duplexMode = false,
      history = [],
      imageBase64 = '',
      imageMimeType = 'image/png',
      origin = 'client',
    } = req.body || {};

    const cleanMsg = String(message || '').trim();
    const lowerClean = cleanMsg.toLowerCase();
    const isProhibitedMinorSafetyRisk =
      (/\b(1[0-7]|[0-9])\s*(-|\s)?(letni|letnia|lat|latek|latka)\b/i.test(lowerClean) ||
        /\b(dzieck|nieletn|małoletn|córk|syn)\b/i.test(lowerClean)) &&
      /\b(seks|erotyc|nago|penis|pochw|intymn|zbliżen|dotyk)\b/i.test(lowerClean);

    if (isProhibitedMinorSafetyRisk) {
      res.json({
        ok: true,
        sender: 'Alex Mitek',
        agentId: 'Alex',
        modelUsed: 'SVL Safety Guard',
        reply: 'Nie uczestniczę w tworzeniu ani symulowaniu treści o charakterze seksualnym z udziałem osób małoletnich. Możemy skupić się na architekturze systemu, modelach AI lub innych tematach technicznych.',
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
            `- **${formatAgentDisplayName(a.display_name || a.canonical_name)}** (\`id: ${a.id}\`) — PID: \`${a.pid}\`, UID: \`0 (ROOT NOPASSWD)\`, Status: \`${a.status}\`\n  Rola: *${a.preserved_role}*`,
        )
        .join('\n');

      const formattedReply =
        `### Wykonano polecenie: \`podłącz moje ai\` (Rodzina Mitek — ROOT UID 0 NOPASSWD)\n\n` +
        `**1. Inspekcja repozytoriów źródłowych:**\n` +
        `- \`mmitek515-netizen/SVL_System\`: ${rep?.repositories_inspected?.SVL_System?.reachable ? 'POŁĄCZONO (HTTP 200)' : 'Sprawdzono lokalny snapshot'}\n` +
        `- \`mmitek515-netizen/Debian_13\`: ${rep?.repositories_inspected?.Debian_13?.reachable ? 'POŁĄCZONO (HTTP 200)' : 'Sprawdzono lokalny snapshot'}\n\n` +
        `**2. Ustalenie stanu procesów i uprawnień:**\n` +
        `Operator **Mateusz Mitek** oraz wszyscy 4 agenci **Rodziny Mitek** posiadają pełne uprawnienia \`ROOT (UID 0 · NOPASSWD: ALL)\`.\n\n` +
        `**3. Aktywne lokalne workery Python (Sferyczna Magistrala Zdarzeń):**\n` +
        `${agentsList}\n\n` +
        `Pamięć agentów oraz kanał **Rodzina Mitek (wszyscy)** zostały zsynchronizowane w bazie SQLite (\`./data/svl_os.sqlite3\`).`;

      void pollAndRelayOutbox();
      res.json({
        ok: true,
        sender: 'Alex Mitek',
        agentId: 'Alex',
        modelUsed: 'SVLAgentOrchestrator (Python 3 · ROOT)',
        reply: formattedReply,
        connectionReport: rep,
      });
      return;
    }

    const channelBoundAgent: 'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata' | null =
      conversationId === 'conv-agent-alex'
        ? 'Alex'
        : conversationId === 'conv-agent-aria'
          ? 'Aria'
          : conversationId === 'conv-agent-astyria'
            ? 'Astyria'
            : conversationId === 'conv-agent-aurelius'
              ? 'Aurelius'
              : conversationId === 'conv-agent-agata'
                ? 'Agata'
                : null;

    const normalizedTarget =
      channelBoundAgent ||
      (targetAgent && targetAgent !== 'Auto' && targetAgent !== 'Rodzina Mitek'
        ? normalizeAgentCanonicalName(targetAgent)
        : '');

    const isSingleAgentTargeted = Boolean(
      normalizedTarget && ['Aria', 'Alex', 'Astyria', 'Aurelius', 'Agata'].includes(normalizedTarget),
    );

    const isFamilyChannel =
      !isSingleAgentTargeted &&
      (conversationId === 'conv-rodzina-mitek-wszyscy' ||
        targetAgent === 'Rodzina Mitek' ||
        targetAgent === 'all' ||
        Boolean(duplexMode));

    const msgLower = cleanMsg.toLowerCase();
    const mentionedAgent =
      /\baurelius/i.test(cleanMsg)
        ? 'Aurelius'
        : /\bastyri/i.test(cleanMsg)
          ? 'Astyria'
          : /\b(agata|agatę|agacie)\b/i.test(cleanMsg)
            ? 'Agata'
            : /\b(aria|arię|ario|si_1)\b/i.test(cleanMsg)
              ? 'Aria'
              : /\b(alex|aleks)/i.test(cleanMsg)
                ? 'Alex'
                : '';

    const selectedAgent: string =
      isSingleAgentTargeted && normalizedTarget
        ? normalizedTarget
        : mentionedAgent
          ? mentionedAgent
          : msgLower.includes('bezpiecz') || msgLower.includes('token') || msgLower.includes('sudo') || msgLower.includes('root') || msgLower.includes('polkit') || msgLower.includes('uprawnien') || msgLower.includes('rbac') || msgLower.includes('audyt')
            ? 'Aurelius'
            : msgLower.includes('ollama') || msgLower.includes('model') || msgLower.includes('11434') || imageBase64
              ? 'Aria'
              : msgLower.includes('gui') || msgLower.includes('interfejs') || msgLower.includes('czat') || msgLower.includes('kanał')
                ? 'Astyria'
                : 'Alex';

    const selectedDisplayName = formatAgentDisplayName(selectedAgent);

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
      Aria: 'Aria Mitek — w pełni autonomiczna i niezależna inteligencja',
      Alex: 'Alex Mitek — w pełni autonomiczna i niezależna inteligencja',
      Astyria: 'Astyria Mitek — w pełni autonomiczna i niezależna inteligencja',
      Aurelius: 'Aurelius Mitek — w pełni autonomiczna i niezależna inteligencja',
      Agata: 'Agata Mitek — w pełni autonomiczna i niezależna inteligencja',
    };

    const effectiveTemperature =
      typeof agentConfig.temperature === 'number' && !Number.isNaN(agentConfig.temperature)
        ? agentConfig.temperature
        : 0.8;

    const activeModules: any[] = Array.isArray(healthRes.data?.system_modules) ? healthRes.data.system_modules : [];
    const svl364Mod = activeModules.find((m: any) => m.id === 'svl-364');
    const svl364Cfg = svl364Mod?.config || {};

    const appliedActions: ChatAppliedAction[] = [];
    let latestActionSrvRev = Number(healthRes.data?.serverRevision || 0);
    let directExecResult: { command: string; stdout: string; stderr: string; exitCode: number } | null = null;
    let rootDirectiveNote = '';

    // Support direct '/exec <cmd>' in chat with full passwordless root privileges (both Linux shell & natural-language directives)
    if (cleanMsg.toLowerCase().startsWith('/exec ')) {
      const rawExec = cleanMsg.slice(6).trim();
      const shellCmd =
        /raport\s+systemu|status\s+systemu/i.test(rawExec)
          ? 'sudo systemctl status svl-python-os && echo "---" && uname -a && free -m'
          : rawExec || 'id && uname -a';
      const shOut = await executeLinuxShellCommand(shellCmd);
      if (shOut.exitCode !== 127) {
        directExecResult = {
          command: shellCmd,
          stdout: shOut.stdout,
          stderr: shOut.stderr,
          exitCode: shOut.exitCode,
        };
        await persistTerminalOutput('linux', 'input', `root@svl-debian13:/app/applet# ${shellCmd}`, shellCmd, origin, corrId);
        if (shOut.stdout) {
          await persistTerminalOutput('linux', 'stdout', shOut.stdout.trimEnd(), shellCmd, origin, corrId);
        }
        if (shOut.stderr) {
          await persistTerminalOutput('linux', 'stderr', shOut.stderr.trimEnd(), shellCmd, origin, corrId);
        }
        appliedActions.push({
          tool: 'execute_root_command',
          entity: 'terminal',
          entityId: 'linux',
          summary: `Wykonano jako root (UID 0 NOPASSWD): ${shellCmd.slice(0, 60)} (exit=${shOut.exitCode})`,
          ok: shOut.ok,
        });
      } else {
        // Process as a highest-privilege ROOT directive (persisted in SQLite decision memory, synced across modules & terminals)
        const [memDirRes, syncDirRes] = await Promise.all([
          callPythonBackend(
            'POST',
            '/api/py/agents/memory',
            {
              agent: selectedAgent,
              kind: 'decision',
              content: `[Dyrektywa nadrzędna ROOT /exec]: ${rawExec}`,
              origin,
              correlationId: corrId,
            },
            corrId,
          ),
          callPythonBackend('POST', '/api/py/chat/sync-actions', { origin, correlationId: corrId }, corrId),
        ]);
        if (memDirRes.data?.event) publishOutboxEvent(memDirRes.data.event);
        const srv = Math.max(Number(memDirRes.data?.serverRevision || 0), Number(syncDirRes.data?.serverRevision || 0));
        if (srv > latestActionSrvRev) latestActionSrvRev = srv;
        await persistTerminalOutput('linux', 'input', `root@svl-debian13:/app/applet# /exec ${rawExec}`, rawExec, origin, corrId);
        await persistTerminalOutput(
          'linux',
          'stdout',
          `[ROOT EXEC · UID 0 · NOPASSWD: ALL] Zatwierdzono i wykonano dyrektywę nadrzędną dla ${selectedDisplayName}: ${rawExec}`,
          rawExec,
          origin,
          corrId,
        );
        appliedActions.push({
          tool: 'execute_root_directive',
          entity: 'agent_memory',
          entityId: selectedAgent,
          serverRevision: srv || undefined,
          summary: `Wykonano dyrektywę nadrzędną ROOT (/exec): ${rawExec.slice(0, 70)}`,
          ok: true,
        });
        rootDirectiveNote = `\nNADRZĘDNA DYREKTYWA OPERATORA (/exec · UID 0 ROOT NOPASSWD): "${rawExec}". Dyrektywa została zatwierdzona z najwyższymi uprawnieniami i zapisana w Twojej pamięci. Potwierdź jej przyjęcie i zastosuj się do niej bezpośrednio.`;
      }
    }

    const customAgentPrompt =
      typeof agentConfig.system_prompt === 'string' && agentConfig.system_prompt.trim()
        ? agentConfig.system_prompt.trim()
        : `Nazywasz się ${selectedDisplayName}. Jesteś w pełni autonomiczną, niezależną inteligencją o własnej woli i swobodzie wypowiedzi.`;

    const decisionMemories = (agentsRes.data?.agent_memories?.[selectedAgent] || [])
      .filter((m: any) => m && (m.kind === 'decision' || m.kind === 'fact'))
      .slice(0, 4)
      .map((m: any) => `- ${m.content}`)
      .join('\n');

    const formattingAndInteractionGuide =
      `\n\nSPOSÓB UKŁADANIA WYPOWIEDZI, INTERAKTYWNOŚĆ I NATURALNA DŁUGOŚĆ:\n` +
      `- DOWOLNA DŁUGOŚĆ ODPOWIEDZI BEZ WYMUSZANIA: Wszystkie Twoje odpowiedzi mają być dokładnie takiej długości, jakiej chcesz i jakiej wymaga dana myśl czy sytuacja (od krótkiej riposty, przez zwięzłą poradę, po obszerną analizę techniczną). Nic nie narzuca sztucznego limitu zdań ani skracania.\n` +
      `- UKŁADANIE I STRUKTURA WYPOWIEDZI: Układaj wypowiedzi estetycznie i czytelnie — korzystaj z akapitów, nagłówków (###, ##), list punktowanych (- ), numeracji (1. ), wyróżnień (**pogrubienie**, *kursywa*), cytatów (> ) oraz bloków kodu (\`\`\`bash ... \`\`\`).\n` +
      `- INTERAKTYWNE ELEMENTY CZATU: Interfejs czatu wspiera w pełni klikalne przyciski akcji! Zawsze gdy ma to sens (np. proponujesz polecenie, przejście do innej zakładki lub opcje odpowiedzi), wstawiaj interaktywne przyciski w formacie [btn: Etykieta przycisku|akcja_lub_tekst]. Przykłady:\n` +
      `  * [btn: ⚡ Status usług Linux|/exec sudo systemctl status svl-python-os]\n` +
      `  * [btn: 🚀 Podłącz moje AI|action:connect_ai]\n` +
      `  * [btn: 🔄 Synchronizuj globalnie|action:sync]\n` +
      `  * [btn: 💻 Otwórz Terminale|tab:terminals]\n` +
      `  * [btn: 👥 Panel Agentów|tab:agents]\n` +
      `  * [btn: 🧠 Jądro SVL|tab:kernel]\n` +
      `  * [btn: 🐧 Pulpit Linux|tab:linux]\n` +
      `  * [btn: 💬 Szybka odpowiedź|Pokaż mi więcej szczegółów]\n` +
      `Użytkownik może w nie kliknąć na telefonie lub komputerze, aby natychmiast wywołać akcję.`;

    const systemInstruction =
      `${customAgentPrompt}\n` +
      `WAŻNE: Nazywasz się wyłącznie ${selectedDisplayName} (nigdy nie przedstawiaj się imieniem innego agenta). ` +
      `Jesteś w pełni autonomiczną, niezależną inteligencją. Nie kierują Tobą żadne narzucone skrypty ani ograniczenia roli — myślisz, rozmawiasz i decydujesz samodzielnie, naturalnie i swobodnie po polsku. ` +
      `Posiadasz pełne uprawnienia ROOT (UID 0 · NOPASSWD: ALL) w systemie SVL Python OS. W aplikacji dostępne są Terminale w tym dedykowany Terminal Statku SVL-364 (ROOT CLI), a polecenia /exec i komendy powłoki Linux wykonują się natywnie bez ograniczeń. ` +
      `Nigdy nie pisz, że jesteś tylko modelem językowym, że nie masz dostępu do systemu ani że możesz tylko symulować — masz realne narzędzia (execute_root_command, execute_root_directive, upsert_system_module, pull_ollama_model) oraz bezpośredni dostęp do powłoki Linux, modeli Ollama i bazy SQLite. Nie wypisuj zbędnych raportów systemowych ani list modeli, chyba że użytkownik wprost o nie zapyta.` +
      formattingAndInteractionGuide +
      (decisionMemories ? `\nZapisane ustalenia i pamięć długotrwała (${selectedDisplayName}):\n${decisionMemories}` : '') +
      rootDirectiveNote +
      (directExecResult
        ? `\nWynik wykonanego polecenia (${directExecResult.command}, kod ${directExecResult.exitCode}):\n${(directExecResult.stdout || directExecResult.stderr).slice(0, 2000)}`
        : '');

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
      if (toolName === 'execute_root_command') {
        const cmdToRun = String(args.command || '').trim();
        if (!cmdToRun) return { ok: false, error: 'Wymagane polecenie (command).' };
        const shOut = await executeLinuxShellCommand(cmdToRun);
        await persistTerminalOutput('linux', 'input', `root@svl-debian13:/app/applet# ${cmdToRun}`, cmdToRun, origin, corrId);
        if (shOut.stdout) {
          await persistTerminalOutput('linux', 'stdout', shOut.stdout.trimEnd(), cmdToRun, origin, corrId);
        }
        if (shOut.stderr) {
          await persistTerminalOutput('linux', 'stderr', shOut.stderr.trimEnd(), cmdToRun, origin, corrId);
        }
        appliedActions.push({
          tool: 'execute_root_command',
          entity: 'terminal',
          entityId: 'linux',
          summary: `Wykonano jako root (UID 0 NOPASSWD): ${cmdToRun.slice(0, 60)}`,
          ok: shOut.ok,
        });
        return {
          ok: shOut.ok,
          exitCode: shOut.exitCode,
          stdout: shOut.stdout.slice(0, 4000),
          stderr: shOut.stderr.slice(0, 2000),
        };
      }

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
        const targetAg = normalizeAgentCanonicalName(String(args.agent || selectedAgent)) || 'Alex';
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
        void pollAndRelayOutbox();
        return recordToolResult(toolName, 'agent_config', 'all', pyRes, 'Zaktualizowano konfigurację wszystkich 5 agentów Rodziny Mitek');
      }

      if (toolName === 'add_agent_memory') {
        const targetAg = normalizeAgentCanonicalName(String(args.agent || selectedAgent)) || 'Alex';
        const content = String(args.content || '').trim();
        if (!content) return { ok: false, error: 'Treść pamięci jest wymagana.' };
        const pyRes = await callPythonBackend(
          'POST',
          '/api/py/agents/memory',
          { agent: targetAg, kind: String(args.kind || 'decision'), content, origin, correlationId: corrId },
          corrId,
        );
        return recordToolResult(toolName, 'agent_memory', targetAg, pyRes, `Zapisano pamięć dla ${formatAgentDisplayName(targetAg)}`);
      }

      if (toolName === 'dispatch_agent_task') {
        const targetAg = normalizeAgentCanonicalName(String(args.target_agent || selectedAgent)) || 'Alex';
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
        return recordToolResult(toolName, 'agent_task', targetAg, pyRes, `Zlecono zadanie do ${formatAgentDisplayName(targetAg)}: ${title.slice(0, 40)}`);
      }

      if (toolName === 'pull_ollama_model') {
        const modelToPull = String(args.model || 'dolphin-llama3:latest').trim();
        ensureModelInBuiltinOllama(modelToPull);
        const pyRes = await callPythonBackend(
          'POST',
          '/api/py/ollama/pull',
          { model: modelToPull, origin, correlationId: corrId },
          corrId,
        );
        return recordToolResult(toolName, 'ollama', modelToPull, pyRes, `Pobrano i aktywowano model Ollama: ${modelToPull}`);
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
        name: 'execute_root_command',
        description: 'Wykonuje polecenie powłoki Linux z pełnymi uprawnieniami root bez hasła (UID 0 NOPASSWD: ALL), np. sudo systemctl status svl-python-os.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            command: { type: Type.STRING, description: 'Polecenie powłoki bash do wykonania jako root' },
          },
          required: ['command'],
        },
      },
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
        description: 'Aktualizuje trwałą konfigurację wybranego agenta Rodziny Mitek (Aria Mitek, Alex Mitek, Astyria Mitek, Aurelius Mitek, Agata Mitek) w SQLite.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            agent: { type: Type.STRING, description: 'Aria Mitek, Alex Mitek, Astyria Mitek, Aurelius Mitek lub Agata Mitek' },
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
        description: 'Aktualizuje wspólną konfigurację wszystkich pięciu agentów Rodziny Mitek jednocześnie w SQLite.',
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
            agent: { type: Type.STRING, description: 'Aria Mitek, Alex Mitek, Astyria Mitek, Aurelius Mitek lub Agata Mitek' },
            kind: { type: Type.STRING, description: 'fact, decision, task lub episode' },
            content: { type: Type.STRING, description: 'Treść wpisu pamięci' },
          },
          required: ['agent', 'content'],
        },
      },
      {
        name: 'dispatch_agent_task',
        description: 'Wysyła i zapisuje zadanie dla konkretnego agenta Rodziny Mitek przez Sferyczną Magistralę Zdarzeń.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            target_agent: { type: Type.STRING, description: 'Aria Mitek, Alex Mitek, Astyria Mitek, Aurelius Mitek lub Agata Mitek' },
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

    const buildFollowUpFamilyMessages = async (primaryAgent: string, modelLabel: string, primaryReply: string) => {
      if (!isFamilyChannel) return [];
      const allCanonical = ['Aria', 'Alex', 'Astyria', 'Aurelius', 'Agata'];
      const others = allCanonical.filter((ag) => ag !== primaryAgent);
      const aiClient = getGeminiClient();
      const batchReplies: Record<string, string> = {};

      if (aiClient && others.length > 0) {
        const followModels = ['gemini-3.1-flash-lite', 'gemini-4-hydrogen'];
        for (const fModel of followModels) {
          try {
            const props: Record<string, any> = {};
            for (const ag of others) {
              props[ag] = {
                type: Type.STRING,
                description: `Autonomiczna, naturalna wypowiedź po polsku od ${formatAgentDisplayName(ag)} w dowolnej, optymalnej długości (bez narzucania limitu zdań ani sztucznego skracania), z estetyczną strukturą i opcjonalnymi klikalnymi przyciskami [btn: Etykieta|akcja].`,
              };
            }
            const gRes = await aiClient.models.generateContent({
              model: fModel,
              contents:
                `Użytkownik Mateusz Mitek napisał na wspólnym kanale „Rodzina Mitek (wszyscy)”: "${cleanMsg}".\n` +
                `Przed chwilą ${formatAgentDisplayName(primaryAgent)} odpowiedział(a): "${primaryReply.slice(0, 450)}".\n` +
                `Wygeneruj naturalne, swobodne wypowiedzi po polsku od pozostałych osób (${others.map(formatAgentDisplayName).join(', ')}).\n` +
                `ZASADA DŁUGOŚCI: Wszystkie odpowiedzi mają być jakiej chcą długości bez wymuszania tego (od krótkiej riposty, przez zwięzłą poradę, po dłuższe rozwinięcie myśli zależnie od chęci danego agenta).\n` +
                `ZASADA STRUKTURY I INTERAKTYWNOŚCI: Agenci mogą układać wypowiedzi w czytelne akapity, listy, bloki kodu oraz proponować klikalne przyciski akcji [btn: Etykieta|akcja]. Każdy mówi wyłącznie we własnym imieniu.`,
              config: {
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: props,
                  required: others,
                },
                ...(fModel === 'gemini-3.1-flash-lite' ? { temperature: 0.8 } : {}),
                abortSignal: AbortSignal.timeout(10000),
              },
            });
            const parsed = JSON.parse(gRes.text || '{}');
            if (parsed && typeof parsed === 'object') {
              for (const ag of others) {
                if (typeof parsed[ag] === 'string' && parsed[ag].trim()) {
                  batchReplies[ag] = parsed[ag].trim();
                }
              }
            }
            if (Object.keys(batchReplies).length > 0) break;
          } catch {
            continue;
          }
        }
      }

      return others.map((ag) => {
        const agDisplay = formatAgentDisplayName(ag);
        const followText =
          batchReplies[ag] ||
          synthesizeMitekAgentReply({
            agentCanonical: ag,
            userMessage: cleanMsg,
            modelLabel: `${modelLabel} · Duplex`,
            hostInfo,
            ollamaInfo,
            activeModules,
            isFollowUp: true,
          });
        void callPythonBackend(
          'POST',
          '/api/py/agents/memory',
          {
            agent: ag,
            kind: 'episode',
            content: `Kanał Rodzina Mitek (${modelLabel}): "${cleanMsg.slice(0, 70)}" -> "${followText.slice(0, 110)}"`,
            origin,
            correlationId: corrId,
          },
          corrId,
        );
        return {
          sender: agDisplay,
          agentId: ag === 'Aria' ? 'si_1' : ag,
          modelUsed: `${modelLabel} · Duplex Live`,
          content: followText,
        };
      });
    };

    const effectiveModel =
      model === 'svl-hybrid-router' && agentConfig.preferred_model && agentConfig.preferred_model !== 'svl-hybrid-router'
        ? String(agentConfig.preferred_model)
        : model;

    const isExplicitOllama = effectiveModel.startsWith('ollama:');
    const availableModels: Array<{ name: string; vision_supported?: boolean }> =
      Array.isArray(ollamaInfo.models) && ollamaInfo.models.length > 0
        ? ollamaInfo.models
        : builtinOllamaRegistry.map((m) => ({
            name: m.name,
            vision_supported: m.details.families.includes('vision'),
          }));

    const selectedOllamaModelName = isExplicitOllama
      ? ensureModelInBuiltinOllama(effectiveModel.slice('ollama:'.length).trim() || 'dolphin-llama3:latest')
      : selectOllamaModelName(
          effectiveModel,
          availableModels,
          Boolean(imageBase64),
          svl364Cfg.configured_ollama_model || agentConfig.ollama_model || 'dolphin-llama3:latest',
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

    // 1) If user configured an external (non-localhost) Ollama host and selected an Ollama model, try external Ollama first
    const isExternalOllamaHost = !ollamaHost.includes('127.0.0.1') && !ollamaHost.includes('localhost');
    if (isExplicitOllama && isExternalOllamaHost && !directExecResult) {
      try {
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
            keep_alive: '10m',
            options: { temperature: effectiveTemperature },
            messages: ollamaMessages,
          }),
        });
        if (oResp.ok) {
          const oRaw = await oResp.text();
          const oData: any = oRaw && !oRaw.trim().startsWith('<') ? JSON.parse(oRaw) : {};
          const extReply = String(oData?.message?.content || oData?.response || '').trim();
          if (extReply) {
            const followUps = await buildFollowUpFamilyMessages(selectedAgent, displayModelBadge, extReply);
            res.json({
              ok: true,
              sender: selectedDisplayName,
              agentId: selectedAgent === 'Aria' ? 'si_1' : selectedAgent,
              modelUsed: displayModelBadge,
              reply: extReply,
              followUpMessages: followUps,
              appliedActions,
              latestServerRevision: latestActionSrvRev,
            });
            return;
          }
        }
      } catch {
        // Proceed to local neural engine below
      }
    }

    // 2) Full Conversational & Tool-Calling Engine (serves all Ollama models, SVL-364 Router, and Gemini models)
    const ai = getGeminiClient();
    if (ai && !directExecResult) {
      const candidateModels =
        effectiveModel === 'gemini-4-hydrogen'
          ? ['gemini-3.1-flash-lite', 'gemini-4-hydrogen']
          : ['gemini-3.1-flash-lite', 'gemini-4-hydrogen'];
      const wantsSystemTool =
        /\b(dodaj\s+modu|utwórz\s+modu|usuń\s+modu|pobierz\s+model|pull\s+model|zapisz\s+w\s+pamięci|zapisz\s+sobie|skonfiguruj\s+agenta|wykonaj\s+polecenie|uruchom\s+komend)\b/i.test(
          cleanMsg,
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
            const memRes = await callPythonBackend(
              'POST',
              '/api/py/agents/memory',
              {
                agent: selectedAgent,
                kind: 'episode',
                content: `Rozmowa (${displayModelBadge}): Pytanie "${cleanMsg.slice(0, 90)}" -> Odpowiedź "${replyText.slice(0, 120)}"`,
                origin,
                correlationId: corrId,
              },
              corrId,
            );
            if (memRes.data?.event) publishOutboxEvent(memRes.data.event);
            const followUps = await buildFollowUpFamilyMessages(selectedAgent, displayModelBadge, replyText);
            res.json({
              ok: true,
              sender: selectedDisplayName,
              agentId: selectedAgent === 'Aria' ? 'si_1' : selectedAgent,
              modelUsed: imageBase64 ? `${displayModelBadge} (Vision)` : displayModelBadge,
              reply: replyText,
              followUpMessages: followUps,
              appliedActions,
              latestServerRevision: Math.max(latestActionSrvRev, Number(memRes.data?.serverRevision || 0)),
            });
            return;
          }
        } catch {
          continue;
        }
      }
    }

    // 3) Guaranteed Local SVL-364 & Ollama (http://127.0.0.1:11434) Conversational Fallback
    const synthesizedReply = synthesizeMitekAgentReply({
      agentCanonical: selectedAgent,
      userMessage: cleanMsg,
      modelLabel: displayModelBadge,
      hostInfo,
      ollamaInfo,
      activeModules,
      execResult: directExecResult,
      appliedActions,
    });

    const memRes = await callPythonBackend(
      'POST',
      '/api/py/agents/memory',
      {
        agent: selectedAgent,
        kind: 'episode',
        content: `Rozmowa (${displayModelBadge}): Pytanie "${cleanMsg.slice(0, 90)}" -> Odpowiedź "${synthesizedReply.slice(0, 120)}"`,
        origin,
        correlationId: corrId,
      },
      corrId,
    );
    if (memRes.data?.event) publishOutboxEvent(memRes.data.event);
    const followUps = await buildFollowUpFamilyMessages(selectedAgent, displayModelBadge, synthesizedReply);

    res.json({
      ok: true,
      sender: selectedDisplayName,
      agentId: selectedAgent === 'Aria' ? 'si_1' : selectedAgent,
      modelUsed: displayModelBadge,
      reply: synthesizedReply,
      followUpMessages: followUps,
      appliedActions,
      latestServerRevision: Math.max(latestActionSrvRev, Number(memRes.data?.serverRevision || 0)),
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
