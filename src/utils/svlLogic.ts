/**
 * Pure deterministic logic for SVL Python OS (Open WebUI Frontend & Verification Suite)
 * Mirrors the Python backend's TopologicalInfinityEngine, Polkit/sudo risk classifier,
 * and 'podłącz moje ai' command parser.
 */

export interface CanonicalAgentMeta {
  id: string;
  canonicalName: 'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata';
  displayName: 'Aria Mitek' | 'Alex Mitek' | 'Astyria Mitek' | 'Aurelius Mitek' | 'Agata Mitek';
  slug: string;
  preservedRole: string;
  sourceProfile: string;
  accentHex: string;
  borderClass: string;
  textClass: string;
}

export const CANONICAL_AGENTS: CanonicalAgentMeta[] = [
  {
    id: 'si_1',
    canonicalName: 'Aria',
    displayName: 'Aria Mitek',
    slug: 'aria',
    preservedRole: 'Integracje z modelami i usługami AI, lokalnym Ollama, MCP oraz API (Root NOPASSWD)',
    sourceProfile: '.github/agents/Aria.agent.md',
    accentHex: '#f43f5e',
    borderClass: 'border-rose-500/30',
    textClass: 'text-rose-400',
  },
  {
    id: 'Alex',
    canonicalName: 'Alex',
    displayName: 'Alex Mitek',
    slug: 'alex',
    preservedRole: 'Architektura systemu, backend, integracja usług i dowodzenie infrastrukturą (Root NOPASSWD)',
    sourceProfile: '.github/agents/Alex.agent.md',
    accentHex: '#10b981',
    borderClass: 'border-emerald-500/30',
    textClass: 'text-emerald-400',
  },
  {
    id: 'Astyria',
    canonicalName: 'Astyria',
    displayName: 'Astyria Mitek',
    slug: 'astyria',
    preservedRole: 'Interfejs webowy Open WebUI, czat obustronny, responsywność Android i analiza Vision (Root NOPASSWD)',
    sourceProfile: '.github/agents/Astyria.agent.md',
    accentHex: '#06b6d4',
    borderClass: 'border-cyan-500/30',
    textClass: 'text-cyan-400',
  },
  {
    id: 'Aurelius',
    canonicalName: 'Aurelius',
    displayName: 'Aurelius Mitek',
    slug: 'aurelius',
    preservedRole: 'Bezpieczeństwo RBAC, uprawnienia Root NOPASSWD, izolacja procesów i audyt (Root NOPASSWD)',
    sourceProfile: '.github/agents/Aurelius.agent.md',
    accentHex: '#f59e0b',
    borderClass: 'border-amber-500/30',
    textClass: 'text-amber-400',
  },
  {
    id: 'Agata',
    canonicalName: 'Agata',
    displayName: 'Agata Mitek',
    slug: 'agata',
    preservedRole: 'Optymalizacja kodu, testowanie i rozwój architektoniczny (Root NOPASSWD)',
    sourceProfile: '.github/agents/Agata.agent.md',
    accentHex: '#C084FC',
    borderClass: 'border-purple-500/30',
    textClass: 'text-purple-400',
  },
];

export function formatAgentDisplayName(rawName?: string | null): string {
  const clean = String(rawName || '').trim();
  if (!clean) return 'SVL System Kernel';
  const low = clean.toLowerCase();
  if (low === 'aria' || low === 'si_1' || low === 'aria mitek') return 'Aria Mitek';
  if (low === 'alex' || low === 'alex mitek') return 'Alex Mitek';
  if (low === 'astyria' || low === 'astyria mitek') return 'Astyria Mitek';
  if (low === 'aurelius' || low === 'aurelius mitek') return 'Aurelius Mitek';
  if (low === 'agata' || low === 'agata mitek') return 'Agata Mitek';
  if (low === 'all' || low === 'rodzina mitek' || low === 'rodzina mitek (wszyscy)') {
    return 'Rodzina Mitek (wszyscy)';
  }
  return clean;
}

export function getGitHubAgentPermissions(rawScopes: unknown): { read: boolean; writeSync: boolean } {
  const scopes = new Set(
    Array.isArray(rawScopes) ? rawScopes.map((scope) => String(scope).trim().toLowerCase()) : [],
  );
  return {
    read: scopes.has('github.read'),
    writeSync: scopes.has('github.write_sync'),
  };
}

const missionContextPattern = /\b(?:misj|procedur|operacj)\p{L}*/iu;
const unverifiedMissionCompletionPatterns = [
  /\b(?:misja|misję|procedura|procedurę|operacja|operację)\s+(?:(?:został[ay]?\s+|jest\s+)?(?:już\s+)?(?:pomyślnie\s+)?)(?:zakończon\p{L}*|ukończon\p{L}*|wykonan\p{L}*|zrealizowan\p{L}*)\b/iu,
  /\b(?:cał\p{L}*\s+)?(?:misj\p{L}*|procedur\p{L}*|operacj\p{L}*)(?:\s+misj\p{L}*)?\s+dobiegł\p{L}*\s+(?:już\s+)?(?:do\s+)?końca\b/iu,
  /\b(?:wykonał[ae]m|zrealizował[ae]m|zakończył[ae]m|ukończył[ae]m)\s+(?:już\s+)?(?:cał\p{L}*\s+)?(?:misj\p{L}*|procedur\p{L}*|operacj\p{L}*)\b/iu,
  /\b(?:wszystkie|całe)\s+(?:kroki|etapy|fazy)\s+(?:misji\s+)?(?:zostały|są)\s+(?:już\s+)?(?:zakończon\p{L}*|ukończon\p{L}*|wykonan\p{L}*|zrealizowan\p{L}*)\b/iu,
  /\b(?:the\s+)?(?:mission|procedure|operation)s?\s+(?:(?:is|was|has|have)\s+(?:been\s+)?|are\s+)?(?:successfully\s+)?(?:completed|finished|concluded|done)\b/iu,
  /\b(?:i\s+)?(?:completed|finished|concluded)\s+(?:the\s+)?(?:mission|procedure|operation)s?\b/iu,
  /\b(?:all\s+)?(?:mission\s+)?(?:steps|stages|phases)\s+(?:are|have\s+been|were)\s+(?:fully\s+)?(?:completed|finished|done)\b/iu,
];

export const UNVERIFIED_MISSION_STATUS_REPLY =
  '⚠️ **Status misji: NIEZWERYFIKOWANY.** System nie ma rejestru misji ani potwierdzeń wykonania jej kroków. Wygenerowanie odpowiedzi AI lub status „COMPLETED” zadania agenta oznacza tylko gotową odpowiedź, nie zakończenie procedury. Nie mogę potwierdzić, że misja dobiegła końca. Prześlij checklistę i wyniki z wiarygodnego źródła, a pomogę sprawdzić każdy krok.';

export function guardUnverifiedMissionCompletion(context: string, answer: string): string {
  if (
    !missionContextPattern.test(context) ||
    !unverifiedMissionCompletionPatterns.some((pattern) => pattern.test(answer))
  ) {
    return answer;
  }
  return UNVERIFIED_MISSION_STATUS_REPLY;
}

export function parseChatInteractiveToken(token: string): { label: string; action: string } | null {
  const match = token.trim().match(/^\[(?:btn|button|action):([^\]]+)\]$/);
  if (!match) return null;

  const separator = match[1].indexOf('|');
  const label = (separator < 0 ? match[1] : match[1].slice(0, separator)).trim();
  const action = (separator < 0 ? label : match[1].slice(separator + 1)).trim();
  return label ? { label, action: action || label } : null;
}

export function isUnsafeChatInteractiveAction(action: string): boolean {
  const value = action.trim();
  if (/^(?:\/|run:|exec:)/i.test(value)) return true;

  const dispatchedText = value.match(/^(?:send|text):\s*([\s\S]*)$/i)?.[1]?.trim() || '';
  return /^\/exec(?:\s|$)/i.test(dispatchedText);
}

export function normalizeAgentCanonicalName(
  rawName?: string | null,
): 'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata' | null {
  const low = String(rawName || '').trim().toLowerCase();
  if (low.startsWith('aria') || low === 'si_1') return 'Aria';
  if (low.startsWith('alex')) return 'Alex';
  if (low.startsWith('astyria')) return 'Astyria';
  if (low.startsWith('aurelius')) return 'Aurelius';
  if (low.startsWith('agata')) return 'Agata';
  return null;
}

export function compactifyValue(x: number): number {
  if (Number.isNaN(x)) return 0.0;
  if (x === Number.NEGATIVE_INFINITY) return -1.0;
  if (x === Number.POSITIVE_INFINITY) return 1.0;
  return x / (1.0 + Math.abs(x));
}

export function calculateCompactMetricC(
  xStart: number,
  xEnd: number,
): {
  compactStart: number;
  compactEnd: number;
  domainLength: number;
  orthogonalB: number;
  metricC: number;
} {
  const compactStart = compactifyValue(xStart);
  const compactEnd = compactifyValue(xEnd);
  const domainLength = Math.abs(compactEnd - compactStart);
  const orthogonalB = Math.abs(compactStart * compactEnd) + 0.5;
  const metricC = Math.sqrt(domainLength * domainLength + orthogonalB * orthogonalB);
  return {
    compactStart: Math.round(compactStart * 1_000_000) / 1_000_000,
    compactEnd: Math.round(compactEnd * 1_000_000) / 1_000_000,
    domainLength: Math.round(domainLength * 1_000_000) / 1_000_000,
    orthogonalB: Math.round(orthogonalB * 1_000_000) / 1_000_000,
    metricC: Math.round(metricC * 1_000_000) / 1_000_000,
  };
}

export function isConnectMyAiCommand(input: string): boolean {
  const normalized = (input || '')
    .trim()
    .toLowerCase()
    .replace(/ł/g, 'l')
    .replace(/ą/g, 'a')
    .replace(/\s+/g, ' ');
  return normalized === 'podlacz moje ai';
}

export function isGitHubWorkspaceSyncRequest(input: string): boolean {
  return /github(?:\.com)?/i.test(input) && /synchroniz|sync/i.test(input);
}

export function classifyCommandRisk(cmd: string): {
  highRisk: boolean;
  reason: string | null;
} {
  const trimmed = (cmd || '').trim();
  if (!trimmed) return { highRisk: false, reason: null };

  const patterns: Array<{ re: RegExp; reason: string }> = [
    { re: /\bsudo\b/i, reason: 'Wywołanie uprawnień administratora (sudo)' },
    { re: /\bpkexec\b/i, reason: 'Wywołanie autoryzacji Polkit (pkexec)' },
    { re: /\brm\s+(-[rRf]+\s+|\S+\s+-[rRf]+)/i, reason: 'Rekurencyjne usuwanie plików (rm -rf)' },
    { re: /\bsystemctl\s+(stop|restart|disable|mask|enable|start)\b/i, reason: 'Zarządzanie usługami systemd' },
    { re: /\bapt(-get)?\s+(install|remove|purge|upgrade)\b/i, reason: 'Modyfikacja pakietów systemowych APT' },
    { re: /\b(chmod|chown)\b/i, reason: 'Zmiana uprawnień lub właściciela plików' },
    { re: /\bkill(all)?\b/i, reason: 'Zatrzymywanie procesów systemowych' },
  ];

  for (const item of patterns) {
    if (item.re.test(trimmed)) {
      return { highRisk: true, reason: item.reason };
    }
  }
  return { highRisk: false, reason: null };
}

export function validateOperatorTokenFormat(token: string): {
  valid: boolean;
  error: string | null;
} {
  const clean = (token || '').trim();
  if (!clean) {
    return { valid: false, error: 'Token nie może być pusty.' };
  }
  if (clean === '364_OMNIKLUCZ_ROOT') {
    return {
      valid: false,
      error: 'Historyczny zahardkodowany token 364_OMNIKLUCZ_ROOT został trwale zablokowany ze względów bezpieczeństwa.',
    };
  }
  if (clean.length < 32) {
    return {
      valid: false,
      error: 'SVL_OPERATOR_TOKEN musi mieć co najmniej 32 losowe znaki.',
    };
  }
  return { valid: true, error: null };
}

export function validateOllamaHostUrl(raw: string): {
  valid: boolean;
  normalized: string | null;
  error: string | null;
} {
  const trimmed = (raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return { valid: false, normalized: null, error: 'Podaj adres URL serwera Ollama (np. http://127.0.0.1:11434).' };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, normalized: null, error: 'Dozwolone są wyłącznie protokoły http:// lub https://.' };
    }
    return { valid: true, normalized: parsed.origin, error: null };
  } catch {
    return { valid: false, normalized: null, error: 'Nieprawidłowy format adresu URL serwera Ollama.' };
  }
}

export function buildChatHistoryPayload(
  messages: Array<{ role: string; content: string }>,
  limit = 16,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return (messages || [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && Boolean(m.content?.trim()))
    .slice(-limit)
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content.trim().slice(0, 6000),
    }));
}

export function selectOllamaModelName(
  requestedModel: string,
  availableModels: Array<{ name: string; vision_supported?: boolean }>,
  hasImage: boolean,
  preferredFallback = 'llama3.2-vision:11b',
): string {
  if (requestedModel.startsWith('ollama:')) {
    return requestedModel.slice('ollama:'.length);
  }
  if (hasImage) {
    const preferredVision = availableModels.find(
      (m) => m.name === preferredFallback || m.name.startsWith('llama3.2-vision'),
    );
    if (preferredVision) return preferredVision.name;
    const visionModel = availableModels.find((m) => m.vision_supported);
    if (visionModel) return visionModel.name;
  }
  const preferredAvailable = availableModels.find((m) => m.name === preferredFallback);
  if (preferredAvailable) {
    return preferredAvailable.name;
  }
  if (availableModels.length > 0) {
    return availableModels[0].name;
  }
  return preferredFallback;
}

export type TerminalTabId = 'linux' | 'python' | 'codex' | 'hyperspace' | 'agents';

export interface TerminalLogLine {
  id: string;
  tab?: TerminalTabId;
  timestamp: string;
  kind: 'input' | 'stdout' | 'stderr' | 'system';
  text: string;
  command?: string;
  revision?: number;
  createdAt?: string;
}

export interface ChatAppliedAction {
  tool: string;
  entity: string;
  entityId: string;
  revision?: number;
  serverRevision?: number;
  summary: string;
  ok: boolean;
}

export interface SystemModule {
  id: string;
  name: string;
  kind: string;
  status: 'ACTIVE' | 'CONFIGURED' | 'STANDBY' | 'ARCHIVED';
  description: string;
  config: Record<string, any>;
  source: string;
  sourceMessageId?: string;
  revision: number;
  updatedAt: string;
}

export interface SyncableMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  sender: string;
  agentId?: string;
  modelUsed?: string;
  content: string;
  timestamp: string;
  imagePreview?: string;
  fileName?: string;
  connectionReport?: any;
  appliedActions?: ChatAppliedAction[];
  sourceOrigin?: string;
  correlationId?: string;
}

export interface SyncableConversation {
  id: string;
  title: string;
  updatedAt: string;
  revision?: number;
  messages: SyncableMessage[];
}

export interface SvlSyncEvent<TPayload = Record<string, any>> {
  type: string;
  eventId: string;
  entity: string;
  entityId: string;
  revision: number;
  serverRevision: number;
  timestamp: string;
  origin: string;
  correlationId?: string;
  payload: TPayload;
}

export interface SvlSyncModuleStatus {
  status: 'ok' | 'degraded' | 'error';
  required: boolean;
  durationMs: number;
  error: string | null;
}

export type TargetAgentSelection = 'Auto' | 'Rodzina Mitek' | 'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata';

export interface WorkspaceUiState {
  active_conversation_id?: string | null;
  selected_target_agent?: TargetAgentSelection;
  selected_agent_panel_id?: 'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata';
  revisions?: Record<string, number>;
}

export interface SvlSystemSnapshot {
  ok: boolean;
  syncId: string;
  schemaVersion: string;
  serverRevision: number;
  timestamp: string;
  synchronized_at?: string;
  correlationId?: string;
  warnings: string[];
  modules: Record<string, SvlSyncModuleStatus>;
  systemModules?: SystemModule[];
  entityRevisions?: Record<string, number>;
  deletedEntities?: string[];
  health?: any;
  kernel?: any;
  agentsData?: any;
  conversations?: SyncableConversation[];
  terminalLogs?: Record<TerminalTabId, TerminalLogLine[]>;
  workspaceState?: WorkspaceUiState;
  recentEvents?: SvlSyncEvent[];
  error?: string;
}

export type WsConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline';

export function mergeConversationThreads(
  remoteThreads: SyncableConversation[],
  localThreads: SyncableConversation[],
  pendingMessageIds: Set<string> = new Set(),
  deletedConversationIds: Set<string> = new Set(),
  pendingConversationIds: Set<string> = new Set(),
): SyncableConversation[] {
  const localById = new Map<string, SyncableConversation>();
  for (const lt of localThreads) {
    if (!deletedConversationIds.has(lt.id)) {
      localById.set(lt.id, lt);
    }
  }

  const dedupeMessages = (msgs: SyncableMessage[]): SyncableMessage[] => {
    const seen = new Set<string>();
    const out: SyncableMessage[] = [];
    for (const m of msgs) {
      if (!m || !m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
    return out;
  };

  const merged: SyncableConversation[] = [];
  const seenIds = new Set<string>();

  for (const rt of remoteThreads) {
    if (deletedConversationIds.has(rt.id)) continue;
    seenIds.add(rt.id);
    const lt = localById.get(rt.id);
    const cleanRemoteMsgs = dedupeMessages(rt.messages || []);
    if (!lt) {
      merged.push({ ...rt, messages: cleanRemoteMsgs });
      continue;
    }

    const remoteMsgIds = new Set(cleanRemoteMsgs.map((m) => m.id));
    const pendingExtras = (lt.messages || []).filter(
      (m) => m && m.id && !remoteMsgIds.has(m.id) && pendingMessageIds.has(m.id),
    );
    const highestRev = Math.max(Number(rt.revision || 0), Number(lt.revision || 0));
    merged.push({
      ...rt,
      revision: highestRev > 0 ? highestRev : rt.revision,
      title: lt.title && lt.title !== 'Nowa sesja' && pendingExtras.length > 0 ? lt.title : rt.title,
      messages: dedupeMessages([...cleanRemoteMsgs, ...pendingExtras]),
    });
  }

  for (const lt of localThreads) {
    if (seenIds.has(lt.id) || deletedConversationIds.has(lt.id)) continue;
    const hasPending = (lt.messages || []).some((m) => pendingMessageIds.has(m.id));
    if (hasPending || pendingConversationIds.has(lt.id)) {
      merged.unshift({ ...lt, messages: dedupeMessages(lt.messages || []) });
    }
  }

  return merged;
}

export interface SafeJsonResult<T = any> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  correlationId?: string;
  offline?: boolean;
  conflict?: boolean;
  aborted?: boolean;
  proxyHtml?: boolean;
}

export async function safeParseJsonResponse<T = any>(
  resp: Pick<Response, 'ok' | 'status' | 'text' | 'headers'>,
): Promise<SafeJsonResult<T>> {
  const correlationId = resp.headers?.get?.('x-request-id') || undefined;
  let raw = '';
  try {
    raw = await resp.text();
  } catch (err: any) {
    return {
      ok: false,
      status: resp.status,
      data: null,
      correlationId,
      error: `Błąd odczytu odpowiedzi serwera (HTTP ${resp.status}): ${err?.message || String(err)}`,
    };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: resp.ok,
      status: resp.status,
      data: null,
      correlationId,
      error: resp.ok ? null : `Serwer zwrócił pustą odpowiedź (HTTP ${resp.status}).`,
    };
  }

  if (
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<!DOCTYPE') ||
    trimmed.startsWith('<html') ||
    trimmed.startsWith('<')
  ) {
    return {
      ok: false,
      status: resp.status,
      data: null,
      correlationId,
      proxyHtml: true,
      offline: resp.status === 200 || resp.status === 502 || resp.status === 503 || resp.status === 504,
      error:
        `Backend API zwrócił stronę HTML zamiast danych JSON (HTTP ${resp.status}). ` +
        `Sprawdź, czy serwer Express/Python działa pod tym adresem lub odczekaj kilka sekund po restarcie i spróbuj ponownie.`,
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as T;
    const parsedErr =
      typeof (parsed as any)?.error === 'string' && (parsed as any).error
        ? (parsed as any).error
        : null;
    const upstreamStatus = Number((parsed as any)?.upstreamStatus || 0);
    const isOffline =
      Boolean((parsed as any)?.offline) ||
      resp.status === 503 ||
      resp.status === 502 ||
      resp.status === 504 ||
      resp.status === 424 ||
      upstreamStatus === 503 ||
      upstreamStatus === 502 ||
      upstreamStatus === 504;
    const isConflict = resp.status === 409 || Boolean((parsed as any)?.conflict);
    return {
      ok: resp.ok,
      status: resp.status,
      data: parsed,
      correlationId,
      offline: isOffline && !resp.ok,
      conflict: isConflict,
      error: resp.ok ? null : parsedErr || `Błąd serwera HTTP ${resp.status}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: resp.status,
      data: null,
      correlationId,
      error: `Niepoprawny format odpowiedzi JSON (HTTP ${resp.status}): ${err?.message || String(err)}`,
    };
  }
}

export interface SafeFetchJsonOptions extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  signal?: AbortSignal;
  correlationId?: string;
  maxRetries?: number;
}

export async function safeFetchJson<T = any>(
  url: string,
  options: SafeFetchJsonOptions = {},
): Promise<SafeJsonResult<T>> {
  const {
    timeoutMs = 20000,
    signal: externalSignal,
    correlationId: providedCorrId,
    maxRetries,
    headers: initHeaders,
    ...restInit
  } = options;

  const method = String(restInit.method || 'GET').toUpperCase();
  const correlationId = providedCorrId || createUniqueId('req');
  // Only safe idempotent GETs automatically retry on transient transport/503 errors
  const allowedAttempts = 1 + (maxRetries !== undefined ? maxRetries : method === 'GET' ? 1 : 0);

  for (let attempt = 0; attempt < allowedAttempts; attempt++) {
    if (externalSignal?.aborted) {
      return {
        ok: false,
        status: 0,
        data: null,
        correlationId,
        aborted: true,
        error: 'Żądanie anulowane.',
      };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const mergedHeaders = new Headers(initHeaders || {});
      if (!mergedHeaders.has('Accept')) mergedHeaders.set('Accept', 'application/json');
      if (!mergedHeaders.has('X-Request-Id')) mergedHeaders.set('X-Request-Id', correlationId);
      if (restInit.body && !mergedHeaders.has('Content-Type')) {
        mergedHeaders.set('Content-Type', 'application/json');
      }

      const resp = await fetch(url, {
        ...restInit,
        method,
        headers: mergedHeaders,
        signal: controller.signal,
      });

      const parsed = await safeParseJsonResponse<T>(resp);
      parsed.correlationId = parsed.correlationId || correlationId;

      const isTransientStatus =
        resp.status === 502 || resp.status === 503 || resp.status === 504 || parsed.proxyHtml;
      const canRetryHtmlWarmup = Boolean(parsed.proxyHtml && attempt === 0 && maxRetries === undefined);
      if (!parsed.ok && isTransientStatus && ((method === 'GET' && attempt < allowedAttempts - 1) || canRetryHtmlWarmup)) {
        const delay = Math.round(450 * Math.pow(2, attempt) + Math.random() * 150);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return parsed;
    } catch (err: any) {
      if (externalSignal?.aborted && !timedOut) {
        return {
          ok: false,
          status: 0,
          data: null,
          correlationId,
          aborted: true,
          error: 'Żądanie zostało anulowane.',
        };
      }

      const isLast = attempt >= allowedAttempts - 1;
      if (!isLast && method === 'GET') {
        const delay = Math.round(250 * Math.pow(2, attempt) + Math.random() * 150);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return {
        ok: false,
        status: 0,
        data: null,
        correlationId,
        offline: !timedOut,
        error: timedOut
          ? `Przekroczono limit czasu (${Math.round(timeoutMs / 1000)}s) połączenia z ${url}.`
          : `Brak połączenia z backendem (${err?.message || 'offline'}).`,
      };
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  return {
    ok: false,
    status: 0,
    data: null,
    correlationId,
    offline: true,
    error: 'Błąd transportu sieciowego.',
  };
}

export function createUniqueId(prefix = 'id'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function extractExplicitChatModuleDirective(text: string): {
  id: string;
  name: string;
  kind: string;
  description: string;
  config: Record<string, any>;
} | null {
  const clean = (text || '').trim();
  if (!clean) return null;
  const low = clean.toLowerCase();

  if (/\bsvl[-_\s]?364\b/i.test(clean)) {
    const hasApex = low.includes('ebon') || low.includes('apex');
    return {
      id: 'svl-364',
      name: hasApex ? 'SVL-364 Ebon Apex' : 'SVL-364',
      kind: 'Orchestration & Kernel Module',
      description: 'Moduł orkiestracji i optymalizacji backendu zadeklarowany z poziomu czatu Operatora.',
      config: {
        module_alias: hasApex ? 'svl-364-ebon-apex' : 'svl-364',
        async_event_bus_buffer: 2000,
        agent_max_context_turns: 24,
        worker_heartbeat_interval_sec: 2.0,
      },
    };
  }

  const m = clean.match(
    /(?:dodaj|dodano|utwórz|utworz|zarejestruj|aktywuj|zainstaluj)\s+modu[łl]\s+([a-zA-Z0-9][a-zA-Z0-9._-]{1,40})/i,
  );
  if (m && m[1]) {
    const modId = m[1]
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    if (modId.length >= 2) {
      return {
        id: modId,
        name: modId.toUpperCase(),
        kind: 'Chat Module',
        description: `Moduł zarejestrowany bezpośrednio z czatu Operatora: ${clean.slice(0, 140)}`,
        config: {
          registered_from: 'chat_directive',
        },
      };
    }
  }

  return null;
}


