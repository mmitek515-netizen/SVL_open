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
import { SvlSyncProvider, useSvlSync } from './utils/svlSyncStore';

type ActiveWorkspaceTab = 'chat' | 'agents' | 'terminals' | 'kernel' | 'linux';

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
  const activeWorkersCount = agentsList.filter((a) => a.status === 'ONLINE_LOCAL_WORKER').length;

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#0B0D13] text-[#F1F5F9]">
      {/* Strict 3-Zone Top Bar Contract per Frontend Design Constitution */}
      <header className="flex items-center justify-between gap-3 md:gap-8 px-3 md:px-6 py-3 border-b border-slate-800/90 bg-[#111520] shrink-0">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('chat');
          }}
          className="text-base md:text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          SVL Python OS
        </a>

        {/* Zone 2: 5 concise single-line text navigation links */}
        <nav
          aria-label="Główna nawigacja systemu"
          className="flex items-center gap-4 md:gap-6 text-xs md:text-sm font-medium text-slate-400 overflow-x-auto"
        >
          <button
            type="button"
            onClick={() => setActiveTab('chat')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'chat'
                ? 'text-violet-300 border-violet-500 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            Czat Open WebUI
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('agents')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 font-mono tabular-nums ${
              activeTab === 'agents'
                ? 'text-violet-300 border-violet-500 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            Agenci ({activeWorkersCount}/4)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('terminals')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
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
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'kernel'
                ? 'text-violet-300 border-violet-500 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            Jądro SVL &amp; Sfera
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('linux')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'linux'
                ? 'text-violet-300 border-violet-500 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            Linux &amp; Wdrożenie
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => void connectMyAi('operator_header_cta')}
            disabled={isConnectingAi}
            className="min-h-[38px] px-4 py-2 text-xs font-semibold text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            {isConnectingAi
              ? 'Podłączanie AI...'
              : activeWorkersCount === 4
                ? 'Podłącz moje AI (4/4 Aktywne)'
                : 'Podłącz moje AI'}
          </button>
        </div>
      </header>

      {/* Main Workspace Viewport */}
      <main className="flex-1 min-h-0 w-full overflow-hidden">
        {activeTab === 'chat' && <ChatWorkspace onNavigateTab={setActiveTab} />}
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

