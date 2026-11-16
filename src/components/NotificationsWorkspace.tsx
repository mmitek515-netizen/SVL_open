import React, { useMemo, useState } from 'react';
import {
  Bell,
  CheckCheck,
  FileBarChart2,
  Filter,
  MessageSquare,
  RefreshCw,
  Send,
  ShieldAlert,
  SlidersHorizontal,
} from 'lucide-react';
import { useSvlSync } from '../utils/svlSyncStore';
import { IrisNotification, safeFetchJson } from '../utils/svlLogic';
import { SvlAvatar } from './AgentAvatar';
import { renderFormattedContent } from './ChatWorkspace';

interface NotificationsWorkspaceProps {
  onNavigateTab: (tab: 'chat' | 'svl364' | 'notifications' | 'infrastructure' | 'agents' | 'terminals' | 'kernel' | 'linux') => void;
}

type CategoryFilter = 'all' | 'unread' | 'svl_system' | 'agents_work' | 'system' | 'github';

export const NotificationsWorkspace: React.FC<NotificationsWorkspaceProps> = ({ onNavigateTab }) => {
  const {
    tabOrigin,
    irisNotifications,
    irisUnreadCount,
    systemModules,
    agentsData,
    healthData,
    serverRevision,
    isSyncing,
    emitIrisNotification,
    ackIrisNotifications,
    refreshAllDomains,
    refreshDomainModules,
    upsertSystemModule,
    openFamilyChannel,
  } = useSvlSync();

  const [filterMode, setFilterMode] = useState<CategoryFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [customNote, setCustomNote] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isAcking, setIsAcking] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const irisModule = systemModules.find((m) => m.id === 'svl-iris-01');
  const centerModule = systemModules.find((m) => m.id === 'svl-notification-center');
  const controlModule = systemModules.find((m) => m.id === 'svl-notif-control-iris');

  const detailLevel = String(controlModule?.config?.detail_level || 'maximum');
  const frequency = String(controlModule?.config?.frequency || 'continuous');
  const targetChannel = String(controlModule?.config?.channel || 'wszyscy');

  const agentsList: any[] = Array.isArray(agentsData?.agents) ? agentsData.agents : [];
  const activeWorkers = agentsList.filter((a) =>
    ['ONLINE_LOCAL_WORKER', 'BUSY_LOCAL_WORKER'].includes(a.status),
  ).length;

  const filteredNotifications = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return irisNotifications.filter((item) => {
      if (filterMode === 'unread' && item.isRead) return false;
      if (filterMode !== 'all' && filterMode !== 'unread') {
        if (filterMode === 'github') {
          const isGh = item.category.includes('github') || item.title.toLowerCase().includes('github');
          if (!isGh) return false;
        } else if (filterMode === 'svl_system') {
          const isSvl =
            item.category === 'svl_system' ||
            item.category === 'system' ||
            item.title.toLowerCase().includes('svl_system') ||
            item.title.toLowerCase().includes('svl-364');
          if (!isSvl) return false;
        } else if (item.category !== filterMode) {
          return false;
        }
      }
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.message.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        `[iris][${item.seqNum}]`.includes(q)
      );
    });
  }, [filterMode, irisNotifications, searchQuery]);

  const handleEmitReport = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isSending) return;
    setIsSending(true);
    setFeedback(null);
    try {
      const note = customNote.trim();
      if (!note) {
        const res = await safeFetchJson<{
          ok: boolean;
          notification?: IrisNotification;
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
        await refreshDomainModules(['notifications', 'chat', 'modules', 'kernel']);
        if (res.ok && res.data?.ok) {
          setFeedback(
            `Wyemitowano pełny wielosekcyjny raport SVL_System [Iris][${res.data.notification?.seqNum ?? '?'}] do Centrum Powiadomień i na kanał Rodzina Mitek (wszyscy).`,
          );
        } else {
          setFeedback(res.error || res.data?.error || 'Błąd generowania raportu SVL_System.');
        }
        return;
      }

      const title = note.slice(0, 140);
      const res = await emitIrisNotification({
        severity: 'INFO',
        category: 'svl_system',
        title,
        message: note,
        details: {
          workers_online: activeWorkers,
          modules_count: systemModules.length,
          server_revision: serverRevision,
          detail_level: detailLevel,
          ollama_online: Boolean(healthData?.ollama?.daemon_reachable),
          source: 'notification_center_ui',
        },
        mirrorToFamilyChat: true,
      });
      if (res.ok && res.notification) {
        setCustomNote('');
        setFeedback(`Wysłano szczegółowy komunikat [Iris][${res.notification.seqNum}] na kanał Rodzina Mitek (wszyscy).`);
      } else {
        setFeedback(res.error || 'Błąd emisji powiadomienia Iris.');
      }
    } finally {
      setIsSending(false);
    }
  };

  const handleMarkAllRead = async () => {
    if (isAcking || irisUnreadCount === 0) return;
    setIsAcking(true);
    setFeedback(null);
    try {
      const res = await ackIrisNotifications();
      if (res.ok) {
        setFeedback('Oznaczono wszystkie powiadomienia Iris jako przeczytane.');
      } else {
        setFeedback(res.error || 'Nie udało się potwierdzić powiadomień.');
      }
    } finally {
      setIsAcking(false);
    }
  };

  const handleToggleControlMode = async () => {
    const nextDetail = detailLevel === 'maximum' ? 'standard' : 'maximum';
    await upsertSystemModule({
      id: 'svl-notif-control-iris',
      name: controlModule?.name || 'Iris Notification & Research Monitor',
      kind: controlModule?.kind || 'Notification Control Engine',
      status: 'ACTIVE',
      config: {
        ...(controlModule?.config || {}),
        mode: 'active',
        channel: 'wszyscy',
        frequency: 'continuous',
        detail_level: nextDetail,
        format_template: '[Iris][{count}] {severity}: {message}',
      },
    });
    setFeedback(`Zapisano szczegółowość Iris w SQLite: ${nextDetail}.`);
  };

  const handleInteractiveAction = (actionValue: string) => {
    const val = actionValue.trim();
    if (val.startsWith('tab:')) {
      const tabName = val.slice(4).trim();
      if (['chat', 'svl364', 'notifications', 'infrastructure', 'agents', 'terminals', 'kernel', 'linux'].includes(tabName)) {
        onNavigateTab(tabName as any);
      }
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#090D16] text-slate-100">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-5 space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-cyan-500/20 pb-4">
          <div className="flex items-start gap-3">
            <SvlAvatar profileKey="Iris" size={44} className="mt-0.5" />
            <div className="space-y-1">
              <p className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-cyan-400 font-mono">
                <Bell size={15} /> SVL Notification Center (Iris AI · SVL_System)
              </p>
              <h1 className="text-xl sm:text-2xl font-semibold">Centrum Raportów i Powiadomień Iris AI</h1>
              <p className="text-xs sm:text-sm text-slate-400">
                Wielosekcyjne raporty <span className="font-mono text-cyan-300">[Iris][N]</span> z telemetrią statku <span className="font-mono text-cyan-200">SVL-364 Ebon Apex</span> i floty publikowane na kanale <span className="text-emerald-300 font-medium">Rodzina Mitek (wszyscy)</span>.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleEmitReport()}
              disabled={isSending}
              className="flex items-center gap-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 px-3 py-2 text-xs font-semibold text-white shadow-sm disabled:opacity-50"
            >
              <FileBarChart2 size={14} /> Wyemituj pełny raport SVL_System
            </button>
            <button
              type="button"
              onClick={() => {
                openFamilyChannel();
                onNavigateTab('chat');
              }}
              className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-200 hover:bg-emerald-500/25"
            >
              <MessageSquare size={14} /> Kanał wszyscy
            </button>
            <button
              type="button"
              onClick={() => void handleMarkAllRead()}
              disabled={isAcking || irisUnreadCount === 0}
              className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40"
            >
              <CheckCheck size={14} /> Oznacz przeczytane ({irisUnreadCount})
            </button>
            <button
              type="button"
              onClick={() => void refreshAllDomains('notifications_tab_refresh')}
              disabled={isSyncing}
              className="flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-3 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-40"
            >
              <RefreshCw size={14} className={isSyncing ? 'animate-spin' : ''} /> Synchronizuj
            </button>
          </div>
        </header>

        {/* Active Iris Notification Module Status Strip */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3" aria-label="Moduły powiadomień Iris w SQLite">
          <div className="rounded-xl border border-slate-800 bg-[#111826] p-3.5 space-y-1">
            <p className="text-xs text-slate-400">Moduł koordynatora</p>
            <p className="text-sm font-semibold text-cyan-300">
              {irisModule?.name || 'svl-iris-01'}
            </p>
            <p className="text-[11px] font-mono text-slate-400">
              id: {irisModule?.id || 'svl-iris-01'} · status: {irisModule?.status || 'ACTIVE'} · rev {irisModule?.revision || 1}
            </p>
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#111826] p-3.5 space-y-1">
            <p className="text-xs text-slate-400">Panel powiadomień (/notifications)</p>
            <p className="text-sm font-semibold text-slate-100">
              {centerModule?.name || 'svl-notification-center'}
            </p>
            <p className="text-[11px] font-mono text-slate-400">
              odświeżanie: {centerModule?.config?.refresh_interval_ms || 3000} ms · razem: {irisNotifications.length} · nieprzeczytane: {irisUnreadCount}
            </p>
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#111826] p-3.5 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-slate-400">Kontrola formatu Iris</p>
              <button
                type="button"
                onClick={() => void handleToggleControlMode()}
                className="inline-flex items-center gap-1 text-[11px] font-mono text-violet-300 hover:underline"
              >
                <SlidersHorizontal size={12} /> Tryb: {detailLevel}
              </button>
            </div>
            <p className="text-sm font-semibold text-slate-100 font-mono">
              SVL_System Multi-Section Markdown Report
            </p>
            <p className="text-[11px] font-mono text-slate-400">
              kanał: {targetChannel} · częstotliwość: {frequency}
            </p>
          </div>
        </section>

        {/* Emit / Broadcast Control */}
        <section className="rounded-xl border border-cyan-500/30 bg-[#111826] p-4 space-y-3">
          <form onSubmit={(e) => void handleEmitReport(e)} className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={customNote}
              onChange={(e) => setCustomNote(e.target.value)}
              placeholder="Wpisz własny komunikat Iris AI lub pozostaw puste, aby wygenerować pełny raport SVL_System..."
              aria-label="Treść powiadomienia Iris AI"
              className="flex-1 min-w-[240px] rounded-lg border border-slate-700 bg-[#0B0D13] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
            />
            <button
              type="submit"
              disabled={isSending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 px-3.5 py-2 text-xs font-semibold text-white whitespace-nowrap"
            >
              <Send size={13} />
              {isSending
                ? 'Generowanie...'
                : customNote.trim()
                  ? 'Wyślij jako Iris AI'
                  : 'Wygeneruj pełny raport SVL_System'}
            </button>
          </form>
          {feedback && (
            <p role="status" className="text-xs font-mono text-emerald-300">
              {feedback}
            </p>
          )}
        </section>

        {/* Filter & Search Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Filter size={13} className="text-slate-400 mr-1" />
            {(
              [
                ['all', 'Wszystkie'],
                ['unread', `Nieprzeczytane (${irisUnreadCount})`],
                ['svl_system', 'Raporty SVL_System'],
                ['agents_work', '@work'],
                ['system', 'System'],
                ['github', 'GitHub'],
              ] as Array<[CategoryFilter, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilterMode(key)}
                className={`px-2.5 py-1 rounded-md border font-medium transition-colors ${
                  filterMode === key
                    ? 'border-cyan-500/60 bg-cyan-500/20 text-cyan-200'
                    : 'border-slate-800 bg-[#111520] text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Szukaj w raportach Iris..."
            aria-label="Szukaj powiadomień Iris"
            className="w-full sm:w-64 rounded-md border border-slate-800 bg-[#0B0D13] px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
          />
        </div>

        {/* Feed List */}
        <section className="space-y-3" aria-label="Lista powiadomień Iris AI">
          {filteredNotifications.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-[#111826] p-8 text-center space-y-2">
              <ShieldAlert size={22} className="mx-auto text-slate-500" />
              <p className="text-sm font-medium text-slate-300">Brak powiadomień spełniających wybrane kryteria.</p>
              <p className="text-xs text-slate-500">
                Uruchom „Wygeneruj pełny raport SVL_System” albo wykonaj polecenie `@work` na czacie.
              </p>
            </div>
          ) : (
            filteredNotifications.map((item: IrisNotification) => {
              const sevColor =
                item.severity === 'ALERT'
                  ? 'text-rose-300 border-rose-500/40 bg-rose-950/30'
                  : item.severity === 'WARN'
                    ? 'text-amber-300 border-amber-500/40 bg-amber-950/30'
                    : 'text-cyan-300 border-cyan-500/40 bg-cyan-950/30';
              const isExpanded = expandedId === item.id;
              return (
                <article
                  key={item.id}
                  className={`rounded-xl border bg-gradient-to-br from-[#0D1524] via-[#0E1625] to-[#090F1A] p-4 space-y-2.5 transition-colors shadow-md ${
                    item.isRead ? 'border-slate-800/80 opacity-90' : 'border-cyan-500/45'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs pb-2 border-b border-slate-800/70">
                    <div className="flex flex-wrap items-center gap-2 font-mono">
                      <SvlAvatar profileKey="Iris" size={24} />
                      <span className={`font-semibold px-2 py-0.5 rounded border ${sevColor} tabular-nums`}>
                        [Iris][{item.seqNum}] {item.severity}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-cyan-200">
                        {item.category}
                      </span>
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      <span className="text-emerald-300">kanał: {item.channel}</span>
                      {!item.isRead && (
                        <>
                          <span aria-hidden="true" className="text-slate-600">·</span>
                          <span className="text-emerald-400 font-semibold">NOWY RAPORT</span>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400">
                      <span className="tabular-nums">
                        {item.createdAt ? new Date(item.createdAt).toLocaleString('pl-PL') : ''}
                      </span>
                      {!item.isRead && (
                        <button
                          type="button"
                          onClick={() => void ackIrisNotifications([item.id])}
                          className="text-cyan-400 hover:underline"
                        >
                          Przeczytane
                        </button>
                      )}
                      {item.details && Object.keys(item.details).length > 0 && (
                        <button
                          type="button"
                          onClick={() => setExpandedId(isExpanded ? null : item.id)}
                          className="text-slate-400 hover:text-slate-200"
                        >
                          {isExpanded ? 'Ukryj JSON' : 'Metadane JSON'}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="text-xs sm:text-sm text-slate-200 leading-relaxed space-y-1">
                    {renderFormattedContent(item.message || item.title, handleInteractiveAction)}
                  </div>
                  {isExpanded && item.details && (
                    <pre className="rounded-lg border border-slate-800 bg-[#080C13] p-2.5 text-[11px] font-mono text-slate-300 overflow-x-auto">
                      {JSON.stringify(item.details, null, 2)}
                    </pre>
                  )}
                </article>
              );
            })
          )}
        </section>
      </div>
    </div>
  );
};
