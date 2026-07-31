/**
 * Chat Toolbar
 * Session selector, new session, refresh, and the workspace browser
 * entry point.  Rendered in the Header when on the Chat page.
 */
import { useMemo } from 'react';
import { RefreshCw, FolderTree, ListTree, ChevronDown, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useAgentsStore } from '@/stores/agents';
import { useArtifactPanel } from '@/stores/artifact-panel';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { WORKSPACE_BROWSER_ENABLED } from '@/components/file-preview/workspace-browser-config';
import { DEFAULT_AGENT_AVATAR_SRC, getAgentAvatar } from '@/lib/agent-avatars';

type ChatToolbarProps = {
  questionDirectoryOpen?: boolean;
  questionDirectoryCount?: number;
  onToggleQuestionDirectory?: () => void;
  workspaceAvailable?: boolean;
};

export function ChatToolbar({
  questionDirectoryOpen = false,
  questionDirectoryCount = 0,
  onToggleQuestionDirectory,
  workspaceAvailable = false,
}: ChatToolbarProps = {}) {
  const refresh = useChatStore((s) => s.refresh);
  const loading = useChatStore((s) => s.loading);
  const switchSession = useChatStore((s) => s.switchSession);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const agents = useAgentsStore((s) => s.agents);
  const openBrowser = useArtifactPanel((s) => s.openBrowser);
  const panelOpen = useArtifactPanel((s) => s.open);
  const panelTab = useArtifactPanel((s) => s.tab);
  const closePanel = useArtifactPanel((s) => s.close);
  const { t } = useTranslation('chat');
  const currentAgent = useMemo(
    () => (agents ?? []).find((agent) => agent.id === currentAgentId) ?? null,
    [agents, currentAgentId],
  );
  const currentAgentName = currentAgent?.profile?.personaName ?? currentAgent?.name ?? currentAgentId;
  const currentAgentAvatar = getAgentAvatar(currentAgent?.profile?.avatarId);

  const browserActive = WORKSPACE_BROWSER_ENABLED && panelOpen && panelTab === 'browser';
  const questionDirectoryAvailable = questionDirectoryCount > 1 && !!onToggleQuestionDirectory;

  return (
    <div className="flex items-center gap-2">
      {/* Switch to the selected Agent's canonical main session. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            data-testid="chat-agent-switcher"
            type="button"
            variant="outline"
            className="hidden h-8 max-w-[260px] items-center gap-1.5 rounded-full border-black/10 bg-white/70 px-3 text-xs font-medium text-foreground/80 shadow-none hover:bg-black/5 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10 sm:flex"
            aria-label={t('toolbar.agentSwitcher')}
          >
            <img
              data-testid={`chat-agent-avatar-${currentAgent?.id ?? currentAgentId}`}
              src={currentAgent?.profile?.avatarId ? currentAgentAvatar.src : DEFAULT_AGENT_AVATAR_SRC}
              alt=""
              className="h-5 w-5 shrink-0 rounded-full object-cover"
            />
            <span className="truncate">{t('toolbar.currentAgent', { agent: currentAgentName })}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-80 w-64 overflow-y-auto rounded-lg border-black/10 p-1.5 shadow-xl dark:border-white/10"
        >
          {(agents ?? []).map((agent) => {
            const isActive = agent.id === currentAgentId;
            const avatar = getAgentAvatar(agent.profile?.avatarId);
            const displayName = agent.profile?.personaName || agent.name;
            return (
              <DropdownMenuItem
                key={agent.id}
                onSelect={() => switchSession(agent.mainSessionKey)}
                className={cn(
                  'flex min-h-12 cursor-pointer gap-2.5 rounded-md px-2 py-2',
                  isActive && 'bg-black/5 dark:bg-white/10',
                )}
                aria-current={isActive ? 'true' : undefined}
              >
                <img
                  data-testid={`chat-agent-menu-avatar-${agent.id}`}
                  src={agent.profile?.avatarId ? avatar.src : DEFAULT_AGENT_AVATAR_SRC}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded-full border border-black/5 object-cover dark:border-white/10"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{displayName}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {agent.profile?.roleName || agent.modelDisplay}
                  </span>
                </span>
                {isActive ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {WORKSPACE_BROWSER_ENABLED && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              data-testid="chat-toolbar-workspace"
              variant="ghost"
              size="icon"
              className={cn(
                'h-8 w-8 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10',
                browserActive && 'bg-foreground/10 text-foreground',
              )}
              onClick={() => (browserActive ? closePanel() : openBrowser())}
              disabled={!workspaceAvailable}
              aria-label={t('toolbar.workspace')}
            >
              <FolderTree className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t('toolbar.workspace')}</p>
          </TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            data-testid="chat-question-directory-toggle"
            variant="ghost"
            size="icon"
            className={cn(
              'h-8 w-8 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10',
              questionDirectoryOpen && 'bg-foreground/10 text-foreground',
            )}
            onClick={onToggleQuestionDirectory}
            disabled={!questionDirectoryAvailable}
            aria-label={t('questionDirectory.title')}
            aria-controls="chat-question-directory"
            aria-expanded={questionDirectoryOpen}
          >
            <ListTree className="h-4 w-4" />
          </Button>
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
