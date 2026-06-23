import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AlertCircle, Bot, Check, Plus, RefreshCw, Settings2, Trash2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Switch } from '@/components/ui/switch';
import { useAgentsStore } from '@/stores/agents';
import { useChatStore } from '@/stores/chat';
import type { ChatRuntimeRunState, ChatSession } from '@/stores/chat/types';
import { useGatewayStore } from '@/stores/gateway';
import { useProviderStore } from '@/stores/providers';
import { subscribeHostEvent } from '@/lib/host-events';
import { fetchChannelsAccounts } from '@/pages/Channels/channel-accounts-cache';
import { CHANNEL_ICONS, CHANNEL_NAMES, type ChannelType } from '@/types/channel';
import type { AgentProfileDraft, AgentSummary } from '@/types/agent';
import {
  buildRuntimeProviderOptions,
  formatModelDisplayLabel,
  splitModelRef,
  type RuntimeProviderOption,
} from '@/lib/model-options';
import { AGENT_AVATARS, getAgentAvatar } from '@/lib/agent-avatars';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import telegramIcon from '@/assets/channels/telegram.svg';
import discordIcon from '@/assets/channels/discord.svg';
import whatsappIcon from '@/assets/channels/whatsapp.svg';
import wechatIcon from '@/assets/channels/wechat.svg';
import dingtalkIcon from '@/assets/channels/dingtalk.svg';
import feishuIcon from '@/assets/channels/feishu.svg';
import wecomIcon from '@/assets/channels/wecom.svg';
import qqIcon from '@/assets/channels/qq.svg';

interface ChannelAccountItem {
  accountId: string;
  name: string;
  configured: boolean;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  lastError?: string;
  isDefault: boolean;
  agentId?: string;
}

interface ChannelGroupItem {
  channelType: string;
  defaultAccountId: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  accounts: ChannelAccountItem[];
}

type AgentWorkStatus = 'running' | 'completed';
type FetchChannelAccountsOptions = { deferIfBusy?: boolean; force?: boolean };

const AGENTS_BUSY_REFRESH_DEFER_MS = 30_000;
const RUNNING_SESSION_STATUSES = new Set(['running', 'active', 'queued', 'in_progress', 'processing']);

function normalizeAgentId(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase() || 'main';
}

function getAgentIdFromSessionKey(sessionKey: string | undefined | null): string {
  if (!sessionKey?.startsWith('agent:')) return 'main';
  const [, agentId] = sessionKey.split(':');
  return normalizeAgentId(agentId);
}

function isRunningSession(session: ChatSession): boolean {
  if (session.hasActiveRun === true) return true;
  const status = session.status?.trim().toLowerCase();
  return Boolean(status && RUNNING_SESSION_STATUSES.has(status));
}

function getRunningAgentIds(
  state: {
    sessions: ChatSession[];
    currentSessionKey: string;
    currentAgentId: string;
    sending: boolean;
    runtimeRuns: Record<string, ChatRuntimeRunState>;
  },
): string[] {
  const ids = new Set<string>();
  if (state.sending) {
    const sendingAgentId = normalizeAgentId(state.currentAgentId || getAgentIdFromSessionKey(state.currentSessionKey));
    ids.add(sendingAgentId);
  }

  for (const session of state.sessions) {
    if (isRunningSession(session)) {
      ids.add(getAgentIdFromSessionKey(session.key));
    }
  }

  for (const run of Object.values(state.runtimeRuns)) {
    if (run.status === 'running') {
      ids.add(getAgentIdFromSessionKey(run.sessionKey));
    }
  }

  return Array.from(ids).sort();
}

function getRunningAgentKey(state: {
  sessions: ChatSession[];
  currentSessionKey: string;
  currentAgentId: string;
  sending: boolean;
  runtimeRuns: Record<string, ChatRuntimeRunState>;
}): string {
  return getRunningAgentIds(state).join('|');
}

export function Agents() {
  const { t } = useTranslation('agents');
  const navigate = useNavigate();
  const gatewayStatus = useGatewayStore((state) => state.status);
  const switchSession = useChatStore((state) => state.switchSession);
  const runningAgentKey = useChatStore(getRunningAgentKey);
  const refreshProviderSnapshot = useProviderStore((state) => state.refreshProviderSnapshot);
  const lastGatewayStateRef = useRef(gatewayStatus.state);
  const {
    agents,
    loading,
    error,
    fetchAgents,
    createAgent,
    generateAgentProfile,
    deleteAgent,
  } = useAgentsStore();
  const [channelGroups, setChannelGroups] = useState<ChannelGroupItem[]>([]);

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [agentToDelete, setAgentToDelete] = useState<AgentSummary | null>(null);
  const deferredChannelRefreshRef = useRef<number | null>(null);
  const hasActiveRunRef = useRef(false);
  const fetchChannelAccountsRef = useRef<((options?: FetchChannelAccountsOptions) => Promise<void>) | null>(null);

  const runningAgentIds = useMemo(
    () => new Set(runningAgentKey ? runningAgentKey.split('|') : []),
    [runningAgentKey],
  );
  const hasActiveRun = runningAgentIds.size > 0;
  useEffect(() => {
    hasActiveRunRef.current = hasActiveRun;
  }, [hasActiveRun]);

  const clearDeferredChannelRefresh = useCallback(() => {
    if (deferredChannelRefreshRef.current != null) {
      window.clearTimeout(deferredChannelRefreshRef.current);
      deferredChannelRefreshRef.current = null;
    }
  }, []);

  const scheduleChannelRefreshWhenIdle = useCallback((callback: () => void) => {
    clearDeferredChannelRefresh();
    deferredChannelRefreshRef.current = window.setTimeout(() => {
      deferredChannelRefreshRef.current = null;
      callback();
    }, AGENTS_BUSY_REFRESH_DEFER_MS);
  }, [clearDeferredChannelRefresh]);

  const fetchChannelAccounts = useCallback(async (options?: FetchChannelAccountsOptions) => {
    if (options?.deferIfBusy === true && hasActiveRunRef.current) {
      scheduleChannelRefreshWhenIdle(() => {
        void fetchChannelAccountsRef.current?.({ deferIfBusy: true });
      });
      return;
    }
    try {
      const response = await fetchChannelsAccounts<{ success: boolean; channels?: ChannelGroupItem[] }>(
        '/api/channels/accounts?mode=config',
        { force: options?.force === true },
      );
      setChannelGroups(response.channels || []);
    } catch {
      // Keep the last rendered snapshot when channel account refresh fails.
    }
  }, [scheduleChannelRefreshWhenIdle]);
  useEffect(() => {
    fetchChannelAccountsRef.current = fetchChannelAccounts;
    return () => {
      if (fetchChannelAccountsRef.current === fetchChannelAccounts) {
        fetchChannelAccountsRef.current = null;
      }
    };
  }, [fetchChannelAccounts]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void Promise.all([fetchAgents({ quiet: agents.length > 0 }), fetchChannelAccounts({ deferIfBusy: true })]);
      void refreshProviderSnapshot({ quiet: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [agents.length, fetchAgents, fetchChannelAccounts, refreshProviderSnapshot]);

  useEffect(() => {
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;

    const unsubscribe = subscribeHostEvent('gateway:channel-status', () => {
      if (throttleTimer) {
        pending = true;
        return;
      }
      void fetchChannelAccounts({ deferIfBusy: true });
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        if (pending) {
          pending = false;
          void fetchChannelAccounts({ deferIfBusy: true });
        }
      }, 2000);
    });
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
      if (throttleTimer) {
        clearTimeout(throttleTimer);
      }
    };
  }, [fetchChannelAccounts]);

  useEffect(() => {
    const previousGatewayState = lastGatewayStateRef.current;
    lastGatewayStateRef.current = gatewayStatus.state;

    if (previousGatewayState !== 'running' && gatewayStatus.state === 'running') {
      const timer = window.setTimeout(() => {
        void fetchChannelAccounts({ deferIfBusy: true });
      }, 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [fetchChannelAccounts, gatewayStatus.state]);

  useEffect(() => {
    if (hasActiveRun) return;
    if (deferredChannelRefreshRef.current == null) return;
    clearDeferredChannelRefresh();
    const timer = window.setTimeout(() => {
      void fetchChannelAccounts();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [clearDeferredChannelRefresh, fetchChannelAccounts, hasActiveRun]);

  useEffect(() => clearDeferredChannelRefresh, [clearDeferredChannelRefresh]);

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.id === activeAgentId) ?? null,
    [activeAgentId, agents],
  );

  const visibleAgents = agents;
  const visibleChannelGroups = channelGroups;
  const isUsingStableValue = loading;
  const agentWorkStatuses = useMemo(() => {
    const next = new Map<string, AgentWorkStatus>();
    for (const agent of visibleAgents) {
      next.set(agent.id, runningAgentIds.has(normalizeAgentId(agent.id)) ? 'running' : 'completed');
    }
    return next;
  }, [runningAgentIds, visibleAgents]);
  const handleRefresh = () => {
    void Promise.all([fetchAgents({ force: true }), fetchChannelAccounts({ force: true }), refreshProviderSnapshot({ force: true })]);
  };
  const openAgentChat = useCallback((agent: AgentSummary) => {
    switchSession(agent.mainSessionKey);
    navigate('/');
  }, [navigate, switchSession]);

  return (
    <div data-testid="agents-page" className="flex flex-col -m-6 dark:bg-background h-[calc(100vh-2.5rem)] overflow-hidden">
      <div className="w-full max-w-5xl mx-auto flex flex-col h-full p-10 pt-16">
        <div className="flex flex-col md:flex-row md:items-start justify-between mb-12 shrink-0 gap-4">
          <div>
            <h1 className="text-5xl md:text-6xl font-serif text-foreground mb-3 font-normal tracking-tight">
              {t('title')}
            </h1>
            <p className="text-subtitle text-foreground/70 font-medium">{t('subtitle')}</p>
          </div>
          <div className="flex items-center gap-3 md:mt-2">
            <Button
              variant="outline"
              onClick={handleRefresh}
              className="h-9 text-meta font-medium rounded-full px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground transition-colors"
            >
              <RefreshCw className={cn('h-3.5 w-3.5 mr-2', isUsingStableValue && 'animate-spin')} />
              {t('refresh')}
            </Button>
            <Button
              data-testid="agents-add-button"
              onClick={() => setShowAddDialog(true)}
              className="h-9 text-meta font-medium rounded-full px-4 shadow-none"
            >
              <Plus className="h-3.5 w-3.5 mr-2" />
              {t('addAgent')}
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 pb-10 min-h-0 -mr-2">
          {gatewayStatus.state !== 'running' && (
            <div className="mb-8 p-4 rounded-xl border border-yellow-500/50 bg-yellow-500/10 flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
              <span className="text-yellow-700 dark:text-yellow-400 text-sm font-medium">
                {t('gatewayWarning')}
              </span>
            </div>
          )}

          {error && (
            <div className="mb-8 p-4 rounded-xl border border-destructive/50 bg-destructive/10 flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-destructive" />
              <span className="text-destructive text-sm font-medium">
                {error}
              </span>
            </div>
          )}

          <div className="space-y-3">
            {visibleAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                workStatus={agentWorkStatuses.get(agent.id) ?? 'completed'}
                channelGroups={visibleChannelGroups}
                onOpenChat={() => openAgentChat(agent)}
                onOpenSettings={() => setActiveAgentId(agent.id)}
                onDelete={() => setAgentToDelete(agent)}
              />
            ))}
          </div>
        </div>
      </div>

      {showAddDialog && (
        <AddAgentDialog
          onClose={() => setShowAddDialog(false)}
          onGenerate={generateAgentProfile}
          onCreate={async (name, options) => {
            const createdAgent = await createAgent(name, options);
            setShowAddDialog(false);
            toast.success(t('toast.agentCreated'));
            if (createdAgent?.mainSessionKey) {
              switchSession(createdAgent.mainSessionKey);
              navigate('/');
            }
          }}
        />
      )}

      {activeAgent && (
        <AgentSettingsModal
          agent={activeAgent}
          channelGroups={visibleChannelGroups}
          onClose={() => setActiveAgentId(null)}
        />
      )}

      <ConfirmDialog
        open={!!agentToDelete}
        title={t('deleteDialog.title')}
        message={agentToDelete ? t('deleteDialog.message', { name: agentToDelete.name }) : ''}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={async () => {
          if (!agentToDelete) return;
          try {
            await deleteAgent(agentToDelete.id);
            const deletedId = agentToDelete.id;
            setAgentToDelete(null);
            if (activeAgentId === deletedId) {
              setActiveAgentId(null);
            }
            toast.success(t('toast.agentDeleted'));
          } catch (error) {
            toast.error(t('toast.agentDeleteFailed', { error: String(error) }));
          }
        }}
        onCancel={() => setAgentToDelete(null)}
      />
    </div>
  );
}

function AgentCard({
  agent,
  workStatus,
  channelGroups,
  onOpenChat,
  onOpenSettings,
  onDelete,
}: {
  agent: AgentSummary;
  workStatus: AgentWorkStatus;
  channelGroups: ChannelGroupItem[];
  onOpenChat: () => void;
  onOpenSettings: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation('agents');
  const boundChannelAccounts = channelGroups.flatMap((group) =>
    group.accounts
      .filter((account) => account.agentId === agent.id)
      .map((account) => {
        const channelName = CHANNEL_NAMES[group.channelType as ChannelType] || group.channelType;
        const accountLabel =
          account.accountId === 'default'
            ? t('settingsDialog.mainAccount')
            : account.name || account.accountId;
        return `${channelName} · ${accountLabel}`;
      }),
  );
  const channelsText = boundChannelAccounts.length > 0
    ? boundChannelAccounts.join(', ')
    : t('none');
  const avatar = getAgentAvatar(agent.profile?.avatarId);
  const displayName = agent.profile?.personaName || agent.name;
  const responsibility = agent.profile?.responsibility?.trim();
  const openChatLabel = t('openChatWithAgent', { name: displayName });

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpenChat();
  };

  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-2xl border border-transparent bg-transparent transition-all hover:bg-black/5 focus-within:ring-2 focus-within:ring-blue-500/40 dark:hover:bg-white/5',
        agent.isDefault && 'bg-black/[0.04] dark:bg-white/[0.06]'
      )}
    >
      <div
        role="button"
        tabIndex={0}
        data-testid={`agent-card-${agent.id}`}
        aria-label={openChatLabel}
        title={openChatLabel}
        onClick={onOpenChat}
        onKeyDown={handleKeyDown}
        className="flex min-w-0 cursor-pointer items-start gap-4 p-4 pr-24 text-left outline-none"
      >
        <div className="h-[50px] w-[50px] shrink-0 overflow-hidden rounded-full border border-black/5 bg-white/70 shadow-sm dark:border-white/10 dark:bg-white/5">
          {agent.profile?.avatarId ? (
            <img src={avatar.src} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-primary bg-primary/10">
              <Bot className="h-[22px] w-[22px]" />
            </div>
          )}
        </div>
        <div className="flex flex-col flex-1 min-w-0 py-0.5 mt-1">
          <div className="mb-1 flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="max-w-full truncate text-base font-semibold text-foreground">{displayName}</h2>
            <AgentWorkStatusBadge status={workStatus} />
            {agent.isDefault && (
              <Badge
                variant="secondary"
                className="flex items-center gap-1 font-mono text-2xs font-medium px-2 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.08] border-0 shadow-none text-foreground/70"
              >
                <Check className="h-3 w-3" />
                {t('defaultBadge')}
              </Badge>
            )}
          </div>
          {responsibility && (
            <p className="text-sm text-foreground/75 line-clamp-2 leading-[1.5] mb-1">
              {responsibility}
            </p>
          )}
          <p className="text-sm text-muted-foreground line-clamp-2 leading-[1.5]">
            {t('modelLine', {
              model: agent.modelDisplay,
              suffix: agent.inheritedModel ? ` (${t('inherited')})` : '',
            })}
          </p>
          <p className="text-sm text-muted-foreground line-clamp-2 leading-[1.5]">
            {t('channelsLine', { channels: channelsText })}
          </p>
        </div>
      </div>
      <div className="absolute right-4 top-5 flex items-center gap-1 shrink-0">
        {!agent.isDefault && (
          <Button
            variant="ghost"
            size="icon"
            className="opacity-0 group-hover:opacity-100 h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all focus-visible:opacity-100"
            onClick={onDelete}
            title={t('deleteAgent')}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/10 transition-all focus-visible:opacity-100',
            !agent.isDefault && 'opacity-0 group-hover:opacity-100',
          )}
          onClick={onOpenSettings}
          title={t('settings')}
        >
          <Settings2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function AgentWorkStatusBadge({ status }: { status: AgentWorkStatus }) {
  const { t } = useTranslation('agents');
  const running = status === 'running';

  return (
    <span
      data-testid="agent-work-status"
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-1.5 font-mono text-[10px] font-medium leading-none',
        running
          ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300',
      )}
    >
      <PixelWorkStatusIcon status={status} />
      {t(`workStatus.${status}`)}
    </span>
  );
}

function PixelWorkStatusIcon({ status }: { status: AgentWorkStatus }) {
  if (status === 'running') {
    return (
      <span aria-hidden="true" className="grid h-3 w-3 grid-cols-2 gap-px">
        <span className="h-[5px] w-[5px] bg-emerald-500 motion-safe:animate-pulse" />
        <span className="h-[5px] w-[5px] bg-emerald-400 motion-safe:animate-pulse [animation-delay:120ms]" />
        <span className="h-[5px] w-[5px] bg-emerald-300 motion-safe:animate-pulse [animation-delay:240ms]" />
        <span className="h-[5px] w-[5px] bg-emerald-500 motion-safe:animate-pulse [animation-delay:360ms]" />
      </span>
    );
  }

  return (
    <span aria-hidden="true" className="relative h-3 w-3">
      <span className="absolute left-[1px] top-[6px] h-[3px] w-[3px] bg-sky-500" />
      <span className="absolute left-[4px] top-[8px] h-[3px] w-[3px] bg-sky-500" />
      <span className="absolute left-[7px] top-[5px] h-[3px] w-[3px] bg-sky-500" />
      <span className="absolute left-[10px] top-[2px] h-[3px] w-[3px] bg-sky-500" />
    </span>
  );
}

const inputClasses = 'h-[44px] rounded-xl font-mono text-meta bg-transparent border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:border-blue-500 shadow-sm transition-all text-foreground placeholder:text-foreground/40';
const selectClasses = 'h-[44px] w-full rounded-xl font-mono text-meta bg-transparent border border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:border-blue-500 shadow-sm transition-all text-foreground px-3';
const labelClasses = 'text-sm text-foreground/80 font-bold';

function ChannelLogo({ type }: { type: ChannelType }) {
  switch (type) {
    case 'telegram':
      return <img src={telegramIcon} alt="Telegram" className="w-[20px] h-[20px] dark:invert" />;
    case 'discord':
      return <img src={discordIcon} alt="Discord" className="w-[20px] h-[20px] dark:invert" />;
    case 'whatsapp':
      return <img src={whatsappIcon} alt="WhatsApp" className="w-[20px] h-[20px] dark:invert" />;
    case 'wechat':
      return <img src={wechatIcon} alt="WeChat" className="w-[20px] h-[20px] dark:invert" />;
    case 'dingtalk':
      return <img src={dingtalkIcon} alt="DingTalk" className="w-[20px] h-[20px] dark:invert" />;
    case 'feishu':
      return <img src={feishuIcon} alt="Feishu" className="w-[20px] h-[20px] dark:invert" />;
    case 'wecom':
      return <img src={wecomIcon} alt="WeCom" className="w-[20px] h-[20px] dark:invert" />;
    case 'qqbot':
      return <img src={qqIcon} alt="QQ" className="w-[20px] h-[20px] dark:invert" />;
    default:
      return <span className="text-xl leading-none">{CHANNEL_ICONS[type] || '💬'}</span>;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function AddAgentDialog({
  onClose,
  onGenerate,
  onCreate,
}: {
  onClose: () => void;
  onGenerate: (input: { roleName: string; responsibility: string; avatarId: string; locale?: string }) => Promise<AgentProfileDraft>;
  onCreate: (name: string, options: { inheritWorkspace: boolean; profile: AgentProfileDraft }) => Promise<void>;
}) {
  const { t, i18n } = useTranslation('agents');
  const [roleName, setRoleName] = useState('');
  const [responsibility, setResponsibility] = useState('');
  const [avatarId, setAvatarId] = useState(AGENT_AVATARS[0].id);
  const [inheritWorkspace, setInheritWorkspace] = useState(false);
  const [saving, setSaving] = useState(false);
  const selectedAvatar = getAgentAvatar(avatarId);

  const canCreate = roleName.trim().length > 0 && responsibility.trim().length > 0 && !saving;

  const handleSubmit = async () => {
    if (!canCreate) return;
    setSaving(true);
    let generated: AgentProfileDraft;
    try {
      generated = await onGenerate({
        roleName: roleName.trim(),
        responsibility: responsibility.trim(),
        avatarId,
        locale: i18n.language,
      });
    } catch (error) {
      toast.error(t('toast.agentProfileGenerateFailed', { error: getErrorMessage(error) }));
      setSaving(false);
      return;
    }

    try {
      const profile = { ...generated, avatarId };
      await onCreate(profile.personaName.trim() || roleName.trim(), {
        inheritWorkspace,
        profile,
      });
    } catch (error) {
      toast.error(t('toast.agentCreateFailed', { error: getErrorMessage(error) }));
      setSaving(false);
      return;
    }
    setSaving(false);
  };

  return (
    <div data-testid="agent-create-dialog" className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl max-h-[92vh] flex flex-col rounded-3xl border-0 shadow-2xl bg-surface-modal overflow-hidden">
        <CardHeader className="flex flex-row items-start justify-between gap-4 pb-2 shrink-0">
          <div>
            <CardTitle className="text-2xl font-serif font-normal tracking-tight">
              {t('createDialog.title')}
            </CardTitle>
            <CardDescription className="text-sm mt-1 text-foreground/70">
              {t('createDialog.description')}
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="rounded-full h-8 w-8 -mr-2 -mt-2 text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
          >
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto p-6 pt-4">
          <div className="grid gap-6 md:grid-cols-[132px_minmax(0,1fr)]">
            <div className="flex flex-col items-center gap-3">
              <div className="h-28 w-28 overflow-hidden rounded-full border border-black/10 bg-white/70 shadow-sm dark:border-white/10 dark:bg-white/5">
                <img src={selectedAvatar.src} alt="" className="h-full w-full object-cover" />
              </div>
              <p className="text-center text-xs leading-5 text-foreground/55">
                {t('createDialog.avatarHint')}
              </p>
            </div>
            <div className="space-y-5">
              <div className="space-y-2.5">
                <Label htmlFor="agent-role-name" className={labelClasses}>{t('createDialog.nameLabel')}</Label>
                <Input
                  data-testid="agent-create-role-name"
                  id="agent-role-name"
                  value={roleName}
                  onChange={(event) => {
                    setRoleName(event.target.value);
                  }}
                  placeholder={t('createDialog.namePlaceholder')}
                  className={inputClasses}
                />
              </div>
              <div className="space-y-2.5">
                <Label htmlFor="agent-responsibility" className={labelClasses}>{t('createDialog.responsibilityLabel')}</Label>
                <Textarea
                  data-testid="agent-create-responsibility"
                  id="agent-responsibility"
                  value={responsibility}
                  onChange={(event) => {
                    setResponsibility(event.target.value);
                  }}
                  placeholder={t('createDialog.responsibilityPlaceholder')}
                  className="min-h-[112px] rounded-xl font-mono text-meta bg-transparent border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:border-blue-500 shadow-sm transition-all text-foreground placeholder:text-foreground/40 resize-none"
                />
              </div>
              <div className="space-y-3">
                <Label className={labelClasses}>{t('createDialog.avatarLabel')}</Label>
                <div className="grid grid-cols-3 gap-3">
                  {AGENT_AVATARS.map((avatar) => (
                    <button
                      data-testid={`agent-create-avatar-${avatar.id}`}
                      key={avatar.id}
                      type="button"
                      onClick={() => {
                        setAvatarId(avatar.id);
                      }}
                      className={cn(
                        'aspect-square rounded-2xl border p-2 transition-all bg-white/50 dark:bg-white/5',
                        avatarId === avatar.id
                          ? 'border-primary ring-2 ring-primary/20'
                          : 'border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/10',
                      )}
                      aria-label={t(`createDialog.avatarOptions.${avatar.id}`)}
                      title={t(`createDialog.avatarOptions.${avatar.id}`)}
                    >
                      <img src={avatar.src} alt="" className="h-full w-full object-cover rounded-xl" />
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between rounded-2xl border border-black/10 dark:border-white/10 p-4">
                <div className="space-y-0.5">
                  <Label htmlFor="inherit-workspace" className={labelClasses}>{t('createDialog.inheritWorkspaceLabel')}</Label>
                  <p className="text-meta text-foreground/60">{t('createDialog.inheritWorkspaceDescription')}</p>
                </div>
                <Switch
                  id="inherit-workspace"
                  checked={inheritWorkspace}
                  onCheckedChange={setInheritWorkspace}
                />
              </div>
            </div>
          </div>
        </CardContent>
        <div className="flex justify-end gap-2 border-t border-black/10 p-4 dark:border-white/10">
          <Button
            variant="outline"
            onClick={onClose}
            className="h-9 text-meta font-medium rounded-full px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground"
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            data-testid="agent-create-submit"
            onClick={() => void handleSubmit()}
            disabled={!canCreate}
            className="h-9 text-meta font-medium rounded-full px-4 shadow-none"
          >
            {saving ? (
              <>
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                {t('createDialog.creatingWithProfile')}
              </>
            ) : (
              t('createDialog.createAndOpen')
            )}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function AgentSettingsModal({
  agent,
  channelGroups,
  onClose,
}: {
  agent: AgentSummary;
  channelGroups: ChannelGroupItem[];
  onClose: () => void;
}) {
  const { t } = useTranslation('agents');
  const { updateAgent, defaultModelRef } = useAgentsStore();
  const [name, setName] = useState(agent.name);
  const [savingName, setSavingName] = useState(false);
  const [showModelModal, setShowModelModal] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  useEffect(() => {
    setName(agent.name);
  }, [agent.name]);

  const hasNameChanges = name.trim() !== agent.name;

  const handleRequestClose = () => {
    if (savingName || hasNameChanges) {
      setShowCloseConfirm(true);
      return;
    }
    onClose();
  };

  const handleSaveName = async () => {
    if (!name.trim() || name.trim() === agent.name) return;
    setSavingName(true);
    try {
      await updateAgent(agent.id, name.trim());
      toast.success(t('toast.agentUpdated'));
    } catch (error) {
      toast.error(t('toast.agentUpdateFailed', { error: String(error) }));
    } finally {
      setSavingName(false);
    }
  };

  const assignedChannels = channelGroups.flatMap((group) =>
    group.accounts
      .filter((account) => account.agentId === agent.id)
      .map((account) => ({
        channelType: group.channelType as ChannelType,
        accountId: account.accountId,
        name:
          account.accountId === 'default'
            ? t('settingsDialog.mainAccount')
            : account.name || account.accountId,
        error: account.lastError,
      })),
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-3xl border-0 shadow-2xl bg-surface-modal overflow-hidden">
        <CardHeader className="flex flex-row items-start justify-between pb-2 shrink-0">
          <div>
            <CardTitle className="text-2xl font-serif font-normal tracking-tight">
              {t('settingsDialog.title', { name: agent.name })}
            </CardTitle>
            <CardDescription className="text-sm mt-1 text-foreground/70">
              {t('settingsDialog.description')}
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRequestClose}
            className="rounded-full h-8 w-8 -mr-2 -mt-2 text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
          >
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-6 pt-4 overflow-y-auto flex-1 p-6">
          <div className="space-y-4">
            <div className="space-y-2.5">
              <Label htmlFor="agent-settings-name" className={labelClasses}>{t('settingsDialog.nameLabel')}</Label>
              <div className="flex gap-2">
                <Input
                  id="agent-settings-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  readOnly={agent.isDefault}
                  className={inputClasses}
                />
                {!agent.isDefault && (
                  <Button
                    variant="outline"
                    onClick={() => void handleSaveName()}
                    disabled={savingName || !name.trim() || name.trim() === agent.name}
                    className="h-[44px] text-meta font-medium rounded-xl px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground"
                  >
                    {savingName ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      t('common:actions.save')
                    )}
                  </Button>
                )}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1 rounded-2xl bg-black/5 dark:bg-white/5 border border-transparent p-4">
                <p className="text-tiny uppercase tracking-[0.08em] text-muted-foreground/80 font-medium">
                  {t('settingsDialog.agentIdLabel')}
                </p>
                <p className="font-mono text-meta text-foreground">{agent.id}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowModelModal(true)}
                className="space-y-1 rounded-2xl bg-black/5 dark:bg-white/5 border border-transparent p-4 text-left hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
              >
                <p className="text-tiny uppercase tracking-[0.08em] text-muted-foreground/80 font-medium">
                  {t('settingsDialog.modelLabel')}
                </p>
                <p className="text-sm text-foreground">
                  {agent.modelDisplay}
                  {agent.inheritedModel ? ` (${t('inherited')})` : ''}
                </p>
                <p className="font-mono text-xs text-foreground/70 break-all">
                  {agent.modelRef || defaultModelRef || '-'}
                </p>
              </button>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-serif text-foreground font-normal tracking-tight">
                  {t('settingsDialog.channelsTitle')}
                </h3>
                <p className="text-sm text-foreground/70 mt-1">{t('settingsDialog.channelsDescription')}</p>
              </div>
            </div>

            {assignedChannels.length === 0 && agent.channelTypes.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-4 text-sm text-muted-foreground">
                {t('settingsDialog.noChannels')}
              </div>
            ) : (
              <div className="space-y-3">
                {assignedChannels.map((channel) => (
                  <div key={`${channel.channelType}-${channel.accountId}`} className="flex items-center justify-between rounded-2xl bg-black/5 dark:bg-white/5 border border-transparent p-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-[40px] w-[40px] shrink-0 flex items-center justify-center text-foreground bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-full shadow-sm">
                        <ChannelLogo type={channel.channelType} />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground">{channel.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {CHANNEL_NAMES[channel.channelType]} · {channel.accountId === 'default' ? t('settingsDialog.mainAccount') : channel.accountId}
                        </p>
                        {channel.error && (
                          <p className="text-xs text-destructive mt-1">{channel.error}</p>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0" />
                  </div>
                ))}
                {assignedChannels.length === 0 && agent.channelTypes.length > 0 && (
                  <div className="rounded-2xl border border-dashed border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-4 text-sm text-muted-foreground">
                    {t('settingsDialog.channelsManagedInChannels')}
                  </div>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      {showModelModal && (
        <AgentModelModal
          agent={agent}
          onClose={() => setShowModelModal(false)}
        />
      )}
      <ConfirmDialog
        open={showCloseConfirm}
        title={t('settingsDialog.unsavedChangesTitle')}
        message={t('settingsDialog.unsavedChangesMessage')}
        confirmLabel={t('settingsDialog.closeWithoutSaving')}
        cancelLabel={t('common:actions.cancel')}
        onConfirm={() => {
          setShowCloseConfirm(false);
          setName(agent.name);
          onClose();
        }}
        onCancel={() => setShowCloseConfirm(false)}
      />
    </div>
  );
}

function AgentModelModal({
  agent,
  onClose,
}: {
  agent: AgentSummary;
  onClose: () => void;
}) {
  const { t } = useTranslation('agents');
  const providerAccounts = useProviderStore((state) => state.accounts);
  const providerStatuses = useProviderStore((state) => state.statuses);
  const providerVendors = useProviderStore((state) => state.vendors);
  const providerDefaultAccountId = useProviderStore((state) => state.defaultAccountId);
  const { updateAgentModel, defaultModelRef } = useAgentsStore();
  const [selectedRuntimeProviderKey, setSelectedRuntimeProviderKey] = useState('');
  const [modelIdInput, setModelIdInput] = useState('');
  const [savingModel, setSavingModel] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  const runtimeProviderOptions = useMemo<RuntimeProviderOption[]>(
    () => buildRuntimeProviderOptions(
      providerAccounts,
      providerStatuses,
      providerVendors,
      providerDefaultAccountId,
    ),
    [providerAccounts, providerDefaultAccountId, providerStatuses, providerVendors],
  );

  useEffect(() => {
    const override = splitModelRef(agent.overrideModelRef);
    if (override) {
      setSelectedRuntimeProviderKey(override.providerKey);
      setModelIdInput(override.modelId);
      return;
    }

    const effective = splitModelRef(agent.modelRef || defaultModelRef);
    if (effective) {
      setSelectedRuntimeProviderKey(effective.providerKey);
      setModelIdInput(effective.modelId);
      return;
    }

    setSelectedRuntimeProviderKey(runtimeProviderOptions[0]?.runtimeProviderKey || '');
    setModelIdInput('');
  }, [agent.modelRef, agent.overrideModelRef, defaultModelRef, runtimeProviderOptions]);

  const selectedProvider = runtimeProviderOptions.find((option) => option.runtimeProviderKey === selectedRuntimeProviderKey) || null;
  const trimmedModelId = modelIdInput.trim();
  const nextModelRef = selectedRuntimeProviderKey && trimmedModelId
    ? `${selectedRuntimeProviderKey}/${trimmedModelId}`
    : '';
  const normalizedDefaultModelRef = (defaultModelRef || '').trim();
  const isUsingDefaultModelInForm = Boolean(normalizedDefaultModelRef) && nextModelRef === normalizedDefaultModelRef;
  const currentOverrideModelRef = (agent.overrideModelRef || '').trim();
  const desiredOverrideModelRef = nextModelRef && nextModelRef !== normalizedDefaultModelRef
    ? nextModelRef
    : null;
  const modelChanged = (desiredOverrideModelRef || '') !== currentOverrideModelRef;
  const defaultModelLabel = formatModelDisplayLabel(defaultModelRef);

  const handleRequestClose = () => {
    if (savingModel || modelChanged) {
      setShowCloseConfirm(true);
      return;
    }
    onClose();
  };

  const handleSaveModel = async () => {
    if (!selectedRuntimeProviderKey) {
      toast.error(t('toast.agentModelProviderRequired'));
      return;
    }
    if (!trimmedModelId) {
      toast.error(t('toast.agentModelIdRequired'));
      return;
    }
    if (!modelChanged) return;
    if (!nextModelRef.includes('/')) {
      toast.error(t('toast.agentModelInvalid'));
      return;
    }

    setSavingModel(true);
    try {
      await updateAgentModel(agent.id, desiredOverrideModelRef);
      toast.success(desiredOverrideModelRef ? t('toast.agentModelUpdated') : t('toast.agentModelReset'));
      onClose();
    } catch (error) {
      toast.error(t('toast.agentModelUpdateFailed', { error: String(error) }));
    } finally {
      setSavingModel(false);
    }
  };

  const handleUseDefaultModel = () => {
    const parsedDefault = splitModelRef(normalizedDefaultModelRef);
    if (!parsedDefault) {
      setSelectedRuntimeProviderKey('');
      setModelIdInput('');
      return;
    }
    setSelectedRuntimeProviderKey(parsedDefault.providerKey);
    setModelIdInput(parsedDefault.modelId);
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
      <Card className="w-full max-w-xl rounded-3xl border-0 shadow-2xl bg-surface-modal overflow-hidden">
        <CardHeader className="flex flex-row items-start justify-between pb-2">
          <div>
            <CardTitle className="text-2xl font-serif font-normal tracking-tight">
              {t('settingsDialog.modelLabel')}
            </CardTitle>
            <CardDescription className="text-sm mt-1 text-foreground/70">
              {t('settingsDialog.modelOverrideDescription', { defaultModel: defaultModelRef ? defaultModelLabel : '-' })}
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRequestClose}
            className="rounded-full h-8 w-8 -mr-2 -mt-2 text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
          >
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4 p-6 pt-4">
          <div className="space-y-2">
            <Label htmlFor="agent-model-provider" className="text-xs text-foreground/70">{t('settingsDialog.modelProviderLabel')}</Label>
            <select
              id="agent-model-provider"
              value={selectedRuntimeProviderKey}
              onChange={(event) => {
                const nextProvider = event.target.value;
                setSelectedRuntimeProviderKey(nextProvider);
                if (!modelIdInput.trim()) {
                  const option = runtimeProviderOptions.find((candidate) => candidate.runtimeProviderKey === nextProvider);
                  setModelIdInput(option?.configuredModelId || '');
                }
              }}
              className={selectClasses}
            >
              <option value="">{t('settingsDialog.modelProviderPlaceholder')}</option>
              {runtimeProviderOptions.map((option) => (
                <option key={option.runtimeProviderKey} value={option.runtimeProviderKey}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-model-id" className="text-xs text-foreground/70">{t('settingsDialog.modelIdLabel')}</Label>
            <Input
              id="agent-model-id"
              value={modelIdInput}
              onChange={(event) => setModelIdInput(event.target.value)}
              placeholder={selectedProvider?.modelIdPlaceholder || selectedProvider?.configuredModelId || t('settingsDialog.modelIdPlaceholder')}
              className={inputClasses}
            />
          </div>
          {!!nextModelRef && (
            <p className="text-xs font-mono text-foreground/70 break-all">
              {t('settingsDialog.modelPreview')}: {nextModelRef}
            </p>
          )}
          {runtimeProviderOptions.length === 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t('settingsDialog.modelProviderEmpty')}
            </p>
          )}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={handleUseDefaultModel}
              disabled={savingModel || !normalizedDefaultModelRef || isUsingDefaultModelInForm}
              className="h-9 text-meta font-medium rounded-full px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground"
            >
              {t('settingsDialog.useDefaultModel')}
            </Button>
            <Button
              variant="outline"
              onClick={handleRequestClose}
              className="h-9 text-meta font-medium rounded-full px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground"
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              onClick={() => void handleSaveModel()}
              disabled={savingModel || !selectedRuntimeProviderKey || !trimmedModelId || !modelChanged}
              className="h-9 text-meta font-medium rounded-full px-4 shadow-none"
            >
              {savingModel ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                t('common:actions.save')
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={showCloseConfirm}
        title={t('settingsDialog.unsavedChangesTitle')}
        message={t('settingsDialog.unsavedChangesMessage')}
        confirmLabel={t('settingsDialog.closeWithoutSaving')}
        cancelLabel={t('common:actions.cancel')}
        onConfirm={() => {
          setShowCloseConfirm(false);
          onClose();
        }}
        onCancel={() => setShowCloseConfirm(false)}
      />
    </div>
  );
}

export default Agents;
