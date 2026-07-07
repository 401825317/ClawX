import { GatewayEventType, type JsonRpcNotification } from './protocol';
import { logger } from '../utils/logger';
import { normalizeGatewayChatRuntimeEvent } from './chat-runtime-events';

type GatewayEventEmitter = {
  emit: (event: string, payload: unknown) => boolean;
};

function logChatRuntimeDiagnostic(event: ReturnType<typeof normalizeGatewayChatRuntimeEvent>): void {
  if (!event) return;
  if (event.type === 'assistant.delta' || event.type === 'thinking.delta') return;

  const base = {
    type: event.type,
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

export function dispatchProtocolEvent(
  emitter: GatewayEventEmitter,
  event: string,
  payload: unknown,
): void {
  switch (event) {
    case 'tick':
      break;
    case 'chat':
      emitter.emit('chat:message', { message: payload });
      break;
    case 'agent': {
      const normalized = normalizeGatewayChatRuntimeEvent(payload);
      if (normalized) {
        logChatRuntimeDiagnostic(normalized);
        emitter.emit('chat:runtime-event', normalized);
      }
      emitter.emit('notification', { method: event, params: payload });
      break;
    }
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
  if (notification.method === 'agent') {
    const normalized = normalizeGatewayChatRuntimeEvent(notification.params);
    if (normalized) {
      logChatRuntimeDiagnostic(normalized);
      emitter.emit('chat:runtime-event', normalized);
    }
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
