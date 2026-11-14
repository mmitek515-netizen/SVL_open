import React, { useState } from 'react';
import {
  ShieldCheck,
  Lock,
  Compass,
  Database,
  Activity,
  CheckCircle2,
  XCircle,
  RefreshCw,
} from 'lucide-react';

interface KernelDiagnosticsViewProps {
  kernelData: any;
  agentsData: any;
  operatorToken: string;
  onRefresh: () => Promise<void>;
}

export const KernelDiagnosticsView: React.FC<KernelDiagnosticsViewProps> = ({
  kernelData,
  agentsData,
  operatorToken,
  onRefresh,
}) => {
  // TopologicalInfinityEngine Interactive Evaluator State
  const [xStartInput, setXStartInput] = useState('-inf');
  const [xEndInput, setXEndInput] = useState('inf');
  const [topoResult, setTopoResult] = useState<any>(
    kernelData?.report?.Topological_Compact_Engine || null,
  );

  // SVLProtectedVariable RBAC Test State
  const [targetVarName, setTargetVarName] = useState('SYS_VERSION');
  const [newVarValue, setNewVarValue] = useState('5.6.2-QuantumWheel-Verified');
  const [tokenToTest, setTokenToTest] = useState(operatorToken || '');
  const [varUpdateFeedback, setVarUpdateFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  // Update History Toggle (Real vs Marked Demo Fixtures)
  const [showDemoFixtures, setShowDemoFixtures] = useState(false);
  const [demoReportData, setDemoReportData] = useState<any>(null);

  const report = kernelData?.report || {};
  const protectedVars = kernelData?.protected_variables || {};
  const visualScopes: any[] = kernelData?.visual_scopes || [];
  const auditLogs: any[] = kernelData?.audit_logs || [];
  const sphericalBus = agentsData?.spherical_bus || {};

  const handleEvaluateTopology = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const resp = await fetch('/api/py/kernel/evaluate-topology', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x_start: xStartInput.trim(), x_end: xEndInput.trim() }),
      });
      const data = await resp.json();
      if (data.ok) {
        setTopoResult(data.evaluation);
      }
    } catch {
      // ignore error
    }
  };

  const handleTestProtectedUpdate = async (tokenOverride?: string) => {
    const tokenUsed = tokenOverride !== undefined ? tokenOverride : tokenToTest;
    try {
      const resp = await fetch('/api/py/kernel/update-variable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: targetVarName,
          value: newVarValue,
          token: tokenUsed,
          actor: 'operator_ui',
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setVarUpdateFeedback({
          ok: true,
          msg: `Autoryzacja HMAC powiodła się! Zmienna ${targetVarName} zaktualizowana do "${newVarValue}".`,
        });
      } else {
        setVarUpdateFeedback({
          ok: false,
          msg:
            tokenUsed === '364_OMNIKLUCZ_ROOT'
              ? 'ZABLOKOWANO: Historyczny zahardkodowany token "364_OMNIKLUCZ_ROOT" został odrzucony przez SVLProtectedVariable i zapisany w dzienniku audytu!'
              : 'ODMOWA DOSTĘPU: Nieprawidłowy SVL_OPERATOR_TOKEN (wymagany sekret backendu >= 32 znaki).',
        });
      }
      await onRefresh();
    } catch (err: any) {
      setVarUpdateFeedback({ ok: false, msg: `Błąd: ${err?.message}` });
    }
  };

  const handleToggleDemoHistory = async (checked: boolean) => {
    setShowDemoFixtures(checked);
    if (checked) {
      const resp = await fetch('/api/py/kernel/report?include_demo=true');
      const data = await resp.json();
      setDemoReportData(data?.report);
    } else {
      setDemoReportData(null);
    }
  };

  const displayedUpdates: any[] =
    (showDemoFixtures && demoReportData?.Update_History) || report.Update_History || [];

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-6 bg-[#0B0D13]">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <h1 className="text-xl font-bold text-slate-100">
            01. Jądro SVLSystemKernel (Python 3) i Sferyczna Architektura Workerów
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Rzeczywiste moduły Python (<code className="text-violet-300">VisualScope</code>,{' '}
            <code className="text-violet-300">SVLProtectedVariable</code>,{' '}
            <code className="text-violet-300">TopologicalInfinityEngine</code>,{' '}
            <code className="text-violet-300">SVLSystemKernel</code>) uruchomione w procesie backendu z trwałą bazą SQLite.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="min-h-[40px] px-4 py-2 rounded-lg bg-[#111520] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-2 self-start whitespace-nowrap"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Odśwież raport jądra
        </button>
      </div>

      {/* Top 2-Column Split: SVLProtectedVariable RBAC Vault & TopologicalInfinityEngine */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: SVLProtectedVariable RBAC & Hardcoded Token Removal Proof */}
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">
              02. SVLProtectedVariable (Usunięto token 364_OMNIKLUCZ_ROOT)
            </h2>
            <span className="text-xs font-mono text-emerald-400">HMAC-SHA256 RBAC</span>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            Zahardkodowany w pierwotnym kodzie token <code className="text-rose-400">364_OMNIKLUCZ_ROOT</code> został usunięty i zastąpiony weryfikacją stałoczasową (<code className="text-slate-300">hmac.compare_digest</code>) względem sekretu backendu <code className="text-violet-300">SVL_OPERATOR_TOKEN</code> (min. 32 znaki).
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

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => handleTestProtectedUpdate('364_OMNIKLUCZ_ROOT')}
              className="px-3 py-2 rounded-lg bg-rose-950/60 hover:bg-rose-900/60 border border-rose-500/40 text-rose-300 text-xs font-medium transition-colors whitespace-nowrap"
            >
              Testuj odrzucenie: 364_OMNIKLUCZ_ROOT
            </button>
            <button
              type="button"
              onClick={() => handleTestProtectedUpdate(operatorToken)}
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

          {/* Protected Variables Current Snapshot */}
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

          <form onSubmit={handleEvaluateTopology} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
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
          <h2 className="text-sm font-semibold text-slate-100">
            05. Telemetria Sferycznej Magistrali Zdarzeń (SphericalEventBus)
          </h2>
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

      {/* Bottom Section: Verified Update History in SQLite vs Optional Demo Fixtures & JSON Report */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-100">
              06. Trwała Historia Aktualizacji w SQLite (Bez fikcyjnych dat w raportach produkcyjnych)
            </h2>
            <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
              <input
                type="checkbox"
                checked={showDemoFixtures}
                onChange={(e) => handleToggleDemoHistory(e.target.checked)}
                className="rounded border-slate-700 bg-[#0B0D13]"
              />
              <span>Pokaż oznaczone dane demonstracyjne z kodu wejściowego</span>
            </label>
          </div>

          <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
            {displayedUpdates.map((u: any, idx: number) => (
              <div
                key={`${u.wersja}-${idx}`}
                className={`p-3 rounded-lg border text-xs space-y-1 ${
                  u.is_demo
                    ? 'bg-amber-950/20 border-amber-500/30 text-amber-200'
                    : 'bg-[#0B0D13] border-slate-800 text-slate-200'
                }`}
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
            07. Rzeczywisty Zrzut Stanu Systemu (SVLSystemKernel.generate_system_status_report)
          </h2>
          <pre className="p-3.5 rounded-lg bg-[#07090E] border border-slate-800 text-[11px] font-mono text-slate-300 overflow-x-auto max-h-64 leading-relaxed">
            {JSON.stringify(showDemoFixtures && demoReportData ? demoReportData : report, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
};
