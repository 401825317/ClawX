/**
 * Sidebar Component
 * Navigation sidebar with menu items.
 * No longer fixed - sits inside the flex layout below the title bar.
 */
import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Network,
  Bot,
  Puzzle,
  Clock,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeft,
  Plus,
  Terminal,
  ExternalLink,
  CreditCard,
  Trash2,
  Pencil,
  Check,
  X,
  Cpu,
  ImagePlus,
  Video,
  Moon,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { rendererExtensionRegistry } from '@/extensions/registry';
import { useSettingsStore } from '@/stores/settings';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { getSessionActivityMs, getSessionBucket, type SessionBucketKey } from './session-buckets';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { SIDEBAR_COLLAPSED_WIDTH, MAC_SIDEBAR_CHROME_HEIGHT } from '../../../shared/sidebar-layout';
import { useTranslation } from 'react-i18next';
import logoPng from '@/assets/logo-uclaw.png';
import { AnnouncementBell } from '@/components/client/AnnouncementBell';
import { SupportContactButton } from '@/components/client/SupportContactButton';
import type { ChatSession } from '@/stores/chat/types';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  badge?: string;
  collapsed?: boolean;
  onClick?: () => void;
  testId?: string;
}

function isRouteActive(pathname: string, targetPath: string): boolean {
  if (targetPath === '/') return pathname === '/';
  return pathname === targetPath || pathname.startsWith(`${targetPath}/`);
}

const NavItem = memo(function NavItem({ to, icon, label, badge, collapsed, onClick, testId }: NavItemProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const isActive = isRouteActive(location.pathname, to);

  return (
    <button
      type="button"
      onClick={() => {
        onClick?.();
        startTransition(() => {
          navigate(to);
        });
      }}
      data-testid={testId}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'sidebar-nav-text flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors',
        'hover:bg-black/5 dark:hover:bg-white/5 text-foreground/80',
        isActive ? 'bg-black/5 dark:bg-white/10 text-foreground' : '',
        collapsed && 'justify-center px-0',
      )}
    >
      <>
        <div className="flex shrink-0 items-center justify-center text-current [&_svg]:size-4">
          {icon}
        </div>
        {!collapsed && (
          <>
            <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
            {badge && (
              <Badge variant="secondary" className="ml-auto shrink-0">
                {badge}
              </Badge>
            )}
          </>
        )}
      </>
    </button>
  );
});

const INITIAL_NOW_MS = Date.now();
const DEFAULT_EXPANDED_SESSION_BUCKETS: Record<SessionBucketKey, boolean> = {
  today: true,
  withinWeek: true,
  withinMonth: false,
  older: false,
};

function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  const [, agentId] = sessionKey.split(':');
  return agentId || 'main';
}

type SessionBucketGroup = {
  key: SessionBucketKey;
  label: string;
  sessions: ChatSession[];
};

function resolveSessionLabel(
  sessionLabels: Record<string, string>,
  key: string,
  displayName?: string,
  label?: string,
): string {
  return sessionLabels[key] ?? label ?? displayName ?? key;
}

const SessionRow = memo(function SessionRow({
  session,
  sessionLabel,
  agentName,
  labels,
  isActive,
  isEditing,
  editingLabel,
  onClick,
  onStartRename,
  onEditingLabelChange,
  onRenameKeyDown,
  onRenameSubmit,
  onRenameCancel,
  onDelete,
}: {
  session: ChatSession;
  sessionLabel: string;
  agentName: string;
  labels: {
    renamePlaceholder: string;
    saveRename: string;
    cancelRename: string;
    rename: string;
    delete: string;
  };
  isActive: boolean;
  isEditing: boolean;
  editingLabel: string;
  onClick: (sessionKey: string) => void;
  onStartRename: (key: string, currentLabel: string) => void;
  onEditingLabelChange: (value: string) => void;
  onRenameKeyDown: (event: React.KeyboardEvent) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onDelete: (session: { key: string; label: string }) => void;
}) {
  if (isEditing) {
    return (
      <div className="group relative flex items-center">
        <div className="flex w-full items-center gap-1 px-1.5 py-1">
          <Input
            autoFocus
            value={editingLabel}
            onChange={(event) => onEditingLabelChange(event.target.value)}
            onKeyDown={onRenameKeyDown}
            onBlur={onRenameSubmit}
            className="h-7 min-w-0 flex-1 text-meta"
            aria-label={labels.renamePlaceholder}
          />
          <button
            aria-label={labels.saveRename}
            onMouseDown={(event) => { event.preventDefault(); onRenameSubmit(); }}
            className="flex shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            aria-label={labels.cancelRename}
            onMouseDown={(event) => { event.preventDefault(); onRenameCancel(); }}
            className="flex shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group relative flex items-center">
      <button
        data-testid={`sidebar-session-${session.key}`}
        onClick={() => onClick(session.key)}
        onDoubleClick={() => onStartRename(session.key, sessionLabel)}
        className={cn(
          'w-full text-left rounded-lg px-2.5 py-1.5 text-meta transition-colors pr-16',
          'hover:bg-black/5 dark:hover:bg-white/5',
          isActive
            ? 'bg-black/5 dark:bg-white/10 text-foreground font-medium'
            : 'text-foreground/75',
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded-full bg-black/[0.04] px-2 py-0.5 text-2xs font-medium text-foreground/70 dark:bg-white/[0.08]">
            {agentName}
          </span>
          <span className="truncate">{sessionLabel}</span>
        </div>
      </button>
      <div className={cn(
        'absolute right-1 flex items-center gap-0.5 transition-opacity',
        'opacity-0 group-hover:opacity-100',
      )}>
        <button
          aria-label={labels.rename}
          onClick={(event) => {
            event.stopPropagation();
            onStartRename(session.key, sessionLabel);
          }}
          className="flex items-center justify-center rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/10"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          aria-label={labels.delete}
          onClick={(event) => {
            event.stopPropagation();
            onDelete({
              key: session.key,
              label: sessionLabel,
            });
          }}
          className="flex items-center justify-center rounded p-0.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
});

const SessionHistoryList = memo(function SessionHistoryList({
  buckets,
  expandedBuckets,
  activeSessionKey,
  sessionLabels,
  agentNameById,
  editingSessionKey,
  editingLabel,
  onToggleBucket,
  onSessionClick,
  onStartRename,
  onEditingLabelChange,
  onRenameKeyDown,
  onRenameSubmit,
  onRenameCancel,
  onDeleteSession,
}: {
  buckets: SessionBucketGroup[];
  expandedBuckets: Record<SessionBucketKey, boolean>;
  activeSessionKey: string | null;
  sessionLabels: Record<string, string>;
  agentNameById: Record<string, string>;
  editingSessionKey: string | null;
  editingLabel: string;
  onToggleBucket: (bucketKey: SessionBucketKey) => void;
  onSessionClick: (sessionKey: string) => void;
  onStartRename: (key: string, currentLabel: string) => void;
  onEditingLabelChange: (value: string) => void;
  onRenameKeyDown: (event: React.KeyboardEvent) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onDeleteSession: (session: { key: string; label: string }) => void;
}) {
  const { t } = useTranslation(['common']);
  const rowLabels = useMemo(() => ({
    renamePlaceholder: t('common:sidebar.renameSessionPlaceholder'),
    saveRename: t('common:sidebar.saveSessionRename'),
    cancelRename: t('common:sidebar.cancelSessionRename'),
    rename: t('common:sidebar.renameSession'),
    delete: t('common:sidebar.deleteSession'),
  }), [t]);

  return (
    <div className="mt-4 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 space-y-1">
      {buckets.map((bucket) => {
        const isBucketExpanded = expandedBuckets[bucket.key] ?? false;
        return (
          <div key={bucket.key} data-testid={`session-bucket-${bucket.key}`} className="pt-2">
            <button
              type="button"
              data-testid={`session-bucket-toggle-${bucket.key}`}
              aria-expanded={isBucketExpanded}
              onClick={() => onToggleBucket(bucket.key)}
              className={cn(
                'flex w-full items-center gap-1 rounded-md px-2.5 py-1 text-left text-tiny font-medium',
                'text-muted-foreground/60 tracking-tight transition-colors',
                'hover:bg-black/5 hover:text-muted-foreground dark:hover:bg-white/5',
              )}
            >
              <ChevronRight
                className={cn(
                  'h-3 w-3 shrink-0 transition-transform',
                  isBucketExpanded && 'rotate-90',
                )}
              />
              <span>{bucket.label}</span>
            </button>
            {isBucketExpanded && bucket.sessions.map((session) => {
              const agentId = getAgentIdFromSessionKey(session.key);
              const sessionLabel = resolveSessionLabel(sessionLabels, session.key, session.displayName, session.label);
              return (
                <SessionRow
                  key={session.key}
                  session={session}
                  sessionLabel={sessionLabel}
                  agentName={agentNameById[agentId] || agentId}
                  labels={rowLabels}
                  isActive={activeSessionKey === session.key}
                  isEditing={editingSessionKey === session.key}
                  editingLabel={editingLabel}
                  onClick={onSessionClick}
                  onStartRename={onStartRename}
                  onEditingLabelChange={onEditingLabelChange}
                  onRenameKeyDown={onRenameKeyDown}
                  onRenameSubmit={onRenameSubmit}
                  onRenameCancel={onRenameCancel}
                  onDelete={onDeleteSession}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
});

const SidebarNavigation = memo(function SidebarNavigation({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const newSession = useChatStore((state) => state.newSession);
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const { t } = useTranslation(['common', 'chat']);
  const hiddenRoutes = useMemo(() => rendererExtensionRegistry.getHiddenRoutes(), []);
  const extraNavItems = useMemo(() => rendererExtensionRegistry.getExtraNavItems(), []);
  const navItems = useMemo(() => {
    const coreNavItems = [
      { to: '/models', icon: <Cpu className="h-4 w-4" strokeWidth={2} />, label: t('sidebar.models'), testId: 'sidebar-nav-models' },
      { to: '/agents', icon: <Bot className="h-4 w-4" strokeWidth={2} />, label: t('sidebar.agents'), testId: 'sidebar-nav-agents' },
      { to: '/channels', icon: <Network className="h-4 w-4" strokeWidth={2} />, label: t('sidebar.channels'), testId: 'sidebar-nav-channels' },
      { to: '/skills', icon: <Puzzle className="h-4 w-4" strokeWidth={2} />, label: t('sidebar.skills'), testId: 'sidebar-nav-skills' },
      { to: '/recharge', icon: <CreditCard className="h-4 w-4" strokeWidth={2} />, label: t('sidebar.recharge'), testId: 'sidebar-nav-recharge' },
      { to: '/cron', icon: <Clock className="h-4 w-4" strokeWidth={2} />, label: t('sidebar.cronTasks'), testId: 'sidebar-nav-cron' },
      ...(devModeUnlocked
        ? [
          { to: '/image-generation', icon: <ImagePlus className="h-4 w-4" strokeWidth={2} />, label: t('common:sidebar.imageGeneration'), testId: 'sidebar-nav-image-generation' },
          { to: '/video-generation', icon: <Video className="h-4 w-4" strokeWidth={2} />, label: t('common:sidebar.videoGeneration', 'Video Generation'), testId: 'sidebar-nav-video-generation' },
          { to: '/dreams', icon: <Moon className="h-4 w-4" strokeWidth={2} />, label: t('common:sidebar.openClawDreams'), testId: 'sidebar-nav-dreams' },
        ]
        : []),
    ];

    return [
      ...coreNavItems.filter((item) => !hiddenRoutes.has(item.to)),
      ...extraNavItems.map((item) => ({
        to: item.to,
        icon: <item.icon className="h-4 w-4" strokeWidth={2} />,
        label: item.labelI18nKey ? t(item.labelI18nKey) : item.label,
        testId: item.testId,
      })),
    ];
  }, [devModeUnlocked, extraNavItems, hiddenRoutes, t]);

  const handleNewChat = useCallback(() => {
    const { messages } = useChatStore.getState();
    if (messages.length > 0) newSession();
    startTransition(() => {
      navigate('/');
    });
  }, [navigate, newSession]);

  return (
    <nav className="flex flex-col gap-1 px-2">
      <button
        type="button"
        data-testid="sidebar-new-chat"
        onClick={handleNewChat}
        className={cn(
          'sidebar-nav-text flex items-center gap-2 rounded-lg px-2.5 py-2 transition-colors',
          'hover:bg-black/5 dark:hover:bg-white/5 text-foreground/80',
          collapsed && 'justify-center px-0',
        )}
      >
        <div className="flex shrink-0 items-center justify-center text-current [&_svg]:size-4">
          <Plus className="h-4 w-4" strokeWidth={2} />
        </div>
        {!collapsed && <span className="flex-1 text-left overflow-hidden text-ellipsis whitespace-nowrap">{t('sidebar.newChat')}</span>}
      </button>

      {navItems.map((item) => (
        <NavItem
          key={item.to}
          {...item}
          collapsed={collapsed}
        />
      ))}
    </nav>
  );
});

function SidebarComponent() {
  const isMac = window.electron?.platform === 'darwin';
  const sidebarCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useSettingsStore((state) => state.setSidebarCollapsed);
  const sidebarWidth = useSettingsStore((state) => state.sidebarWidth);
  const setSidebarWidth = useSettingsStore((state) => state.setSidebarWidth);
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const [isResizing, setIsResizing] = useState(false);
  const stopResizeRef = useRef<(() => void) | null>(null);

  const sessions = useChatStore((s) => s.sessions);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sessionLabels = useChatStore((s) => s.sessionLabels);
  const sessionLastActivity = useChatStore((s) => s.sessionLastActivity);
  const switchSession = useChatStore((s) => s.switchSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const renameSession = useChatStore((s) => s.renameSession);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const loadHistory = useChatStore((s) => s.loadHistory);

  const gatewayStatus = useGatewayStore((s) => s.status);
  const isGatewayRunning = gatewayStatus.state === 'running';
  const isGatewayReady = isGatewayRunning && gatewayStatus.gatewayReady !== false;
  const gatewayRuntimeKey = `${gatewayStatus.pid ?? 'none'}:${gatewayStatus.connectedAt ?? 'none'}:${gatewayStatus.port}`;

  const hasLoadedCurrentRuntimeRef = useRef(false);

  useEffect(() => {
    hasLoadedCurrentRuntimeRef.current = false;
  }, [gatewayRuntimeKey]);

  useEffect(() => {
    if (!isGatewayReady) return;
    let cancelled = false;
    (async () => {
      await loadSessions();
      if (cancelled) return;
      if (hasLoadedCurrentRuntimeRef.current) return;
      hasLoadedCurrentRuntimeRef.current = true;
      await loadHistory(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [gatewayRuntimeKey, isGatewayReady, loadHistory, loadSessions]);
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  useEffect(() => {
    if (!isMac) return;
    void invokeIpc('window:syncTrafficLightPosition', sidebarCollapsed);
  }, [isMac, sidebarCollapsed]);

  const navigate = useNavigate();

  const openControlUi = async (path: string, label: string) => {
    try {
      const result = await hostApiFetch<{
        success: boolean;
        url?: string;
        error?: string;
      }>(path);
      if (result.success && result.url) {
        await window.electron.openExternal(result.url);
      } else {
        console.error(`Failed to get ${label} URL:`, result.error);
      }
    } catch (err) {
      console.error(`Error opening ${label}:`, err);
    }
  };

  const openDevConsole = async () => {
    await openControlUi('/api/gateway/control-ui', 'OpenClaw Page');
  };

  const { t } = useTranslation(['common', 'chat']);
  const [sessionToDelete, setSessionToDelete] = useState<{ key: string; label: string } | null>(null);
  const [editingSessionKey, setEditingSessionKey] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [nowMs, setNowMs] = useState(INITIAL_NOW_MS);
  const [expandedSessionBuckets, setExpandedSessionBuckets] = useState<Record<SessionBucketKey, boolean>>(
    () => ({ ...DEFAULT_EXPANDED_SESSION_BUCKETS }),
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (agents.length > 0) return;
    const timer = window.setTimeout(() => {
      void fetchAgents({ quiet: true });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [agents.length, fetchAgents]);

  const handleStartRename = useCallback((key: string, currentLabel: string) => {
    setEditingSessionKey(key);
    setEditingLabel(currentLabel);
  }, []);

  const handleRenameSubmit = useCallback(async () => {
    if (!editingSessionKey || !editingLabel.trim()) {
      setEditingSessionKey(null);
      return;
    }
    try {
      await renameSession(editingSessionKey, editingLabel.trim());
    } catch (err) {
      console.error('Failed to rename session:', err);
    }
    setEditingSessionKey(null);
  }, [editingLabel, editingSessionKey, renameSession]);

  const handleRenameCancel = useCallback(() => {
    setEditingSessionKey(null);
  }, []);

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleRenameSubmit();
    } else if (e.key === 'Escape') {
      handleRenameCancel();
    }
  }, [handleRenameCancel, handleRenameSubmit]);

  const toggleSessionBucket = useCallback((bucketKey: SessionBucketKey) => {
    setExpandedSessionBuckets((current) => ({
      ...current,
      [bucketKey]: !current[bucketKey],
    }));
  }, []);

  const handleSessionClick = useCallback((sessionKey: string) => {
    if (currentSessionKey === sessionKey) {
      void loadHistory(false);
    } else {
      switchSession(sessionKey);
    }
    startTransition(() => {
      navigate('/');
    });
  }, [currentSessionKey, loadHistory, navigate, switchSession]);

  const submitRenameFromList = useCallback(() => {
    void handleRenameSubmit();
  }, [handleRenameSubmit]);

  const stopResizing = useCallback(() => {
    stopResizeRef.current?.();
    stopResizeRef.current = null;
    setIsResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (sidebarCollapsed) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Window listeners below keep dragging reliable even if capture is unavailable.
      }

      const onMove = (moveEvent: PointerEvent) => {
        setSidebarWidth(moveEvent.clientX);
      };
      const onUp = () => stopResizing();

      stopResizeRef.current = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      setIsResizing(true);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [setSidebarWidth, sidebarCollapsed, stopResizing],
  );

  useEffect(() => stopResizing, [stopResizing]);

  const agentNameById = useMemo(
    () => Object.fromEntries((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const sessionBuckets = useMemo<SessionBucketGroup[]>(() => {
    const buckets: SessionBucketGroup[] = [
      { key: 'today', label: t('chat:historyBuckets.today'), sessions: [] },
      { key: 'withinWeek', label: t('chat:historyBuckets.withinWeek'), sessions: [] },
      { key: 'withinMonth', label: t('chat:historyBuckets.withinMonth'), sessions: [] },
      { key: 'older', label: t('chat:historyBuckets.older'), sessions: [] },
    ];
    const sessionBucketMap = Object.fromEntries(buckets.map((bucket) => [bucket.key, bucket])) as Record<
      SessionBucketKey,
      (typeof buckets)[number]
    >;

    for (const { session, activityMs } of sessions
      .map((session) => ({
        session,
        activityMs: getSessionActivityMs(session, sessionLastActivity),
      }))
      .sort((a, b) => b.activityMs - a.activityMs)) {
      const bucketKey = getSessionBucket(activityMs, nowMs);
      sessionBucketMap[bucketKey].sessions.push(session);
    }

    return buckets;
  }, [sessions, sessionLastActivity, nowMs, t]);

  return (
    <aside
      data-testid="sidebar"
      className={cn(
        'relative flex min-h-0 shrink-0 flex-col overflow-hidden bg-surface-sidebar',
        isResizing ? 'transition-none' : 'transition-[width] duration-300',
      )}
      style={{ width: sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth }}
    >
      {isMac && (
        <div
          aria-hidden="true"
          data-testid="mac-sidebar-chrome"
          className="drag-region shrink-0"
          style={{ height: MAC_SIDEBAR_CHROME_HEIGHT }}
        />
      )}

      {/* Top Header Toggle */}
      <div
        className={cn(
          'flex shrink-0 items-center p-2',
          sidebarCollapsed ? 'min-h-16' : 'h-8',
          sidebarCollapsed ? 'justify-center' : 'justify-between',
        )}
      >
        {!sidebarCollapsed && (
          <div className="flex items-center gap-2 px-2 overflow-hidden">
            <img src={logoPng} alt="UClaw" className="h-5 w-auto shrink-0" />
            <span className="text-sm font-semibold truncate whitespace-nowrap text-foreground/90">
              UClaw
            </span>
          </div>
        )}
        <div className={cn('flex items-center gap-1', sidebarCollapsed && 'flex-col')}>
          <AnnouncementBell
            collapsed={sidebarCollapsed}
            sidebarOffset={sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth}
          />
          <Button
            data-testid="sidebar-collapse-toggle"
            variant="ghost"
            size="icon"
            className={cn(
              'no-drag h-8 w-8 shrink-0 rounded-lg text-foreground/80',
              'hover:bg-black/5 hover:text-foreground/80 dark:hover:bg-white/5',
            )}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            {sidebarCollapsed ? (
              <PanelLeft className="h-[18px] w-[18px]" />
            ) : (
              <PanelLeftClose className="h-[18px] w-[18px]" />
            )}
          </Button>
        </div>
      </div>

      <SidebarNavigation collapsed={sidebarCollapsed} />

      {/* Session list - below Settings, only when expanded */}
      {!sidebarCollapsed && sessions.length > 0 && (
        <SessionHistoryList
          buckets={sessionBuckets}
          expandedBuckets={expandedSessionBuckets}
          activeSessionKey={currentSessionKey}
          sessionLabels={sessionLabels}
          agentNameById={agentNameById}
          editingSessionKey={editingSessionKey}
          editingLabel={editingLabel}
          onToggleBucket={toggleSessionBucket}
          onSessionClick={handleSessionClick}
          onStartRename={handleStartRename}
          onEditingLabelChange={setEditingLabel}
          onRenameKeyDown={handleRenameKeyDown}
          onRenameSubmit={submitRenameFromList}
          onRenameCancel={handleRenameCancel}
          onDeleteSession={setSessionToDelete}
        />
      )}
      {/* Footer */}
      <div className="mt-auto flex flex-col gap-1 p-2">
        <SupportContactButton
          collapsed={sidebarCollapsed}
          sidebarOffset={sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth}
        />

        <NavItem
          to="/settings"
          icon={<SettingsIcon className="h-4 w-4" strokeWidth={2} />}
          label={t('sidebar.settings')}
          collapsed={sidebarCollapsed}
          testId="sidebar-nav-settings"
        />

        {devModeUnlocked && (
          <Button
            data-testid="sidebar-open-dev-console"
            variant="ghost"
            className={cn(
              'sidebar-nav-text flex h-auto w-full items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors',
              'hover:bg-black/5 dark:hover:bg-white/5 text-foreground/80',
              sidebarCollapsed ? 'justify-center px-0' : 'justify-start'
            )}
            onClick={openDevConsole}
          >
            <div className="flex shrink-0 items-center justify-center text-current [&_svg]:size-4">
              <Terminal className="h-4 w-4" strokeWidth={2} />
            </div>
            {!sidebarCollapsed && (
              <>
                <span className="flex-1 text-left overflow-hidden text-ellipsis whitespace-nowrap">{t('common:sidebar.openClawPage')}</span>
                <ExternalLink className="ml-auto h-3 w-3 shrink-0 opacity-50 text-current" />
              </>
            )}
          </Button>
        )}
      </div>

      {!sidebarCollapsed && (
        <div
          data-testid="sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={420}
          aria-valuenow={sidebarWidth}
          title="Drag to resize sidebar"
          onPointerDown={handleResizePointerDown}
          className="no-drag group absolute inset-y-0 right-0 z-20 w-2 translate-x-1/2 cursor-col-resize select-none"
        >
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-primary/40"
          />
        </div>
      )}

      <ConfirmDialog
        open={!!sessionToDelete}
        title={t('common:actions.confirm')}
        message={t('common:sidebar.deleteSessionConfirm', { label: sessionToDelete?.label })}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={async () => {
          if (!sessionToDelete) return;
          await deleteSession(sessionToDelete.key);
          if (currentSessionKey === sessionToDelete.key) navigate('/');
          setSessionToDelete(null);
        }}
        onCancel={() => setSessionToDelete(null)}
      />
    </aside>
  );
}

export const Sidebar = memo(SidebarComponent);
