import type { ToolCategory, ToolEntry, ToolGroupItem } from './types';

const TOOL_GROUP_WINDOW_MS = 15_000;

const CATEGORY_PATTERNS: Array<[ToolCategory, RegExp]> = [
  ['read', /^(?:read|cat|view|open_file|read_file|list|glob|ls|find_files?)$/iu],
  ['search', /(?:search|grep|ripgrep|rg|query|lookup|web_search)/iu],
  ['command', /(?:command|exec|shell|bash|terminal|process)/iu],
  ['edit', /(?:write|edit|patch|replace|create_file|delete_file|move_file)/iu],
  ['browser', /(?:browser|navigate|click|playwright|chrome|web_fetch)/iu],
  ['media', /(?:image|video|audio|media|render|generate)/iu],
  ['subagent', /(?:subagent|delegate|task|agent)/iu],
];

export function toolCategory(name: string): ToolCategory {
  const normalized = name.trim().toLowerCase();
  return CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(normalized))?.[0] ?? 'generic';
}

export function toolGroupSummary(category: ToolCategory, entries: ToolEntry[]): {
  key: string;
  params: Record<string, string | number>;
} {
  const running = entries.filter((entry) => entry.status === 'running').length;
  const failed = entries.filter((entry) => entry.status === 'error').length;
  const status = failed > 0 ? 'failed' : running > 0 ? 'running' : 'completed';
  return {
    key: `timeline.tools.${status}`,
    params: { category, count: entries.length, running, failed },
  };
}

export function canAppendToolToGroup(
  group: ToolGroupItem,
  entry: ToolEntry,
  options?: { hasBoundary?: boolean },
): boolean {
  if (options?.hasBoundary) return false;
  if (group.category !== toolCategory(entry.name)) return false;
  const lastEntry = group.entries[group.entries.length - 1];
  if (!lastEntry) return true;
  if ((lastEntry.parentTaskId ?? '') !== (entry.parentTaskId ?? '')) return false;
  if (entry.startedAt - lastEntry.updatedAt > TOOL_GROUP_WINDOW_MS) return false;
  if (lastEntry.status === 'error' || entry.status === 'error') return false;
  return true;
}
