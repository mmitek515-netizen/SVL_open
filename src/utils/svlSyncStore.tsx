import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AvatarProfileKey,
  IrisNotification,
  SvlAvatarMap,
  SyncableConversation,
  SyncableMessage,
  SystemModule,
  SvlSyncEvent,
  TerminalLogLine,
  TerminalTabId,
  WorkspaceUiState,
  WsConnectionState,
  createUniqueId,
  mergeConversationThreads,
  safeFetchJson,
  getSvlOperatorAccessToken,
} from './svlLogic';

const BROADCAST_CHANNEL_NAME = 'svl_python_os_sync';
const STORAGE_SIGNAL_KEY = 'svl_sync_signal_v1';
const CONVERSATIONS_CACHE_KEY = 'svl_python_os_conversations_v1';

const DEFAULT_TERMINAL_LOGS: Record<TerminalTabId, TerminalLogLine[]> = {
  linux: [],
  ssh: [],
  python: [],
  codex: [],
  hyperspace: [],
  agents: [],
};

export const INITIAL_WELCOME_CONVERSATIONS: SyncableConversation[] = [
  { id: 'conv-rodzina-mitek-wszyscy', title: 'Rodzina Mitek (wszyscy)', updatedAt: '', revision: 1, messages: [] },
  { id: 'conv-agent-agata', title: 'Agata Mitek (1-na-1)', updatedAt: '', revision: 1, messages: [] },
];

export interface RefreshExecutionReport {
  ok: boolean;
  serverRevision: number;
  timestamp: string;
  durationMs: number;
  error?: string;
}

export interface ViteHmrDiagnostic {
  hmrState: 'active' | 'disabled' | 'proxy_unavailable';
  hmrMessage?: string;
  detectedAt?: string;
}

export interface DomainRefreshReport {
  ok: boolean;
  error?: string;
}

function formatUpdatedAt(raw?: string): string {
  if (!raw) return '';
  if (raw.includes('T')) {
    const dt = new Date(raw);
    if (!Number.isNaN(dt.getTime())) {
      return dt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    }
  }
  return raw;
}

function stripObsoleteDiagnosticMessages(msgs: any[]): SyncableMessage[] {
  if (!Array.isArray(msgs)) return [];
  return msgs.filter(Boolean);
}

const REMOVED_AGENT_CONVERSATION_IDS = new Set([
  'conv-agent-aria',
  'conv-agent-alex',
  'conv-agent-astyria',
  'conv-agent-aurelius',
]);

export function getCanonicalConversationTitle(id: string, fallbackTitle?: string): string {
  if (id === 'conv-rodzina-mitek-wszyscy') return 'Rodzina Mitek (wszyscy)';
  if (id === 'conv-agent-agata') return 'Agata Mitek (1-na-1)';
  return fallbackTitle || 'Sesja SVL Python OS';
}

function normalizeConversationsFromServer(rawList: any[]): SyncableConversation[] {
  return (rawList || [])
    .filter((c: any) => !REMOVED_AGENT_CONVERSATION_IDS.has(String(c?.id || '')))
    .map((c: any) => {
      const cleaned = stripObsoleteDiagnosticMessages(c.messages);
      return {
        id: String(c.id),
        title: getCanonicalConversationTitle(String(c.id), c.title),
        updatedAt: formatUpdatedAt(c.updatedAt),
        revision: typeof c.revision === 'number' ? c.revision : Number(c.revision || 1),
        messages: cleaned,
      };
    });
}

interface SvlSyncContextValue {
  tabOrigin: string;
  wsState: WsConnectionState;
  wsAttempt: number;
  wsLastError: string | null;
  viteHmrDiagnostic: ViteHmrDiagnostic;
  serverRevision: number;
  schemaVersion: string;
  lastSyncedAt: string | null;
  isSyncing: boolean;
  isConnectingAi: boolean;
  lastRefreshReport: RefreshExecutionReport | null;

  healthData: any;
  kernelData: any;
  agentsData: any;
  systemModules: SystemModule[];
  avatars: SvlAvatarMap;
  irisNotifications: IrisNotification[];
  irisUnreadCount: number;
  conversations: SyncableConversation[];
  terminalLogsByTab: Record<TerminalTabId, TerminalLogLine[]>;
  workspaceState: WorkspaceUiState;

  activeConvId: string;
  targetAgent: 'Auto' | 'Rodzina Mitek' | 'Agata';
  selectedAgentPanel: 'Agata';

  refreshAllDomains: (reason?: string) => Promise<RefreshExecutionReport>;
  refreshDomainModules: (modules: Array<'health' | 'kernel' | 'agents' | 'chat' | 'terminals' | 'workspace' | 'modules' | 'notifications' | 'avatars'>) => Promise<DomainRefreshReport>;
  reconnectWebSocket: () => void;
  connectMyAi: (triggeredBy?: string) => Promise<any>;

  setActiveConvId: (convId: string) => void;
  setTargetAgent: (agent: 'Auto' | 'Rodzina Mitek' | 'Agata') => void;
  setSelectedAgentPanel: (agent: 'Agata') => void;
  openFamilyChannel: () => void;
  openAgentChannel: (agent: 'Agata') => void;

  createConversation: () => SyncableConversation;
  deleteConversation: (convId: string) => Promise<{ ok: boolean; error?: string }>;
  clearAllConversationsAndBuffers: (accessToken?: string) => Promise<{ ok: boolean; error?: string }>;
  appendAndPersistChatMessage: (convId: string, convTitle: string, model: string, msg: SyncableMessage) => Promise<{ ok: boolean; error?: string }>;
  upsertSystemModule: (mod: { id: string; name: string; kind?: string; status?: string; description?: string; config?: Record<string, any> }) => Promise<{ ok: boolean; module?: SystemModule; error?: string }>;
  deleteSystemModule: (modId: string) => Promise<{ ok: boolean; error?: string }>;
  saveAgentAvatar: (agent: AvatarProfileKey, image: string) => Promise<{ ok: boolean; avatars?: SvlAvatarMap; error?: string }>;
  resetAgentAvatar: (agent: AvatarProfileKey) => Promise<{ ok: boolean; avatars?: SvlAvatarMap; error?: string }>;
  emitIrisNotification: (payload: { severity?: 'INFO' | 'WARN' | 'ALERT'; category?: string; title: string; message?: string; details?: Record<string, any>; mirrorToFamilyChat?: boolean }) => Promise<{ ok: boolean; notification?: IrisNotification; error?: string }>;
  ackIrisNotifications: (ids?: string[]) => Promise<{ ok: boolean; unreadCount?: number; error?: string }>;
  clearTerminalTab: (tab: TerminalTabId) => Promise<{ ok: boolean; error?: string }>;
  refreshTerminals: () => Promise<void>;
  notifyLocalMutation: (entity: string, entityId: string, serverRevision?: number, event?: SvlSyncEvent | null) => void;
}

const SvlSyncContext = createContext<SvlSyncContextValue | null>(null);

export const SvlSyncProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const tabOriginRef = useRef<string>(createUniqueId('tab'));
  const tabOrigin = tabOriginRef.current;

  const [wsState, setWsState] = useState<WsConnectionState>('connecting');
  const [wsAttempt, setWsAttempt] = useState(0);
  const [wsLastError, setWsLastError] = useState<string | null>(null);
  const [viteHmrDiagnostic, setViteHmrDiagnostic] = useState<ViteHmrDiagnostic>(() => {
    if (typeof window !== 'undefined' && window.__SVL_DEV_DIAGNOSTICS__) {
      return window.__SVL_DEV_DIAGNOSTICS__;
    }
    return { hmrState: import.meta.env.DEV ? 'active' : 'disabled' };
  });

  const [serverRevision, setServerRevision] = useState(0);
  const serverRevisionRef = useRef(0);
  const [schemaVersion, setSchemaVersion] = useState('2026.11.sync.v1');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isConnectingAi, setIsConnectingAi] = useState(false);
  const [lastRefreshReport, setLastRefreshReport] = useState<RefreshExecutionReport | null>(null);

  const [healthData, setHealthData] = useState<any>(null);
  const [kernelData, setKernelData] = useState<any>(null);
  const [agentsData, setAgentsData] = useState<any>(null);
  const [systemModules, setSystemModules] = useState<SystemModule[]>([]);
  const [avatars, setAvatars] = useState<SvlAvatarMap>({});
  const [irisNotifications, setIrisNotifications] = useState<IrisNotification[]>([]);
  const [irisUnreadCount, setIrisUnreadCount] = useState<number>(0);
  const [conversations, setConversations] = useState<SyncableConversation[]>(INITIAL_WELCOME_CONVERSATIONS);
  // Never restore erased conversation history from an old browser cache.
  useEffect(() => {
    try { localStorage.removeItem(CONVERSATIONS_CACHE_KEY); } catch { /* unavailable */ }
  }, []);

  const conversationsRef = useRef<SyncableConversation[]>(conversations);
  conversationsRef.current = conversations;

  const [terminalLogsByTab, setTerminalLogsByTab] = useState<Record<TerminalTabId, TerminalLogLine[]>>(DEFAULT_TERMINAL_LOGS);
  const [workspaceState, setWorkspaceState] = useState<WorkspaceUiState>({
    active_conversation_id: null,
    selected_target_agent: 'Rodzina Mitek',
    selected_agent_panel_id: 'Agata',
    revisions: {},
  });

  const [activeConvIdState, setActiveConvIdState] = useState<string>(
    () => conversations[0]?.id || 'conv-rodzina-mitek-wszyscy',
  );
  const [targetAgentState, setTargetAgentState] = useState<'Auto' | 'Rodzina Mitek' | 'Agata'>('Rodzina Mitek');
  const [selectedAgentPanelState, setSelectedAgentPanelState] = useState<'Agata'>('Agata');

  const pendingMsgIdsRef = useRef<Set<string>>(new Set());
  // Keep a newly-created EMPTY thread visible while SQLite create is in-flight.
  const pendingConvIdsRef = useRef<Set<string>>(new Set());
  const deletedConvIdsRef = useRef<Set<string>>(new Set());
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const seenEventOrderRef = useRef<string[]>([]);
  const seenSignalIdsRef = useRef<Set<string>>(new Set());
  const seenSignalOrderRef = useRef<string[]>([]);
  const inflightRefreshRef = useRef<Promise<RefreshExecutionReport> | null>(null);
  const inflightCatchupRef = useRef<Promise<void> | null>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);
  const wsReconnectNowRef = useRef<(() => void) | null>(null);

  // Server SQLite is authoritative. Do not persist old messages in localStorage.

  // Listen to Vite HMR diagnostics emitted in main.tsx
  useEffect(() => {
    const onHmrDiag = (evt: Event) => {
      const custom = evt as CustomEvent<ViteHmrDiagnostic>;
      if (custom?.detail) setViteHmrDiagnostic(custom.detail);
    };
    window.addEventListener('svl:hmr-diagnostic', onHmrDiag);
    return () => window.removeEventListener('svl:hmr-diagnostic', onHmrDiag);
  }, []);

  const recordSeenEventId = useCallback((eventId?: string): boolean => {
    if (!eventId) return true;
    if (seenEventIdsRef.current.has(eventId)) return false;
    seenEventIdsRef.current.add(eventId);
    seenEventOrderRef.current.push(eventId);
    if (seenEventOrderRef.current.length > 1200) {
      const oldest = seenEventOrderRef.current.shift();
      if (oldest) seenEventIdsRef.current.delete(oldest);
    }
    return true;
  }, []);

  const recordSeenSignalId = useCallback((signalId?: string): boolean => {
    if (!signalId) return true;
    if (seenSignalIdsRef.current.has(signalId)) return false;
    seenSignalIdsRef.current.add(signalId);
    seenSignalOrderRef.current.push(signalId);
    if (seenSignalOrderRef.current.length > 1200) {
      const oldest = seenSignalOrderRef.current.shift();
      if (oldest) seenSignalIdsRef.current.delete(oldest);
    }
    return true;
  }, []);

  const advanceServerRevision = useCallback((rev?: number) => {
    const num = Number(rev || 0);
    if (num > serverRevisionRef.current) {
      serverRevisionRef.current = num;
      setServerRevision(num);
    }
  }, []);

  const emitCrossTabSignal = useCallback(
    (entity: string, entityId: string, srvRev?: number, eventId?: string) => {
      const sig = {
        type: 'svl_sync_signal',
        origin: tabOrigin,
        signalId: createUniqueId('sig'),
        eventId: eventId || undefined,
        entity,
        entityId,
        serverRevision: Number(srvRev || serverRevisionRef.current || 0),
        at: Date.now(),
      };
      recordSeenSignalId(sig.signalId);
      try {
        broadcastChannelRef.current?.postMessage(sig);
      } catch {
        // ignore closed channel
      }
      try {
        localStorage.setItem(STORAGE_SIGNAL_KEY, JSON.stringify(sig));
      } catch {
        // ignore storage restrictions
      }
    },
    [recordSeenSignalId, tabOrigin],
  );

  const refreshDomainModules = useCallback(
    async (modules: Array<'health' | 'kernel' | 'agents' | 'chat' | 'terminals' | 'workspace' | 'modules' | 'notifications' | 'avatars'>): Promise<DomainRefreshReport> => {
      const unique = Array.from(new Set(modules));
      const tasks: Promise<void>[] = [];
      const taskDomains: string[] = [];
      let refreshedConversationIds: Set<string> | null = null;
      let refreshedActiveConversation: unknown;
      const addTask = (domain: string, task: Promise<void>) => {
        taskDomains.push(domain);
        tasks.push(task);
      };

      if (unique.includes('avatars')) {
        addTask('avatars',
          safeFetchJson<{
            ok: boolean;
            avatars?: SvlAvatarMap;
            serverRevision?: number;
            error?: string;
          }>('/api/avatars', { timeoutMs: 10000 }).then((r) => {
            if (!r.ok || !r.data?.ok || !r.data.avatars || typeof r.data.avatars !== 'object') {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            setAvatars(r.data.avatars);
            advanceServerRevision(r.data.serverRevision);
          }),
        );
      }

      if (unique.includes('notifications')) {
        addTask('notifications',
          safeFetchJson<{
            ok: boolean;
            notifications?: IrisNotification[];
            unreadCount?: number;
            serverRevision?: number;
            error?: string;
          }>('/api/py/notifications?limit=80', { timeoutMs: 12000 }).then((r) => {
            if (!r.ok || !r.data?.ok || !Array.isArray(r.data.notifications)) {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            setIrisNotifications(r.data.notifications);
            setIrisUnreadCount(
              typeof r.data.unreadCount === 'number'
                ? r.data.unreadCount
                : r.data.notifications.filter((n) => !n.isRead).length,
            );
            advanceServerRevision(r.data.serverRevision);
          }),
        );
      }

      if (unique.includes('health')) {
        addTask('health',
          safeFetchJson('/api/py/health', { timeoutMs: 12000 }).then((r) => {
            if (!r.ok || !r.data || r.data.ok === false) {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            setHealthData(r.data);
            if (typeof r.data.schemaVersion === 'string') setSchemaVersion(r.data.schemaVersion);
            if (Array.isArray(r.data.system_modules)) {
              setSystemModules(r.data.system_modules);
            }
            advanceServerRevision(r.data.serverRevision);
          }),
        );
      }
      if (unique.includes('kernel')) {
        addTask('kernel',
          safeFetchJson('/api/py/kernel/report', { timeoutMs: 12000 }).then((r) => {
            if (!r.ok || !r.data || r.data.ok === false) {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            setKernelData(r.data);
            if (Array.isArray(r.data.system_modules)) {
              setSystemModules(r.data.system_modules);
            }
            advanceServerRevision(r.data.serverRevision);
          }),
        );
      }
      if (unique.includes('modules')) {
        addTask('modules',
          safeFetchJson<{ ok: boolean; modules?: SystemModule[]; serverRevision?: number; error?: string }>('/api/py/modules', {
            timeoutMs: 12000,
          }).then((r) => {
            if (!r.ok || !r.data?.ok || !Array.isArray(r.data.modules)) {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            setSystemModules(r.data.modules);
            advanceServerRevision(r.data.serverRevision);
          }),
        );
      }
      if (unique.includes('agents')) {
        addTask('agents',
          safeFetchJson('/api/py/agents/status', { timeoutMs: 12000 }).then((r) => {
            if (!r.ok || !r.data || r.data.ok === false) {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            setAgentsData(r.data);
            advanceServerRevision(r.data.serverRevision);
          }),
        );
      }
      if (unique.includes('chat')) {
        addTask('chat',
          safeFetchJson('/api/py/chat/conversations', { timeoutMs: 12000 }).then((r) => {
            if (!r.ok || !r.data?.ok || !Array.isArray(r.data.conversations)) {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            advanceServerRevision(r.data.serverRevision);
            const hydrated = normalizeConversationsFromServer(r.data.conversations);
            refreshedConversationIds = new Set(hydrated.map((conversation) => conversation.id));
            for (const conversation of hydrated) {
              deletedConvIdsRef.current.delete(conversation.id);
            }
            setConversations((prev) =>
              mergeConversationThreads(hydrated, prev, pendingMsgIdsRef.current, deletedConvIdsRef.current, pendingConvIdsRef.current),
            );
          }),
        );
      }
      if (unique.includes('terminals')) {
        addTask('terminals',
          safeFetchJson('/api/py/terminal/history', { timeoutMs: 12000 }).then((r) => {
            if (!r.ok || !r.data?.ok || !r.data.terminalLogs) {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            advanceServerRevision(r.data.serverRevision);
            setTerminalLogsByTab((prev) => ({ ...prev, ...r.data.terminalLogs }));
          }),
        );
      }
      if (unique.includes('workspace')) {
        addTask('workspace',
          safeFetchJson('/api/py/workspace/state', { timeoutMs: 12000 }).then((r) => {
            if (!r.ok || !r.data?.ok || !r.data.workspaceState) {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            advanceServerRevision(r.data.serverRevision);
            const ws = r.data.workspaceState as any;
            setWorkspaceState(ws);
            const rawConv = ws.active_conversation_id?.value ?? ws.active_conversation_id;
            refreshedActiveConversation = rawConv;
            const rawTarget = ws.selected_target_agent?.value ?? ws.selected_target_agent;
            if (rawTarget === 'Auto' || rawTarget === 'Rodzina Mitek' || rawTarget === 'Agata') {
              setTargetAgentState(rawTarget);
            }
            const rawPanel = ws.selected_agent_panel_id?.value ?? ws.selected_agent_panel_id;
            if (rawPanel === 'Agata') {
              setSelectedAgentPanelState(rawPanel);
            }
          }),
        );
      }

      const results = await Promise.allSettled(tasks);
      const failures = results.flatMap((result, index) => {
        if (result.status !== 'rejected') return [];
        const detail = result.reason instanceof Error ? result.reason.message : String(result.reason);
        return [`${taskDomains[index]}: ${detail}`];
      });
      if (failures.length > 0) {
        return { ok: false, error: failures.join('; ') };
      }

      if (refreshedActiveConversation !== undefined) {
        const knownConversationIds = refreshedConversationIds ??
          new Set(conversationsRef.current.map((conversation) => conversation.id));
        if (
          typeof refreshedActiveConversation === 'string' &&
          refreshedActiveConversation &&
          !REMOVED_AGENT_CONVERSATION_IDS.has(refreshedActiveConversation) &&
          knownConversationIds.has(refreshedActiveConversation)
        ) {
          setActiveConvIdState(refreshedActiveConversation);
        }
      }

      setLastSyncedAt(new Date().toLocaleTimeString('pl-PL', { hour12: false }));
      return { ok: true };
    },
    [advanceServerRevision],
  );

  const refreshAllDomains = useCallback(
    async (_reason = 'operator_refresh'): Promise<RefreshExecutionReport> => {
      if (inflightRefreshRef.current) return inflightRefreshRef.current;

      const task = (async (): Promise<RefreshExecutionReport> => {
        const startedAt = performance.now();
        setIsSyncing(true);
        try {
          const result = await refreshDomainModules([
            'health',
            'kernel',
            'agents',
            'chat',
            'terminals',
            'workspace',
            'modules',
            'notifications',
            'avatars',
          ]);
          const report: RefreshExecutionReport = {
            ok: result.ok,
            serverRevision: serverRevisionRef.current,
            timestamp: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startedAt),
            ...(result.error ? { error: result.error } : {}),
          };
          setLastRefreshReport(report);
          return report;
        } finally {
          setIsSyncing(false);
          inflightRefreshRef.current = null;
        }
      })();

      inflightRefreshRef.current = task;
      return task;
    },
    [refreshDomainModules],
  );

  // Coalesced domain refresh queue for incoming outbox events
  const queuedDomainsRef = useRef<Set<'health' | 'kernel' | 'agents' | 'chat' | 'terminals' | 'workspace' | 'modules' | 'notifications' | 'avatars'>>(new Set());
  const domainFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleDomainRefresh = useCallback(
    (domains: Array<'health' | 'kernel' | 'agents' | 'chat' | 'terminals' | 'workspace' | 'modules' | 'notifications' | 'avatars'>) => {
      for (const d of domains) queuedDomainsRef.current.add(d);
      if (domainFlushTimerRef.current) return;
      domainFlushTimerRef.current = setTimeout(() => {
        domainFlushTimerRef.current = null;
        const batch = Array.from(queuedDomainsRef.current);
        queuedDomainsRef.current.clear();
        if (batch.length > 0) {
          void refreshDomainModules(batch).then((report) => {
            if (!report.ok) void refreshAllDomains('domain_refresh_failed');
          });
        }
      }, 25);
    },
    [refreshDomainModules, refreshAllDomains],
  );

  const applySyncEvent = useCallback(
    (evt: SvlSyncEvent) => {
      if (!evt || typeof evt !== 'object' || !evt.eventId) return;
      const isNew = recordSeenEventId(evt.eventId);
      if (!isNew) return;

      const incomingSrvRev = Number(evt.serverRevision || 0);
      if (serverRevisionRef.current > 0 && incomingSrvRev > serverRevisionRef.current + 1) {
        // A missing event requires refreshing current server domains.
        advanceServerRevision(incomingSrvRev);
        void refreshAllDomains('sequence_gap_catchup');
        return;
      }
      advanceServerRevision(incomingSrvRev);
      setLastSyncedAt(new Date().toLocaleTimeString('pl-PL', { hour12: false }));

      // Apply immediate deterministic deltas where safe
      if (evt.entity === 'terminal') {
        const tab = (evt.entityId || evt.payload?.tab) as TerminalTabId;
        if (evt.type === 'terminal.cleared' && tab) {
          setTerminalLogsByTab((prev) => ({ ...prev, [tab]: [] }));
          return;
        }
        if (evt.type === 'terminal.logged' && evt.payload?.entry && tab) {
          const entry = evt.payload.entry as TerminalLogLine;
          setTerminalLogsByTab((prev) => {
            const existing = prev[tab] || [];
            if (existing.some((line) => line.id === entry.id)) return prev;
            return { ...prev, [tab]: [...existing, entry].slice(-250) };
          });
          return;
        }
        scheduleDomainRefresh(['terminals']);
        return;
      }

      if (evt.entity === 'chat') {
        if (evt.type === 'chat.all_cleared') {
          pendingMsgIdsRef.current.clear();
          pendingConvIdsRef.current.clear();
          deletedConvIdsRef.current.clear();
          setConversations(INITIAL_WELCOME_CONVERSATIONS);
          try { localStorage.removeItem(CONVERSATIONS_CACHE_KEY); } catch { /* unavailable */ }
          scheduleDomainRefresh(['chat']);
          return;
        }
        if (
          (evt.type === 'chat.thread_deleted' || evt.type === 'chat.conversation_deleted') &&
          evt.entityId
        ) {
          deletedConvIdsRef.current.add(evt.entityId);
          setConversations((prev) => prev.filter((c) => c.id !== evt.entityId));
        }
        if (evt.origin !== tabOrigin) {
          scheduleDomainRefresh(['chat']);
        }
        return;
      }

      if (evt.entity === 'module') {
        if (evt.type === 'module.deleted' && evt.entityId) {
          setSystemModules((prev) => prev.filter((m) => m.id !== evt.entityId));
        }
        scheduleDomainRefresh(['modules', 'kernel']);
        return;
      }

      if (evt.entity === 'workspace_state') {
        const key = evt.entityId;
        const val = evt.payload?.value;
        setWorkspaceState((prev) => ({
          ...prev,
          [key]: val,
          revisions: { ...(prev.revisions || {}), [key]: evt.revision },
        }));
        if (key === 'active_conversation_id' && typeof val === 'string' && val && !REMOVED_AGENT_CONVERSATION_IDS.has(val)) {
          setActiveConvIdState(val);
        } else if (
          key === 'selected_target_agent' &&
          ['Auto', 'Rodzina Mitek', 'Agata'].includes(String(val))
        ) {
          setTargetAgentState(val);
        } else if (
          key === 'selected_agent_panel_id' &&
          ['Agata'].includes(String(val))
        ) {
          setSelectedAgentPanelState(val);
        }
        return;
      }

      if (evt.entity === 'agent_config' || evt.entity === 'agent_memory' || evt.entity === 'agent_runtime' || evt.entity === 'agent_task') {
        scheduleDomainRefresh(['agents']);
        return;
      }

      if (evt.entity === 'ollama') {
        scheduleDomainRefresh(['health', 'agents']);
        return;
      }

      if (evt.entity === 'kernel') {
        scheduleDomainRefresh(['kernel', 'health']);
        return;
      }

      if (evt.entity === 'notification') {
        scheduleDomainRefresh(['notifications', 'chat']);
        return;
      }

      if (evt.entity === 'avatar') {
        scheduleDomainRefresh(['avatars']);
        return;
      }

      if (evt.entity === 'system' && evt.origin !== tabOrigin) {
        void refreshAllDomains('remote_system_mutation');
        return;
      }

      scheduleDomainRefresh(['health', 'kernel', 'agents', 'chat', 'terminals', 'workspace', 'modules', 'notifications', 'avatars']);
    },
    [advanceServerRevision, recordSeenEventId, refreshAllDomains, scheduleDomainRefresh, tabOrigin],
  );

  const catchUpFromEvents = useCallback(
    async (sourceReason = 'signal') => {
      if (inflightCatchupRef.current) return inflightCatchupRef.current;
      const run = (async () => {
        try {
          let res = await safeFetchJson<{
            ok: boolean;
            serverRevision: number;
            events: SvlSyncEvent[];
            gapDetected?: boolean;
            hasMore?: boolean;
          }>(`/api/py/sync/events?sinceRevision=${serverRevisionRef.current}&limit=100`, { timeoutMs: 12000 });
          let hasMore = Boolean(res.data?.hasMore);
          if (res.ok && res.data?.ok) {
            let pages = 0;
            while (true) {
              if (res.data.gapDetected) {
                await refreshAllDomains(`${sourceReason}_gap`);
                return;
              }
              const evts = Array.isArray(res.data.events) ? res.data.events : [];
              const beforeRevision = serverRevisionRef.current;
              for (const ev of evts) applySyncEvent(ev);
              hasMore = Boolean(res.data.hasMore);

              if (!hasMore) {
                advanceServerRevision(res.data.serverRevision);
                return;
              }

              if (serverRevisionRef.current <= beforeRevision || evts.length === 0) {
                await refreshAllDomains(`${sourceReason}_pagination_stalled`);
                return;
              }

              pages += 1;
              if (pages >= 20) break;
              res = await safeFetchJson<{
                ok: boolean;
                serverRevision: number;
                events: SvlSyncEvent[];
                gapDetected?: boolean;
                hasMore?: boolean;
              }>(
                `/api/py/sync/events?sinceRevision=${serverRevisionRef.current}&limit=100`,
                { timeoutMs: 12000 },
              );
              if (!res.ok || !res.data?.ok) return;
            }

            if (hasMore) {
              setTimeout(() => void catchUpFromEvents(`${sourceReason}_pagination`), 0);
            }
          }
        } finally {
          inflightCatchupRef.current = null;
        }
      })();
      inflightCatchupRef.current = run;
      return run;
    },
    [advanceServerRevision, applySyncEvent, refreshAllDomains],
  );

  // Load each server domain independently on boot.
  useEffect(() => {
    void refreshAllDomains('boot_initial_load');
  }, [refreshAllDomains]);

  // Cross-tab BroadcastChannel + localStorage 'storage' event fallback (signal-only)
  useEffect(() => {
    let bcCatchupTimer: ReturnType<typeof setTimeout> | null = null;

    const handleSignal = (raw: any) => {
      if (!raw || typeof raw !== 'object') return;
      if (raw.origin === tabOrigin) return;
      const dedupeKey = raw.signalId || raw.eventId;
      if (dedupeKey && !recordSeenSignalId(String(dedupeKey))) return;
      if (bcCatchupTimer) clearTimeout(bcCatchupTimer);
      bcCatchupTimer = setTimeout(() => {
        void catchUpFromEvents('cross_tab_signal');
      }, 110);
    };

    let bc: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      broadcastChannelRef.current = bc;
      bc.onmessage = (evt) => handleSignal(evt.data);
    }

    const onStorage = (evt: StorageEvent) => {
      if (evt.key !== STORAGE_SIGNAL_KEY || !evt.newValue) return;
      try {
        handleSignal(JSON.parse(evt.newValue));
      } catch {
        // ignore invalid storage payload
      }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      if (bcCatchupTimer) clearTimeout(bcCatchupTimer);
      window.removeEventListener('storage', onStorage);
      bc?.close();
      broadcastChannelRef.current = null;
    };
  }, [catchUpFromEvents, recordSeenSignalId, tabOrigin]);

  // Hardened Application WebSocket (/ws/svl) with handshake, heartbeat, backoff+jitter & gap recovery
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let unmounted = false;
    let consecutiveFailures = 0;
    let lastServerActivityAt = Date.now();
    const MAX_RAPID_ATTEMPTS = 10;

    const clearTimers = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (unmounted) return;
      if (!getSvlOperatorAccessToken()) {
        setWsState('offline');
        setWsLastError('Do synchronizacji WebSocket wymagany jest SVL_OPERATOR_TOKEN.');
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setWsState('offline');
        setWsLastError('Brak połączenia sieciowego przeglądarki (navigator.onLine = false).');
        return;
      }
      consecutiveFailures += 1;
      setWsAttempt(consecutiveFailures);
      if (consecutiveFailures > MAX_RAPID_ATTEMPTS) {
        setWsState('offline');
        setWsLastError('Przekroczono limit prób reconnect /ws/svl. Kliknij „Synchronizuj aplikację” lub wznów połączenie.');
        return;
      }
      setWsState('reconnecting');
      const baseMs = Math.min(30000, 1000 * Math.pow(1.75, consecutiveFailures - 1));
      const jitterMs = Math.round(Math.random() * 600);
      reconnectTimer = setTimeout(connect, baseMs + jitterMs);
    };

    const connect = () => {
      if (unmounted) return;
      clearTimers();
      // Detach first: the old onclose handler must never schedule a second
      // reconnect for a connection being deliberately replaced.
      const previousSocket = ws;
      ws = null;
      if (previousSocket && previousSocket.readyState < WebSocket.CLOSING) {
        try { previousSocket.close(1000, 'Reconnect'); } catch { /* already closed */ }
      }
      const operatorSecret = getSvlOperatorAccessToken();
      if (!operatorSecret) {
        setWsState('offline');
        setWsLastError('Wpisz SVL_OPERATOR_TOKEN, aby włączyć synchronizację WebSocket.');
        return;
      }
      setWsState(consecutiveFailures === 0 ? 'connecting' : 'reconnecting');

      try {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const revParam = serverRevisionRef.current;
        const url = `${proto}//${window.location.host}/ws/svl?origin=${encodeURIComponent(tabOrigin)}&lastRevision=${revParam}`;
        const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(operatorSecret)))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
        const protocols = ['svl-v1', `svl-auth.${encoded}`];
        ws = new WebSocket(url, protocols);
      } catch (err: any) {
        setWsLastError(err?.message || 'Nie udało się utworzyć WebSocket /ws/svl.');
        scheduleReconnect();
        return;
      }

      const activeSocket = ws;

      activeSocket.onopen = () => {
        lastServerActivityAt = Date.now();
        // Wait for svl.hello handshake before marking 'online'
        heartbeatTimer = setInterval(() => {
          if (activeSocket.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastServerActivityAt > 52000) {
            setWsLastError('Timeout heartbeat WebSocket /ws/svl (brak pong > 52s).');
            try {
              activeSocket.close(4000, 'Heartbeat timeout');
            } catch {
              // ignore
            }
            return;
          }
          try {
            activeSocket.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() }));
          } catch {
            // ignore
          }
        }, 20000);
      };

      activeSocket.onmessage = (evt) => {
        lastServerActivityAt = Date.now();
        let frame: any;
        try {
          frame = JSON.parse(String(evt.data || '{}'));
        } catch {
          return;
        }
        if (!frame || typeof frame !== 'object') return;

        if (frame.type === 'svl.hello') {
          const wasReconnect = consecutiveFailures > 0;
          consecutiveFailures = 0;
          setWsAttempt(0);
          setWsLastError(null);
          setWsState('online');
          if (frame.schemaVersion) setSchemaVersion(String(frame.schemaVersion));
          const srvRev = Number(frame.serverRevision || 0);
          if (srvRev > serverRevisionRef.current && serverRevisionRef.current === 0) {
            void refreshAllDomains('ws_hello_initial');
          } else if (wasReconnect && srvRev > serverRevisionRef.current) {
            void catchUpFromEvents('ws_reconnect_hello');
          }
          return;
        }

        if (frame.type === 'svl.ping') {
          try {
            activeSocket.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          } catch {
            // ignore
          }
          advanceServerRevision(frame.serverRevision);
          return;
        }

        if (frame.type === 'pong') {
          advanceServerRevision(frame.serverRevision);
          return;
        }

        if (frame.type === 'svl.catchup') {
          const evts = Array.isArray(frame.events) ? frame.events : [];
          for (const ev of evts) {
            applySyncEvent(ev);
          }
          if (frame.hasMore) {
            void catchUpFromEvents('ws_catchup_pagination');
          } else {
            advanceServerRevision(frame.serverRevision);
          }
          return;
        }

        if (frame.type === 'svl.resync_required') {
          void refreshAllDomains(`ws_${frame.reason || 'resync_required'}`);
          return;
        }

        if (frame.type === 'svl.event') {
          applySyncEvent(frame as SvlSyncEvent);
          return;
        }

        if (frame.type === 'svl.error') {
          setWsLastError(String(frame.message || frame.code || 'Błąd ramki /ws/svl'));
        }
      };

      activeSocket.onerror = () => {
        setWsLastError('Błąd połączenia WebSocket /ws/svl.');
      };

      activeSocket.onclose = (ev) => {
        // A deliberate reconnect must not spawn an extra reconnect timer from
        // the old socket, otherwise multiple parallel sockets can be created.
        if (ws !== activeSocket) return;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (unmounted) return;
        if (ev.reason) {
          setWsLastError(ev.reason);
        }
        scheduleReconnect();
      };
    };

    wsReconnectNowRef.current = () => {
      consecutiveFailures = 0;
      setWsAttempt(0);
      setWsLastError(null);
      // connect() deliberately closes any existing socket and detaches its
      // old close handler. Avoid a parallel reconnect timer.
      connect();
    };

    const onBrowserOnline = () => {
      consecutiveFailures = 0;
      setWsAttempt(0);
      setWsLastError(null);
      connect();
      void catchUpFromEvents('browser_online');
    };
    const onBrowserOffline = () => {
      setWsState('offline');
      setWsLastError('Przeglądarka jest w trybie offline.');
    };
    window.addEventListener('online', onBrowserOnline);
    window.addEventListener('offline', onBrowserOffline);

    connect();

    return () => {
      unmounted = true;
      wsReconnectNowRef.current = null;
      window.removeEventListener('online', onBrowserOnline);
      window.removeEventListener('offline', onBrowserOffline);
      clearTimers();
      try {
        ws?.close(1000, 'Unmount');
      } catch {
        // ignore
      }
    };
  }, [advanceServerRevision, applySyncEvent, catchUpFromEvents, refreshAllDomains, tabOrigin]);

  // Low-frequency fallback heartbeat only when WS is offline/reconnecting (avoids redundant polling when online)
  useEffect(() => {
    if (wsState === 'online') return;
    const timer = setInterval(() => {
      void refreshDomainModules(['health', 'agents']);
    }, 15000);
    return () => clearInterval(timer);
  }, [refreshDomainModules, wsState]);

  const reconnectWebSocket = useCallback(() => {
    wsReconnectNowRef.current?.();
  }, []);

  const notifyLocalMutation = useCallback(
    (entity: string, entityId: string, srvRev?: number, event?: SvlSyncEvent | null) => {
      if (event) {
        recordSeenEventId(event.eventId);
        advanceServerRevision(event.serverRevision);
      } else if (srvRev) {
        advanceServerRevision(srvRev);
      }
      setLastSyncedAt(new Date().toLocaleTimeString('pl-PL', { hour12: false }));
      emitCrossTabSignal(entity, entityId, srvRev || event?.serverRevision, event?.eventId);
    },
    [advanceServerRevision, emitCrossTabSignal, recordSeenEventId],
  );

  const persistWorkspaceKey = useCallback(
    async (key: 'active_conversation_id' | 'selected_target_agent' | 'selected_agent_panel_id', value: string) => {
      const eventId = createUniqueId('ws-state');
      const res = await safeFetchJson<{
        ok: boolean;
        serverRevision?: number;
        revision?: number;
        event?: SvlSyncEvent;
        workspaceState?: WorkspaceUiState;
      }>('/api/py/workspace/state', {
        method: 'POST',
        timeoutMs: 10000,
        body: JSON.stringify({
          key,
          value,
          origin: tabOrigin,
          eventId,
        }),
      });
      if (res.ok && res.data?.ok) {
        if (res.data.workspaceState) setWorkspaceState(res.data.workspaceState);
        notifyLocalMutation('workspace_state', key, res.data.serverRevision, res.data.event);
      }
    },
    [notifyLocalMutation, tabOrigin],
  );

  const setActiveConvId = useCallback(
    (convId: string) => {
      if (REMOVED_AGENT_CONVERSATION_IDS.has(convId)) return;
      setActiveConvIdState(convId);
      void persistWorkspaceKey('active_conversation_id', convId);
      if (convId === 'conv-rodzina-mitek-wszyscy') {
        setTargetAgentState('Rodzina Mitek');
        void persistWorkspaceKey('selected_target_agent', 'Rodzina Mitek');
      } else if (convId === 'conv-agent-agata') {
        setTargetAgentState('Agata');
        void persistWorkspaceKey('selected_target_agent', 'Agata');
      }
    },
    [persistWorkspaceKey],
  );

  const openAgentChannel = useCallback(
    (agent: 'Agata') => {
      const slug = agent.toLowerCase();
      const convId = `conv-agent-${slug}`;
      const displayName = `${agent} Mitek`;
      deletedConvIdsRef.current.delete(convId);
      const exists = conversationsRef.current.some((c) => c.id === convId);
      if (!exists) {
        const nowTime = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
        const newConv: SyncableConversation = {
          id: convId,
          title: `${displayName} (1-na-1)`,
          updatedAt: nowTime,
          revision: 1,
          messages: [],
        };
        setConversations((prev) => [newConv, ...prev]);
      }
      setActiveConvIdState(convId);
      setTargetAgentState(agent);
      void persistWorkspaceKey('active_conversation_id', convId);
      void persistWorkspaceKey('selected_target_agent', agent);
    },
    [persistWorkspaceKey],
  );

  const setTargetAgent = useCallback(
    (agent: 'Auto' | 'Rodzina Mitek' | 'Agata') => {
      setTargetAgentState(agent);
      void persistWorkspaceKey('selected_target_agent', agent);
    },
    [persistWorkspaceKey],
  );

  const setSelectedAgentPanel = useCallback(
    (agent: 'Agata') => {
      setSelectedAgentPanelState(agent);
      void persistWorkspaceKey('selected_agent_panel_id', agent);
    },
    [persistWorkspaceKey],
  );

  const openFamilyChannel = useCallback(() => {
    const familyConvId = 'conv-rodzina-mitek-wszyscy';
    deletedConvIdsRef.current.delete(familyConvId);
    const exists = conversationsRef.current.some((c) => c.id === familyConvId);
    if (!exists) {
      const template = INITIAL_WELCOME_CONVERSATIONS[0];
      setConversations((prev) => [template, ...prev]);
    }
    setActiveConvIdState(familyConvId);
    setTargetAgentState('Rodzina Mitek');
    void persistWorkspaceKey('active_conversation_id', familyConvId);
    void persistWorkspaceKey('selected_target_agent', 'Rodzina Mitek');
  }, [persistWorkspaceKey]);

  const appendAndPersistChatMessage = useCallback(
    async (convId: string, convTitle: string, model: string, msg: SyncableMessage) => {
      pendingMsgIdsRef.current.add(msg.id);
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== convId) return c;
          if (c.messages.some((existing) => existing.id === msg.id)) return c;
          return {
            ...c,
            title: getCanonicalConversationTitle(convId, convTitle),
            updatedAt: msg.timestamp,
            messages: [...c.messages, msg],
          };
        }),
      );

      const eventId = createUniqueId('evt-msg');
      try {
        // The SQLite store deduplicates on msg.id. A retry with the same
        // message and event identifiers cannot create a second chat entry.
        const payload = JSON.stringify({
          conversation_id: convId,
          title: convTitle,
          model,
          message: msg,
          origin: tabOrigin,
          eventId,
        });
        const persistOnce = () => safeFetchJson<{
          ok: boolean;
          revision?: number;
          serverRevision?: number;
          event?: SvlSyncEvent;
          conversations?: any[];
          error?: string;
        }>('/api/py/chat/conversations/message', {
          method: 'POST',
          timeoutMs: 15000,
          maxRetries: 0,
          body: payload,
        });
        let res = await persistOnce();
        const transient = !res.ok &&
          (res.status === 0 || res.status === 502 || res.status === 503 || res.status === 504);
        if (transient && pendingMsgIdsRef.current.has(msg.id)) {
          await new Promise<void>((resolve) => setTimeout(resolve, 450));
          // A server-side clear-all invalidates pending messages. Never replay
          // old writes into an intentionally emptied conversation.
          if (pendingMsgIdsRef.current.has(msg.id)) {
            res = await persistOnce();
          }
        }

        if (res.ok && res.data?.ok) {
          if (Array.isArray(res.data.conversations)) {
            const hydrated = normalizeConversationsFromServer(res.data.conversations);
            for (const conversation of hydrated) {
              deletedConvIdsRef.current.delete(conversation.id);
            }
            setConversations((prev) =>
              mergeConversationThreads(hydrated, prev, pendingMsgIdsRef.current, deletedConvIdsRef.current, pendingConvIdsRef.current),
            );
          }
          pendingConvIdsRef.current.delete(convId);
          notifyLocalMutation('chat', convId, res.data.serverRevision, res.data.event);
          return { ok: true };
        }

        // Roll back optimistic message on failed persistence instead of showing ghost messages.
        setConversations((prev) => prev.map((c) =>
          c.id === convId ? { ...c, messages: c.messages.filter((entry) => entry.id !== msg.id) } : c,
        ));
        return { ok: false, error: res.error || res.data?.error || `Błąd zapisu wiadomości HTTP ${res.status}` };
      } catch (error: any) {
        setConversations((prev) => prev.map((c) =>
          c.id === convId ? { ...c, messages: c.messages.filter((entry) => entry.id !== msg.id) } : c,
        ));
        return { ok: false, error: error?.message || String(error) };
      } finally {
        pendingMsgIdsRef.current.delete(msg.id);
      }
    },
    [notifyLocalMutation, tabOrigin],
  );

  const createConversation = useCallback((): SyncableConversation => {
    const newId = createUniqueId('conv');
    const nowTime = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    // New sessions do not create synthetic greeting messages.
    const newThread: SyncableConversation = {
      id: newId,
      title: `Nowa sesja (${nowTime})`,
      updatedAt: nowTime,
      revision: 1,
      messages: [],
    };
    pendingConvIdsRef.current.add(newId);
    setConversations((prev) => [newThread, ...prev]);
    setActiveConvId(newId);
    void safeFetchJson<{ok: boolean; serverRevision?: number; event?: SvlSyncEvent}>(
      '/api/py/chat/conversations/create',
      {
        method: 'POST',
        timeoutMs: 12000,
        body: JSON.stringify({
          conversation_id: newId,
          title: newThread.title,
          model: 'svl-hybrid-router',
          origin: tabOrigin,
          eventId: createUniqueId('evt-create-conv'),
        }),
      },
    ).then((response) => {
      if (response.ok && response.data?.ok) {
        pendingConvIdsRef.current.delete(newId);
        notifyLocalMutation('chat', newId, response.data.serverRevision, response.data.event);
      } else {
        // The operator can still type and the next message can create the thread.
        // Do not silently discard the selected conversation on a stale domain response.
        console.warn('[SVL] Zapis pustej sesji nie powiódł się; zachowuję lokalną sesję do pierwszej wiadomości.');
      }
    });
    return newThread;
  }, [notifyLocalMutation, setActiveConvId, tabOrigin]);

  const deleteConversation = useCallback(
    async (convId: string) => {
      if (conversationsRef.current.length <= 1) {
        return { ok: false, error: 'Nie można usunąć ostatniej aktywnej sesji.' };
      }
      // SQLite is authoritative: do not hide or blacklist a thread before
      // the backend confirms that it has actually been deleted.
      const eventId = createUniqueId('evt-del');
      const res = await safeFetchJson<{
        ok: boolean;
        serverRevision?: number;
        event?: SvlSyncEvent;
        conversations?: any[];
        error?: string;
      }>('/api/py/chat/conversations/delete', {
        method: 'POST',
        timeoutMs: 12000,
        body: JSON.stringify({
          conversation_id: convId,
          origin: tabOrigin,
          eventId,
        }),
      });

      if (res.ok && res.data?.ok) {
        pendingConvIdsRef.current.delete(convId);
        deletedConvIdsRef.current.add(convId);
        const remaining = conversationsRef.current.filter((c) => c.id !== convId);
        setConversations((prev) => prev.filter((c) => c.id !== convId));
        if (activeConvIdState === convId && remaining[0]) {
          setActiveConvId(remaining[0].id);
        }
        if (Array.isArray(res.data.conversations)) {
          const hydrated = normalizeConversationsFromServer(res.data.conversations);
          for (const conversation of hydrated) {
            deletedConvIdsRef.current.delete(conversation.id);
          }
          setConversations((prev) =>
            mergeConversationThreads(hydrated, prev, pendingMsgIdsRef.current, deletedConvIdsRef.current, pendingConvIdsRef.current),
          );
        }
        notifyLocalMutation('chat', convId, res.data.serverRevision, res.data.event);
        return { ok: true };
      }
      return { ok: false, error: res.error || res.data?.error || 'Nie udało się usunąć sesji w bazie SQLite.' };
    },
    [activeConvIdState, notifyLocalMutation, setActiveConvId, tabOrigin],
  );

  const clearAllConversationsAndBuffers = useCallback(async () => {
    const accessToken = getSvlOperatorAccessToken();
    // SQLite is authoritative. Until the server confirms the destructive action
    // do NOT erase messages or the pending-write tracking sets.
    const eventId = createUniqueId('evt-clear-all');
    const res = await safeFetchJson<{
      ok: boolean;
      conversations?: any[];
      serverRevision?: number;
      error?: string;
    }>('/api/py/chat/conversations/clear-all', {
      method: 'POST',
      timeoutMs: 12000,
      headers: accessToken ? { 'X-SVL-Operator-Token': accessToken } : {},
      body: JSON.stringify({ origin: tabOrigin, eventId }),
    });

    if (res.ok && res.data?.ok && Array.isArray(res.data.conversations)) {
      pendingConvIdsRef.current.clear();
      pendingMsgIdsRef.current.clear();
      deletedConvIdsRef.current.clear();
      const hydrated = normalizeConversationsFromServer(res.data.conversations);
      setConversations(hydrated);
      setActiveConvIdState('conv-rodzina-mitek-wszyscy');
      setTargetAgentState('Rodzina Mitek');
      try { localStorage.removeItem(CONVERSATIONS_CACHE_KEY); } catch { /* unavailable */ }
      notifyLocalMutation('chat', 'all', res.data.serverRevision);
      return { ok: true };
    }
    // On transport failure / 401, preserve the untouched local state.
    return { ok: false, error: res.data?.error || res.error || 'Nie udało się wyczyścić rozmów w SQLite.' };
  }, [notifyLocalMutation, tabOrigin]);

  const clearTerminalTab = useCallback(
    async (tab: TerminalTabId) => {
      const eventId = createUniqueId('evt-tclr');
      const res = await safeFetchJson<{
        ok: boolean;
        serverRevision?: number;
        event?: SvlSyncEvent;
        error?: string;
      }>('/api/py/terminal/clear', {
        method: 'POST',
        timeoutMs: 10000,
        body: JSON.stringify({
          tab,
          origin: tabOrigin,
          eventId,
        }),
      });
      if (res.ok && res.data?.ok) {
        setTerminalLogsByTab((prev) => ({ ...prev, [tab]: [] }));
        notifyLocalMutation('terminal', tab, res.data.serverRevision, res.data.event);
        return { ok: true };
      }
      return { ok: false, error: res.error || res.data?.error || 'Nie udało się wyczyścić historii terminala.' };
    },
    [notifyLocalMutation, tabOrigin],
  );

  const refreshTerminals = useCallback(async () => {
    await refreshDomainModules(['terminals', 'agents', 'health']);
  }, [refreshDomainModules]);

  const connectMyAi = useCallback(
    async (triggeredBy = 'operator_header_cta') => {
      setIsConnectingAi(true);
      try {
        const res = await safeFetchJson<any>('/api/py/agents/connect', {
          method: 'POST',
          timeoutMs: 25000,
          body: JSON.stringify({
            triggered_by: triggeredBy,
            origin: tabOrigin,
          }),
        });
        await refreshDomainModules(['agents', 'health', 'kernel']);
        if (res.ok && res.data?.ok) {
          notifyLocalMutation('agent_runtime', 'all', res.data.serverRevision);
          return res.data;
        }
        return res.data || { ok: false, error: res.error };
      } finally {
        setIsConnectingAi(false);
      }
    },
    [notifyLocalMutation, refreshDomainModules, tabOrigin],
  );

  const upsertSystemModule = useCallback(
    async (mod: {
      id: string;
      name: string;
      kind?: string;
      status?: string;
      description?: string;
      config?: Record<string, any>;
    }) => {
      const eventId = createUniqueId('evt-mod');
      const res = await safeFetchJson<{
        ok: boolean;
        module?: SystemModule;
        modules?: SystemModule[];
        serverRevision?: number;
        event?: SvlSyncEvent;
        error?: string;
      }>('/api/py/modules/upsert', {
        method: 'POST',
        timeoutMs: 12000,
        body: JSON.stringify({
          ...mod,
          source: 'ui',
          origin: tabOrigin,
          eventId,
        }),
      });
      if (res.ok && res.data?.ok) {
        if (Array.isArray(res.data.modules)) setSystemModules(res.data.modules);
        notifyLocalMutation('module', mod.id, res.data.serverRevision, res.data.event);
        await refreshDomainModules(['modules', 'kernel']);
        return { ok: true, module: res.data.module };
      }
      return { ok: false, error: res.error || res.data?.error || 'Nie udało się zapisać modułu.' };
    },
    [notifyLocalMutation, refreshDomainModules, tabOrigin],
  );

  const deleteSystemModule = useCallback(
    async (modId: string) => {
      const eventId = createUniqueId('evt-mdel');
      const res = await safeFetchJson<{
        ok: boolean;
        modules?: SystemModule[];
        serverRevision?: number;
        event?: SvlSyncEvent;
        error?: string;
      }>('/api/py/modules/delete', {
        method: 'POST',
        timeoutMs: 12000,
        body: JSON.stringify({
          id: modId,
          origin: tabOrigin,
          eventId,
        }),
      });
      if (res.ok && res.data?.ok) {
        if (Array.isArray(res.data.modules)) setSystemModules(res.data.modules);
        notifyLocalMutation('module', modId, res.data.serverRevision, res.data.event);
        await refreshDomainModules(['modules', 'kernel']);
        return { ok: true };
      }
      return { ok: false, error: res.error || res.data?.error || 'Nie udało się usunąć modułu.' };
    },
    [notifyLocalMutation, refreshDomainModules, tabOrigin],
  );

  const emitIrisNotification = useCallback(
    async (payload: {
      severity?: 'INFO' | 'WARN' | 'ALERT';
      category?: string;
      title: string;
      message?: string;
      details?: Record<string, any>;
      mirrorToFamilyChat?: boolean;
    }) => {
      const eventId = createUniqueId('evt-iris');
      const res = await safeFetchJson<{
        ok: boolean;
        notification?: IrisNotification;
        serverRevision?: number;
        event?: SvlSyncEvent;
        error?: string;
      }>('/api/py/notifications/emit', {
        method: 'POST',
        timeoutMs: 12000,
        body: JSON.stringify({
          ...payload,
          channel: 'wszyscy',
          origin: tabOrigin,
          eventId,
        }),
      });
      if (res.ok && res.data?.ok) {
        notifyLocalMutation('notification', res.data.notification?.id || 'iris', res.data.serverRevision, res.data.event);
        await refreshDomainModules(['notifications', 'chat']);
        return { ok: true, notification: res.data.notification };
      }
      return { ok: false, error: res.error || res.data?.error || 'Nie udało się wysłać powiadomienia Iris.' };
    },
    [notifyLocalMutation, refreshDomainModules, tabOrigin],
  );

  const ackIrisNotifications = useCallback(
    async (ids?: string[]) => {
      const res = await safeFetchJson<{
        ok: boolean;
        unreadCount?: number;
        serverRevision?: number;
        event?: SvlSyncEvent;
        error?: string;
      }>('/api/py/notifications/ack', {
        method: 'POST',
        timeoutMs: 10000,
        body: JSON.stringify({
          ids: Array.isArray(ids) ? ids : undefined,
          origin: tabOrigin,
        }),
      });
      if (res.ok && res.data?.ok) {
        notifyLocalMutation('notification', 'ack', res.data.serverRevision, res.data.event);
        await refreshDomainModules(['notifications']);
        return { ok: true, unreadCount: res.data.unreadCount };
      }
      return { ok: false, error: res.error || res.data?.error || 'Nie udało się potwierdzić powiadomień.' };
    },
    [notifyLocalMutation, refreshDomainModules, tabOrigin],
  );

  const saveAgentAvatar = useCallback(
    async (agent: AvatarProfileKey, image: string) => {
      const eventId = createUniqueId('evt-avatar');
      const res = await safeFetchJson<{
        ok: boolean;
        avatars?: SvlAvatarMap;
        serverRevision?: number;
        event?: SvlSyncEvent;
        error?: string;
      }>('/api/avatars', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({ agent, image, origin: tabOrigin, eventId }),
      });
      if (res.ok && res.data?.ok) {
        if (res.data.avatars) setAvatars(res.data.avatars);
        notifyLocalMutation('avatar', agent, res.data.serverRevision, res.data.event);
        return { ok: true, avatars: res.data.avatars };
      }
      return { ok: false, error: res.error || res.data?.error || 'Nie udało się zapisać awatara.' };
    },
    [notifyLocalMutation, tabOrigin],
  );

  const resetAgentAvatar = useCallback(
    async (agent: AvatarProfileKey) => {
      const res = await safeFetchJson<{
        ok: boolean;
        avatars?: SvlAvatarMap;
        serverRevision?: number;
        event?: SvlSyncEvent;
        error?: string;
      }>(`/api/avatars/${encodeURIComponent(agent)}`, {
        method: 'DELETE',
        timeoutMs: 12000,
      });
      if (res.ok && res.data?.ok) {
        if (res.data.avatars) setAvatars(res.data.avatars);
        notifyLocalMutation('avatar', agent, res.data.serverRevision, res.data.event);
        return { ok: true, avatars: res.data.avatars };
      }
      return { ok: false, error: res.error || res.data?.error || 'Nie udało się przywrócić awatara.' };
    },
    [notifyLocalMutation],
  );

  const value = useMemo<SvlSyncContextValue>(
    () => ({
      tabOrigin,
      wsState,
      wsAttempt,
      wsLastError,
      viteHmrDiagnostic,
      serverRevision,
      schemaVersion,
      lastSyncedAt,
      isSyncing,
      isConnectingAi,
      lastRefreshReport,
      healthData,
      kernelData,
      agentsData,
      systemModules,
      avatars,
      irisNotifications,
      irisUnreadCount,
      conversations,
      terminalLogsByTab,
      workspaceState,
      activeConvId: activeConvIdState,
      targetAgent: targetAgentState,
      selectedAgentPanel: selectedAgentPanelState,
      refreshAllDomains,
      refreshDomainModules,
      reconnectWebSocket,
      connectMyAi,
      setActiveConvId,
      setTargetAgent,
      setSelectedAgentPanel,
      openFamilyChannel,
      openAgentChannel,
      createConversation,
      deleteConversation,
      clearAllConversationsAndBuffers,
      appendAndPersistChatMessage,
      upsertSystemModule,
      deleteSystemModule,
      saveAgentAvatar,
      resetAgentAvatar,
      emitIrisNotification,
      ackIrisNotifications,
      clearTerminalTab,
      refreshTerminals,
      notifyLocalMutation,
    }),
    [
      ackIrisNotifications,
      activeConvIdState,
      agentsData,
      appendAndPersistChatMessage,
      avatars,
      clearAllConversationsAndBuffers,
      clearTerminalTab,
      connectMyAi,
      conversations,
      createConversation,
      deleteConversation,
      deleteSystemModule,
      emitIrisNotification,
      healthData,
      irisNotifications,
      irisUnreadCount,
      isConnectingAi,
      isSyncing,
      kernelData,
      lastRefreshReport,
      lastSyncedAt,
      notifyLocalMutation,
      openAgentChannel,
      openFamilyChannel,
      reconnectWebSocket,
      refreshDomainModules,
      refreshTerminals,
      resetAgentAvatar,
      saveAgentAvatar,
      schemaVersion,
      selectedAgentPanelState,
      serverRevision,
      setActiveConvId,
      setSelectedAgentPanel,
      setTargetAgent,
      systemModules,
      tabOrigin,
      targetAgentState,
      terminalLogsByTab,
      refreshAllDomains,
      upsertSystemModule,
      viteHmrDiagnostic,
      workspaceState,
      wsAttempt,
      wsLastError,
      wsState,
    ],
  );

  return <SvlSyncContext.Provider value={value}>{children}</SvlSyncContext.Provider>;
};

export function useSvlSync(): SvlSyncContextValue {
  const ctx = useContext(SvlSyncContext);
  if (!ctx) {
    throw new Error('useSvlSync must be used within SvlSyncProvider');
  }
  return ctx;
}
