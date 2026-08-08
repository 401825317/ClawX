import type { TimelineItem, ToolCallItem } from './timeline-types';
import type { AcpTurnTiming } from './turn-timings';
import type { ChatSession } from '@/stores/chat/types';

export type AcpAssistantDisplayEntry =
  | { kind: 'timeline-item'; item: TimelineItem }
  | { kind: 'tool-call-group'; id: string; items: ToolCallItem[] };

export type SubagentToolGroupProgress = {
  phase: 'running' | 'waiting' | 'resuming' | 'completed';
  total: number;
  completed: number;
};

function isToolNamed(item: ToolCallItem, name: string): boolean {
  return new RegExp(`(?:^|\\b)${name}(?:\\b|$)`, 'i').test(item.title);
}

export function isSubagentSpawnTool(item: ToolCallItem): boolean {
  return isToolNamed(item, 'sessions_spawn');
}

export function isSubagentYieldTool(item: ToolCallItem): boolean {
  return isToolNamed(item, 'sessions_yield');
}

function collectChildSessionKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectChildSessionKeys(child, keys);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'childSessionKey' && typeof child === 'string' && child.trim()) {
      keys.add(child.trim());
      continue;
    }
    collectChildSessionKeys(child, keys);
  }
}

function getSpawnedChildSessionKeys(items: ToolCallItem[]): Set<string> {
  const keys = new Set<string>();
  for (const item of items) {
    if (!isSubagentSpawnTool(item)) continue;
    collectChildSessionKeys(item.output, keys);
    for (const part of item.outputParts) {
      if (part.kind !== 'markdown') continue;
      try {
        collectChildSessionKeys(JSON.parse(part.text), keys);
      } catch {
        // Human-readable output has no reliable child-session identity.
      }
    }
  }
  return keys;
}

function isSubagentSessionComplete(session: ChatSession): boolean {
  if (session.hasActiveSubagentRun === true) return false;
  const state = session.subagentRunState?.trim().toLowerCase();
  return session.hasActiveSubagentRun === false
    || !!state && ['done', 'completed', 'failed', 'error', 'cancelled', 'canceled', 'timeout', 'aborted'].includes(state);
}

/** Derives parent-visible progress from native session lineage without polling. */
export function getSubagentToolGroupProgress(input: {
  items: ToolCallItem[];
  parentSessionKey: string;
  subagentSessions: ChatSession[];
  hasFollowingContent: boolean;
}): SubagentToolGroupProgress | null {
  const spawnItems = input.items.filter(isSubagentSpawnTool);
  if (spawnItems.length === 0) return null;

  const spawnedKeys = getSpawnedChildSessionKeys(spawnItems);
  const directChildren = input.subagentSessions
    .filter((session) => (
      session.parentSessionKey === input.parentSessionKey
      || session.spawnedBy === input.parentSessionKey
    ))
    .filter((session) => spawnedKeys.size === 0 || spawnedKeys.has(session.key))
    .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0));
  const relevantChildren = spawnedKeys.size === 0
    ? directChildren.slice(-spawnItems.length)
    : directChildren;
  const total = Math.max(spawnItems.length, spawnedKeys.size);
  const completed = Math.min(total, relevantChildren.filter(isSubagentSessionComplete).length);

  if (completed >= total && input.hasFollowingContent) {
    return { phase: 'completed', total, completed };
  }
  if (completed >= total) return { phase: 'resuming', total, completed };
  if (completed > 0) return { phase: 'waiting', total, completed };
  return { phase: 'running', total, completed };
}

/** Projects consecutive tool calls into renderer-only groups without changing timeline ownership or order. */
export function groupConsecutiveToolCalls(items: TimelineItem[]): AcpAssistantDisplayEntry[] {
  const entries: AcpAssistantDisplayEntry[] = [];
  let pendingTools: ToolCallItem[] = [];

  // A singleton keeps the established tool-card behavior except persistent sub-Agent controls.
  const flushPendingTools = () => {
    if (
      pendingTools.length === 1
      && !isSubagentSpawnTool(pendingTools[0])
      && !isSubagentYieldTool(pendingTools[0])
    ) {
      entries.push({ kind: 'timeline-item', item: pendingTools[0] });
    } else if (pendingTools.length > 0) {
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
