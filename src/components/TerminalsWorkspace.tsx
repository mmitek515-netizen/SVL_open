import React, { useState, useRef, useEffect } from 'react';
import {
  Play,
  Trash2,
} from 'lucide-react';
import {
  TerminalLogLine,
  TerminalTabId,
  safeFetchJson,
} from '../utils/svlLogic';
import { useSvlSync } from '../utils/svlSyncStore';

const TERMINAL_TABS: Array<{
  id: TerminalTabId;
  label: string;
  subtitle: string;
  defaultPrompt: string;
  welcomeText: string;
  quickCommands: string[];
}> = [
  {
    id: 'ssh',
    label: 'SSH · Ship',
    subtitle: 'Wykonuje polecenia wyłącznie na hoście SSH Ship; wymaga potwierdzenia. Przy błędzie SSH nie przełącza się na lokalny shell.',
    defaultPrompt: 'Ship$',
    welcomeText:
      'Zdalny terminal SSH używa aliasu OpenSSH Ship i istniejącego uwierzytelniania serwera. Każde polecenie wymaga osobnego potwierdzenia; Ollama nie wykonuje tu poleceń.',
    quickCommands: [
      'id',
      'hostname',
      'uname -a',
      'df -h / && free -h',
    ],
  },
  {
    id: 'linux',
    label: 'Powłoka Linux',
    subtitle: 'Powłoka Bash środowiska aplikacji. Polecenia działają z uprawnieniami procesu serwera; brak automatycznego podnoszenia uprawnień.',
    defaultPrompt: 'svl@debian13:/app/applet$',
    welcomeText:
      'Powłoka Linux wykonuje polecenia jako proces serwera. Dostęp do terminala wymaga SVL_OPERATOR_TOKEN; polecenia nie otrzymują automatycznie uprawnień administratora.',
    quickCommands: [
      'id',
      'uname -a && cat /etc/os-release',
      'df -h / && free -m',
      'ollama list',
      'podłącz moje ai',
    ],
  },
  {
    id: 'python',
    label: 'Python 3 Console',
    subtitle: 'Interaktywna sesja REPL z załadowanym SVLSystemKernel i TopologicalInfinityEngine',
    defaultPrompt: 'svl-py3>>>',
    welcomeText:
      'Python 3 Interactive Kernel REPL. Dostępne obiekty w przestrzeni nazw: kernel, VisualScope, SVLProtectedVariable, TopologicalInfinityEngine, BinaryHyperspaceKernel, WithoutNlpHarmonicEngine.',
    quickCommands: [
      'print(kernel.generate_comprehensive_svl_system_markdown_report("raport systemu"))',
      'print(kernel.generate_system_status_report())',
      'TopologicalInfinityEngine(float("-inf"), float("inf")).evaluate_diagnostics()',
      'VisualScope.get_registry_snapshot()',
      'hyperspace.resolve_intent("status systemu i diagnostyka")',
    ],
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    subtitle: 'Status binarki Codex CLI, logowania oraz bieżącej gałęzi repozytorium',
    defaultPrompt: 'codex$',
    welcomeText:
      'Terminal OpenAI Codex CLI Bridge. Wpisz "status", aby sprawdzić binarkę codex, autoryzację ChatGPT OAuth (codex login --device-auth) oraz bieżącą gałąź repozytorium.',
    quickCommands: [
      'status',
      'git status -s && git branch -v',
      'git log -n 5 --oneline',
    ],
  },
  {
    id: 'hyperspace',
    label: 'Konsola obliczeń 128-bit',
    subtitle: 'Moduł obliczeniowy 128-bit BinaryHyperspaceKernel (Hamming) + Analiza Harmoniczna Eulera/Fouriera',
    defaultPrompt: 'hyper128>',
    welcomeText:
      'Konsola wywołuje silnik obliczeń wektorowych i harmonicznych dostępny w backendzie.',
    quickCommands: [
      'system status and diagnostics',
      'vector similarity with Hamming distance',
      'spectral analysis of a sample signal',
    ],
  },
  {
    id: 'agents',
    label: 'Konsola agentów',
    subtitle: 'Zapisuje dyrektywy jako zadania dla agentów; wykonanie zależy od dostępności workera.',
    defaultPrompt: 'agents>',
    welcomeText:
      'Wpisz @Aria, @Alex, @Astyria, @Aurelius lub @Agata i treść zadania. Dyrektywa zostanie zapisana w kolejce; jej wykonanie zależy od aktywnego workera.',
    quickCommands: [
      'podłącz moje ai',
      '@Alex Sprawdź spójność usług backendu Python i bazy SQLite',
      '@Aria Zweryfikuj połączenie z lokalnym silnikiem Ollama 11434',
      '@Astyria Oceń responsywność interfejsu Open WebUI na ekranach dotykowych',
      '@Aurelius Sprawdź zakres uprawnień skonfigurowanych agentów',
    ],
  },
];

export const TerminalsWorkspace: React.FC = () => {
  const {
    tabOrigin,
    wsState,
    wsAttempt,
    serverRevision,
    terminalLogsByTab,
    clearTerminalTab,
    refreshTerminals,
    refreshDomainModules,
    reconnectWebSocket,
  } = useSvlSync();

  const [activeTab, setActiveTab] = useState<TerminalTabId>('linux');
  const [commandInput, setCommandInput] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [terminalActionError, setTerminalActionError] = useState<string | null>(null);
  const [localFallbackLogs, setLocalFallbackLogs] = useState<Record<TerminalTabId, TerminalLogLine[]>>({
    linux: [],
    ssh: [],
    python: [],
    codex: [],
    hyperspace: [],
    agents: [],
  });

  const [operatorTokenInput, setOperatorTokenInput] = useState('');

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const prevLogLenRef = useRef<number>(0);

  const currentTabMeta = TERMINAL_TABS.find((t) => t.id === activeTab)!;
  const persistedLogs = terminalLogsByTab[activeTab] || [];
  const mergedTabLogs: TerminalLogLine[] =
    persistedLogs.length > 0 || (localFallbackLogs[activeTab] || []).length > 0
      ? [
          ...persistedLogs,
          ...(localFallbackLogs[activeTab] || []).filter(
            (loc) => !persistedLogs.some((srv) => srv.id === loc.id),
          ),
        ]
      : [
          {
            id: `banner-${activeTab}`,
            timestamp: new Date().toLocaleTimeString('pl-PL', { hour12: false }),
            kind: 'system',
            text: currentTabMeta.welcomeText,
          },
        ];

  useEffect(() => {
    const curLen = mergedTabLogs.length;
    const prevLen = prevLogLenRef.current;
    prevLogLenRef.current = curLen;
    if (curLen === prevLen && !isExecuting) return;

    const el = viewportRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist < 180 || isExecuting) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeTab, mergedTabLogs.length, isExecuting]);

  const appendLocalOnlyLog = (tab: TerminalTabId, kind: TerminalLogLine['kind'], text: string) => {
    const now = new Date().toLocaleTimeString('pl-PL', { hour12: false });
    setLocalFallbackLogs((prev) => ({
      ...prev,
      [tab]: [
        ...prev[tab],
        {
          id: `${tab}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: now,
          kind,
          text,
        },
      ],
    }));
  };

  const executeTerminalCommand = async (rawCmd: string) => {
    const trimmed = rawCmd.trim();
    if (!trimmed || isExecuting) return;
    if (activeTab === 'ssh' && !window.confirm(`Wykonać na zdalnym hoście Ship?\n\n${trimmed}`)) return;
    setTerminalActionError(null);
    setIsExecuting(true);

    try {
      const res = await safeFetchJson<any>('/api/terminal/exec', {
        method: 'POST',
        timeoutMs: 22000,
        body: JSON.stringify({
          terminalType: activeTab,
          command: trimmed,
          operatorToken: operatorTokenInput,
          origin: tabOrigin,
          confirmed: activeTab === 'ssh',
        }),
      });
      const data = res.data;

      if (!res.ok || !data || data.ok === false) {
        appendLocalOnlyLog(activeTab, 'stderr', res.error || data?.error || `Błąd HTTP ${res.status}`);
        return;
      }
      setCommandInput('');

      // Sync persisted terminal logs, agents, modules & chat state immediately from SQLite
      setLocalFallbackLogs((prev) => ({ ...prev, [activeTab]: [] }));
      await Promise.all([
        refreshTerminals(),
        refreshDomainModules(['agents', 'modules', 'kernel', 'chat', 'notifications']),
      ]);
    } finally {
      setIsExecuting(false);
    }
  };

  const handleClearActiveTab = async () => {
    setTerminalActionError(null);
    setLocalFallbackLogs((prev) => ({ ...prev, [activeTab]: [] }));
    const res = await clearTerminalTab(activeTab);
    if (!res.ok && res.error) {
      setTerminalActionError(res.error);
    }
  };

  const wsLabel = wsState === 'online'
    ? `WebSocket online · Terminal chroniony tokenem · rev ${serverRevision}`
    : `Sync HTTP · Terminal chroniony tokenem · rev ${serverRevision}`;

  const wsClass = wsState === 'online' ? 'text-emerald-400' : 'text-amber-400';

  return (
    <div className="flex flex-col h-full bg-[#0B0D13] overflow-hidden">
      {/* Terminal Selector Bar */}
      <div className="px-4 py-3 border-b border-slate-800 bg-[#111520] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
          {TERMINAL_TABS.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'bg-violet-600 text-white'
                    : 'bg-[#0B0D13] text-slate-400 hover:text-slate-200 border border-slate-800'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 text-xs font-mono tabular-nums text-slate-400">
          <button
            type="button"
            onClick={() => {
              if (wsState === 'offline') reconnectWebSocket();
            }}
            className={`${wsClass} ${wsState === 'offline' ? 'hover:underline cursor-pointer' : 'cursor-default'}`}
          >
            /ws/svl: {wsLabel}
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => void handleClearActiveTab()}
            className="text-slate-400 hover:text-rose-400 flex items-center gap-1"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Wyczyść historię SQLite
          </button>
        </div>
      </div>

      {/* Active Terminal Subtitle & Quick Presets */}
      <div className="px-4 py-2 bg-[#0D1018] border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-slate-400">{currentTabMeta.subtitle}</span>
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {currentTabMeta.quickCommands.map((qCmd) => (
            <button
              key={qCmd}
              type="button"
              onClick={() => void executeTerminalCommand(qCmd)}
              disabled={isExecuting}
              className="px-2.5 py-1 rounded bg-slate-800/90 hover:bg-slate-700 text-slate-200 text-[11px] font-mono whitespace-nowrap shrink-0 transition-colors"
            >
              {qCmd.length > 44 ? `${qCmd.slice(0, 44)}...` : qCmd}
            </button>
          ))}
        </div>
      </div>

      {terminalActionError && (
        <div className="px-4 py-2 bg-rose-950/40 border-b border-rose-500/40 text-xs font-mono text-rose-300">
          {terminalActionError}
        </div>
      )}

      {/* Terminal Output Viewport */}
      <div ref={viewportRef} className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-2 bg-[#07090E]">
        {mergedTabLogs.map((line) => {
          let textStyle = 'text-slate-200';
          if (line.kind === 'input') textStyle = 'text-violet-300 font-semibold';
          else if (line.kind === 'stderr') textStyle = 'text-rose-400';
          else if (line.kind === 'system') textStyle = 'text-emerald-400';

          return (
            <div key={line.id} className={`${textStyle} whitespace-pre-wrap break-words leading-relaxed`}>
              <span className="text-slate-600 select-none mr-2 tabular-nums">[{line.timestamp}]</span>
              {line.text}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="px-3 py-2 border-t border-slate-800 bg-[#111520]">
        <label className="text-[11px] text-slate-400 flex flex-wrap items-center gap-2">
          <span>Autoryzacja terminala</span>
          <input type="password" autoComplete="off" spellCheck={false}
            aria-label="Prywatny token operatora SVL"
            value={operatorTokenInput}
            onChange={(event) => setOperatorTokenInput(event.target.value)}
            placeholder="SVL_OPERATOR_TOKEN"
            className="min-w-0 w-48 max-w-full rounded-md border border-slate-700 bg-[#0B0D13] px-2 py-1 text-xs text-slate-100"
          />
          <span>Token pozostaje tylko w bieżącej karcie.</span>
        </label>
      </div>
      {/* Command Input Bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void executeTerminalCommand(commandInput);
        }}
        className="p-3 bg-[#111520] border-t border-slate-800 flex items-center gap-2"
      >
        <span className="text-xs font-mono text-violet-400 shrink-0 select-none">
          {currentTabMeta.defaultPrompt}
        </span>
        <input
          type="text"
          value={commandInput}
          onChange={(e) => setCommandInput(e.target.value)}
          placeholder={`Wprowadź polecenie dla ${currentTabMeta.label}...`}
          aria-label={`Wejście terminala ${currentTabMeta.label}`}
          className="flex-1 min-h-[40px] bg-[#0B0D13] border border-slate-700/80 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-violet-500"
        />
        <button
          type="submit"
          disabled={isExecuting || !commandInput.trim()}
          className="min-h-[40px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <Play className="w-3.5 h-3.5" />
          <span>{isExecuting ? 'Wykonywanie...' : 'Uruchom'}</span>
        </button>
      </form>
    </div>
  );
};
