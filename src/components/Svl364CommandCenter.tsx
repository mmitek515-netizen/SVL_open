import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Bot, Cpu, Database, HardDrive, RefreshCw, RadioTower, Satellite, Server, Terminal, Wifi, WifiOff } from 'lucide-react';
import { useSvlSync } from '../utils/svlSyncStore';
import { safeFetchJson } from '../utils/svlLogic';

type WorkspaceTab = 'chat' | 'svl364' | 'agents' | 'terminals' | 'kernel' | 'linux';

interface CenterProps {
  onNavigate: (tab: WorkspaceTab) => void;
}

const unknown = 'Brak danych';

export const Svl364CommandCenter: React.FC<CenterProps> = ({ onNavigate }) => {
  const {
    agentsData, healthData, systemModules, serverRevision, lastSyncedAt,
    wsState, lastSyncReport, conversations, refreshDomainModules, triggerFullSync,
  } = useSvlSync();
  const [events, setEvents] = useState<any[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [chatStats, setChatStats] = useState<{totalMessages: number; resetApplied: boolean; databaseName: string} | null>(null);
  const [runningCommit, setRunningCommit] = useState<string | null>(null);
  const [codexState, setCodexState] = useState<{
    enabled: boolean; accessConfigured: boolean; loggedIn: boolean; reason: string;
  } | null>(null);
  const [diagnosticsCheckedAt, setDiagnosticsCheckedAt] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [codexOperatorAccess, setCodexOperatorAccess] = useState('');
  const [isCheckingCodex, setIsCheckingCodex] = useState(false);
  const currentRevisionRef = useRef(serverRevision);
  useEffect(() => { currentRevisionRef.current = serverRevision; }, [serverRevision]);

  const refreshObservability = useCallback(async () => {
    await refreshDomainModules(['modules', 'kernel', 'agents', 'health', 'chat']);
    const currentRevision = Math.max(0, currentRevisionRef.current - 35);
    const response = await safeFetchJson<{ ok: boolean; events?: any[]; error?: string }>(
      '/api/py/sync/events?sinceRevision=' + currentRevision + '&limit=50',
      { timeoutMs: 12000 },
    );
    const [chatDiag, deployDiag] = await Promise.all([
      safeFetchJson<{ok: boolean; totalMessages: number; resetApplied: boolean; databaseName: string}>(
        '/api/py/chat/diagnostics', {timeoutMs: 10000},
      ),
      safeFetchJson<{ok: boolean; commit: string | null}>(
        '/api/deployment-info', {timeoutMs: 10000},
      ),
    ]);
    setDiagnosticsCheckedAt(new Date().toISOString());
    if (chatDiag.ok && chatDiag.data?.ok) setChatStats(chatDiag.data);
    if (deployDiag.ok && deployDiag.data?.ok) setRunningCommit(deployDiag.data.commit || null);
    if (response.ok && response.data?.ok && Array.isArray(response.data.events)) {
      setEvents(response.data.events.slice(-15).reverse());
      setEventsError(null);
    } else {
      setEventsError(response.data?.error || response.error || 'Nie udało się pobrać historii zdarzeń');
    }
  }, [refreshDomainModules]);

  useEffect(() => {
    void refreshObservability();
    const timer = setInterval(() => { void refreshObservability(); }, 15000);
    return () => clearInterval(timer);
  }, [refreshObservability]);

  const checkCodexSession = async () => {
    if (isCheckingCodex) return;
    setIsCheckingCodex(true);
    try {
      const result = await safeFetchJson<{
        ok: boolean; enabled: boolean; accessConfigured: boolean;
        authenticated: boolean; loggedIn: boolean; reason: string;
      }>('/api/codex-chat/status', {
        timeoutMs: 10000,
        headers: codexOperatorAccess ? {'X-SVL-Codex-Access': codexOperatorAccess} : {},
      });
      if (result.ok && result.data?.ok) {
        setCodexState(result.data);
      } else {
        setCodexState({enabled:false,accessConfigured:false,loggedIn:false,
          reason:result.error || 'Nie można odczytać stanu Codexa.'});
      }
    } finally {
      setIsCheckingCodex(false);
    }
  };

  const refreshNow = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await triggerFullSync('svl364_operator_command_center');
      await refreshObservability();
    } finally {
      setIsRefreshing(false);
    }
  };

  const agents: any[] = Array.isArray(agentsData?.agents) ? agentsData.agents : [];
  const activeWorkers = agents.filter((agent) =>
    ['ONLINE_LOCAL_WORKER', 'BUSY_LOCAL_WORKER'].includes(agent.status),
  ).length;
  const commandModule: any = systemModules.find((item: any) => item.id === 'svl-364');
  const totalMessages = conversations.reduce((sum, thread) => sum + (thread.messages?.length || 0), 0);
  const ollamaReachable = healthData?.ollama?.daemon_reachable === true;
  const ollamaModels: Array<{ name: string }> = Array.isArray(healthData?.ollama?.models)
    ? healthData.ollama.models
    : [];
  const configuredModel = String(
    commandModule?.config?.configured_ollama_model ||
    healthData?.ollama?.preferred_14b_vision_model ||
    '',
  );
  const configuredModelInstalled = Boolean(
    configuredModel &&
    ollamaModels.some((model) =>
      model.name === configuredModel ||
      String(model.name || '').startsWith(`${configuredModel.split(':')[0]}:`),
    ),
  );
  const backendOnline = healthData?.status === 'ONLINE';
  const localLinkOnline = backendOnline && wsState === 'online';
  const physicalTelemetryEndpoint = String(commandModule?.config?.telemetry_endpoint || '');
  const busCapacity = Number(
    agentsData?.spherical_bus?.max_history_size ||
    commandModule?.config?.async_event_bus_buffer ||
    0,
  );
  const busTelemetry = agentsData?.spherical_bus?.telemetry || {};
  const targetNames = ['Aria', 'Alex', 'Astyria', 'Aurelius', 'Agata'];

  return (
    <div className="h-full overflow-y-auto bg-[#090D16] text-slate-100">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-5 space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-violet-500/20 pb-4">
          <div>
            <p className="flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-violet-400">
              <Satellite size={16} /> SVL-364 / Ebon Apex
            </p>
            <h1 className="text-xl sm:text-2xl font-semibold mt-2">Centrum dowodzenia</h1>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              Rzeczywiste dane aplikacji SVL Python OS. Zewnętrzna łączność ze statkiem nie została zweryfikowana.
            </p>
          </div>
          <button type="button" onClick={() => void refreshNow()} disabled={isRefreshing}
            className="flex items-center gap-2 rounded-lg border border-violet-500/40 bg-violet-500/15 px-3 py-2 text-sm text-violet-100 hover:bg-violet-500/25 disabled:opacity-40">
            <RefreshCw size={15} className={isRefreshing ? 'animate-spin' : ''} /> Synchronizuj
          </button>
        </header>

        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="Status systemu">
          <StatusMetric label="Synchronizacja" value={wsState === 'online' ? 'WebSocket online' : wsState}
            detail={'Rewizja SQLite: ' + serverRevision} icon={<Wifi size={17} />} />
          <StatusMetric label="Workery agentów" value={activeWorkers + '/5'}
            detail="Potwierdzone lokalne procesy (nie dostępność LLM)" icon={<Bot size={17} />} />
          <StatusMetric label="Silnik Ollama" value={ollamaReachable ? 'API odpowiada' : 'Offline / nieznany'}
            detail={ollamaReachable ? 'Sprawdź modele w zakładce Linux' : 'Nie udawaj gotowości modelu'} icon={<Cpu size={17} />} />
          <StatusMetric label="Wiadomości SQLite" value={chatStats ? String(chatStats.totalMessages) : unknown}
            detail={'UI: ' + totalMessages + ' · Reset historii: ' + (chatStats?.resetApplied ? 'wykonany' : 'niepotwierdzony')}
            icon={<Database size={17} />} />
        </section>

        <section className="rounded-xl border border-slate-800 bg-[#111826] p-4 space-y-3" aria-label="Zweryfikowane łącza SVL-364">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold">
              <RadioTower size={18} className="text-violet-400" /> Diagnostyka połączeń SVL-364
            </h2>
            <span className="text-xs text-slate-500">
              Ostatni pomiar: {diagnosticsCheckedAt ? new Date(diagnosticsCheckedAt).toLocaleTimeString('pl-PL') : 'oczekuje'}
            </span>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <LinkCheck
              label="Aplikacja ↔ Python Kernel"
              state={localLinkOnline ? 'online' : 'offline'}
              detail={
                localLinkOnline
                  ? `Kernel ${healthData.system || 'SVL'} · WebSocket online · rewizja ${serverRevision}`
                  : `Kernel: ${backendOnline ? 'online' : 'brak odpowiedzi'} · WebSocket: ${wsState}`
              }
            />
            <LinkCheck
              label="Ollama ↔ host"
              state={!ollamaReachable ? 'offline' : configuredModelInstalled ? 'online' : 'degraded'}
              detail={
                !ollamaReachable
                  ? healthData?.ollama?.error || 'Daemon Ollama nie odpowiada.'
                  : configuredModelInstalled
                    ? `${configuredModel} · zainstalowany · aktywne: ${(healthData?.ollama?.loaded_models || []).length}`
                    : `${configuredModel || 'Brak wybranego modelu'} nie znaleziono · dostępne: ${ollamaModels.length}`
              }
            />
            <LinkCheck
              label="Spherical Event Bus"
              state={busCapacity > 0 ? 'online' : 'unverified'}
              detail={
                busCapacity > 0
                  ? `Bufor ${busCapacity}/2000 · opublikowane zdarzenia: ${busTelemetry.published_events || 0}`
                  : 'Oczekiwanie na telemetrię workera.'
              }
            />
            <LinkCheck
              label="Zewnętrzne łącze statku"
              state="unverified"
              detail={physicalTelemetryEndpoint
                ? `Endpoint ${physicalTelemetryEndpoint} jest zapisany, ale brak testu protokołu/heartbeat.`
                : 'Nie skonfigurowano endpointu ani protokołu telemetrii; połączenie fizyczne nie jest potwierdzone.'}
            />
          </div>
          <p className="text-xs text-slate-500">
            Wyniki dotyczą usług i procesów dostępnych dla tej aplikacji. Sama nazwa „statek SVL-364” oznacza moduł programowy; nie potwierdza łączności z fizycznym pojazdem.
          </p>
        </section>

        <section className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-800 bg-[#111826] p-4 space-y-3">
            <h2 className="flex gap-2 items-center font-semibold"><Server size={18} className="text-violet-400" /> Moduły i usługi</h2>
            <div className="flex items-center justify-between gap-3 rounded-md border border-slate-700 px-3 py-2 text-sm">
              <span>Moduł dowodzenia SVL-364</span>
              <span className={commandModule ? 'text-emerald-300' : 'text-amber-300'}>
                {commandModule ? String(commandModule.status || 'Zarejestrowany') : 'Brak w stanie backendu'}
              </span>
            </div>
            <p className="text-xs text-slate-400">Rejestr modułów: {systemModules.length} · endpoint telemetrii: {physicalTelemetryEndpoint ? 'zapisany, niezweryfikowany' : 'nie skonfigurowany'}</p>
            <p className="text-xs text-slate-400">
              Codex CLI / ChatGPT OAuth: {codexState
                ? codexState.loggedIn ? 'ZALOGOWANY W RUNTIME' : codexState.reason
                : 'Niepotwierdzony'}
            </p>
            <p className="text-xs text-slate-400">
              Czat Codex: {codexState?.enabled ? 'Włączony' : 'Wyłączony lub jeszcze nie sprawdzony'}
              {' · Ochrona dostępu: ' + (codexState?.accessConfigured ? 'skonfigurowana' : 'niepotwierdzona')}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="password" autoComplete="off" spellCheck={false}
                aria-label="Prywatny token do sprawdzenia logowania Codex CLI"
                value={codexOperatorAccess}
                onChange={(event) => setCodexOperatorAccess(event.target.value)}
                placeholder="Token dostępu Codex CLI"
                className="min-w-0 flex-1 rounded-md border border-slate-700 bg-[#0B0D13] px-2 py-1.5 text-xs"
              />
              <button type="button" disabled={isCheckingCodex}
                onClick={() => void checkCodexSession()}
                className="rounded-md border border-violet-600/50 px-2 py-1.5 text-xs text-violet-200 disabled:opacity-50"
              >
                {isCheckingCodex ? 'Sprawdzanie…' : 'Sprawdź logowanie'}
              </button>
            </div>
            <div className="max-h-48 overflow-auto space-y-1">
              {systemModules.slice(0, 16).map((mod: any) => (
                <div key={mod.id} className="flex justify-between gap-2 border-b border-slate-800/70 py-1 text-xs">
                  <span className="truncate" title={mod.name}>{mod.name || mod.id}</span>
                  <span className="shrink-0 text-slate-400">{mod.status || unknown}</span>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => onNavigate('kernel')} className="text-sm text-violet-300 hover:underline">
              Otwórz rejestr i diagnostykę jądra
            </button>
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#111826] p-4 space-y-3">
            <h2 className="flex gap-2 items-center font-semibold"><Bot size={18} className="text-violet-400" /> Pięciu agentów</h2>
            <div className="space-y-2">
              {targetNames.map((name) => {
                const agent = agents.find((entry) => String(entry.name || entry.agent || '').toLowerCase().includes(name.toLowerCase()));
                const state = String(agent?.status || 'Brak danych');
                const running = ['ONLINE_LOCAL_WORKER', 'BUSY_LOCAL_WORKER'].includes(state);
                return (
                  <div key={name} className="flex items-center justify-between rounded-md bg-slate-950/50 px-3 py-2 text-sm">
                    <span>{name} Mitek</span>
                    <span className={running ? 'text-emerald-300 text-xs' : 'text-slate-400 text-xs'}>
                      {state}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-4 text-sm text-violet-300">
              <button type="button" onClick={() => onNavigate('agents')} className="hover:underline">Panel agentów</button>
              <button type="button" onClick={() => onNavigate('chat')} className="hover:underline">Otwórz czat</button>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-800 bg-[#111826] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold"><Activity size={18} className="text-violet-400" /> Zmiany widoczne w systemie</h2>
            <span className="text-xs text-slate-400">Zdarzenia SQLite / Spherical Event Bus</span>
          </div>
          <p className="text-sm text-slate-400">
            Tutaj widać zatwierdzone zdarzenia systemu. Sam commit GitHub nie oznacza, że kod został wdrożony do uruchomionego procesu.
          </p>
          {eventsError && <p role="status" className="text-sm text-amber-300">{eventsError}</p>}
          {events.length === 0 && !eventsError && <p className="text-sm text-slate-400">Brak potwierdzonych zdarzeń w pobranym zakresie.</p>}
          <div className="max-h-72 overflow-auto divide-y divide-slate-800">
            {events.map((evt: any, i: number) => (
              <div key={evt.eventId || i} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                <div>
                  <p className="font-medium text-slate-200">{evt.type || 'Zdarzenie'}</p>
                  <p className="text-slate-400">{evt.entity || 'system'} / {evt.entityId || 'global'} · {evt.origin || 'nieznane'}</p>
                </div>
                <span className="font-mono text-violet-300">rev {evt.serverRevision || '?'}</span>
              </div>
            ))}
          </div>
        </section>

        <footer className="flex flex-wrap gap-2 pb-3">
          <button type="button" onClick={() => onNavigate('terminals')}
            className="flex gap-2 items-center rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm hover:bg-slate-700">
            <Terminal size={16} /> Terminal statku
          </button>
          <button type="button" onClick={() => onNavigate('linux')}
            className="flex gap-2 items-center rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm hover:bg-slate-700">
            <HardDrive size={16} /> Diagnostyka Linux
          </button>
          <span className="self-center text-xs text-slate-500">
            {lastSyncReport?.ok === false ? ('Ostatni błąd synchronizacji: ' + (lastSyncReport.error || unknown)) : 'Stan z backendu · ostatnia synchronizacja ' + (lastSyncedAt || 'nieznana')}
            {' · kod uruchomiony: ' + (runningCommit ? runningCommit.slice(0, 12) : 'SHA niedostępne')}
            {chatStats?.databaseName ? ' · baza: ' + chatStats.databaseName : ''}
          </span>
        </footer>
      </div>
    </div>
  );
};

const StatusMetric: React.FC<{label: string; value: string; detail: string; icon: React.ReactNode}> =
  ({label, value, detail, icon}) => (
    <div className="rounded-xl border border-slate-800 bg-[#111826] px-3 py-3 min-w-0">
      <p className="flex items-center gap-2 text-xs text-slate-400">{icon}{label}</p>
      <p className="font-semibold text-sm sm:text-base mt-2 break-words">{value}</p>
      <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">{detail}</p>
    </div>
  );

const LinkCheck: React.FC<{
  label: string;
  state: 'online' | 'degraded' | 'offline' | 'unverified';
  detail: string;
}> = ({ label, state, detail }) => {
  const labelByState = {
    online: 'Połączono',
    degraded: 'Częściowo',
    offline: 'Offline',
    unverified: 'Niezweryfikowane',
  } as const;
  const classByState = {
    online: 'text-emerald-300',
    degraded: 'text-amber-300',
    offline: 'text-rose-300',
    unverified: 'text-slate-400',
  } as const;
  const Icon = state === 'online' ? Wifi : WifiOff;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className={`flex items-center gap-1 text-xs ${classByState[state]}`}>
          <Icon size={13} /> {labelByState[state]}
        </span>
      </div>
      <p className="mt-1 break-words text-xs text-slate-400">{detail}</p>
    </div>
  );
};
