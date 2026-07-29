import { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
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

function activitySummary(
  items: ToolCallItem[],
  running: boolean,
  language: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const counts = new Map<ActivityKind, number>();

  // Unknown or non-action tool kinds cannot be summarized naturally, so keep the copy generic.
  for (const item of items) {
    const activity = item.toolKind ? ACTIVITY_KINDS[item.toolKind] : undefined;
    if (!activity) {
      return t(running ? 'acp.toolGroup.runningGeneric' : 'acp.toolGroup.completedGeneric', { count: items.length });
    }
    counts.set(activity, (counts.get(activity) ?? 0) + 1);
  }

  if (counts.size > 3) {
    return t(running ? 'acp.toolGroup.runningGeneric' : 'acp.toolGroup.completedGeneric', { count: items.length });
  }

  const phrases = Array.from(counts, ([activity, count]) => {
    const state = running ? 'running' : 'completed';
    const key = `acp.toolGroup.${state}${activity[0].toUpperCase()}${activity.slice(1)}`;
    return t(key, { count });
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
        {expanded
          ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
          : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />}
        {active
          ? <Loader2 data-testid="acp-tool-group-running-icon" className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          : <CheckCircle2 data-testid="acp-tool-group-completed-icon" className="h-4 w-4 shrink-0" aria-hidden="true" />}
        <span
          data-testid="acp-tool-group-summary"
          className={cn('acp-tool-group-summary min-w-0 flex-1 truncate font-medium', active && 'acp-tool-group-shimmer')}
        >
          {summary}
        </span>
        <span data-testid="acp-tool-group-count" className="shrink-0 text-2xs">{t('acp.toolGroup.itemCount', { count: items.length })}</span>
      </button>

      {expanded && (
        <div id={panelId} className="ml-3 mt-1 border-l border-border/70 pl-3" data-testid="acp-tool-group-items">
          <div className="flex min-w-0 flex-col gap-0.5">
            {items.map((item) => (
              <div key={item.id} data-acp-item-id={item.id} className="min-w-0">
                <AcpToolCallCard item={item} variant="grouped" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
