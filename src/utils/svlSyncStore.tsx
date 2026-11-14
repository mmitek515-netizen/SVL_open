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
  SyncableConversation,
  SyncableMessage,
  SystemModule,
  SvlSyncEvent,
  SvlSyncModuleStatus,
  SvlSystemSnapshot,
  TerminalLogLine,
  TerminalTabId,
  WorkspaceUiState,
  WsConnectionState,
  createUniqueId,
  mergeConversationThreads,
  safeFetchJson,
} from './svlLogic';

const BROADCAST_CHANNEL_NAME = 'svl_python_os_sync';
const STORAGE_SIGNAL_KEY = 'svl_sync_signal_v1';
const CONVERSATIONS_CACHE_KEY = 'svl_python_os_conversations_v1';

const DEFAULT_TERMINAL_LOGS: Record<TerminalTabId, TerminalLogLine[]> = {
  linux: [],
  python: [],
  codex: [],
  hyperspace: [],
  agents: [],
};

export const INITIAL_WELCOME_CONVERSATIONS: SyncableConversation[] = [
  { id: 'conv-rodzina-mitek-wszyscy', title: 'Rodzina Mitek (wszyscy)', updatedAt: '', revision: 1, messages: [] },
  { id: 'conv-agent-aria', title: 'Aria Mitek (1-na-1)', updatedAt: '', revision: 1, messages: [] },
  { id: 'conv-agent-alex', title: 'Alex Mitek (1-na-1)', updatedAt: '', revision: 1, messages: [] },
  { id: 'conv-agent-astyria', title: 'Astyria Mitek (1-na-1)', updatedAt: '', revision: 1, messages: [] },
  { id: 'conv-agent-aurelius', title: 'Aurelius Mitek (1-na-1)', updatedAt: '', revision: 1, messages: [] },
  { id: 'conv-agent-agata', title: 'Agata Mitek (1-na-1)', updatedAt: '', revision: 1, messages: [] },
];

export interface SyncExecutionReport {
  ok: boolean;
  syncId?: string;
  schemaVersion?: string;
  serverRevision: number;
  timestamp: string;
  durationMs: number;
  warnings: string[];
  modules: Record<string, SvlSyncModuleStatus>;
  error: string | null;
}

export interface ViteHmrDiagnostic {
  hmrState: 'active' | 'disabled' | 'proxy_unavailable';
  hmrMessage?: string;
  detectedAt?: string;
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

export function getCanonicalConversationTitle(id: string, fallbackTitle?: string): string {
  if (id === 'conv-rodzina-mitek-wszyscy') return 'Rodzina Mitek (wszyscy)';
  if (id === 'conv-agent-aria') return 'Aria Mitek (1-na-1)';
  if (id === 'conv-agent-alex') return 'Alex Mitek (1-na-1)';
  if (id === 'conv-agent-astyria') return 'Astyria Mitek (1-na-1)';
  if (id === 'conv-agent-aurelius') return 'Aurelius Mitek (1-na-1)';
  if (id === 'conv-agent-agata') return 'Agata Mitek (1-na-1)';
  return fallbackTitle || 'Sesja SVL Python OS';
}

function normalizeConversationsFromServer(rawList: any[]): SyncableConversation[] {
  return (rawList || []).map((c: any) => {
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
  lastSyncReport: SyncExecutionReport | null;

  healthData: any;
  kernelData: any;
  agentsData: any;
  systemModules: SystemModule[];
  conversations: SyncableConversation[];
  terminalLogsByTab: Record<TerminalTabId, TerminalLogLine[]>;
  workspaceState: WorkspaceUiState;

  activeConvId: string;
  targetAgent: 'Auto' | 'Rodzina Mitek' | 'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata';
  selectedAgentPanel: 'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata';

  triggerFullSync: (reason?: string) => Promise<SyncExecutionReport>;
  refreshDomainModules: (modules: Array<'health' | 'kernel' | 'agents' | 'chat' | 'terminals' | 'workspace' | 'modules'>) => Promise<void>;
  reconnectWebSocket: () => void;
  connectMyAi: (triggeredBy?: string) => Promise<any>;

  setActiveConvId: (convId: string) => void;
  setTargetAgent: (agent: 'Auto' | 'Rodzina Mitek' | 'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata') => void;
  setSelectedAgentPanel: (agent: 'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata') => void;
  openFamilyChannel: () => void;
  openAgentChannel: (agent: 'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata') => void;

  createConversation: () => SyncableConversation;
  deleteConversation: (convId: string) => Promise<{ ok: boolean; error?: string }>;
  clearAllConversationsAndBuffers: () => Promise<{ ok: boolean; error?: string }>;
  appendAndPersistChatMessage: (convId: string, convTitle: string, model: string, msg: SyncableMessage) => Promise<{ ok: boolean; error?: string }>;
  upsertSystemModule: (mod: { id: string; name: string; kind?: string; status?: string; description?: string; config?: Record<string, any> }) => Promise<{ ok: boolean; module?: SystemModule; error?: string }>;
  deleteSystemModule: (modId: string) => Promise<{ ok: boolean; error?: string }>;
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
  const [lastSyncReport, setLastSyncReport] = useState<SyncExecutionReport | null>(null);

  const [healthData, setHealthData] = useState<any>(null);
  const [kernelData, setKernelData] = useState<any>(null);
  const [agentsData, setAgentsData] = useState<any>(null);
  const [systemModules, setSystemModules] = useState<SystemModule[]>([]);
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
    selected_target_agent: 'Auto',
    selected_agent_panel_id: 'Alex',
    revisions: {},
  });

  const [activeConvIdState, setActiveConvIdState] = useState<string>(
    () => conversations[0]?.id || 'conv-rodzina-mitek-wszyscy',
  );
  const [targetAgentState, setTargetAgentState] = useState<'Auto' | 'Rodzina Mitek' | 'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata'>('Auto');
  const [selectedAgentPanelState, setSelectedAgentPanelState] = useState<'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata'>('Alex');

  const pendingMsgIdsRef = useRef<Set<string>>(new Set());
  const deletedConvIdsRef = useRef<Set<string>>(new Set());
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const seenEventOrderRef = useRef<string[]>([]);
  const seenSignalIdsRef = useRef<Set<string>>(new Set());
  const seenSignalOrderRef = useRef<string[]>([]);
  const inflightSnapshotRef = useRef<Promise<SyncExecutionReport> | null>(null);
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

  const applyAuthoritativeSnapshot = useCallback(
    (snap: SvlSystemSnapshot) => {
      if (snap.schemaVersion) setSchemaVersion(snap.schemaVersion);
      advanceServerRevision(snap.serverRevision);

      if (Array.isArray(snap.deletedEntities)) {
        for (const ent of snap.deletedEntities) {
          if (ent.startsWith('chat:')) {
            deletedConvIdsRef.current.add(ent.slice('chat:'.length));
          }
        }
      }

      if (snap.health) setHealthData(snap.health);
      if (snap.kernel) setKernelData(snap.kernel);
      if (snap.agentsData) setAgentsData(snap.agentsData);
      const snapModules = Array.isArray(snap.systemModules)
        ? snap.systemModules
        : Array.isArray(snap.kernel?.system_modules)
          ? snap.kernel.system_modules
          : Array.isArray(snap.health?.system_modules)
            ? snap.health.system_modules
            : null;
      if (snapModules) setSystemModules(snapModules);

      if (Array.isArray(snap.conversations)) {
        const hydrated = normalizeConversationsFromServer(snap.conversations);
        setConversations((prev) =>
          mergeConversationThreads(hydrated.length ? hydrated : INITIAL_WELCOME_CONVERSATIONS, prev, pendingMsgIdsRef.current, deletedConvIdsRef.current),
        );
      }

      if (snap.terminalLogs) {
        setTerminalLogsByTab((prev) => {
          const next = { ...prev };
          (['linux', 'python', 'codex', 'hyperspace', 'agents'] as TerminalTabId[]).forEach((tab) => {
            if (Array.isArray(snap.terminalLogs?.[tab])) {
              next[tab] = snap.terminalLogs[tab];
            }
          });
          return next;
        });
      }

      if (snap.workspaceState) {
        setWorkspaceState(snap.workspaceState);
        const rawActiveConv =
          (snap.workspaceState.active_conversation_id as any)?.value ?? snap.workspaceState.active_conversation_id;
        const rawTargetAgent =
          (snap.workspaceState.selected_target_agent as any)?.value ?? snap.workspaceState.selected_target_agent;

        if (typeof rawActiveConv === 'string' && rawActiveConv) {
          setActiveConvIdState((prev) => {
            const existsInRemote = snap.conversations?.some((c) => c.id === rawActiveConv);
            return existsInRemote ? rawActiveConv : prev;
          });
          if (rawActiveConv === 'conv-rodzina-mitek-wszyscy') {
            setTargetAgentState('Rodzina Mitek');
          } else if (rawActiveConv.startsWith('conv-agent-')) {
            const slug = rawActiveConv.replace('conv-agent-', '').toLowerCase();
            const map: Record<string, 'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata'> = {
              aria: 'Aria',
              alex: 'Alex',
              astyria: 'Astyria',
              aurelius: 'Aurelius',
              agata: 'Agata',
            };
            if (map[slug]) setTargetAgentState(map[slug]);
          } else if (rawTargetAgent && ['Auto', 'Rodzina Mitek', 'Aria', 'Alex', 'Astyria', 'Aurelius', 'Agata'].includes(String(rawTargetAgent))) {
            setTargetAgentState(String(rawTargetAgent) as any);
          }
        } else if (rawTargetAgent && ['Auto', 'Rodzina Mitek', 'Aria', 'Alex', 'Astyria', 'Aurelius', 'Agata'].includes(String(rawTargetAgent))) {
          setTargetAgentState(String(rawTargetAgent) as any);
        }
        const rawPanelAgent =
          (snap.workspaceState.selected_agent_panel_id as any)?.value ?? snap.workspaceState.selected_agent_panel_id;
        if (rawPanelAgent && ['Aria', 'Alex', 'Astyria', 'Aurelius', 'Agata'].includes(String(rawPanelAgent))) {
          setSelectedAgentPanelState(String(rawPanelAgent) as any);
        }
      }

      if (Array.isArray(snap.recentEvents)) {
        for (const ev of snap.recentEvents) {
          recordSeenEventId(ev.eventId);
        }
      }

      setLastSyncedAt(new Date().toLocaleTimeString('pl-PL', { hour12: false }));
    },
    [advanceServerRevision, recordSeenEventId],
  );

  const triggerFullSync = useCallback(
    async (reason = 'operator_sync_button'): Promise<SyncExecutionReport> => {
      if (inflightSnapshotRef.current) {
        return inflightSnapshotRef.current;
      }

      const task = (async (): Promise<SyncExecutionReport> => {
        const t0 = performance.now();
        setIsSyncing(true);
        try {
          // A snapshot reads from the authoritative server; it must not replay local cache.
          const res = await safeFetchJson<SvlSystemSnapshot>('/api/py/system/sync', {
            method: 'POST',
            timeoutMs: 25000,
            body: JSON.stringify({
              triggered_by: reason,
              origin: tabOrigin,
              clientRevision: serverRevisionRef.current,
            }),
          });

          const durationMs = Math.round(performance.now() - t0);
          const data = res.data;

          if (res.ok && data?.ok) {
            applyAuthoritativeSnapshot(data);
            const report: SyncExecutionReport = {
              ok: true,
              syncId: data.syncId,
              schemaVersion: data.schemaVersion,
              serverRevision: Number(data.serverRevision || serverRevisionRef.current),
              timestamp: data.timestamp || new Date().toISOString(),
              durationMs,
              warnings: Array.isArray(data.warnings) ? data.warnings : [],
              modules: data.modules || {},
              error: null,
            };
            setLastSyncReport(report);
            if (reason !== 'boot_initial_sync' && reason !== 'broadcast_catchup') {
              emitCrossTabSignal('system', 'snapshot', report.serverRevision, data.syncId);
            }
            return report;
          }

          const errReport: SyncExecutionReport = {
            ok: false,
            syncId: data?.syncId,
            schemaVersion: data?.schemaVersion,
            serverRevision: serverRevisionRef.current,
            timestamp: new Date().toISOString(),
            durationMs,
            warnings: Array.isArray(data?.warnings) ? data.warnings : [],
            modules: data?.modules || {},
            error: res.error || data?.error || `Błąd synchronizacji HTTP ${res.status}`,
          };
          setLastSyncReport(errReport);
          return errReport;
        } finally {
          setIsSyncing(false);
          inflightSnapshotRef.current = null;
        }
      })();

      inflightSnapshotRef.current = task;
      return task;
    },
    [applyAuthoritativeSnapshot, emitCrossTabSignal, tabOrigin],
  );

  const refreshDomainModules = useCallback(
    async (modules: Array<'health' | 'kernel' | 'agents' | 'chat' | 'terminals' | 'workspace' | 'modules'>) => {
      const unique = Array.from(new Set(modules));
      const tasks: Promise<void>[] = [];

      if (unique.includes('health')) {
        tasks.push(
          safeFetchJson('/api/py/health', { timeoutMs: 12000 }).then((r) => {
            if (r.ok && r.data) {
              setHealthData(r.data);
              if (Array.isArray(r.data.system_modules)) {
                setSystemModules(r.data.system_modules);
              }
              advanceServerRevision(r.data.serverRevision);
            }
          }),
        );
      }
      if (unique.includes('kernel')) {
        tasks.push(
          safeFetchJson('/api/py/kernel/report', { timeoutMs: 12000 }).then((r) => {
            if (r.ok && r.data) {
              setKernelData(r.data);
              if (Array.isArray(r.data.system_modules)) {
                setSystemModules(r.data.system_modules);
              }
              advanceServerRevision(r.data.serverRevision);
            }
          }),
        );
      }
      if (unique.includes('modules')) {
        tasks.push(
          safeFetchJson<{ ok: boolean; modules?: SystemModule[]; serverRevision?: number }>('/api/py/modules', {
            timeoutMs: 12000,
          }).then((r) => {
            if (r.ok && r.data?.ok && Array.isArray(r.data.modules)) {
              setSystemModules(r.data.modules);
              advanceServerRevision(r.data.serverRevision);
            }
          }),
        );
      }
      if (unique.includes('agents')) {
        tasks.push(
          safeFetchJson('/api/py/agents/status', { timeoutMs: 12000 }).then((r) => {
            if (r.ok && r.data) {
              setAgentsData(r.data);
              advanceServerRevision(r.data.serverRevision);
            }
          }),
        );
      }
      if (unique.includes('chat')) {
        tasks.push(
          safeFetchJson('/api/py/chat/conversations', { timeoutMs: 12000 }).then((r) => {
            if (r.ok && r.data?.ok && Array.isArray(r.data.conversations)) {
              advanceServerRevision(r.data.serverRevision);
              const hydrated = normalizeConversationsFromServer(r.data.conversations);
              setConversations((prev) =>
                mergeConversationThreads(hydrated.length ? hydrated : INITIAL_WELCOME_CONVERSATIONS, prev, pendingMsgIdsRef.current, deletedConvIdsRef.current),
              );
            }
          }),
        );
      }
      if (unique.includes('terminals')) {
        tasks.push(
          safeFetchJson('/api/py/terminal/history', { timeoutMs: 12000 }).then((r) => {
            if (r.ok && r.data?.ok && r.data.terminalLogs) {
              advanceServerRevision(r.data.serverRevision);
              setTerminalLogsByTab((prev) => ({ ...prev, ...r.data.terminalLogs }));
            }
          }),
        );
      }
      if (unique.includes('workspace')) {
        tasks.push(
          safeFetchJson('/api/py/workspace/state', { timeoutMs: 12000 }).then((r) => {
            if (r.ok && r.data?.ok && r.data.workspaceState) {
              advanceServerRevision(r.data.serverRevision);
              const ws = r.data.workspaceState as any;
              setWorkspaceState(ws);
              const rawConv = ws.active_conversation_id?.value ?? ws.active_conversation_id;
              if (typeof rawConv === 'string' && rawConv) setActiveConvIdState(rawConv);
              const rawTarget = ws.selected_target_agent?.value ?? ws.selected_target_agent;
              if (rawTarget && ['Auto', 'Rodzina Mitek', 'Aria', 'Alex', 'Astyria', 'Aurelius', 'Agata'].includes(String(rawTarget))) {
                setTargetAgentState(String(rawTarget) as any);
              }
              const rawPanel = ws.selected_agent_panel_id?.value ?? ws.selected_agent_panel_id;
              if (rawPanel && ['Aria', 'Alex', 'Astyria', 'Aurelius', 'Agata'].includes(String(rawPanel))) {
                setSelectedAgentPanelState(String(rawPanel) as any);
              }
            }
          }),
        );
      }

      await Promise.allSettled(tasks);
      setLastSyncedAt(new Date().toLocaleTimeString('pl-PL', { hour12: false }));
    },
    [advanceServerRevision],
  );

  // Coalesced domain refresh queue for incoming outbox events
  const queuedDomainsRef = useRef<Set<'health' | 'kernel' | 'agents' | 'chat' | 'terminals' | 'workspace' | 'modules'>>(new Set());
  const domainFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleDomainRefresh = useCallback(
    (domains: Array<'health' | 'kernel' | 'agents' | 'chat' | 'terminals' | 'workspace' | 'modules'>) => {
      for (const d of domains) queuedDomainsRef.current.add(d);
      if (domainFlushTimerRef.current) return;
      domainFlushTimerRef.current = setTimeout(() => {
        domainFlushTimerRef.current = null;
        const batch = Array.from(queuedDomainsRef.current);
        queuedDomainsRef.current.clear();
        if (batch.length > 0) {
          void refreshDomainModules(batch);
        }
      }, 90);
    },
    [refreshDomainModules],
  );

  const applySyncEvent = useCallback(
    (evt: SvlSyncEvent) => {
      if (!evt || typeof evt !== 'object' || !evt.eventId) return;
      const isNew = recordSeenEventId(evt.eventId);
      if (!isNew) return;

      const incomingSrvRev = Number(evt.serverRevision || 0);
      if (serverRevisionRef.current > 0 && incomingSrvRev > serverRevisionRef.current + 1) {
        // Gap detected in outbox sequence: coalesce catch-up snapshot
        advanceServerRevision(incomingSrvRev);
        void triggerFullSync('sequence_gap_catchup');
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
          deletedConvIdsRef.current.clear();
          setConversations(INITIAL_WELCOME_CONVERSATIONS);
          try { localStorage.removeItem(CONVERSATIONS_CACHE_KEY); } catch { /* unavailable */ }
          scheduleDomainRefresh(['chat']);
          return;
        }
        if (evt.type === 'chat.conversation_deleted' && evt.entityId) {
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
        if (key === 'active_conversation_id' && typeof val === 'string' && val) {
          setActiveConvIdState(val);
        } else if (
          key === 'selected_target_agent' &&
          ['Auto', 'Rodzina Mitek', 'Aria', 'Alex', 'Astyria', 'Aurelius', 'Agata'].includes(String(val))
        ) {
          setTargetAgentState(val);
        } else if (
          key === 'selected_agent_panel_id' &&
          ['Aria', 'Alex', 'Astyria', 'Aurelius', 'Agata'].includes(String(val))
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

      if (evt.entity === 'system' && evt.origin !== tabOrigin) {
        void triggerFullSync('remote_snapshot_event');
      }
    },
    [advanceServerRevision, recordSeenEventId, scheduleDomainRefresh, tabOrigin, triggerFullSync],
  );

  const catchUpFromEvents = useCallback(
    async (sourceReason = 'signal') => {
      if (inflightCatchupRef.current) return inflightCatchupRef.current;
      const run = (async () => {
        try {
          const since = serverRevisionRef.current;
          const res = await safeFetchJson<{
            ok: boolean;
            serverRevision: number;
            events: SvlSyncEvent[];
            gapDetected?: boolean;
          }>(`/api/py/sync/events?sinceRevision=${since}&limit=100`, { timeoutMs: 12000 });
          if (res.ok && res.data?.ok) {
            if (res.data.gapDetected) {
              await triggerFullSync(`${sourceReason}_gap`);
              return;
            }
            const evts = Array.isArray(res.data.events) ? res.data.events : [];
            for (const ev of evts) {
              applySyncEvent(ev);
            }
            advanceServerRevision(res.data.serverRevision);
          }
        } finally {
          inflightCatchupRef.current = null;
        }
      })();
      inflightCatchupRef.current = run;
      return run;
    },
    [advanceServerRevision, applySyncEvent, triggerFullSync],
  );

  // Initial authoritative snapshot on boot
  useEffect(() => {
    void triggerFullSync('boot_initial_sync');
  }, [triggerFullSync]);

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
      setWsState(consecutiveFailures === 0 ? 'connecting' : 'reconnecting');

      try {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const revParam = serverRevisionRef.current;
        const url = `${proto}//${window.location.host}/ws/svl?origin=${encodeURIComponent(tabOrigin)}&lastRevision=${revParam}`;
        ws = new WebSocket(url);
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
            void triggerFullSync('ws_hello_initial');
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
          advanceServerRevision(frame.serverRevision);
          return;
        }

        if (frame.type === 'svl.resync_required') {
          void triggerFullSync(`ws_${frame.reason || 'resync_required'}`);
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
      try {
        ws?.close();
      } catch {
        // ignore
      }
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
  }, [advanceServerRevision, applySyncEvent, catchUpFromEvents, tabOrigin, triggerFullSync]);

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
      setActiveConvIdState(convId);
      void persistWorkspaceKey('active_conversation_id', convId);
      if (convId === 'conv-rodzina-mitek-wszyscy') {
        setTargetAgentState('Rodzina Mitek');
        void persistWorkspaceKey('selected_target_agent', 'Rodzina Mitek');
      } else if (convId === 'conv-agent-aria') {
        setTargetAgentState('Aria');
        void persistWorkspaceKey('selected_target_agent', 'Aria');
      } else if (convId === 'conv-agent-alex') {
        setTargetAgentState('Alex');
        void persistWorkspaceKey('selected_target_agent', 'Alex');
      } else if (convId === 'conv-agent-astyria') {
        setTargetAgentState('Astyria');
        void persistWorkspaceKey('selected_target_agent', 'Astyria');
      } else if (convId === 'conv-agent-aurelius') {
        setTargetAgentState('Aurelius');
        void persistWorkspaceKey('selected_target_agent', 'Aurelius');
      } else if (convId === 'conv-agent-agata') {
        setTargetAgentState('Agata');
        void persistWorkspaceKey('selected_target_agent', 'Agata');
      }
    },
    [persistWorkspaceKey],
  );

  const openAgentChannel = useCallback(
    (agent: 'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata') => {
      const slug = agent.toLowerCase();
      const convId = `conv-agent-${slug}`;
      const displayName = `${agent} Mitek`;
      const agentId = agent === 'Aria' ? 'si_1' : agent;
      deletedConvIdsRef.current.delete(convId);
      const exists = conversationsRef.current.some((c) => c.id === convId);
      if (!exists) {
        const nowTime = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
        const newConv: SyncableConversation = {
          id: convId,
          title: `${displayName} (1-na-1)`,
          updatedAt: nowTime,
          revision: 1,
          messages: [
            {
              id: `msg-init-${slug}`,
              role: 'assistant',
              sender: displayName,
              agentId,
              modelUsed: 'Pełna Autonomia',
              timestamp: nowTime,
              content: `Cześć! To nasz bezpośredni, indywidualny kanał 1-na-1 — odpisuję tutaj wyłącznie ja (**${displayName}**), w pełni autonomicznie i niezależnie.`,
            },
          ],
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
    (agent: 'Auto' | 'Rodzina Mitek' | 'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata') => {
      setTargetAgentState(agent);
      void persistWorkspaceKey('selected_target_agent', agent);
    },
    [persistWorkspaceKey],
  );

  const setSelectedAgentPanel = useCallback(
    (agent: 'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata') => {
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
        const res = await safeFetchJson<{
          ok: boolean;
          revision?: number;
          serverRevision?: number;
          event?: SvlSyncEvent;
          conversations?: any[];
          error?: string;
        }>('/api/py/chat/conversations/message', {
          method: 'POST',
          timeoutMs: 15000,
          body: JSON.stringify({
            conversation_id: convId,
            title: convTitle,
            model,
            message: msg,
            origin: tabOrigin,
            eventId,
          }),
        });

        if (res.ok && res.data?.ok) {
          if (Array.isArray(res.data.conversations) && res.data.conversations.length > 0) {
            const hydrated = normalizeConversationsFromServer(res.data.conversations);
            setConversations((prev) =>
              mergeConversationThreads(hydrated, prev, pendingMsgIdsRef.current, deletedConvIdsRef.current),
            );
          }
          notifyLocalMutation('chat', convId, res.data.serverRevision, res.data.event);
          return { ok: true };
        }

        return { ok: false, error: res.error || res.data?.error || `Błąd zapisu wiadomości HTTP ${res.status}` };
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
    setConversations((prev) => [newThread, ...prev]);
    setActiveConvId(newId);
    return newThread;
  }, [appendAndPersistChatMessage, setActiveConvId]);

  const deleteConversation = useCallback(
    async (convId: string) => {
      if (conversationsRef.current.length <= 1) {
        return { ok: false, error: 'Nie można usunąć ostatniej aktywnej sesji.' };
      }
      deletedConvIdsRef.current.add(convId);
      const remaining = conversationsRef.current.filter((c) => c.id !== convId);
      setConversations(remaining);
      if (activeConvIdState === convId && remaining[0]) {
        setActiveConvId(remaining[0].id);
      }

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
        if (Array.isArray(res.data.conversations) && res.data.conversations.length > 0) {
          const hydrated = normalizeConversationsFromServer(res.data.conversations);
          setConversations((prev) =>
            mergeConversationThreads(hydrated, prev, pendingMsgIdsRef.current, deletedConvIdsRef.current),
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
    const previousConversations = conversationsRef.current;
    const previousActiveConvId = activeConvIdState;
    const previousTargetAgent = targetAgentState;
    deletedConvIdsRef.current.clear();
    pendingMsgIdsRef.current.clear();
    setConversations(INITIAL_WELCOME_CONVERSATIONS.map((c) => ({ ...c, messages: [] })));
    setActiveConvIdState('conv-rodzina-mitek-wszyscy');
    setTargetAgentState('Rodzina Mitek');

    const eventId = createUniqueId('evt-clear-all');
    const res = await safeFetchJson<{
      ok: boolean;
      conversations?: any[];
      serverRevision?: number;
      error?: string;
    }>('/api/py/chat/conversations/clear-all', {
      method: 'POST',
      timeoutMs: 12000,
      body: JSON.stringify({ origin: tabOrigin, eventId }),
    });

    if (res.ok && res.data?.ok && Array.isArray(res.data.conversations)) {
      const hydrated = normalizeConversationsFromServer(res.data.conversations);
      setConversations(hydrated.length > 0 ? hydrated : INITIAL_WELCOME_CONVERSATIONS);
      try { localStorage.removeItem(CONVERSATIONS_CACHE_KEY); } catch { /* unavailable */ }
      notifyLocalMutation('chat', 'all', res.data.serverRevision);
      return { ok: true };
    }
    // Roll back optimistic clearing when Python/SQLite fails.
    setConversations(previousConversations);
    setActiveConvIdState(previousActiveConvId);
    setTargetAgentState(previousTargetAgent);
    return { ok: false, error: res.data?.error || res.error || 'Nie udało się wyczyścić rozmów w SQLite.' };
  }, [activeConvIdState, notifyLocalMutation, tabOrigin, targetAgentState]);

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
      lastSyncReport,
      healthData,
      kernelData,
      agentsData,
      systemModules,
      conversations,
      terminalLogsByTab,
      workspaceState,
      activeConvId: activeConvIdState,
      targetAgent: targetAgentState,
      selectedAgentPanel: selectedAgentPanelState,
      triggerFullSync,
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
      clearTerminalTab,
      refreshTerminals,
      notifyLocalMutation,
    }),
    [
      activeConvIdState,
      agentsData,
      appendAndPersistChatMessage,
      clearAllConversationsAndBuffers,
      clearTerminalTab,
      connectMyAi,
      conversations,
      createConversation,
      deleteConversation,
      deleteSystemModule,
      healthData,
      isConnectingAi,
      isSyncing,
      kernelData,
      lastSyncReport,
      lastSyncedAt,
      notifyLocalMutation,
      openAgentChannel,
      openFamilyChannel,
      reconnectWebSocket,
      refreshDomainModules,
      refreshTerminals,
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
      triggerFullSync,
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
