import React, { useState, useEffect } from 'react';
import {
  Cpu,
  Activity,
  Database,
  Send,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Terminal,
  GitBranch,
  Layers,
  MessageSquare,
  Sliders,
} from 'lucide-react';
import { CANONICAL_AGENTS } from '../utils/svlLogic';

interface AgentsPanelProps {
  agentsData: any;
  healthData?: any;
  onConnectMyAi: () => Promise<any>;
  isConnecting: boolean;
  onRefresh: () => Promise<void>;
  onChatWithAgent?: (agent: 'Aria' | 'Alex' | 'Astyria' | 'Aurelius') => void;
}

export const AgentsPanel: React.FC<AgentsPanelProps> = ({
  agentsData,
  healthData,
  onConnectMyAi,
  isConnecting,
  onRefresh,
  onChatWithAgent,
}) => {
  const [selectedAgent, setSelectedAgent] = useState<'Aria' | 'Alex' | 'Astyria' | 'Aurelius'>('Alex');
  const [senderActor, setSenderActor] = useState<'operator' | 'Aria' | 'Alex' | 'Astyria' | 'Aurelius'>('operator');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskPayload, setTaskPayload] = useState('');
  const [memoryContent, setMemoryContent] = useState('');
  const [memoryKind, setMemoryKind] = useState<'fact' | 'decision' | 'task' | 'episode'>('fact');
  const [dispatchStatus, setDispatchStatus] = useState<string | null>(null);
  const [memoryStatus, setMemoryStatus] = useState<string | null>(null);
  const [configStatus, setConfigStatus] = useState<string | null>(null);
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  const agentsList: any[] = agentsData?.agents || [];
  const agentLogs: Record<string, any[]> = agentsData?.agent_logs || {};
  const agentMemories: Record<string, any[]> = agentsData?.agent_memories || {};
  const sphericalBus = agentsData?.spherical_bus || {};
  const lastReport = agentsData?.last_sync_report;
  const ollamaModels: any[] = healthData?.ollama?.models || [];

  const activeAgentObj = agentsList.find((a) => a.canonical_name === selectedAgent) || {};
  const activeAgentCfg = activeAgentObj.config || {};

  const [cfgPreferredModel, setCfgPreferredModel] = useState('svl-hybrid-router');
  const [cfgOllamaModel, setCfgOllamaModel] = useState('llama3.2-vision:11b');
  const [cfgFallbackModel, setCfgFallbackModel] = useState('gemini-3.1-flash-lite');
  const [cfgTemperature, setCfgTemperature] = useState('0.7');
  const [cfgRbacRole, setCfgRbacRole] = useState('');
  const [cfgVisionEnabled, setCfgVisionEnabled] = useState(true);
  const [cfgSystemPrompt, setCfgSystemPrompt] = useState('');

  useEffect(() => {
    setCfgPreferredModel(activeAgentCfg.preferred_model || 'svl-hybrid-router');
    setCfgOllamaModel(activeAgentCfg.ollama_model || 'llama3.2-vision:11b');
    setCfgFallbackModel(activeAgentCfg.fallback_model || 'gemini-3.1-flash-lite');
    setCfgTemperature(String(activeAgentCfg.temperature ?? 0.7));
    setCfgRbacRole(activeAgentCfg.rbac_role || '');
    setCfgVisionEnabled(activeAgentCfg.vision_enabled !== false);
    setCfgSystemPrompt(activeAgentCfg.system_prompt || '');
  }, [selectedAgent, activeAgentObj.canonical_name, activeAgentCfg.preferred_model, activeAgentCfg.ollama_model, activeAgentCfg.fallback_model, activeAgentCfg.temperature, activeAgentCfg.rbac_role, activeAgentCfg.vision_enabled, activeAgentCfg.system_prompt]);

  const handleDispatchTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskTitle.trim()) {
      setDispatchStatus('Błąd: Tytuł zadania nie może być pusty.');
      return;
    }
    setDispatchStatus('Wysyłanie zadania przez Sferyczną Magistralę Zdarzeń...');
    try {
      const resp = await fetch('/api/py/agents/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: senderActor,
          target_agent: selectedAgent,
          title: taskTitle.trim(),
          payload: taskPayload.trim() || taskTitle.trim(),
        }),
      });
      const data = await resp.json();
      if (data.ok) {
        setDispatchStatus(`Zadanie wykonane przez ${selectedAgent}: ${data.task?.result}`);
        setTaskTitle('');
        setTaskPayload('');
        await onRefresh();
      } else {
        setDispatchStatus(`Błąd: ${data.error || 'Nie udało się wykonać zadania'}`);
      }
    } catch (err: any) {
      setDispatchStatus(`Błąd sieci: ${err?.message || String(err)}`);
    }
  };

  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!memoryContent.trim()) {
      setMemoryStatus('Błąd: Wpis pamięci nie może być pusty.');
      return;
    }
    try {
      const resp = await fetch('/api/py/agents/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: selectedAgent,
          kind: memoryKind,
          content: memoryContent.trim(),
        }),
      });
      const data = await resp.json();
      if (data.ok) {
        setMemoryStatus(`Zapisano w trwałej pamięci SQLite (zakres: agent:${selectedAgent}).`);
        setMemoryContent('');
        await onRefresh();
      } else {
        setMemoryStatus(`Błąd: ${data.error}`);
      }
    } catch (err: any) {
      setMemoryStatus(`Błąd: ${err?.message}`);
    }
  };

  const handleSaveAgentConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingConfig(true);
    setConfigStatus(null);
    try {
      const resp = await fetch('/api/py/agents/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: selectedAgent,
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
      const data = await resp.json();
      if (data.ok) {
        setConfigStatus(`Zapisano pełną konfigurację dla ${selectedAgent} w SQLite.`);
        await onRefresh();
      } else {
        setConfigStatus(`Błąd zapisu: ${data.error}`);
      }
    } catch (err: any) {
      setConfigStatus(`Błąd sieci: ${err?.message || String(err)}`);
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleConfigureAllAgents = async () => {
    setIsSavingConfig(true);
    setConfigStatus(null);
    try {
      const resp = await fetch('/api/py/agents/configure-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            preferred_model: 'svl-hybrid-router',
            ollama_model: 'llama3.2-vision:11b',
            fallback_model: 'gemini-3.1-flash-lite',
            vision_enabled: true,
            auto_connect_on_boot: true,
          },
        }),
      });
      const data = await resp.json();
      await onRefresh();
      if (data.ok) {
        setConfigStatus('Skonfigurowano i podłączono wszystkich 4 agentów (Ollama llama3.2-vision:11b + Gemini 3.1 + Magistrala Sferyczna).');
      } else {
        setConfigStatus(`Błąd: ${data.error}`);
      }
    } catch (err: any) {
      setConfigStatus(`Błąd sieci: ${err?.message || String(err)}`);
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
            01. Panel Czterech Agentów AI (Aria, Alex, Astyria, Aurelius)
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Zachowane oryginalne identyfikatory z <code className="text-violet-300">mmitek515-netizen/SVL_System</code>, osobne procesy Python (PID/UID), izolowana pamięć SQLite, konfiguracja Ollama 11B Vision i komunikacja na Sferycznej Magistrali Zdarzeń.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onRefresh}
            className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#111520] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-2 transition-colors whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Odśwież telemetrię
          </button>
          <button
            type="button"
            onClick={handleConfigureAllAgents}
            disabled={isSavingConfig}
            className="min-h-[40px] px-3.5 py-2 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 disabled:opacity-50 text-xs font-semibold text-white flex items-center gap-2 transition-colors whitespace-nowrap"
          >
            <Sliders className="w-3.5 h-3.5" />
            Skonfiguruj wszystkim 11B Vision
          </button>
          <button
            type="button"
            onClick={onConnectMyAi}
            disabled={isConnecting}
            className="min-h-[40px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-xs font-semibold text-white flex items-center gap-2 transition-colors whitespace-nowrap"
          >
            <GitBranch className="w-4 h-4" />
            {isConnecting ? 'Łączenie z SVL_System...' : 'Wykonaj: podłącz moje ai'}
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

      {/* 4 Agents Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {CANONICAL_AGENTS.map((meta) => {
          const live = agentsList.find((a) => a.canonical_name === meta.canonicalName) || {};
          const cb = sphericalBus.circuit_breakers?.[meta.canonicalName] || { state: 'CLOSED', failure_count: 0 };
          const isOnline = live.status === 'ONLINE_LOCAL_WORKER';
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
                    {meta.canonicalName}
                  </span>
                  <span className="text-xs font-mono text-slate-400">
                    id: {meta.id}
                  </span>
                </div>

                {/* Unboxed clean metadata */}
                <div className="text-[11px] font-mono tabular-nums text-slate-400">
                  <span>{isOnline ? `ONLINE (PID ${live.pid} · UID ${live.uid})` : 'STAN: DEFINICJA KODU'}</span>
                  <span aria-hidden="true"> · </span>
                  <span>CB: {cb.state}</span>
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
                  <span>RBAC / Temp:</span>
                  <span className="text-slate-200 truncate max-w-[170px]">
                    {live.config?.rbac_role || 'worker'} · {live.config?.temperature ?? 0.7}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Pamięć SQLite ({live.memory_scope || `agent:${meta.canonicalName}`}):</span>
                  <span className="text-violet-300">{live.memory_entries_count ?? 0} wpisów</span>
                </div>
                <div className="flex justify-between">
                  <span>Heartbeat:</span>
                  <span className="text-slate-300">
                    {live.heartbeat_at ? new Date(live.heartbeat_at).toLocaleTimeString('pl-PL') : 'Brak (nieuruchomiony)'}
                  </span>
                </div>
                {onChatWithAgent && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onChatWithAgent(meta.canonicalName as any);
                    }}
                    className="mt-2 w-full py-1.5 px-2.5 rounded-lg bg-violet-600/20 hover:bg-violet-600/35 border border-violet-500/40 text-violet-200 text-xs font-sans font-medium flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    Rozmawiaj z {meta.canonicalName}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Interactive Agent-to-Agent Task Queue & Memory Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Async Task Dispatcher (Operator -> Agent or Agent -> Agent) */}
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4">
          <h2 className="text-sm font-semibold text-slate-100">
            02. Asynchroniczna Kolejka Zadań i Komunikacja Agent-Agent (Sferyczny Event Bus)
          </h2>
          <form onSubmit={handleDispatchTask} className="space-y-3">
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
                  <option value="Aria">Agent: Aria (id: si_1)</option>
                  <option value="Alex">Agent: Alex (id: Alex)</option>
                  <option value="Astyria">Agent: Astyria (id: Astyria)</option>
                  <option value="Aurelius">Agent: Aurelius (id: Aurelius)</option>
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
                  <option value="Aria">Aria (id: si_1)</option>
                  <option value="Alex">Alex (id: Alex)</option>
                  <option value="Astyria">Astyria (id: Astyria)</option>
                  <option value="Aurelius">Aurelius (id: Aurelius)</option>
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
              Wyślij zadanie do {selectedAgent}
            </button>
          </form>

          {/* Selected Agent Live Logs */}
          <div className="pt-3 border-t border-slate-800 space-y-2">
            <div className="text-xs font-semibold text-slate-300">
              Dziennik zdarzeń workera: {selectedAgent} ({(agentLogs[selectedAgent] || []).length} wpisów)
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
        </div>

        {/* Right: Persistent SQLite Agent Memory Inspector */}
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4">
          <h2 className="text-sm font-semibold text-slate-100">
            03. Izolowana Pamięć Agenta w SQLite (Zakres: agent:{selectedAgent})
          </h2>

          <form onSubmit={handleAddMemory} className="space-y-3">
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
              <div className="text-xs font-mono text-emerald-400">{memoryStatus}</div>
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
          <h2 className="text-sm font-semibold text-slate-100">
            04. Pełna Konfiguracja Agenta: {selectedAgent} (id: {activeAgentObj.id || selectedAgent})
          </h2>
          <span className="text-xs font-mono text-slate-400">
            Zakresy: {(activeAgentCfg.allowed_scopes || []).join(', ') || 'chat, agents.pubsub'}
          </span>
        </div>

        <form onSubmit={handleSaveAgentConfig} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <div>
              <label htmlFor="cfg-preferred-model" className="block text-xs text-slate-400 mb-1">
                Preferowany tryb routingu:
              </label>
              <select
                id="cfg-preferred-model"
                value={cfgPreferredModel}
                onChange={(e) => setCfgPreferredModel(e.target.value)}
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200"
              >
                <option value="svl-hybrid-router">SVL Router (Ollama -&gt; Gemini)</option>
                <option value="ollama:llama3.2-vision:11b">Tylko Ollama: llama3.2-vision:11b</option>
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
                onChange={(e) => setCfgOllamaModel(e.target.value)}
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
              />
              <datalist id="ollama-pulled-models">
                <option value="llama3.2-vision:11b" />
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
                onChange={(e) => setCfgTemperature(e.target.value)}
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
                onChange={(e) => setCfgRbacRole(e.target.value)}
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
              onChange={(e) => setCfgSystemPrompt(e.target.value)}
              className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 leading-relaxed"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={cfgVisionEnabled}
                onChange={(e) => setCfgVisionEnabled(e.target.checked)}
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
            <div className="p-2.5 rounded bg-[#0B0D13] border border-slate-800 text-xs font-mono text-emerald-400">
              {configStatus}
            </div>
          )}
        </form>
      </div>
    </div>
  );
};
