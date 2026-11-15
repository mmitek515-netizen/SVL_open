/**
 * No fixed IP and no paid API key: Codex CLI executes in the SAME runtime as the
 * SVL gateway using a ChatGPT OAuth login already present in CODEX_HOME.
 *
 * IMPORTANT: this feature is disabled unless BOTH the admin opt-in and a
 * separate, private operator access token are configured. Never expose an
 * authenticated ChatGPT session through an unauthenticated public preview.
 */
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_PROMPT_BYTES = 11_000;
const CHAT_TIMEOUT_MS = 140_000;
let running = false;
let lastProbe: { expires: number; loggedIn: boolean; reason: string } | null = null;

type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };

function codexEnv(): NodeJS.ProcessEnv {
  // Deliberate environment allowlist. No application keys, database paths,
  // operator tokens, local MCP settings or secret env may reach the CLI subprocess.
  const keys = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SHELL',
    'TERM', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'CODEX_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function runCodex(
  args: string[], stdin: string, timeoutMs: number, cwd: string, sharedAgentLock = false,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    const complete = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, truncated });
    };
    try {
      // util-linux flock --no-fork uses the same advisory lock as Python
      // fcntl.flock() in the five agent worker processes.
      const lockPath = path.join(os.tmpdir(),
        'svl-codex-oauth-worker-' + String(typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid) + '.lock');
      const binary = sharedAgentLock ? 'flock' : 'codex';
      const commandArgs = sharedAgentLock
        ? ['--no-fork', '--exclusive', '--wait', '15', '--conflict-exit-code', '75', lockPath, 'codex', ...args]
        : args;
      child = spawn(binary, commandArgs, {
        cwd,
        shell: false,
        env: codexEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve({code: 127, stdout: '', stderr: '', timedOut: false, truncated: false});
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      complete(124);
    }, timeoutMs);
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    const childStdin = child.stdin;
    if (!childStdout || !childStderr || !childStdin) {
      child.kill('SIGKILL');
      complete(127);
      return;
    }
    const consume = (buf: Buffer, stream: 'stdout' | 'stderr') => {
      bytes += buf.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        child.kill('SIGKILL');
        complete(125);
        return;
      }
      if (stream === 'stdout') stdout += buf.toString('utf8');
      else stderr += buf.toString('utf8');
    };
    childStdout.on('data', (b: Buffer) => consume(b, 'stdout'));
    childStderr.on('data', (b: Buffer) => consume(b, 'stderr'));
    child.on('error', () => complete(127));
    child.on('close', code => complete(code ?? 1));
    childStdin.on('error', () => {});
    childStdin.end(stdin);
  });
}

function enabled(): boolean {
  return process.env.SVL_CODEX_CHAT_ENABLED === 'true';
}

function configured(): boolean {
  return (process.env.SVL_CODEX_CHAT_ACCESS_TOKEN || '').length >= 32;
}

export function codexChatAccessAllowed(value: unknown): boolean {
  if (!enabled() || !configured() || typeof value !== 'string') return false;
  const supplied = Buffer.from(value, 'utf8');
  const expected = Buffer.from(process.env.SVL_CODEX_CHAT_ACCESS_TOKEN || '', 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function codexChatConfiguration() {
  return {
    enabled: enabled(),
    accessConfigured: configured(),
    provider: 'Codex CLI / ChatGPT OAuth',
    runtime: 'same Linux process host (no IP, no MCP HTTP URL, no OpenAI API key)',
    cliStatus: lastProbe && lastProbe.expires > Date.now()
      ? (lastProbe.loggedIn ? 'chatgpt_oauth' : 'unavailable')
      : 'unchecked',
  };
}

export async function probeCodexCli(cwd: string, force = false): Promise<{loggedIn:boolean;reason:string}> {
  if (!enabled()) return {loggedIn: false, reason: 'Codex chat disabled'};
  if (!configured()) return {loggedIn: false, reason: 'Operator access protection not configured'};
  if (!force && lastProbe && lastProbe.expires > Date.now()) {
    return {loggedIn: lastProbe.loggedIn, reason: lastProbe.reason};
  }
  const result = await runCodex(['login', 'status'], '', 6500, cwd);
  const loggedIn = result.code === 0 &&
    /logged in (?:using|with) chatgpt\b/i.test(result.stdout + '\n' + result.stderr);
  const reason = loggedIn ? 'ChatGPT OAuth active for gateway runtime account'
    : 'Codex CLI missing or not logged into ChatGPT in this runtime/CODEX_HOME';
  lastProbe = {expires: Date.now() + 25000, loggedIn, reason};
  return {loggedIn, reason};
}

function finalAgentReply(stdout: string): string {
  let reply = '';
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'item.completed' && event?.item?.type === 'agent_message') {
        reply = String(event.item.text || '');
      }
    } catch {
      // The CLI emits JSONL events; never treat diagnostics as an agent reply.
    }
  }
  return reply.trim().slice(0, 24000);
}

export async function generateCodexCliChat(
  input: {agentName:string;message:string;history:Array<{role:string;content:string}>},
  cwd: string,
): Promise<{ok:boolean;reply?:string;error?:string;busy?:boolean}> {
  if (!enabled()) return {ok:false,error:'Codex CLI chat is disabled on the gateway'};
  if (!configured()) return {ok:false,error:'Codex CLI requires private operator access protection'};
  if (running) return {ok:false,busy:true,error:'Codex CLI is already answering another message'};
  running = true;
  try {
    const probe = await probeCodexCli(cwd, true);
    if (!probe.loggedIn) return {ok:false,error:probe.reason};
    const history = (input.history || []).slice(-8).map(turn =>
      (turn.role === 'assistant' ? 'AI: ' : 'Operator: ') + String(turn.content || '').slice(0,450),
    );
    const prompt = [
      'Jesteś ' + String(input.agentName || 'SVL Agent').slice(0,80) + ' w czacie SVL Python OS.',
      'Odpowiadaj naturalnie po polsku jako dany agent. To jest rozmowa, nie zadanie wykonawcze.',
      'Nie wykonuj poleceń powłoki, nie zmieniaj plików. Nie ujawniaj plików konfiguracyjnych, sekretów ani danych uwierzytelniających.',
      'Nie deklaruj wykonania misji lub czynności bez potwierdzonego wyniku narzędzia.',
      'Kontekst rozmowy:',
      ...history,
      'Operator: ' + String(input.message || '').slice(0,4000),
    ].join('\n').slice(0,MAX_PROMPT_BYTES);
    // Keep the conversation outside SVL_open's source directory. Read-only
    // Codex must not read the application's checked-out code by default.
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'svl-codex-chat-'));
    try {
      const run = await runCodex(
        ['exec', '--ignore-user-config', '--ignore-rules',
         '--skip-git-repo-check', '--ephemeral', '--json',
         '--sandbox', 'read-only', '-'],
        prompt,
        CHAT_TIMEOUT_MS,
        isolatedRoot,
        true,
      );
      if (run.timedOut) return {ok:false,error:'Codex CLI exceeded its response timeout'};
      if (run.truncated) return {ok:false,error:'Codex CLI produced too much output'};
      if (run.code === 75) {
        return {ok:false,busy:true,error:'Codex CLI jest zajęty pracą innego agenta. Spróbuj później.'};
      }
      if (run.code !== 0) return {ok:false,error:'Codex CLI failed or the logged-in account reached its usage limit'};
      const reply = finalAgentReply(run.stdout);
      return reply ? {ok:true,reply} : {ok:false,error:'Codex CLI returned no agent message'};
    } finally {
      await rm(isolatedRoot, {recursive: true, force: true});
    }
  } finally {
    running = false;
  }
}
