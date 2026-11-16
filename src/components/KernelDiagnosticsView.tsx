import React, { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { createUniqueId, safeFetchJson } from '../utils/svlLogic';
import { useSvlSync } from '../utils/svlSyncStore';

export const KernelDiagnosticsView: React.FC = () => {
  const {
    tabOrigin,
    kernelData,
    agentsData,
    systemModules,
    refreshDomainModules,
    notifyLocalMutation,
    upsertSystemModule,
    deleteSystemModule,
    serverRevision,
  } = useSvlSync();

  // TopologicalInfinityEngine Interactive Evaluator State
  const [xStartInput, setXStartInput] = useState('-inf');
  const [xEndInput, setXEndInput] = useState('inf');
  const [topoResult, setTopoResult] = useState<any>(
    kernelData?.report?.Topological_Compact_Engine || null,
  );

  // SVLProtectedVariable RBAC Test State (token strictly entered by operator, never leaked from API)
  const [targetVarName, setTargetVarName] = useState('SYS_VERSION');
  const [newVarValue, setNewVarValue] = useState('unversioned');
  const [tokenToTest, setTokenToTest] = useState('');
  const [varUpdateFeedback, setVarUpdateFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const [topoError, setTopoError] = useState<string | null>(null);

  // System Modules Registry Form State
  const [modIdInput, setModIdInput] = useState('');
  const [modNameInput, setModNameInput] = useState('');
  const [modKindInput, setModKindInput] = useState('extension');
  const [modDescInput, setModDescInput] = useState('');
  const [isSavingModule, setIsSavingModule] = useState(false);
  const [modFeedback, setModFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (!topoResult && kernelData?.report?.Topological_Compact_Engine) {
      setTopoResult(kernelData.report.Topological_Compact_Engine);
    }
  }, [kernelData?.report?.Topological_Compact_Engine, topoResult]);

  const report = kernelData?.report || {};
  const protectedVars = kernelData?.protected_variables || {};
  const visualScopes: any[] = kernelData?.visual_scopes || [];
  const sphericalBus = agentsData?.spherical_bus || {};
  const modulesList =
    systemModules.length > 0 ? systemModules : kernelData?.system_modules || [];

  const handleEvaluateTopology = async (e: React.FormEvent) => {
    e.preventDefault();
    setTopoError(null);
    const res = await safeFetchJson<any>('/api/py/kernel/evaluate-topology', {
      method: 'POST',
      timeoutMs: 10000,
      body: JSON.stringify({ x_start: xStartInput.trim(), x_end: xEndInput.trim() }),
    });
    if (res.ok && res.data?.ok) {
      setTopoResult(res.data.evaluation);
    } else {
      setTopoError(res.error || res.data?.error || 'Błąd obliczeń topologicznych.');
    }
  };

  const handleTestProtectedUpdate = async (tokenOverride?: string) => {
    const tokenUsed = (tokenOverride !== undefined ? tokenOverride : tokenToTest).trim();
    if (!tokenUsed) {
      setVarUpdateFeedback({
        ok: false,
        msg: 'Podaj SVL_OPERATOR_TOKEN (>= 32 znaki) w polu tokenu lub użyj przycisku testu odrzucenia.',
      });
      return;
    }

    const res = await safeFetchJson<any>('/api/py/kernel/update-variable', {
      method: 'POST',
      timeoutMs: 10000,
      body: JSON.stringify({
        name: targetVarName,
        value: newVarValue,
        token: tokenUsed,
        actor: 'operator_ui',
        origin: tabOrigin,
        eventId: createUniqueId('evt-kvar'),
      }),
    });
    const data = res.data;
    if (!res.ok && res.error) {
      setVarUpdateFeedback({ ok: false, msg: res.error });
      return;
    }
    if (data?.success) {
      setVarUpdateFeedback({
        ok: true,
        msg: `Autoryzacja HMAC powiodła się! Zmienna ${targetVarName} zaktualizowana do "${newVarValue}".`,
      });
      notifyLocalMutation('kernel', targetVarName, data.serverRevision, data.event);
    } else {
      setVarUpdateFeedback({
        ok: false,
        msg: 'ODMOWA DOSTĘPU: Nieprawidłowy SVL_OPERATOR_TOKEN (wymagany sekret backendu >= 32 znaki).',
      });
    }
    await refreshDomainModules(['kernel', 'health']);
  };

  const displayedUpdates: any[] = report.Update_History || [];

  const handleUpsertModule = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = modIdInput.trim();
    const name = modNameInput.trim();
    if (!id) {
      setModFeedback({ ok: false, msg: 'Podaj identyfikator modułu (np. svl-custom-01).' });
      return;
    }
    setIsSavingModule(true);
    setModFeedback(null);
    try {
      const existingModule = modulesList.find(
        (module: any) => String(module.id || '').toLowerCase() === id.toLowerCase(),
      );
      const res = await upsertSystemModule({
        id,
        name: name || id.toUpperCase(),
        kind: modKindInput,
        status: existingModule?.status || 'CONFIGURED',
        description:
          modDescInput.trim() ||
          existingModule?.description ||
          'Wpis konfiguracyjny; implementacja modułu nie została zweryfikowana.',
      });
      if (res.ok) {
        setModFeedback({
          ok: true,
          msg: `Zapisano moduł "${res.module?.id || id}" w SQLite (rev ${res.module?.revision ?? serverRevision}) i rozgłoszono przez /ws/svl.`,
        });
        setModIdInput('');
        setModNameInput('');
        setModDescInput('');
      } else {
        setModFeedback({ ok: false, msg: res.error || 'Błąd zapisu modułu.' });
      }
    } finally {
      setIsSavingModule(false);
    }
  };

  const handleDeleteModule = async (id: string) => {
    setModFeedback(null);
    const res = await deleteSystemModule(id);
    if (res.ok) {
      setModFeedback({ ok: true, msg: `Usunięto moduł "${id}" z rejestru SQLite.` });
    } else {
      setModFeedback({ ok: false, msg: res.error || `Nie udało się usunąć modułu "${id}".` });
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-6 bg-[#0B0D13]">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <h1 className="text-xl font-bold text-slate-100">
            01. Jądro SVLSystemKernel (Python 3) i Sferyczna Architektura Rodziny Mitek
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Rzeczywiste moduły Python (<code className="text-violet-300">VisualScope</code>,{' '}
            <code className="text-violet-300">SVLProtectedVariable</code>,{' '}
            <code className="text-violet-300">TopologicalInfinityEngine</code>,{' '}
            <code className="text-violet-300">SVLSystemKernel</code>) oraz moduł <code className="text-emerald-300">svl-duplex-chat</code> (kanał rozmów agentów, rev {serverRevision}).
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshDomainModules(['kernel', 'agents'])}
          className="min-h-[40px] px-4 py-2 rounded-lg bg-[#111520] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-2 self-start whitespace-nowrap"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Odśwież raport jądra
        </button>
      </div>

      {/* Top 2-Column Split: SVLProtectedVariable RBAC Vault & TopologicalInfinityEngine */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">
              02. SVLProtectedVariable — chronione zmienne
            </h2>
            <span className="text-xs font-mono text-emerald-400">HMAC-SHA256 RBAC</span>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            Zmiany wymagają sekretu backendu <code className="text-violet-300">SVL_OPERATOR_TOKEN</code> (min. 32 znaki), weryfikowanego po stronie serwera.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="prot-var-select" className="block text-xs text-slate-400 mb-1">
                Chroniona zmienna:
              </label>
              <select
                id="prot-var-select"
                value={targetVarName}
                onChange={(e) => setTargetVarName(e.target.value)}
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-200"
              >
                <option value="SYS_VERSION">SYS_VERSION ({report.System})</option>
                <option value="OPERATOR">OPERATOR ({report.Operator})</option>
                <option value="SECURITY_POLICY">SECURITY_POLICY</option>
              </select>
            </div>
            <div>
              <label htmlFor="prot-var-val" className="block text-xs text-slate-400 mb-1">
                Nowa wartość:
              </label>
              <input
                id="prot-var-val"
                type="text"
                value={newVarValue}
                onChange={(e) => setNewVarValue(e.target.value)}
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
              />
            </div>
          </div>

          <div>
            <label htmlFor="kernel-operator-token-input" className="block text-xs text-slate-400 mb-1">
              Token operatora (SVL_OPERATOR_TOKEN):
            </label>
            <input
              id="kernel-operator-token-input"
              type="password"
              value={tokenToTest}
              onChange={(e) => setTokenToTest(e.target.value)}
              placeholder="Wpisz SVL_OPERATOR_TOKEN (>= 32 znaki)..."
              className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => void handleTestProtectedUpdate(tokenToTest)}
              className="px-3.5 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold transition-colors whitespace-nowrap"
            >
              Autoryzuj przez SVL_OPERATOR_TOKEN
            </button>
          </div>

          {varUpdateFeedback && (
            <div
              className={`p-3 rounded-lg border text-xs font-mono ${
                varUpdateFeedback.ok
                  ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                  : 'bg-rose-950/40 border-rose-500/40 text-rose-300'
              }`}
            >
              {varUpdateFeedback.msg}
            </div>
          )}

          {/* Protected Variables Current State */}
          <div className="pt-2 border-t border-slate-800 space-y-1.5 text-xs font-mono">
            {Object.values(protectedVars).map((v: any) => (
              <div
                key={v.name}
                className="flex items-center justify-between py-1.5 px-2.5 rounded bg-[#0B0D13] border border-slate-800/80"
              >
                <span className="text-violet-300 font-semibold">{v.name}</span>
                <span className="text-slate-300 truncate max-w-[220px]">{String(v.value)}</span>
                <span className="text-slate-500 tabular-nums">
                  Audyt: {(v.audit_trail || []).length}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Right: TopologicalInfinityEngine Math Verifier */}
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">
              03. TopologicalInfinityEngine (Uzwarcenie Stereograficzne)
            </h2>
            <span className="text-xs font-mono tabular-nums text-violet-300">
              c = {topoResult?.compact_metric_c ?? report.Compact_Metric_C ?? 2.5}
            </span>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            Przekształca przedział <code className="text-slate-300">[x_start, x_end]</code> na przedział zwarty <code className="text-slate-300">[-1.0, 1.0]</code> wzorem <code className="text-violet-300">x / (1 + |x|)</code> i wyznacza przeciwprostokątną <code className="text-violet-300">c = sqrt(a² + b²)</code>. Zgodnie z wymogami architektonicznymi jest to czysta metryka matematyczna (usunięto nieprawdziwą deklarację przyspieszenia sprzętowego +1456%).
          </p>

          <form onSubmit={(e) => void handleEvaluateTopology(e)} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div>
              <label htmlFor="topo-start" className="block text-xs text-slate-400 mb-1">
                Początek przedziału (x_start):
              </label>
              <input
                id="topo-start"
                type="text"
                value={xStartInput}
                onChange={(e) => setXStartInput(e.target.value)}
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
              />
            </div>
            <div>
              <label htmlFor="topo-end" className="block text-xs text-slate-400 mb-1">
                Koniec przedziału (x_end):
              </label>
              <input
                id="topo-end"
                type="text"
                value={xEndInput}
                onChange={(e) => setXEndInput(e.target.value)}
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
              />
            </div>
            <button
              type="submit"
              className="min-h-[38px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold transition-colors whitespace-nowrap"
            >
              Oblicz w Pythonie
            </button>
          </form>

          {topoError && (
            <div className="p-2.5 rounded-lg bg-rose-950/40 border border-rose-500/40 text-xs font-mono text-rose-300">
              {topoError}
            </div>
          )}

          {topoResult && (
            <div className="p-3.5 rounded-lg bg-[#0B0D13] border border-slate-800 grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs font-mono tabular-nums">
              <div>
                <div className="text-slate-500 text-[11px]">compact_start</div>
                <div className="text-slate-100 font-semibold">{topoResult.compact_start}</div>
              </div>
              <div>
                <div className="text-slate-500 text-[11px]">compact_end</div>
                <div className="text-slate-100 font-semibold">{topoResult.compact_end}</div>
              </div>
              <div>
                <div className="text-slate-500 text-[11px]">domain_length (a)</div>
                <div className="text-slate-100 font-semibold">{topoResult.domain_length_a}</div>
              </div>
              <div>
                <div className="text-slate-500 text-[11px]">orthogonal (b)</div>
                <div className="text-slate-100 font-semibold">{topoResult.orthogonal_component_b}</div>
              </div>
              <div>
                <div className="text-slate-500 text-[11px]">Compact_Metric_C</div>
                <div className="text-violet-400 font-bold">{topoResult.compact_metric_c}</div>
              </div>
              <div>
                <div className="text-slate-500 text-[11px]">Wpływ na CPU/RAM</div>
                <div className="text-emerald-400">Brak (czysta mat.)</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Middle Section: VisualScope Registry & Spherical Event Bus Observability */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-3">
          <h2 className="text-sm font-semibold text-slate-100">
            04. Rejestr VisualScope (Widoczność Zasobów i Geometria Sferyczna)
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono tabular-nums">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 pr-3">Identyfikator</th>
                  <th className="py-2 px-3">Tryb zakresu</th>
                  <th className="py-2 px-3">Geometria</th>
                  <th className="py-2 pl-3 text-right">Uprawnieni czytelnicy</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {visualScopes.map((sc: any) => (
                  <tr key={sc.identifier} className="hover:bg-slate-800/30">
                    <td className="py-2 pr-3 text-violet-300 font-semibold">{sc.identifier}</td>
                    <td className="py-2 px-3 text-slate-300">{sc.scope_mode}</td>
                    <td className="py-2 px-3 text-slate-400">{sc.metadata?.geometry}</td>
                    <td className="py-2 pl-3 text-right text-slate-400">
                      {(sc.allowed_readers || []).length} ról
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-100">
              05. Telemetria Sferycznej Magistrali Zdarzeń (SphericalEventBus)
            </h2>
            <span className="text-xs font-mono tabular-nums text-violet-300">
              Bufor: {sphericalBus.max_history_size ?? 250} zdarzeń
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono tabular-nums text-xs">
            <div className="p-3 rounded-lg bg-[#0B0D13] border border-slate-800">
              <div className="text-slate-500 text-[11px]">Opublikowane</div>
              <div className="text-base font-bold text-slate-100">
                {sphericalBus.telemetry?.published_events ?? 0}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-[#0B0D13] border border-slate-800">
              <div className="text-slate-500 text-[11px]">Dostarczone (Pub/Sub)</div>
              <div className="text-base font-bold text-emerald-400">
                {sphericalBus.telemetry?.delivered_events ?? 0}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-[#0B0D13] border border-slate-800">
              <div className="text-slate-500 text-[11px]">Ponowienia (Retry)</div>
              <div className="text-base font-bold text-amber-400">
                {sphericalBus.telemetry?.retried_tasks ?? 0}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-[#0B0D13] border border-slate-800">
              <div className="text-slate-500 text-[11px]">Circuit Breaker Trips</div>
              <div className="text-base font-bold text-rose-400">
                {sphericalBus.telemetry?.circuit_breaker_trips ?? 0}
              </div>
            </div>
          </div>

          <div className="max-h-40 overflow-y-auto space-y-1.5 bg-[#0B0D13] p-3 rounded-lg border border-slate-800 font-mono text-[11px]">
            {(sphericalBus.recent_events || []).length === 0 ? (
              <div className="text-slate-500">Brak zdarzeń w buforze magistrali.</div>
            ) : (
              (sphericalBus.recent_events || []).slice().reverse().map((ev: any) => (
                <div key={ev.id} className="text-slate-300">
                  <span className="text-slate-500 tabular-nums">
                    [{new Date(ev.timestamp).toLocaleTimeString('pl-PL')}]
                  </span>{' '}
                  <span className="text-violet-400">{ev.topic}</span> ({ev.source} -&gt; {ev.target})
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Section 06: Synchronized System Modules Registry (Chat -> SQLite -> Runtime) */}
      <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              06. Rejestr Modułów Systemowych SVL (Zsynchronizowane z Czatu i Jądra)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Trwała tabela SQLite <code className="text-violet-300">system_modules</code> — aktywuje m.in. zsynchronizowany z czatu moduł <code className="text-emerald-300">svl-364</code> oraz ustawia bufor <code className="text-slate-300">SphericalEventBus.max_history_size</code> ({sphericalBus.max_history_size ?? 250}).
            </p>
          </div>
          <span className="text-xs font-mono tabular-nums text-emerald-400">
            Aktywnych modułów: {modulesList.length}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {modulesList.map((mod: any) => {
            const isCore = mod.kind === 'core';
            return (
              <div
                key={mod.id}
                data-module-id={mod.id}
                className="p-3.5 rounded-lg bg-[#0B0D13] border border-slate-800 space-y-2 flex flex-col justify-between"
              >
                <div className="space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-100 truncate">
                        {mod.name}
                      </div>
                      <div className="text-[11px] font-mono text-violet-300">
                        {mod.id} · {mod.kind}
                      </div>
                    </div>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${
                        mod.status === 'ACTIVE'
                          ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                          : 'bg-amber-950/40 border-amber-500/40 text-amber-300'
                      }`}
                    >
                      {mod.status}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">{mod.description}</p>
                </div>

                <div className="pt-2 border-t border-slate-800/80 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 tabular-nums">
                    <span>źródło: {mod.source}</span>
                    <span>rev {mod.revision}</span>
                  </div>
                  {mod.config && Object.keys(mod.config).length > 0 && (
                    <pre className="p-2 rounded bg-[#07090E] border border-slate-800/70 text-[10px] font-mono text-slate-300 overflow-x-auto">
                      {JSON.stringify(mod.config, null, 2)}
                    </pre>
                  )}
                  {!isCore && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteModule(mod.id)}
                      className="text-[11px] font-mono text-rose-400 hover:text-rose-300 hover:underline"
                    >
                      Usuń moduł ({mod.id})
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <form
          onSubmit={(e) => void handleUpsertModule(e)}
          className="pt-3 border-t border-slate-800 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end"
        >
          <div>
            <label htmlFor="svl-mod-id" className="block text-xs text-slate-400 mb-1">
              ID modułu:
            </label>
            <input
              id="svl-mod-id"
              type="text"
              value={modIdInput}
              onChange={(e) => setModIdInput(e.target.value)}
              placeholder="np. svl-sensor-01"
              className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
            />
          </div>
          <div>
            <label htmlFor="svl-mod-name" className="block text-xs text-slate-400 mb-1">
              Nazwa:
            </label>
            <input
              id="svl-mod-name"
              type="text"
              value={modNameInput}
              onChange={(e) => setModNameInput(e.target.value)}
              placeholder="np. SVL Sensor Bridge"
              className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
            />
          </div>
          <div>
            <label htmlFor="svl-mod-kind" className="block text-xs text-slate-400 mb-1">
              Typ:
            </label>
            <select
              id="svl-mod-kind"
              value={modKindInput}
              onChange={(e) => setModKindInput(e.target.value)}
              className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
            >
              <option value="extension">extension</option>
              <option value="vessel">vessel</option>
              <option value="agent_plugin">agent_plugin</option>
            </select>
          </div>
          <div>
            <label htmlFor="svl-mod-desc" className="block text-xs text-slate-400 mb-1">
              Opis:
            </label>
            <input
              id="svl-mod-desc"
              type="text"
              value={modDescInput}
              onChange={(e) => setModDescInput(e.target.value)}
              placeholder="Rola modułu w systemie..."
              className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
            />
          </div>
          <button
            type="submit"
            disabled={isSavingModule}
            className="min-h-[38px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors whitespace-nowrap"
          >
            {isSavingModule ? 'Zapisywanie...' : 'Dodaj / Aktualizuj moduł'}
          </button>
        </form>

        {modFeedback && (
          <div
            className={`p-3 rounded-lg border text-xs font-mono ${
              modFeedback.ok
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                : 'bg-rose-950/40 border-rose-500/40 text-rose-300'
            }`}
          >
            {modFeedback.msg}
          </div>
        )}
      </div>

      {/* Recorded Update History in SQLite */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-100">
              07. Zapisana historia aktualizacji w SQLite
            </h2>
          </div>

          <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
            {displayedUpdates.map((u: any, idx: number) => (
              <div
                key={`${u.wersja}-${idx}`}
                className="p-3 rounded-lg border text-xs space-y-1 bg-[#0B0D13] border-slate-800 text-slate-200"
              >
                <div className="flex items-center justify-between font-mono tabular-nums text-[11px]">
                  <span className="font-semibold text-violet-300">
                    {u.wersja} · {u.typ}
                  </span>
                  <span className="text-slate-400">{u.data}</span>
                </div>
                <p className="text-xs leading-relaxed">{u.opis}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Live Structured JSON Report Output from SVLSystemKernel */}
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-3">
          <h2 className="text-sm font-semibold text-slate-100">
            08. Rzeczywisty Zrzut Stanu Systemu (SVLSystemKernel.generate_system_status_report)
          </h2>
          <pre className="p-3.5 rounded-lg bg-[#07090E] border border-slate-800 text-[11px] font-mono text-slate-300 overflow-x-auto max-h-64 leading-relaxed">
            {JSON.stringify(report, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
};
