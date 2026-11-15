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
  Copy,
  Check,
  Zap,
  CornerDownRight,
  Sparkles,
  Radio,
  Bell,
  Server,
  Rocket,
  Brain,
  FileBarChart2,
} from 'lucide-react';
import {
  CANONICAL_AGENTS,
  SyncableMessage,
  buildChatHistoryPayload,
  createUniqueId,
  formatAgentDisplayName,
  isUnsafeChatInteractiveAction,
  parseChatInteractiveToken,
  safeFetchJson,
  getSvlOperatorAccessToken,
  setSvlOperatorAccessToken,
  validateOllamaHostUrl,
} from '../utils/svlLogic';
import { useSvlSync, getCanonicalConversationTitle } from '../utils/svlSyncStore';
import { AvatarSettingsModal, SvlAvatar } from './AgentAvatar';
import { RealVisionPanel } from './RealVisionPanel';

export type ChatMessage = SyncableMessage;

interface ChatWorkspaceProps {
  onNavigateTab: (tab: 'chat' | 'svl364' | 'notifications' | 'infrastructure' | 'agents' | 'terminals' | 'kernel' | 'linux') => void;
}

const InteractiveCodeBlock: React.FC<{
  code: string;
  language: string;
}> = ({ code, language }) => {
  const [copied, setCopied] = useState(false);
  const cleanCode = code.replace(/^\n+|\n+$/g, '');
  const cleanLang = (language || '').toLowerCase().trim();

  const handleCopy = () => {
    void navigator.clipboard.writeText(cleanCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-2.5 rounded-lg border border-slate-800 bg-[#070A10] overflow-hidden text-xs font-mono shadow-sm">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#101624] border-b border-slate-800 text-[11px] text-slate-400">
        <span className="font-semibold uppercase tracking-wider text-cyan-400">
          {cleanLang || 'TERMINAL / KOD'}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800/90 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? 'Skopiowano!' : 'Kopiuj'}</span>
          </button>
        </div>
      </div>
      <div className="p-3 overflow-auto text-slate-200 leading-relaxed max-h-96">
        <pre>{cleanCode}</pre>
      </div>
    </div>
  );
};

const InteractiveActionButton: React.FC<{
  label: string;
  action: string;
  onAction?: (actionValue: string, label?: string) => void;
  disabled?: boolean;
}> = ({ label, action, onAction, disabled = false }) => {
  const getIcon = () => {
    const act = action.trim().toLowerCase();
    if (act.startsWith('tab:svl364')) return <Rocket className="w-3.5 h-3.5 text-cyan-400" />;
    if (act.startsWith('tab:terminals')) return <Terminal className="w-3.5 h-3.5 text-violet-400" />;
    if (act.startsWith('tab:agents')) return <Users className="w-3.5 h-3.5 text-emerald-400" />;
    if (act.startsWith('tab:kernel')) return <Cpu className="w-3.5 h-3.5 text-cyan-400" />;
    if (act.startsWith('tab:linux')) return <Terminal className="w-3.5 h-3.5 text-amber-400" />;
    if (act.startsWith('tab:notifications')) return <Bell className="w-3.5 h-3.5 text-cyan-300" />;
    if (act.startsWith('tab:infrastructure')) return <Server className="w-3.5 h-3.5 text-emerald-300" />;
    if (act === 'action:connect_ai' || act === 'connect_ai') return <Zap className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />;
    if (act === 'action:sync' || act === 'sync') return <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />;
    if (isUnsafeChatInteractiveAction(action)) return <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />;
    return <CornerDownRight className="w-3.5 h-3.5 text-cyan-400" />;
  };

  return (
    <button
      type="button"
      onClick={() => onAction?.(action, label)}
      disabled={disabled}
      title={disabled ? 'Przyciski czatu nie mogą uruchamiać poleceń powłoki.' : undefined}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 my-1 mr-2 rounded-lg bg-cyan-950/50 hover:bg-cyan-900/70 active:bg-cyan-800 text-cyan-100 border border-cyan-500/40 hover:border-cyan-400 text-xs font-medium transition-all shadow-sm active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {getIcon()}
      <span>{label}</span>
    </button>
  );
};

export function renderFormattedLine(
  line: string,
  keyPrefix: string,
  onAction?: (actionValue: string, label?: string) => void,
): React.ReactNode {
  const tokens = line.split(/(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[(?:btn|button|action):[^\]]+\]|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g);
  return tokens.map((tok, i) => {
    const button = parseChatInteractiveToken(tok);
    if (button) {
      return (
        <InteractiveActionButton
          key={`${keyPrefix}-${i}`}
          label={button.label}
          action={button.action}
          onAction={onAction}
          disabled={isUnsafeChatInteractiveAction(button.action)}
        />
      );
    }
    if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) {
      return (
        <strong key={`${keyPrefix}-${i}`} className="font-semibold text-white">
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
    if (tok.startsWith('_') && tok.endsWith('_') && tok.length > 2) {
      return (
        <em key={`${keyPrefix}-${i}`} className="italic text-slate-300">
          {tok.slice(1, -1)}
        </em>
      );
    }
    if (tok.startsWith('~~') && tok.endsWith('~~') && tok.length > 4) {
      return (
        <del key={`${keyPrefix}-${i}`} className="text-slate-400">
          {tok.slice(2, -2)}
        </del>
      );
    }
    const link = tok.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/i);
    if (link) {
      return (
        <a
          key={`${keyPrefix}-${i}`}
          href={link[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-cyan-300 underline underline-offset-2 hover:text-cyan-200"
        >
          {link[1]}
        </a>
      );
    }
    if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) {
      const codeContent = tok.slice(1, -1);
      return (
        <code
          key={`${keyPrefix}-${i}`}
          className="px-1.5 py-0.5 rounded bg-[#070A10] border border-cyan-500/25 font-mono text-[12px] text-cyan-200"
        >
          {codeContent}
        </code>
      );
    }
    return <React.Fragment key={`${keyPrefix}-${i}`}>{tok}</React.Fragment>;
  });
}

function parseMarkdownTableRow(rowLine: string): string[] {
  const trimmed = rowLine.trim();
  const stripped = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return stripped.split('|').map((cell) => cell.trim());
}

function isMarkdownTableSeparator(rowLine: string): boolean {
  const cells = parseMarkdownTableRow(rowLine);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

export function renderFormattedContent(
  content: string,
  onAction?: (actionValue: string, label?: string) => void,
): React.ReactNode {
  const normalized = (content || '').trim();
  if (!normalized) return null;

  const codeBlockRegex = /(```[\s\S]*?(?:```|$))/g;
  const segments = normalized.split(codeBlockRegex);

  return segments.map((seg, segIdx) => {
    if (seg.startsWith('```')) {
      const firstLineBreak = seg.indexOf('\n');
      const lang = firstLineBreak !== -1 ? seg.slice(3, firstLineBreak).trim() : '';
      const closingFence = seg.endsWith('```') ? seg.lastIndexOf('```') : seg.length;
      const code = firstLineBreak !== -1
        ? seg.slice(firstLineBreak + 1, closingFence)
        : seg.slice(3, closingFence);
      return (
        <InteractiveCodeBlock
          key={`code-block-${segIdx}`}
          code={code}
          language={lang}
        />
      );
    }

    const lines = seg.split('\n');
    const renderedElements: React.ReactNode[] = [];
    let idx = 0;

    while (idx < lines.length) {
      const line = lines[idx];
      const trimmed = line.trim();
      const structuralLine = line.trimStart();

      // Detect Markdown Table block
      if (
        trimmed.startsWith('|') &&
        trimmed.endsWith('|') &&
        idx + 1 < lines.length &&
        lines[idx + 1].trim().startsWith('|') &&
        isMarkdownTableSeparator(lines[idx + 1])
      ) {
        const headerCells = parseMarkdownTableRow(trimmed);
        idx += 2; // skip header + separator
        const bodyRows: string[][] = [];
        while (
          idx < lines.length &&
          lines[idx].trim().startsWith('|') &&
          lines[idx].trim().endsWith('|')
        ) {
          if (!isMarkdownTableSeparator(lines[idx])) {
            bodyRows.push(parseMarkdownTableRow(lines[idx]));
          }
          idx += 1;
        }
        renderedElements.push(
          <div
            key={`table-${segIdx}-${idx}`}
            className="my-2.5 overflow-x-auto rounded-lg border border-cyan-500/25 bg-[#070B12] shadow-sm"
          >
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-cyan-500/25 bg-[#0C1422] text-cyan-300 font-mono text-[11px] uppercase tracking-wider">
                  {headerCells.map((hCell, hIdx) => (
                    <th key={`th-${hIdx}`} className="py-2 px-3 font-semibold">
                      {renderFormattedLine(hCell, `th-${segIdx}-${idx}-${hIdx}`, onAction)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-slate-200">
                {bodyRows.map((rCells, rIdx) => (
                  <tr
                    key={`tr-${rIdx}`}
                    className="hover:bg-cyan-500/5 transition-colors"
                  >
                    {rCells.map((cText, cIdx) => (
                      <td key={`td-${rIdx}-${cIdx}`} className="py-1.5 px-3 align-top leading-relaxed">
                        {renderFormattedLine(cText, `td-${segIdx}-${idx}-${rIdx}-${cIdx}`, onAction)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        continue;
      }

      // H1
      if (structuralLine.startsWith('# ')) {
        renderedElements.push(
          <h1
            key={`h1-${idx}`}
            className="text-base md:text-lg font-bold text-white mt-2.5 mb-1.5 pb-1.5 border-b border-cyan-500/30 flex items-center gap-2 tracking-tight"
          >
            {renderFormattedLine(structuralLine.slice(2), `h1-${idx}`, onAction)}
          </h1>,
        );
        idx += 1;
        continue;
      }

      // H2
      if (structuralLine.startsWith('## ')) {
        renderedElements.push(
          <h2
            key={`h2-${idx}`}
            className="text-xs md:text-sm font-bold uppercase tracking-wider text-cyan-300 mt-3 mb-1.5 pt-1 border-t border-slate-800/70 flex items-center gap-2 font-mono"
          >
            {renderFormattedLine(structuralLine.slice(3), `h2-${idx}`, onAction)}
          </h2>,
        );
        idx += 1;
        continue;
      }

      // H3
      if (structuralLine.startsWith('### ')) {
        renderedElements.push(
          <h3
            key={`h3-${idx}`}
            className="text-xs md:text-sm font-semibold text-violet-300 mt-2 mb-1"
          >
            {renderFormattedLine(structuralLine.slice(4), `h3-${idx}`, onAction)}
          </h3>,
        );
        idx += 1;
        continue;
      }

      // Blockquote / Callout
      if (structuralLine.startsWith('> ')) {
        renderedElements.push(
          <div
            key={`bq-${idx}`}
            className="my-1.5 border-l-2 border-cyan-400 bg-cyan-950/25 px-3.5 py-2 rounded-r-lg text-cyan-100 text-xs md:text-sm leading-relaxed"
          >
            {renderFormattedLine(structuralLine.slice(2), `bq-${idx}`, onAction)}
          </div>,
        );
        idx += 1;
        continue;
      }

      // Horizontal rule
      if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
        renderedElements.push(<hr key={`hr-${idx}`} className="my-2.5 border-cyan-500/20" />);
        idx += 1;
        continue;
      }

      // Unordered list item
      if (/^[-*•]\s+/.test(trimmed)) {
        const listText = trimmed.replace(/^[-*•]\s+/, '');
        renderedElements.push(
          <div key={`li-${idx}`} className="flex items-start gap-2 my-0.5 leading-relaxed pl-1">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 mt-2 shrink-0 shadow-[0_0_5px_rgba(34,211,238,0.6)]" />
            <div className="flex-1 min-w-0">{renderFormattedLine(listText, `li-${idx}`, onAction)}</div>
          </div>,
        );
        idx += 1;
        continue;
      }

      // Numbered list item
      const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
      if (numMatch) {
        renderedElements.push(
          <div key={`nli-${idx}`} className="flex items-start gap-2 my-0.5 leading-relaxed pl-1">
            <span className="text-cyan-400 font-mono text-xs font-semibold shrink-0 min-w-[18px]">
              {numMatch[1]}.
            </span>
            <div className="flex-1 min-w-0">{renderFormattedLine(numMatch[2], `nli-${idx}`, onAction)}</div>
          </div>,
        );
        idx += 1;
        continue;
      }

      // Blank line
      if (trimmed === '') {
        renderedElements.push(<div key={`empty-${idx}`} className="h-1.5" />);
        idx += 1;
        continue;
      }

      // Regular paragraph
      renderedElements.push(
        <div key={`p-${idx}`} className="leading-relaxed">
          {renderFormattedLine(line, `l-${idx}`, onAction)}
        </div>,
      );
      idx += 1;
    }

    return <React.Fragment key={`text-seg-${segIdx}`}>{renderedElements}</React.Fragment>;
  });
}

export const ChatWorkspace: React.FC<ChatWorkspaceProps> = ({ onNavigateTab }) => {
  const {
    tabOrigin,
    wsState,
    viteHmrDiagnostic,
    serverRevision,
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
    clearAllConversationsAndBuffers,
    appendAndPersistChatMessage,
    triggerFullSync,
    refreshDomainModules,
    connectMyAi,
    notifyLocalMutation,
  } = useSvlSync();

  const agentsStatus: any[] = agentsData?.agents || [];

  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('svl-hybrid-router');
  const [isSending, setIsSending] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [isGeneratingSvlReport, setIsGeneratingSvlReport] = useState(false);
  const sendingRef = useRef(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [controlsExpanded, setControlsExpanded] = useState(false);
  const [attachedImage, setAttachedImage] = useState<{ base64: string; mimeType: string; name: string } | null>(null);
  const [attachedTextFile, setAttachedTextFile] = useState<{ name: string; content: string } | null>(null);
  const [syncDrawerOpen, setSyncDrawerOpen] = useState(false);
  const [avatarSettingsOpen, setAvatarSettingsOpen] = useState(false);
  const [realVisionOpen, setRealVisionOpen] = useState(false);
  const [chatActionError, setChatActionError] = useState<string | null>(null);

  // Ollama connection panel & pull state
  const [ollamaConfigOpen, setOllamaConfigOpen] = useState(false);
  const [ollamaUrlInput, setOllamaUrlInput] = useState('http://127.0.0.1:11434');
  const ollamaUrlDirtyRef = useRef(false);
  const [ollamaConfigStatus, setOllamaConfigStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [isSavingOllama, setIsSavingOllama] = useState(false);
  const [pullState, setPullState] = useState<any>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputFieldRef = useRef<HTMLInputElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const prevMsgCountRef = useRef<number>(0);

  const [duplexActive, setDuplexActive] = useState(true);
  const [isProactiveLoading, setIsProactiveLoading] = useState(false);
  const lastInteractionTimeRef = useRef<number>(Date.now());
  const autoTurnsRef = useRef<number>(0);
  const prevDuplexActiveRef = useRef<boolean>(duplexActive);
  const inputValueRef = useRef<string>(input);
  inputValueRef.current = input;

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

  useEffect(() => {
    lastInteractionTimeRef.current = Date.now();
  }, [activeConv?.id, activeConv?.messages.length]);

  useEffect(() => {
    autoTurnsRef.current = 0;
  }, [activeConv?.id]);

  const handleTriggerProactiveChat = async (agentOverride?: string, autonomous = false) => {
    if (sendingRef.current || isSending || isProactiveLoading || !activeConv) return;
    if (!autonomous) {
      autoTurnsRef.current = 0;
    }
    setIsProactiveLoading(true);
    setChatActionError(null);
    lastInteractionTimeRef.current = Date.now();
    try {
      const channelBoundAgent = activeConv.id === 'conv-agent-agata' ? 'Agata' : null;
      const chosenTarget =
        agentOverride ||
        channelBoundAgent ||
        (autonomous
          ? 'Auto'
          : targetAgent === 'Agata'
            ? targetAgent
            : 'Auto');
      const recentMsgs = (activeConv.messages || []).slice(-12);
      const lastMsg = recentMsgs[recentMsgs.length - 1];
      const historyPayload = recentMsgs.map((m) => ({
        role: m.role,
        sender: m.sender,
        content: m.content,
      }));
      const res = await safeFetchJson<{
        ok: boolean;
        message?: ChatMessage;
        sender?: string;
        agentId?: string;
        modelUsed?: string;
        serverRevision?: number;
        error?: string;
      }>('/api/chat/proactive', {
        method: 'POST',
        timeoutMs: 30000,
        body: JSON.stringify({
          conversationId: activeConv.id,
          targetAgent: chosenTarget,
          model: selectedModel,
          origin: tabOrigin,
          history: historyPayload,
          lastSender: lastMsg?.sender || '',
          autonomous,
        }),
      });

      if (res.ok && res.data?.ok && res.data.message) {
        if (autonomous) {
          autoTurnsRef.current += 1;
        }
        await refreshDomainModules(['chat']);
        notifyLocalMutation('chat', activeConv.id, res.data.serverRevision);
      } else if (!res.ok && !autonomous) {
        setChatActionError(`Błąd inicjacji rozmowy: ${res.error || res.data?.error || 'brak odpowiedzi'}`);
      }
    } finally {
      setIsProactiveLoading(false);
    }
  };

  const handleProactiveRef = useRef(handleTriggerProactiveChat);
  handleProactiveRef.current = handleTriggerProactiveChat;

  useEffect(() => {
    const justEnabled = !prevDuplexActiveRef.current && duplexActive;
    prevDuplexActiveRef.current = duplexActive;
    if (justEnabled) {
      autoTurnsRef.current = 0;
    }

    if (!duplexActive || !activeConv || isSending || isProactiveLoading) {
      return;
    }
    const MAX_AUTO_TURNS = 4;
    if (autoTurnsRef.current >= MAX_AUTO_TURNS) {
      return;
    }

    const delayMs = justEnabled ? 4000 : autoTurnsRef.current === 0 ? 6000 : 12000;
    const timer = setTimeout(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (sendingRef.current || inputValueRef.current.trim().length > 0) return;
      void handleProactiveRef.current(undefined, true);
    }, delayMs);

    return () => clearTimeout(timer);
  }, [duplexActive, activeConv?.id, activeConv?.messages.length, isSending, isProactiveLoading, selectedModel]);

  const ollamaReachable = Boolean(healthData?.ollama?.daemon_reachable);
  const ollamaModels: any[] = healthData?.ollama?.models || [];
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
          msg: `Połączono z lokalnym demonem Ollama (${data.ollama.ollama_host}). Wykryto modeli: ${count}.`,
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

  const handleTriggerFullSync = async () => {
    if (isSyncing) return;
    setChatActionError(null);
    const rep = await triggerFullSync('operator_sync_button');
    await refreshDomainModules(['modules', 'agents', 'kernel', 'health', 'chat', 'notifications']);
    setSyncDrawerOpen(true);
    if (!rep.ok) {
      setChatActionError(rep.error || 'Synchronizacja nie powiodła się.');
    }
  };

  const handleEmitComprehensiveSvlReport = async () => {
    if (isGeneratingSvlReport || isSending) return;
    setIsGeneratingSvlReport(true);
    setChatActionError(null);
    try {
      const res = await safeFetchJson<{
        ok: boolean;
        reportMarkdown?: string;
        serverRevision?: number;
        error?: string;
      }>('/api/py/kernel/markdown-report', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          emitToIris: true,
          title: 'Pełny Raport Operacyjny SVL_System, Statku SVL-364 Ebon Apex i Infrastruktury Floty',
          category: 'svl_system',
          origin: tabOrigin,
        }),
      });
      if (res.ok && res.data?.ok) {
        await refreshDomainModules(['chat', 'notifications', 'modules', 'kernel']);
        notifyLocalMutation('chat', 'conv-rodzina-mitek-wszyscy', res.data.serverRevision);
      } else {
        setChatActionError(res.error || res.data?.error || 'Nie udało się wygenerować raportu SVL_System.');
      }
    } finally {
      setIsGeneratingSvlReport(false);
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
    if ((!trimmed && !attachedImage && !attachedTextFile) || sendingRef.current || !targetConvObj) return;
    autoTurnsRef.current = 0;
    sendingRef.current = true;
    setIsSending(true);
    try {
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
      const isPermanentChannel =
        targetConvId === 'conv-rodzina-mitek-wszyscy' || targetConvId.startsWith('conv-agent-');
      const targetTitle = isPermanentChannel
        ? getCanonicalConversationTitle(targetConvId, targetConvObj.title)
        : targetConvObj.messages.length <= 1 && trimmed
          ? trimmed.slice(0, 42)
          : targetConvObj.title;

      const persistRes = await appendAndPersistChatMessage(targetConvId, targetTitle, selectedModel, userMsg);
      if (!persistRes.ok) {
        setChatActionError(`Błąd zapisu SQLite: ${persistRes.error || 'Nie zapisano wiadomości.'}`);
        return;
      }
      void refreshDomainModules(['modules', 'kernel']);

      if (overrideText === undefined) setInput('');
      const currentImage = attachedImage;
      setAttachedImage(null);
      setAttachedTextFile(null);

      const historyPayload = buildChatHistoryPayload(targetConvObj.messages, 32);

      const isSpecificAgentTargeted =
        targetAgent === 'Agata' || targetConvId === 'conv-agent-agata';
      const isFamilyDuplex =
        !isSpecificAgentTargeted &&
        (targetConvId === 'conv-rodzina-mitek-wszyscy' ||
          targetConvObj.title.toLowerCase().includes('rodzina mitek') ||
          targetAgent === 'Rodzina Mitek' ||
          duplexActive);

      const res = await safeFetchJson<any>('/api/chat', {
        method: 'POST',
        timeoutMs: 90000,
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
          void refreshDomainModules(['modules', 'agents', 'kernel', 'health', 'notifications']);
        }
        setChatActionError(res.error || data?.error || `Błąd serwera HTTP ${res.status}`);
        return;
      }

      if (data.connectionReport) {
        void refreshDomainModules(['agents', 'health']);
      }

      const appliedActions =
        Array.isArray(data.appliedActions) && data.appliedActions.length > 0
          ? data.appliedActions
          : undefined;

      const replyMsg: ChatMessage = {
        id: createUniqueId('asst'),
        role: 'assistant',
        sender: data.sender === 'Iris AI' ? 'Iris AI' : formatAgentDisplayName(data.sender || 'Agata Mitek'),
        agentId: data.agentId || 'Agata',
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

      if (Array.isArray(data.followUpMessages) && data.followUpMessages.length > 0) {
        for (const follow of data.followUpMessages) {
          if (!follow || !follow.content) continue;
          const followMsg: ChatMessage = {
            id: createUniqueId('asst-duplex'),
            role: 'assistant',
            sender: follow.sender === 'Iris AI' ? 'Iris AI' : formatAgentDisplayName(follow.sender || 'Agata Mitek'),
            agentId: follow.agentId || 'Agata',
            modelUsed: follow.modelUsed || data.modelUsed || selectedModel,
            timestamp: new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }),
            content: String(follow.content),
          };
          await appendAndPersistChatMessage(targetConvId, targetTitle, selectedModel, followMsg);
        }
      }

      await refreshDomainModules(['modules', 'agents', 'kernel', 'health', 'chat', 'notifications']);
      if (appliedActions || data.connectionReport || (Array.isArray(data.followUpMessages) && data.followUpMessages.length > 0)) {
        notifyLocalMutation('module', 'chat', data.latestServerRevision || undefined);
      }
    } catch (error: any) {
      setChatActionError(`Błąd wysyłania wiadomości: ${error?.message || String(error)}`);
    } finally {
      sendingRef.current = false;
      setIsSending(false);
    }
  };

  const handleGenerateImage = async () => {
    const prompt = input.trim();
    const targetConvObj = activeConv;
    if (!prompt || sendingRef.current || !targetConvObj) return;

    sendingRef.current = true;
    setIsSending(true);
    setIsGeneratingImage(true);
    setChatActionError(null);
    const targetTitle = targetConvObj.messages.length <= 1
      ? prompt.slice(0, 42)
      : targetConvObj.title;
    const timestamp = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

    try {
      const userMsg: ChatMessage = {
        id: createUniqueId('user-image'),
        role: 'user',
        sender: 'Mateusz Mitek (Operator)',
        timestamp,
        content: `[Generowanie obrazu] ${prompt}`,
      };
      const savedPrompt = await appendAndPersistChatMessage(
        targetConvObj.id,
        targetTitle,
        selectedModel,
        userMsg,
      );
      if (!savedPrompt.ok) {
        setChatActionError(`Błąd zapisu promptu: ${savedPrompt.error || 'Nie zapisano wiadomości.'}`);
        return;
      }

      setInput('');
      const result = await safeFetchJson<any>('/api/py/images/generate', {
        method: 'POST',
        timeoutMs: 900000,
        body: JSON.stringify({ prompt, origin: tabOrigin }),
      });
      if (!result.ok || !result.data?.ok || !result.data?.image) {
        setChatActionError(result.error || result.data?.error || 'Silnik graficzny nie zwrócił obrazu.');
        return;
      }

      const imageMsg: ChatMessage = {
        id: createUniqueId('assistant-image'),
        role: 'assistant',
        sender: 'SVL Image Engine',
        modelUsed: 'ComfyUI · Qwen Image 2.1',
        timestamp: new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }),
        content: 'Wygenerowano obraz przez Qwen Image 2.1.',
        imagePreview: result.data.image,
      };
      const savedImage = await appendAndPersistChatMessage(
        targetConvObj.id,
        targetTitle,
        selectedModel,
        imageMsg,
      );
      if (!savedImage.ok) {
        setChatActionError(`Obraz wygenerowano, ale nie zapisano go w czacie: ${savedImage.error || 'błąd SQLite.'}`);
      }
      await refreshDomainModules(['chat', 'health']);
    } catch (error: any) {
      setChatActionError(`Błąd generowania obrazu: ${error?.message || String(error)}`);
    } finally {
      sendingRef.current = false;
      setIsSending(false);
      setIsGeneratingImage(false);
    }
  };

  const handleInteractiveAction = async (actionValue: string, label?: string) => {
    const val = actionValue.trim();
    if (!val) return;
    if (isUnsafeChatInteractiveAction(val)) {
      setChatActionError('Przyciski odpowiedzi AI nie mogą automatycznie uruchamiać powłoki. Wklej komendę ręcznie do terminala po sprawdzeniu.');
      return;
    }

    if (val.startsWith('tab:')) {
      const tabName = val.slice(4).trim();
      if (!['chat', 'svl364', 'notifications', 'infrastructure', 'agents', 'terminals', 'kernel', 'linux'].includes(tabName)) return;
      onNavigateTab(tabName as 'chat' | 'svl364' | 'notifications' | 'infrastructure' | 'agents' | 'terminals' | 'kernel' | 'linux');
      return;
    }

    if (val === 'action:connect_ai' || val === 'connect_ai') {
      await connectMyAi('interactive_btn');
      return;
    }
    if (val === 'action:sync' || val === 'sync') {
      await handleTriggerFullSync();
      return;
    }

    if (val.startsWith('send:')) {
      const textToSend = val.slice(5).trim();
      void handleSendMessage(textToSend);
      return;
    }

    let textToFill = val.startsWith('text:') ? val.slice(5).trim() : val;
    if (/^[a-z0-9_-]+$/i.test(textToFill) && label && !['action:sync', 'action:connect_ai'].includes(val)) {
      textToFill = label;
    }
    setInput(textToFill);
    inputFieldRef.current?.focus();
  };

  const wsBadgeLabel =
    wsState === 'online'
      ? `WS Online · rev ${serverRevision}`
      : `Sync Online · rev ${serverRevision || 1}`;

  const wsBadgeClass = 'text-emerald-400';

  const agataLive = agentsStatus.find((a) => a.canonical_name === 'Agata');
  const agataMemoriesCount = agataLive?.memory_entries_count ?? (agentsData?.agent_memories?.Agata?.length || 0);

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
          <button
            type="button"
            onClick={async () => {
              if (window.confirm('Czy na pewno chcesz wyczyścić wszystkie wiadomości i odetkać bufory czatu?')) {
                const credential = getSvlOperatorAccessToken() ||
                  window.prompt('Podaj SVL_OPERATOR_TOKEN, aby wyczyścić historię wszystkich rozmów:') || '';
                if (credential) setSvlOperatorAccessToken(credential);
                const cleared = await clearAllConversationsAndBuffers();
                if (cleared.ok) setMobileSidebarOpen(false);
                else setChatActionError(cleared.error || 'Nie udało się wyczyścić rozmów w SQLite.');
              }
            }}
            className="w-full min-h-[36px] px-3 py-1.5 bg-rose-600/20 hover:bg-rose-600/35 border border-rose-500/40 text-rose-200 text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Wyczyść wszystko i odetkaj bufory
          </button>
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
                    } else if (conv.id === 'conv-agent-agata') {
                      setTargetAgent('Agata');
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
                {conversations.length > 1 && !isFamilyChan && !conv.id.startsWith('conv-agent-') && (
                  <button
                    type="button"
                    aria-label={`Usuń konwersację ${conv.title}`}
                    onClick={() => void handleDeleteConversationClick(conv.id)}
                    className="opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 focus:opacity-100 focus-visible:outline-2 focus-visible:outline-violet-400 focus-visible:outline-offset-2 rounded-md min-h-8 min-w-8 flex items-center justify-center text-slate-500 hover:text-rose-400 transition-opacity"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Agents Live Sidebar Summary */}
        <div className="p-4 border-t border-slate-800/80 bg-[#0D1018] space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300">
              Rodzina Mitek ({CANONICAL_AGENTS.length} AI + Iris)
            </span>
            <button
              type="button"
              onClick={() => {
                setMobileSidebarOpen(false);
                onNavigateTab('agents');
              }}
              className="text-xs text-violet-400 hover:text-violet-300 hover:underline whitespace-nowrap"
            >
              Panel AI
            </button>
          </div>
          <div className="space-y-1.5">
            {CANONICAL_AGENTS.map((meta) => {
              const live = agentsStatus.find((a) => a.canonical_name === meta.canonicalName);
              const isOnline = ['ONLINE_LOCAL_WORKER', 'BUSY_LOCAL_WORKER'].includes(live?.status);
              return (
                <button
                  type="button"
                  key={meta.id}
                  onClick={() => {
                    openAgentChannel(meta.canonicalName);
                    setMobileSidebarOpen(false);
                  }}
                  className="w-full flex items-center justify-between gap-2 text-xs py-1.5 px-2 rounded bg-slate-900/70 hover:bg-slate-800/80 border border-slate-800/60 transition-colors text-left cursor-pointer"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <SvlAvatar sender={meta.displayName} agentId={meta.id} size={22} />
                    <span className={`font-semibold ${meta.textClass} truncate`}>
                      {meta.displayName}
                    </span>
                  </div>
                  <span className="text-[11px] font-mono tabular-nums text-emerald-400 shrink-0">
                    {isOnline ? `PID ${live.pid}` : 'ONLINE'}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => {
                openFamilyChannel();
                setMobileSidebarOpen(false);
              }}
              className="w-full flex items-center justify-between gap-2 text-xs py-1.5 px-2 rounded bg-cyan-950/30 hover:bg-cyan-950/50 border border-cyan-500/30 transition-colors text-left cursor-pointer"
            >
              <div className="flex items-center gap-2 min-w-0">
                <SvlAvatar sender="Iris AI" agentId="iris" size={22} />
                <span className="font-semibold text-cyan-300 truncate">Iris AI (SVL_System)</span>
              </div>
              <span className="text-[11px] font-mono text-cyan-400 shrink-0">Raporty</span>
            </button>
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
                } else if (val === 'Agata') {
                  openAgentChannel(val);
                } else {
                  setTargetAgent(val);
                }
              }}
              className="min-w-0 flex-1 max-w-[220px] bg-[#0B0D13] border border-slate-700/80 rounded-md px-2 py-1 text-xs text-slate-100 font-medium focus:outline-none focus:border-violet-500 truncate"
            >
              <option value="Rodzina Mitek">Rodzina Mitek (wszyscy — czat grupowy)</option>
              <option value="Agata">Agata Mitek (1-na-1 · ROOT UID 0)</option>
              <option value="Auto">Auto-Router (Agata + Iris AI)</option>
            </select>

            <label htmlFor="openwebui-model-select" className="sr-only">
              Silnik AI
            </label>
            <select
              id="openwebui-model-select"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="min-w-0 flex-1 max-w-[215px] bg-[#0B0D13] border border-slate-700/80 rounded-md px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-violet-500 truncate"
            >
              <option value="svl-hybrid-router">
                SVL Hybrid Router ({ollamaReachable ? `Ollama (${ollamaModels.length}) + Gemini` : 'Auto'})
              </option>
              {ollamaModels.map((m: any) => (
                <option key={m.name} value={`ollama:${m.name}`}>
                  Ollama: {m.name} ({m.parameter_size || 'LLM'})
                </option>
              ))}
              <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash-Lite</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => void handleEmitComprehensiveSvlReport()}
              disabled={isGeneratingSvlReport || isSending}
              title="Wygeneruj pełny, estetyczny raport SVL_System od Iris AI na kanale wszyscy"
              className="px-2.5 py-1 rounded-md bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 text-[11px] font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer disabled:opacity-50"
            >
              <FileBarChart2 className={`w-3.5 h-3.5 text-cyan-300 ${isGeneratingSvlReport ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Raport SVL_System</span>
              <span className="sm:hidden">Raport</span>
            </button>

            <button
              type="button"
              onClick={() => setDuplexActive((v) => !v)}
              title={duplexActive ? 'Czat obustronny aktywny (AI rozmawia swobodnie i przejmuje inicjatywę)' : 'Czat obustronny wstrzymany'}
              aria-label="Przełącz czat obustronny"
              className={`px-2 py-1 rounded-md border text-[11px] font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-all ${
                duplexActive
                  ? 'bg-violet-600/25 border-violet-500/50 text-violet-200 hover:bg-violet-600/35 shadow-sm'
                  : 'bg-[#0B0D13] border-slate-700/80 text-slate-400 hover:text-slate-300'
              }`}
            >
              <Radio className={`w-3 h-3 ${duplexActive ? 'text-emerald-400 animate-pulse' : 'text-slate-500'}`} />
              <span className="hidden sm:inline">{duplexActive ? 'Czat obustronny: WŁ' : 'Obustronny: WYŁ'}</span>
              <span className="sm:hidden">{duplexActive ? '2-Way' : 'Ręczny'}</span>
            </button>
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

        {/* Status Bar: Deep Long-Term Memory 128D + Local Ollama Daemon + SVL-364 Link */}
        <div className="shrink-0 border-b border-slate-800/70 bg-[#090D16] px-3 py-1.5 text-[11px] text-slate-400 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 font-mono">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex items-center gap-1.5 text-emerald-300 font-medium">
              <Brain className="w-3.5 h-3.5 text-emerald-400" />
              Pamięć Długotrwała 128D: AKTYWNA (64 tury / 16k ctx · {agataMemoriesCount} wspomnień SQLite WAL)
            </span>
            <span aria-hidden="true" className="text-slate-600">·</span>
            <span className={ollamaReachable ? 'text-cyan-300' : 'text-amber-300'}>
              Demon Ollama: {ollamaReachable ? `ONLINE 11434 (${ollamaModels.length} modeli)` : 'Łączenie...'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigateTab('svl364')}
              className="text-cyan-400 hover:text-cyan-300 hover:underline flex items-center gap-1"
            >
              <Rocket className="w-3 h-3" />
              <span>SVL-364 Ebon Apex (QKD-364)</span>
            </button>
          </div>
        </div>

        {/* Collapsible Secondary Controls */}
        {controlsExpanded && (
          <div className="border-b border-slate-800/80 bg-[#0D1018] shrink-0">
            <div className="px-3 py-1.5 border-b border-slate-800/60 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 font-mono tabular-nums">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-emerald-300 font-semibold">Uprawnienia: Agata Mitek (ROOT UID 0 · NOPASSWD: ALL)</span>
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
                  Ollama: {ollamaReachable ? `ONLINE (${ollamaModels.length})` : 'Offline'}
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

            <div className="px-3 py-1.5 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handleTriggerFullSync()}
                disabled={isSyncing}
                className="px-2 py-1 rounded bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 text-[11px] font-medium"
              >
                Synchronizuj globalnie
              </button>
              <button
                type="button"
                onClick={() => void handleEmitComprehensiveSvlReport()}
                disabled={isGeneratingSvlReport}
                className="px-2 py-1 rounded bg-cyan-600/20 border border-cyan-500/40 text-cyan-200 text-[11px] font-medium"
              >
                Wyemituj pełny raport SVL_System (Iris AI)
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
                onClick={() => onNavigateTab('svl364')}
                className="px-2 py-1 rounded bg-slate-800 text-cyan-300 text-[11px]"
              >
                Statek SVL-364 (Mapa Mass Effect)
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('infrastructure')}
                className="px-2 py-1 rounded bg-slate-800 text-emerald-300 text-[11px]"
              >
                Infrastruktura Floty &amp; Botanika
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('terminals')}
                className="px-2 py-1 rounded bg-slate-800 text-slate-300 text-[11px]"
              >
                Otwórz Terminale (4)
              </button>
              <button
                type="button"
                onClick={() => setAvatarSettingsOpen(true)}
                className="px-2 py-1 rounded bg-violet-600/20 border border-violet-500/40 text-violet-200 text-[11px] font-medium"
              >
                Awatary
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
          </div>
        )}

        {chatActionError && (
          <div role="alert" aria-live="assertive" className="px-4 py-2 border-b border-rose-500/40 bg-rose-950/40 text-rose-300 text-xs font-mono flex items-center justify-between gap-2">
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
        <div ref={messagesScrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5 md:p-5 space-y-3.5">
          {(activeConv?.messages || [])
            .filter((msg) => {
              const txt = String(msg.content || '').trim();
              if (txt.includes('ustaw: command not found')) return false;
              if (msg.sender === 'System SVL' || txt.startsWith('[Czat -> System]')) return false;
              if (
                msg.role === 'system' &&
                (msg.sender === 'Diagnostyka połączenia AI' ||
                  txt.includes('Nie udało się uzyskać odpowiedzi z żadnego silnika AI') ||
                  txt.includes('Serwer Ollama pod adresem http://127.0.0.1:11434 jest nieosiągalny'))
              ) {
                return false;
              }
              return true;
            })
            .map((msg) => {
              const isUser = msg.role === 'user';
              const isIris =
                msg.sender === 'Iris AI' ||
                msg.agentId === 'iris' ||
                Boolean(msg.metadata?.irisNotification) ||
                /^#?\s*🛰️\s*\[Iris\]\[\d+\]/.test(String(msg.content || '').trim()) ||
                /^\[Iris\]\[\d+\]/.test(String(msg.content || '').trim());
              const formattedSender = isUser ? msg.sender : isIris ? 'Iris AI' : formatAgentDisplayName(msg.sender);
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
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mb-1.5 px-1">
                    <SvlAvatar
                      sender={formattedSender}
                      agentId={isIris ? 'iris' : isUser ? 'operator' : msg.agentId || agentMeta?.id}
                      size={26}
                    />
                    <span
                      className={`font-semibold ${
                        isIris
                          ? 'text-cyan-300'
                          : agentMeta
                            ? agentMeta.textClass
                            : isUser
                              ? 'text-violet-300'
                              : 'text-slate-200'
                      }`}
                    >
                      {formattedSender}
                    </span>
                    {isIris && (
                      <span className="px-2 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/40 text-[10px] font-mono font-semibold text-cyan-200 uppercase tracking-wider">
                        SVL_System Telemetry &amp; Fleet Report
                      </span>
                    )}
                    {!isUser && !isIris && (
                      <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-[10px] font-mono text-emerald-300">
                        ROOT UID 0 · 128D Memory
                      </span>
                    )}
                    {msg.modelUsed && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono text-slate-500">{msg.modelUsed}</span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums text-slate-500">
                      {/^\d{4}-\d{2}-\d{2}T/.test(String(msg.timestamp || ''))
                        ? new Date(msg.timestamp).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
                        : msg.timestamp}
                    </span>
                    {isIris && (
                      <button
                        type="button"
                        onClick={() => onNavigateTab('notifications')}
                        className="text-cyan-400 hover:text-cyan-300 hover:underline font-mono text-[11px]"
                      >
                        Centrum Iris →
                      </button>
                    )}
                  </div>

                  <div
                    className={`max-w-4xl w-full rounded-xl p-4 border shadow-md ${
                      isUser
                        ? 'bg-violet-950/30 border-violet-500/35 text-slate-100 max-w-2xl'
                        : isIris
                          ? 'bg-gradient-to-br from-[#0A1524] via-[#0B1220] to-[#09101B] border-cyan-500/45 text-slate-100 shadow-[0_0_25px_rgba(6,182,212,0.08)]'
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

                    <div className="text-xs sm:text-sm break-words space-y-1">
                      {renderFormattedContent(msg.content, handleInteractiveAction)}
                    </div>

                    {msg.connectionReport && (
                      <div className="mt-4 pt-4 border-t border-slate-800 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                            <CheckCircle2 className="w-4 h-4" />
                            Zweryfikowano połączenie z SVL_System i uruchomiono lokalny worker Python (Agata Mitek)
                          </span>
                          <button
                            type="button"
                            onClick={() => onNavigateTab('agents')}
                            className="px-3 py-1 bg-violet-600 hover:bg-violet-500 text-white rounded text-xs font-medium transition-colors whitespace-nowrap"
                          >
                            Przejdź do Panelu Agentów
                          </button>
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
          {/* Quick Action Toolbar / Duplex Trigger */}
          <div className="max-w-4xl mx-auto mb-2.5 flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-1.5 overflow-x-auto py-0.5 scrollbar-none min-w-0">
              <button
                type="button"
                onClick={() => void handleTriggerProactiveChat()}
                disabled={isSending || isProactiveLoading}
                aria-label="Swobodna rozmowa AI — niech agent zainicjuje rozmowę"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 active:scale-95 text-white text-xs font-semibold transition-all shadow-md disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Sparkles className={`w-3.5 h-3.5 ${isProactiveLoading ? 'animate-spin' : ''}`} />
                <span>{isProactiveLoading ? 'AI myśli i pisze...' : '🎙️ Swobodna rozmowa AI'}</span>
              </button>

              <button
                type="button"
                onClick={() => void handleEmitComprehensiveSvlReport()}
                disabled={isSending || isGeneratingSvlReport}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/45 text-cyan-200 text-xs font-semibold transition-all disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <FileBarChart2 className="w-3.5 h-3.5 text-cyan-300" />
                <span>{isGeneratingSvlReport ? 'Generowanie raportu...' : '📊 Raport SVL_System'}</span>
              </button>

              <button
                type="button"
                onClick={() => setRealVisionOpen(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-violet-500/20 hover:bg-violet-500/30 border border-violet-500/45 text-violet-200 text-xs font-semibold transition-all cursor-pointer whitespace-nowrap shrink-0"
              >
                <ImageIcon className="w-3.5 h-3.5 text-violet-300" />
                <span>👁️ Real Vision (Ollama 3.2)</span>
              </button>

              <button
                type="button"
                onClick={() => void handleGenerateImage()}
                disabled={isSending || !input.trim()}
                aria-label="Wygeneruj obraz z wpisanego promptu"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-medium transition-all disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <ImageIcon className={`w-3.5 h-3.5 text-cyan-400 ${isGeneratingImage ? 'animate-pulse' : ''}`} />
                <span>{isGeneratingImage ? 'Generowanie...' : 'Generuj obraz'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  void handleSendMessage('/exec raport systemu');
                }}
                disabled={isSending}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-[#0B0D13] hover:bg-slate-800 border border-emerald-500/40 text-emerald-300 text-xs font-mono whitespace-nowrap shrink-0 transition-colors cursor-pointer"
              >
                <Terminal className="w-3 h-3 text-emerald-400" />
                <span>/exec raport systemu</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setInput('@work pełna diagnostyka statku SVL-364 i floty');
                  inputFieldRef.current?.focus();
                }}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-[#0B0D13] hover:bg-slate-800 border border-violet-500/40 text-violet-300 text-xs font-mono whitespace-nowrap shrink-0 transition-colors"
              >
                <span>@work</span>
              </button>
            </div>

            <div className="hidden sm:flex items-center gap-1.5 text-xs text-slate-400 font-mono shrink-0">
              <span className={`w-2 h-2 rounded-full ${duplexActive ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
              <span>{duplexActive ? 'Czat obustronny czuwa' : 'Tryb ręczny'}</span>
            </div>
          </div>

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
              ref={inputFieldRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Wpisz wiadomość, '/exec raport systemu' lub 'raport svl_system'..."
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
      {avatarSettingsOpen && (
        <AvatarSettingsModal onClose={() => setAvatarSettingsOpen(false)} />
      )}
      {realVisionOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="SVL Real Vision Ollama 3.2 Vision Studio"
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 md:p-6"
        >
          <RealVisionPanel
            mode="modal"
            onClose={() => setRealVisionOpen(false)}
            activeConversationId={activeConv?.id || 'conv-rodzina-mitek-wszyscy'}
            onAttachToChat={(img) => {
              setAttachedImage(img);
              setSelectedModel('ollama:llama3.2-vision:11b');
              setRealVisionOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
};
