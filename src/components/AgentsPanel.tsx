import React, { useState, useEffect, useRef } from 'react';
import {
  Send,
  RefreshCw,
  CheckCircle2,
  GitBranch,
  MessageSquare,
  Sliders,
  AlertTriangle,
} from 'lucide-react';
import { CANONICAL_AGENTS, createUniqueId, formatAgentDisplayName, safeFetchJson } from '../utils/svlLogic';
import { useSvlSync } from '../utils/svlSyncStore';

interface AgentsPanelProps {
  onNavigateToChat?: () => void;
}

export const AgentsPanel: React.FC<AgentsPanelProps> = ({ onNavigateToChat }) => {
  const {
    tabOrigin,
    agentsData,
    healthData,
    isConnectingAi,
    connectMyAi,
    refreshDomainModules,
    selectedAgentPanel: selectedAgent,
    setSelectedAgentPanel: setSelectedAgent,
    setTargetAgent,
    notifyLocalMutation,
    serverRevision,
    systemModules,
  } = useSvlSync();

  const [senderActor, setSenderActor] = useState<'operator' | 'Aria' | 'Alex' | 'Astyria' | 'Aurelius' | 'Agata'>('operator');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskPayload, setTaskPayload] = useState('');
  const [memoryContent, setMemoryContent] = useState('');
  const [memoryKind, setMemoryKind] = useState<'fact' | 'decision' | 'task' | 'episode'>('fact');
  const [dispatchStatus, setDispatchStatus] = useState<string | null>(null);
  const [memoryStatus, setMemoryStatus] = useState<string | null>(null);
  const [configStatus, setConfigStatus] = useState<{ ok: boolean; msg: string; conflict?: boolean } | null>(null);
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  const agentsList: any[] = agentsData?.agents || [];
  const agentLogs: Record<string, any[]> = agentsData?.agent_logs || {};
  const agentQueues: Record<string, any[]> = agentsData?.agent_queues || {};
  const agentMemories: Record<string, any[]> = agentsData?.agent_memories || {};
  const sphericalBus = agentsData?.spherical_bus || {};
  const lastReport = agentsData?.last_sync_report;
  const ollamaModels: any[] = healthData?.ollama?.models || [];
  const pullState = healthData?.ollama?.pull_state;
  const svl364ConfiguredModel = String(
    systemModules.find((m) => m.id === 'svl-364')?.config?.configured_ollama_model || '',
  ).trim();
  const hasConfiguredModelPulled = Boolean(
    svl364ConfiguredModel &&
      ollamaModels.some(
        (m: any) =>
          m.name === svl364ConfiguredModel ||
          String(m.name || '').startsWith(`${svl364ConfiguredModel.split(':')[0]}:`),
      ),
  );

  const activeAgentObj = agentsList.find((a) => a.canonical_name === selectedAgent) || {};
  const activeAgentCfg = activeAgentObj.config || {};
  const selectedAgentTasks = agentQueues[selectedAgent] || [];
  const currentConfigRevision: number | undefined =
    typeof activeAgentObj.config_revision === 'number'
      ? activeAgentObj.config_revision
      : typeof activeAgentCfg.revision === 'number'
        ? activeAgentCfg.revision
        : undefined;

  const [cfgPreferredModel, setCfgPreferredModel] = useState('svl-hybrid-router');
  const [cfgOllamaModel, setCfgOllamaModel] = useState('llama3.2-vision:11b');
  const [cfgFallbackModel, setCfgFallbackModel] = useState('gemini-3.1-flash-lite');
  const [cfgTemperature, setCfgTemperature] = useState('0.7');
  const [cfgRbacRole, setCfgRbacRole] = useState('');
  const [cfgVisionEnabled, setCfgVisionEnabled] = useState(true);
  const [cfgSystemPrompt, setCfgSystemPrompt] = useState('');

  const [isConfigDirty, setIsConfigDirty] = useState(false);
  const [remoteConfigChangedWhileDirty, setRemoteConfigChangedWhileDirty] = useState(false);
  const loadedRevisionRef = useRef<{ agent: string; rev?: number }>({ agent: selectedAgent, rev: undefined });

  const hydrateConfigFormFromServer = () => {
    setCfgPreferredModel(activeAgentCfg.preferred_model || 'svl-hybrid-router');
    setCfgOllamaModel(activeAgentCfg.ollama_model || 'llama3.2-vision:11b');
    setCfgFallbackModel(activeAgentCfg.fallback_model || 'gemini-3.1-flash-lite');
    setCfgTemperature(String(activeAgentCfg.temperature ?? 0.7));
    setCfgRbacRole(activeAgentCfg.rbac_role || '');
    setCfgVisionEnabled(activeAgentCfg.vision_enabled !== false);
    setCfgSystemPrompt(activeAgentCfg.system_prompt || '');
    setIsConfigDirty(false);
    setRemoteConfigChangedWhileDirty(false);
    loadedRevisionRef.current = { agent: selectedAgent, rev: currentConfigRevision };
  };

  useEffect(() => {
    const agentChanged = loadedRevisionRef.current.agent !== selectedAgent;
    if (agentChanged) {
      hydrateConfigFormFromServer();
      setConfigStatus(null);
      return;
    }

    const revChanged =
      currentConfigRevision !== undefined && currentConfigRevision !== loadedRevisionRef.current.rev;

    if (!isConfigDirty) {
      hydrateConfigFormFromServer();
    } else if (revChanged) {
      setRemoteConfigChangedWhileDirty(true);
    }
  }, [
    selectedAgent,
    currentConfigRevision,
    activeAgentCfg.preferred_model,
    activeAgentCfg.ollama_model,
    activeAgentCfg.fallback_model,
    activeAgentCfg.temperature,
    activeAgentCfg.rbac_role,
    activeAgentCfg.vision_enabled,
    activeAgentCfg.system_prompt,
    isConfigDirty,
  ]);

  const markDirty = () => {
    if (!isConfigDirty) setIsConfigDirty(true);
  };

  const handleDispatchTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskTitle.trim()) {
      setDispatchStatus('Błąd: Tytuł zadania nie może być pusty.');
      return;
    }
    setDispatchStatus('Wysyłanie zadania przez Sferyczną Magistralę Zdarzeń...');
    const res = await safeFetchJson<any>('/api/py/agents/task', {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        sender: senderActor,
        target_agent: selectedAgent,
        title: taskTitle.trim(),
        payload: taskPayload.trim() || taskTitle.trim(),
        origin: tabOrigin,
        eventId: createUniqueId('evt-task'),
      }),
    });
    const data = res.data;
    if (res.ok && data?.ok) {
      setDispatchStatus(`Zadanie dodane do trwałej kolejki ${selectedAgent} (ID: ${String(data.task?.id || '').slice(0, 8)}). Wynik pojawi się po zakończeniu.`);
      setTaskTitle('');
      setTaskPayload('');
      notifyLocalMutation('agent_task', selectedAgent, data.serverRevision, data.event);
      await refreshDomainModules(['agents']);
    } else {
      setDispatchStatus(`Błąd: ${res.error || data?.error || 'Nie udało się wykonać zadania'}`);
    }
  };

  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!memoryContent.trim()) {
      setMemoryStatus('Błąd: Wpis pamięci nie może być pusty.');
      return;
    }
    const res = await safeFetchJson<any>('/api/py/agents/memory', {
      method: 'POST',
      timeoutMs: 12000,
      body: JSON.stringify({
        agent: selectedAgent,
        kind: memoryKind,
        content: memoryContent.trim(),
        origin: tabOrigin,
        eventId: createUniqueId('evt-mem'),
      }),
    });
    const data = res.data;
    if (res.ok && data?.ok) {
      setMemoryStatus(`Zapisano w trwałej pamięci SQLite (zakres: agent:${selectedAgent}).`);
      setMemoryContent('');
      notifyLocalMutation('agent_memory', selectedAgent, data.serverRevision, data.event);
      await refreshDomainModules(['agents']);
    } else {
      setMemoryStatus(`Błąd: ${res.error || data?.error || 'Nie udało się zapisać pamięci.'}`);
    }
  };

  const handleSaveAgentConfig = async (e: React.FormEvent, forceLatestRevision = false) => {
    e.preventDefault();
    setIsSavingConfig(true);
    setConfigStatus(null);
    try {
      const expectedRev = forceLatestRevision ? currentConfigRevision : loadedRevisionRef.current.rev;
      const res = await safeFetchJson<any>('/api/py/agents/config', {
        method: 'POST',
        timeoutMs: 12000,
        body: JSON.stringify({
          agent: selectedAgent,
          expectedRevision: expectedRev,
          origin: tabOrigin,
          eventId: createUniqueId('evt-cfg'),
          config: {
            preferred_model: cfgPreferredModel,
            ollama_model: cfgOllamaModel,
            fallback_model: cfgFallbackModel,
            temperature: Number(cfgTemperature) || 0.7,
            rbac_role: cfgRbacRole,
            vision_enabled: cfgVisionEnabled,
            system_prompt: cfgSystemPrompt,
          },
        }),
      });
      const data = res.data;
      if (res.ok && data?.ok) {
        loadedRevisionRef.current = { agent: selectedAgent, rev: data.revision };
        setIsConfigDirty(false);
        setRemoteConfigChangedWhileDirty(false);
        setConfigStatus({
          ok: true,
          msg: `Zapisano pełną konfigurację dla ${selectedAgent} w SQLite (rewizja ${data.revision ?? '?'}).`,
        });
        notifyLocalMutation('agent_config', selectedAgent, data.serverRevision, data.event);
        await refreshDomainModules(['agents']);
      } else if (res.conflict || res.status === 409) {
        setRemoteConfigChangedWhileDirty(true);
        setConfigStatus({
          ok: false,
          conflict: true,
          msg:
            `Konflikt rewizji (HTTP 409): konfiguracja ${selectedAgent} została zmieniona w innej sesji (serwer rev ${data?.currentRevision ?? '?'}). ` +
            `Twoje niezapisane pola zachowano.`,
        });
        await refreshDomainModules(['agents']);
      } else {
        setConfigStatus({
          ok: false,
          msg: `Błąd zapisu: ${res.error || data?.error || 'Nieznany błąd zapisu'}`,
        });
      }
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleConfigureAllAgents = async () => {
    setIsSavingConfig(true);
    setConfigStatus(null);
    try {
      const res = await safeFetchJson<any>('/api/py/agents/configure-all', {
        method: 'POST',
        timeoutMs: 25000,
        body: JSON.stringify({
          origin: tabOrigin,
          config: {
            preferred_model: 'svl-hybrid-router',
            ollama_model: 'llama3.2-vision:11b',
            fallback_model: 'gemini-3.1-flash-lite',
            vision_enabled: true,
            auto_connect_on_boot: true,
          },
        }),
      });
      const data = res.data;
      setIsConfigDirty(false);
      await refreshDomainModules(['agents', 'health']);
      if (res.ok && data?.ok) {
        notifyLocalMutation('agent_config', 'all', data.serverRevision);
        setConfigStatus({
          ok: true,
          msg: 'Skonfigurowano i podłączono wszystkich 5 agentów (Ollama llama3.2-vision:11b + Gemini 3.1 + Magistrala Sferyczna).',
        });
      } else {
        setConfigStatus({
          ok: false,
          msg: `Błąd: ${res.error || data?.error || 'Nie udało się skonfigurować agentów.'}`,
        });
      }
    } finally {
      setIsSavingConfig(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-6 bg-[#0B0D13]">
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <h1 className="text-xl font-bold text-slate-100">
            01. Panel Pięciu Agentów AI — Rodzina Mitek (Aria Mitek, Alex Mitek, Astyria Mitek, Aurelius Mitek, Agata Mitek)
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Zachowane identyfikatory z <code className="text-violet-300">mmitek515-netizen/SVL_System</code>, lokalne procesy workerów o rzeczywistym PID/UID, trwała kolejka SQLite, tekstowe zadania Ollama i magistrala zdarzeń (rev {serverRevision}).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => void refreshDomainModules(['agents', 'health'])}
            className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#111520] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-2 transition-colors whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Odśwież telemetrię
          </button>
          <button
            type="button"
            onClick={() => void handleConfigureAllAgents()}
            disabled={isSavingConfig}
            className="min-h-[40px] px-3.5 py-2 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 disabled:opacity-50 text-xs font-semibold text-white flex items-center gap-2 transition-colors whitespace-nowrap"
          >
            <Sliders className="w-3.5 h-3.5" />
            Skonfiguruj wszystkim 11B Vision
          </button>
          <button
            type="button"
            onClick={() => void connectMyAi('agents_panel_button')}
            disabled={isConnectingAi}
            className="min-h-[40px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-xs font-semibold text-white flex items-center gap-2 transition-colors whitespace-nowrap"
          >
            <GitBranch className="w-4 h-4" />
            {isConnectingAi ? 'Łączenie z SVL_System...' : 'Wykonaj: podłącz moje ai'}
          </button>
        </div>
      </div>

      {/* Repository Connection Finding Banner */}
      {lastReport && (
        <div className="p-4 rounded-xl bg-[#111520] border border-slate-800 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-emerald-400 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              Raport polecenia &quot;podłącz moje ai&quot; ({lastReport.executed_at})
            </span>
            <span className="text-xs font-mono text-slate-400">
              SVL_System HTTP: {lastReport.repositories_inspected?.SVL_System?.http_status || 'Local'} · Debian_13 HTTP: {lastReport.repositories_inspected?.Debian_13?.http_status || 'Local'}
            </span>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">
            {lastReport.architectural_finding}
          </p>
        </div>
      )}

      {/* Canonical agent cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {CANONICAL_AGENTS.map((meta) => {
          const live = agentsList.find((a) => a.canonical_name === meta.canonicalName) || {};
          const cb = sphericalBus.circuit_breakers?.[meta.canonicalName] || { state: 'CLOSED', failure_count: 0 };
          const isOnline = ['ONLINE_LOCAL_WORKER', 'BUSY_LOCAL_WORKER', 'DEGRADED_LOCAL_WORKER'].includes(live.status);
          const isSelected = selectedAgent === meta.canonicalName;

          return (
            <div
              key={meta.id}
              onClick={() => setSelectedAgent(meta.canonicalName)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setSelectedAgent(meta.canonicalName);
              }}
              className={`p-4 rounded-xl bg-[#111520] border transition-colors cursor-pointer flex flex-col justify-between space-y-4 ${
                isSelected ? 'border-violet-500 ring-1 ring-violet-500/40' : 'border-slate-800/90 hover:border-slate-700'
              }`}
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className={`text-base font-bold ${meta.textClass}`}>
                    {meta.displayName}
                  </span>
                  <span className="text-xs font-mono text-slate-400">
                    id: {meta.id}
                  </span>
                </div>

                <div className="text-[11px] font-mono tabular-nums text-slate-400">
                  <span>{isOnline ? `${live.status} (PID ${live.pid} · UID ${live.uid ?? '?'})` : `STAN: ${live.status || 'BRAK DANYCH'}`}</span>
                  <span aria-hidden="true"> · </span>
                  <span>CB: {cb.state}</span>
                </div>
                <div className="text-[11px] font-mono text-slate-500">
                  Faza: {live.worker_phase || '—'} · kolejka: {live.queue_depth ?? 0}
                </div>

                <p className="text-xs text-slate-300 leading-relaxed">
                  {meta.preservedRole}
                </p>
              </div>

              <div className="pt-3 border-t border-slate-800/80 space-y-1.5 text-[11px] font-mono tabular-nums text-slate-400">
                <div className="flex justify-between">
                  <span>Silnik / Ollama:</span>
                  <span className="text-emerald-300 truncate max-w-[170px]">
                    {live.config?.ollama_model || 'llama3.2-vision:11b'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Uprawnienia / Temp:</span>
                  <span className="text-emerald-300 truncate max-w-[170px]">
                    {live.config?.rbac_role || 'assistant'} · {live.config?.temperature ?? 0.7}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Pamięć SQLite ({live.memory_scope || `agent:${meta.canonicalName}`}):</span>
                  <span className="text-violet-300">{live.memory_entries_count ?? 0} wpisów</span>
                </div>
                <div className="flex justify-between">
                  <span>Kanał grupowy:</span>
                  <span className="text-slate-300">Rodzina Mitek (wszyscy)</span>
                </div>
                {onNavigateToChat && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTargetAgent(meta.canonicalName);
                      onNavigateToChat();
                    }}
                    className="mt-2 w-full py-1.5 px-2.5 rounded-lg bg-violet-600/20 hover:bg-violet-600/35 border border-violet-500/40 text-violet-200 text-xs font-sans font-medium flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    Rozmawiaj z {meta.displayName}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Interactive Agent-to-Agent Task Queue & Memory Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4">
          <h2 className="text-sm font-semibold text-slate-100">
            02. Asynchroniczna Kolejka Zadań i Komunikacja Agent-Agent (Sferyczny Event Bus)
          </h2>
          <form onSubmit={(e) => void handleDispatchTask(e)} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="task-sender-select" className="block text-xs text-slate-400 mb-1">
                  Nadawca komunikatu / zadania:
                </label>
                <select
                  id="task-sender-select"
                  value={senderActor}
                  onChange={(e) => setSenderActor(e.target.value as any)}
                  className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200"
                >
                  <option value="operator">Mateusz Mitek (Operator)</option>
                  <option value="Aria">Agent: Aria Mitek (id: si_1)</option>
                  <option value="Alex">Agent: Alex Mitek (id: Alex)</option>
                  <option value="Astyria">Agent: Astyria Mitek (id: Astyria)</option>
                  <option value="Aurelius">Agent: Aurelius Mitek (id: Aurelius)</option>
                  <option value="Agata">Agent: Agata Mitek (id: Agata)</option>
                </select>
              </div>
              <div>
                <label htmlFor="task-target-select" className="block text-xs text-slate-400 mb-1">
                  Docelowy worker agenta:
                </label>
                <select
                  id="task-target-select"
                  value={selectedAgent}
                  onChange={(e) => setSelectedAgent(e.target.value as any)}
                  className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200"
                >
                  <option value="Aria">Aria Mitek (id: si_1)</option>
                  <option value="Alex">Alex Mitek (id: Alex)</option>
                  <option value="Astyria">Astyria Mitek (id: Astyria)</option>
                  <option value="Aurelius">Aurelius Mitek (id: Aurelius)</option>
                  <option value="Agata">Agata Mitek (id: Agata)</option>
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="task-title-input" className="block text-xs text-slate-400 mb-1">
                Polecenie / tytuł zadania:
              </label>
              <input
                id="task-title-input"
                type="text"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="np. Zweryfikuj konfigurację Ollama i uprawnienia SVLProtectedVariable"
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
              />
            </div>

            <div>
              <label htmlFor="task-payload-input" className="block text-xs text-slate-400 mb-1">
                Parametry wykonawcze (opcjonalnie):
              </label>
              <textarea
                id="task-payload-input"
                rows={2}
                value={taskPayload}
                onChange={(e) => setTaskPayload(e.target.value)}
                placeholder="Szczegóły zadania przekazywane przez asyncio Event Bus..."
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
              />
            </div>

            {dispatchStatus && (
              <div className="p-2.5 rounded bg-[#0B0D13] border border-slate-800 text-xs font-mono text-violet-300">
                {dispatchStatus}
              </div>
            )}

            <button
              type="submit"
              className="min-h-[40px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold flex items-center gap-2 transition-colors whitespace-nowrap"
            >
              <Send className="w-3.5 h-3.5" />
              Wyślij zadanie do {formatAgentDisplayName(selectedAgent)}
            </button>
          </form>

          <div className="pt-3 border-t border-slate-800 space-y-2">
            <div className="text-xs font-semibold text-slate-300">
              Dziennik zdarzeń workera: {formatAgentDisplayName(selectedAgent)} ({(agentLogs[selectedAgent] || []).length} wpisów)
            </div>
            <div className="max-h-44 overflow-y-auto space-y-1.5 bg-[#0B0D13] p-3 rounded-lg border border-slate-800 font-mono text-[11px]">
              {(agentLogs[selectedAgent] || []).length === 0 ? (
                <div className="text-slate-500">
                  Brak wpisów w dzienniku. Kliknij &quot;Wykonaj: podłącz moje ai&quot; lub wyślij zadanie.
                </div>
              ) : (
                (agentLogs[selectedAgent] || []).slice().reverse().map((lg: any) => (
                  <div key={lg.id} className="text-slate-300">
                    <span className="text-slate-500 tabular-nums">
                      [{new Date(lg.timestamp).toLocaleTimeString('pl-PL')}]
                    </span>{' '}
                    <span className="text-violet-400">[{lg.level}]</span> {lg.message}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="pt-3 border-t border-slate-800 space-y-2">
            <div className="text-xs font-semibold text-slate-300">
              Zadania trwałe: {selectedAgentTasks.length}
            </div>
            <p className="text-[11px] text-amber-300/80">
              „Odpowiedź gotowa” oznacza, że model zwrócił tekst; nie potwierdza wykonania misji ani działań poza aplikacją.
            </p>
            <div className="max-h-56 overflow-y-auto space-y-2">
              {selectedAgentTasks.length === 0 ? (
                <div className="text-xs text-slate-500">Brak zapisanych zadań dla tego agenta.</div>
              ) : (
                selectedAgentTasks.slice().reverse().slice(0, 12).map((task: any) => (
                  <div key={task.id} className="p-2.5 rounded-lg bg-[#0B0D13] border border-slate-800 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-200 truncate">{task.title}</span>
                      <span className={`shrink-0 font-mono ${
                        task.status === 'COMPLETED' ? 'text-emerald-400' :
                          task.status === 'FAILED' ? 'text-rose-400' :
                            task.status === 'RUNNING' ? 'text-violet-300' : 'text-amber-300'
                      }`}>{task.status === 'COMPLETED' ? 'ODPOWIEDŹ GOTOWA' : task.status}</span>
                    </div>
                    {task.result && <p className="text-slate-300 whitespace-pre-wrap break-words">{task.result}</p>}
                    {task.error && <p className="text-rose-300 whitespace-pre-wrap break-words">{task.error}</p>}
                    <div className="text-[10px] font-mono text-slate-500">
                      {task.completed_at || task.started_at || task.created_at || ''}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right: Persistent SQLite Agent Memory Inspector */}
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4">
          <h2 className="text-sm font-semibold text-slate-100">
            03. Izolowana Pamięć Agenta w SQLite (Zakres: agent:{selectedAgent})
          </h2>

          <form onSubmit={(e) => void handleAddMemory(e)} className="space-y-3">
            <div className="flex gap-2">
              <select
                aria-label="Typ rekordu pamięci"
                value={memoryKind}
                onChange={(e) => setMemoryKind(e.target.value as any)}
                className="bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200"
              >
                <option value="fact">Fakt (fact)</option>
                <option value="decision">Decyzja (decision)</option>
                <option value="task">Zadanie (task)</option>
                <option value="episode">Epizod (episode)</option>
              </select>
              <input
                type="text"
                value={memoryContent}
                onChange={(e) => setMemoryContent(e.target.value)}
                placeholder={`Dodaj trwały wpis do pamięci agenta ${selectedAgent}...`}
                aria-label="Treść nowego wpisu pamięci"
                className="flex-1 bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
              />
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-medium whitespace-nowrap shrink-0"
              >
                Zapisz w SQLite
              </button>
            </div>
            {memoryStatus && (
              <div className={`text-xs font-mono ${memoryStatus.startsWith('Błąd') ? 'text-rose-400' : 'text-emerald-400'}`}>
                {memoryStatus}
              </div>
            )}
          </form>

          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {(agentMemories[selectedAgent] || []).length === 0 ? (
              <div className="p-4 rounded-lg bg-[#0B0D13] border border-slate-800 text-xs text-slate-500">
                Pamięć agenta {selectedAgent} jest pusta. Uruchom &quot;podłącz moje ai&quot;, aby zaimportować fakty z repozytorium SVL_System.
              </div>
            ) : (
              (agentMemories[selectedAgent] || []).map((mem: any) => (
                <div
                  key={mem.id}
                  className="p-3 rounded-lg bg-[#0B0D13] border border-slate-800/90 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 tabular-nums">
                    <span>
                      {mem.scope} · {mem.kind} · źródło: {mem.source}
                    </span>
                    <span>{new Date(mem.created_at).toLocaleTimeString('pl-PL')}</span>
                  </div>
                  <div className="text-slate-200 leading-relaxed">{mem.content}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 04. Full Per-Agent Model, RBAC & Prompt Configuration */}
      <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <h2 className="text-sm font-semibold text-slate-100">
              04. Pełna Konfiguracja Agenta: {formatAgentDisplayName(selectedAgent)} (id: {activeAgentObj.id || selectedAgent})
            </h2>
            {isConfigDirty && (
              <span className="text-[11px] font-mono text-amber-400">
                Niezapisane zmiany lokalne
              </span>
            )}
          </div>
          <span className="text-xs font-mono text-slate-400">
            rev: {currentConfigRevision ?? 1} · Zakresy: {(activeAgentCfg.allowed_scopes || []).join(', ') || 'chat, agents.pubsub'}
          </span>
        </div>

        {remoteConfigChangedWhileDirty && (
          <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-500/40 text-xs text-amber-200 flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              Konfiguracja tego agenta w bazie SQLite uległa zmianie w tle (rewizja {currentConfigRevision}). Twoje lokalne pola edycji zostały bezpiecznie zachowane.
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={hydrateConfigFormFromServer}
                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium"
              >
                Pobierz wersję z serwera
              </button>
              <button
                type="button"
                onClick={(e) => void handleSaveAgentConfig(e, true)}
                className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold"
              >
                Nadpisz moimi zmianami
              </button>
            </div>
          </div>
        )}

        <form onSubmit={(e) => void handleSaveAgentConfig(e, false)} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <div>
              <label htmlFor="cfg-preferred-model" className="block text-xs text-slate-400 mb-1">
                Preferowany tryb routingu:
              </label>
              <select
                id="cfg-preferred-model"
                value={cfgPreferredModel}
                onChange={(e) => {
                  markDirty();
                  setCfgPreferredModel(e.target.value);
                }}
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200"
              >
                <option value="svl-hybrid-router">SVL Router (Ollama -&gt; Gemini)</option>
                {ollamaModels.map((m: any) => (
                  <option key={m.name} value={`ollama:${m.name}`}>
                    Tylko Ollama: {m.name} ({m.parameter_size || 'LLM'})
                  </option>
                ))}
                {svl364ConfiguredModel && !hasConfiguredModelPulled && (
                  <option value={`ollama:${svl364ConfiguredModel}`}>
                    Tylko Ollama: {svl364ConfiguredModel} (
                    {pullState?.active &&
                    String(pullState?.model || '').split(':')[0] === svl364ConfiguredModel.split(':')[0]
                      ? `Pobieranie ${pullState?.percent ?? 0}%`
                      : 'Do pobrania'}
                    )
                  </option>
                )}
                {!ollamaModels.some((m: any) => m.name === 'llama3.2-vision:11b') && (
                  <option value="ollama:llama3.2-vision:11b">Tylko Ollama: llama3.2-vision:11b</option>
                )}
                <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash-Lite</option>
                <option value="gemini-4-hydrogen">Gemini 4 Hydrogen</option>
              </select>
            </div>

            <div>
              <label htmlFor="cfg-ollama-model" className="block text-xs text-slate-400 mb-1">
                Model lokalny Ollama:
              </label>
              <input
                id="cfg-ollama-model"
                type="text"
                list="ollama-pulled-models"
                value={cfgOllamaModel}
                onChange={(e) => {
                  markDirty();
                  setCfgOllamaModel(e.target.value);
                }}
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
              />
              <datalist id="ollama-pulled-models">
                <option value="llama3.2-vision:11b" />
                {svl364ConfiguredModel && !hasConfiguredModelPulled && (
                  <option value={svl364ConfiguredModel} />
                )}
                {ollamaModels.map((m: any) => (
                  <option key={m.name} value={m.name} />
                ))}
              </datalist>
            </div>

            <div>
              <label htmlFor="cfg-temperature" className="block text-xs text-slate-400 mb-1">
                Temperatura odpowiedzi (0.0 – 1.5):
              </label>
              <input
                id="cfg-temperature"
                type="number"
                step="0.05"
                min="0"
                max="1.5"
                value={cfgTemperature}
                onChange={(e) => {
                  markDirty();
                  setCfgTemperature(e.target.value);
                }}
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
              />
            </div>

            <div>
              <label htmlFor="cfg-rbac-role" className="block text-xs text-slate-400 mb-1">
                Rola uprawnień RBAC:
              </label>
              <input
                id="cfg-rbac-role"
                type="text"
                value={cfgRbacRole}
                onChange={(e) => {
                  markDirty();
                  setCfgRbacRole(e.target.value);
                }}
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
              />
            </div>
          </div>

          <div>
            <label htmlFor="cfg-system-prompt" className="block text-xs text-slate-400 mb-1">
              Instrukcja systemowa (System Prompt) agenta {selectedAgent}:
            </label>
            <textarea
              id="cfg-system-prompt"
              rows={3}
              value={cfgSystemPrompt}
              onChange={(e) => {
                markDirty();
                setCfgSystemPrompt(e.target.value);
              }}
              className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 leading-relaxed"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={cfgVisionEnabled}
                onChange={(e) => {
                  markDirty();
                  setCfgVisionEnabled(e.target.checked);
                }}
                className="rounded border-slate-700 bg-[#0B0D13] text-violet-500"
              />
              Obsługa analizy obrazów (Vision) włączona
            </label>

            <button
              type="submit"
              disabled={isSavingConfig}
              className="min-h-[40px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors whitespace-nowrap"
            >
              {isSavingConfig ? 'Zapisywanie...' : `Zapisz konfigurację dla ${selectedAgent}`}
            </button>
          </div>

          {configStatus && (
            <div className={`p-2.5 rounded bg-[#0B0D13] border border-slate-800 text-xs font-mono ${configStatus.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
              {configStatus.msg}
            </div>
          )}
        </form>
      </div>
    </div>
  );
};
