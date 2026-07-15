import type {
  ConversationEventAuthority,
  ConversationEventSource,
} from '../../../shared/conversation-events';
import type { AttachedFileMeta, RawMessage } from '../chat/types';
import { createSessionAliasKey } from './identity';
import type {
  ConversationState,
  ConversationTurn,
  TimelineItem,
} from './types';

export const SHADOW_COMPARISON_SESSION_LIMIT = 16;
export const SHADOW_COMPARISON_RECORD_LIMIT = 8;
export const SHADOW_SNAPSHOT_TURN_LIMIT = 24;
export const SHADOW_SNAPSHOT_ITEM_LIMIT = 32;
export const SHADOW_SNAPSHOT_ENTITY_LIMIT = 32;

export type ShadowComparisonReason = 'history-checkpoint' | 'authoritative-terminal';
export type ShadowTerminalStatus = 'completed' | 'error' | 'aborted' | 'missing';
export type ShadowSemanticValue = string | number | boolean | null;
export type ShadowSemanticField =
  | keyof ShadowSemanticSummary
  | 'userContent'
  | 'finalContent'
  | 'sessionOwnership'
  | 'turnOwnership'
  | 'turnStatus'
  | 'itemOrder'
  | 'itemStatus'
  | 'tools'
  | 'tasks'
  | 'artifacts'
  | 'verifications'
  | 'approvals'
  | 'terminalProvenance';

export type ShadowSemanticSummary = {
  turnCount?: number;
  finalAnswerCount?: number;
  errorTurnCount?: number;
  abortedTurnCount?: number;
  terminalStatus?: ShadowTerminalStatus;
};

export type ShadowSemanticDifference = {
  field: ShadowSemanticField;
  legacy: ShadowSemanticValue;
  canonical: ShadowSemanticValue;
};

export type ShadowSemanticItemSnapshot = {
  kind: string;
  status: string;
  entityRefs: string[];
};

export type ShadowToolSnapshot = {
  ref: string;
  status: 'running' | 'completed' | 'error';
  taskRef?: string;
  parentTaskRef?: string;
};

export type ShadowTaskSnapshot = {
  ref: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'waiting_approval' | 'partial';
  parentTaskRef?: string;
};

export type ShadowArtifactSnapshot = {
  ref: string;
  status: 'registered' | 'available' | 'unavailable' | 'error';
};

export type ShadowVerificationSnapshot = {
  ref: string;
  status: 'passed' | 'failed' | 'blocked' | 'skipped';
};

export type ShadowApprovalSnapshot = {
  ref: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'completed' | 'error' | 'unknown';
  taskRef?: string;
};

export type ShadowTerminalEvidenceSnapshot = {
  status: Exclude<ShadowTerminalStatus, 'missing'>;
  source: ConversationEventSource | 'legacy-runtime' | 'unknown';
  authority: ConversationEventAuthority;
};

export type ShadowSemanticTurnSnapshot = {
  sessionRef: string;
  turnRef: string;
  status: string;
  itemCount: number;
  omittedItemCount: number;
  items: ShadowSemanticItemSnapshot[];
  toolCount: number;
  omittedToolCount: number;
  tools: ShadowToolSnapshot[];
  taskCount: number;
  omittedTaskCount: number;
  tasks: ShadowTaskSnapshot[];
  artifactCount: number;
  omittedArtifactCount: number;
  artifacts: ShadowArtifactSnapshot[];
  verificationCount: number;
  omittedVerificationCount: number;
  verifications: ShadowVerificationSnapshot[];
  approvalCount: number;
  omittedApprovalCount: number;
  approvals: ShadowApprovalSnapshot[];
  terminal?: ShadowTerminalEvidenceSnapshot;
};

export type ShadowSemanticSnapshot = {
  version: 1;
  coverage: 'history' | 'terminal-only';
  sessionRef: string;
  turnCount: number;
  omittedTurnCount: number;
  turns: ShadowSemanticTurnSnapshot[];
};

export type ShadowComparisonAssociation = {
  sessionRef: string;
  turnRefs: string[];
  runRef?: string;
};

export type ShadowComparisonRecord = {
  reason: ShadowComparisonReason;
  checkpointReason?: 'initial-load' | 'terminal-refresh' | 'manual-refresh';
  checkedAt: number;
  matched: boolean;
  comparedFields: ShadowSemanticField[];
  association: ShadowComparisonAssociation;
  differences: ShadowSemanticDifference[];
  legacy: ShadowSemanticSummary;
  canonical: ShadowSemanticSummary;
  legacySnapshot: ShadowSemanticSnapshot;
  canonicalSnapshot: ShadowSemanticSnapshot;
};

export type ShadowComparisonCache = {
  bySession: Record<string, ShadowComparisonRecord[]>;
  sessionOrder: string[];
};

type FullSemanticTurn = {
  sessionRef: string;
  turnRef: string;
  status: string;
  items: ShadowSemanticItemSnapshot[];
  tools: ShadowToolSnapshot[];
  tasks: ShadowTaskSnapshot[];
  artifacts: ShadowArtifactSnapshot[];
  verifications: ShadowVerificationSnapshot[];
  approvals: ShadowApprovalSnapshot[];
  terminal?: ShadowTerminalEvidenceSnapshot;
};

type FullSemanticSnapshot = {
  coverage: ShadowSemanticSnapshot['coverage'];
  sessionRef: string;
  turns: FullSemanticTurn[];
};

type HistorySemanticProjection = {
  summary: ShadowSemanticSummary;
  snapshot: FullSemanticSnapshot;
  userContentDigest: string;
  finalContentDigest: string;
};

type ReferenceScope = 'session' | 'turn' | 'run' | 'tool' | 'task' | 'artifact' | 'verification' | 'approval';

class SemanticReferenceRegistry {
  private readonly refs = new Map<ReferenceScope, Map<string, string>>();

  ref(scope: ReferenceScope, value: unknown, fallback: string): string {
    const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
    let scoped = this.refs.get(scope);
    if (!scoped) {
      scoped = new Map<string, string>();
      this.refs.set(scope, scoped);
    }
    const existing = scoped.get(raw);
    if (existing) return existing;
    const ref = `${scope}:${scoped.size + 1}`;
    scoped.set(raw, ref);
    return ref;
  }
}

function fnv1a32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function digest(values: string[]): string {
  return fnv1a32(values.join('\u001f')).toString(16).padStart(8, '0');
}

function stableSerialize(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
    .join(',')}}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readIdentifier(value: unknown, keys: string[]): string | undefined {
  const source = record(value);
  if (!source) return undefined;
  for (const key of keys) {
    const normalized = readString(source[key]);
    if (normalized) return normalized;
  }
  return undefined;
}

/** Extract displayable text only for ephemeral equality checks. It is never retained. */
function displayText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .flatMap((entry) => {
        const block = record(entry);
        const type = typeof block?.type === 'string' ? block.type : '';
        if (type && type !== 'text') return [];
        return typeof block?.text === 'string' ? [block.text] : [];
      })
      .join('\n')
      .trim();
  }
  const value = record(content);
  return typeof value?.text === 'string' ? value.text.trim() : '';
}

function attachmentMarker(message: RawMessage): string {
  const attachments = message._attachedFiles ?? [];
  if (attachments.length === 0) return '';
  const kinds = attachments.map((attachment) => attachment.mimeType.split('/')[0] || 'file').sort();
  return `${attachments.length}:${kinds.join(',')}`;
}

function messageFingerprint(message: Pick<RawMessage, 'content' | '_attachedFiles'>): string {
  return digest([displayText(message.content), attachmentMarker(message as RawMessage)]);
}

function contentBlocks(message: RawMessage): Record<string, unknown>[] {
  return Array.isArray(message.content)
    ? message.content.map(record).filter((entry): entry is Record<string, unknown> => entry != null)
    : [];
}

function hasThinking(message: RawMessage): boolean {
  return contentBlocks(message).some((block) => (
    block.type === 'thinking'
    && Boolean(readString(block.thinking) ?? readString(block.text))
  ));
}

function isToolResultMessage(message: RawMessage): boolean {
  if (message.role === 'toolresult') return true;
  if (message.role !== 'user') return false;
  const blocks = contentBlocks(message);
  return blocks.length > 0 && blocks.every((block) => block.type === 'tool_result' || block.type === 'toolResult');
}

function isUserBoundary(message: RawMessage): boolean {
  return message.role === 'user' && !isToolResultMessage(message);
}

function hasToolCall(message: RawMessage): boolean {
  return contentBlocks(message).some((block) => block.type === 'tool_use' || block.type === 'toolCall');
}

type LegacyToolCall = {
  rawId?: string;
  taskId?: string;
  parentTaskId?: string;
};

function legacyToolCalls(message: RawMessage): LegacyToolCall[] {
  const calls = contentBlocks(message)
    .filter((block) => block.type === 'tool_use' || block.type === 'toolCall')
    .map((block) => {
      const input = block.input ?? block.arguments;
      return {
        rawId: readString(block.id),
        taskId: readIdentifier(input, ['taskId', 'task_id']),
        parentTaskId: readIdentifier(input, ['parentTaskId', 'parent_task_id']),
      };
    });
  const rawCalls = record(message)?.tool_calls ?? record(message)?.toolCalls;
  if (!Array.isArray(rawCalls)) return calls;
  return [
    ...calls,
    ...rawCalls.map((entry) => ({ rawId: readString(record(entry)?.id) })),
  ];
}

function toolResultId(message: RawMessage): string | undefined {
  if (message.toolCallId) return message.toolCallId;
  for (const block of contentBlocks(message)) {
    if (block.type !== 'tool_result' && block.type !== 'toolResult') continue;
    const id = readString(block.tool_use_id) ?? readString(block.toolCallId) ?? readString(block.id);
    if (id) return id;
  }
  return undefined;
}

function collectLegacyToolResults(messages: readonly RawMessage[]): Map<string, 'completed' | 'error'> {
  const results = new Map<string, 'completed' | 'error'>();
  for (const message of messages) {
    if (!isToolResultMessage(message)) continue;
    const id = toolResultId(message);
    if (id) results.set(id, message.isError ? 'error' : 'completed');
  }
  return results;
}

function assistantTerminalStatus(message: RawMessage): Exclude<ShadowTerminalStatus, 'completed' | 'missing'> | null {
  if (message.role !== 'assistant') return null;
  const source = message as RawMessage & { isFailed?: unknown };
  const stopReason = typeof (source.stopReason ?? source.stop_reason) === 'string'
    ? String(source.stopReason ?? source.stop_reason).trim().toLowerCase()
    : '';
  const text = displayText(message.content);
  if (/^(?:abort|aborted|cancel|cancelled|canceled)$/u.test(stopReason)
    || /^\[assistant turn (?:aborted|cancelled|canceled)\b/iu.test(text)) {
    return 'aborted';
  }
  if (
    stopReason === 'error'
    || stopReason === 'failed'
    || source.isFailed === true
    || message.isError === true
    || Boolean(source.errorMessage ?? source.error_message)
    || /^\[assistant turn failed\b/iu.test(text)
  ) {
    return 'error';
  }
  return null;
}

type HistoryAssistantTerminal = {
  index: number;
  status: 'error' | 'aborted';
};

function terminalAssistant(messages: readonly RawMessage[]): HistoryAssistantTerminal | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const status = assistantTerminalStatus(message);
    if (status) return { index, status };
    if (displayText(message.content) || message._attachedFiles?.length || hasToolCall(message) || hasThinking(message)) return null;
  }
  return null;
}

function finalAssistantIndex(messages: readonly RawMessage[], terminal: HistoryAssistantTerminal | null): number {
  if (terminal) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    if (!(displayText(message.content) || message._attachedFiles?.length)) continue;
    if (hasToolCall(message)) continue;
    return index;
  }
  return -1;
}

function aggregateToolStatus(tools: ShadowToolSnapshot[]): 'running' | 'completed' | 'error' {
  if (tools.some((tool) => tool.status === 'error')) return 'error';
  if (tools.some((tool) => tool.status === 'running')) return 'running';
  return 'completed';
}

function artifactStatus(file: Pick<AttachedFileMeta, 'filePath' | 'gatewayUrl' | 'preview' | 'previewStatus' | 'fileSize'>): ShadowArtifactSnapshot['status'] {
  if (file.previewStatus === 'unavailable') return 'unavailable';
  if (file.fileSize > 0 || file.preview || file.filePath || file.gatewayUrl) return 'available';
  return 'registered';
}

function approvalStatus(value: unknown, itemStatus?: string): ShadowApprovalSnapshot['status'] {
  const normalized = readString(value)?.toLowerCase().replace(/[^a-z0-9]+/gu, '_') ?? '';
  if (/pending|waiting|requested|required/u.test(normalized)) return 'pending';
  if (/approved|allowed|accepted/u.test(normalized)) return 'approved';
  if (/reject|denied|declined/u.test(normalized)) return 'rejected';
  if (/cancel|aborted/u.test(normalized)) return 'cancelled';
  if (/expired|timeout/u.test(normalized)) return 'expired';
  if (/error|failed/u.test(normalized)) return 'error';
  if (/completed|resolved|consumed/u.test(normalized)) return 'completed';
  if (itemStatus === 'blocked') return 'pending';
  if (itemStatus === 'error') return 'error';
  if (itemStatus === 'completed') return 'completed';
  return 'unknown';
}

function artifactIdentity(
  artifact: { id?: string; filePath?: string; url?: string },
  turnKey: string,
  ordinal: number,
): string {
  return artifact.filePath?.trim()
    || artifact.url?.trim()
    || (artifact.id && !artifact.id.startsWith('history-artifact:') ? artifact.id : undefined)
    || `${turnKey}:artifact:${ordinal}`;
}

function buildLegacyTurn(
  sessionKey: string,
  turnIndex: number,
  userMessage: RawMessage,
  segment: readonly RawMessage[],
  refs: SemanticReferenceRegistry,
): { turn: FullSemanticTurn; finalMessage?: RawMessage } {
  const sessionRef = refs.ref('session', sessionKey, 'session');
  const turnKey = userMessage.id ?? `ordinal:${turnIndex}`;
  const turnRef = refs.ref('turn', turnKey, `turn:${turnIndex}`);
  const terminal = terminalAssistant(segment);
  const finalIndex = finalAssistantIndex(segment, terminal);
  const toolResults = collectLegacyToolResults(segment);
  const items: ShadowSemanticItemSnapshot[] = [{ kind: 'user-message', status: 'completed', entityRefs: [] }];
  const tools: ShadowToolSnapshot[] = [];
  const artifacts: ShadowArtifactSnapshot[] = [];
  let artifactGroupAdded = false;
  let toolOrdinal = 0;
  let artifactOrdinal = 0;

  segment.forEach((message, messageIndex) => {
    if (message.role !== 'assistant') return;
    if (hasThinking(message)) items.push({ kind: 'thinking', status: 'completed', entityRefs: [] });

    const messageTools = legacyToolCalls(message).map((tool): ShadowToolSnapshot => {
      const ordinal = toolOrdinal;
      toolOrdinal += 1;
      const rawId = tool.rawId ?? `${turnKey}:tool:${ordinal}`;
      return {
        ref: refs.ref('tool', rawId, `${turnKey}:tool:${ordinal}`),
        status: tool.rawId ? toolResults.get(tool.rawId) ?? 'running' : 'running',
        taskRef: tool.taskId ? refs.ref('task', tool.taskId, `${turnKey}:task:${ordinal}`) : undefined,
        parentTaskRef: tool.parentTaskId
          ? refs.ref('task', tool.parentTaskId, `${turnKey}:parent-task:${ordinal}`)
          : undefined,
      };
    });
    if (messageTools.length > 0) {
      tools.push(...messageTools);
      items.push({
        kind: 'tool-group',
        status: aggregateToolStatus(messageTools),
        entityRefs: messageTools.map((tool) => tool.ref),
      });
    }

    const text = displayText(message.content);
    if (terminal?.index === messageIndex) {
      items.push({ kind: 'error', status: 'error', entityRefs: [] });
    } else if (text) {
      items.push({
        kind: messageIndex === finalIndex ? 'final-answer' : 'commentary',
        status: 'completed',
        entityRefs: [],
      });
    }

    const outputFiles = (message._attachedFiles ?? []).filter((file) => file.disposition !== 'input-reference');
    if (outputFiles.length === 0) return;
    const refsForItem = outputFiles.map((file) => {
      const ordinal = artifactOrdinal;
      artifactOrdinal += 1;
      const ref = refs.ref(
        'artifact',
        file.filePath ?? file.gatewayUrl,
        `${turnKey}:artifact:${ordinal}`,
      );
      artifacts.push({ ref, status: artifactStatus(file) });
      return ref;
    });
    if (!artifactGroupAdded) {
      items.push({ kind: 'artifact-group', status: 'completed', entityRefs: refsForItem });
      artifactGroupAdded = true;
    } else {
      const group = items.find((item) => item.kind === 'artifact-group');
      if (group) group.entityRefs.push(...refsForItem);
    }
  });

  const terminalStatus = terminal?.status ?? (finalIndex >= 0 ? 'completed' : undefined);
  const status: string = terminal?.status
    ?? (finalIndex >= 0 ? 'completed' : tools.some((tool) => tool.status === 'running') ? 'running' : 'queued');
  return {
    finalMessage: finalIndex >= 0 ? segment[finalIndex] : undefined,
    turn: {
      sessionRef,
      turnRef,
      status,
      items,
      tools,
      tasks: [],
      artifacts,
      verifications: [],
      approvals: [],
      terminal: terminalStatus
        ? { status: terminalStatus, source: 'history', authority: 'authoritative' }
        : undefined,
    },
  };
}

function legacyHistoryProjection(
  sessionKey: string,
  messages: readonly RawMessage[],
  refs: SemanticReferenceRegistry,
): HistorySemanticProjection {
  const boundaries = messages
    .map((message, index) => isUserBoundary(message) ? index : -1)
    .filter((index) => index >= 0);
  const turns = boundaries.map((messageIndex, turnIndex) => {
    const end = boundaries[turnIndex + 1] ?? messages.length;
    return buildLegacyTurn(
      sessionKey,
      turnIndex,
      messages[messageIndex],
      messages.slice(messageIndex + 1, end),
      refs,
    );
  });
  const userDigests = boundaries.map((index) => messageFingerprint(messages[index]));
  const finalDigests = turns.flatMap((entry) => entry.finalMessage ? [messageFingerprint(entry.finalMessage)] : []);
  return {
    summary: {
      turnCount: turns.length,
      finalAnswerCount: finalDigests.length,
      errorTurnCount: turns.filter((entry) => entry.turn.status === 'error').length,
      abortedTurnCount: turns.filter((entry) => entry.turn.status === 'aborted').length,
    },
    snapshot: {
      coverage: 'history',
      sessionRef: refs.ref('session', sessionKey, 'session'),
      turns: turns.map((entry) => entry.turn),
    },
    userContentDigest: digest(userDigests),
    finalContentDigest: digest(finalDigests),
  };
}

function canonicalTerminal(turn: ConversationTurn): ShadowTerminalEvidenceSnapshot | undefined {
  if (turn.evidence.runTerminal) {
    return {
      status: turn.evidence.runTerminal,
      source: turn.evidence.runTerminalSource ?? 'unknown',
      authority: turn.evidence.runTerminalAuthority ?? 'inferred',
    };
  }
  const status = turn.status === 'completed'
    ? 'completed'
    : turn.status === 'aborted'
      ? 'aborted'
      : turn.status === 'error' || turn.status === 'partial'
        ? 'error'
        : undefined;
  if (!status) return undefined;
  if (turn.evidence.historyCheckpointed) {
    return { status, source: 'history', authority: 'authoritative' };
  }
  if (turn.evidence.backendIdle) {
    return { status, source: 'host', authority: 'authoritative' };
  }
  return { status, source: 'derived', authority: 'inferred' };
}

function canonicalArtifactStatus(
  artifact: {
    filePath?: string;
    url?: string;
    preview?: string | null;
    previewStatus?: 'unavailable';
    sizeBytes?: number;
    availability?: 'registered' | 'available' | 'unavailable' | 'error';
  },
  itemStatus: TimelineItem['status'],
): ShadowArtifactSnapshot['status'] {
  if (artifact.availability) return artifact.availability;
  if (itemStatus === 'error') return 'error';
  if (artifact.previewStatus === 'unavailable') return 'unavailable';
  if (artifact.filePath || artifact.url || artifact.preview || (artifact.sizeBytes ?? 0) > 0) return 'available';
  return 'registered';
}

function buildCanonicalTurn(
  turn: ConversationTurn,
  turnIndex: number,
  refs: SemanticReferenceRegistry,
): FullSemanticTurn {
  const turnKey = turn.trigger.message.id ?? `ordinal:${turnIndex}`;
  const sessionRef = refs.ref('session', turn.sessionKey, `turn-session:${turnIndex}`);
  const turnRef = refs.ref('turn', turnKey, `turn:${turnIndex}`);
  const items: ShadowSemanticItemSnapshot[] = [];
  const tools: ShadowToolSnapshot[] = [];
  const tasks: ShadowTaskSnapshot[] = [];
  const artifacts: ShadowArtifactSnapshot[] = [];
  const verifications: ShadowVerificationSnapshot[] = [];
  const approvals: ShadowApprovalSnapshot[] = [];
  const seenTaskRefs = new Set<string>();
  let toolOrdinal = 0;
  let taskOrdinal = 0;
  let artifactOrdinal = 0;
  let verificationOrdinal = 0;
  let approvalOrdinal = 0;

  for (const item of turn.items) {
    const entityRefs: string[] = [];
    if (item.kind === 'tool-group') {
      for (const entry of item.entries) {
        const ordinal = toolOrdinal;
        toolOrdinal += 1;
        const ref = refs.ref('tool', entry.toolCallId, `${turnKey}:tool:${ordinal}`);
        entityRefs.push(ref);
        tools.push({
          ref,
          status: entry.status,
          taskRef: entry.taskId ? refs.ref('task', entry.taskId, `${turnKey}:task:${ordinal}`) : undefined,
          parentTaskRef: entry.parentTaskId
            ? refs.ref('task', entry.parentTaskId, `${turnKey}:parent-task:${ordinal}`)
            : undefined,
        });
      }
    } else if (item.kind === 'subtask') {
      for (const task of item.tasks) {
        const ordinal = taskOrdinal;
        taskOrdinal += 1;
        const ref = refs.ref('task', task.taskId, `${turnKey}:task:${ordinal}`);
        entityRefs.push(ref);
        if (seenTaskRefs.has(ref)) continue;
        seenTaskRefs.add(ref);
        tasks.push({
          ref,
          status: task.status,
          parentTaskRef: task.parentTaskId
            ? refs.ref('task', task.parentTaskId, `${turnKey}:parent-task:${ordinal}`)
            : undefined,
        });
      }
    } else if (item.kind === 'artifact-group') {
      for (const artifact of item.artifacts) {
        const ordinal = artifactOrdinal;
        artifactOrdinal += 1;
        const ref = refs.ref(
          'artifact',
          artifactIdentity(artifact, turnKey, ordinal),
          `${turnKey}:artifact:${ordinal}`,
        );
        entityRefs.push(ref);
        artifacts.push({ ref, status: canonicalArtifactStatus(artifact, item.status) });
      }
    } else if (item.kind === 'verification-summary') {
      for (const verification of item.verifications) {
        const ordinal = verificationOrdinal;
        verificationOrdinal += 1;
        const ref = refs.ref('verification', verification.id, `${turnKey}:verification:${ordinal}`);
        entityRefs.push(ref);
        verifications.push({ ref, status: verification.status });
      }
    } else if (item.kind === 'approval') {
      const ordinal = approvalOrdinal;
      approvalOrdinal += 1;
      const rawId = item.itemId ?? item.taskId ?? item.id;
      const ref = refs.ref('approval', rawId, `${turnKey}:approval:${ordinal}`);
      entityRefs.push(ref);
      approvals.push({
        ref,
        status: approvalStatus(item.approvalStatus ?? item.phase, item.status),
        taskRef: item.taskId ? refs.ref('task', item.taskId, `${turnKey}:approval-task:${ordinal}`) : undefined,
      });
    }
    items.push({ kind: item.kind, status: item.status, entityRefs });
  }

  for (const taskId of turn.taskIds) {
    const task = turn.taskById[taskId];
    if (!task) continue;
    const ordinal = taskOrdinal;
    taskOrdinal += 1;
    const ref = refs.ref('task', task.taskId, `${turnKey}:task:${ordinal}`);
    if (seenTaskRefs.has(ref)) continue;
    seenTaskRefs.add(ref);
    tasks.push({
      ref,
      status: task.status,
      parentTaskRef: task.parentTaskId
        ? refs.ref('task', task.parentTaskId, `${turnKey}:parent-task:${ordinal}`)
        : undefined,
    });
  }

  return {
    sessionRef,
    turnRef,
    status: turn.status,
    items,
    tools,
    tasks,
    artifacts,
    verifications,
    approvals,
    terminal: canonicalTerminal(turn),
  };
}

function canonicalHistoryProjection(
  state: ConversationState,
  sessionKey: string,
  refs: SemanticReferenceRegistry,
): HistorySemanticProjection {
  const turns = (state.turnOrderBySession[sessionKey] ?? [])
    .map((turnId) => state.turnsById[turnId])
    .filter((turn): turn is ConversationTurn => Boolean(turn));
  const semanticTurns = turns.map((turn, index) => buildCanonicalTurn(turn, index, refs));
  const userDigests = turns.map((turn) => messageFingerprint(turn.trigger.message));
  const finalDigests = turns.flatMap((turn) => {
    const final = [...turn.items].reverse().find((item) => item.kind === 'final-answer');
    return final?.kind === 'final-answer' ? [messageFingerprint(final.message)] : [];
  });
  return {
    summary: {
      turnCount: turns.length,
      finalAnswerCount: finalDigests.length,
      errorTurnCount: turns.filter((turn) => turn.status === 'error').length,
      abortedTurnCount: turns.filter((turn) => turn.status === 'aborted').length,
    },
    snapshot: {
      coverage: 'history',
      sessionRef: refs.ref('session', sessionKey, 'session'),
      turns: semanticTurns,
    },
    userContentDigest: digest(userDigests),
    finalContentDigest: digest(finalDigests),
  };
}

function boundedEntries<T>(values: T[], limit: number): { entries: T[]; omitted: number } {
  if (values.length <= limit) return { entries: values, omitted: 0 };
  const headCount = Math.ceil(limit / 2);
  const tailCount = Math.floor(limit / 2);
  return {
    entries: [...values.slice(0, headCount), ...values.slice(-tailCount)],
    omitted: values.length - limit,
  };
}

function compactTurn(turn: FullSemanticTurn): ShadowSemanticTurnSnapshot {
  const itemWindow = boundedEntries(turn.items, SHADOW_SNAPSHOT_ITEM_LIMIT);
  const toolWindow = boundedEntries(turn.tools, SHADOW_SNAPSHOT_ENTITY_LIMIT);
  const taskWindow = boundedEntries(turn.tasks, SHADOW_SNAPSHOT_ENTITY_LIMIT);
  const artifactWindow = boundedEntries(turn.artifacts, SHADOW_SNAPSHOT_ENTITY_LIMIT);
  const verificationWindow = boundedEntries(turn.verifications, SHADOW_SNAPSHOT_ENTITY_LIMIT);
  const approvalWindow = boundedEntries(turn.approvals, SHADOW_SNAPSHOT_ENTITY_LIMIT);
  return {
    sessionRef: turn.sessionRef,
    turnRef: turn.turnRef,
    status: turn.status,
    itemCount: turn.items.length,
    omittedItemCount: itemWindow.omitted,
    items: itemWindow.entries,
    toolCount: turn.tools.length,
    omittedToolCount: toolWindow.omitted,
    tools: toolWindow.entries,
    taskCount: turn.tasks.length,
    omittedTaskCount: taskWindow.omitted,
    tasks: taskWindow.entries,
    artifactCount: turn.artifacts.length,
    omittedArtifactCount: artifactWindow.omitted,
    artifacts: artifactWindow.entries,
    verificationCount: turn.verifications.length,
    omittedVerificationCount: verificationWindow.omitted,
    verifications: verificationWindow.entries,
    approvalCount: turn.approvals.length,
    omittedApprovalCount: approvalWindow.omitted,
    approvals: approvalWindow.entries,
    terminal: turn.terminal,
  };
}

function compactSnapshot(snapshot: FullSemanticSnapshot): ShadowSemanticSnapshot {
  const turnWindow = boundedEntries(snapshot.turns, SHADOW_SNAPSHOT_TURN_LIMIT);
  return {
    version: 1,
    coverage: snapshot.coverage,
    sessionRef: snapshot.sessionRef,
    turnCount: snapshot.turns.length,
    omittedTurnCount: turnWindow.omitted,
    turns: turnWindow.entries.map(compactTurn),
  };
}

function compareSummaries(
  legacy: ShadowSemanticSummary,
  canonical: ShadowSemanticSummary,
  fields: Array<keyof ShadowSemanticSummary>,
): ShadowSemanticDifference[] {
  return fields.flatMap((field) => (
    legacy[field] === canonical[field]
      ? []
      : [{
          field,
          legacy: legacy[field] ?? null,
          canonical: canonical[field] ?? null,
        }]
  ));
}

function semanticCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length;
  return value == null ? 0 : 1;
}

function compareSemanticField(
  differences: ShadowSemanticDifference[],
  field: ShadowSemanticField,
  legacy: unknown,
  canonical: unknown,
): void {
  if (stableSerialize(legacy) === stableSerialize(canonical)) return;
  differences.push({
    field,
    legacy: semanticCount(legacy),
    canonical: semanticCount(canonical),
  });
}

function compareHistorySnapshots(
  legacy: FullSemanticSnapshot,
  canonical: FullSemanticSnapshot,
): ShadowSemanticDifference[] {
  const differences: ShadowSemanticDifference[] = [];
  compareSemanticField(differences, 'sessionOwnership', {
    sessionRef: legacy.sessionRef,
    turnSessionRefs: legacy.turns.map((turn) => turn.sessionRef),
  }, {
    sessionRef: canonical.sessionRef,
    turnSessionRefs: canonical.turns.map((turn) => turn.sessionRef),
  });
  compareSemanticField(
    differences,
    'turnOwnership',
    legacy.turns.map((turn) => turn.turnRef),
    canonical.turns.map((turn) => turn.turnRef),
  );
  compareSemanticField(
    differences,
    'turnStatus',
    legacy.turns.map((turn) => [turn.turnRef, turn.status]),
    canonical.turns.map((turn) => [turn.turnRef, turn.status]),
  );
  compareSemanticField(
    differences,
    'itemOrder',
    legacy.turns.map((turn) => [
      turn.turnRef,
      turn.items.map((item) => [item.kind, item.entityRefs]),
    ]),
    canonical.turns.map((turn) => [
      turn.turnRef,
      turn.items.map((item) => [item.kind, item.entityRefs]),
    ]),
  );
  compareSemanticField(
    differences,
    'itemStatus',
    legacy.turns.map((turn) => [turn.turnRef, turn.items.map((item) => [item.kind, item.status])]),
    canonical.turns.map((turn) => [turn.turnRef, turn.items.map((item) => [item.kind, item.status])]),
  );
  compareSemanticField(
    differences,
    'tools',
    legacy.turns.map((turn) => [turn.turnRef, turn.tools]),
    canonical.turns.map((turn) => [turn.turnRef, turn.tools]),
  );
  compareSemanticField(
    differences,
    'tasks',
    legacy.turns.map((turn) => [turn.turnRef, turn.tasks]),
    canonical.turns.map((turn) => [turn.turnRef, turn.tasks]),
  );
  compareSemanticField(
    differences,
    'artifacts',
    legacy.turns.map((turn) => [turn.turnRef, turn.artifacts]),
    canonical.turns.map((turn) => [turn.turnRef, turn.artifacts]),
  );
  compareSemanticField(
    differences,
    'verifications',
    legacy.turns.map((turn) => [turn.turnRef, turn.verifications]),
    canonical.turns.map((turn) => [turn.turnRef, turn.verifications]),
  );
  compareSemanticField(
    differences,
    'approvals',
    legacy.turns.map((turn) => [turn.turnRef, turn.approvals]),
    canonical.turns.map((turn) => [turn.turnRef, turn.approvals]),
  );
  compareSemanticField(
    differences,
    'terminalStatus',
    legacy.turns.map((turn) => [turn.turnRef, turn.terminal?.status ?? 'missing']),
    canonical.turns.map((turn) => [turn.turnRef, turn.terminal?.status ?? 'missing']),
  );
  compareSemanticField(
    differences,
    'terminalProvenance',
    legacy.turns.map((turn) => [
      turn.turnRef,
      turn.terminal ? [turn.terminal.source, turn.terminal.authority] : null,
    ]),
    canonical.turns.map((turn) => [
      turn.turnRef,
      turn.terminal ? [turn.terminal.source, turn.terminal.authority] : null,
    ]),
  );
  return differences;
}

const HISTORY_COMPARED_FIELDS: ShadowSemanticField[] = [
  'turnCount',
  'finalAnswerCount',
  'errorTurnCount',
  'abortedTurnCount',
  'userContent',
  'finalContent',
  'sessionOwnership',
  'turnOwnership',
  'turnStatus',
  'itemOrder',
  'itemStatus',
  'tools',
  'tasks',
  'artifacts',
  'verifications',
  'approvals',
  'terminalStatus',
  'terminalProvenance',
];

export function createHistoryShadowComparison(input: {
  state: ConversationState;
  sessionKey: string;
  visibleMessages: readonly RawMessage[];
  checkpointReason?: ShadowComparisonRecord['checkpointReason'];
  checkedAt?: number;
}): ShadowComparisonRecord {
  const refs = new SemanticReferenceRegistry();
  const legacyProjection = legacyHistoryProjection(input.sessionKey, input.visibleMessages, refs);
  const canonicalProjection = canonicalHistoryProjection(input.state, input.sessionKey, refs);
  const legacy = legacyProjection.summary;
  const canonical = canonicalProjection.summary;
  const differences = compareSummaries(legacy, canonical, [
    'turnCount',
    'finalAnswerCount',
    'errorTurnCount',
    'abortedTurnCount',
  ]);
  if (legacyProjection.userContentDigest !== canonicalProjection.userContentDigest) {
    differences.push({ field: 'userContent', legacy: true, canonical: false });
  }
  if (legacyProjection.finalContentDigest !== canonicalProjection.finalContentDigest) {
    differences.push({ field: 'finalContent', legacy: true, canonical: false });
  }
  differences.push(...compareHistorySnapshots(legacyProjection.snapshot, canonicalProjection.snapshot));
  const legacySnapshot = compactSnapshot(legacyProjection.snapshot);
  const canonicalSnapshot = compactSnapshot(canonicalProjection.snapshot);
  return {
    reason: 'history-checkpoint',
    checkpointReason: input.checkpointReason,
    checkedAt: input.checkedAt ?? Date.now(),
    matched: differences.length === 0,
    comparedFields: HISTORY_COMPARED_FIELDS,
    association: {
      sessionRef: canonicalSnapshot.sessionRef,
      turnRefs: canonicalSnapshot.turns.map((turn) => turn.turnRef),
    },
    differences,
    legacy,
    canonical,
    legacySnapshot,
    canonicalSnapshot,
  };
}

export function createTerminalShadowComparison(input: {
  state: ConversationState;
  sessionKey: string;
  runId: string;
  expectedStatus: Exclude<ShadowTerminalStatus, 'missing'>;
  legacyRunStatus?: Exclude<ShadowTerminalStatus, 'missing'>;
  checkedAt?: number;
}): ShadowComparisonRecord | null {
  const turnId = input.state.aliases.byRunId[createSessionAliasKey(input.sessionKey, input.runId)];
  const turn = turnId ? input.state.turnsById[turnId] : undefined;
  if (turn?.evidence.runTerminalAuthority !== 'authoritative') return null;

  const refs = new SemanticReferenceRegistry();
  const sessionRef = refs.ref('session', input.sessionKey, 'session');
  const runRef = refs.ref('run', input.runId, 'run');
  const canonicalTurn = buildCanonicalTurn(turn, 0, refs);
  const legacyTerminalStatus = input.legacyRunStatus ?? 'missing';
  const legacyTurn: FullSemanticTurn = {
    sessionRef,
    turnRef: canonicalTurn.turnRef,
    status: legacyTerminalStatus,
    items: [],
    tools: [],
    tasks: [],
    artifacts: [],
    verifications: [],
    approvals: [],
    terminal: legacyTerminalStatus === 'missing'
      ? undefined
      : { status: legacyTerminalStatus, source: 'legacy-runtime', authority: 'authoritative' },
  };
  const legacySnapshot = compactSnapshot({ coverage: 'terminal-only', sessionRef, turns: [legacyTurn] });
  const canonicalSnapshot = compactSnapshot({ coverage: 'terminal-only', sessionRef, turns: [canonicalTurn] });
  const canonicalTerminalStatus = canonicalTurn.terminal?.status ?? 'missing';
  const legacy: ShadowSemanticSummary = { terminalStatus: legacyTerminalStatus };
  const canonical: ShadowSemanticSummary = { terminalStatus: canonicalTerminalStatus };
  const differences: ShadowSemanticDifference[] = [];
  if (legacyTerminalStatus !== input.expectedStatus || canonicalTerminalStatus !== input.expectedStatus) {
    differences.push({
      field: 'terminalStatus',
      legacy: legacyTerminalStatus,
      canonical: canonicalTerminalStatus,
    });
  }
  if (!canonicalTurn.terminal || canonicalTurn.terminal.authority !== 'authoritative') {
    differences.push({
      field: 'terminalProvenance',
      legacy: legacyTurn.terminal ? 1 : 0,
      canonical: canonicalTurn.terminal ? 1 : 0,
    });
  }
  return {
    reason: 'authoritative-terminal',
    checkedAt: input.checkedAt ?? Date.now(),
    matched: differences.length === 0,
    comparedFields: ['terminalStatus', 'terminalProvenance'],
    association: {
      sessionRef,
      turnRefs: [canonicalTurn.turnRef],
      runRef,
    },
    differences,
    legacy,
    canonical,
    legacySnapshot,
    canonicalSnapshot,
  };
}

export function appendShadowComparison(
  cache: ShadowComparisonCache,
  sessionKey: string,
  comparison: ShadowComparisonRecord,
): ShadowComparisonCache {
  const sessionOrder = cache.sessionOrder.filter((key) => key !== sessionKey);
  sessionOrder.push(sessionKey);
  const bySession = {
    ...cache.bySession,
    [sessionKey]: [...(cache.bySession[sessionKey] ?? []), comparison]
      .slice(-SHADOW_COMPARISON_RECORD_LIMIT),
  };
  while (sessionOrder.length > SHADOW_COMPARISON_SESSION_LIMIT) {
    const removed = sessionOrder.shift();
    if (removed) delete bySession[removed];
  }
  return { bySession, sessionOrder };
}

/** Telemetry contains controlled fields and counts only; semantic snapshots stay local. */
export function shadowComparisonTelemetry(comparison: ShadowComparisonRecord): Record<string, unknown> {
  return {
    reason: comparison.reason,
    checkpointReason: comparison.checkpointReason,
    matched: comparison.matched,
    comparedFields: comparison.comparedFields,
    differenceFields: comparison.differences.map((difference) => difference.field),
    differenceCount: comparison.differences.length,
    legacyTurnCount: comparison.legacy.turnCount,
    canonicalTurnCount: comparison.canonical.turnCount,
    legacyFinalAnswerCount: comparison.legacy.finalAnswerCount,
    canonicalFinalAnswerCount: comparison.canonical.finalAnswerCount,
    legacyTerminalStatus: comparison.legacy.terminalStatus,
    canonicalTerminalStatus: comparison.canonical.terminalStatus,
    legacySnapshotTurnCount: comparison.legacySnapshot.turnCount,
    canonicalSnapshotTurnCount: comparison.canonicalSnapshot.turnCount,
  };
}
