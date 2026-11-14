/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ChatWorkspace } from './components/ChatWorkspace';
import { AgentsPanel } from './components/AgentsPanel';
import { TerminalsWorkspace } from './components/TerminalsWorkspace';
import { KernelDiagnosticsView } from './components/KernelDiagnosticsView';
import { LinuxDeployDashboard } from './components/LinuxDeployDashboard';

type ActiveWorkspaceTab = 'chat' | 'agents' | 'terminals' | 'kernel' | 'linux';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveWorkspaceTab>('chat');
  const [chatTargetAgent, setChatTargetAgent] = useState<'Auto' | 'Aria' | 'Alex' | 'Astyria' | 'Aurelius'>('Auto');
  const [healthData, setHealthData] = useState<any>(null);
  const [kernelData, setKernelData] = useState<any>(null);
  const [agentsData, setAgentsData] = useState<any>(null);
  const [isConnectingAi, setIsConnectingAi] = useState(false);

  const fetchAllSystemState = useCallback(async () => {
    try {
      const [hResp, kResp, aResp] = await Promise.all([
        fetch('/api/py/health'),
        fetch('/api/py/kernel/report'),
        fetch('/api/py/agents/status'),
      ]);
      if (hResp.ok) setHealthData(await hResp.json());
      if (kResp.ok) setKernelData(await kResp.json());
      if (aResp.ok) setAgentsData(await aResp.json());
    } catch {
      // retry silently on next poll
    }
  }, []);

  useEffect(() => {
    fetchAllSystemState();
    const timer = setInterval(fetchAllSystemState, 6000);
    return () => clearInterval(timer);
  }, [fetchAllSystemState]);

  const handleConnectMyAi = useCallback(async () => {
    setIsConnectingAi(true);
    try {
      const resp = await fetch('/api/py/agents/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triggered_by: 'operator_header_cta' }),
      });
      const data = await resp.json();
      await fetchAllSystemState();
      return data;
    } finally {
      setIsConnectingAi(false);
    }
  }, [fetchAllSystemState]);

  const agentsList: any[] = agentsData?.agents || [];
  const activeWorkersCount = agentsList.filter((a) => a.status === 'ONLINE_LOCAL_WORKER').length;
  const operatorToken = healthData?.security?.demo_operator_token_for_local_testing || '';

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
            onClick={handleConnectMyAi}
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
        {activeTab === 'chat' && (
          <ChatWorkspace
            agentsStatus={agentsList}
            healthData={healthData}
            onExecuteConnectMyAi={handleConnectMyAi}
            isConnectingAi={isConnectingAi}
            onNavigateTab={setActiveTab}
            onRefreshSystem={fetchAllSystemState}
            targetAgent={chatTargetAgent}
            onChangeTargetAgent={setChatTargetAgent}
          />
        )}
        {activeTab === 'agents' && (
          <AgentsPanel
            agentsData={agentsData}
            healthData={healthData}
            onConnectMyAi={handleConnectMyAi}
            isConnecting={isConnectingAi}
            onRefresh={fetchAllSystemState}
            onChatWithAgent={(agent) => {
              setChatTargetAgent(agent);
              setActiveTab('chat');
            }}
          />
        )}
        {activeTab === 'terminals' && (
          <TerminalsWorkspace
            operatorToken={operatorToken}
            onRefreshSystem={fetchAllSystemState}
          />
        )}
        {activeTab === 'kernel' && (
          <KernelDiagnosticsView
            kernelData={kernelData}
            agentsData={agentsData}
            operatorToken={operatorToken}
            onRefresh={fetchAllSystemState}
          />
        )}
        {activeTab === 'linux' && (
          <LinuxDeployDashboard
            healthData={healthData}
            agentsData={agentsData}
            onRefresh={fetchAllSystemState}
          />
        )}
      </main>
    </div>
  );
}
