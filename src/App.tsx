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
import { SvlSyncProvider, useSvlSync } from './utils/svlSyncStore';
import { CANONICAL_AGENTS } from './utils/svlLogic';

type ActiveWorkspaceTab = 'chat' | 'svl364' | 'agents' | 'terminals' | 'kernel' | 'linux';

function SVLWorkspaceShell() {
  const [activeTab, setActiveTab] = useState<ActiveWorkspaceTab>('chat');
  const {
    agentsData,
    isConnectingAi,
    connectMyAi,
    refreshDomainModules,
  } = useSvlSync();

  useEffect(() => {
    if (activeTab === 'chat') {
      void refreshDomainModules(['chat', 'agents', 'health', 'workspace']);
    } else if (activeTab === 'svl364') {
      void refreshDomainModules(['modules', 'kernel', 'agents', 'health', 'chat', 'terminals']);
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
            Terminale (5)
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
                ? `AI (${activeWorkersCount}/${CANONICAL_AGENTS.length} Aktywne)`
                : 'Podłącz AI'}
          </button>
        </div>
      </header>

      {/* Main Workspace Viewport */}
      <main className="flex-1 min-h-0 w-full overflow-hidden">
        {activeTab === 'chat' && <ChatWorkspace onNavigateTab={setActiveTab} />}
        {activeTab === 'svl364' && <Svl364CommandCenter onNavigate={setActiveTab} />}
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

