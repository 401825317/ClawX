import type { AcpTimelineSnapshot, ToolCallItem } from './timeline-types';
import { normalizeWorkspaceHtmlPreviewUrl } from '@shared/web-browser';

type WebpageArtifact = {
  ok: true;
  kind: 'webpage';
  filePath: string;
};

export type HtmlAutoOpenResult = {
  filePath: string | null;
  observedToolCallIds: string[];
};

export function isTokenizedLoopbackPreviewUrl(value: string): boolean {
  return normalizeWorkspaceHtmlPreviewUrl(value) !== null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsedJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function findWebpageArtifact(value: unknown, depth = 0): WebpageArtifact | null {
  if (depth > 5 || value == null) return null;
  if (typeof value === 'string') {
    const parsed = parsedJson(value);
    return parsed == null ? null : findWebpageArtifact(parsed, depth + 1);
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const artifact = findWebpageArtifact(value[index], depth + 1);
      if (artifact) return artifact;
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) return null;
  const filePath = typeof record.filePath === 'string'
    ? record.filePath
    : typeof record.path === 'string'
      ? record.path
      : typeof record.sourcePath === 'string'
        ? record.sourcePath
        : '';
  if (record.ok === true && record.kind === 'webpage' && filePath) {
    return { ok: true, kind: 'webpage', filePath };
  }
  for (const key of ['details', 'rawOutput', 'output', 'content', 'result', 'text']) {
    const artifact = findWebpageArtifact(record[key], depth + 1);
    if (artifact) return artifact;
  }
  return null;
}

function normalizedAbsolutePath(value: string): { family: 'windows' | 'posix'; path: string } | null {
  const normalizedSeparators = value.trim().replaceAll('\\', '/');
  const windowsDrive = /^([A-Za-z]:)\/(.*)$/u.exec(normalizedSeparators);
  const isUnc = normalizedSeparators.startsWith('//') && !normalizedSeparators.startsWith('///');
  const isPosix = normalizedSeparators.startsWith('/') && !isUnc;
  if (!windowsDrive && !isUnc && !isPosix) return null;

  let prefix = '/';
  let minimumSegments = 0;
  let rawSegments = normalizedSeparators.slice(1).split('/');
  let family: 'windows' | 'posix' = 'posix';
  if (windowsDrive) {
    family = 'windows';
    prefix = `${windowsDrive[1]}/`;
    rawSegments = windowsDrive[2].split('/');
  } else if (isUnc) {
    family = 'windows';
    prefix = '//';
    rawSegments = normalizedSeparators.slice(2).split('/');
    minimumSegments = 2;
  }

  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length <= minimumSegments) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (isUnc && segments.length < minimumSegments) return null;
  const path = `${prefix}${segments.join('/')}`.replace(/\/$/u, '') || '/';
  return { family, path };
}

export function isAbsolutePathInsideWorkspace(filePath: string, workspaceRoot: string): boolean {
  const file = normalizedAbsolutePath(filePath);
  const root = normalizedAbsolutePath(workspaceRoot);
  if (!file || !root || file.family !== root.family) return false;
  const candidate = file.family === 'windows' ? file.path.toLowerCase() : file.path;
  const boundary = root.family === 'windows' ? root.path.toLowerCase() : root.path;
  return candidate !== boundary && candidate.startsWith(boundary === '/' ? '/' : `${boundary}/`);
}

function completedLiveTool(item: unknown): item is ToolCallItem {
  return asRecord(item)?.kind === 'tool-call'
    && (item as ToolCallItem).status === 'completed'
    && (item as ToolCallItem).historical !== true;
}

export function collectHtmlAutoOpen(
  timeline: AcpTimelineSnapshot,
  workspaceRoot: string,
  seenToolCallIds: ReadonlySet<string>,
): HtmlAutoOpenResult {
  const observedToolCallIds: string[] = [];
  let filePath: string | null = null;
  for (const itemId of timeline.itemOrder) {
    const item = timeline.itemsById[itemId];
    if (!completedLiveTool(item) || seenToolCallIds.has(item.toolCallId)) continue;
    const artifact = findWebpageArtifact(item.output)
      ?? findWebpageArtifact(item.outputParts);
    if (!artifact) continue;
    observedToolCallIds.push(item.toolCallId);
    if (!isAbsolutePathInsideWorkspace(artifact.filePath, workspaceRoot)) continue;
    if (!/\.html?$/iu.test(artifact.filePath)) continue;
    filePath = artifact.filePath;
  }
  return { filePath, observedToolCallIds };
}

export const __test = { findWebpageArtifact, normalizedAbsolutePath };
