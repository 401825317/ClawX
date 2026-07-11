import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatRuntimeArtifact, ChatRuntimeEvent, ChatRuntimeVerification } from '../../../shared/chat-runtime-events';
import { hostTaskService, type HostTaskCreateRequest, type HostTaskSnapshot, type HostTaskUpdateRequest } from '../../services/agent-runtime/host-task-service';
import { buildRuntimeCapabilityCatalog } from '../../services/agent-runtime/runtime-capability-catalog';
import { agentTurnPreferenceStore } from '../../services/agent-runtime/turn-preference-store';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

function publishHostTaskEvent(ctx: HostApiContext, event: ChatRuntimeEvent): void {
  ctx.eventBus.emit('chat:runtime-event', event);
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
    ctx.mainWindow.webContents.send('chat:runtime-event', event);
  }
}

function taskIdFromPath(pathname: string): { taskId?: string; action?: string } {
  const segments = pathname.slice('/api/runtime/tasks/'.length)
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment).trim());
  return { taskId: segments[0], action: segments[1] };
}

function waitMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.floor(value)), 90_000);
}

function bridgeStatus(status: HostTaskSnapshot['status']): string {
  return status === 'waiting' ? 'blocked' : status;
}

function bridgeTask(task: HostTaskSnapshot) {
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
    recoverable: task.artifacts.length > 0,
    recovery: task.artifacts.length > 0 ? { supported: ['status_only', 'redeliver_existing_artifacts'] } : { supported: ['status_only'] },
    correlation: {
      sessionKey: task.sessionKey,
      runId: task.runId,
      toolCallId: task.toolCallId,
      idempotencyKey: task.idempotencyKey,
    },
    progress,
    artifacts: task.artifacts.map((artifact) => ({ ...artifact, role: artifact.kind ?? 'output' })),
    verifications: task.verifications,
  };
}

function isBridgeTerminalDelivered(task: HostTaskSnapshot): boolean {
  return task.completionAcks.some((key) => key.startsWith(`uclaw-task-bridge:completion:${task.taskId}:${task.revision}`));
}

export async function handleRuntimeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  hostTaskService.setPublisher((event) => publishHostTaskEvent(ctx, event));

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
    sendJson(res, 200, {
      success: true,
      schema: 'uclaw.host-task.capabilities/v1',
      // Executors register concrete task kinds when they can provide an
      // idempotent start/cancel/recover implementation. An empty registry is
      // intentionally safer than accepting a task that no Host can run.
      capabilities: [],
    });
    return true;
  }

  if (url.pathname === '/api/task-bridge/tasks' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        kind?: string;
        title?: string;
        correlation?: Partial<HostTaskCreateRequest>;
      }>(req);
      sendJson(res, 409, {
        success: false,
        error: `No registered Host executor for task kind ${body.kind?.trim() || '(missing)'}. Use a capability-specific OpenClaw tool instead.`,
      });
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
      || (includeTerminalUndelivered && !isBridgeTerminalDelivered(task))
    ));
    sendJson(res, 200, { success: true, tasks: tasks.map(bridgeTask) });
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
      sendJson(res, task ? 200 : 404, task ? { success: true, task: bridgeTask(task) } : { success: false, error: 'Host task not found' });
      return true;
    }
    if (action === 'cancel' && req.method === 'POST') {
      const body = await parseJsonBody<{ reason?: string }>(req).catch(() => ({}));
      const task = await hostTaskService.cancel(taskId, typeof body.reason === 'string' ? body.reason : undefined);
      sendJson(res, task ? 200 : 404, task ? { success: true, task: bridgeTask(task) } : { success: false, error: 'Host task not found' });
      return true;
    }
    if (action === 'recover' && req.method === 'POST') {
      const body = await parseJsonBody<{ strategy?: 'status_only' | 'resume_if_safe' | 'redeliver_existing_artifacts' }>(req).catch(() => ({}));
      const task = await hostTaskService.recover(taskId, body.strategy ?? 'status_only');
      sendJson(res, task ? 200 : 404, task ? { success: true, task: bridgeTask(task) } : { success: false, error: 'Host task not found' });
      return true;
    }
    if (action === 'ack' && req.method === 'POST') {
      const body = await parseJsonBody<{ deliveryKey?: string }>(req).catch(() => ({}));
      const task = await hostTaskService.acknowledgeCompletion(taskId, body.deliveryKey ?? '');
      sendJson(res, task ? 200 : 404, task ? { success: true, task: bridgeTask(task) } : { success: false, error: 'Host task not found' });
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

  if (url.pathname === '/api/runtime/tasks' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<HostTaskCreateRequest & { waitMs?: number }>(req);
      const result = await hostTaskService.create(body);
      const task = await hostTaskService.waitForTerminal(result.task.taskId, waitMs(body.waitMs));
      sendJson(res, result.idempotent ? 200 : 202, { success: true, idempotent: result.idempotent, task: task ?? result.task });
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/runtime/tasks' && req.method === 'GET') {
    const sessionKey = url.searchParams.get('sessionKey')?.trim() || undefined;
    sendJson(res, 200, { success: true, tasks: await hostTaskService.list(sessionKey) });
    return true;
  }

  if (!url.pathname.startsWith('/api/runtime/tasks/')) return false;
  const { taskId, action } = taskIdFromPath(url.pathname);
  if (!taskId) return false;

  if (!action && req.method === 'GET') {
    const task = await hostTaskService.get(taskId);
    sendJson(res, task ? 200 : 404, task ? { success: true, task } : { success: false, error: 'Host task not found' });
    return true;
  }

  if (action === 'update' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<HostTaskUpdateRequest>(req);
      const task = await hostTaskService.update(taskId, body);
      sendJson(res, task ? 200 : 404, task ? { success: true, task } : { success: false, error: 'Host task not found' });
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (action === 'complete' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<HostTaskUpdateRequest & { status?: 'succeeded' | 'failed' | 'cancelled' }>(req).catch(() => ({}));
      const task = await hostTaskService.update(taskId, {
        ...body,
        status: body.status ?? 'succeeded',
        artifacts: Array.isArray(body.artifacts) ? body.artifacts as ChatRuntimeArtifact[] : undefined,
        verifications: Array.isArray(body.verifications) ? body.verifications as ChatRuntimeVerification[] : undefined,
      });
      sendJson(res, task ? 200 : 404, task ? { success: true, task } : { success: false, error: 'Host task not found' });
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (action === 'cancel' && req.method === 'POST') {
    const body = await parseJsonBody<{ reason?: string }>(req).catch(() => ({}));
    const task = await hostTaskService.cancel(taskId, typeof body.reason === 'string' ? body.reason : undefined);
    sendJson(res, task ? 200 : 404, task ? { success: true, task } : { success: false, error: 'Host task not found' });
    return true;
  }

  return false;
}
