/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { ChatWorkspace } from './components/ChatWorkspace';
import { AgentsPanel } from './components/AgentsPanel';
import { TerminalsWorkspace } from './components/TerminalsWorkspace';
import { KernelDiagnosticsView } from './components/KernelDiagnosticsView';
import { LinuxDeployDashboard } from './components/LinuxDeployDashboard';
import { Svl364CommandCenter } from './components/Svl364CommandCenter';
import { NotificationsWorkspace } from './components/NotificationsWorkspace';
import { InfrastructureWorkspace } from './components/InfrastructureWorkspace';
import { SvlSyncProvider, useSvlSync } from './utils/svlSyncStore';
import { CANONICAL_AGENTS, getSvlOperatorAccessToken, safeFetchJson, setSvlOperatorAccessToken } from './utils/svlLogic';

type ActiveWorkspaceTab = 'chat' | 'svl364' | 'notifications' | 'infrastructure' | 'agents' | 'terminals' | 'kernel' | 'linux';

function SVLWorkspaceShell() {
  const [activeTab, setActiveTab] = useState<ActiveWorkspaceTab>('chat');
  const [operatorToken, setOperatorToken] = useState(() => getSvlOperatorAccessToken());
  const [operatorAuthVisible, setOperatorAuthVisible] = useState(false);
  const [operatorAuthStatus, setOperatorAuthStatus] = useState<'none' | 'checking' | 'authorized' | 'denied'>('checking');
  const firstAuthCheckRef = React.useRef(true);

  if (getSvlOperatorAccessToken() !== operatorToken) {
    setSvlOperatorAccessToken(operatorToken);
  }

  useEffect(() => {
    setSvlOperatorAccessToken(operatorToken);
    // Remove credentials left by earlier SVL releases; keep new ones in memory only.
    try { window.localStorage.removeItem('svl_operator_token'); } catch {}
  }, [operatorToken]);
  const {
    agentsData,
    irisUnreadCount,
    isConnectingAi,
    connectMyAi,
    refreshDomainModules,
    reconnectWebSocket,
  } = useSvlSync();

  useEffect(() => {
    if (activeTab === 'chat') {
      void refreshDomainModules(['chat', 'agents', 'health', 'workspace', 'notifications']);
    } else if (activeTab === 'svl364') {
      void refreshDomainModules(['modules', 'kernel', 'agents', 'health', 'chat', 'terminals', 'notifications']);
    } else if (activeTab === 'notifications') {
      void refreshDomainModules(['notifications', 'modules', 'agents', 'health', 'chat']);
    } else if (activeTab === 'infrastructure') {
      void refreshDomainModules(['modules', 'agents', 'health', 'kernel', 'notifications']);
    } else if (activeTab === 'agents') {
      void refreshDomainModules(['agents', 'health', 'workspace']);
    } else if (activeTab === 'terminals') {
      void refreshDomainModules(['terminals', 'health']);
    } else if (activeTab === 'kernel') {
      void refreshDomainModules(['kernel', 'agents']);
    } else if (activeTab === 'linux') {
      void refreshDomainModules(['health', 'agents']);
    }
  }, [activeTab, refreshDomainModules]);

  useEffect(() => {
    let cancelled = false;
    if (!operatorToken) {
      setOperatorAuthStatus('none');
      reconnectWebSocket();
      return;
    }
    setOperatorAuthStatus('checking');
    const isInitial = firstAuthCheckRef.current;
    firstAuthCheckRef.current = false;
    const handle = setTimeout(async () => {
      const result = await safeFetchJson<{ok: boolean; authenticated?: boolean}>(
        '/api/operator/status',
        {
          timeoutMs: 8000,
          maxRetries: 0,
          headers: {'X-SVL-Operator-Token': operatorToken},
        },
      );
      if (cancelled) return;
      const authorized = result.ok && result.data?.ok && result.data?.authenticated === true;
      setOperatorAuthStatus(authorized ? 'authorized' : 'denied');
      if (!isInitial || !authorized) {
        reconnectWebSocket();
      }
      if (authorized && !isInitial) {
        void refreshDomainModules(['chat', 'agents', 'health', 'workspace', 'modules']);
      }
    }, isInitial ? 20 : 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [operatorToken, refreshDomainModules, reconnectWebSocket]);

  const agentsList: any[] = agentsData?.agents || [];
  const activeWorkersCount = agentsList.filter((a) =>
    ['ONLINE_LOCAL_WORKER', 'BUSY_LOCAL_WORKER'].includes(a.status),
  ).length;

  return (
    <div className="flex flex-col h-[100dvh] w-screen overflow-hidden bg-[#0B0D13] text-[#F1F5F9]">
      {/* Compact 3-Zone Top Bar for Maximum Chat Viewport */}
      <header className="flex items-center justify-between gap-2 md:gap-6 px-2.5 md:px-5 py-1.5 border-b border-slate-800/90 bg-[#111520] shrink-0">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('chat');
          }}
          className="text-sm md:text-base font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          SVL Python OS
        </a>

        {/* Zone 2: 5 concise single-line text navigation links */}
        <nav
          aria-label="Główna nawigacja systemu"
          className="flex items-center gap-2.5 md:gap-5 text-xs font-medium text-slate-400 overflow-x-auto no-scrollbar"
        >
          <button
            type="button"
            onClick={() => setActiveTab('chat')}
            className={`py-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'chat'
                ? 'text-violet-300 border-violet-500 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            Czat
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('svl364')}
            className={`py-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'svl364'
                ? 'text-violet-300 border-violet-500 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            SVL-364
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('notifications')}
            className={`py-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 font-mono tabular-nums ${
              activeTab === 'notifications'
                ? 'text-cyan-300 border-cyan-400 font-semibold'
                : irisUnreadCount > 0
                  ? 'border-transparent text-cyan-300 hover:text-cyan-200'
                  : 'border-transparent hover:text-slate-100'
            }`}
          >
            Powiadomienia ({irisUnreadCount})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('infrastructure')}
            className={`py-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'infrastructure'
                ? 'text-emerald-300 border-emerald-400 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            Infrastruktura
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('agents')}
            className={`py-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 font-mono tabular-nums ${
              activeTab === 'agents'
                ? 'text-violet-300 border-violet-500 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            Agenci ({activeWorkersCount}/{CANONICAL_AGENTS.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('terminals')}
            className={`py-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'terminals'
                ? 'text-violet-300 border-violet-500 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            Terminale (4)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('kernel')}
            className={`py-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'kernel'
                ? 'text-violet-300 border-violet-500 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            Jądro SVL
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('linux')}
            className={`py-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'linux'
                ? 'text-violet-300 border-violet-500 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            Linux
          </button>
        </nav>

        {/* Operator authorization (memory only, never stored on disk) */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            aria-expanded={operatorAuthVisible}
            aria-label="Otwórz autoryzację operatora"
            onClick={() => setOperatorAuthVisible((visible) => !visible)}
            className={`px-2 py-1 rounded-md border text-[11px] ${operatorAuthStatus === 'authorized'
              ? 'border-emerald-700 text-emerald-300'
              : operatorAuthStatus === 'denied'
                ? 'border-rose-700 text-rose-300'
                : 'border-slate-700 text-slate-400'}`}
            title={operatorAuthStatus === 'authorized'
              ? 'Token operatora potwierdzony przez backend'
              : operatorAuthStatus === 'denied'
                ? 'Serwer odrzucił token operatora'
                : 'Wpisz prywatny SVL_OPERATOR_TOKEN'}
          >{operatorAuthStatus === 'authorized' ? '🔐 SVL' : '🔒 SVL'}</button>
          {operatorAuthVisible && (
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={operatorToken}
              aria-label="Prywatny SVL_OPERATOR_TOKEN"
              placeholder="SVL_OPERATOR_TOKEN"
              onChange={(event) => {
                const value = event.target.value;
                setOperatorToken(value);
                setSvlOperatorAccessToken(value);
              }}
              className="min-w-0 w-28 md:w-44 bg-[#0B0D13] border border-slate-700 rounded-md px-2 py-1 text-xs text-slate-200"
            />
          )}
          <span className="sr-only" role="status" aria-live="polite">
            {operatorAuthStatus === 'authorized' ? 'Token operatora zweryfikowany'
              : operatorAuthStatus === 'denied' ? 'Token operatora nieprawidłowy'
                : operatorAuthStatus === 'checking' ? 'Sprawdzanie tokenu operatora' : 'Brak autoryzacji operatora'}
          </span>
        </div>
        {/* Zone 3: 1 compact primary action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => void connectMyAi('operator_header_cta')}
            disabled={isConnectingAi}
            className="px-2.5 py-1 text-[11px] md:text-xs font-semibold text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            {isConnectingAi
              ? 'Łączenie...'
              : activeWorkersCount >= CANONICAL_AGENTS.length
                ? `Workery (${activeWorkersCount}/${CANONICAL_AGENTS.length})`
                : 'Podłącz AI'}
          </button>
        </div>
      </header>

      {/* Main Workspace Viewport */}
      <main className="flex-1 min-h-0 w-full overflow-hidden">
        {activeTab === 'chat' && <ChatWorkspace onNavigateTab={setActiveTab} />}
        {activeTab === 'svl364' && <Svl364CommandCenter onNavigate={setActiveTab} />}
        {activeTab === 'notifications' && <NotificationsWorkspace onNavigateTab={setActiveTab} />}
        {activeTab === 'infrastructure' && <InfrastructureWorkspace onNavigateTab={setActiveTab} />}
        {activeTab === 'agents' && (
          <AgentsPanel
            onNavigateToChat={() => setActiveTab('chat')}
          />
        )}
        {activeTab === 'terminals' && <TerminalsWorkspace />}
        {activeTab === 'kernel' && <KernelDiagnosticsView />}
        {activeTab === 'linux' && <LinuxDeployDashboard />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <SvlSyncProvider>
      <SVLWorkspaceShell />
    </SvlSyncProvider>
  );
}

