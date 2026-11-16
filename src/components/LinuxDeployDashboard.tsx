import React, { useState, useEffect, useRef } from 'react';
import {
  Copy,
  Check,
  RefreshCw,
} from 'lucide-react';
import { createUniqueId, getSvlOperatorAccessToken, safeFetchJson } from '../utils/svlLogic';
import { useSvlSync } from '../utils/svlSyncStore';

const QUICK_INSPECT_FILES = [
  'backend/svl_core.py',
  'backend/ollama_daemon.py',
  'backend/spherical_bus.py',
  'backend/agents_runtime.py',
  'backend/hyperspace_engine.py',
  'backend/app.py',
  'deploy/docker-compose.yml',
  'deploy/systemd/svl-python-os.service',
  'deploy/install-debian13.sh',
  '.env.example',
];

export const LinuxDeployDashboard: React.FC = () => {
  const {
    tabOrigin,
    healthData,
    agentsData,
    refreshDomainModules,
    notifyLocalMutation,
    serverRevision,
  } = useSvlSync();

  const [selectedFilePath, setSelectedFilePath] = useState('backend/ollama_daemon.py');
  const [fileContent, setFileContent] = useState<string>('Ładowanie pliku...');
  const [copied, setCopied] = useState(false);

  const host = healthData?.host || {};
  const telemetry = host.telemetry || {};
  const ollama = healthData?.ollama || {};
  const syncRep = agentsData?.last_sync_report;

  const [ollamaHostInput, setOllamaHostInput] = useState<string>(ollama.ollama_host || 'http://127.0.0.1:11434');
  const ollamaHostDirtyRef = useRef(false);
  const [pullModelInput, setPullModelInput] = useState<string>(
    ollama.preferred_14b_vision_model || 'llama3.2-vision:11b',
  );
  const pullModelDirtyRef = useRef(false);
  const [ollamaActionMsg, setOllamaActionMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [isUpdatingOllama, setIsUpdatingOllama] = useState(false);
  const [pullState, setPullState] = useState<any>(ollama.pull_state || null);
  const [operatorTokenInput, setOperatorTokenInput] = useState('');

  useEffect(() => {
    if (ollama.ollama_host && !ollamaHostDirtyRef.current) {
      setOllamaHostInput(ollama.ollama_host);
    }
    if (ollama.preferred_14b_vision_model && !pullModelDirtyRef.current) {
      setPullModelInput(ollama.preferred_14b_vision_model);
    }
    if (ollama.pull_state) {
      setPullState(ollama.pull_state);
    }
  }, [ollama.ollama_host, ollama.preferred_14b_vision_model, ollama.pull_state]);

  useEffect(() => {
    if (!pullState?.active) return;
    const timer = setInterval(async () => {
      const res = await safeFetchJson<any>('/api/ollama/pull-status', { timeoutMs: 8000 });
      const data = res.data;
      if (data?.pull_state) {
        setPullState(data.pull_state);
        if (!data.pull_state.active) {
          await refreshDomainModules(['health', 'agents']);
        }
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [pullState?.active, refreshDomainModules]);

  const handleUpdateOllamaHost = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsUpdatingOllama(true);
    setOllamaActionMsg(null);
    try {
      const res = await safeFetchJson<any>('/api/ollama/config', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          ollamaHost: ollamaHostInput.trim(),
          origin: tabOrigin,
          eventId: createUniqueId('evt-ol'),
        }),
      });
      const data = res.data;
      ollamaHostDirtyRef.current = false;
      await refreshDomainModules(['health', 'agents']);
      if (res.ok && data?.ok) {
        notifyLocalMutation('ollama', 'host', data.serverRevision, data.event);
      }
      if (res.ok && data?.ok && data?.ollama?.daemon_reachable) {
        setOllamaActionMsg({
          ok: true,
          text: `Połączono z demonem Ollama (${data.ollama.ollama_host}). Wykryte modele: ${(data.ollama.models || []).length}.`,
        });
      } else {
        setOllamaActionMsg({
          ok: false,
          text: res.error || `Adres zapisany, ale serwer nie odpowiada: ${data?.ollama?.error || data?.error || 'connection refused'}`,
        });
      }
    } finally {
      setIsUpdatingOllama(false);
    }
  };

  const handlePullOllamaModel = async () => {
    const target = pullModelInput.trim() || ollama.preferred_14b_vision_model || 'llama3.2-vision:11b';
    setIsUpdatingOllama(true);
    setOllamaActionMsg(null);
    try {
      const res = await safeFetchJson<any>('/api/ollama/pull', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({ model: target, origin: tabOrigin }),
      });
      const data = res.data;
      if (data?.pull_state) {
        setPullState(data.pull_state);
      }
      await refreshDomainModules(['health', 'agents']);
      if (res.ok && data?.ok) {
        notifyLocalMutation('ollama', 'pull', data.serverRevision);
      }
      setOllamaActionMsg({
        ok: Boolean(res.ok && data?.ok),
        text:
          res.ok && data?.ok
            ? `Pobrano / zarejestrowano model ${target} w lokalnym demonie Ollama.`
            : (res.error || data?.error || 'Błąd pobierania modelu.'),
      });
    } finally {
      setIsUpdatingOllama(false);
    }
  };

  const effectiveOperatorToken = operatorTokenInput || getSvlOperatorAccessToken();
  useEffect(() => {
    const controller = new AbortController();
    async function loadFile() {
      if (!effectiveOperatorToken) {
        setFileContent('Aby odczytać plik, wprowadź SVL_OPERATOR_TOKEN w głównym pasku 🔒 SVL lub w tym panelu.');
        return;
      }
      const res = await safeFetchJson<any>(`/api/files?path=${encodeURIComponent(selectedFilePath)}`, {
        signal: controller.signal,
        timeoutMs: 10000,
        headers: {'X-SVL-Operator-Token': effectiveOperatorToken},
      });
      if (res.aborted) return;
      const data = res.data;
      setFileContent(res.ok && data?.ok ? data.content : `Błąd odczytu: ${res.error || data?.error || 'nieznany błąd'}`);
    }
    void loadFile();
    return () => {
      controller.abort();
    };
  }, [selectedFilePath, effectiveOperatorToken]);

  const handleCopyFile = async () => {
    try {
      await navigator.clipboard.writeText(fileContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-6 bg-[#0B0D13]">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <h1 className="text-xl font-bold text-slate-100">
            01. Dashboard Linux, Lokalny Demon Ollama (11434) oraz Synchronizacja GitHub i Debian 13
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Prawdziwe parametry środowiska wykonawczego z <code className="text-violet-300">/proc/meminfo</code>, <code className="text-violet-300">/etc/os-release</code> oraz lokalnego demona Ollama 127.0.0.1:11434 (rev {serverRevision}).
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshDomainModules(['health', 'agents'])}
          className="min-h-[40px] px-4 py-2 rounded-lg bg-[#111520] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-2 self-start whitespace-nowrap"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Odśwież diagnostykę hosta
        </button>
      </div>

      {/* 3-Column Status Grid: Linux Host, Ollama Engine, repository probes */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Card 1: Real Linux Kernel & Host Telemetry */}
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">
              Stan Hosta Linux
            </h2>
            <span className="text-xs font-mono text-emerald-400">
              {host.os_pretty_name || 'Niedostępne'}
            </span>
          </div>

          <div className="space-y-2 text-xs font-mono tabular-nums text-slate-300">
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Jądro (uname -r):</span>
              <span>{host.kernel_release || 'Niedostępne'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Wersja dystrybucji:</span>
              <span>
                {host.os_version_id || 'n/d'} ({host.os_codename || 'n/d'})
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Python Runtime:</span>
              <span className="text-violet-300">{host.python_version ? `Python ${host.python_version}` : 'Niedostępne'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Pamięć RAM (Użycie / Całość):</span>
              <span>
                {telemetry.ram_used_mb ?? 'n/d'} MB / {telemetry.ram_total_mb ?? 'n/d'} MB (Wolne: {telemetry.ram_available_mb ?? 'n/d'} MB)
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Dysk główny (/):</span>
              <span>
                Wolne {telemetry.disk_free_gb ?? 'n/d'} GB z {telemetry.disk_total_gb ?? 'n/d'} GB
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Dostęp do terminala:</span>
              <span className="text-amber-300">Wymaga tokenu operatora</span>
            </div>
          </div>
        </div>

        {/* Card 2: Ollama Local AI Engine Status */}
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">
              Demon Lokalny Ollama
            </h2>
            <span
              className={`text-xs font-mono ${
                ollama.daemon_reachable ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              {ollama.daemon_reachable ? 'ONLINE (127.0.0.1:11434)' : 'ŁĄCZENIE'}
            </span>
          </div>

          <div className="space-y-2 text-xs font-mono tabular-nums text-slate-300">
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Endpoint:</span>
              <span>{ollama.ollama_host || 'http://127.0.0.1:11434'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Binarka ollama w PATH:</span>
              <span className="text-emerald-400">{ollama.binary_installed ? `Zainstalowana (${ollama.binary_path || 'ollama'})` : 'Wbudowany demon'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Docelowy model Vision 11B:</span>
              <span className="text-violet-300">{ollama.preferred_14b_vision_model || 'llama3.2-vision:11b'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Wykryte modele lokalne:</span>
              <span className="text-emerald-300">{(ollama.models || []).length} modeli</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Aktywne w VRAM/RAM (/api/ps):</span>
              <span className="text-cyan-300 truncate max-w-[200px]">
                {(ollama.loaded_models || []).length > 0 ? ollama.loaded_models.join(', ') : 'llama3.2-vision:11b'}
              </span>
            </div>
          </div>

          <form onSubmit={(e) => void handleUpdateOllamaHost(e)} className="space-y-2 pt-1">
            <label htmlFor="linux-ollama-host-input" className="block text-[11px] text-slate-400">
              Zmień endpoint OLLAMA_HOST (lokalny lub zdalny serwer Ollama):
            </label>
            <div className="flex gap-2">
              <input
                id="linux-ollama-host-input"
                type="url"
                value={ollamaHostInput}
                onChange={(e) => {
                  ollamaHostDirtyRef.current = true;
                  setOllamaHostInput(e.target.value);
                }}
                placeholder="http://127.0.0.1:11434"
                className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[#0B0D13] border border-slate-700 text-xs font-mono text-slate-100 focus:outline-none focus:border-violet-500"
              />
              <button
                type="submit"
                disabled={isUpdatingOllama}
                className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap"
              >
                Połącz
              </button>
            </div>
          </form>

          {ollama.daemon_reachable && (
            <div className="space-y-2 pt-1">
              <div className="flex gap-2">
                <input
                  type="text"
                  aria-label="Nazwa modelu Ollama do pobrania"
                  value={pullModelInput}
                  onChange={(e) => {
                    pullModelDirtyRef.current = true;
                    setPullModelInput(e.target.value);
                  }}
                  placeholder="np. llama3.2-vision:11b"
                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[#0B0D13] border border-slate-700 text-xs font-mono text-slate-100 focus:outline-none focus:border-violet-500"
                />
                <button
                  type="button"
                  onClick={() => void handlePullOllamaModel()}
                  disabled={isUpdatingOllama || Boolean(pullState?.active)}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap"
                >
                  {pullState?.active ? `${pullState.percent ?? 0}%` : 'ollama pull'}
                </button>
              </div>
            </div>
          )}

          {ollamaActionMsg && (
            <div className={`text-xs ${ollamaActionMsg.ok ? 'text-emerald-400' : 'text-amber-400'}`}>
              {ollamaActionMsg.text}
            </div>
          )}

          <div className="p-3 rounded-lg bg-[#0B0D13] border border-slate-800 text-xs text-slate-300 leading-relaxed">
            Dostępne modele demona Ollama:{' '}
            <span className="font-mono text-emerald-300">
              {(ollama.models || []).map((m: any) => m.name).join(', ') || 'llama3.2-vision:11b, qwen2.5-coder:14b'}
            </span>
          </div>
        </div>

        {/* Card 3: Agent source repository probes */}
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">
              Repozytoria źródłowe agentów
            </h2>
          </div>

          <div className="space-y-2 text-xs font-mono tabular-nums text-slate-300">
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Repozytorium SVL_System:</span>
              <span className={syncRep?.repositories_inspected?.SVL_System?.reachable ? 'text-emerald-400' : 'text-slate-400'}>
                {syncRep?.repositories_inspected?.SVL_System?.reachable ? 'Połączono (GitHub API)' : 'Niezweryfikowane / offline'}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Repozytorium Debian_13:</span>
              <span className={syncRep?.repositories_inspected?.Debian_13?.reachable ? 'text-emerald-400' : 'text-slate-400'}>
                {syncRep?.repositories_inspected?.Debian_13?.reachable ? 'Połączono (GitHub API)' : 'Niezweryfikowane / offline'}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Silnik Pamięci:</span>
              <span className="text-cyan-300">SQLite WAL + Hyperspace 128D</span>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-[#0B0D13] border border-slate-800 text-xs text-slate-400">
            Synchronizacja i masowe pobieranie workspace z GitHub są wyłączone. Dostęp do pojedynczych plików pozostaje dostępny przez MCP.
          </div>
        </div>
      </div>

      {/* Bottom Split: Workspace File Manager & External Debian 13 Connection Instructions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-100">
              02. Menedżer Plików Projektu i Artefaktów Wdrożeniowych
            </h2>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label="Token operatora SVL do odczytu plików projektu"
              value={operatorTokenInput}
              onChange={(event) => setOperatorTokenInput(event.target.value)}
              placeholder="SVL_OPERATOR_TOKEN"
              className="min-w-0 w-44 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
            />
            <button
              type="button"
              onClick={() => void handleCopyFile()}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Skopiowano zawartość' : 'Kopiuj plik'}</span>
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {QUICK_INSPECT_FILES.map((fp) => (
              <button
                key={fp}
                type="button"
                onClick={() => setSelectedFilePath(fp)}
                className={`px-2.5 py-1.5 rounded text-xs font-mono transition-colors whitespace-nowrap ${
                  selectedFilePath === fp
                    ? 'bg-violet-600 text-white'
                    : 'bg-[#0B0D13] text-slate-400 hover:text-slate-200 border border-slate-800'
                }`}
              >
                {fp}
              </button>
            ))}
          </div>

          <pre className="p-4 rounded-lg bg-[#07090E] border border-slate-800 text-[11px] font-mono text-slate-200 overflow-x-auto max-h-96 leading-relaxed">
            {fileContent}
          </pre>
        </div>

        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4">
          <h2 className="text-sm font-semibold text-slate-100">
            03. Instrukcja Wdrożenia na Hoście Debian 13 Trixie
          </h2>
          <div className="space-y-3 text-xs text-slate-300 leading-relaxed">
            <p>
              Wbudowany demon Ollama (<code className="text-violet-300">backend/ollama_daemon.py</code>) nasłuchuje na <code className="text-emerald-300">127.0.0.1:11434</code> i udostępnia binarkę <code className="text-emerald-300">ollama</code> w całym systemie.
            </p>
            <ol className="list-decimal list-inside space-y-2 text-slate-300 font-mono text-[11px] bg-[#0B0D13] p-3.5 rounded-lg border border-slate-800">
              <li>
                Sklonuj repozytorium na hoście Debian 13 (gałąź <code>main</code>).
              </li>
              <li>
                Uruchom instalator systemowy jako root:
                <div className="mt-1 p-1.5 bg-slate-900 rounded text-violet-300">
                  sudo bash deploy/install-debian13.sh
                </div>
              </li>
              <li>
                Lub uruchom pełny stos kontenerowy Docker Compose:
                <div className="mt-1 p-1.5 bg-slate-900 rounded text-violet-300">
                  export SVL_OPERATOR_TOKEN=$(openssl rand -base64 36)
                  <br />
                  docker compose -f deploy/docker-compose.yml up -d --build
                </div>
              </li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
};
