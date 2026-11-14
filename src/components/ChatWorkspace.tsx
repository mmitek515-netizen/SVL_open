import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Paperclip,
  Plus,
  Terminal,
  Cpu,
  ShieldCheck,
  Sparkles,
  Image as ImageIcon,
  FileText,
  X,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  MessageSquare,
  Trash2,
} from 'lucide-react';
import {
  CANONICAL_AGENTS,
  buildChatHistoryPayload,
  mergeConversationThreads,
  validateOllamaHostUrl,
} from '../utils/svlLogic';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  sender: string;
  agentId?: string;
  modelUsed?: string;
  content: string;
  timestamp: string;
  imagePreview?: string;
  fileName?: string;
  connectionReport?: any;
}

export interface ConversationThread {
  id: string;
  title: string;
  updatedAt: string;
  messages: ChatMessage[];
}

interface ChatWorkspaceProps {
  agentsStatus: any[];
  healthData: any;
  onExecuteConnectMyAi: () => Promise<any>;
  isConnectingAi: boolean;
  onNavigateTab: (tab: 'chat' | 'agents' | 'terminals' | 'kernel' | 'linux') => void;
  onRefreshSystem: () => Promise<void>;
  targetAgent?: 'Auto' | 'Aria' | 'Alex' | 'Astyria' | 'Aurelius';
  onChangeTargetAgent?: (agent: 'Auto' | 'Aria' | 'Alex' | 'Astyria' | 'Aurelius') => void;
  syncRevision?: number;
  isSyncing?: boolean;
  lastSyncedAt?: string | null;
  onFullSync?: (localConversations?: any[]) => Promise<any>;
}

const STORAGE_KEY = 'svl_python_os_conversations_v1';

const INITIAL_CONVERSATIONS: ConversationThread[] = [
  {
    id: 'conv-initial-svl',
    title: 'Sesja główna SVL Python OS',
    updatedAt: new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }),
    messages: [
      {
        id: 'msg-welcome-1',
        role: 'assistant',
        sender: 'SVL System Kernel',
        agentId: 'system',
        modelUsed: 'SVLSystemKernel v5.6.0-QuantumWheel-Debian13 (Python 3)',
        timestamp: new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }),
        content:
          'Witaj w **SVL Python OS (Open WebUI Workspace)**.\n\n' +
          'Czterej agenci **Aria** (`si_1`), **Alex** (`Alex`), **Astyria** (`Astyria`) i **Aurelius** (`Aurelius`) są automatycznie uruchamiani jako osobne procesy Python (PID) z pełną konfiguracją RBAC, pamięcią SQLite i magistralą zdarzeń oraz integracją z **Ollama** (`llama3.2-vision:11b`).\n\n' +
          '- Kliknij dowolnego agenta na pasku powyżej, aby rozmawiać z nim bezpośrednio, lub zostaw **Auto-Router**.\n' +
          '- Możesz pisać swobodnie po polsku, przesyłać obrazy Vision lub wpisać `podłącz moje ai`, aby ponownie zweryfikować repozytorium `mmitek515-netizen/SVL_System`.',
      },
    ],
  },
];

function renderFormattedLine(line: string, keyPrefix: string): React.ReactNode {
  const tokens = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return tokens.map((tok, i) => {
    if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) {
      return (
        <strong key={`${keyPrefix}-${i}`} className="font-semibold text-slate-100">
          {tok.slice(2, -2)}
        </strong>
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

export const ChatWorkspace: React.FC<ChatWorkspaceProps> = ({
  agentsStatus,
  healthData,
  onExecuteConnectMyAi,
  isConnectingAi,
  onNavigateTab,
  onRefreshSystem,
  targetAgent: propTargetAgent,
  onChangeTargetAgent,
  syncRevision = 0,
  isSyncing = false,
  lastSyncedAt,
  onFullSync,
}) => {
  const [conversations, setConversations] = useState<ConversationThread[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // ignore storage errors
    }
    return INITIAL_CONVERSATIONS;
  });

  const [activeConvId, setActiveConvId] = useState<string>(() => conversations[0]?.id || 'conv-initial-svl');
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('svl-hybrid-router');
  const [localTargetAgent, setLocalTargetAgent] = useState<'Auto' | 'Aria' | 'Alex' | 'Astyria' | 'Aurelius'>('Auto');
  const targetAgent = propTargetAgent ?? localTargetAgent;
  const setTargetAgent = (next: 'Auto' | 'Aria' | 'Alex' | 'Astyria' | 'Aurelius') => {
    setLocalTargetAgent(next);
    onChangeTargetAgent?.(next);
  };
  const [isSending, setIsSending] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [attachedImage, setAttachedImage] = useState<{ base64: string; mimeType: string; name: string } | null>(null);
  const [attachedTextFile, setAttachedTextFile] = useState<{ name: string; content: string } | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const hasSyncedInitialRef = useRef(false);
  const pendingMsgIdsRef = useRef<Set<string>>(new Set());
  const deletedConvIdsRef = useRef<Set<string>>(new Set());

  // Ollama connection panel & pull state
  const [ollamaConfigOpen, setOllamaConfigOpen] = useState(false);
  const [ollamaUrlInput, setOllamaUrlInput] = useState('http://127.0.0.1:11434');
  const [ollamaConfigStatus, setOllamaConfigStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [isSavingOllama, setIsSavingOllama] = useState(false);
  const [pullState, setPullState] = useState<any>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const activeConv = conversations.find((c) => c.id === activeConvId) || conversations[0];

  // Synchronize conversations with SQLite on boot and whenever syncRevision updates
  useEffect(() => {
    let cancelled = false;
    async function syncFromBackend() {
      try {
        if (!hasSyncedInitialRef.current) {
          hasSyncedInitialRef.current = true;
          const resp = await fetch('/api/py/chat/conversations/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversations }),
          });
          const data = await resp.json();
          if (!cancelled && data.ok && Array.isArray(data.conversations) && data.conversations.length > 0) {
            const hydrated: ConversationThread[] = data.conversations.map((c: any) => ({
              id: c.id,
              title: c.title,
              updatedAt: c.updatedAt?.includes('T')
                ? new Date(c.updatedAt).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
                : (c.updatedAt || ''),
              messages: Array.isArray(c.messages) && c.messages.length > 0 ? c.messages : INITIAL_CONVERSATIONS[0].messages,
            }));
            setConversations((prev) =>
              mergeConversationThreads(hydrated, prev, pendingMsgIdsRef.current, deletedConvIdsRef.current),
            );
          }
        } else {
          const resp = await fetch('/api/py/chat/conversations');
          const data = await resp.json();
          if (!cancelled && data.ok && Array.isArray(data.conversations) && data.conversations.length > 0) {
            const hydrated: ConversationThread[] = data.conversations.map((c: any) => ({
              id: c.id,
              title: c.title,
              updatedAt: c.updatedAt?.includes('T')
                ? new Date(c.updatedAt).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
                : (c.updatedAt || ''),
              messages: Array.isArray(c.messages) && c.messages.length > 0 ? c.messages : INITIAL_CONVERSATIONS[0].messages,
            }));
            setConversations((prev) =>
              mergeConversationThreads(hydrated, prev, pendingMsgIdsRef.current, deletedConvIdsRef.current),
            );
          }
        }
      } catch {
        // fallback cleanly to local cache if backend still starting
      }
    }
    void syncFromBackend();
    return () => {
      cancelled = true;
    };
  }, [syncRevision]);

  useEffect(() => {
    if (healthData?.ollama?.ollama_host) {
      setOllamaUrlInput((prev) => (prev === 'http://127.0.0.1:11434' ? healthData.ollama.ollama_host : prev));
    }
    if (healthData?.ollama?.pull_state) {
      setPullState(healthData.ollama.pull_state);
    }
  }, [healthData?.ollama?.ollama_host, healthData?.ollama?.pull_state]);

  useEffect(() => {
    if (!pullState?.active) return;
    const timer = setInterval(async () => {
      try {
        const resp = await fetch('/api/ollama/pull-status');
        const data = await resp.json();
        if (data?.pull_state) {
          setPullState(data.pull_state);
          if (!data.pull_state.active) {
            await onRefreshSystem();
          }
        }
      } catch {
        // ignore transient polling error
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [pullState?.active, onRefreshSystem]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } catch {
      // ignore quota errors
    }
  }, [conversations]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConv?.messages.length, isSending]);

  const ollamaReachable = Boolean(healthData?.ollama?.daemon_reachable);
  const ollamaHostUrl: string = healthData?.ollama?.ollama_host || 'http://127.0.0.1:11434';
  const ollamaModels: any[] = healthData?.ollama?.models || [];
  const hasLlama32Vision = ollamaModels.some((m: any) =>
    String(m.name || '').startsWith('llama3.2-vision'),
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
      const resp = await fetch('/api/ollama/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ollamaHost: check.normalized }),
      });
      const data = await resp.json();
      await onRefreshSystem();
      if (data.ok && data.ollama?.daemon_reachable) {
        const count = (data.ollama.models || []).length;
        setOllamaConfigStatus({
          ok: true,
          msg: `Połączono z Ollama (${data.ollama.ollama_host}). Wykryto modeli: ${count}.`,
        });
      } else {
        setOllamaConfigStatus({
          ok: false,
          msg: `Zapisano adres ${check.normalized}, ale daemon nie odpowiada: ${data.ollama?.error || data.error || 'connection refused'}`,
        });
      }
    } catch (err: any) {
      setOllamaConfigStatus({ ok: false, msg: `Błąd zapisu: ${err?.message || String(err)}` });
    } finally {
      setIsSavingOllama(false);
    }
  };

  const handlePullVisionModel = async (modelToPull = 'llama3.2-vision:11b') => {
    setOllamaConfigStatus(null);
    try {
      const resp = await fetch('/api/ollama/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelToPull }),
      });
      const data = await resp.json();
      if (data.pull_state) {
        setPullState(data.pull_state);
      }
      if (data.ok) {
        setOllamaConfigStatus({
          ok: true,
          msg: `Rozpoczęto pobieranie ${modelToPull} przez lokalny daemon Ollama.`,
        });
      } else {
        setOllamaConfigStatus({
          ok: false,
          msg: data.error || 'Nie udało się uruchomić pobierania modelu.',
        });
      }
    } catch (err: any) {
      setOllamaConfigStatus({ ok: false, msg: `Błąd pobierania: ${err?.message || String(err)}` });
    }
  };

  const persistMessageToSqlite = async (convId: string, convTitle: string, msg: ChatMessage) => {
    pendingMsgIdsRef.current.add(msg.id);
    try {
      await fetch('/api/py/chat/conversations/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: convId,
          title: convTitle,
          model: selectedModel,
          message: msg,
        }),
      });
    } catch {
      // ignore transient persist failure
    } finally {
      pendingMsgIdsRef.current.delete(msg.id);
    }
  };

  const appendMessageToThread = (convId: string, convTitle: string, msg: ChatMessage) => {
    pendingMsgIdsRef.current.add(msg.id);
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convId) return c;
        return {
          ...c,
          title: convTitle,
          updatedAt: msg.timestamp,
          messages: [...c.messages, msg],
        };
      }),
    );
    void persistMessageToSqlite(convId, convTitle, msg);
  };

  const handleCreateConversation = () => {
    const newId = `conv-${Date.now()}`;
    const nowTime = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    const initMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      sender: 'SVL System Kernel',
      agentId: 'system',
      modelUsed: 'SVLSystemKernel v5.6.0',
      timestamp: nowTime,
      content: 'Rozpoczęto nową konwersację. Wpisz `podłącz moje ai` lub zadaj pytanie wybranemu agentowi.',
    };
    const newThread: ConversationThread = {
      id: newId,
      title: `Nowa sesja (${nowTime})`,
      updatedAt: nowTime,
      messages: [initMsg],
    };
    pendingMsgIdsRef.current.add(initMsg.id);
    setConversations((prev) => [newThread, ...prev]);
    setActiveConvId(newId);
    void persistMessageToSqlite(newId, newThread.title, initMsg);
  };

  const handleDeleteConversation = (id: string) => {
    if (conversations.length <= 1) return;
    deletedConvIdsRef.current.add(id);
    const remaining = conversations.filter((c) => c.id !== id);
    setConversations(remaining);
    if (activeConvId === id && remaining[0]) {
      setActiveConvId(remaining[0].id);
    }
    void fetch('/api/py/chat/conversations/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: id }),
    }).catch(() => {});
  };

  const handleTriggerFullSync = async () => {
    if (!onFullSync) {
      await onRefreshSystem();
      return;
    }
    const res = await onFullSync(conversations);
    if (res?.ok) {
      setSyncNotice(`Zsynchronizowano SQLite, agentów (4/4) i Ollama (${new Date().toLocaleTimeString('pl-PL', { hour12: false })})`);
      setTimeout(() => setSyncNotice(null), 4500);
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

  const handleSendMessage = async (overrideText?: string) => {
    const rawText = overrideText !== undefined ? overrideText : input;
    const trimmed = rawText.trim();
    if ((!trimmed && !attachedImage && !attachedTextFile) || isSending) return;

    const nowTime = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    const fullPrompt = attachedTextFile
      ? `${trimmed || 'Przeanalizuj załączony plik.'}\n\n[Załączony plik: ${attachedTextFile.name}]\n\`\`\`\n${attachedTextFile.content.slice(0, 4000)}\n\`\`\``
      : trimmed;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      sender: 'Mateusz Mitek (Operator)',
      timestamp: nowTime,
      content: trimmed || (attachedImage ? `[Przesłano obraz: ${attachedImage.name}]` : `[Plik: ${attachedTextFile?.name}]`),
      imagePreview: attachedImage?.base64,
      fileName: attachedTextFile?.name || attachedImage?.name,
    };

    const targetConvId = activeConv.id;
    const targetTitle =
      activeConv.messages.length <= 1 && trimmed
        ? trimmed.slice(0, 42)
        : activeConv.title;

    appendMessageToThread(targetConvId, targetTitle, userMsg);
    if (overrideText === undefined) setInput('');
    const currentImage = attachedImage;
    setAttachedImage(null);
    setAttachedTextFile(null);
    setIsSending(true);

    const historyPayload = buildChatHistoryPayload(activeConv.messages, 16);

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: fullPrompt,
          model: selectedModel,
          targetAgent,
          history: historyPayload,
          imageBase64: currentImage?.base64 || '',
          imageMimeType: currentImage?.mimeType || 'image/png',
        }),
      });
      const data = await resp.json();

      if (!resp.ok || data.ok === false) {
        appendMessageToThread(targetConvId, targetTitle, {
          id: `err-${Date.now()}`,
          role: 'system',
          sender: 'Diagnostyka połączenia AI',
          timestamp: new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }),
          content: data.error || `Błąd serwera HTTP ${resp.status}`,
        });
        return;
      }

      // If 'podłącz moje ai' was executed in chat, also refresh top-level state
      if (data.connectionReport) {
        await onExecuteConnectMyAi();
      }

      const replyMsg: ChatMessage = {
        id: `asst-${Date.now()}`,
        role: 'assistant',
        sender: data.sender || 'Alex',
        agentId: data.agentId || 'Alex',
        modelUsed: data.modelUsed || selectedModel,
        timestamp: new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }),
        content: data.reply || 'Brak odpowiedzi z serwera.',
        connectionReport: data.connectionReport,
      };
      appendMessageToThread(targetConvId, targetTitle, replyMsg);
    } catch (err: any) {
      appendMessageToThread(targetConvId, targetTitle, {
        id: `err-${Date.now()}`,
        role: 'system',
        sender: 'System Error',
        timestamp: nowTime,
        content: `Błąd komunikacji z backendem: ${err?.message || String(err)}`,
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-[#0B0D13]">
      {/* Left Open WebUI Sidebar: Conversation History & Agent Status Summary */}
      <aside
        className={`${
          mobileSidebarOpen ? 'fixed inset-y-0 left-0 z-40 flex shadow-2xl' : 'hidden lg:flex'
        } w-72 shrink-0 flex-col border-r border-slate-800/80 bg-[#111520]`}
      >
        <div className="p-4 border-b border-slate-800/80 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              handleCreateConversation();
              setMobileSidebarOpen(false);
            }}
            className="flex-1 min-h-[42px] px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4" />
            Nowa konwersacja
          </button>
          {mobileSidebarOpen && (
            <button
              type="button"
              aria-label="Zamknij panel boczny"
              onClick={() => setMobileSidebarOpen(false)}
              className="lg:hidden min-h-[42px] px-2.5 rounded-lg bg-[#0B0D13] border border-slate-700 text-slate-300"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Conversations List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          <div className="px-2 py-1.5 text-xs font-medium text-slate-400">
            Historia konwersacji ({conversations.length})
          </div>
          {conversations.map((conv) => {
            const isActive = conv.id === activeConv.id;
            return (
              <div
                key={conv.id}
                className={`group flex items-center justify-between rounded-lg px-3 py-2.5 text-xs transition-colors ${
                  isActive
                    ? 'bg-violet-600/15 text-slate-100 border border-violet-500/30'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 border border-transparent'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setActiveConvId(conv.id);
                    setMobileSidebarOpen(false);
                  }}
                  className="flex-1 text-left truncate pr-2"
                >
                  <div className="font-medium truncate">{conv.title}</div>
                  <div className="text-[11px] text-slate-500 font-mono tabular-nums mt-0.5">
                    {conv.messages.length} wiad. · {conv.updatedAt}
                  </div>
                </button>
                {conversations.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Usuń konwersację ${conv.title}`}
                    onClick={() => handleDeleteConversation(conv.id)}
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
            <span className="text-xs font-semibold text-slate-300">Agenci SVL_System</span>
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
                      {meta.canonicalName}
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
        {/* Workspace Toolbar: Model Selector, Target Agent Selector & Vision Capabilities */}
        <div className="px-4 py-2.5 border-b border-slate-800/80 bg-[#111520]/90 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5 md:gap-3 w-full md:w-auto min-w-0">
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(true)}
              className="lg:hidden min-h-[38px] px-3 py-1.5 rounded-lg bg-[#0B0D13] border border-slate-700/80 text-xs font-medium text-slate-200 flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <MessageSquare className="w-3.5 h-3.5 text-violet-400" />
              Historia ({conversations.length})
            </button>
            <div className="flex items-center gap-2 min-w-0 max-w-full flex-1 sm:flex-initial">
              <label htmlFor="openwebui-model-select" className="text-xs text-slate-400 whitespace-nowrap shrink-0">
                Silnik AI:
              </label>
              <select
                id="openwebui-model-select"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="min-w-0 max-w-full flex-1 sm:flex-initial bg-[#0B0D13] border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-violet-500 truncate"
              >
                <option value="svl-hybrid-router">
                  SVL Router ({ollamaReachable && ollamaModels.length > 0 ? 'Ollama -> Gemini' : 'Gemini / Ollama'})
                </option>
                {ollamaModels.map((m: any) => (
                  <option key={m.name} value={`ollama:${m.name}`}>
                    Ollama: {m.name} ({m.parameter_size || 'LLM'} · {m.vision_supported ? 'Vision' : 'Text'})
                  </option>
                ))}
                {!hasLlama32Vision && (
                  <option value="ollama:llama3.2-vision:11b">
                    Ollama: llama3.2-vision:11b ({ollamaReachable ? '11B Vision · Do pobrania' : '11B Vision · Offline'})
                  </option>
                )}
                <option value="gemini-3.1-flash-lite">
                  Gemini 3.1 Flash-Lite (Szybka konwersacja)
                </option>
                <option value="gemini-4-hydrogen">
                  Gemini 4 Hydrogen (Multimodal &amp; Vision)
                </option>
              </select>
            </div>

            <div className="flex items-center gap-2 min-w-0 max-w-full w-full sm:w-auto">
              <label htmlFor="openwebui-agent-select" className="text-xs text-slate-400 whitespace-nowrap shrink-0">
                Adresat:
              </label>
              <select
                id="openwebui-agent-select"
                value={targetAgent}
                onChange={(e) => setTargetAgent(e.target.value as any)}
                className="min-w-0 max-w-full flex-1 sm:flex-initial bg-[#0B0D13] border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-violet-500 truncate"
              >
                <option value="Auto">Auto-Router (Sferyczna Magistrala)</option>
                <option value="Aria">Aria (id: si_1 · Modele AI, Ollama, MCP)</option>
                <option value="Alex">Alex (id: Alex · Architektura, Backend, Linux)</option>
                <option value="Astyria">Astyria (id: Astyria · Open WebUI, Android)</option>
                <option value="Aurelius">Aurelius (id: Aurelius · Bezpieczeństwo RBAC, Audyt)</option>
              </select>
            </div>
          </div>

          {/* Unboxed clean metadata + Ollama endpoint config trigger */}
          <div className="flex items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
            <span>Vision: {selectedModelSupportsVision ? 'Tak' : 'Nie'}</span>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => setOllamaConfigOpen((v) => !v)}
              className={`hover:underline ${ollamaReachable ? 'text-emerald-400' : 'text-amber-400'}`}
            >
              Ollama: {ollamaReachable ? `Połączono (${ollamaModels.length})` : `Offline (${ollamaHostUrl}) · Skonfiguruj`}
            </button>
          </div>
        </div>

        {/* Inline Ollama Endpoint Configuration & Llama 3.2 Vision 11B Pull Drawer */}
        {ollamaConfigOpen && (
          <div className="px-4 py-2.5 border-b border-slate-800/80 bg-[#0F131D] space-y-2 text-xs">
            <form
              onSubmit={handleSaveOllamaConfig}
              className="flex flex-wrap items-center gap-2.5"
            >
              <label htmlFor="chat-ollama-host-input" className="text-slate-300 font-medium whitespace-nowrap">
                Adres serwera Ollama (OLLAMA_HOST):
              </label>
              <input
                id="chat-ollama-host-input"
                type="url"
                value={ollamaUrlInput}
                onChange={(e) => setOllamaUrlInput(e.target.value)}
                placeholder="http://127.0.0.1:11434"
                className="flex-1 min-w-[200px] max-w-md px-3 py-1.5 rounded-lg bg-[#0B0D13] border border-slate-700 text-slate-100 font-mono text-xs focus:outline-none focus:border-violet-500"
              />
              <button
                type="submit"
                disabled={isSavingOllama}
                className="px-3.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white font-semibold whitespace-nowrap"
              >
                {isSavingOllama ? 'Testowanie...' : 'Połącz i wykryj modele'}
              </button>
              {ollamaReachable && !hasLlama32Vision && (
                <button
                  type="button"
                  disabled={Boolean(pullState?.active)}
                  onClick={() => handlePullVisionModel('llama3.2-vision:11b')}
                  className="px-3.5 py-1.5 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold whitespace-nowrap"
                >
                  {pullState?.active ? `Pobieranie (${pullState.percent ?? 0}%)` : 'Pobierz llama3.2-vision:11b'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setOllamaConfigOpen(false)}
                className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                Zamknij
              </button>
            </form>
            {pullState && (pullState.active || pullState.error || pullState.percent > 0) && (
              <div className="flex items-center gap-3 font-mono text-[11px] text-slate-300">
                <span>Model: {pullState.model}</span>
                <span>·</span>
                <span className={pullState.error ? 'text-amber-400' : 'text-emerald-400'}>
                  {pullState.error ? pullState.error : `${pullState.status} (${pullState.percent ?? 0}%)`}
                </span>
              </div>
            )}
            {ollamaConfigStatus && (
              <div className={ollamaConfigStatus.ok ? 'text-emerald-400' : 'text-amber-400'}>
                {ollamaConfigStatus.msg}
              </div>
            )}
          </div>
        )}

        {/* Always-Visible 4 Live AI Agents Quick Strip (Desktop & Mobile) */}
        <div
          aria-label="Aktywni agenci AI SVL Python OS"
          className="px-4 py-2 border-b border-slate-800/70 bg-[#0F131C] flex items-center gap-2 overflow-x-auto"
        >
          <span className="text-[11px] font-medium text-slate-400 whitespace-nowrap shrink-0">
            Aktywni agenci:
          </span>
          {CANONICAL_AGENTS.map((meta) => {
            const live = agentsStatus.find((a) => a.canonical_name === meta.canonicalName);
            const isOnline = live?.status === 'ONLINE_LOCAL_WORKER';
            const isTargeted = targetAgent === meta.canonicalName;
            const ollamaModel = live?.config?.ollama_model || 'llama3.2-vision:11b';
            return (
              <button
                key={meta.id}
                type="button"
                onClick={() => setTargetAgent(isTargeted ? 'Auto' : (meta.canonicalName as any))}
                title={`${meta.canonicalName} (id: ${meta.id}) · Model: ${ollamaModel} · Kliknij, aby kierować rozmowę`}
                className={`px-2.5 py-1.5 rounded-lg border text-xs flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors ${
                  isTargeted
                    ? 'bg-violet-600/25 border-violet-500 text-slate-100'
                    : 'bg-[#0B0D13] border-slate-800 hover:border-slate-700 text-slate-300'
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    isOnline ? 'bg-emerald-400' : 'bg-amber-400'
                  }`}
                />
                <span className={`font-semibold ${meta.textClass}`}>{meta.canonicalName}</span>
                <span className="text-[11px] font-mono tabular-nums text-slate-400">
                  {isOnline ? `PID ${live.pid}` : 'Łączenie'}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => onNavigateTab('agents')}
            className="ml-auto px-2.5 py-1.5 rounded-lg bg-slate-800/70 hover:bg-slate-700/80 text-violet-300 text-xs font-medium whitespace-nowrap shrink-0"
          >
            Konfiguruj agentów
          </button>
        </div>

        {/* Quick Command Action Bar */}
        <div className="px-4 py-2 border-b border-slate-800/50 bg-[#0D1018] flex items-center gap-2 overflow-x-auto">
          <span className="text-xs text-slate-500 shrink-0">Szybkie polecenia:</span>
          <button
            type="button"
            onClick={handleTriggerFullSync}
            disabled={isSyncing}
            className="px-2.5 py-1 rounded bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
            {isSyncing ? 'Synchronizacja...' : 'Synchronizuj aplikację'}
          </button>
          <button
            type="button"
            onClick={() => handleSendMessage('podłącz moje ai')}
            disabled={isSending || isConnectingAi}
            className="px-2.5 py-1 rounded bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/40 text-violet-300 text-xs font-mono whitespace-nowrap shrink-0 transition-colors"
          >
            podłącz moje ai
          </button>
          <button
            type="button"
            onClick={() => handleSendMessage('Cześć! Jak się macie i nad czym obecnie pracujecie w SVL Python OS?')}
            disabled={isSending}
            className="px-2.5 py-1 rounded bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 text-xs whitespace-nowrap shrink-0 transition-colors"
          >
            Swobodna rozmowa z agentem
          </button>
          <button
            type="button"
            onClick={() => onNavigateTab('linux')}
            className="px-2.5 py-1 rounded bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 text-xs flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
          >
            <Cpu className="w-3.5 h-3.5 text-emerald-400" />
            Ustawienia Ollama &amp; Linux
          </button>
          <button
            type="button"
            onClick={() => onNavigateTab('terminals')}
            className="px-2.5 py-1 rounded bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 text-xs flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
          >
            <Terminal className="w-3.5 h-3.5 text-violet-400" />
            Otwórz Terminale (5)
          </button>
          {(syncNotice || lastSyncedAt) && (
            <span className="ml-auto text-[11px] font-mono text-slate-400 whitespace-nowrap shrink-0">
              {syncNotice || `Sync: ${lastSyncedAt}`}
            </span>
          )}
        </div>

        {/* Chat Messages Stream */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-5">
          {activeConv.messages.map((msg) => {
            const isUser = msg.role === 'user';
            const agentMeta = CANONICAL_AGENTS.find(
              (a) => a.canonicalName === msg.sender || a.id === msg.agentId,
            );

            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
              >
                {/* Metadata Header (Unboxed clean text with · separators) */}
                <div className="flex items-center gap-2 text-xs text-slate-400 mb-1.5 px-1">
                  <span className={`font-semibold ${agentMeta ? agentMeta.textClass : isUser ? 'text-violet-300' : 'text-slate-200'}`}>
                    {msg.sender}
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

                {/* Message Content Surface */}
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

                  {/* Interactive Connection Report Card when 'podłącz moje ai' runs */}
                  {msg.connectionReport && (
                    <div className="mt-4 pt-4 border-t border-slate-800 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4" />
                          Zweryfikowano połączenie z SVL_System i uruchomiono 4 lokalne workery Python
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
                                {ag.canonical_name} (id: {ag.id})
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
            handleSendMessage();
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
