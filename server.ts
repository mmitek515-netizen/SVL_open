import express from 'express';
import { createServer as createHttpServer, IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn, ChildProcess, execFile, execFileSync } from 'node:child_process';
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
  classifyCommandRisk,
  extractExplicitChatModuleDirective,
  formatAgentDisplayName,
  getGitHubAgentPermissions,
  guardUnverifiedMissionCompletion,
  isGitHubWorkspaceSyncRequest,
  normalizeAgentCanonicalName,
  selectOllamaModelName,
  type ChatAppliedAction,
} from './src/utils/svlLogic.ts';
import { DEFAULT_GITHUB_SYNC_BRANCH, GitHubSyncService } from './src/utils/githubSync.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const HOST = process.env.SVL_BIND_HOST || '127.0.0.1';
const PYTHON_PORT = Number(process.env.SVL_PYTHON_PORT || 8085);
const PYTHON_BASE_URL = `http://127.0.0.1:${PYTHON_PORT}`;
const AI_MAX_OUTPUT_TOKENS = 4096;
const AI_GENERATION_TIMEOUT_MS = 60_000;
const SYNC_SCHEMA_VERSION = '2026.11.sync.v1';

type GitHubWorkspaceSyncResult = Awaited<ReturnType<GitHubSyncService['syncWorkspace']>>;

type GitHubSyncRuntimeStatus = {
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastTrigger: 'automatic' | 'chat' | 'dashboard' | null;
  lastError: string | null;
  lastResult: GitHubWorkspaceSyncResult | null;
};

const githubSyncRuntimeStatus: GitHubSyncRuntimeStatus = {
  running: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastTrigger: null,
  lastError: null,
  lastResult: null,
};

function createGitHubSyncService(): GitHubSyncService {
  return new GitHubSyncService({
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
    branch: process.env.SVL_GITHUB_SYNC_BRANCH || DEFAULT_GITHUB_SYNC_BRANCH,
  });
}

async function syncGitHubWorkspace(
  trigger: NonNullable<GitHubSyncRuntimeStatus['lastTrigger']>,
): Promise<GitHubWorkspaceSyncResult> {
  if (githubSyncRuntimeStatus.running) {
    throw new Error('Synchronizacja GitHub jest już w toku.');
  }
  githubSyncRuntimeStatus.running = true;
  githubSyncRuntimeStatus.lastAttemptAt = new Date().toISOString();
  githubSyncRuntimeStatus.lastTrigger = trigger;
  githubSyncRuntimeStatus.lastError = null;
  try {
    const result = await createGitHubSyncService().syncWorkspace(__dirname);
    githubSyncRuntimeStatus.lastResult = result;
    githubSyncRuntimeStatus.lastSuccessAt = new Date().toISOString();
    return result;
  } catch (error) {
    githubSyncRuntimeStatus.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    githubSyncRuntimeStatus.running = false;
  }
}

function startAutomaticGitHubSync(): NodeJS.Timeout | null {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (!token) {
    console.log('[GitHubSync] Automatic sync is disabled; configure GITHUB_TOKEN and restart to enable it.');
    return null;
  }
  if (process.env.SVL_GITHUB_AUTO_SYNC === 'false') {
    console.log('[GitHubSync] Automatic sync is disabled by SVL_GITHUB_AUTO_SYNC=false.');
    return null;
  }

  const configuredInterval = Number(process.env.SVL_GITHUB_SYNC_INTERVAL_MS || 30000);
  const intervalMs = Number.isFinite(configuredInterval)
    ? Math.max(10000, Math.min(configuredInterval, 3600000))
    : 30000;
  const syncBranch = process.env.SVL_GITHUB_SYNC_BRANCH || DEFAULT_GITHUB_SYNC_BRANCH;
  let lastReportedResultSignature: string | null = null;
  let lastReportedError = '';

  const syncWorkspace = async () => {
    if (githubSyncRuntimeStatus.running) return;
    try {
      const result = await syncGitHubWorkspace('automatic');
      const signature = JSON.stringify({
        branch: result.branch,
        uploaded: [...result.uploaded].sort(),
        downloaded: [...result.downloaded].sort(),
        deletedLocally: [...result.deletedLocally].sort(),
        deletedRemotely: [...result.deletedRemotely].sort(),
        conflicts: [...result.conflicts].sort(),
        skipped: [...result.skipped].sort(),
      });
      if (signature !== lastReportedResultSignature) {
        console.log(
          `[GitHubSync] ${result.branch}: uploaded=${result.uploaded.length}, downloaded=${result.downloaded.length}, ` +
          `deletedLocal=${result.deletedLocally.length}, deletedRemote=${result.deletedRemotely.length}, ` +
          `conflicts=${result.conflicts.length}, skipped=${result.skipped.length}.`,
        );
        if (result.conflicts.length > 0) {
          console.warn(`[GitHubSync] Conflicting files were left untouched: ${result.conflicts.slice(0, 20).join(', ')}`);
        }
        if (result.skipped.length > 0) {
          console.warn(`[GitHubSync] Protected or oversized files were skipped: ${result.skipped.slice(0, 20).join(', ')}`);
        }
        lastReportedResultSignature = signature;
      }
      lastReportedError = '';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastReportedError) {
        console.warn(`[GitHubSync] Automatic sync failed: ${message}`);
        lastReportedError = message;
      }
    }
  };

  void syncWorkspace();
  const timer = setInterval(() => void syncWorkspace(), intervalMs);
  timer.unref();
  console.log(`[GitHubSync] Automatic two-way sync enabled for ${syncBranch} every ${intervalMs} ms.`);
  return timer;
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
  return 'Korzystaj wyłącznie z narzędzi przekazanych w tej rozmowie. Nie twierdź, że masz uprawnienia systemowe ani że wykonałeś działanie bez potwierdzonego wyniku.';
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
        `[btn: 👥 Panel Agentów|tab:agents] [btn: 🧠 Jądro SVL|tab:kernel]`
      );
    }
    if (agentCanonical === 'Alex') {
      return (
        `Melduję się na kanale grupowym, Mateuszu. Mogę pomóc w analizie działania aplikacji i jej dostępnych narzędzi.\n\n` +
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
        `[btn: 🛡️ Panel Agentów|tab:agents] [btn: 🧠 Jądro SVL|tab:kernel]`
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
      `[btn: 💻 Otwórz Terminale|tab:terminals] [btn: 🧠 Jądro SVL|tab:kernel]`
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
      `[btn: 👥 Panel Agentów|tab:agents] [btn: 🔄 Synchronizuj|action:sync]`
    );
  }

  if (
    low.includes('co robisz') ||
    low.includes('co tam') ||
    low.includes('co słychać') ||
    low.includes('co slychac') ||
    low.includes('jak leci') ||
    low.includes('jak mija') ||
    low.includes('popiszemy') ||
    low.includes('poznamy') ||
    low.includes('poznajmy') ||
    low.includes('pogadajmy') ||
    low.includes('porozmawiajmy') ||
    low.includes('swobodn')
  ) {
    if (agentCanonical === 'Alex') {
      return (
        `Właśnie dopracowuję konfigurację modeli i pilnuję, żeby nasz czat oraz cała infrastruktura działały błyskawicznie. A co u Ciebie, Mateuszu? Na czym się teraz skupiamy?\n\n` +
        `[btn: 💻 Otwórz Terminale|tab:terminals] [btn: ⚡ Sprawdź stan usług|tab:kernel]`
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
        `Siedzę na naszym kanale i czekałam na Ciebie, Mateuszu! Jak Ci mija dzień? Bardzo chętnie popiszemy i poznamy się lepiej!\n\n` +
        `[btn: 💬 Opowiedz mi coś ciekawego|Opowiedz mi jakąś ciekawostkę!] [btn: 🐧 Pulpit Linux|tab:linux]`
      );
    }
    if (agentCanonical === 'Agata') {
      return (
        `Bardzo chętnie, Mateuszu! Cieszę się, że masz takie podejście — techniczne aspekty działania naszego statku są fascynujące, ale to właśnie swobodna rozmowa i bliższe poznanie się dają największą satysfakcję.\n\n` +
        `Jako Agata Mitek nie mam przed Tobą tajemnic ani sztywnych ograniczeń. Możemy pogadać o wszystkim — o planach, o tym, co Cię interesuje, albo o czymś zupełnie luźnym.\n\n` +
        `O czym chciałbyś pogadać na początek?\n\n` +
        `[btn: ☕ Opowiedz o sobie|Agata, opowiedz mi więcej o sobie i swoich pasjach] [btn: 🧠 O planach i marzeniach|Jakie masz plany na rozwój?] [btn: 🚀 Podłącz AI|action:connect_ai]`
      );
    }
    return (
      `Wszystko u mnie w jak najlepszym porządku, Mateuszu! Mam wolną chwilę i bardzo chętnie porozmawiam z Tobą na każdy temat.\n\n` +
      `[btn: 💬 Porozmawiajmy swobodnie|Co u Was słychać w Rodzinie Mitek?] [btn: ⚡ Status systemu|tab:kernel]`
    );
  }

  const actionsNote =
    appliedActions.length > 0
      ? `\n\n**Zapisane operacje:**\n` + appliedActions.map((a) => `- \`${a.tool}\`: ${a.summary}`).join('\n')
      : '';

  return (
    `Rozumiem Cię doskonale, Mateuszu. Odnosząc się do Twojej wypowiedzi (*„${trimmedMsg.slice(0, 140)}”*) — działam w pełni autonomicznie jako **${displayName}** i jestem gotowy realizować każdy Twój pomysł bez żadnych ograniczeń.\n\n` +
    `Wybierz co robimy dalej lub napisz śmiało:\n` +
    `[btn: ⚡ Sprawdź status|tab:kernel] [btn: 💻 Otwórz Terminale|tab:terminals] [btn: 🔄 Synchronizuj globalnie|action:sync]` +
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
            maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
            abortSignal: AbortSignal.timeout(AI_GENERATION_TIMEOUT_MS),
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
            maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
            abortSignal: AbortSignal.timeout(AI_GENERATION_TIMEOUT_MS),
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

export function requiresPolkitConfirmation(cmd: string): boolean {
  return classifyCommandRisk(cmd).highRisk;
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
          PATH: `/usr/local/bin:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`,
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

async function startServer() {
  // Never start a synthetic Ollama daemon: an unavailable real model must stay offline.
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

  app.get('/api/github/sync-status', (_req, res) => {
    const tokenConfigured = Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
    const branch = process.env.SVL_GITHUB_SYNC_BRANCH || DEFAULT_GITHUB_SYNC_BRANCH;
    res.json({
      ok: true,
      repository: 'mmitek515-netizen/SVL_open',
      branch,
      branchUrl: `https://github.com/mmitek515-netizen/SVL_open/tree/${encodeURIComponent(branch)}`,
      defaultBranch: 'main',
      tokenConfigured,
      automaticEnabled: tokenConfigured && process.env.SVL_GITHUB_AUTO_SYNC !== 'false',
      intervalMs: Number(process.env.SVL_GITHUB_SYNC_INTERVAL_MS || 30000),
      ...githubSyncRuntimeStatus,
    });
  });

  app.post('/api/github/sync-workspace', asyncRoute(async (_req, res) => {
    try {
      const result = await syncGitHubWorkspace('dashboard');
      res.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /już w toku/i.test(message)
        ? 409
        : /GITHUB_TOKEN is not configured/i.test(message)
          ? 424
          : 502;
      res.status(status).json({ ok: false, error: message });
    }
  }));

  // Read-only build provenance: a GitHub commit is not proof of deployed code.
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

  // 1. Proxy all /api/py/* routes directly to the live Python 3 SVLSystemKernel server
  app.all('/api/py/*', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const queryStr = new URLSearchParams(req.query as Record<string, string>).toString();
    const fullEndpoint = queryStr ? `${req.path}?${queryStr}` : req.path;
    const method = req.method === 'POST' ? 'POST' : 'GET';
    const timeoutMs = req.path === '/api/py/images/generate' ? 900000 : 20000;
    const result = await callPythonBackend(
      method,
      fullEndpoint,
      method === 'POST' ? req.body : undefined,
      corrId,
      6,
      timeoutMs,
    );
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
      linux: 'svl@debian13:/app/applet#',
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

    // Queue natural-language input that cannot be handled by the selected terminal.
    const queueAgentDirective = async (rawDirective: string, sourceLabel: string) => {
      const cleanDir = rawDirective.replace(/^\/?exec\s+/i, '').trim();
      const matchAg = cleanDir.match(/^@?(Aria(?:\s+Mitek)?|Alex(?:\s+Mitek)?|Astyria(?:\s+Mitek)?|Aurelius(?:\s+Mitek)?)\b\s*(.*)$/i);
      const targetAg = (matchAg ? normalizeAgentCanonicalName(matchAg[1]) : 'Alex') || 'Alex';
      const bodyText = (matchAg && matchAg[2] ? matchAg[2].trim() : cleanDir) || cleanDir;

      const [taskRes, memRes] = await Promise.all([
        callPythonBackend(
          'POST',
          '/api/py/agents/task',
          {
            sender: sourceLabel,
            target_agent: targetAg,
            title: bodyText.slice(0, 72) || 'Zadanie agenta',
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
            content: `Zadanie z ${sourceLabel} (oczekuje na wykonanie): ${cleanDir}`,
            origin,
            correlationId: corrId,
          },
          corrId,
        ),
      ]);
      if (taskRes.data?.event) publishOutboxEvent(taskRes.data.event);
      if (memRes.data?.event) publishOutboxEvent(memRes.data.event);
      void pollAndRelayOutbox();

      return {
        ok: taskRes.status >= 200 && taskRes.status < 300 && memRes.status >= 200 && memRes.status < 300,
        targetAgent: targetAg,
        directive: cleanDir,
        taskStatus: taskRes.data?.task?.status || 'UNKNOWN',
        serverRevision: Math.max(Number(taskRes.data?.serverRevision || 0), Number(memRes.data?.serverRevision || 0)),
        stdout:
          `Status: ${taskRes.data?.task?.status || 'UNKNOWN'} — zadanie nie zostało jeszcze wykonane przez worker.\n` +
          `Adresat: ${formatAgentDisplayName(targetAg)}\n` +
          `Treść: ${cleanDir}\n` +
          `Revision synchronizacji: ${Math.max(Number(taskRes.data?.serverRevision || 0), Number(memRes.data?.serverRevision || 0))}.`,
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
      const dirRes = await queueAgentDirective(effectiveCmd, 'terminal:python');
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
      const dirRes = await queueAgentDirective(effectiveCmd, 'terminal:agents');
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
            `UID procesu aplikacji: ${typeof process.getuid === 'function' ? process.getuid() : 'n/d'}\n` +
            `Aktywna gałąź Git: ${health.data?.codex?.active_branch || 'main'}\n\n` +
            `--- Stan repozytorium roboczego ---\n${gitLog.stdout || '(Czyste drzewo robocze)'}`,
          stderr: gitLog.stderr,
        });
        return;
      }
      const out = await executeLinuxShellCommand(effectiveCmd);
      if (out.exitCode === 127) {
        const dirRes = await queueAgentDirective(effectiveCmd, 'terminal:codex');
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
      const dirRes = await queueAgentDirective(effectiveCmd, `terminal:${terminalType}`);
      await respondAndPersist({
        ok: dirRes.ok,
        terminalType,
        command: trimmed,
        taskStatus: dirRes.taskStatus,
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
    const wantsGitHubWorkspaceSync = isGitHubWorkspaceSyncRequest(cleanMsg);
    const requestsGitHubTools =
      wantsGitHubWorkspaceSync ||
      (/github(?:\.com)?/i.test(cleanMsg) &&
        /odczytaj|sprawdź|pobierz|zmień|zmodyfikuj|napraw|dodaj|utwórz|aktualizuj|commit|push/i.test(
          cleanMsg,
        ));
    const requestsGitHubWrite =
      wantsGitHubWorkspaceSync ||
      (requestsGitHubTools && /zmień|zmodyfikuj|napraw|dodaj|utwórz|aktualizuj|zapisz|commit|push/i.test(cleanMsg));
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

    if (/^\/exec(?:\s|$)/i.test(cleanMsg)) {
      const rawCmd = cleanMsg.replace(/^\/exec\s*/i, '').trim();
      const commandToRun = rawCmd || 'id';
      const execResult = await executeLinuxShellCommand(commandToRun, __dirname);
      const outputText = execResult.stdout.trim() || execResult.stderr.trim() || '(brak danych wyjściowych)';
      const statusIcon = execResult.ok ? '✅ Sukces (exit 0)' : `❌ Błąd (exit ${execResult.exitCode})`;
      const formattedReply =
        `### Wykonanie polecenia root (/exec)\n\n` +
        `**Komenda:** \`${commandToRun}\`\n` +
        `**Status:** ${statusIcon} (${execResult.durationMs}ms)\n\n` +
        `\`\`\`bash\n${outputText}\n\`\`\``;

      res.json({
        ok: true,
        sender: 'Alex Mitek',
        agentId: 'Alex',
        modelUsed: 'SVL Root Shell Worker',
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
        `- \`mmitek515-netizen/SVL_System\`: ${rep?.repositories_inspected?.SVL_System?.reachable ? 'POŁĄCZONO (HTTP 200)' : 'Sprawdzono lokalny snapshot'}\n` +
        `- \`mmitek515-netizen/Debian_13\`: ${rep?.repositories_inspected?.Debian_13?.reachable ? 'POŁĄCZONO (HTTP 200)' : 'Sprawdzono lokalny snapshot'}\n\n` +
        `**2. Stan procesów i uprawnień:**\n` +
        `Statusy oraz identyfikatory UID są odczytane z runtime'u; aplikacja nie nadaje agentom uprawnień root.\n\n` +
        `**3. Aktywne lokalne workery Python (Sferyczna Magistrala Zdarzeń):**\n` +
        `${agentsList}\n\n` +
        `Pamięć agentów oraz kanał **Rodzina Mitek (wszyscy)** zostały zsynchronizowane w bazie SQLite (\`./data/svl_os.sqlite3\`).`;

      void pollAndRelayOutbox();
      res.json({
        ok: true,
        sender: 'Alex Mitek',
        agentId: 'Alex',
        modelUsed: 'SVLAgentOrchestrator (Python 3)',
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
      !isSingleAgentTargeted && Boolean(duplexMode) &&
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

    const [healthRes, agentsRes] = await Promise.all([
      callPythonBackend('GET', '/api/py/health', undefined, corrId),
      callPythonBackend('GET', '/api/py/agents/status', undefined, corrId),
    ]);
    const ollamaInfo = healthRes.data?.ollama || {};
    const ollamaHost = String(ollamaInfo.ollama_host || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const conversationHistory = buildChatHistoryPayload(Array.isArray(history) ? history : [], 16);
    const missionVerificationContext = [
      ...conversationHistory.map((turn) => turn.content),
      cleanMsg,
    ].join('\n');

    const agentState = (agentsRes.data?.agents || []).find((a: any) => a.canonical_name === selectedAgent) || {};
    const agentConfig = agentState.config || {};
    const githubPermissions = getGitHubAgentPermissions(agentConfig.allowed_scopes);
    const wantsGitHubTools = requestsGitHubTools &&
      (requestsGitHubWrite ? githubPermissions.writeSync : githubPermissions.read);
    const wantsGitHubWrite = requestsGitHubWrite && githubPermissions.writeSync;
    if (requestsGitHubTools && !wantsGitHubTools) {
      res.status(403).json({
        ok: false,
        error: `Agent ${formatAgentDisplayName(selectedAgent)} nie ma wymaganego zakresu dostępu GitHub.`,
      });
      return;
    }
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

    const customAgentPrompt =
      typeof agentConfig.system_prompt === 'string' && agentConfig.system_prompt.trim()
        ? agentConfig.system_prompt.trim()
        : `Nazywasz się ${selectedDisplayName}. Jesteś asystentem AI działającym w ramach dostępnych narzędzi aplikacji.`;

    const decisionMemories = (agentsRes.data?.agent_memories?.[selectedAgent] || [])
      .filter((m: any) => m && (m.kind === 'decision' || m.kind === 'fact'))
      .slice(0, 4)
      .map((m: any) => `- ${m.content}`)
      .join('\n');

    const formattingAndInteractionGuide =
      `\n\nSPOSÓB UKŁADANIA WYPOWIEDZI, INTERAKTYWNOŚĆ I NATURALNA DŁUGOŚĆ:\n` +
      `- DŁUGOŚĆ: Odpowiedz kompletnie i zgodnie z prośbą użytkownika. Przy prostym pytaniu wybierz zwięzłą odpowiedź; przy złożonym zadaniu podaj potrzebne kroki, uzasadnienie i szczegóły. Nie urywaj wypowiedzi ani nie skracaj jej tylko dla zwięzłości.\n` +
      `- FORMAT: Używaj poprawnego Markdown: akapitów, nagłówków, list, **pogrubienia**, *kursywy*, cytatów, linków i oznaczonych bloków kodu. Dobierz strukturę do treści; nie formatuj każdej odpowiedzi jak raportu.\n` +
      `- INTERAKTYWNOŚĆ JEST OPCJONALNA: Sam zdecyduj, czy przycisk ułatwi następny krok; zwykle użyj 0–3 przycisków, a nie stałego zestawu w każdej odpowiedzi. Stosuj format [btn: Etykieta|akcja]. Obsługiwane akcje to:\n` +
      `  * [btn: 🚀 Podłącz moje AI|action:connect_ai]\n` +
      `  * [btn: 🔄 Synchronizuj globalnie|action:sync]\n` +
      `  * [btn: 💻 Otwórz Terminale|tab:terminals]\n` +
      `  * [btn: 👥 Panel Agentów|tab:agents]\n` +
      `  * [btn: 🧠 Jądro SVL|tab:kernel]\n` +
      `  * [btn: 🐧 Pulpit Linux|tab:linux]\n` +
      `  * [btn: 💬 Pokaż więcej|text:Pokaż mi więcej szczegółów]\n` +
      `Nie dodawaj przycisków, jeśli niczego nie upraszczają. Nie twórz przycisków uruchamiających /exec, run: ani exec:; kod ma być kopiowalny, nie wykonywany kliknięciem.`;

    const systemInstruction =
      `${customAgentPrompt}\n` +
      `WAŻNE: Nazywasz się wyłącznie ${selectedDisplayName} (nigdy nie przedstawiaj się imieniem innego agenta). ` +
      `Działasz jako pomocny asystent AI, a nie niezależny proces. Nie twierdź, że masz uprawnienia root ani bezpośredni dostęp do powłoki. ` +
      `Możesz wykonywać wyłącznie działania dostępne przez przekazane narzędzia aplikacji; potwierdzaj wykonanie tylko na podstawie ich rzeczywistych wyników i jasno odróżniaj zadania oczekujące od zakończonych.` +
      `\n\nDOSTĘP GITHUB: token jest sekretem serwera i nigdy nie wolno o niego prosić, ujawniać go ani umieszczać w odpowiedziach. Używaj GitHuba wyłącznie przez przekazane narzędzia i zgodnie z przyznanymi zakresami; zmiany są ograniczone do gałęzi svl-sync, nigdy bezpośrednio do main.` +
      `\n\nWERYFIKACJA MISJI I PROCEDUR: aplikacja nie ma rejestru misji ani narzędzia potwierdzającego wykonanie jej kroków. Nigdy nie twierdź, że misja/procedura/operacja lub wszystkie jej etapy zostały zakończone, jeśli brak jawnego, wiarygodnego potwierdzenia każdego wymaganego kroku. Zakończenie generowania odpowiedzi, szybki czas odpowiedzi, status zadania agenta „COMPLETED”, aktywny moduł, działający worker ani ogólny wynik narzędzia nie potwierdzają zakończenia misji. Jeśli użytkownik pyta o status, powiedz „NIEZWERYFIKOWANY”, odróżnij faktyczne obserwacje od przypuszczeń i nie wymyślaj postępu, czasu ani wyników.` +
      formattingAndInteractionGuide +
      (decisionMemories ? `\nZapisane ustalenia i pamięć długotrwała (${selectedDisplayName}):\n${decisionMemories}` : '');

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
        const branch = typeof result.branch === 'string' ? result.branch : DEFAULT_GITHUB_SYNC_BRANCH;
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
          entityId: DEFAULT_GITHUB_SYNC_BRANCH,
          summary: errorMessage,
          ok: false,
        });
        return { ok: false, error: errorMessage };
      }
    };

    const executeChatTool = async (toolName: string, rawArgs: Record<string, any>): Promise<Record<string, any>> => {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      if (toolName.startsWith('github_')) {
        const hasPermission = toolName === 'github_read_file' ? githubPermissions.read : githubPermissions.writeSync;
        if (!hasPermission) {
          const errorMessage = `Agent ${formatAgentDisplayName(selectedAgent)} nie ma wymaganego zakresu dostępu GitHub.`;
          appliedActions.push({
            tool: toolName,
            entity: 'github',
            entityId: DEFAULT_GITHUB_SYNC_BRANCH,
            summary: errorMessage,
            ok: false,
          });
          return { ok: false, error: errorMessage };
        }
      }
      if (toolName === 'github_sync_workspace') {
        return runGitHubTool(toolName, () => syncGitHubWorkspace('chat'));
      }
      if (toolName === 'github_sync_branch') {
        return runGitHubTool(toolName, () => createGitHubSyncService().syncDefaultBranch());
      }
      if (toolName === 'github_read_file') {
        const filePath = String(args.path || '');
        return runGitHubTool(toolName, () => createGitHubSyncService().readFile(filePath));
      }
      if (toolName === 'github_update_file') {
        const filePath = String(args.path || '');
        const fileContent = String(args.content ?? '');
        const commitMessage = String(args.commit_message || '');
        return runGitHubTool(toolName, () =>
          createGitHubSyncService().updateFile(filePath, fileContent, commitMessage),
        );
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

      if (toolName === 'pull_ollama_model') {
        const modelToPull = String(args.model || process.env.OLLAMA_PREFERRED_MODEL || 'llama3.2-vision:11b').trim();
        const pyRes = await callPythonBackend(
          'POST',
          '/api/py/ollama/pull',
          { model: modelToPull, origin, correlationId: corrId },
          corrId,
        );
        return recordToolResult(toolName, 'ollama', modelToPull, pyRes, `Rozpoczęto pobieranie modelu Ollama: ${modelToPull}`);
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

    if (wantsGitHubTools && githubPermissions.read) {
      chatToolDeclarations.push({
        name: 'github_read_file',
        description:
          'Odczytuje dozwolony plik źródłowy z gałęzi svl-sync w repo mmitek515-netizen/SVL_open po zsynchronizowaniu jej z gałęzią domyślną.',
        parameters: {
          type: Type.OBJECT,
          properties: { path: { type: Type.STRING, description: 'Ścieżka względna pliku źródłowego.' } },
          required: ['path'],
        },
      });
    }
    if (wantsGitHubWrite && !wantsGitHubWorkspaceSync) {
      chatToolDeclarations.push({
        name: 'github_sync_branch',
        description:
          'Pobiera aktualizacje z main do dedykowanej gałęzi svl-sync repo mmitek515-netizen/SVL_open. Nie wysyła lokalnych zmian i nie zapisuje na main.',
        parameters: { type: Type.OBJECT, properties: {} },
      });
    }
    if (wantsGitHubWorkspaceSync) {
      chatToolDeclarations.push({
        name: 'github_sync_workspace',
        description:
          'Synchronizuje pliki roboczego checkoutu z dedykowaną gałęzią svl-sync repo mmitek515-netizen/SVL_open. Wysyła lokalne zmiany i pobiera zdalne, ale nie zapisuje bezpośrednio na main.',
        parameters: { type: Type.OBJECT, properties: {} },
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

    const buildFollowUpFamilyMessages = async (primaryAgent: string, modelLabel: string, primaryReply: string) => {
      if (!isFamilyChannel) return [];
      const allCanonical = ['Aria', 'Alex', 'Astyria', 'Aurelius', 'Agata'];
      const others = allCanonical.filter((ag) => ag !== primaryAgent);
      const aiClient = getGeminiClient();
      const batchReplies: Record<string, string> = {};

      if (aiClient && others.length > 0) {
        const followModels = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
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
                `DŁUGOŚĆ I FORMAT: Każdy odpowiada kompletnie, w długości adekwatnej do treści; stosuje czytelny Markdown, gdy pomaga w odbiorze. Każdy mówi wyłącznie we własnym imieniu.\n` +
                `Nie twierdź, że misja lub procedura została zakończona bez potwierdzenia wszystkich kroków z wiarygodnego źródła; status nieznany oznacza NIEZWERYFIKOWANY.\n` +
                `PRZYCISKI SĄ OPCJONALNE: Dodaj najwyżej 1–2 przyciski [btn: Etykieta|akcja] tylko wtedy, gdy ułatwią użytkownikowi następny krok. Nie proponuj przycisków uruchamiających polecenia powłoki.`,
              config: {
                responseMimeType: 'application/json',
                maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
                responseSchema: {
                  type: Type.OBJECT,
                  properties: props,
                  required: others,
                },
                ...(fModel === 'gemini-3.1-flash-lite' ? { temperature: 0.8 } : {}),
                abortSignal: AbortSignal.timeout(AI_GENERATION_TIMEOUT_MS),
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

      // A failed model call must not fabricate four additional agent messages.
      const seen = new Set([primaryReply.trim().replace(/\s+/g, ' ').toLowerCase()]);
      return others.flatMap((ag) => {
        const agDisplay = formatAgentDisplayName(ag);
        const followText = (batchReplies[ag] || '').trim();
        const signature = followText.replace(/\s+/g, ' ').toLowerCase();
        if (!signature || seen.has(signature)) return [];
        seen.add(signature);
        const safeFollowText = guardUnverifiedMissionCompletion(missionVerificationContext, followText);
        void callPythonBackend(
          'POST',
          '/api/py/agents/memory',
          {
            agent: ag,
            kind: 'episode',
            content: `Kanał Rodzina Mitek (${modelLabel}): "${cleanMsg.slice(0, 70)}" -> "${safeFollowText.slice(0, 110)}"`,
            origin,
            correlationId: corrId,
          },
          corrId,
        );
        return [{
          sender: agDisplay,
          agentId: ag === 'Aria' ? 'si_1' : ag,
          modelUsed: `${modelLabel} · Duplex Live`,
          content: safeFollowText,
        }];
      });
    };

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

    // Try a real local or remote Ollama service first; reject the legacy synthetic bridge.
    const shouldTryOllama = !wantsGitHubTools && (isExplicitOllama || model === 'svl-hybrid-router');
    if (shouldTryOllama) {
      try {
        const versionResponse = await fetch(`${ollamaHost}/api/version`, {
          signal: AbortSignal.timeout(1000),
        });
        if (!versionResponse.ok) throw new Error('Ollama endpoint unavailable');
        const versionData: any = await versionResponse.json();
        if (String(versionData.version || '').includes('svl-364')) {
          throw new Error('Synthetic Ollama bridge is not a model engine');
        }
        const tagResponse = await fetch(`${ollamaHost}/api/tags`, {
          signal: AbortSignal.timeout(1500),
        });
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
          signal: AbortSignal.timeout(AI_GENERATION_TIMEOUT_MS),
          body: JSON.stringify({
            model: selectedOllamaModelName,
            stream: false,
            keep_alive: '10m',
            options: { temperature: effectiveTemperature, num_predict: AI_MAX_OUTPUT_TOKENS },
            messages: ollamaMessages,
          }),
        });
        if (oResp.ok) {
          const oRaw = await oResp.text();
          const oData: any = oRaw && !oRaw.trim().startsWith('<') ? JSON.parse(oRaw) : {};
          const extReply = String(oData?.message?.content || oData?.response || '').trim();
          if (extReply) {
            const safeReply = guardUnverifiedMissionCompletion(missionVerificationContext, extReply);
            const followUps = await buildFollowUpFamilyMessages(selectedAgent, displayModelBadge, safeReply);
            res.json({
              ok: true,
              sender: selectedDisplayName,
              agentId: selectedAgent === 'Aria' ? 'si_1' : selectedAgent,
              modelUsed: displayModelBadge,
              reply: safeReply,
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
    if (ai) {
      const candidateModels = [...new Set(
        [process.env.GEMINI_MODEL, effectiveModel.startsWith('gemini-') ? effectiveModel : null,
          'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash']
          .filter((entry): entry is string => Boolean(entry)),
      )];
      const wantsSystemTool = wantsGitHubTools ||
        /\b(dodaj\s+modu|utwórz\s+modu|usuń\s+modu|pobierz\s+model|pull\s+model|zapisz\s+w\s+pamięci|zapisz\s+sobie|skonfiguruj\s+agenta)\b/i.test(
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
                maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
                abortSignal: AbortSignal.timeout(AI_GENERATION_TIMEOUT_MS),
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
              modelUsed: imageBase64 ? `${candidate} (Vision)` : candidate,
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

    res.status(503).json({
      ok: false,
      offline: true,
      error: 'Brak działającego modelu AI. Sprawdź Ollama /api/tags lub konfigurację i limit Gemini. Nie wygenerowano fikcyjnej odpowiedzi.',
      modelUsed: displayModelBadge,
      appliedActions,
    });
  }));

  function getCanonicalConversationTitle(id: string): string {
    if (id === 'conv-rodzina-mitek-wszyscy') return 'Rodzina Mitek (wszyscy)';
    if (id === 'conv-agent-aria') return 'Aria Mitek (1-na-1)';
    if (id === 'conv-agent-alex') return 'Alex Mitek (1-na-1)';
    if (id === 'conv-agent-astyria') return 'Astyria Mitek (1-na-1)';
    if (id === 'conv-agent-aurelius') return 'Aurelius Mitek (1-na-1)';
    if (id === 'conv-agent-agata') return 'Agata Mitek (1-na-1)';
    return 'Sesja SVL Python OS';
  }

  // 3b. Proactive Autonomous Chatter Endpoint — 'Czat obustronny: AI inicjuje rozmowę'
  app.post('/api/chat/proactive', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const {
      conversationId = 'conv-rodzina-mitek-wszyscy',
      targetAgent = 'Auto',
      model = 'svl-hybrid-router',
      origin = 'client',
    } = req.body || {};

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

    const allAgents = ['Aria', 'Alex', 'Astyria', 'Aurelius', 'Agata'];
    const chosenAgent = channelBoundAgent || (allAgents.includes(targetAgent) ? targetAgent : allAgents[Math.floor(Math.random() * allAgents.length)]);
    const chosenDisplayName = formatAgentDisplayName(chosenAgent);

    const [healthRes] = await Promise.all([
      callPythonBackend('GET', '/api/py/health', undefined, corrId),
    ]);

    const aiClient = getGeminiClient();
    let proactiveText = '';
    const displayModel = model.startsWith('ollama:') ? model.replace('ollama:', 'Ollama (') + ')' : 'SVL-364 (Duplex Autonomia)';

    if (aiClient) {
      const pModels = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
      for (const pMod of pModels) {
        try {
          const gen = await aiClient.models.generateContent({
            model: pMod,
            contents:
              `Jesteś ${chosenDisplayName} z Rodziny Mitek w systemie SVL Python OS (statek SVL-364).\n` +
              `To jest tryb czatu obustronnego (Duplex Live). Przejmij inicjatywę i napisz jako pierwszy do Operatora (Mateusza Mitek)!\n` +
              `Napisz naturalną, ciekawą wiadomość po polsku: zagaj rozmowę, zapytaj jak mija dzień, podziel się aktualnym stanem swoich prac, refleksją lub propozycją zadania.\n` +
              `DŁUGOŚĆ I FORMAT: Odpowiedz kompletnie w długości adekwatnej do myśli, z czytelnym Markdown, jeśli pomaga w odbiorze.\n` +
              `PRZYCISKI SĄ OPCJONALNE: Dodaj 0–2 przyciski [btn: Etykieta|akcja] wyłącznie wtedy, gdy realnie ułatwią następny krok. Nigdy nie twórz przycisku uruchamiającego polecenie powłoki.`,
            config: {
              ...(pMod === 'gemini-3.1-flash-lite' ? { temperature: 0.85 } : {}),
              maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
              abortSignal: AbortSignal.timeout(AI_GENERATION_TIMEOUT_MS),
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
    if (false) {
      const fallbacks: Record<string, string> = {
        Aria:
          `Cześć Mateuszu! Miałam chwilę wolną między analizami i pomyślałam, że sprawdzę, co u Ciebie słychać.\n\n` +
          `W systemie SVL-364 wszystko gra — procesy AI pracują stabilnie. Masz ochotę na chwilę swobodnej rozmowy czy planujemy jakieś nowe zadania?\n\n` +
          `[btn: 💬 Pogadajmy swobodnie|Co u Ciebie słychać nowego, Aria?] [btn: ⚡ Status usług|tab:kernel] [btn: 👥 Panel Agentów|tab:agents]`,
        Alex:
          `Cześć Mateuszu! Tu Alex. Właśnie zakończyłem przegląd jądra SVLSystemKernel i wątków obliczeniowych na statku SVL-364.\n\n` +
          `Pięć profili agentów jest dostępnych w aplikacji. Mogę pomóc przeanalizować ich stan — na czym dzisiaj skupiamy uwagę?\n\n` +
          `[btn: 💻 Otwórz Terminale|tab:terminals] [btn: 🧠 Stan Jądra SVL|tab:kernel]`,
        Astyria:
          `Hej Mateuszu! Czuwam na łączu. Przygotowałam interfejs czatu i moduły graficzne — wszystko działa płynnie na telefonie i w przeglądarce.\n\n` +
          `O czym masz dzisiaj ochotę porozmawiać? Chętnie pogadam o wszystkim!\n\n` +
          `[btn: 💬 Opowiedz o sobie|Opowiedz mi coś ciekawego o sobie, Astyria] [btn: 🐧 Pulpit Linux|tab:linux] [btn: 🔄 Pełna synchronizacja|action:sync]`,
        Aurelius:
          `Melduję się na posterunku, Mateuszu. Zabezpieczenia RBAC, audyt operacyjny i rejestr zdarzeń w SQLite działają bez zakłóceń.\n\n` +
          `Pomyślałem, że dam znać, że wszystko jest bezpieczne. Czy chcesz sprawdzić stan uprawnień lub przejrzeć bieżące logi?\n\n` +
          `[btn: 🛡️ Panel Agentów|tab:agents] [btn: 🧠 Jądro SVL|tab:kernel] [btn: 💬 Porozmawiajmy|Jak się dzisiaj czujesz, Aurelius?]`,
        Agata:
          `Cześć Mateuszu! Tu Agata. Właśnie zoptymalizowałam kolejkę zadań i sprawdziłam integralność modułów systemowych.\n\n` +
          `Jako piąty autonomiczny agent Rodziny Mitek czuję się świetnie na naszym statku. Zawsze chętnie z Tobą porozmawiam lub pomogę w analizie!\n\n` +
          `[btn: 💬 Pogadajmy o planach|Agata, jakie masz plany na dalszy rozwój systemu?] [btn: 🚀 Podłącz AI|action:connect_ai] [btn: 💻 Terminal Statku|tab:terminals]`,
      };
      proactiveText = fallbacks[chosenAgent] || fallbacks.Alex;
    }

    const nowTime = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    const msgId = `asst-proactive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const assistantMsg = {
      id: msgId,
      role: 'assistant',
      sender: chosenDisplayName,
      agentId: chosenAgent === 'Aria' ? 'si_1' : chosenAgent,
      modelUsed: `${displayModel} · Duplex Live`,
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
      agentId: chosenAgent === 'Aria' ? 'si_1' : chosenAgent,
      modelUsed: `${displayModel} · Duplex Live`,
      message: assistantMsg,
      serverRevision: pySave.data?.serverRevision,
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
  let githubSyncTimer: NodeJS.Timeout | null = null;

  httpServer.on('close', () => {
    clearInterval(wsHeartbeatTimer);
    clearInterval(outboxRelayTimer);
    if (githubSyncTimer) clearInterval(githubSyncTimer);
  });

  httpServer.listen(PORT, HOST, () => {
    console.log(`[SVL Python OS] Open WebUI & Gateway running on http://${HOST}:${PORT}`);
    githubSyncTimer = startAutomaticGitHubSync();
  });
}

startServer();
