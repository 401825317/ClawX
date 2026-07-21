/**
 * Chat Toolbar
 * Session selector, new session, refresh, and the workspace browser
 * entry point.  Rendered in the Header when on the Chat page.
 */
import { useMemo, useRef, useState } from 'react';
import { RefreshCw, FolderTree, FolderOpen, ListTree, ChevronDown, Check, Loader2, RotateCcw } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useAgentsStore } from '@/stores/agents';
import { useArtifactPanel } from '@/stores/artifact-panel';
import { cn } from '@/lib/utils';
import { DEFAULT_AGENT_AVATAR_SRC, getAgentAvatar } from '@/lib/agent-avatars';
import { useTranslation } from 'react-i18next';
import { WORKSPACE_BROWSER_ENABLED } from '@/components/file-preview/workspace-browser-config';
import { selectDirectory } from '@/lib/api-client';
import { toast } from 'sonner';

function workspaceName(workspace: string): string {
  const normalized = workspace.trim().replace(/[\\/]+$/u, '');
  return normalized.split(/[\\/]/u).filter(Boolean).at(-1) || normalized;
}

type ChatToolbarProps = {
  runActive: boolean;
  questionDirectoryOpen?: boolean;
  questionDirectoryCount?: number;
  onToggleQuestionDirectory?: () => void;
};

export function ChatToolbar({
  runActive,
  questionDirectoryOpen = false,
  questionDirectoryCount = 0,
  onToggleQuestionDirectory,
}: ChatToolbarProps) {
  const refresh = useChatStore((s) => s.refresh);
  const loading = useChatStore((s) => s.loading);
  const sessions = useChatStore((s) => s.sessions);
  const switchSession = useChatStore((s) => s.switchSession);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const updateSessionCwd = useChatStore((s) => s.updateSessionCwd);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const agents = useAgentsStore((s) => s.agents);
  const openBrowser = useArtifactPanel((s) => s.openBrowser);
  const panelOpen = useArtifactPanel((s) => s.open);
  const panelTab = useArtifactPanel((s) => s.tab);
  const closePanel = useArtifactPanel((s) => s.close);
  const { t } = useTranslation('chat');
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [workspaceUpdating, setWorkspaceUpdating] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const currentAgent = useMemo(
    () => (agents ?? []).find((agent) => agent.id === currentAgentId) ?? null,
    [agents, currentAgentId],
  );
  const currentAgentName = currentAgent?.profile?.personaName ?? currentAgent?.name ?? currentAgentId;
  const currentSession = sessions.find((session) => session.key === currentSessionKey);
  const currentWorkspace = currentSession?.cwd || currentAgent?.workspace || '';
  const workspaceLocked = runActive
    || currentSession?.hasActiveRun === true
    || currentSession?.status === 'running'
    || currentSession?.status === 'active';
  const currentAvatar = getAgentAvatar(currentAgent?.profile?.avatarId);
  const activeAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of sessions) {
      if (!session.key.startsWith('agent:')) continue;
      const agentId = session.key.split(':')[1] || 'main';
      if (session.hasActiveRun || session.status === 'running' || session.status === 'active') {
        ids.add(agentId);
      }
    }
    if (runActive) ids.add(currentAgentId);
    return ids;
  }, [currentAgentId, runActive, sessions]);

  const browserActive = WORKSPACE_BROWSER_ENABLED && panelOpen && panelTab === 'browser';
  const questionDirectoryAvailable = questionDirectoryCount > 1 && !!onToggleQuestionDirectory;

  return (
    <div className="flex items-center gap-2">
      <div ref={pickerRef} className="relative hidden sm:block">
        <Button
          data-testid="chat-agent-switcher"
          type="button"
          variant="outline"
          onClick={() => setAgentPickerOpen((open) => !open)}
          className="h-8 rounded-full border-black/10 bg-white/70 px-2.5 text-xs font-medium text-foreground/80 shadow-none hover:bg-black/5 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
          aria-label={t('toolbar.agentSwitcher')}
          aria-expanded={agentPickerOpen}
        >
          {currentAgent?.profile?.avatarId ? (
            <img src={currentAvatar.src} alt="" className="mr-1.5 h-5 w-5 rounded-full object-cover" />
          ) : (
            <img src={DEFAULT_AGENT_AVATAR_SRC} alt="" className="mr-1.5 h-5 w-5 rounded-full object-cover" />
          )}
          <span className="max-w-[150px] truncate">{currentAgentName}</span>
          <ChevronDown className="ml-1 h-3.5 w-3.5 text-muted-foreground" />
        </Button>
        {agentPickerOpen && (
          <div className="absolute right-0 top-10 z-50 w-72 rounded-2xl border border-black/10 bg-surface-modal p-2 shadow-xl dark:border-white/10">
            <div className="px-2 py-1.5 text-tiny uppercase tracking-[0.08em] text-muted-foreground">
              {t('toolbar.agentSwitcher')}
            </div>
            <div className="max-h-80 overflow-y-auto">
              {(agents ?? []).map((agent) => {
                const avatar = getAgentAvatar(agent.profile?.avatarId);
                const name = agent.profile?.personaName || agent.name;
                const isActive = agent.id === currentAgentId;
                const isRunning = activeAgentIds.has(agent.id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => {
                      switchSession(agent.mainSessionKey);
                      setAgentPickerOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors',
                      isActive
                        ? 'bg-black/5 dark:bg-white/10'
                        : 'hover:bg-black/5 dark:hover:bg-white/10',
                    )}
                  >
                    <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-full border border-black/5 bg-white/70 dark:border-white/10 dark:bg-white/5">
                      {agent.profile?.avatarId ? (
                        <img src={avatar.src} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <img src={DEFAULT_AGENT_AVATAR_SRC} alt="" className="h-full w-full object-cover" />
                      )}
                      {isRunning && (
                        <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border border-white bg-emerald-500 dark:border-background" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{name}</span>
                        {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {isRunning ? t('toolbar.agentRunning') : (agent.profile?.roleName || agent.modelDisplay)}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {WORKSPACE_BROWSER_ENABLED && (
        <div className="relative hidden sm:block">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  'h-8 max-w-[190px] rounded-full border-black/10 bg-white/70 px-2.5 text-xs font-medium text-foreground/80 shadow-none hover:bg-black/5 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10',
                  browserActive && 'bg-foreground/10 text-foreground',
                )}
                onClick={() => {
                  setAgentPickerOpen(false);
                  setWorkspacePickerOpen((open) => !open);
                }}
                disabled={workspaceUpdating}
                aria-label={t('toolbar.workspace')}
                aria-expanded={workspacePickerOpen}
              >
                {workspaceUpdating ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderTree className="h-4 w-4" />}
                <span className="hidden max-w-[130px] truncate md:inline">{workspaceName(currentWorkspace) || t('toolbar.workspace')}</span>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </TooltipTrigger>
            <TooltipContent><p>{currentWorkspace || t('toolbar.workspace')}</p></TooltipContent>
          </Tooltip>
          {workspacePickerOpen && (
            <div className="absolute right-0 top-10 z-50 w-80 rounded-lg border border-black/10 bg-surface-modal p-2 shadow-xl dark:border-white/10">
              <div className="px-2 py-1.5">
                <p className="text-xs font-medium text-foreground">{t('toolbar.projectWorkspace')}</p>
                <p className="mt-1 truncate text-2xs text-muted-foreground" title={currentWorkspace}>{currentWorkspace}</p>
              </div>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10"
                disabled={workspaceLocked}
                onClick={async () => {
                  setWorkspaceUpdating(true);
                  try {
                    const result = await selectDirectory({
                      title: t('toolbar.chooseProjectWorkspace'),
                      defaultPath: currentWorkspace || undefined,
                    });
                    const cwd = result.filePaths?.[0]?.trim();
                    if (result.canceled || !cwd) return;
                    await updateSessionCwd(currentSessionKey, cwd);
                    setWorkspacePickerOpen(false);
                    toast.success(t('toolbar.workspaceUpdated'));
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : t('toolbar.workspaceUpdateFailed'));
                  } finally {
                    setWorkspaceUpdating(false);
                  }
                }}
              >
                <FolderOpen className="h-4 w-4" />
                <span>{t('toolbar.chooseProjectWorkspace')}</span>
              </button>
              {currentSession?.cwd && (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10"
                  disabled={workspaceLocked}
                  onClick={async () => {
                    setWorkspaceUpdating(true);
                    try {
                      await updateSessionCwd(currentSessionKey, null);
                      setWorkspacePickerOpen(false);
                      toast.success(t('toolbar.workspaceReset'));
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : t('toolbar.workspaceUpdateFailed'));
                    } finally {
                      setWorkspaceUpdating(false);
                    }
                  }}
                >
                  <RotateCcw className="h-4 w-4" />
                  <span>{t('toolbar.useAgentWorkspace')}</span>
                </button>
              )}
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10"
                onClick={() => {
                  setWorkspacePickerOpen(false);
                  if (browserActive) closePanel();
                  else openBrowser();
                }}
              >
                <FolderTree className="h-4 w-4" />
                <span>{browserActive ? t('toolbar.closeWorkspaceBrowser') : t('toolbar.browseWorkspace')}</span>
              </button>
              {workspaceLocked && (
                <p className="px-2 pb-1 pt-2 text-2xs text-muted-foreground">{t('toolbar.workspaceLocked')}</p>
              )}
            </div>
          )}
        </div>
      )}
      <Tooltip>
        <TooltipTrigger
          data-testid="chat-question-directory-toggle"
          type="button"
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'icon' }),
            'h-8 w-8 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10',
            questionDirectoryOpen && 'bg-foreground/10 text-foreground',
          )}
          onClick={onToggleQuestionDirectory}
          disabled={!questionDirectoryAvailable}
          aria-label={t('questionDirectory.title')}
          aria-expanded={questionDirectoryOpen}
          aria-controls={questionDirectoryAvailable ? 'chat-question-directory' : undefined}
        >
          <ListTree className="h-4 w-4" />
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('questionDirectory.title')}</p>
        </TooltipContent>
      </Tooltip>
      {/* Refresh */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
            onClick={() => refresh()}
            disabled={loading}
            aria-label={t('toolbar.refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('toolbar.refresh')}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
