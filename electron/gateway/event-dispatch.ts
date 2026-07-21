import { GatewayEventType, type JsonRpcNotification } from './protocol';
import { logger } from '../utils/logger';
import {
  CHAT_SYNTHETIC_TERMINAL_PRODUCER,
  type ChatRuntimeEvent,
} from '../../shared/chat-runtime-events';
import {
  normalizeGatewayChatTerminalRuntimeEvent,
  normalizeGatewayApprovalRuntimeEvent,
  normalizeGatewayChatRuntimeEvent,
  normalizeGatewayChatRuntimeEvents,
} from './chat-runtime-events';

type GatewayEventEmitter = {
  emit: (event: string, payload: unknown) => boolean;
};

type TerminalRuntimeEvent = Extract<ChatRuntimeEvent, { type: 'run.ended' }>;
type ApprovalRuntimeEvent = Extract<ChatRuntimeEvent, { type: 'approval.updated' }>;
type TerminalRunRecord = {
  status: TerminalRuntimeEvent['status'];
  authoritative: boolean;
  endedAt?: number;
};

const MAX_TERMINAL_RUNS_PER_EMITTER = 2_048;
const emittedTerminalRuns = new WeakMap<GatewayEventEmitter, Map<string, TerminalRunRecord>>();
const MAX_APPROVAL_EXPIRY_TIMERS_PER_EMITTER = 2_048;
const approvalExpiryTimers = new WeakMap<GatewayEventEmitter, Map<string, ReturnType<typeof setTimeout>>>();
const terminalApprovalKeys = new WeakMap<GatewayEventEmitter, Map<string, true>>();
const MAX_PENDING_APPROVAL_SESSIONS_PER_EMITTER = 2_048;
// Retain only trusted routing identity; approval request content stays in the canonical event stream.
const pendingApprovalSessions = new WeakMap<GatewayEventEmitter, Map<string, string>>();

function nativeApprovalIdentityKey(
  approvalKind: ApprovalRuntimeEvent['approvalKind'],
  approvalId: string | undefined,
): string | null {
  if ((approvalKind !== 'exec' && approvalKind !== 'plugin') || !approvalId) return null;
  return `${approvalKind}:${approvalId}`;
}

function lookupPendingApprovalSession(
  emitter: GatewayEventEmitter,
  approvalKind: 'exec' | 'plugin',
  approvalId: string,
): string | undefined {
  const sessions = pendingApprovalSessions.get(emitter);
  const key = nativeApprovalIdentityKey(approvalKind, approvalId);
  if (!sessions || !key) return undefined;
  const sessionKey = sessions.get(key);
  if (!sessionKey) return undefined;
  sessions.delete(key);
  sessions.set(key, sessionKey);
  return sessionKey;
}

function rememberPendingApprovalSession(emitter: GatewayEventEmitter, event: ApprovalRuntimeEvent): void {
  const key = nativeApprovalIdentityKey(event.approvalKind, event.approvalId);
  if (!key || !event.sessionKey) return;
  let sessions = pendingApprovalSessions.get(emitter);
  if (!sessions) {
    sessions = new Map();
    pendingApprovalSessions.set(emitter, sessions);
  }
  sessions.delete(key);
  sessions.set(key, event.sessionKey);
  while (sessions.size > MAX_PENDING_APPROVAL_SESSIONS_PER_EMITTER) {
    const oldestKey = sessions.keys().next().value;
    if (!oldestKey) break;
    sessions.delete(oldestKey);
  }
}

function forgetPendingApprovalSession(emitter: GatewayEventEmitter, event: ApprovalRuntimeEvent): void {
  const key = nativeApprovalIdentityKey(event.approvalKind, event.approvalId);
  if (key) pendingApprovalSessions.get(emitter)?.delete(key);
}

function approvalEventKey(event: ApprovalRuntimeEvent): string | null {
  if (!event.approvalId || !event.approvalKind || !event.sessionKey) return null;
  return `${event.sessionKey.length}:${event.sessionKey}:${event.approvalKind}:${event.approvalId}`;
}

function cancelApprovalExpiry(emitter: GatewayEventEmitter, event: ApprovalRuntimeEvent): void {
  const key = approvalEventKey(event);
  if (!key) return;
  const timers = approvalExpiryTimers.get(emitter);
  const timer = timers?.get(key);
  if (!timer) return;
  clearTimeout(timer);
  timers?.delete(key);
}

function hasTerminalApproval(emitter: GatewayEventEmitter, event: ApprovalRuntimeEvent): boolean {
  const key = approvalEventKey(event);
  return key ? terminalApprovalKeys.get(emitter)?.has(key) === true : false;
}

function markTerminalApproval(emitter: GatewayEventEmitter, event: ApprovalRuntimeEvent): void {
  const key = approvalEventKey(event);
  if (!key) return;
  let approvals = terminalApprovalKeys.get(emitter);
  if (!approvals) {
    approvals = new Map();
    terminalApprovalKeys.set(emitter, approvals);
  }
  approvals.delete(key);
  approvals.set(key, true);
  while (approvals.size > MAX_APPROVAL_EXPIRY_TIMERS_PER_EMITTER) {
    const oldestKey = approvals.keys().next().value;
    if (!oldestKey) break;
    approvals.delete(oldestKey);
  }
}

function scheduleApprovalExpiry(emitter: GatewayEventEmitter, event: ApprovalRuntimeEvent): void {
  const key = approvalEventKey(event);
  if (!key || event.expiresAt == null) return;
  cancelApprovalExpiry(emitter, event);

  let timers = approvalExpiryTimers.get(emitter);
  if (!timers) {
    timers = new Map();
    approvalExpiryTimers.set(emitter, timers);
  }

  const timer = setTimeout(() => {
    if (timers?.get(key) !== timer) return;
    timers.delete(key);
    dispatchCanonicalApprovalRuntimeEvent(emitter, {
      ...event,
      producer: 'gateway-approval-expiry',
      ts: event.expiresAt,
      decision: undefined,
      actionable: false,
      phase: 'resolved',
      status: 'expired',
      resolutionSource: 'gateway',
    });
  }, Math.max(0, event.expiresAt - Date.now()));
  timer.unref();
  timers.set(key, timer);

  while (timers.size > MAX_APPROVAL_EXPIRY_TIMERS_PER_EMITTER) {
    const oldestKey = timers.keys().next().value;
    if (!oldestKey) break;
    const oldest = timers.get(oldestKey);
    if (oldest) clearTimeout(oldest);
    timers.delete(oldestKey);
  }
}

function terminalRunKey(event: Pick<ChatRuntimeEvent, 'runId' | 'sessionKey'>): string {
  const sessionKey = event.sessionKey ?? '';
  return `${sessionKey.length}:${sessionKey}${event.runId}`;
}

function terminalStatusRank(status: TerminalRuntimeEvent['status']): number {
  if (status === 'error') return 3;
  if (status === 'aborted') return 2;
  return 1;
}

function runtimeTimestampMs(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return value > 0 && value < 100_000_000_000 ? value * 1_000 : value;
}

function markTerminalRunEmitted(
  emitter: GatewayEventEmitter,
  event: TerminalRuntimeEvent,
): boolean {
  if (event.producer === 'history') return true;

  let runs = emittedTerminalRuns.get(emitter);
  if (!runs) {
    runs = new Map<string, TerminalRunRecord>();
    emittedTerminalRuns.set(emitter, runs);
  }

  const key = terminalRunKey(event);
  const existing = runs.get(key);
  const authoritative = event.producer !== CHAT_SYNTHETIC_TERMINAL_PRODUCER;
  const endedAt = runtimeTimestampMs(event.endedAt ?? event.ts);
  if (existing) {
    if (existing.status === event.status) {
      if (authoritative && !existing.authoritative) {
        runs.set(key, { status: event.status, authoritative: true, endedAt: endedAt ?? existing.endedAt });
      }
      return false;
    }
    if (existing.authoritative && !authoritative) return false;
    if (!existing.authoritative && authoritative) {
      runs.set(key, { status: event.status, authoritative: true, endedAt: endedAt ?? existing.endedAt });
      return true;
    }
    if (terminalStatusRank(event.status) <= terminalStatusRank(existing.status)) return false;
  }

  runs.set(key, { status: event.status, authoritative, endedAt });
  if (runs.size > MAX_TERMINAL_RUNS_PER_EMITTER) {
    const oldest = runs.keys().next().value;
    if (oldest != null) runs.delete(oldest);
  }
  return true;
}

function beginRuntimeRun(emitter: GatewayEventEmitter, event: Extract<ChatRuntimeEvent, { type: 'run.started' }>): void {
  const runs = emittedTerminalRuns.get(emitter);
  const existing = runs?.get(terminalRunKey(event));
  if (!runs || !existing) return;

  const startedAt = runtimeTimestampMs(event.startedAt ?? event.ts);
  if (startedAt == null || existing.endedAt == null || startedAt > existing.endedAt) {
    runs.delete(terminalRunKey(event));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function countTextChars(value: unknown): number {
  if (typeof value === 'string') return Array.from(value).length;
  if (!Array.isArray(value)) return 0;
  return value.reduce((sum, item) => {
    if (typeof item === 'string') return sum + Array.from(item).length;
    if (isRecord(item) && typeof item.text === 'string') {
      return sum + Array.from(item.text).length;
    }
    if (isRecord(item) && typeof item.content === 'string') {
      return sum + Array.from(item.content).length;
    }
    return sum;
  }, 0);
}

function summarizeToolCallNames(toolCalls: unknown[]): string[] {
  return toolCalls.map((toolCall) => {
    if (!isRecord(toolCall)) return null;
    if (typeof toolCall.name === 'string') return toolCall.name;
    if (isRecord(toolCall.function) && typeof toolCall.function.name === 'string') {
      return toolCall.function.name;
    }
    if (typeof toolCall.type === 'string') return toolCall.type;
    return null;
  }).filter((name): name is string => Boolean(name)).slice(0, 30);
}

function summarizeChatMessagePayload(payload: unknown): Record<string, unknown> {
  const message = isRecord(payload) && isRecord(payload.message) ? payload.message : payload;
  if (!isRecord(message)) {
    return {
      messageKind: typeof message,
    };
  }

  const content = message.content;
  const toolCalls = asArray(message.tool_calls ?? message.toolCalls);
  const output = asArray(message.output);
  const outputTypes = output.map((item) => (
    isRecord(item) && typeof item.type === 'string' ? item.type : null
  )).filter(Boolean);
  const contentTypes = asArray(content).map((item) => (
    isRecord(item) && typeof item.type === 'string' ? item.type : null
  )).filter(Boolean);

  return {
    role: typeof message.role === 'string' ? message.role : undefined,
    messageType: typeof message.type === 'string' ? message.type : undefined,
    contentKind: Array.isArray(content) ? 'array' : typeof content,
    contentParts: Array.isArray(content) ? content.length : undefined,
    contentTextChars: countTextChars(content),
    hasToolCalls: toolCalls.length > 0,
    toolCallsCount: toolCalls.length,
    toolCallNames: summarizeToolCallNames(toolCalls),
    hasFunctionCall: Boolean(message.function_call ?? message.functionCall),
    outputCount: output.length,
    outputTypes: outputTypes.slice(0, 20),
    contentTypes: contentTypes.slice(0, 20),
    finishReason: typeof message.finish_reason === 'string' ? message.finish_reason : undefined,
    topLevelKeys: Object.keys(message).sort(),
  };
}

export function shouldLogChatMessageDiagnostic(payload: unknown): boolean {
  const summary = summarizeChatMessagePayload(payload);
  const envelope = isRecord(payload) ? payload : null;
  const state = typeof envelope?.state === 'string' ? envelope.state : undefined;
  const structuredContent = Array.isArray(summary.contentTypes)
    && summary.contentTypes.some((type) => (
      type === 'toolCall'
      || type === 'toolResult'
      || type === 'function_call'
      || type === 'function_call_output'
    ));
  const structuredDelta = summary.hasToolCalls === true
    || summary.hasFunctionCall === true
    || structuredContent
    || (typeof summary.outputCount === 'number' && summary.outputCount > 0);
  // Plain text deltas can arrive dozens of times per second. Logging each one
  // competes with the renderer for the same Main-process event loop.
  return state !== 'delta' || structuredDelta;
}

function logChatMessageDiagnostic(payload: unknown): void {
  if (!shouldLogChatMessageDiagnostic(payload)) return;
  const envelope = isRecord(payload) ? payload : null;
  const state = typeof envelope?.state === 'string' ? envelope.state : undefined;
  const summary = summarizeChatMessagePayload(payload);
  logger.info('[diagnostic] chat.message.signal', { state, ...summary });
}

function logChatRuntimeDiagnostic(event: ReturnType<typeof normalizeGatewayChatRuntimeEvent>): void {
  if (!event) return;
  if (event.type === 'assistant.delta' || event.type === 'thinking.delta') return;

  const base = {
    type: event.type,
    contractVersion: event.contractVersion,
    producer: event.producer,
    runId: event.runId,
    sessionKey: event.sessionKey,
    seq: event.seq,
  };

  if (event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'tool.updated') {
    logger.info('[metric] chat.runtime.event', {
      ...base,
      toolCallId: event.toolCallId,
      name: event.name,
      isError: event.type === 'tool.completed' ? event.isError : undefined,
      durationMs: event.type === 'tool.completed' ? event.durationMs : undefined,
    });
    return;
  }

  if (event.type === 'progress.update') {
    logger.info('[metric] chat.runtime.event', {
      ...base,
      progressId: event.entry.id,
      progressKind: event.entry.kind,
      progressStatus: event.entry.status,
      progressSource: event.entry.source,
      toolCallId: event.entry.toolCallId,
    });
    return;
  }

  if (event.type === 'run.ended') {
    logger.info('[metric] chat.runtime.event', {
      ...base,
      status: event.status,
      stopReason: event.stopReason,
      error: event.error,
      livenessState: event.livenessState,
    });
    return;
  }

  if (event.type === 'run.plan.updated') {
    logger.info('[metric] chat.runtime.event', {
      ...base,
      stepCount: event.steps.length,
      hasObjective: Boolean(event.objective),
      hasSummary: Boolean(event.summary),
    });
    return;
  }

  if (event.type === 'run.step.updated') {
    logger.info('[metric] chat.runtime.event', {
      ...base,
      stepId: event.step.id,
      status: event.step.status,
      kind: event.step.kind,
    });
    return;
  }

  if (event.type === 'artifact.produced') {
    logger.info('[metric] chat.runtime.event', {
      ...base,
      artifactId: event.artifact.id,
      kind: event.artifact.kind,
      mimeType: event.artifact.mimeType,
      hasFilePath: Boolean(event.artifact.filePath),
      hasUrl: Boolean(event.artifact.url),
      toolCallId: event.toolCallId,
    });
    return;
  }

  if (event.type === 'verification.completed') {
    logger.info('[metric] chat.runtime.event', {
      ...base,
      verificationId: event.verification.id,
      status: event.verification.status,
      kind: event.verification.kind,
      required: event.verification.required,
      severity: event.verification.severity,
      artifactId: event.verification.artifactId,
      targetId: event.verification.targetId,
      toolCallId: event.toolCallId,
    });
    return;
  }

  if (event.type === 'command.output') {
    logger.info('[metric] chat.runtime.event', {
      ...base,
      name: event.name,
      status: event.status,
      phase: event.phase,
      exitCode: event.exitCode,
      durationMs: event.durationMs,
    });
    return;
  }

  if (event.type === 'patch.completed') {
    logger.info('[metric] chat.runtime.event', {
      ...base,
      name: event.name,
      added: event.added,
      modified: event.modified,
      deleted: event.deleted,
    });
    return;
  }

  if (event.type === 'approval.updated') {
    logger.info('[metric] chat.runtime.event', {
      ...base,
      kind: event.kind,
      phase: event.phase,
      status: event.status,
    });
    return;
  }

  logger.info('[metric] chat.runtime.event', base);
}

function isChatRuntimeGatewayEventName(event: string): boolean {
  return event === 'agent'
    || event === 'agent.runtime'
    || event === 'chat.runtime_event'
    || event === 'runtime.event';
}

function isApprovalGatewayEventName(event: string): boolean {
  return event === 'exec.approval.requested'
    || event === 'exec.approval.resolved'
    || event === 'plugin.approval.requested'
    || event === 'plugin.approval.resolved';
}

function dispatchApprovalRuntimeEvent(
  emitter: GatewayEventEmitter,
  eventName: string,
  payload: unknown,
): void {
  const event = normalizeGatewayApprovalRuntimeEvent(eventName, payload, {
    lookupSessionKey: (approvalKind, approvalId) => (
      lookupPendingApprovalSession(emitter, approvalKind, approvalId)
    ),
  });
  if (!event) return;
  dispatchCanonicalApprovalRuntimeEvent(emitter, event);
}

/** Emit a canonical approval and arm/cancel its expiry timer for replayed snapshots. */
export function dispatchCanonicalApprovalRuntimeEvent(
  emitter: GatewayEventEmitter,
  event: ApprovalRuntimeEvent,
): void {
  if (event.phase === 'requested' && hasTerminalApproval(emitter, event)) {
    cancelApprovalExpiry(emitter, event);
    return;
  }
  if (event.phase === 'requested') rememberPendingApprovalSession(emitter, event);
  if (event.phase === 'resolved') {
    markTerminalApproval(emitter, event);
    forgetPendingApprovalSession(emitter, event);
  }
  emitChatRuntimeEvent(emitter, event);
  if (event.phase === 'requested') scheduleApprovalExpiry(emitter, event);
  else cancelApprovalExpiry(emitter, event);
}

function dispatchChatRuntimeEvents(
  emitter: GatewayEventEmitter,
  payload: unknown,
): void {
  const normalizedEvents = normalizeGatewayChatRuntimeEvents(payload);
  for (const normalized of normalizedEvents) {
    emitChatRuntimeEvent(emitter, normalized);
  }
}

function emitChatRuntimeEvent(emitter: GatewayEventEmitter, event: NonNullable<ReturnType<typeof normalizeGatewayChatRuntimeEvent>>): void {
  if (event.type === 'run.started') beginRuntimeRun(emitter, event);
  if (event.type === 'run.ended' && !markTerminalRunEmitted(emitter, event)) return;
  logChatRuntimeDiagnostic(event);
  emitter.emit('chat:runtime-event', event);
}

function dispatchChatTerminalRuntimeEvent(emitter: GatewayEventEmitter, payload: unknown): void {
  const terminalEvent = normalizeGatewayChatTerminalRuntimeEvent(payload);
  if (terminalEvent) emitChatRuntimeEvent(emitter, terminalEvent);
}

export function dispatchProtocolEvent(
  emitter: GatewayEventEmitter,
  event: string,
  payload: unknown,
): void {
  if (isApprovalGatewayEventName(event)) {
    dispatchApprovalRuntimeEvent(emitter, event, payload);
    emitter.emit('notification', { method: event, params: payload });
    return;
  }
  if (isChatRuntimeGatewayEventName(event)) {
    dispatchChatRuntimeEvents(emitter, payload);
    emitter.emit('notification', { method: event, params: payload });
    return;
  }

  switch (event) {
    case 'tick':
      break;
    case 'chat':
      logChatMessageDiagnostic(payload);
      dispatchChatTerminalRuntimeEvent(emitter, payload);
      emitter.emit('chat:message', { message: payload });
      break;
    case 'channel.status':
    case 'channel.status_changed':
      emitter.emit('channel:status', payload as { channelId: string; status: string });
      break;
    case 'gateway.ready':
    case 'ready':
      emitter.emit('gateway:ready', payload);
      break;
    case 'health':
      emitter.emit('gateway:health', payload);
      break;
    case 'presence':
      emitter.emit('gateway:presence', payload);
      break;
    default:
      emitter.emit('notification', { method: event, params: payload });
  }
}

export function dispatchJsonRpcNotification(
  emitter: GatewayEventEmitter,
  notification: JsonRpcNotification,
): void {
  emitter.emit('notification', notification);
  if (isApprovalGatewayEventName(notification.method)) {
    dispatchApprovalRuntimeEvent(emitter, notification.method, notification.params);
  }
  if (isChatRuntimeGatewayEventName(notification.method)) {
    dispatchChatRuntimeEvents(emitter, notification.params);
  }
  switch (notification.method) {
    case GatewayEventType.CHANNEL_STATUS_CHANGED:
      emitter.emit('channel:status', notification.params as { channelId: string; status: string });
      break;
    case GatewayEventType.MESSAGE_RECEIVED:
      logChatMessageDiagnostic(notification.params);
      dispatchChatTerminalRuntimeEvent(emitter, notification.params);
      emitter.emit('chat:message', notification.params as { message: unknown });
      break;
    case GatewayEventType.ERROR: {
      const errorData = notification.params as { message?: string };
      emitter.emit('error', new Error(errorData.message || 'Gateway error'));
      break;
    }
    case 'exec.approval.requested':
    case 'exec.approval.resolved':
    case 'plugin.approval.requested':
    case 'plugin.approval.resolved':
      break;
    default:
      logger.debug(`Unknown Gateway notification: ${notification.method}`);
  }
}
