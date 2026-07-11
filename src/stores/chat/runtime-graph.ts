import type { ChatRuntimeEvent } from '../../../shared/chat-runtime-events';
import {
  extractImagesAsAttachedFiles,
  extractMediaRefs,
  extractRawFilePaths,
  getMessageText,
  makeAttachedFile,
} from './helpers';
import type { AttachedFileMeta, ChatRuntimeRunState } from './types';

export function shouldFilterRuntimeExecutionGraphEvent(event: ChatRuntimeEvent): boolean {
  if (event.type === 'tool.started' || event.type === 'tool.updated' || event.type === 'tool.completed') {
    return event.name.trim().toLowerCase() === 'process';
  }
  if (event.type === 'command.output') {
    return event.name?.trim().toLowerCase() === 'process';
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function cloneRunState(runId: string, event: ChatRuntimeEvent): ChatRuntimeRunState {
  const eventTs = typeof event.ts === 'number' ? event.ts : Date.now();
  return {
    runId,
    sessionKey: event.sessionKey,
    status: event.type === 'run.ended' ? event.status : 'running',
    startedAt: event.type === 'run.started' ? event.startedAt : undefined,
    lastEventAt: eventTs,
    endedAt: event.type === 'run.ended' ? event.endedAt : undefined,
    objective: event.type === 'run.started' ? event.objective : undefined,
    planSummary: undefined,
    planSteps: [],
    artifacts: [],
    verifications: [],
    issues: [],
    checkpoints: [],
    gateEvaluations: [],
    gateResult: undefined,
    assistantText: '',
    thinkingText: '',
    progressEntries: [],
    events: [],
  };
}

function stableRuntimeFingerprint(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) return `[${value.map(stableRuntimeFingerprint).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableRuntimeFingerprint(child)}`)
    .join(',')}}`;
}

function sameRuntimeEvent(left: ChatRuntimeEvent | undefined, right: ChatRuntimeEvent): boolean {
  if (!left) return false;
  if (left.runId !== right.runId || left.type !== right.type) return false;
  if (typeof left.seq === 'number' && typeof right.seq === 'number') {
    return left.seq === right.seq;
  }
  if (left.type === 'tool.started') {
    return right.type === left.type && right.toolCallId === left.toolCallId;
  }
  if (left.type === 'tool.updated') {
    return right.type === left.type
      && right.toolCallId === left.toolCallId
      && stableRuntimeFingerprint(right.partialResult) === stableRuntimeFingerprint(left.partialResult);
  }
  if (left.type === 'tool.completed') {
    return right.type === left.type
      && right.toolCallId === left.toolCallId
      && right.isError === left.isError
      && stableRuntimeFingerprint(right.result) === stableRuntimeFingerprint(left.result)
      && stableRuntimeFingerprint(right.meta) === stableRuntimeFingerprint(left.meta);
  }
  if (left.type === 'command.output') {
    return right.type === left.type
      && right.toolCallId === left.toolCallId
      && right.itemId === left.itemId
      && right.phase === left.phase
      && right.output === left.output;
  }
  if (left.type === 'patch.completed') {
    return right.type === left.type && right.toolCallId === left.toolCallId && right.summary === left.summary;
  }
  if (left.type === 'approval.updated') {
    return right.type === left.type
      && right.toolCallId === left.toolCallId
      && right.status === left.status
      && right.phase === left.phase
      && right.message === left.message;
  }
  if (left.type === 'assistant.delta') {
    return right.type === left.type && right.text === left.text && right.delta === left.delta;
  }
  if (left.type === 'thinking.delta') {
    return right.type === left.type && right.text === left.text && right.delta === left.delta;
  }
  if (left.type === 'progress.update') {
    return right.type === left.type
      && stableRuntimeFingerprint(right.entry) === stableRuntimeFingerprint(left.entry);
  }
  if (left.type === 'run.started') return right.type === left.type;
  if (left.type === 'run.plan.updated') {
    return right.type === left.type
      && right.objective === left.objective
      && right.summary === left.summary
      && stableRuntimeFingerprint(right.steps) === stableRuntimeFingerprint(left.steps);
  }
  if (left.type === 'run.step.updated') {
    return right.type === left.type
      && stableRuntimeFingerprint(right.step) === stableRuntimeFingerprint(left.step);
  }
  if (left.type === 'artifact.produced') {
    return right.type === left.type
      && stableRuntimeFingerprint(right.artifact) === stableRuntimeFingerprint(left.artifact);
  }
  if (left.type === 'verification.completed') {
    return right.type === left.type
      && stableRuntimeFingerprint(right.verification) === stableRuntimeFingerprint(left.verification);
  }
  if (left.type === 'gate.issue') {
    return right.type === left.type
      && stableRuntimeFingerprint(right.issue) === stableRuntimeFingerprint(left.issue);
  }
  if (left.type === 'run.checkpoint') {
    return right.type === left.type
      && stableRuntimeFingerprint(right.checkpoint) === stableRuntimeFingerprint(left.checkpoint);
  }
  if (left.type === 'gate.evaluated') {
    return right.type === left.type
      && stableRuntimeFingerprint(right.gate) === stableRuntimeFingerprint(left.gate);
  }
  if (left.type === 'run.ended') return right.type === left.type && right.status === left.status && right.endedAt === left.endedAt;
  return false;
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === next.id);
  if (existingIndex === -1) return [...items, next];
  return items.map((item, index) => (index === existingIndex ? { ...item, ...next } : item));
}

function sortPlanSteps(steps: NonNullable<ChatRuntimeRunState['planSteps']>): NonNullable<ChatRuntimeRunState['planSteps']> {
  return [...steps].sort((left, right) => {
    const leftOrder = typeof left.order === 'number' ? left.order : Number.MAX_SAFE_INTEGER;
    const rightOrder = typeof right.order === 'number' ? right.order : Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.id.localeCompare(right.id);
  });
}

export function applyRuntimeEventToRuns(
  currentRuns: Record<string, ChatRuntimeRunState>,
  event: ChatRuntimeEvent,
): Record<string, ChatRuntimeRunState> {
  if (shouldFilterRuntimeExecutionGraphEvent(event)) {
    return currentRuns;
  }
  const existing = currentRuns[event.runId] ?? cloneRunState(event.runId, event);
  if (
    typeof event.seq === 'number'
    && existing.events.some((existingEvent) => existingEvent.seq === event.seq)
  ) {
    return currentRuns;
  }
  const nextRun: ChatRuntimeRunState = {
    ...existing,
    sessionKey: event.sessionKey ?? existing.sessionKey,
    lastEventAt: typeof event.ts === 'number' ? event.ts : Date.now(),
    events: sameRuntimeEvent(existing.events.at(-1), event)
      ? existing.events
      : [...existing.events, event],
  };

  switch (event.type) {
    case 'run.started':
      nextRun.status = 'running';
      nextRun.startedAt = event.startedAt ?? nextRun.startedAt;
      nextRun.objective = event.objective ?? nextRun.objective;
      nextRun.endedAt = undefined;
      break;
    case 'run.plan.updated':
      nextRun.objective = event.objective ?? nextRun.objective;
      nextRun.planSummary = event.summary ?? nextRun.planSummary;
      nextRun.planSteps = sortPlanSteps(event.steps);
      break;
    case 'run.step.updated':
      nextRun.planSteps = sortPlanSteps(upsertById(nextRun.planSteps ?? [], event.step));
      break;
    case 'run.ended':
      nextRun.status = event.status;
      nextRun.endedAt = event.endedAt ?? event.ts ?? Date.now();
      break;
    case 'artifact.produced':
      nextRun.artifacts = upsertById(nextRun.artifacts ?? [], {
        ...event.artifact,
        sourceToolCallId: event.artifact.sourceToolCallId ?? event.toolCallId,
      });
      break;
    case 'verification.completed':
      nextRun.verifications = upsertById(nextRun.verifications ?? [], event.verification);
      break;
    case 'gate.issue':
      nextRun.issues = upsertById(nextRun.issues ?? [], event.issue);
      break;
    case 'run.checkpoint':
      nextRun.checkpoints = upsertById(nextRun.checkpoints ?? [], event.checkpoint);
      break;
    case 'gate.evaluated':
      nextRun.gateEvaluations = upsertById(nextRun.gateEvaluations ?? [], event.gate);
      nextRun.gateResult = event.gate;
      nextRun.issues = event.gate.issues;
      break;
    case 'assistant.delta': {
      const incoming = event.text ?? event.delta ?? '';
      if (incoming) {
        if (event.replace) {
          nextRun.assistantText = incoming;
        } else if (event.text) {
          nextRun.assistantText = event.text.startsWith(nextRun.assistantText)
            ? event.text
            : event.text;
        } else {
          nextRun.assistantText = `${nextRun.assistantText}${event.delta ?? ''}`;
        }
      }
      break;
    }
    case 'thinking.delta': {
      const incoming = event.text ?? event.delta ?? '';
      if (incoming) {
        if (event.text) {
          nextRun.thinkingText = event.text.startsWith(nextRun.thinkingText)
            ? event.text
            : event.text;
        } else {
          nextRun.thinkingText = `${nextRun.thinkingText}${event.delta ?? ''}`;
        }
      }
      break;
    }
    case 'progress.update':
      nextRun.progressEntries = upsertById(nextRun.progressEntries ?? [], event.entry);
      break;
    default:
      break;
  }

  return {
    ...currentRuns,
    [event.runId]: nextRun,
  };
}

function collectRuntimeResultTexts(result: unknown, depth = 0, seen = new Set<object>()): string[] {
  const texts: string[] = [];
  if (depth > 4) return texts;
  if (typeof result === 'string' && result.trim()) {
    texts.push(result);
  }
  if (Array.isArray(result)) {
    const text = getMessageText(result);
    if (text.trim()) texts.push(text);
    for (const item of result) texts.push(...collectRuntimeResultTexts(item, depth + 1, seen));
  }
  const record = asRecord(result);
  if (!record) return texts;
  if (seen.has(record)) return texts;
  seen.add(record);
  try {
    const serialized = JSON.stringify(record);
    if (/(?:MEDIA:\s*|"(?:filePath|outputPath|media)"\s*:)/iu.test(serialized)) texts.push(serialized);
  } catch {
    // Continue with structured fields when a runtime result is not JSON-safe.
  }

  const candidates = [record.content, record.output, record.summary, record.error, record.stdout, record.stderr];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      texts.push(candidate);
      continue;
    }
    const text = getMessageText(candidate);
    if (text.trim()) texts.push(text);
  }
  for (const candidate of [record.result, record.details, record.meta]) {
    texts.push(...collectRuntimeResultTexts(candidate, depth + 1, seen));
  }

  return [...new Set(texts)];
}

function isTranscriptCompactionResult(value: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  const record = asRecord(value);
  if (!record) return false;
  if (record.summarizedForModel === true || record.summaryKind === 'tool_result_transcript_compaction') {
    return true;
  }
  return ['details', 'meta', 'result'].some((key) => isTranscriptCompactionResult(record[key], depth + 1));
}

const RAW_PATH_PRODUCER_TOOLS = /(?:write|create|edit|patch|save|export|generate|image|video|artifact|presentation|spreadsheet|document|ppt|excel|word|pdf)/iu;
const EXPLICIT_OUTPUT_CUE_RE = /(?:已(?:生成|创建|导出|保存|写入|制作)|产物(?:路径|文件)?|输出(?:到|文件|路径)|保存(?:到|为)|写入(?:到)?|(?:saved|wrote|written|created|generated|exported)\b)/iu;

export function extractToolCompletedFiles(event: ChatRuntimeEvent): AttachedFileMeta[] {
  if (event.type !== 'tool.completed') return [];
  if (isTranscriptCompactionResult(event.result) || isTranscriptCompactionResult(event.meta)) return [];

  const files: AttachedFileMeta[] = extractImagesAsAttachedFiles(event.result)
    .filter((file) => !file.mimeType.startsWith('image/'))
    .map((file) => (file.source ? file : { ...file, source: 'tool-result' as const }));

  const seenPaths = new Set(files.map((file) => file.filePath).filter(Boolean));
  const resultTexts = collectRuntimeResultTexts(event.result);
  const allowRawPaths = RAW_PATH_PRODUCER_TOOLS.test(event.name)
    || resultTexts.some((text) => EXPLICIT_OUTPUT_CUE_RE.test(text) || /\bMEDIA\s*:/iu.test(text));
  for (const text of resultTexts) {
    const mediaRefs = extractMediaRefs(text);
    const mediaRefPaths = new Set(mediaRefs.map((ref) => ref.filePath));
    for (const ref of mediaRefs) {
      if (seenPaths.has(ref.filePath)) continue;
      const file = makeAttachedFile(ref, 'tool-result');
      seenPaths.add(ref.filePath);
      files.push(file);
    }
    if (!allowRawPaths) continue;
    for (const ref of extractRawFilePaths(text)) {
      if (ref.mimeType.startsWith('image/')) continue;
      if (mediaRefPaths.has(ref.filePath) || seenPaths.has(ref.filePath)) continue;
      const file = makeAttachedFile(ref, 'tool-result');
      seenPaths.add(ref.filePath);
      files.push(file);
    }
  }

  return files;
}
