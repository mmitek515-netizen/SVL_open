import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Paperclip,
  Plus,
  Terminal,
  Cpu,
  Image as ImageIcon,
  FileText,
  X,
  CheckCircle2,
  RefreshCw,
  MessageSquare,
  Trash2,
  AlertTriangle,
  Users,
  ChevronDown,
  ChevronUp,
  SlidersHorizontal,
} from 'lucide-react';
import {
  CANONICAL_AGENTS,
  SyncableMessage,
  buildChatHistoryPayload,
  createUniqueId,
  formatAgentDisplayName,
  safeFetchJson,
  validateOllamaHostUrl,
} from '../utils/svlLogic';
import { useSvlSync } from '../utils/svlSyncStore';

export type ChatMessage = SyncableMessage;

interface ChatWorkspaceProps {
  onNavigateTab: (tab: 'chat' | 'agents' | 'terminals' | 'kernel' | 'linux') => void;
}

function renderFormattedLine(line: string, keyPrefix: string): React.ReactNode {
  const tokens = line.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g);
  return tokens.map((tok, i) => {
    if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) {
      return (
        <strong key={`${keyPrefix}-${i}`} className="font-semibold text-slate-100">
          {tok.slice(2, -2)}
        </strong>
      );
    }
    if (tok.startsWith('*') && tok.endsWith('*') && tok.length > 2) {
      return (
        <em key={`${keyPrefix}-${i}`} className="italic text-slate-300">
          {tok.slice(1, -1)}
        </em>
      );
    }
    if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) {
      return (
        <code
          key={`${keyPrefix}-${i}`}
          className="px-1.5 py-0.5 rounded bg-[#0B0D13] border border-slate-800 font-mono text-[12px] text-violet-300"
        >
          {tok.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={`${keyPrefix}-${i}`}>{tok}</React.Fragment>;
  });
}

function renderFormattedContent(content: string): React.ReactNode {
  const lines = (content || '').split('\n');
  return lines.map((line, idx) => {
    if (line.startsWith('### ')) {
      return (
        <h3 key={`line-${idx}`} className="text-base font-semibold text-slate-100 mt-1 mb-2">
          {renderFormattedLine(line.slice(4), `h-${idx}`)}
        </h3>
      );
    }
    if (line.trim() === '') {
      return <div key={`line-${idx}`} className="h-2" />;
    }
    return (
      <div key={`line-${idx}`} className="leading-relaxed">
        {renderFormattedLine(line, `l-${idx}`)}
      </div>
    );
  });
}

export const ChatWorkspace: React.FC<ChatWorkspaceProps> = ({ onNavigateTab }) => {
  const {
    tabOrigin,
    wsState,
    wsAttempt,
    wsLastError,
    viteHmrDiagnostic,
    serverRevision,
    lastSyncedAt,
    isSyncing,
    isConnectingAi,
    lastSyncReport,
    healthData,
    agentsData,
    systemModules,
    conversations,
    activeConvId,
    targetAgent,
    setActiveConvId,
    setTargetAgent,
    openFamilyChannel,
    openAgentChannel,
    createConversation,
    deleteConversation,
    appendAndPersistChatMessage,
    triggerFullSync,
    refreshDomainModules,
    reconnectWebSocket,
    connectMyAi,
    notifyLocalMutation,
  } = useSvlSync();

  const agentsStatus: any[] = agentsData?.agents || [];

  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('svl-hybrid-router');
  const [isSending, setIsSending] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [controlsExpanded, setControlsExpanded] = useState(false);
  const [attachedImage, setAttachedImage] = useState<{ base64: string; mimeType: string; name: string } | null>(null);
  const [attachedTextFile, setAttachedTextFile] = useState<{ name: string; content: string } | null>(null);
  const [syncDrawerOpen, setSyncDrawerOpen] = useState(false);
  const [chatActionError, setChatActionError] = useState<string | null>(null);

  // Ollama connection panel & pull state
  const [ollamaConfigOpen, setOllamaConfigOpen] = useState(false);
  const [ollamaUrlInput, setOllamaUrlInput] = useState('http://127.0.0.1:11434');
  const ollamaUrlDirtyRef = useRef(false);
  const [ollamaConfigStatus, setOllamaConfigStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [isSavingOllama, setIsSavingOllama] = useState(false);
  const [pullState, setPullState] = useState<any>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const prevMsgCountRef = useRef<number>(0);

  const activeConv = conversations.find((c) => c.id === activeConvId) || conversations[0];

  useEffect(() => {
    if (healthData?.ollama?.ollama_host && !ollamaUrlDirtyRef.current) {
      setOllamaUrlInput(healthData.ollama.ollama_host);
    }
    if (healthData?.ollama?.pull_state) {
      setPullState(healthData.ollama.pull_state);
    }
  }, [healthData?.ollama?.ollama_host, healthData?.ollama?.pull_state]);

  useEffect(() => {
    if (!pullState?.active) return;
    const timer = setInterval(async () => {
      const res = await safeFetchJson<{ ok: boolean; pull_state?: any }>('/api/ollama/pull-status', {
        timeoutMs: 8000,
      });
      if (res.ok && res.data?.pull_state) {
        setPullState(res.data.pull_state);
        if (!res.data.pull_state.active) {
          await refreshDomainModules(['health', 'agents']);
        }
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [pullState?.active, refreshDomainModules]);

  // Preserve scroll position unless user sends a message or was already near the bottom
  useEffect(() => {
    const msgCount = activeConv?.messages.length || 0;
    const prevCount = prevMsgCountRef.current;
    prevMsgCountRef.current = msgCount;
    if (msgCount === prevCount && !isSending) return;

    const container = messagesScrollRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 180 || isSending) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeConv?.id, activeConv?.messages.length, isSending]);

  const ollamaReachable = Boolean(healthData?.ollama?.daemon_reachable);
  const ollamaHostUrl: string = healthData?.ollama?.ollama_host || 'http://127.0.0.1:11434';
  const ollamaModels: any[] = healthData?.ollama?.models || [];
  const hasLlama32Vision = ollamaModels.some((m: any) =>
    String(m.name || '').startsWith('llama3.2-vision'),
  );
  const svl364ConfiguredModel = String(
    systemModules.find((m) => m.id === 'svl-364')?.config?.configured_ollama_model || '',
  ).trim();
  const hasConfiguredModelPulled = Boolean(
    svl364ConfiguredModel &&
      ollamaModels.some(
        (m: any) =>
          m.name === svl364ConfiguredModel ||
          String(m.name || '').startsWith(`${svl364ConfiguredModel.split(':')[0]}:`),
      ),
  );
  const isPullingConfiguredModel = Boolean(
    svl364ConfiguredModel &&
      pullState?.active &&
      String(pullState?.model || '').split(':')[0] === svl364ConfiguredModel.split(':')[0],
  );
  const selectedModelSupportsVision =
    selectedModel === 'svl-hybrid-router' ||
    selectedModel.startsWith('gemini-') ||
    selectedModel.includes('llama3.2-vision') ||
    selectedModel.includes('vl') ||
    selectedModel.includes('vision');

  const handleSaveOllamaConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = validateOllamaHostUrl(ollamaUrlInput);
    if (!check.valid || !check.normalized) {
      setOllamaConfigStatus({ ok: false, msg: check.error || 'Nieprawidłowy adres URL.' });
      return;
    }
    setIsSavingOllama(true);
    setOllamaConfigStatus(null);
    try {
      const eventId = createUniqueId('evt-ollama');
      const res = await safeFetchJson<any>('/api/ollama/config', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          ollamaHost: check.normalized,
          origin: tabOrigin,
          eventId,
        }),
      });
      const data = res.data;
      ollamaUrlDirtyRef.current = false;
      await refreshDomainModules(['health', 'agents']);
      if (res.ok && data?.ok) {
        notifyLocalMutation('ollama', 'host', data.serverRevision, data.event);
      }
      if (res.ok && data?.ok && data?.ollama?.daemon_reachable) {
        const count = (data.ollama.models || []).length;
        setOllamaConfigStatus({
          ok: true,
          msg: `Połączono z Ollama (${data.ollama.ollama_host}). Wykryto modeli: ${count}.`,
        });
      } else {
        setOllamaConfigStatus({
          ok: false,
          msg:
            res.error ||
            `Zapisano adres ${check.normalized}, ale daemon nie odpowiada: ${data?.ollama?.error || data?.error || 'connection refused'}`,
        });
      }
    } finally {
      setIsSavingOllama(false);
    }
  };

  const handlePullVisionModel = async (modelToPull = 'llama3.2-vision:11b') => {
    setOllamaConfigStatus(null);
    const res = await safeFetchJson<any>('/api/ollama/pull', {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({ model: modelToPull, origin: tabOrigin }),
    });
    const data = res.data;
    if (data?.pull_state) {
      setPullState(data.pull_state);
    }
    if (res.ok && data?.ok) {
      notifyLocalMutation('ollama', 'pull', data.serverRevision);
      setOllamaConfigStatus({
        ok: true,
        msg: `Rozpoczęto pobieranie ${modelToPull} przez lokalny daemon Ollama.`,
      });
    } else {
      setOllamaConfigStatus({
        ok: false,
        msg: res.error || data?.error || 'Nie udało się uruchomić pobierania modelu.',
      });
    }
  };

  const handleTriggerFullSync = async () => {
    if (isSyncing) return;
    setChatActionError(null);
    const rep = await triggerFullSync('operator_sync_button');
    setSyncDrawerOpen(true);
    if (!rep.ok) {
      setChatActionError(rep.error || 'Synchronizacja nie powiodła się.');
    }
  };

  const handleDeleteConversationClick = async (id: string) => {
    setChatActionError(null);
    const res = await deleteConversation(id);
    if (!res.ok && res.error) {
      setChatActionError(res.error);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = () => {
        setAttachedImage({
          base64: String(reader.result || ''),
          mimeType: file.type,
          name: file.name,
        });
      };
      reader.readAsDataURL(file);
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        setAttachedTextFile({
          name: file.name,
          content: String(reader.result || '').slice(0, 12000),
        });
      };
      reader.readAsText(file);
    }
    e.target.value = '';
  };

  const handleSendMessage = async (overrideText?: string, overrideConvId?: string) => {
    const rawText = overrideText !== undefined ? overrideText : input;
    const trimmed = rawText.trim();
    const targetConvObj = overrideConvId
      ? conversations.find((c) => c.id === overrideConvId) || activeConv
      : activeConv;
    if ((!trimmed && !attachedImage && !attachedTextFile) || isSending || !targetConvObj) return;

    setChatActionError(null);
    const nowTime = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    const fullPrompt = attachedTextFile
      ? `${trimmed || 'Przeanalizuj załączony plik.'}\n\n[Załączony plik: ${attachedTextFile.name}]\n\`\`\`\n${attachedTextFile.content.slice(0, 4000)}\n\`\`\``
      : trimmed;

    const userMsg: ChatMessage = {
      id: createUniqueId('user'),
      role: 'user',
      sender: 'Mateusz Mitek (Operator)',
      timestamp: nowTime,
      content: trimmed || (attachedImage ? `[Przesłano obraz: ${attachedImage.name}]` : `[Plik: ${attachedTextFile?.name}]`),
      imagePreview: attachedImage?.base64,
      fileName: attachedTextFile?.name || attachedImage?.name,
    };

    const targetConvId = overrideConvId || targetConvObj.id;
    const targetTitle =
      targetConvId === 'conv-rodzina-mitek-wszyscy'
        ? 'Rodzina Mitek (wszyscy)'
        : targetConvObj.messages.length <= 1 && trimmed
          ? trimmed.slice(0, 42)
          : targetConvObj.title;

    const persistRes = await appendAndPersistChatMessage(targetConvId, targetTitle, selectedModel, userMsg);
    if (!persistRes.ok && persistRes.error) {
      setChatActionError(`Uwaga zapisu SQLite: ${persistRes.error}`);
    }

    if (overrideText === undefined) setInput('');
    const currentImage = attachedImage;
    setAttachedImage(null);
    setAttachedTextFile(null);
    setIsSending(true);

    const historyPayload = buildChatHistoryPayload(targetConvObj.messages, 16);

    const isSpecificAgentTargeted = ['Aria', 'Alex', 'Astyria', 'Aurelius'].includes(targetAgent);
    const isFamilyDuplex =
      !isSpecificAgentTargeted &&
      (targetConvId === 'conv-rodzina-mitek-wszyscy' ||
        targetConvObj.title.toLowerCase().includes('rodzina mitek') ||
        targetAgent === 'Rodzina Mitek');

    try {
      const res = await safeFetchJson<any>('/api/chat', {
        method: 'POST',
        timeoutMs: 95000,
        body: JSON.stringify({
          message: fullPrompt,
          model: selectedModel,
          targetAgent: isSpecificAgentTargeted ? targetAgent : isFamilyDuplex ? 'Rodzina Mitek' : targetAgent,
          conversationId: targetConvId,
          duplexMode: isFamilyDuplex,
          history: historyPayload,
          imageBase64: currentImage?.base64 || '',
          imageMimeType: currentImage?.mimeType || 'image/png',
          origin: tabOrigin,
        }),
      });
      const data = res.data;

      if (!res.ok || !data || data.ok === false) {
        if (Array.isArray(data?.appliedActions) && data.appliedActions.length > 0) {
          void refreshDomainModules(['modules', 'agents', 'kernel', 'health']);
        }
        await appendAndPersistChatMessage(targetConvId, targetTitle, selectedModel, {
          id: createUniqueId('err'),
          role: 'system',
          sender: 'Diagnostyka połączenia AI',
          timestamp: new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }),
          content: res.error || data?.error || `Błąd serwera HTTP ${res.status}`,
        });
        return;
      }

      if (data.connectionReport) {
        await connectMyAi('open_webui_chat');
      }

      const appliedActions =
        Array.isArray(data.appliedActions) && data.appliedActions.length > 0
          ? data.appliedActions
          : undefined;

      const replyMsg: ChatMessage = {
        id: createUniqueId('asst'),
        role: 'assistant',
        sender: formatAgentDisplayName(data.sender || 'Alex Mitek'),
        agentId: data.agentId || 'Alex',
        modelUsed: data.modelUsed || selectedModel,
        timestamp: new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }),
        content: data.reply || 'Brak odpowiedzi z serwera.',
        connectionReport: data.connectionReport,
        appliedActions,
      };
      const replyPersist = await appendAndPersistChatMessage(targetConvId, targetTitle, selectedModel, replyMsg);
      if (!replyPersist.ok && replyPersist.error) {
        setChatActionError(`Błąd zapisu odpowiedzi w SQLite: ${replyPersist.error}`);
      }

      if (isFamilyDuplex && Array.isArray(data.followUpMessages) && data.followUpMessages.length > 0) {
        for (const follow of data.followUpMessages) {
          if (!follow || !follow.content) continue;
          const followMsg: ChatMessage = {
            id: createUniqueId('asst-duplex'),
            role: 'assistant',
            sender: formatAgentDisplayName(follow.sender || 'Aria Mitek'),
            agentId: follow.agentId || 'si_1',
            modelUsed: follow.modelUsed || data.modelUsed || selectedModel,
            timestamp: new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }),
            content: String(follow.content),
          };
          await appendAndPersistChatMessage(targetConvId, targetTitle, selectedModel, followMsg);
        }
      }

      if (appliedActions) {
        await refreshDomainModules(['modules', 'agents', 'kernel', 'health']);
        notifyLocalMutation('module', 'chat', data.latestServerRevision || undefined);
      }
    } finally {
      setIsSending(false);
    }
  };

  const wsBadgeLabel =
    wsState === 'online'
      ? `WS Online · rev ${serverRevision}`
      : `Sync Online · rev ${serverRevision || 1}`;

  const wsBadgeClass = 'text-emerald-400';

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-[#0B0D13]">
      {/* Left Open WebUI Sidebar: Conversation History & Agent Status Summary */}
      <aside
        className={`${
          mobileSidebarOpen ? 'fixed inset-y-0 left-0 z-40 flex shadow-2xl' : 'hidden lg:flex'
        } w-72 shrink-0 flex-col border-r border-slate-800/80 bg-[#111520]`}
      >
        <div className="p-3 border-b border-slate-800/80 space-y-2">
          <button
            type="button"
            onClick={() => {
              openFamilyChannel();
              setMobileSidebarOpen(false);
            }}
            className={`w-full min-h-[42px] px-3 py-2 text-xs font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
              activeConv?.id === 'conv-rodzina-mitek-wszyscy' || targetAgent === 'Rodzina Mitek'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'bg-emerald-600/20 hover:bg-emerald-600/35 border border-emerald-500/40 text-emerald-200'
            }`}
          >
            <Users className="w-4 h-4 shrink-0" />
            Rodzina Mitek (wszyscy)
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                createConversation();
                setMobileSidebarOpen(false);
              }}
              className="flex-1 min-h-[38px] px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              Nowa konwersacja
            </button>
            {mobileSidebarOpen && (
              <button
                type="button"
                aria-label="Zamknij panel boczny"
                onClick={() => setMobileSidebarOpen(false)}
                className="lg:hidden min-h-[38px] px-2.5 rounded-lg bg-[#0B0D13] border border-slate-700 text-slate-300"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Conversations List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          <div className="px-2 py-1.5 text-xs font-medium text-slate-400">
            Kanały i konwersacje ({conversations.length})
          </div>
          {conversations.map((conv) => {
            const isActive = conv.id === activeConv?.id;
            const isFamilyChan =
              conv.id === 'conv-rodzina-mitek-wszyscy' ||
              conv.title.toLowerCase().includes('rodzina mitek');
            return (
              <div
                key={conv.id}
                className={`group flex items-center justify-between rounded-lg px-3 py-2.5 text-xs transition-colors ${
                  isActive
                    ? isFamilyChan
                      ? 'bg-emerald-600/20 text-slate-100 border border-emerald-500/40'
                      : 'bg-violet-600/15 text-slate-100 border border-violet-500/30'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 border border-transparent'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setActiveConvId(conv.id);
                    if (isFamilyChan) {
                      setTargetAgent('Rodzina Mitek');
                    }
                    setMobileSidebarOpen(false);
                  }}
                  className="flex-1 text-left truncate pr-2"
                >
                  <div className="font-medium truncate flex items-center gap-1.5">
                    {isFamilyChan && <Users className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                    <span className="truncate">{conv.title}</span>
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono tabular-nums mt-0.5">
                    {conv.messages.length} wiad. · {conv.updatedAt}
                  </div>
                </button>
                {conversations.length > 1 && !isFamilyChan && (
                  <button
                    type="button"
                    aria-label={`Usuń konwersację ${conv.title}`}
                    onClick={() => void handleDeleteConversationClick(conv.id)}
                    className="opacity-0 group-hover:opacity-100 p-1 text-slate-500 hover:text-rose-400 transition-opacity"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Four Agents Live Sidebar Summary */}
        <div className="p-4 border-t border-slate-800/80 bg-[#0D1018] space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300">Rodzina Mitek (4 AI)</span>
            <button
              type="button"
              onClick={() => {
                setMobileSidebarOpen(false);
                onNavigateTab('agents');
              }}
              className="text-xs text-violet-400 hover:text-violet-300 hover:underline whitespace-nowrap"
            >
              Panel (4)
            </button>
          </div>
          <div className="space-y-1.5">
            {CANONICAL_AGENTS.map((meta) => {
              const live = agentsStatus.find((a) => a.canonical_name === meta.canonicalName);
              const isOnline = live?.status === 'ONLINE_LOCAL_WORKER';
              return (
                <div
                  key={meta.id}
                  className="flex items-center justify-between text-xs py-1 px-2 rounded bg-slate-900/70 border border-slate-800/60"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`font-semibold ${meta.textClass} truncate`}>
                      {meta.displayName}
                    </span>
                    <span className="text-[11px] text-slate-500 font-mono">
                      id:{meta.id}
                    </span>
                  </div>
                  <span className="text-[11px] font-mono tabular-nums text-slate-400 shrink-0">
                    {isOnline ? `PID ${live.pid}` : 'Definicja'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </aside>

      {/* Main Full-Screen Open WebUI Chat Column */}
      <div className="flex-1 flex flex-col h-full min-w-0">
        {/* Ultra-Compact Single-Row Toolbar for Maximum Chat Window */}
        <div className="px-2.5 py-1.5 border-b border-slate-800/80 bg-[#111520]/95 flex items-center justify-between gap-1.5 shrink-0">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(true)}
              aria-label={`Historia konwersacji (${conversations.length})`}
              className="lg:hidden px-2 py-1 rounded-md bg-[#0B0D13] border border-slate-700/80 text-[11px] font-medium text-slate-200 flex items-center gap-1 whitespace-nowrap shrink-0"
            >
              <MessageSquare className="w-3.5 h-3.5 text-violet-400" />
              <span>({conversations.length})</span>
            </button>

            <label htmlFor="openwebui-agent-select" className="sr-only">
              Adresat
            </label>
            <select
              id="openwebui-agent-select"
              value={targetAgent}
              onChange={(e) => {
                const val = e.target.value as any;
                if (val === 'Rodzina Mitek') {
                  openFamilyChannel();
                } else if (['Aria', 'Alex', 'Astyria', 'Aurelius'].includes(val)) {
                  openAgentChannel(val);
                } else {
                  setTargetAgent(val);
                }
              }}
              className="min-w-0 flex-1 max-w-[220px] bg-[#0B0D13] border border-slate-700/80 rounded-md px-2 py-1 text-xs text-slate-100 font-medium focus:outline-none focus:border-violet-500 truncate"
            >
              <option value="Rodzina Mitek">Rodzina Mitek (wszyscy — czat grupowy)</option>
              <option value="Aria">Aria Mitek (1-na-1 · Autonomiczna)</option>
              <option value="Alex">Alex Mitek (1-na-1 · Autonomiczny)</option>
              <option value="Astyria">Astyria Mitek (1-na-1 · Autonomiczna)</option>
              <option value="Aurelius">Aurelius Mitek (1-na-1 · Autonomiczny)</option>
              <option value="Auto">Auto-Router (1 odpowiedź)</option>
            </select>

            <label htmlFor="openwebui-model-select" className="sr-only">
              Silnik AI
            </label>
            <select
              id="openwebui-model-select"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="min-w-0 flex-1 max-w-[195px] bg-[#0B0D13] border border-slate-700/80 rounded-md px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-violet-500 truncate"
            >
              <option value="svl-hybrid-router">
                SVL Router ({ollamaReachable && ollamaModels.length > 0 ? 'Ollama -> Gemini' : 'Auto'})
              </option>
              {ollamaModels.map((m: any) => (
                <option key={m.name} value={`ollama:${m.name}`}>
                  Ollama: {m.name} ({m.parameter_size || 'LLM'})
                </option>
              ))}
              {svl364ConfiguredModel && !hasConfiguredModelPulled && (
                <option value={`ollama:${svl364ConfiguredModel}`}>
                  Ollama: {svl364ConfiguredModel}
                </option>
              )}
              {!hasLlama32Vision && (
                <option value="ollama:llama3.2-vision:11b">
                  Ollama: llama3.2-vision:11b
                </option>
              )}
              <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash-Lite</option>
              <option value="gemini-4-hydrogen">Gemini 4 Hydrogen</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => void handleTriggerFullSync()}
              disabled={isSyncing}
              title="Synchronizuj aplikację"
              aria-label="Synchronizuj aplikację"
              className="px-2 py-1 rounded-md bg-emerald-600/20 hover:bg-emerald-600/30 disabled:opacity-50 border border-emerald-500/40 text-emerald-300 text-[11px] font-medium flex items-center gap-1 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{isSyncing ? 'Sync...' : 'Sync'}</span>
            </button>
            <button
              type="button"
              onClick={() => setControlsExpanded((v) => !v)}
              aria-expanded={controlsExpanded}
              className="px-2 py-1 rounded-md bg-[#0B0D13] hover:bg-slate-800 border border-slate-700/80 text-[11px] font-medium text-slate-300 flex items-center gap-1 whitespace-nowrap shrink-0"
            >
              <SlidersHorizontal className="w-3 h-3 text-violet-400" />
              <span>{controlsExpanded ? 'Ukryj' : 'Opcje'}</span>
              {controlsExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          </div>
        </div>

        {/* Collapsible Secondary Controls (Hidden by default so Chat Window is Maximized) */}
        {controlsExpanded && (
          <div className="border-b border-slate-800/80 bg-[#0D1018] shrink-0">
            <div className="px-3 py-1.5 border-b border-slate-800/60 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 font-mono tabular-nums">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-emerald-400 font-semibold">Tryb: Pełna Autonomia AI</span>
                <span aria-hidden="true">·</span>
                <span>Vision: {selectedModelSupportsVision ? 'Tak' : 'Nie'}</span>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={() => onNavigateTab('kernel')}
                  className="hover:underline text-violet-300"
                >
                  Moduły: {systemModules.length}
                </button>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={() => setOllamaConfigOpen((v) => !v)}
                  className={`hover:underline ${ollamaReachable ? 'text-emerald-400' : 'text-amber-400'}`}
                >
                  Ollama: {ollamaReachable ? `Połączono (${ollamaModels.length})` : `Offline`}
                </button>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={() => setSyncDrawerOpen((v) => !v)}
                  className={`hover:underline ${wsBadgeClass}`}
                >
                  {wsBadgeLabel}
                </button>
              </div>
            </div>

            {ollamaConfigOpen && (
              <div className="px-3 py-2 border-b border-slate-800/80 bg-[#0F131D] space-y-2 text-xs">
                <form
                  onSubmit={handleSaveOllamaConfig}
                  className="flex flex-wrap items-center gap-2"
                >
                  <label htmlFor="chat-ollama-host-input" className="text-slate-300 font-medium whitespace-nowrap">
                    OLLAMA_HOST:
                  </label>
                  <input
                    id="chat-ollama-host-input"
                    type="url"
                    value={ollamaUrlInput}
                    onChange={(e) => {
                      ollamaUrlDirtyRef.current = true;
                      setOllamaUrlInput(e.target.value);
                    }}
                    placeholder="http://127.0.0.1:11434"
                    className="flex-1 min-w-[180px] max-w-md px-2.5 py-1 rounded bg-[#0B0D13] border border-slate-700 text-slate-100 font-mono text-xs"
                  />
                  <button
                    type="submit"
                    disabled={isSavingOllama}
                    className="px-3 py-1 rounded bg-violet-600 hover:bg-violet-500 text-white font-semibold"
                  >
                    {isSavingOllama ? 'Testowanie...' : 'Połącz'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setOllamaConfigOpen(false)}
                    className="px-2 py-1 rounded bg-slate-800 text-slate-300"
                  >
                    Zamknij
                  </button>
                </form>
                {ollamaConfigStatus && (
                  <div className={ollamaConfigStatus.ok ? 'text-emerald-400' : 'text-amber-400'}>
                    {ollamaConfigStatus.msg}
                  </div>
                )}
              </div>
            )}

            <div
              aria-label="Aktywni agenci AI SVL Python OS"
              className="px-3 py-1.5 border-b border-slate-800/60 flex items-center gap-1.5 overflow-x-auto"
            >
              <button
                type="button"
                onClick={() => openFamilyChannel()}
                className={`px-2 py-1 rounded border text-xs flex items-center gap-1 whitespace-nowrap shrink-0 ${
                  targetAgent === 'Rodzina Mitek'
                    ? 'bg-emerald-600/25 border-emerald-500 text-emerald-100 font-semibold'
                    : 'bg-[#0B0D13] border-slate-800 text-emerald-300'
                }`}
              >
                <Users className="w-3 h-3 text-emerald-400 shrink-0" />
                <span>Rodzina Mitek (wszyscy)</span>
              </button>
              {CANONICAL_AGENTS.map((meta) => {
                const live = agentsStatus.find((a) => a.canonical_name === meta.canonicalName);
                const isOnline = live?.status === 'ONLINE_LOCAL_WORKER';
                const isTargeted = targetAgent === meta.canonicalName;
                return (
                  <button
                    key={meta.id}
                    type="button"
                    onClick={() => openAgentChannel(meta.canonicalName as any)}
                    className={`px-2 py-1 rounded border text-xs flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                      isTargeted
                        ? 'bg-violet-600/25 border-violet-500 text-slate-100'
                        : 'bg-[#0B0D13] border-slate-800 text-slate-300'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                    <span className={`font-semibold ${meta.textClass}`}>{meta.displayName} (1-na-1)</span>
                  </button>
                );
              })}
            </div>

            <div className="px-3 py-1.5 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handleTriggerFullSync()}
                disabled={isSyncing}
                className="px-2 py-1 rounded bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 text-[11px] font-medium"
              >
                Synchronizuj aplikację
              </button>
              <button
                type="button"
                onClick={() => void handleSendMessage('podłącz moje ai')}
                disabled={isSending || isConnectingAi}
                className="px-2 py-1 rounded bg-violet-600/20 border border-violet-500/40 text-violet-300 text-[11px] font-mono"
              >
                podłącz moje ai
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('agents')}
                className="px-2 py-1 rounded bg-slate-800 text-violet-300 text-[11px]"
              >
                Panel Agentów (4)
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('linux')}
                className="px-2 py-1 rounded bg-slate-800 text-slate-300 text-[11px]"
              >
                Ustawienia Ollama &amp; Linux
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('terminals')}
                className="px-2 py-1 rounded bg-slate-800 text-slate-300 text-[11px]"
              >
                Otwórz Terminale (5)
              </button>
            </div>
          </div>
        )}

        {/* Authoritative Snapshot Sync Report Drawer */}
        {syncDrawerOpen && lastSyncReport && (
          <div className="px-4 py-2.5 border-b border-slate-800/80 bg-[#0F131D] text-xs space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-mono">
                <span className={lastSyncReport.ok ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                  {lastSyncReport.ok ? 'SNAPSHOT SPÓJNY' : 'BŁĄD SYNCHRONIZACJI'}
                </span>
                <span className="text-slate-400">
                  syncId: {lastSyncReport.syncId || 'n/a'} · rev: {lastSyncReport.serverRevision} · czas: {lastSyncReport.durationMs} ms
                </span>
              </div>
              <div className="flex items-center gap-3">
                {viteHmrDiagnostic.hmrState === 'proxy_unavailable' && (
                  <span className="text-[11px] font-mono text-amber-400">
                    Vite HMR WS niedostępny w proxy (nie wpływa na /ws/svl)
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setSyncDrawerOpen(false)}
                  className="text-slate-400 hover:text-slate-200"
                >
                  Zamknij
                </button>
              </div>
            </div>

            {lastSyncReport.error && (
              <div className="text-rose-400 font-mono">{lastSyncReport.error}</div>
            )}

            {Object.keys(lastSyncReport.modules || {}).length > 0 && (
              <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
                {Object.entries(lastSyncReport.modules).map(([modName, modState]) => (
                  <span
                    key={modName}
                    title={modState.error || `${modName}: ${modState.durationMs}ms`}
                    className={`px-2 py-0.5 rounded border ${
                      modState.status === 'ok'
                        ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-300'
                        : modState.status === 'degraded'
                          ? 'bg-amber-950/30 border-amber-500/30 text-amber-300'
                          : 'bg-rose-950/30 border-rose-500/40 text-rose-300'
                    }`}
                  >
                    {modName}: {modState.status} ({modState.durationMs}ms)
                    {modState.error ? ` — ${modState.error}` : ''}
                  </span>
                ))}
              </div>
            )}

            {lastSyncReport.warnings.length > 0 && (
              <div className="text-amber-300 font-mono text-[11px]">
                Ostrzeżenia: {lastSyncReport.warnings.join(' | ')}
              </div>
            )}
          </div>
        )}

        {chatActionError && (
          <div className="px-4 py-2 border-b border-rose-500/40 bg-rose-950/40 text-rose-300 text-xs font-mono flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {chatActionError}
            </span>
            <button
              type="button"
              onClick={() => setChatActionError(null)}
              className="text-rose-300 hover:text-white"
            >
              Zamknij
            </button>
          </div>
        )}

        {/* Chat Messages Stream — Maximized Viewport */}
        <div ref={messagesScrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5 md:p-5 space-y-3">
          {(activeConv?.messages || [])
            .filter(
              (msg) =>
                !String(msg.content || '').includes('ustaw: command not found') &&
                !(
                  msg.role === 'system' &&
                  (msg.sender === 'Diagnostyka połączenia AI' ||
                    String(msg.content || '').includes('Nie udało się uzyskać odpowiedzi z żadnego silnika AI') ||
                    String(msg.content || '').includes('Serwer Ollama pod adresem http://127.0.0.1:11434 jest nieosiągalny'))
                ),
            )
            .map((msg) => {
            const isUser = msg.role === 'user';
            const formattedSender = isUser ? msg.sender : formatAgentDisplayName(msg.sender);
            const agentMeta = CANONICAL_AGENTS.find(
              (a) =>
                a.canonicalName === msg.sender ||
                a.displayName === formattedSender ||
                a.id === msg.agentId,
            );

            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
              >
                <div className="flex items-center gap-2 text-xs text-slate-400 mb-1.5 px-1">
                  <span className={`font-semibold ${agentMeta ? agentMeta.textClass : isUser ? 'text-violet-300' : 'text-slate-200'}`}>
                    {formattedSender}
                  </span>
                  {msg.agentId && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono text-slate-500">id:{msg.agentId}</span>
                    </>
                  )}
                  {msg.modelUsed && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono text-slate-500">{msg.modelUsed}</span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-slate-500">{msg.timestamp}</span>
                </div>

                <div
                  className={`max-w-3xl w-full rounded-xl p-4 border ${
                    isUser
                      ? 'bg-violet-950/30 border-violet-500/30 text-slate-100'
                      : msg.role === 'system'
                        ? 'bg-amber-950/20 border-amber-500/40 text-amber-100'
                        : 'bg-[#111520] border-slate-800/90 text-slate-200'
                  }`}
                >
                  {msg.imagePreview && (
                    <div className="mb-3">
                      <img
                        src={msg.imagePreview}
                        alt={msg.fileName || 'Załączony obraz Vision'}
                        referrerPolicy="no-referrer"
                        className="max-h-56 rounded-lg border border-slate-700 object-contain"
                      />
                    </div>
                  )}

                  <div className="text-sm break-words space-y-0.5">
                    {renderFormattedContent(msg.content)}
                  </div>

                  {msg.connectionReport && (
                    <div className="mt-4 pt-4 border-t border-slate-800 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4" />
                          Zweryfikowano połączenie z SVL_System i uruchomiono 4 lokalne workery Python (Rodzina Mitek)
                        </span>
                        <button
                          type="button"
                          onClick={() => onNavigateTab('agents')}
                          className="px-3 py-1 bg-violet-600 hover:bg-violet-500 text-white rounded text-xs font-medium transition-colors whitespace-nowrap"
                        >
                          Przejdź do Panelu Agentów
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        {(msg.connectionReport.agents || []).map((ag: any) => (
                          <div
                            key={ag.id}
                            className="p-3 rounded-lg bg-[#0B0D13] border border-slate-800 text-xs space-y-1"
                          >
                            <div className="flex items-center justify-between font-mono">
                              <span className="font-semibold text-slate-100">
                                {ag.display_name || formatAgentDisplayName(ag.canonical_name)} (id: {ag.id})
                              </span>
                              <span className="text-emerald-400 tabular-nums">PID {ag.pid}</span>
                            </div>
                            <div className="text-slate-400 text-[11px]">{ag.preserved_role}</div>
                            <div className="text-[11px] font-mono text-violet-300">
                              Status: {ag.instance_origin}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {Array.isArray(msg.appliedActions) && msg.appliedActions.length > 0 && (
                    <div className="mt-4 pt-3 border-t border-slate-800 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Zapisane zmiany w SQLite (czat -&gt; system):
                        </span>
                        <button
                          type="button"
                          onClick={() => onNavigateTab('kernel')}
                          className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-violet-300 text-[11px] font-medium whitespace-nowrap"
                        >
                          Otwórz Jądro SVL &amp; Sfera
                        </button>
                      </div>
                      <div className="space-y-1 font-mono text-[11px]">
                        {msg.appliedActions.map((act, actIdx) => (
                          <div
                            key={`${act.entity}-${act.entityId}-${actIdx}`}
                            className={`flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded border ${
                              act.ok
                                ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-200'
                                : 'bg-rose-950/20 border-rose-500/30 text-rose-200'
                            }`}
                          >
                            <span className="font-semibold text-violet-300">
                              {act.entity}:{act.entityId}
                            </span>
                            <span className="flex-1 text-slate-300 truncate">{act.summary}</span>
                            <span className="tabular-nums text-slate-400">
                              {act.revision ? `rev ${act.revision} · ` : ''}
                              {act.ok ? 'OK' : 'ERR'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Attachment Preview Strip */}
        {(attachedImage || attachedTextFile) && (
          <div className="px-4 py-2 bg-[#111520] border-t border-slate-800 flex items-center gap-3">
            {attachedImage && (
              <div className="flex items-center gap-2 bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-1.5 text-xs">
                <ImageIcon className="w-4 h-4 text-violet-400" />
                <span className="truncate max-w-[180px]">{attachedImage.name}</span>
                {!selectedModelSupportsVision && (
                  <span className="text-amber-400 text-[11px]">
                    (Wybrany model nie obsługuje Vision!)
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setAttachedImage(null)}
                  className="text-slate-400 hover:text-rose-400"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            {attachedTextFile && (
              <div className="flex items-center gap-2 bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-1.5 text-xs">
                <FileText className="w-4 h-4 text-emerald-400" />
                <span className="truncate max-w-[180px]">{attachedTextFile.name}</span>
                <button
                  type="button"
                  onClick={() => setAttachedTextFile(null)}
                  className="text-slate-400 hover:text-rose-400"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Chat Input Composer */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSendMessage();
          }}
          className="p-3 md:p-4 border-t border-slate-800/80 bg-[#111520]"
        >
          <div className="max-w-4xl mx-auto flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.py,.json,.md,.txt,.sh,.yaml,.yml"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Prześlij plik lub obraz Vision"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-[#0B0D13] border border-slate-700/80 text-slate-300 hover:text-white hover:border-violet-500 transition-colors shrink-0"
            >
              <Paperclip className="w-4 h-4" />
            </button>

            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Wpisz wiadomość lub 'podłącz moje ai'..."
              aria-label="Wiadomość czatu Open WebUI"
              className="flex-1 min-w-0 min-h-[44px] px-3 md:px-4 py-2.5 rounded-lg bg-[#0B0D13] border border-slate-700/80 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-violet-500"
            />

            <button
              type="submit"
              disabled={isSending || (!input.trim() && !attachedImage && !attachedTextFile)}
              className="min-h-[44px] px-3.5 md:px-5 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 md:gap-2 transition-colors whitespace-nowrap shrink-0"
            >
              <Send className="w-4 h-4" />
              <span>{isSending ? 'Wysyłanie...' : 'Wyślij'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
