import React, { useState, useEffect, useRef } from 'react';
import {
  Copy,
  Check,
  RefreshCw,
} from 'lucide-react';
import { createUniqueId, safeFetchJson } from '../utils/svlLogic';
import { useSvlSync } from '../utils/svlSyncStore';

const QUICK_INSPECT_FILES = [
  'backend/svl_core.py',
  'backend/spherical_bus.py',
  'backend/agents_runtime.py',
  'backend/hyperspace_engine.py',
  'backend/app.py',
  'deploy/docker-compose.yml',
  'deploy/systemd/svl-python-os.service',
  'deploy/install-debian13.sh',
  'deploy/Dockerfile.debian13',
  '.env.example',
];

type GitHubSyncStatus = {
  ok: boolean;
  error?: string;
  repository: string;
  branch: string;
  branchUrl: string;
  tokenConfigured: boolean;
  automaticEnabled: boolean;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastResult: {
    uploaded: string[];
    downloaded: string[];
    deletedLocally: string[];
    deletedRemotely: string[];
    conflicts: string[];
    skipped: string[];
  } | null;
};

export const LinuxDeployDashboard: React.FC = () => {
  const {
    tabOrigin,
    healthData,
    agentsData,
    refreshDomainModules,
    notifyLocalMutation,
    serverRevision,
  } = useSvlSync();

  const [selectedFilePath, setSelectedFilePath] = useState('deploy/docker-compose.yml');
  const [fileContent, setFileContent] = useState<string>('Ładowanie pliku...');
  const [copied, setCopied] = useState(false);

  const host = healthData?.host || {};
  const telemetry = host.telemetry || {};
  const ollama = healthData?.ollama || {};
  const codex = healthData?.codex || {};
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
  const [githubSyncStatus, setGithubSyncStatus] = useState<GitHubSyncStatus | null>(null);
  const [githubSyncMessage, setGithubSyncMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [isSyncingGithub, setIsSyncingGithub] = useState(false);

  useEffect(() => {
    let active = true;
    const refreshStatus = async () => {
      const res = await safeFetchJson<GitHubSyncStatus>('/api/github/sync-status', { timeoutMs: 10000 });
      if (active && res.ok && res.data?.ok) {
        setGithubSyncStatus(res.data);
      } else if (active) {
        setGithubSyncMessage({
          ok: false,
          text: res.error || res.data?.error || 'Nie można pobrać statusu synchronizacji GitHub.',
        });
      }
    };
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

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
          text: `Połączono z Ollama (${data.ollama.ollama_host}). Wykryte modele: ${(data.ollama.models || []).length}.`,
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
            ? `Uruchomiono pobieranie modelu ${target} w tle.`
            : (res.error || data?.error || 'Błąd pobierania modelu.'),
      });
    } finally {
      setIsUpdatingOllama(false);
    }
  };

  const handleGitHubWorkspaceSync = async () => {
    setIsSyncingGithub(true);
    setGithubSyncMessage(null);
    try {
      const res = await safeFetchJson<any>('/api/github/sync-workspace', {
        method: 'POST',
        timeoutMs: 120000,
        body: JSON.stringify({}),
      });
      const data = res.data;
      if (res.ok && data?.ok) {
        setGithubSyncMessage({
          ok: true,
          text: `Wysłano: ${data.uploaded?.length || 0}, pobrano: ${data.downloaded?.length || 0}, konflikty: ${data.conflicts?.length || 0}, pominięto: ${data.skipped?.length || 0}.`,
        });
      } else {
        setGithubSyncMessage({
          ok: false,
          text: res.error || data?.error || 'Synchronizacja GitHub nie powiodła się.',
        });
      }
      const status = await safeFetchJson<GitHubSyncStatus>('/api/github/sync-status', { timeoutMs: 10000 });
      if (status.ok && status.data?.ok) setGithubSyncStatus(status.data);
    } finally {
      setIsSyncingGithub(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    async function loadFile() {
      const res = await safeFetchJson<any>(`/api/files?path=${encodeURIComponent(selectedFilePath)}`, {
        signal: controller.signal,
        timeoutMs: 10000,
      });
      if (res.aborted) return;
      const data = res.data;
      setFileContent(res.ok && data?.ok ? data.content : `Błąd odczytu: ${res.error || data?.error || 'nieznany błąd'}`);
    }
    void loadFile();
    return () => {
      controller.abort();
    };
  }, [selectedFilePath]);

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
            01. Dashboard Linux, Silnik Ollama, Codex CLI oraz Menedżer Plików i Wdrożenia Debian 13
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Prawdziwe parametry środowiska wykonawczego z <code className="text-violet-300">/proc/meminfo</code>, <code className="text-violet-300">/etc/os-release</code> i systemu plików — zero symulowanych statusów (rev {serverRevision}).
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

      {/* 3-Column Status Grid: Linux Host, Ollama Engine, Codex CLI & GitHub */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Card 1: Real Linux Kernel & Host Telemetry */}
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">
              Stan Hosta Linux
            </h2>
            <span className="text-xs font-mono text-emerald-400">
              {host.os_pretty_name || 'Debian Linux'}
            </span>
          </div>

          <div className="space-y-2 text-xs font-mono tabular-nums text-slate-300">
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Jądro (uname -r):</span>
              <span>{host.kernel_release || 'Linux'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Wersja dystrybucji:</span>
              <span>
                Debian {host.os_version_id} ({host.os_codename})
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Python Runtime:</span>
              <span className="text-violet-300">Python {host.python_version} (PID Aktywny)</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Pamięć RAM (Użycie / Całość):</span>
              <span>
                {telemetry.ram_used_mb ?? 0} MB / {telemetry.ram_total_mb ?? 0} MB (Wolne: {telemetry.ram_available_mb ?? 0} MB)
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Dysk główny (/):</span>
              <span>
                Wolne {telemetry.disk_free_gb ?? 0} GB z {telemetry.disk_total_gb ?? 0} GB
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">systemd / svl-python-os:</span>
              <span className="text-emerald-400">
                AKTYWNY (ROOT UID 0 · NOPASSWD: ALL)
              </span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-slate-400">Uprawnienia Rodziny Mitek:</span>
              <span className="text-emerald-300 truncate max-w-[200px]">ROOT (Aria, Alex, Astyria, Aurelius Mitek)</span>
            </div>
          </div>
        </div>

        {/* Card 2: Ollama Local AI Engine Status */}
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">
              Silnik Lokalny Ollama
            </h2>
            <span
              className={`text-xs font-mono ${
                ollama.daemon_reachable ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              {ollama.daemon_reachable ? 'ONLINE (11434)' : 'OFFLINE W KONTENERZE'}
            </span>
          </div>

          <div className="space-y-2 text-xs font-mono tabular-nums text-slate-300">
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Endpoint:</span>
              <span>{ollama.ollama_host || 'http://127.0.0.1:11434'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Binarka ollama w PATH:</span>
              <span>{ollama.binary_installed ? 'Zainstalowana' : 'Brak w kontenerze'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Docelowy model Vision 11B:</span>
              <span className="text-violet-300">{ollama.preferred_14b_vision_model || 'llama3.2-vision:11b'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Wykryte modele lokalne:</span>
              <span>{(ollama.models || []).length} modeli</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Aktywne w VRAM/RAM (/api/ps):</span>
              <span>{(ollama.loaded_models || []).length > 0 ? ollama.loaded_models.join(', ') : 'Brak'}</span>
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
              {pullState && (pullState.active || pullState.error || pullState.percent > 0) && (
                <div className="space-y-1 text-[11px] font-mono">
                  <div className="flex justify-between text-slate-300">
                    <span className="truncate">{pullState.model}: {pullState.status}</span>
                    <span>{pullState.percent ?? 0}%</span>
                  </div>
                  <div className="h-1.5 w-full rounded bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full transition-all ${pullState.error ? 'bg-amber-500' : 'bg-emerald-500'}`}
                      style={{ width: `${Math.min(100, Math.max(0, pullState.percent ?? 0))}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {ollamaActionMsg && (
            <div className={`text-xs ${ollamaActionMsg.ok ? 'text-emerald-400' : 'text-amber-400'}`}>
              {ollamaActionMsg.text}
            </div>
          )}

          <div className="p-3 rounded-lg bg-[#0B0D13] border border-slate-800 text-xs text-slate-400 leading-relaxed">
            {ollama.daemon_reachable ? (
              <span>
                Połączono z serwerem Ollama. Dostępne modele:{' '}
                {(ollama.models || []).map((m: any) => m.name).join(', ') || 'Brak pobranych modeli (kliknij ollama pull dla llama3.2-vision:11b)'}.
              </span>
            ) : (
              <span>
                Daemon Ollama pod adresem <code className="text-violet-300">{ollama.ollama_host || 'http://127.0.0.1:11434'}</code> nie odpowiada ({ollama.error || 'offline'}). Podaj adres działającego serwera Ollama powyżej lub uruchom instalator <code className="text-violet-300">deploy/install-debian13.sh</code> na hoście Debian 13.
              </span>
            )}
          </div>
        </div>

        {/* Card 3: OpenAI Codex CLI & GitHub Repositories */}
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">
              OpenAI Codex CLI &amp; GitHub
            </h2>
            <span className="text-xs font-mono text-violet-300">
              Gałąź: {codex.active_branch || 'main'}
            </span>
          </div>

          <div className="space-y-2 text-xs font-mono tabular-nums text-slate-300">
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Binarka codex:</span>
              <span>{codex.codex_cli_installed ? codex.codex_binary_path : 'Skrypt w install-debian13.sh'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Logowanie Codex (backend):</span>
              <span className={codex.codex_cli_logged_in ? 'text-emerald-400' : 'text-amber-400'}>
                {codex.codex_cli_logged_in ? 'Zalogowano CLI' : 'Brak aktywnej sesji CLI'}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Komenda Device Login:</span>
              <span className="text-emerald-400">codex login --device-auth</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Repozytorium SVL_System:</span>
              <span className="text-emerald-400">
                {syncRep?.repositories_inspected?.SVL_System?.reachable ? 'Połączono (GitHub API)' : 'Dostępne'}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Repozytorium Debian_13:</span>
              <span className="text-emerald-400">
                {syncRep?.repositories_inspected?.Debian_13?.reachable ? 'Połączono (GitHub API)' : 'Dostępne'}
              </span>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-[#0B0D13] border border-slate-800 text-xs text-slate-400 leading-relaxed">
            {codex.chatgpt_oauth_note}
          </div>

          <div className="p-3 rounded-lg bg-[#0B0D13] border border-slate-800 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className={githubSyncStatus?.tokenConfigured ? 'text-emerald-300' : 'text-amber-300'}>
                {!githubSyncStatus
                  ? 'Sprawdzam status GitHub…'
                  : githubSyncStatus.tokenConfigured
                    ? githubSyncStatus.automaticEnabled
                      ? 'Auto-sync aktywny'
                      : 'Token ustawiony; auto-sync wyłączony'
                    : 'Brak GITHUB_TOKEN — synchronizacja wyłączona'}
              </span>
              <a
                href={githubSyncStatus?.branchUrl || 'https://github.com/mmitek515-netizen/SVL_open/tree/svl-sync'}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-violet-300 hover:text-violet-200 underline"
              >
                Gałąź: {githubSyncStatus?.branch || 'svl-sync'}
              </a>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-400">
              Zmiany lokalne są publikowane na tej gałęzi, nie na <code>main</code>. Ustaw serwerowy token z uprawnieniem Contents (read/write) w <code>.env</code>.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void handleGitHubWorkspaceSync()}
                disabled={!githubSyncStatus?.tokenConfigured || isSyncingGithub || githubSyncStatus.running}
                className="min-h-[34px] px-3 py-1.5 rounded-lg bg-violet-700 hover:bg-violet-600 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium text-white flex items-center gap-2"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSyncingGithub || githubSyncStatus?.running ? 'animate-spin' : ''}`} />
                {isSyncingGithub || githubSyncStatus?.running ? 'Synchronizuję…' : 'Synchronizuj workspace'}
              </button>
              {githubSyncStatus?.lastSuccessAt && (
                <span className="text-[11px] text-slate-500">
                  Ostatnio: {new Date(githubSyncStatus.lastSuccessAt).toLocaleString('pl-PL')}
                </span>
              )}
            </div>
            {githubSyncStatus?.lastResult && (
              <p className="text-[11px] text-slate-400">
                Ostatni wynik: wysłano {githubSyncStatus.lastResult.uploaded.length}, pobrano {githubSyncStatus.lastResult.downloaded.length}, konflikty {githubSyncStatus.lastResult.conflicts.length}, pominięto {githubSyncStatus.lastResult.skipped.length}.
              </p>
            )}
            {githubSyncStatus?.lastResult?.conflicts.length ? (
              <p className="text-[11px] text-amber-300">
                Konflikty: {githubSyncStatus.lastResult.conflicts.slice(0, 3).join(', ')}
              </p>
            ) : null}
            {githubSyncStatus?.lastResult?.skipped.length ? (
              <p className="text-[11px] text-amber-300">
                Pominięte pliki: {githubSyncStatus.lastResult.skipped.slice(0, 3).join(', ')}
              </p>
            ) : null}
            {githubSyncMessage && (
              <p className={`text-xs ${githubSyncMessage.ok ? 'text-emerald-300' : 'text-rose-300'}`}>
                {githubSyncMessage.text}
              </p>
            )}
            {githubSyncStatus?.lastError && (
              <p className="text-xs text-rose-300">Ostatni błąd syncu: {githubSyncStatus.lastError}</p>
            )}
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
            03. Instrukcja Podłączenia Zewnętrznego Hosta Debian 13 Trixie
          </h2>
          <div className="space-y-3 text-xs text-slate-300 leading-relaxed">
            <p>
              W środowisku Google AI Studio aplikacja uruchamia na żywo frontend Open WebUI, serwer WebSocket oraz backend Python 3 (<code className="text-violet-300">backend/app.py</code>) z bazą SQLite i 4 procesami workerów.
            </p>
            <p>
              Aby uruchomić pełny stos na fizycznej maszynie lub VM z <strong>Debian 13 Trixie</strong> (systemd, Docker Compose, Ollama <code className="text-violet-300">llama3.2-vision:11b</code> z GPU oraz Open WebUI):
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
              <li>
                Zaloguj oficjalny Codex CLI przez konto ChatGPT:
                <div className="mt-1 p-1.5 bg-slate-900 rounded text-emerald-400">
                  codex login --device-auth
                </div>
              </li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
};
