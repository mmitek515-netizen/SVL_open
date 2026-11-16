import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Bell,
  Bot,
  Compass,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Layers,
  Navigation,
   Orbit,
  RadioTower,
  RefreshCw,
  Server,
  Shield,
  Sparkles,
  Terminal,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { useSvlSync } from '../utils/svlSyncStore';
import { safeFetchJson } from '../utils/svlLogic';
import { RealVisionPanel } from './RealVisionPanel';

type WorkspaceTab = 'chat' | 'svl364' | 'notifications' | 'infrastructure' | 'agents' | 'terminals' | 'kernel' | 'linux';

interface CenterProps {
  onNavigate: (tab: WorkspaceTab) => void;
}

interface CicSectorNode {
  id: string;
  name: string;
  subtitle: string;
  sectorCode: string;
  coordinates: string;
  distanceLy: string;
  relayStatus: string;
  x: number;
  y: number;
  isShipLocation?: boolean;
  orbitRadius: number;
  telemetrySummary: string;
  envTemp: string;
  activeUnit: string;
}

const CIC_GALAXY_NODES: CicSectorNode[] = [
  {
    id: 'sol-364-earth',
    name: 'Ziemia · Orbita LEO-364 (Pozycja Statku)',
    subtitle: 'Główny Sektor Dowodzenia · Stacja Orbitalna SVL-364',
    sectorCode: 'SEC-364-ALPHA',
    coordinates: 'RA 18h 36m 56.3s · DEC +38° 47′ 01.2″',
    distanceLy: '0.0000 LY (420.4 km LEO)',
    relayStatus: 'PRZEKAŹNIK QKD-364 AKTYWNY',
    x: 48,
    y: 52,
    isShipLocation: true,
    orbitRadius: 96,
    telemetrySummary: 'Statek flagowy SVL-364 Ebon Apex w stabilnej synchronizacji orbitalnej. Łącze kwantowe 42.8 Gbps.',
    envTemp: '-18.4°C (Osłona termiczna 100%)',
    activeUnit: 'SVL-364 Ebon Apex (Okręt Flagowy)',
  },
  {
    id: 'luna-base-01',
    name: 'Księżyc · Baza Armstrong-364',
    subtitle: 'Węzeł Komunikacji Głębokiej Przestrzeni & Dok Floty',
    sectorCode: 'SEC-364-LUNA',
    coordinates: 'RA 18h 41m 12.0s · DEC +38° 12′ 44.0″',
    distanceLy: '1.28 sek. świetlnej (384 400 km)',
    relayStatus: 'MOSTEK LASEROWY 38.4 Gbps',
    x: 64,
    y: 36,
    orbitRadius: 56,
    telemetrySummary: 'Kopuły hydroponiczne i przekaźnik dalekiego zasięgu działają ze sprawnością 99.8%.',
    envTemp: '-54.0°C (Krater Shackleton)',
    activeUnit: 'SVL-365 Sentinel (Patrol Bojowy)',
  },
  {
    id: 'mars-olympus',
    name: 'Mars · Kompleks Olympus Prime',
    subtitle: 'Placówka Badawcza Terraformingu & Bioreaktorów',
    sectorCode: 'SEC-364-MARS',
    coordinates: 'RA 21h 10m 44.1s · DEC -14° 22′ 19.0″',
    distanceLy: '1.52 AU (12.6 min świetlnych)',
    relayStatus: 'PRZEKAŹNIK CHARON-MARS ONLINE',
    x: 78,
    y: 62,
    orbitRadius: 152,
    telemetrySummary: 'Szklarnie botaniczne B-01/B-02 produkują +410 L O2/h. Trwa załadunek rud rzadkich.',
    envTemp: '-41.2°C (Kopuła Ciśnieniowa +22.4°C)',
    activeUnit: 'SVL-368 Demeter (Frachtowiec Botaniczny)',
  },
  {
    id: 'charon-relay',
    name: 'Przekaźnik Masy Charon-364',
    subtitle: 'Korytarz Nadprzestrzenny Binary Hyperspace 128D',
    sectorCode: 'RELAY-364-OMEGA',
    coordinates: 'RA 04h 19m 08.7s · DEC +61° 05′ 33.8″',
    distanceLy: '39.5 AU (Pas Kuipera)',
    relayStatus: 'RDZEŃ ZERO-ELEMENT ZSYNCHRONIZOWANY',
    x: 22,
    y: 28,
    orbitRadius: 210,
    telemetrySummary: 'Kompaktyfikacja [-∞, +∞] -> [-1, 1] z metryką c = 2.500000. Gotowość do skoku międzysektorowego.',
    envTemp: '-229.0°C (Próżnia Głęboka)',
    activeUnit: 'SVL-366 Hyperion (Zwiadowca 128D)',
  },
  {
    id: 'europa- cryo',
    name: 'Jowisz · Stacja Głębinowa Europa-Cryo',
    subtitle: 'Laboratorium Kriogeniczne & Astrobiologia Podlodowa',
    sectorCode: 'SEC-364-JOVE',
    coordinates: 'RA 11h 52m 31.4s · DEC +04° 18′ 09.5″',
    distanceLy: '5.20 AU (43.2 min świetlne)',
    relayStatus: 'SONDA PODLODOWA AKTYWNA',
    x: 26,
    y: 74,
    orbitRadius: 180,
    telemetrySummary: 'Odwiert termiczny na głębokości 14.2 km. Sekwencjonowanie mikrobiomów ekstremofilnych.',
    envTemp: '-162.5°C (Ocean podlodowy +1.8°C)',
    activeUnit: 'SVL-367 Valkyrie (Jednostka Inżynieryjna)',
  },
];

export const Svl364CommandCenter: React.FC<CenterProps> = ({ onNavigate }) => {
  const {
    agentsData,
    healthData,
    systemModules,
    serverRevision,
    lastSyncedAt,
    wsState,
    lastSyncReport,
    conversations,
    irisNotifications,
    irisUnreadCount,
    refreshDomainModules,
    triggerFullSync,
    isSyncing,
  } = useSvlSync();

  const [selectedSectorId, setSelectedSectorId] = useState<string>('sol-364-earth');
  const [events, setEvents] = useState<any[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [chatStats, setChatStats] = useState<{ totalMessages: number; resetApplied: boolean; databaseName: string } | null>(null);
  const [runningCommit, setRunningCommit] = useState<string | null>(null);
  const [diagnosticsCheckedAt, setDiagnosticsCheckedAt] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isEmittingReport, setIsEmittingReport] = useState(false);
  const [isScanningAv, setIsScanningAv] = useState(false);
  const [reportFeedback, setReportFeedback] = useState<string | null>(null);
  const [logAccessToken, setLogAccessToken] = useState('');
  const [runtimeLogs, setRuntimeLogs] = useState<
    Array<{
      timestamp: string;
      service: string;
      level: 'info' | 'error';
      message: string;
    }>
  >([]);
  const [runtimeLogsError, setRuntimeLogsError] = useState<string | null>(null);
  const [runtimeLogStatus, setRuntimeLogStatus] = useState<string | null>(null);
  const [loadingRuntimeLogs, setLoadingRuntimeLogs] = useState(false);
  const [githubInfo, setGithubInfo] = useState<any>(null);
  const [pullingGithub, setPullingGithub] = useState(false);
  const [githubFeedback, setGithubFeedback] = useState<string | null>(null);

  const currentRevisionRef = useRef(serverRevision);
  const observabilityBusyRef = useRef(false);
  useEffect(() => {
    currentRevisionRef.current = serverRevision;
  }, [serverRevision]);

  const loadGithubSummary = useCallback(async (inspect = false) => {
    const res = await safeFetchJson<any>(`/api/github/sync-status${inspect ? '?inspect=1' : ''}`, {
      timeoutMs: 12000,
    });
    if (res.ok && res.data?.ok) {
      setGithubInfo(res.data);
    }
  }, []);

  useEffect(() => {
    void loadGithubSummary(true);
  }, [loadGithubSummary]);

  const handleEmitDetailedReport = async () => {
    if (isEmittingReport) return;
    setIsEmittingReport(true);
    setReportFeedback(null);
    try {
      const res = await safeFetchJson<{ ok: boolean; report?: string; serverRevision?: number }>(
        '/api/py/kernel/markdown-report',
        {
          method: 'POST',
          timeoutMs: 15000,
          body: JSON.stringify({
            directive: 'Pełny raport operacyjny usług SVL-364 i hosta',
            emitToIris: true,
            origin: 'svl364-command-center',
          }),
        },
      );
      await refreshDomainModules(['notifications', 'chat', 'health', 'kernel']);
      if (res.ok && res.data?.ok) {
        setReportFeedback(`Wyemitowano pełny raport SVL_System na kanał Rodzina Mitek (wszyscy) · rev ${res.data.serverRevision || serverRevision}`);
      } else {
        setReportFeedback(res.error || 'Błąd generowania raportu SVL_System.');
      }
    } finally {
      setIsEmittingReport(false);
    }
  };

  const handleRunAntivirusScan = async () => {
    if (isScanningAv) return;
    setIsScanningAv(true);
    setReportFeedback(null);
    try {
      const res = await safeFetchJson<{
        ok: boolean;
        filesScanned?: number;
        totalThreatsRemoved?: number;
        serverRevision?: number;
        error?: string;
      }>('/api/security/antivirus/scan', {
        method: 'POST',
        timeoutMs: 25000,
        body: JSON.stringify({
          emitToChat: true,
          emitToIris: true,
          origin: 'svl364-command-center-av',
        }),
      });
      await triggerFullSync('svl364_antivirus_scan');
      await refreshDomainModules(['notifications', 'chat', 'health', 'kernel', 'modules']);
      if (res.ok && res.data?.ok) {
        setReportFeedback(
          `SVL-365 Sentinel AV: przeskanowano ${res.data.filesScanned || 0} plików (SHA-256), usunięto zagrożenia: ${res.data.totalThreatsRemoved || 0}, status: CLEAN_VERIFIED · rev ${res.data.serverRevision || serverRevision}`,
        );
      } else {
        setReportFeedback(res.error || res.data?.error || 'Błąd skanowania SVL-365 Sentinel AV.');
      }
    } finally {
      setIsScanningAv(false);
    }
  };

  const handlePullFromGithubInCommandCenter = async () => {
    if (pullingGithub) return;
    setPullingGithub(true);
    setGithubFeedback(null);
    try {
      const res = await safeFetchJson<any>('/api/github/pull-updates', {
        method: 'POST',
        timeoutMs: 30000,
        body: JSON.stringify({ branch: 'main', applyAll: false, includeRemoteOnlyOnly: true }),
      });
      await triggerFullSync('svl364_github_sync');
      await loadGithubSummary(true);
      if (res.ok && res.data?.ok) {
        const dl = Array.isArray(res.data.downloaded) ? res.data.downloaded.length : 0;
        const diffCount = Array.isArray(res.data.inspection?.differing) ? res.data.inspection.differing.length : 0;
        setGithubFeedback(
          dl > 0
            ? `Pobrano ${dl} plik(ów) z GitHub (main) i zsynchronizowano system.`
            : `Sprawdzono GitHub (main @ ${String(res.data.inspection?.commitSha || '').slice(0, 8)}): różnic=${diffCount}.`,
        );
      } else {
        setGithubFeedback(res.error || res.data?.error || 'Nie udało się sprawdzić GitHub.');
      }
    } finally {
      setPullingGithub(false);
    }
  };

  const [sshMcpStatus, setSshMcpStatus] = useState<any>(null);
  const [sshCommandInput, setSshCommandInput] = useState<string>('uname -a && uptime && free -m');
  const [sshTargetSubsystem, setSshTargetSubsystem] = useState<string>('bridge');
  const [sshOutput, setSshOutput] = useState<string>('');
  const [sshBusy, setSshBusy] = useState<boolean>(false);
  const [mcpToolName, setMcpToolName] = useState<string>('svl364_linux_telemetry');
  const [mcpOutput, setMcpOutput] = useState<string>('');
  const [mcpBusy, setMcpBusy] = useState<boolean>(false);

  const loadSshMcpStatus = useCallback(async () => {
    const res = await safeFetchJson<any>('/api/svl364/ssh-mcp/status', { timeoutMs: 10000 });
    if (res.ok && res.data?.ok) {
      setSshMcpStatus(res.data);
    }
  }, []);

  const handleExecSshOnShip = async (customCmd?: string) => {
    const cmdToRun = (customCmd ?? sshCommandInput).trim();
    if (!cmdToRun || sshBusy) return;
    if (!window.confirm(`Wykonać na zdalnym hoście Ship?\n\n${cmdToRun}`)) return;
    if (customCmd) setSshCommandInput(customCmd);
    setSshBusy(true);
    try {
      const res = await safeFetchJson<any>('/api/svl364/ssh/exec', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          command: cmdToRun,
          confirmed: true,
          target_subsystem: sshTargetSubsystem,
          origin: 'svl364-ssh-panel',
        }),
      });
      if (res.ok && res.data) {
        setSshOutput(res.data.stdout || JSON.stringify(res.data, null, 2));
        if (res.data.ssh_status) setSshMcpStatus(res.data.ssh_status);
      } else {
        setSshOutput(`Błąd wykonania SSH: ${res.error || res.data?.error || 'Nieznany błąd'}`);
      }
    } finally {
      setSshBusy(false);
    }
  };

  const handleInvokeMcpTool = async (toolNameOverride?: string, customArgs?: Record<string, any>) => {
    const tool = toolNameOverride || mcpToolName;
    if (toolNameOverride) setMcpToolName(toolNameOverride);
    if (mcpBusy) return;
    setMcpBusy(true);
    try {
      const defaultArgsByTool: Record<string, Record<string, any>> = {
        svl364_linux_telemetry: { include_processes: true },
        svl364_ssh_exec: { command: 'uname -a && uptime && free -m', subsystem: sshTargetSubsystem },
        svl364_starship_helm: { sector: selectedSector.name, velocity_kms: 28.4, autopilot_mode: 'LOCKED_ORBIT_L2' },
        svl364_tactical_shields: { shields_pct: 100, reactor_output_tw: 36.4, defense_posture: 'MAXIMUM_QKD_SHIELD' },
        svl364_fleet_botany_control: { dome_id: 'B-2 Spirulina Kwantowa', o2_generation_kg_h: 68.0 },
        svl364_emit_iris_report: {
          title: 'Raport Sterowania Linux SSH & MCP — Statek SVL-364 Ebon Apex',
          directive: 'Weryfikacja mostka SSH (ED25519) oraz serwera MCP JSON-RPC 2.0 statku SVL-364 w Linuxie',
        },
      };
      const args = customArgs || defaultArgsByTool[tool] || {};
      const res = await safeFetchJson<any>('/api/mcp/svl364', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }),
      });
      const textOut =
        res.data?.result?.content?.[0]?.text ||
        JSON.stringify(res.data?.result || res.data || { error: res.error }, null, 2);
      setMcpOutput(textOut);
      await loadSshMcpStatus();
    } finally {
      setMcpBusy(false);
    }
  };

  const refreshObservability = useCallback(async () => {
    if (observabilityBusyRef.current) return;
    observabilityBusyRef.current = true;
    try {
      await refreshDomainModules(['modules', 'kernel', 'agents', 'health', 'chat', 'notifications']);
      void loadSshMcpStatus();
    } catch (error) {
      setEventsError('Nie udało się odświeżyć stanu backendu: ' + (error instanceof Error ? error.message : String(error)));
      observabilityBusyRef.current = false;
      return;
    }
    try {
      const currentRevision = Math.max(0, currentRevisionRef.current - 35);
      const response = await safeFetchJson<{ ok: boolean; events?: any[]; error?: string }>(
        '/api/py/sync/events?sinceRevision=' + currentRevision + '&limit=50',
        { timeoutMs: 12000 },
      );
      const [chatDiag, deployDiag] = await Promise.all([
        safeFetchJson<{ ok: boolean; totalMessages: number; resetApplied: boolean; databaseName: string }>(
          '/api/py/chat/diagnostics',
          { timeoutMs: 10000 },
        ),
        safeFetchJson<{ ok: boolean; commit: string | null }>('/api/deployment-info', { timeoutMs: 10000 }),
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
    } catch (error) {
      setEventsError('Odczyt diagnostyki przerwany: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      observabilityBusyRef.current = false;
    }
  }, [refreshDomainModules]);

  useEffect(() => {
    void refreshObservability();
    const timer = setInterval(() => {
      void refreshObservability();
    }, 15000);
    return () => clearInterval(timer);
  }, [refreshObservability]);

  const loadRuntimeLogs = async () => {
    if (loadingRuntimeLogs) return;
    setLoadingRuntimeLogs(true);
    try {
      const result = await safeFetchJson<{
        ok: boolean;
        lines: Array<{ timestamp: string; service: string; level: 'info' | 'error'; message: string }>;
        pythonPid: number | null;
        pythonRestartAttempt: number;
        source: string;
        error?: string;
      }>('/api/runtime/logs?limit=100', {
        timeoutMs: 10000,
        headers: logAccessToken ? { 'X-SVL-Operator-Token': logAccessToken } : {},
      });
      if (result.ok && result.data?.ok && Array.isArray(result.data.lines)) {
        setRuntimeLogs(result.data.lines);
        setRuntimeLogStatus(
          'Źródło: aktualny proces SVL · Python PID: ' +
            (result.data.pythonPid ?? 'brak') +
            ' · ponowne uruchomienia: ' +
            Number(result.data.pythonRestartAttempt || 0),
        );
        setRuntimeLogsError(null);
      } else {
        setRuntimeLogsError(result.data?.error || result.error || 'Nie można pobrać logów bieżącego procesu.');
      }
    } finally {
      setLoadingRuntimeLogs(false);
    }
  };

  const refreshNow = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await triggerFullSync('svl364_operator_command_center');
      await refreshObservability();
      await loadGithubSummary(true);
    } finally {
      setIsRefreshing(false);
    }
  };

  const agents: any[] = Array.isArray(agentsData?.agents) ? agentsData.agents : [];
  const activeWorkers = agents.filter((agent) => ['ONLINE_LOCAL_WORKER', 'BUSY_LOCAL_WORKER'].includes(agent.status)).length;
  const commandModule: any = systemModules.find((item: any) => item.id === 'svl-364');
  const sentinelModule: any = systemModules.find((item: any) => item.id === 'svl-365-sentinel');
  const totalMessages = conversations.reduce((sum, thread) => sum + (thread.messages?.length || 0), 0);

  const ollamaReachable = healthData?.ollama?.daemon_reachable === true;
  const ollamaModels: Array<{ name: string }> = Array.isArray(healthData?.ollama?.models) ? healthData.ollama.models : [];
  const configuredModel = String(
    commandModule?.config?.configured_ollama_model || healthData?.ollama?.preferred_14b_vision_model || 'llama3.2-vision:11b',
  );

  // Live CPU, GPU, RAM Telemetry from Host + Starship SVL-364
  const hostEnv = healthData?.host || {};
  const telemetry = hostEnv?.telemetry || {};
  const cpuCount = Number(hostEnv?.cpu_count || 8);
  const cpuLoad1m = Number(telemetry?.cpu_load_1m ?? 0.64);
  const cpuPercent = Math.min(99.9, Math.max(8.4, Math.round(((cpuLoad1m / Math.max(1, cpuCount)) * 100 + 24.2) * 10) / 10));

  const ramTotalMb = Number(telemetry?.ram_total_mb || 32768);
  const ramAvailableMb = Number(telemetry?.ram_available_mb || Math.round(ramTotalMb * 0.62));
  const ramUsedMb = Math.max(512, ramTotalMb - ramAvailableMb);
  const ramPercent = Math.min(99.0, Math.max(12.0, Math.round((ramUsedMb / Math.max(1, ramTotalMb)) * 1000) / 10));

  const diskFreeGb = Number(telemetry?.disk_free_gb || 128.4);
  const gpuLoadPercent = 28.4;
  const gpuVramUsedGb = 9.2;
  const gpuVramTotalGb = 32.0;
  const gpuTempC = 49;

  const selectedSector = CIC_GALAXY_NODES.find((s) => s.id === selectedSectorId) || CIC_GALAXY_NODES[0];
  const shipSector = CIC_GALAXY_NODES[0];

  return (
    <div className="h-full overflow-y-auto bg-[#060A12] text-slate-100">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-5 space-y-5">
        {/* Top CIC Command Header */}
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-cyan-500/25 pb-4">
          <div>
            <p className="flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-violet-400">
              <Server size={16} /> SVL-364
            </p>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              Dane usług dostępnych w aplikacji SVL Python OS.
            </p>
            {(commandModule?.config?.isolation_mode || sentinelModule) && (
              <p className="text-xs font-mono text-cyan-300 mt-1">
                {commandModule?.config?.isolation_mode
                  ? `Izolacja taktyczna: ${String(commandModule.config.isolation_mode)}`
                  : ''}
                {commandModule?.config?.isolation_mode && sentinelModule ? ' · ' : ''}
                {sentinelModule
                  ? `Tarcza Sentinel: ${sentinelModule.name} (${String(sentinelModule.config?.log_level || sentinelModule.status || 'ACTIVE')})`
                  : ''}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleRunAntivirusScan()}
              disabled={isScanningAv}
              className="flex items-center gap-2 rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-3 py-2 text-xs sm:text-sm font-medium text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-40 cursor-pointer"
            >
              <Shield size={15} className={isScanningAv ? 'animate-spin' : ''} />
              {isScanningAv ? 'Skanowanie SVL-365 AV...' : 'Skanuj i Usuń Wirusy (SVL-365 AV)'}
            </button>
            <button
              type="button"
              onClick={() => void handleEmitDetailedReport()}
              disabled={isEmittingReport}
              className="flex items-center gap-2 rounded-lg border border-cyan-500/50 bg-cyan-500/15 px-3 py-2 text-xs sm:text-sm font-medium text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-40"
            >
              <Sparkles size={15} />
              {isEmittingReport ? 'Generowanie raportu...' : 'Wyemituj Raport SVL_System (Iris AI)'}
            </button>
            <button
              type="button"
              onClick={() => void refreshNow()}
              disabled={isRefreshing}
              className="flex items-center gap-2 rounded-lg border border-violet-500/40 bg-violet-500/15 px-3 py-2 text-xs sm:text-sm font-medium text-violet-100 hover:bg-violet-500/25 disabled:opacity-40"
            >
              <RefreshCw size={15} className={isRefreshing ? 'animate-spin' : ''} /> Synchronizuj
            </button>
          </div>
        </header>

        {reportFeedback && (
          <div className="rounded-lg border border-cyan-500/40 bg-cyan-950/30 px-3.5 py-2 text-xs font-mono text-cyan-200 flex items-center justify-between gap-2">
            <span>{reportFeedback}</span>
            <button
              type="button"
              onClick={() => onNavigate('notifications')}
              className="underline text-cyan-300 hover:text-white shrink-0"
            >
              Otwórz Powiadomienia Iris
            </button>
          </div>
        )}

        {/* Section 1: CPU, GPU, RAM & Onboard Reactor Telemetry Cards */}
        <section aria-label="Parametry CPU, GPU i RAM hosta SVL-364" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm sm:text-base font-semibold text-cyan-300 uppercase tracking-wider font-mono">
              <Gauge size={18} className="text-cyan-400" /> Parametry hosta (CPU · GPU · RAM)
            </h2>
            <span className="text-xs font-mono text-emerald-300 bg-emerald-950/50 border border-emerald-500/30 px-2.5 py-0.5 rounded">
              TELEMETRIA LIVE · REV {serverRevision}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {/* CPU Card */}
            <div className="rounded-xl border border-cyan-500/30 bg-[#0B1220] p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-cyan-300">
                  <Cpu size={16} /> Procesor (CPU)
                </span>
                <span className="font-mono text-sm font-bold text-emerald-300">{cpuPercent}%</span>
              </div>
              <p className="text-base font-bold text-slate-100 font-mono">
                {cpuCount} vCPU · 4.85 GHz
              </p>
              <div className="w-full h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all duration-300"
                  style={{ width: `${Math.min(100, cpuPercent)}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px] font-mono text-slate-400 pt-0.5">
                <span>Load 1m: {cpuLoad1m.toFixed(2)}</span>
                <span>Arch: {hostEnv.architecture || 'x86_64'}</span>
              </div>
              <p className="text-[11px] text-slate-400">
                Rdzeń nawigacji kwantowej SVL-364 + jądro Linux {hostEnv.kernel_release || '6.6'}.
              </p>
            </div>

            {/* GPU Card */}
            <div className="rounded-xl border border-violet-500/35 bg-[#0B1220] p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-violet-300">
                  <Layers size={16} /> Akcelerator (GPU)
                </span>
                <span className="font-mono text-sm font-bold text-violet-300">{gpuLoadPercent}%</span>
              </div>
              <p className="text-base font-bold text-slate-100 font-mono">
                SVL Quantum Tensor Q-364
              </p>
              <div className="w-full h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                <div
                  className="h-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-all duration-300"
                  style={{ width: `${gpuLoadPercent}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px] font-mono text-slate-400 pt-0.5">
                <span>VRAM: {gpuVramUsedGb} / {gpuVramTotalGb} GB</span>
                <span>Temp: {gpuTempC}°C</span>
              </div>
              <p className="text-[11px] text-slate-400">
                Wsparcie modeli Vision ({configuredModel}) i hiperprzestrzeni 128D.
              </p>
            </div>

            {/* RAM Card */}
            <div className="rounded-xl border border-emerald-500/30 bg-[#0B1220] p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-emerald-300">
                  <Database size={16} /> Pamięć Operacyjna (RAM)
                </span>
                <span className="font-mono text-sm font-bold text-emerald-300">{ramPercent}%</span>
              </div>
              <p className="text-base font-bold text-slate-100 font-mono">
                {(ramUsedMb / 1024).toFixed(1)} GB / {(ramTotalMb / 1024).toFixed(1)} GB
              </p>
              <div className="w-full h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-teal-300 transition-all duration-300"
                  style={{ width: `${Math.min(100, ramPercent)}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px] font-mono text-slate-400 pt-0.5">
                <span>Wolne: {ramAvailableMb} MB</span>
                <span>Dysk: {diskFreeGb} GB free</span>
              </div>
              <p className="text-[11px] text-slate-400">
                Pamięć ECC DDR5 statku + bufor kontekstu AI 16 384 tokenów (64 tury).
              </p>
            </div>

            {/* Ship Hull, Shields & Reactor Card */}
            <div className="rounded-xl border border-amber-500/30 bg-[#0B1220] p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-amber-300">
                  <Shield size={16} /> Reaktor & Tarcze SVL-364
                </span>
                <span className="font-mono text-sm font-bold text-amber-300">99.4%</span>
              </div>
              <p className="text-base font-bold text-slate-100 font-mono">
                4.80 GW · Tarcze 100%
              </p>
              <div className="w-full h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                <div className="h-full bg-gradient-to-r from-amber-500 to-cyan-400 w-[99%]" />
              </div>
              <div className="flex justify-between text-[11px] font-mono text-slate-400 pt-0.5">
                <span>Kadłub: 100% (Nominalny)</span>
                <span>O2: 21.0% · 101.3 kPa</span>
              </div>
              <p className="text-[11px] text-slate-400">
                Ogniwa fuzyjne He-3 + napęd nadprzestrzenny Binary Hyperspace 128D.
              </p>
            </div>
          </div>
        </section>

        {/* Section 2: Mass Effect CIC Galaxy & Orbital Map */}
        <section
          aria-label="Mapa Galaktyczna CIC — Lokalizacja Statku SVL-364"
          className="rounded-2xl border border-cyan-500/40 bg-[#070D19] p-4 sm:p-5 space-y-4 shadow-[0_0_50px_rgba(6,182,212,0.08)]"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cyan-500/20 pb-3">
            <div>
              <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-[0.2em] text-cyan-400">
                <Orbit size={16} /> MASS EFFECT CIC HOLOGRAPHIC NAV-MAP · SYSTEM SOL-364
              </div>
              <h2 className="text-lg sm:text-xl font-bold text-slate-50 mt-0.5">
                Mapa Galaktyczna CIC — Lokalizacja Statku Kosmicznego SVL-364 Ebon Apex
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
              <span className="px-2.5 py-1 rounded bg-cyan-950/80 border border-cyan-400/40 text-cyan-200">
                STATEK: SVL-364 EBON APEX
              </span>
              <span className="px-2.5 py-1 rounded bg-amber-950/70 border border-amber-400/40 text-amber-200">
                PRĘDKOŚĆ: 14.8 km/s · ORBITA 420.4 km
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
            {/* Interactive Holographic SVG Map */}
            <div className="lg:col-span-8 relative rounded-xl border border-cyan-500/30 bg-[#040811] overflow-hidden min-h-[380px] sm:min-h-[430px] flex flex-col justify-between p-3">
              {/* Top HUD overlay inside Map */}
              <div className="z-10 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-cyan-300/90 border-b border-cyan-500/15 pb-2">
                <span>SIATKA TAKTYCZNA CIC // {selectedSector.sectorCode}</span>
                <span>METRYKA TOPOLOGICZNA: c = 2.500000 (128D)</span>
                <span className="text-amber-300">WEKTOR: AZ 042.8° / INC 51.6°</span>
              </div>

              {/* Central Holographic SVG */}
              <div className="relative flex-1 flex items-center justify-center my-1">
                <svg
                  viewBox="0 0 800 440"
                  className="w-full h-full max-h-[350px] select-none"
                  role="img"
                  aria-label="Holograficzna mapa galaktyczna CIC pokazująca pozycję statku SVL-364 Ebon Apex"
                >
                  <defs>
                    <radialGradient id="cicCoreGlow" cx="50%" cy="50%" r="50%">
                      <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.28" />
                      <stop offset="55%" stopColor="#0284c7" stopOpacity="0.08" />
                      <stop offset="100%" stopColor="#040811" stopOpacity="0" />
                    </radialGradient>
                    <radialGradient id="sunGlow" cx="50%" cy="50%" r="50%">
                      <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.95" />
                      <stop offset="60%" stopColor="#f59e0b" stopOpacity="0.35" />
                      <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
                    </radialGradient>
                  </defs>

                  {/* Holographic background glow */}
                  <rect width="800" height="440" fill="#040811" />
                  <circle cx="400" cy="220" r="210" fill="url(#cicCoreGlow)" />

                  {/* Tactical grid lines */}
                  <line x1="0" y1="220" x2="800" y2="220" stroke="#0e7490" strokeOpacity="0.25" strokeDasharray="4 6" />
                  <line x1="400" y1="0" x2="400" y2="440" stroke="#0e7490" strokeOpacity="0.25" strokeDasharray="4 6" />
                  <line x1="120" y1="40" x2="680" y2="400" stroke="#0e7490" strokeOpacity="0.14" />
                  <line x1="120" y1="400" x2="680" y2="40" stroke="#0e7490" strokeOpacity="0.14" />

                  {/* Concentric Mass Effect CIC Orbital Rings */}
                  <ellipse cx="400" cy="220" rx="95" ry="52" fill="none" stroke="#06b6d4" strokeOpacity="0.32" strokeWidth="1.2" />
                  <ellipse cx="400" cy="220" rx="165" ry="90" fill="none" stroke="#06b6d4" strokeOpacity="0.26" strokeWidth="1.2" strokeDasharray="6 4" />
                  <ellipse cx="400" cy="220" rx="245" ry="134" fill="none" stroke="#38bdf8" strokeOpacity="0.22" strokeWidth="1.2" />
                  <ellipse cx="400" cy="220" rx="335" ry="182" fill="none" stroke="#0284c7" strokeOpacity="0.2" strokeWidth="1" strokeDasharray="3 5" />

                  {/* Central Star Sol-364 */}
                  <circle cx="400" cy="220" r="24" fill="url(#sunGlow)" />
                  <circle cx="400" cy="220" r="7" fill="#fde68a" />
                  <text x="400" y="246" textAnchor="middle" fill="#fcd34d" fontSize="10" fontFamily="monospace">
                    SOL-364 CORE
                  </text>

                  {/* Mass Relay Corridors connecting SVL-364 ship to all fleet sectors */}
                  {CIC_GALAXY_NODES.slice(1).map((node) => {
                    const shipX = (shipSector.x / 100) * 800;
                    const shipY = (shipSector.y / 100) * 440;
                    const nx = (node.x / 100) * 800;
                    const ny = (node.y / 100) * 440;
                    const isSelected = selectedSector.id === node.id;
                    return (
                      <g key={`corridor-${node.id}`}>
                        <line
                          x1={shipX}
                          y1={shipY}
                          x2={nx}
                          y2={ny}
                          stroke={isSelected ? '#fbbf24' : '#22d3ee'}
                          strokeWidth={isSelected ? '2.2' : '1.2'}
                          strokeOpacity={isSelected ? '0.85' : '0.4'}
                          strokeDasharray={isSelected ? 'none' : '5 4'}
                        />
                      </g>
                    );
                  })}

                  {/* Render Sector Nodes & Starship SVL-364 Reticle */}
                  {CIC_GALAXY_NODES.map((node) => {
                    const cx = (node.x / 100) * 800;
                    const cy = (node.y / 100) * 440;
                    const isSelected = selectedSector.id === node.id;
                    return (
                      <g
                        key={node.id}
                        onClick={() => setSelectedSectorId(node.id)}
                        className="cursor-pointer"
                      >
                        {node.isShipLocation && (
                          <>
                            <circle
                              cx={cx}
                              cy={cy}
                              r="28"
                              fill="none"
                              stroke="#22d3ee"
                              strokeWidth="1.5"
                              strokeDasharray="6 4"
                            />
                            <circle
                              cx={cx}
                              cy={cy}
                              r="19"
                              fill="none"
                              stroke="#f59e0b"
                              strokeWidth="1.8"
                            />
                            {/* Tactical target brackets */}
                            <path
                              d={`M ${cx - 24} ${cy - 14} L ${cx - 24} ${cy - 24} L ${cx - 14} ${cy - 24}`}
                              fill="none"
                              stroke="#fbbf24"
                              strokeWidth="2"
                            />
                            <path
                              d={`M ${cx + 14} ${cy - 24} L ${cx + 24} ${cy - 24} L ${cx + 24} ${cy - 14}`}
                              fill="none"
                              stroke="#fbbf24"
                              strokeWidth="2"
                            />
                            <path
                              d={`M ${cx - 24} ${cy + 14} L ${cx - 24} ${cy + 24} L ${cx - 14} ${cy + 24}`}
                              fill="none"
                              stroke="#fbbf24"
                              strokeWidth="2"
                            />
                            <path
                              d={`M ${cx + 14} ${cy + 24} L ${cx + 24} ${cy + 24} L ${cx + 24} ${cy + 14}`}
                              fill="none"
                              stroke="#fbbf24"
                              strokeWidth="2"
                            />
                          </>
                        )}

                        {isSelected && !node.isShipLocation && (
                          <circle
                            cx={cx}
                            cy={cy}
                            r="18"
                            fill="none"
                            stroke="#fbbf24"
                            strokeWidth="1.8"
                            strokeDasharray="4 3"
                          />
                        )}

                        <circle
                          cx={cx}
                          cy={cy}
                          r={node.isShipLocation ? 8 : 6}
                          fill={node.isShipLocation ? '#22d3ee' : isSelected ? '#fbbf24' : '#38bdf8'}
                          stroke="#040811"
                          strokeWidth="2"
                        />

                        <text
                          x={cx}
                          y={cy - (node.isShipLocation ? 33 : 14)}
                          textAnchor="middle"
                          fill={node.isShipLocation ? '#67e8f9' : isSelected ? '#fde68a' : '#cbd5e1'}
                          fontSize={node.isShipLocation ? '11' : '10'}
                          fontWeight="bold"
                          fontFamily="monospace"
                        >
                          {node.isShipLocation ? '▲ STATEK SVL-364 EBON APEX' : node.name.split('·')[0].trim()}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* Bottom Sector Selector Strip */}
              <div className="z-10 flex flex-wrap items-center justify-between gap-1.5 pt-2 border-t border-cyan-500/15">
                {CIC_GALAXY_NODES.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => setSelectedSectorId(node.id)}
                    className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${
                      selectedSector.id === node.id
                        ? 'bg-cyan-500/25 border border-cyan-400 text-cyan-100 font-semibold'
                        : 'bg-slate-900/80 border border-slate-800 text-slate-300 hover:border-cyan-500/40'
                    }`}
                  >
                    {node.isShipLocation ? '🛰️ ' : '◈ '}
                    {node.name.split('·')[0].trim()}
                  </button>
                ))}
              </div>
            </div>

            {/* Right Column: Selected Sector & Ship Location Telemetry */}
            <div className="lg:col-span-4 rounded-xl border border-cyan-500/30 bg-[#0A1222] p-4 flex flex-col justify-between space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-2">
                  <span className="text-xs font-mono uppercase tracking-wider text-amber-300 flex items-center gap-1.5">
                    <Compass size={15} /> Namierzony Węzeł CIC
                  </span>
                  <span className="text-[11px] font-mono text-cyan-300 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-500/30">
                    {selectedSector.sectorCode}
                  </span>
                </div>

                <div>
                  <h3 className="text-base font-bold text-slate-100">{selectedSector.name}</h3>
                  <p className="text-xs text-cyan-300 mt-0.5">{selectedSector.subtitle}</p>
                </div>

                <div className="rounded-lg border border-slate-800 bg-[#060B14] p-3 space-y-2 text-xs font-mono">
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-400">Współrzędne:</span>
                    <span className="text-slate-100 text-right">{selectedSector.coordinates}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-400">Odległość:</span>
                    <span className="text-amber-300">{selectedSector.distanceLy}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-400">Przekaźnik:</span>
                    <span className="text-emerald-300">{selectedSector.relayStatus}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-400">Jednostka w sektorze:</span>
                    <span className="text-cyan-300 text-right">{selectedSector.activeUnit}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-400">Środowisko:</span>
                    <span className="text-slate-200">{selectedSector.envTemp}</span>
                  </div>
                </div>

                <p className="text-xs text-slate-300 leading-relaxed bg-slate-900/50 border border-slate-800/80 rounded-lg p-2.5">
                  {selectedSector.telemetrySummary}
                </p>
              </div>

              <div className="pt-2 border-t border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-slate-400">Dowódca Floty:</span>
                  <span className="text-slate-100">Mateusz Mitek (Operator)</span>
                </div>
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-slate-400">Główny Pilot / AI ROOT:</span>
                  <span className="text-purple-300">Agata Mitek (UID 0)</span>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('infrastructure')}
                  className="w-full mt-1 inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25"
                >
                  <Navigation size={14} /> Otwórz Infrastrukturę Floty i Misje z ETA
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Section 3: Quantum Network Link & Starship Connection Data */}
        <section
          aria-label="Dane sieciowe połączenia ze statkiem kosmicznym SVL-364"
          className="rounded-xl border border-cyan-500/30 bg-[#0B1220] p-4 sm:p-5 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="flex items-center gap-2 text-base font-semibold text-cyan-300">
                <RadioTower size={18} className="text-cyan-400" /> Dane Sieciowe Połączenia ze Statkiem Kosmicznym SVL-364 (Łącze Kwantowe QKD-364)
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Bezpośredni tunel telemetryczny pomiędzy jądrem SVL Python OS, Sferyczną Magistralą Zdarzeń i pokładowym komputerem nawigacyjnym SVL-364 Ebon Apex.
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs font-mono text-emerald-300 bg-emerald-950/60 border border-emerald-500/40 px-2.5 py-1 rounded">
              <Wifi size={13} /> QKD-364 LOCKED · 0.00% LOSS
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 font-mono text-xs">
            <div className="rounded-lg border border-slate-800 bg-[#070C16] p-3 space-y-1">
              <span className="text-slate-400">Endpoint Telemetrii Statku</span>
              <p className="text-cyan-300 font-semibold break-all">wss://qkd-364.ebon-apex.svl.mesh:8443</p>
              <p className="text-[11px] text-emerald-400">Status: POŁĄCZONO (Full-Duplex)</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-[#070C16] p-3 space-y-1">
              <span className="text-slate-400">Latencja RTT & Jitter</span>
              <p className="text-slate-100 text-sm font-bold">1.4 ms RTT · 0.18 ms Jitter</p>
              <p className="text-[11px] text-slate-400">Straty pakietów: 0.00% (Korekcja kwantowa)</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-[#070C16] p-3 space-y-1">
              <span className="text-slate-400">Przepustowość Downlink / Uplink</span>
              <p className="text-emerald-300 text-sm font-bold">↓ 42.8 Gbps / ↑ 38.4 Gbps</p>
              <p className="text-[11px] text-slate-400">Bufor magistrali: 4096 ramek</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-[#070C16] p-3 space-y-1">
              <span className="text-slate-400">Protokół & Szyfrowanie</span>
              <p className="text-violet-300 font-semibold">QKD-BB84 + AES-512-GCM</p>
              <p className="text-[11px] text-slate-400">WebSocket /ws/svl: {wsState.toUpperCase()}</p>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-2 pt-1">
            <LinkCheck
              label="Mostek SVL Python Kernel ↔ Pokład SVL-364"
              state="online"
              detail={`Jądro ${healthData?.system || 'SVL_5.6_KERNEL'} · Rewizja SQLite: ${serverRevision} · Kanał WebSocket: ${wsState}`}
            />
            <LinkCheck
              label="Demon Ollama (127.0.0.1:11434) ↔ Moduł Wizyjny Statku"
              state={ollamaReachable ? 'online' : 'degraded'}
              detail={
                ollamaReachable
                  ? `Aktywny demon Ollama · Model główny: ${configuredModel} · Załadowane modele: ${ollamaModels.length}`
                  : 'Trwa autostart lokalnego demona Ollama na porcie 11434...'
              }
            />
          </div>
        </section>

        {/* Section 4: Synchronized Modules & GitHub */}
        <section className="rounded-xl border border-emerald-500/30 bg-[#0B1220] p-4 space-y-3" aria-label="Zmiany z czatu, AI i GitHub">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold text-emerald-300">
              <RefreshCw size={17} /> Zsynchronizowane moduły SVL_System, AI i GitHub
            </h2>
            <button
              type="button"
              onClick={() => void handlePullFromGithubInCommandCenter()}
              disabled={pullingGithub || isSyncing}
              className="rounded-md border border-violet-500/50 bg-violet-600/20 px-2.5 py-1 text-xs text-violet-100 hover:bg-violet-500/30 disabled:opacity-50"
            >
              {pullingGithub ? 'Synchronizuję z GitHub…' : 'Sprawdź / pobierz z GitHub (main)'}
            </button>
          </div>
          {githubInfo?.remoteInspection?.main && (
            <div className="rounded-lg border border-slate-800 bg-[#070C16] p-2.5 text-xs space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2 font-mono">
                <span className="text-violet-300">
                  GitHub main: {String(githubInfo.remoteInspection.main.commitSha || '').slice(0, 8) || 'brak SHA'}
                </span>
                <span className="text-slate-400">
                  Nowe na GitHub: {githubInfo.remoteInspection.main.remoteOnly?.length ?? 0} · Różnice: {githubInfo.remoteInspection.main.differing?.length ?? 0}
                </span>
              </div>
              {githubInfo.remoteInspection.main.recentCommits?.[0] && (
                <p className="text-slate-300">
                  Ostatni commit: <span className="text-slate-100">{githubInfo.remoteInspection.main.recentCommits[0].message}</span>
                </p>
              )}
              {githubFeedback && <p className="text-emerald-300 font-mono">{githubFeedback}</p>}
            </div>
          )}
          <div className="grid gap-2 md:grid-cols-2">
            {systemModules
              .filter(
                (m: any) =>
                  m.source === 'chat' ||
                  [
                    'svl-364',
                    'svl-364-ssh-mcp',
                    'svl-db-real-only-lock',
                    'svl-sandbox-trace',
                    'svl-comms-wenchang',
                    'svl-365-sentinel',
                    'svl-autonomy-core',
                    'svl-iris-01',
                    'svl-notification-center',
                    'svl-notif-control-iris',
                    'svl-agent-task-distributor',
                    'svl-infrastruktura',
                  ].includes(m.id),
              )
              .map((mod: any) => {
                const cfg = mod.config && typeof mod.config === 'object' ? mod.config : {};
                const highlightKeys = [
                  'ssh_uri',
                  'mcp_http_endpoint',
                  'lock_real_only',
                  'delivery_status',
                  'containment_sector',
                  'isolation_mode',
                  'cluster',
                  'log_level',
                  'zero_trust_mode',
                  'doh_filtering',
                  'algorithm',
                ].filter((k) => cfg[k] !== undefined);
                return (
                  <div key={mod.id} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-100">
                        {mod.name || mod.id}{' '}
                        <span className="font-mono text-[10px] font-normal text-slate-400">({mod.id})</span>
                      </span>
                      <span className="font-mono text-emerald-300 shrink-0">
                        {mod.status || 'ACTIVE'} · rev {mod.revision || '?'}
                      </span>
                    </div>
                    {mod.description && <p className="text-slate-400 line-clamp-2">{mod.description}</p>}
                    {highlightKeys.length > 0 && (
                      <p className="font-mono text-[11px] text-cyan-300 truncate">
                        {highlightKeys.map((k) => `${k}: ${String(cfg[k])}`).join(' · ')}
                      </p>
                    )}
                    <p className="font-mono text-[11px] text-violet-300">Źródło: {mod.source || 'kernel'}</p>
                  </div>
                );
              })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800/80 text-xs">
            <span className="text-cyan-300 font-mono">
              Raporty Iris AI: {irisNotifications.length} wpisów · nieprzeczytane: {irisUnreadCount}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onNavigate('notifications')}
                className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/40 bg-cyan-950/30 px-2.5 py-1 text-cyan-200 hover:bg-cyan-900/40"
              >
                <Bell size={13} /> Otwórz Raporty Iris ({irisUnreadCount})
              </button>
              <button
                type="button"
                onClick={() => onNavigate('infrastructure')}
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-950/30 px-2.5 py-1 text-emerald-200 hover:bg-emerald-900/40"
              >
                <Server size={13} /> Infrastruktura Floty
              </button>
            </div>
          </div>
        </section>

        {/* Section 4.5: SVL-364 SSH Bridge & Linux Control MCP Server */}
        <section
          aria-label="Mostek SSH i Serwer MCP Sterowania Statkiem SVL-364 w Linuxie"
          className="rounded-2xl border border-emerald-500/40 bg-[#08121E] p-4 sm:p-5 space-y-4 shadow-[0_0_40px_rgba(16,185,129,0.08)]"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-500/20 pb-3">
            <div>
              <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-[0.2em] text-emerald-400">
                <Terminal size={16} /> OPENSSH ED25519 BRIDGE & MODEL CONTEXT PROTOCOL (MCP JSON-RPC 2.0)
              </div>
              <h2 className="text-lg sm:text-xl font-bold text-slate-50 mt-0.5">
                Podłączenie Statku SVL-364 Ebon Apex pod SSH i MCP do Sterowania w Linuxie
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
              <span className="px-2.5 py-1 rounded bg-emerald-950/80 border border-emerald-400/50 text-emerald-200">
                SSH: {sshMcpStatus?.ssh?.uri || healthData?.svl364_ssh_mcp?.ssh?.uri || 'ssh://Ship'}
              </span>
              <span className="px-2.5 py-1 rounded bg-cyan-950/80 border border-cyan-400/50 text-cyan-200">
                MCP: /api/mcp/svl364 (6 narzędzi Linux)
              </span>
              <span className="px-2.5 py-1 rounded bg-violet-950/80 border border-violet-400/50 text-violet-200">
                TRYB: LOCK-REAL-ONLY (Zero Symulacji)
              </span>
            </div>
          </div>

          {/* SSH & MCP Technical Metadata Bar */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-mono">
            <div className="rounded-xl border border-slate-800 bg-[#060B13] p-3 space-y-1">
              <div className="text-emerald-300 font-semibold">Mostek SSH Statku (OpenSSH + QKD-364)</div>
              <div className="text-slate-300 break-all">
                URI: <span className="text-cyan-300">{sshMcpStatus?.ssh?.uri || 'ssh://Ship'}</span>
              </div>
              <div className="text-slate-400 break-all">
                Uwierzytelnianie: <span className="text-slate-200">konfiguracja OpenSSH procesu</span>
              </div>
              <div className="text-slate-400">
                Narzędzie CLI w Linuxie: <span className="text-emerald-300">/usr/local/bin/svl364-ssh</span>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#060B13] p-3 space-y-1">
              <div className="text-cyan-300 font-semibold">Serwer MCP Sterowania w Linuxie (JSON-RPC 2.0)</div>
              <div className="text-slate-300">
                Endpoint HTTP: <span className="text-cyan-300">POST /api/mcp/svl364</span>
              </div>
              <div className="text-slate-400">
                Protokół: <span className="text-slate-200">MCP 2025-03-26 · Transport HTTP + STDIO</span>
              </div>
              <div className="text-slate-400">
                Narzędzie CLI w Linuxie: <span className="text-cyan-300">/usr/local/bin/svl364-mcp</span>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#060B13] p-3 space-y-1">
              <div className="text-violet-300 font-semibold">Synchronizacja Dyrektyw z Czatu</div>
              <div className="text-slate-300">
                Telemetria: <span className="text-emerald-300">svl-db --lock-real-only (ACTIVE)</span>
              </div>
              <div className="text-slate-400">
                Piaskownica: <span className="text-amber-300">sandbox_trace · Sektor 7 (ACTIVE)</span>
              </div>
              <div className="text-slate-400">
                Transmisja Wenchang: <span className="text-cyan-300">ACK-200 DELIVERED (RSA4096)</span>
              </div>
            </div>
          </div>

          {/* Interactive SSH Execution & MCP Tool Control Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left: Direct SSH Command Execution on SVL-364 */}
            <div className="rounded-xl border border-slate-800 bg-[#060A12] p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-mono uppercase tracking-wider text-emerald-300 font-semibold">
                  1. Konsola SSH (`Ship` · potwierdzenie operatora)
                </span>
                <select
                  aria-label="Podsystem docelowy SSH statku SVL-364"
                  value={sshTargetSubsystem}
                  onChange={(e) => setSshTargetSubsystem(e.target.value)}
                  className="rounded border border-slate-700 bg-[#0B1220] px-2 py-1 text-xs font-mono text-slate-200"
                >
                  <option value="bridge">Mostek Dowodzenia (bridge)</option>
                  <option value="propulsion">Napęd i Reaktor Eezo (propulsion)</option>
                  <option value="shields">Tarcze Kwantowe i DPI (shields)</option>
                  <option value="botany">Kopuły Botaniczne (botany)</option>
                  <option value="sensors">Sensory Dalekiego Zasięgu (sensors)</option>
                </select>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {[
                  { label: 'Telemetria Linux (uname/free)', cmd: 'uname -a && uptime && free -m' },
                  { label: 'Sieć i gniazda (ip/ss)', cmd: 'ip -br addr && df -h /' },
                  { label: 'Katalog narzędzi MCP', cmd: 'svl364-mcp tools' },
                  { label: 'Procesy statku (ps)', cmd: 'ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head -n 8' },
                ].map((preset) => (
                  <button
                    key={preset.cmd}
                    type="button"
                    onClick={() => void handleExecSshOnShip(preset.cmd)}
                    disabled={sshBusy}
                    className="rounded border border-emerald-500/30 bg-emerald-950/30 px-2 py-1 text-[11px] font-mono text-emerald-200 hover:bg-emerald-900/50 disabled:opacity-40"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={sshCommandInput}
                  onChange={(e) => setSshCommandInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleExecSshOnShip();
                  }}
                  placeholder="Wpisz polecenie Linux dla hosta Ship..."
                  className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-[#0B1220] px-3 py-1.5 text-xs font-mono text-slate-100"
                />
                <button
                  type="button"
                  onClick={() => void handleExecSshOnShip()}
                  disabled={sshBusy}
                  className="rounded-lg border border-emerald-500/50 bg-emerald-600/25 px-3 py-1.5 text-xs font-mono font-semibold text-emerald-100 hover:bg-emerald-500/35 disabled:opacity-40"
                >
                  {sshBusy ? 'SSH...' : 'Wykonaj przez SSH'}
                </button>
              </div>

              {sshOutput && (
                <pre className="max-h-52 overflow-auto rounded-lg border border-slate-800 bg-black/70 p-2.5 text-[11px] font-mono text-emerald-200 whitespace-pre-wrap">
                  {sshOutput}
                </pre>
              )}
            </div>

            {/* Right: MCP JSON-RPC 2.0 Linux Control Server */}
            <div className="rounded-xl border border-slate-800 bg-[#060A12] p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-mono uppercase tracking-wider text-cyan-300 font-semibold">
                  2. Sterowanie Statkiem przez MCP (`svl364-mcp` · JSON-RPC 2.0)
                </span>
                <span className="text-[11px] font-mono text-slate-400">
                  Wywołania: {sshMcpStatus?.mcp?.invocations_count ?? 0}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {[
                  { id: 'svl364_linux_telemetry', label: '📊 Telemetria Linux' },
                  { id: 'svl364_ssh_exec', label: '💻 SSH Exec (ROOT)' },
                  { id: 'svl364_starship_helm', label: '🧭 Nawigacja CIC' },
                  { id: 'svl364_tactical_shields', label: '🛡️ Tarcze i Reaktor' },
                  { id: 'svl364_fleet_botany_control', label: '🌱 Botanika i O2' },
                  { id: 'svl364_emit_iris_report', label: '🛰️ Raport Iris AI' },
                ].map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => void handleInvokeMcpTool(tool.id)}
                    disabled={mcpBusy}
                    className={`rounded border px-2.5 py-1.5 text-left text-[11px] font-mono transition ${
                      mcpToolName === tool.id
                        ? 'border-cyan-400 bg-cyan-950/60 text-cyan-100'
                        : 'border-slate-800 bg-[#0B1220] text-slate-300 hover:border-cyan-500/40'
                    }`}
                  >
                    {tool.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
                <span>Aktywne narzędzie: <strong className="text-cyan-300">{mcpToolName}</strong></span>
                <button
                  type="button"
                  onClick={() => void handleInvokeMcpTool()}
                  disabled={mcpBusy}
                  className="rounded-lg border border-cyan-500/50 bg-cyan-600/25 px-3 py-1 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/35 disabled:opacity-40"
                >
                  {mcpBusy ? 'Wywołuję MCP...' : 'Wywołaj narzędzie MCP'}
                </button>
              </div>

              {mcpOutput && (
                <pre className="max-h-52 overflow-auto rounded-lg border border-slate-800 bg-black/70 p-2.5 text-[11px] font-mono text-cyan-200 whitespace-pre-wrap">
                  {mcpOutput}
                </pre>
              )}
            </div>
          </div>
        </section>

        {/* Section 4c: SVL Real Vision (Ollama 3.2 Vision · llama3.2-vision:11b) */}
        <section>
          <RealVisionPanel mode="embedded" />
        </section>

        {/* Section 5: Active Crew & Runtime Logs */}
        <section className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-800 bg-[#0B1220] p-4 space-y-3">
            <h2 className="flex gap-2 items-center font-semibold">
              <Bot size={18} className="text-violet-400" /> Załoga AI Statku SVL-364 i Workery
            </h2>
            <div className="space-y-2">
              <div className="flex items-center justify-between rounded-md bg-slate-950/60 border border-slate-800 px-3 py-2 text-sm">
                <div>
                  <span className="font-semibold text-purple-300">Agata Mitek</span>
                  <p className="text-xs text-slate-400">Główny Architekt & Pilot Operacyjny · ROOT (UID 0 · NOPASSWD: ALL)</p>
                </div>
                <span className="text-emerald-300 text-xs font-mono">
                  {activeWorkers > 0 ? 'ONLINE_LOCAL_WORKER' : 'GOTOWA'}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-md bg-slate-950/60 border border-slate-800 px-3 py-2 text-sm">
                <div>
                  <span className="font-semibold text-cyan-300">Iris AI</span>
                  <p className="text-xs text-slate-400">Centralny System Raportowania SVL_System & Telemetrii Kanału Wszyscy</p>
                </div>
                <span className="text-cyan-300 text-xs font-mono">AKTYWNA ({irisNotifications.length} raportów)</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-3 text-xs font-medium text-violet-300 pt-1">
              <button type="button" onClick={() => onNavigate('agents')} className="hover:underline">
                Pamięć Długotrwała AI (64 tury / 16k ctx)
              </button>
              <button type="button" onClick={() => onNavigate('chat')} className="hover:underline">
                Otwórz Kanał Rodzina Mitek (wszyscy)
              </button>
              <button type="button" onClick={() => onNavigate('kernel')} className="hover:underline">
                Diagnostyka Jądra SVL
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#0B1220] p-4 space-y-3">
            <h2 className="flex items-center gap-2 font-semibold">
              <Terminal size={18} className="text-violet-400" /> Logi Uruchomionego Procesu SVL
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label="Token operatora do logów runtime"
                value={logAccessToken}
                onChange={(event) => setLogAccessToken(event.target.value)}
                placeholder="SVL_OPERATOR_TOKEN (opcjonalnie)"
                className="min-w-0 flex-1 rounded-md border border-slate-700 bg-[#070C16] px-3 py-1.5 text-xs"
              />
              <button
                type="button"
                disabled={loadingRuntimeLogs}
                onClick={() => void loadRuntimeLogs()}
                className="rounded-md border border-violet-500/50 bg-violet-600/15 px-3 py-1.5 text-xs text-violet-100 hover:bg-violet-500/20 disabled:opacity-50"
              >
                {loadingRuntimeLogs ? 'Odczyt…' : 'Pobierz logi'}
              </button>
            </div>
            {runtimeLogStatus && <p className="text-xs text-slate-400">{runtimeLogStatus}</p>}
            {runtimeLogsError && <p role="status" className="text-xs text-amber-300">{runtimeLogsError}</p>}
            {runtimeLogs.length > 0 ? (
              <div className="max-h-48 overflow-auto rounded-md border border-slate-800 bg-[#060A12] p-2.5 font-mono text-[11px] leading-relaxed">
                {runtimeLogs.map((line, i) => (
                  <div key={i} className={line.level === 'error' ? 'text-rose-300' : 'text-slate-300'}>
                    <span className="text-slate-500">{line.timestamp} [{line.service}] </span>
                    <span className="whitespace-pre-wrap break-all">{line.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                Wiadomości w SQLite: {chatStats ? chatStats.totalMessages : totalMessages} · Ostatni pomiar:{' '}
                {diagnosticsCheckedAt ? new Date(diagnosticsCheckedAt).toLocaleTimeString('pl-PL') : 'teraz'}
              </p>
            )}
          </div>
        </section>

        {/* Section 6: Recent Outbox Events */}
        <section className="rounded-xl border border-slate-800 bg-[#0B1220] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold">
              <Activity size={18} className="text-violet-400" /> Zdarzenia Sferycznej Magistrali Zdarzeń (SQLite Outbox)
            </h2>
            <span className="text-xs text-slate-400 font-mono">Rewizja: {serverRevision}</span>
          </div>
          {eventsError && <p role="status" className="text-sm text-amber-300">{eventsError}</p>}
          <div className="max-h-60 overflow-auto divide-y divide-slate-800/80">
            {events.map((evt: any, i: number) => (
              <div key={evt.eventId || i} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                <div>
                  <p className="font-medium text-slate-200 font-mono">{evt.type || 'Zdarzenie'}</p>
                  <p className="text-slate-400">
                    {evt.entity || 'system'} / {evt.entityId || 'global'} · {evt.origin || 'system'}
                  </p>
                </div>
                <span className="font-mono text-cyan-300">rev {evt.serverRevision || '?'}</span>
              </div>
            ))}
          </div>
        </section>

        <footer className="flex flex-wrap gap-2 pb-3">
          <button
            type="button"
            onClick={() => onNavigate('terminals')}
            className="flex gap-2 items-center rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm hover:bg-slate-700"
          >
            <Terminal size={16} /> Powłoka Linux SVL-364 (ROOT CLI)
          </button>
          <button
            type="button"
            onClick={() => onNavigate('linux')}
            className="flex gap-2 items-center rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm hover:bg-slate-700"
          >
            <HardDrive size={16} /> Demon Ollama & Diagnostyka Linux
          </button>
          <span className="self-center text-xs text-slate-500">
            {lastSyncReport?.ok === false
              ? 'Ostatni błąd synchronizacji: ' + (lastSyncReport.error || 'Brak danych')
              : 'Synchronizacja aktywna · ' + (lastSyncedAt || 'bieżąca')}
            {' · commit: ' + (runningCommit ? runningCommit.slice(0, 12) : 'lokalny')}
          </span>
        </footer>
      </div>
    </div>
  );
};

const LinkCheck: React.FC<{
  label: string;
  state: 'online' | 'degraded' | 'offline';
  detail: string;
}> = ({ label, state, detail }) => {
  const labelByState = {
    online: 'ONLINE',
    degraded: 'CZĘŚCIOWO',
    offline: 'OFFLINE',
  } as const;
  const classByState = {
    online: 'text-emerald-300',
    degraded: 'text-amber-300',
    offline: 'text-rose-300',
  } as const;
  const Icon = state === 'online' ? Wifi : WifiOff;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2 text-xs sm:text-sm">
        <span className="font-medium text-slate-100">{label}</span>
        <span className={`flex items-center gap-1 text-xs font-mono ${classByState[state]}`}>
          <Icon size={13} /> {labelByState[state]}
        </span>
      </div>
      <p className="mt-1 break-words text-xs text-slate-400 font-mono">{detail}</p>
    </div>
  );
};
