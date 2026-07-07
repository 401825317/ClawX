import { GatewayEventType, type JsonRpcNotification } from './protocol';
import { logger } from '../utils/logger';
import { normalizeGatewayChatRuntimeEvent, normalizeGatewayChatRuntimeEvents } from './chat-runtime-events';

type GatewayEventEmitter = {
  emit: (event: string, payload: unknown) => boolean;
};

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

  if (event.type === 'gate.issue') {
    logger.info('[metric] chat.runtime.event', {
      ...base,
      issueId: event.issue.id,
      code: event.issue.code,
      severity: event.issue.severity,
      targetId: event.issue.targetId,
      artifactId: event.issue.artifactId,
      stepId: event.issue.stepId,
      recoverable: event.issue.recoverable,
    });
    return;
  }

  if (event.type === 'run.checkpoint') {
    logger.info('[metric] chat.runtime.event', {
      ...base,
      checkpointId: event.checkpoint.id,
      recoverable: event.checkpoint.recoverable,
      hasReason: Boolean(event.checkpoint.reason),
      issueCount: event.checkpoint.issues?.length ?? 0,
    });
    return;
  }

  if (event.type === 'gate.evaluated') {
    logger.info('[metric] chat.runtime.event', {
      ...base,
      gateId: event.gate.id,
      decision: event.gate.decision,
      artifactCount: event.gate.artifactCount,
      requiredVerificationCount: event.gate.requiredVerificationCount,
      passedRequiredVerificationCount: event.gate.passedRequiredVerificationCount,
      blockingIssueCount: event.gate.blockingIssueCount,
      warningIssueCount: event.gate.warningIssueCount,
      verificationCoverage: event.gate.verificationCoverage,
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

function dispatchChatRuntimeEvents(
  emitter: GatewayEventEmitter,
  payload: unknown,
): void {
  const normalizedEvents = normalizeGatewayChatRuntimeEvents(payload);
  for (const normalized of normalizedEvents) {
    logChatRuntimeDiagnostic(normalized);
    emitter.emit('chat:runtime-event', normalized);
  }
}

export function dispatchProtocolEvent(
  emitter: GatewayEventEmitter,
  event: string,
  payload: unknown,
): void {
  if (isChatRuntimeGatewayEventName(event)) {
    dispatchChatRuntimeEvents(emitter, payload);
    emitter.emit('notification', { method: event, params: payload });
    return;
  }

  switch (event) {
    case 'tick':
      break;
    case 'chat':
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
  if (isChatRuntimeGatewayEventName(notification.method)) {
    dispatchChatRuntimeEvents(emitter, notification.params);
  }
  switch (notification.method) {
    case GatewayEventType.CHANNEL_STATUS_CHANGED:
      emitter.emit('channel:status', notification.params as { channelId: string; status: string });
      break;
    case GatewayEventType.MESSAGE_RECEIVED:
      emitter.emit('chat:message', notification.params as { message: unknown });
      break;
    case GatewayEventType.ERROR: {
      const errorData = notification.params as { message?: string };
      emitter.emit('error', new Error(errorData.message || 'Gateway error'));
      break;
    }
    default:
      logger.debug(`Unknown Gateway notification: ${notification.method}`);
  }
}
