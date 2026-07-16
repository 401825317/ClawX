import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatRuntimeEvent } from '../../../shared/chat-runtime-events';
import { hostTaskService, type HostTaskCreateRequest, type HostTaskSnapshot } from '../../services/agent-runtime/host-task-service';
import { ensureDefaultHostCapabilities } from '../../services/agent-runtime/host-capability-defaults';
import { hostCapabilityRegistry } from '../../services/agent-runtime/host-capability-registry';
import { buildRuntimeCapabilityCatalog } from '../../services/agent-runtime/runtime-capability-catalog';
import { agentTurnPreferenceStore } from '../../services/agent-runtime/turn-preference-store';
import { scheduleTaskBridgeSessionWake } from '../../services/agent-runtime/host-task-session-wake';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

function publishHostTaskEvent(ctx: HostApiContext, event: ChatRuntimeEvent): void {
  ctx.eventBus.emit('chat:runtime-event', event);
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
    ctx.mainWindow.webContents.send('chat:runtime-event', event);
  }
}

function bridgeStatus(status: HostTaskSnapshot['status']): string {
  return status;
}

function bridgeDeliveryStatus(task: HostTaskSnapshot): 'pending' | 'delivered' | 'expired' | 'not_applicable' {
  if (task.completion.mode === 'internal') return 'not_applicable';
  if (!['succeeded', 'failed', 'blocked', 'cancelled', 'timed_out', 'lost'].includes(task.status)) return 'pending';
  if (isBridgeTerminalExpired(task)) return 'expired';
  return isBridgeTerminalDelivered(task) ? 'delivered' : 'pending';
}

function requiredCorrelationValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 300) throw new Error(`Invalid ${label}`);
  return normalized;
}

function requiredTaskKind(value: unknown): string {
  if (typeof value !== 'string') throw new Error('kind is required');
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9._-]{1,240}$/u.test(normalized)) throw new Error('Invalid kind');
  return normalized;
}

function requiredTaskTitle(value: unknown): string {
  if (typeof value !== 'string') throw new Error('title is required');
  const normalized = value.trim();
  if (!normalized || normalized.length > 500) throw new Error('Invalid title');
  return normalized;
}

function requiredReplanReason(value: unknown): string {
  if (typeof value !== 'string') throw new Error('completion.reason is required for replan delivery');
  const normalized = value.trim();
  if (!normalized || normalized.length > 1_000) throw new Error('Invalid completion.reason');
  return normalized;
}

function taskBelongsToSession(task: HostTaskSnapshot, sessionKey: unknown): boolean {
  return typeof sessionKey === 'string' && sessionKey.trim() === task.sessionKey;
}

async function bridgeTask(task: HostTaskSnapshot) {
  const registration = await hostCapabilityRegistry.get(task.capability);
  const supportsResume = typeof registration?.executor.resume === 'function';
  const supportsCancel = typeof registration?.executor.cancel === 'function';
  const supportedRecovery = [
    'status_only',
    ...(supportsResume && task.status !== 'succeeded' && task.status !== 'cancelled' ? ['resume_if_safe'] : []),
    ...(task.artifacts.length > 0 ? ['redeliver_existing_artifacts'] : []),
  ];
  const progress = task.progress
    ? [{
        id: `progress:${task.taskId}:${task.revision}`,
        stage: task.capability,
        status: task.status === 'succeeded' ? 'completed' : task.status,
        label: task.title,
        detail: task.progress.detail,
        percent: task.progress.total && task.progress.total > 0 && task.progress.completed !== undefined
          ? Math.min(100, Math.round((task.progress.completed / task.progress.total) * 100))
          : undefined,
        timestampMs: task.updatedAt,
      }]
    : [];
  return {
    schema: 'uclaw.host-task/v1',
    taskId: task.taskId,
    kind: task.capability,
    title: task.title,
    status: bridgeStatus(task.status),
    revision: task.revision,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.error ? { error: task.error } : {}),
    recoverable: supportedRecovery.length > 1,
    recovery: {
      supported: supportedRecovery,
      checkpointAvailable: task.checkpoint !== undefined,
      cancelSupported: supportsCancel,
    },
    correlation: {
      sessionKey: task.sessionKey,
      runId: task.runId,
      toolCallId: task.toolCallId,
      idempotencyKey: task.idempotencyKey,
    },
    acceptance: task.acceptance,
    completion: task.completion,
    delivery: {
      status: bridgeDeliveryStatus(task),
    },
    progress,
    artifacts: task.artifacts.map((artifact) => ({ ...artifact, role: artifact.kind ?? 'output' })),
    verifications: task.verifications,
    lifecycle: {
      operations: task.lifecycle.operations.map((operation) => ({
        kind: operation.kind,
        status: operation.status,
        attempt: operation.attempt,
        startedAt: operation.startedAt,
        ...(operation.finishedAt ? { finishedAt: operation.finishedAt } : {}),
        ...(operation.error ? { error: operation.error } : {}),
      })),
    },
  };
}

function isBridgeTerminalDelivered(task: HostTaskSnapshot): boolean {
  return task.completionAcks.some((key) => key.startsWith(`uclaw-task-bridge:completion:${task.taskId}:${task.revision}`));
}

function isBridgeTerminalExpired(task: HostTaskSnapshot): boolean {
  return task.completionAcks.some((key) => key.startsWith(`uclaw-task-bridge:completion-expired:${task.taskId}:${task.revision}`));
}

function isBridgeTerminalSettled(task: HostTaskSnapshot): boolean {
  return isBridgeTerminalDelivered(task) || isBridgeTerminalExpired(task);
}

export async function handleRuntimeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  hostTaskService.setPublisher((event) => publishHostTaskEvent(ctx, event));
  ensureDefaultHostCapabilities();

  if (url.pathname === '/api/runtime/capabilities' && req.method === 'GET') {
    const sessionKey = url.searchParams.get('sessionKey')?.trim() || undefined;
    try {
      const catalog = await buildRuntimeCapabilityCatalog({
        gatewayManager: ctx.gatewayManager,
        sessionKey,
      });
      sendJson(res, 200, { success: true, catalog });
    } catch (error) {
      sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/task-bridge/capabilities' && req.method === 'GET') {
    const capabilities = await hostCapabilityRegistry.list();
    sendJson(res, 200, {
      success: true,
      schema: 'uclaw.host-task.capabilities/v1',
      capabilities,
    });
    return true;
  }

  if (url.pathname === '/api/task-bridge/session-wakes' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ sessionKey?: unknown; taskIds?: unknown }>(req);
      const sessionKey = requiredCorrelationValue(body.sessionKey, 'sessionKey');
      const taskIds = Array.isArray(body.taskIds)
        ? [...new Set(body.taskIds.map((taskId) => requiredCorrelationValue(taskId, 'taskId')))].slice(0, 64)
        : [];
      if (taskIds.length === 0) throw new Error('taskIds is required');
      const wake = await scheduleTaskBridgeSessionWake(ctx.gatewayManager, sessionKey, taskIds, {
        getTask: (taskId) => hostTaskService.get(taskId),
      });
      sendJson(res, 202, { success: true, scheduled: true, wake });
    } catch (error) {
      sendJson(res, 409, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/task-bridge/tasks' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        kind?: string;
        title?: string;
        input?: unknown;
        completion?: { mode?: 'direct' | 'replan' | 'internal'; reason?: string };
        correlation?: Partial<HostTaskCreateRequest>;
      }>(req);
      const kind = requiredTaskKind(body.kind);
      const registration = await hostCapabilityRegistry.get(kind);
      if (!registration) {
        sendJson(res, 409, {
          success: false,
          error: `No registered Host executor for task kind ${kind}. Use a capability-specific OpenClaw tool instead.`,
        });
        return true;
      }
      if (registration.capability.availability !== 'available') {
        sendJson(res, 409, {
          success: false,
          error: registration.capability.reason ?? `Host capability ${kind} is ${registration.capability.availability}.`,
        });
        return true;
      }
      const correlation = body.correlation ?? {};
      const result = await hostTaskService.create({
        sessionKey: requiredCorrelationValue(correlation.sessionKey, 'correlation.sessionKey'),
        runId: requiredCorrelationValue(correlation.runId, 'correlation.runId'),
        toolCallId: requiredCorrelationValue(correlation.toolCallId, 'correlation.toolCallId'),
        idempotencyKey: requiredCorrelationValue(correlation.idempotencyKey, 'correlation.idempotencyKey'),
        capability: kind,
        title: requiredTaskTitle(body.title),
        input: body.input ?? {},
        acceptance: registration.capability.acceptance,
        completion: body.completion?.mode === 'replan'
          ? { mode: 'replan', reason: requiredReplanReason(body.completion.reason) }
          : body.completion?.mode === 'internal'
            ? { mode: 'internal' }
            : { mode: 'direct' },
      });
      let task = result.task;
      // Always attempt dispatch after an exact idempotent replay. If the Host
      // crashed after persisting create but before claiming start, this closes
      // that gap; a persisted start claim still prevents duplicate execution.
      const dispatched = await hostTaskService.dispatchStart(result.task.taskId, registration.executor);
      task = dispatched.task ?? task;
      sendJson(res, result.idempotent ? 200 : 202, { success: true, idempotent: result.idempotent, task: await bridgeTask(task) });
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/task-bridge/tasks' && req.method === 'GET') {
    const sessionKey = url.searchParams.get('sessionKey')?.trim() || undefined;
    const activeOnly = url.searchParams.get('activeOnly') !== 'false';
    const includeTerminalUndelivered = url.searchParams.get('includeTerminalUndelivered') === 'true';
    const tasks = (await hostTaskService.list(sessionKey)).filter((task) => (
      !activeOnly
      || !['succeeded', 'failed', 'blocked', 'cancelled', 'timed_out', 'lost'].includes(task.status)
      || (includeTerminalUndelivered && !isBridgeTerminalSettled(task))
    ));
    sendJson(res, 200, { success: true, tasks: await Promise.all(tasks.map(bridgeTask)) });
    return true;
  }

  if (url.pathname.startsWith('/api/task-bridge/tasks/')) {
    const segments = url.pathname.slice('/api/task-bridge/tasks/'.length)
      .split('/').filter(Boolean).map((segment) => decodeURIComponent(segment).trim());
    const taskId = segments[0];
    const action = segments[1];
    if (!taskId) return false;
    if (!action && req.method === 'GET') {
      const task = await hostTaskService.get(taskId);
      const sessionKey = url.searchParams.get('sessionKey');
      const visibleTask = task && taskBelongsToSession(task, sessionKey) ? task : undefined;
      sendJson(res, visibleTask ? 200 : 404, visibleTask ? { success: true, task: await bridgeTask(visibleTask) } : { success: false, error: 'Host task not found' });
      return true;
    }
    if (action === 'cancel' && req.method === 'POST') {
      try {
        const body = await parseJsonBody<{ reason?: string; correlation?: { sessionKey?: unknown } }>(req).catch(() => ({}));
        const current = await hostTaskService.get(taskId);
        if (!current || !taskBelongsToSession(current, body.correlation?.sessionKey)) {
          sendJson(res, 404, { success: false, error: 'Host task not found' });
          return true;
        }
        const registration = await hostCapabilityRegistry.get(current.capability);
        if (!registration?.executor.cancel) {
          sendJson(res, 409, { success: false, error: `Host capability ${current.capability} does not support cancellation.` });
          return true;
        }
        const result = await hostTaskService.requestCancel(taskId, registration.executor, typeof body.reason === 'string' ? body.reason : undefined);
        sendJson(res, result.dispatched ? 202 : 200, { success: true, task: await bridgeTask(result.task ?? current) });
      } catch (error) {
        sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (action === 'recover' && req.method === 'POST') {
      try {
        const body = await parseJsonBody<{
          strategy?: 'status_only' | 'resume_if_safe' | 'redeliver_existing_artifacts';
          correlation?: { sessionKey?: unknown };
        }>(req).catch(() => ({}));
        const strategy = body.strategy ?? 'status_only';
        const current = await hostTaskService.get(taskId);
        if (!current || !taskBelongsToSession(current, body.correlation?.sessionKey)) {
          sendJson(res, 404, { success: false, error: 'Host task not found' });
          return true;
        }
        const registration = strategy === 'resume_if_safe' ? await hostCapabilityRegistry.get(current.capability) : undefined;
        if (strategy === 'resume_if_safe' && !registration?.executor.resume) {
          sendJson(res, 409, { success: false, error: `Host capability ${current.capability} does not support safe resume.` });
          return true;
        }
        const result = await hostTaskService.recover(taskId, strategy, registration?.executor);
        sendJson(res, result.dispatched ? 202 : 200, { success: true, task: await bridgeTask(result.task ?? current) });
      } catch (error) {
        sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (action === 'ack' && req.method === 'POST') {
      const body = await parseJsonBody<{ deliveryKey?: string; sessionKey?: unknown }>(req).catch(() => ({}));
      const current = await hostTaskService.get(taskId);
      if (!current || !taskBelongsToSession(current, body.sessionKey)) {
        sendJson(res, 404, { success: false, error: 'Host task not found' });
        return true;
      }
      const task = await hostTaskService.acknowledgeCompletion(taskId, body.deliveryKey ?? '');
      sendJson(res, task ? 200 : 404, task ? { success: true, task: await bridgeTask(task) } : { success: false, error: 'Host task not found' });
      return true;
    }
    return false;
  }

  if (url.pathname === '/api/runtime/turn-preferences/consume' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ sessionKey?: string; message?: string }>(req);
      const sessionKey = body.sessionKey?.trim();
      const message = typeof body.message === 'string' ? body.message : '';
      if (!sessionKey || !message) {
        sendJson(res, 400, { success: false, error: 'sessionKey and message are required' });
        return true;
      }
      sendJson(res, 200, { success: true, preferences: agentTurnPreferenceStore.consume({ sessionKey, message }) ?? null });
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/runtime/tasks' || url.pathname.startsWith('/api/runtime/tasks/')) {
    sendJson(res, 410, {
      success: false,
      error: 'The unscoped runtime task API is retired. Use the session-scoped /api/task-bridge/tasks contract.',
    });
    return true;
  }

  return false;
}
