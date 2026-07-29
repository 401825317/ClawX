import { useState } from 'react';
import {
  ChevronRight,
  FileText,
  Globe2,
  Loader2,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ToolCallItem } from '@/lib/acp/timeline-types';
import { cn } from '@/lib/utils';
import { AcpToolCallCard } from './AcpToolCallCard';

type ActivityKind = 'read' | 'edit' | 'search' | 'execute' | 'fetch';

const ACTIVITY_KINDS: Partial<Record<NonNullable<ToolCallItem['toolKind']>, ActivityKind>> = {
  read: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  search: 'search',
  execute: 'execute',
  fetch: 'fetch',
};

const ACTIVITY_ICONS: Record<ActivityKind, LucideIcon> = {
  read: FileText,
  edit: Pencil,
  search: Search,
  execute: SquareTerminal,
  fetch: Globe2,
};

const ACTIVITY_ICON_PRIORITY: ActivityKind[] = ['edit', 'execute', 'search', 'fetch', 'read'];

function primaryActivityKind(items: ToolCallItem[]): ActivityKind | 'generic' {
  const activities = new Set(items.flatMap((item) => {
    const activity = item.toolKind ? ACTIVITY_KINDS[item.toolKind] : undefined;
    return activity ? [activity] : [];
  }));
  return ACTIVITY_ICON_PRIORITY.find((activity) => activities.has(activity)) ?? 'generic';
}

function activitySummary(
  items: ToolCallItem[],
  running: boolean,
  language: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const activities = new Set<ActivityKind>();

  for (const item of items) {
    const activity = item.toolKind ? ACTIVITY_KINDS[item.toolKind] : undefined;
    if (activity) activities.add(activity);
  }

  // Search and fetch share one user-facing research phrase; show at most two primary actions.
  const summaryActivities: ActivityKind[] = [];
  for (const activity of ACTIVITY_ICON_PRIORITY) {
    if (!activities.has(activity)) continue;
    const summaryActivity = activity === 'fetch' ? 'search' : activity;
    if (!summaryActivities.includes(summaryActivity)) summaryActivities.push(summaryActivity);
    if (summaryActivities.length === 2) break;
  }

  if (summaryActivities.length === 0) {
    return t(running ? 'acp.toolGroup.runningGeneric' : 'acp.toolGroup.completedGeneric');
  }

  const phrases = summaryActivities.map((activity) => {
    const state = running ? 'running' : 'completed';
    const key = `acp.toolGroup.${state}${activity[0].toUpperCase()}${activity.slice(1)}`;
    return t(key);
  });
  return new Intl.ListFormat(language, { style: 'short', type: 'conjunction' }).format(phrases);
}

/** Renders a consecutive tool run as one stable, manually expandable timeline entry. */
export function AcpToolCallGroup({
  id,
  items,
  active,
}: {
  id: string;
  items: ToolCallItem[];
  active: boolean;
}) {
  const { t, i18n } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const panelId = `${id.replace(/[^a-zA-Z0-9_-]/g, '-')}-items`;
  const toggleLabel = expanded ? t('acp.toolGroup.collapse') : t('acp.toolGroup.expand');
  const summary = activitySummary(items, active, i18n.language, t);
  const activityKind = primaryActivityKind(items);
  const CompletedIcon = activityKind === 'generic' ? Wrench : ACTIVITY_ICONS[activityKind];

  return (
    <div
      data-testid="acp-tool-call-group"
      data-tool-group-id={id}
      data-expanded={expanded ? 'true' : 'false'}
      data-active={active ? 'true' : 'false'}
      className="w-full min-w-0"
    >
      <button
        type="button"
        data-testid="acp-tool-group-toggle"
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:hover:bg-white/10"
      >
        <ChevronRight
          data-testid="acp-tool-group-chevron"
          className={cn(
            'h-4 w-4 shrink-0 transition-transform [transition-duration:260ms] [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none',
            expanded && 'rotate-90',
          )}
          aria-hidden="true"
        />
        {active
          ? <Loader2 data-testid="acp-tool-group-running-icon" className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          : (
              <CompletedIcon
                data-testid="acp-tool-group-completed-icon"
                data-activity-kind={activityKind}
                className="h-4 w-4 shrink-0"
                aria-hidden="true"
              />
            )}
        <span
          data-testid="acp-tool-group-summary"
          className={cn('acp-tool-group-summary min-w-0 flex-1 truncate font-medium', active && 'acp-tool-group-shimmer')}
        >
          {summary}
        </span>
      </button>

      <div
        id={panelId}
        data-testid="acp-tool-group-items"
        aria-hidden={!expanded}
        inert={!expanded}
        className={cn(
          'grid transition-[grid-template-rows,opacity] [transition-duration:260ms] [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none',
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            data-testid="acp-tool-group-items-content"
            className={cn(
              'ml-3 mt-1 border-l border-border/70 pl-3 transition-[transform,opacity] [transition-duration:240ms] [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:[transition-delay:0ms] motion-reduce:transition-none',
              expanded
                ? 'translate-y-0 opacity-100 [transition-delay:35ms]'
                : '-translate-y-[7px] opacity-0 [transition-delay:0ms]',
            )}
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              {items.map((item) => (
                <div key={item.id} data-acp-item-id={item.id} className="min-w-0">
                  <AcpToolCallCard item={item} variant="grouped" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
