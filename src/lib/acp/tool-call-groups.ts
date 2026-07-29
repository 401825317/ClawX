import type { TimelineItem, ToolCallItem } from './timeline-types';
import type { AcpTurnTiming } from './turn-timings';

export type AcpAssistantDisplayEntry =
  | { kind: 'timeline-item'; item: TimelineItem }
  | { kind: 'tool-call-group'; id: string; items: ToolCallItem[] };

/** Projects consecutive tool calls into renderer-only groups without changing timeline ownership or order. */
export function groupConsecutiveToolCalls(items: TimelineItem[]): AcpAssistantDisplayEntry[] {
  const entries: AcpAssistantDisplayEntry[] = [];
  let pendingTools: ToolCallItem[] = [];

  // A singleton keeps the established tool-card behavior; only multi-tool runs become groups.
  const flushPendingTools = () => {
    if (pendingTools.length === 1) {
      entries.push({ kind: 'timeline-item', item: pendingTools[0] });
    } else if (pendingTools.length > 1) {
      entries.push({
        kind: 'tool-call-group',
        id: `tool-call-group:${pendingTools[0].id}`,
        items: pendingTools,
      });
    }
    pendingTools = [];
  };

  for (const item of items) {
    if (item.kind === 'tool-call') {
      pendingTools.push(item);
      continue;
    }

    flushPendingTools();
    entries.push({ kind: 'timeline-item', item });
  }

  flushPendingTools();
  return entries;
}

/** Keeps motion on only for the trailing live tool phase without persisting duplicate run state. */
export function isToolCallGroupActive(input: {
  items: ToolCallItem[];
  isLastEntry: boolean;
  timing?: AcpTurnTiming;
}): boolean {
  if (!input.isLastEntry || input.timing?.status === 'complete') return false;
  if (input.timing?.status === 'running') return true;

  // Without turn timing, a historical replay must not inherit a stale running animation.
  return input.items.some((item) => (
    !item.historical && (item.status === 'pending' || item.status === 'running')
  ));
}
