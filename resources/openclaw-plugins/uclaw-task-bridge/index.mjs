import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { Type } from '@sinclair/typebox';

const PLUGIN_ID = 'uclaw-task-bridge';
const CONTRACT_VERSION = 'uclaw.host-task/v1';
const REQUEST_SCHEMA = 'uclaw.host-task.request/v1';
const DEFAULT_HOST_API_ORIGIN = 'http://127.0.0.1:13210';
const MONITOR_INTERVAL_MS = 2_500;
const COMPLETION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_EVENT_ITEMS = 24;
const MAX_TEXT_CHARS = 4_000;
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'timed_out', 'lost']);

class HostTaskBridgeError extends Error {
  constructor(message, code = 'host_task_bridge_error', status) {
    super(message);
    this.name = 'HostTaskBridgeError';
    this.code = code;
    this.status = status;
  }
}

function cleanText(value, maxLength = MAX_TEXT_CHARS) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: 'Unable to serialize structured task result' });
  }
}

function hostApiOrigin() {
  return String(process.env.CLAWX_HOST_API_ORIGIN || DEFAULT_HOST_API_ORIGIN).replace(/\/+$/u, '');
}

function hostApiToken() {
  const token = String(process.env.CLAWX_HOST_API_TOKEN || '').trim();
  if (!token) {
    throw new HostTaskBridgeError(
      'UClaw Host API token is unavailable; no Host task was started.',
      'host_api_token_unavailable',
    );
  }
  return token;
}

async function hostApiFetch(route, options = {}) {
  let response;
  try {
    response = await fetch(`${hostApiOrigin()}${route}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${hostApiToken()}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw new HostTaskBridgeError(
      `UClaw Host task bridge is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      'host_api_unreachable',
    );
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    const code = response.status === 404 ? 'host_task_bridge_not_installed' : 'host_task_bridge_request_failed';
    throw new HostTaskBridgeError(
      cleanText(payload?.error, 800) || `UClaw Host task bridge request failed: ${response.status}`,
      code,
      response.status,
    );
  }
  return payload?.result ?? payload;
}

function correlationFromContext(ctx, toolCallId, requestedKey) {
  const sessionKey = cleanText(ctx?.sessionKey || ctx?.session?.key || ctx?.session?.sessionKey, 300);
  const runId = cleanText(ctx?.runId || ctx?.agentRunId || ctx?.session?.runId, 300);
  if (!sessionKey || !runId) {
    throw new HostTaskBridgeError(
      'UClaw Host tasks require OpenClaw runtime sessionKey and runId. The model must not supply these values itself.',
      'runtime_correlation_missing',
    );
  }
  const stableToolCallId = cleanText(toolCallId, 300);
  const requestedSuffix = cleanText(requestedKey, 300) || stableToolCallId;
  const idempotencyKey = `${PLUGIN_ID}:${sessionKey}:${runId}:${requestedSuffix}`.slice(0, 300);
  return { sessionKey, runId, toolCallId: stableToolCallId, idempotencyKey };
}

function normalizeArtifact(value, index) {
  const artifact = value && typeof value === 'object' ? value : {};
  return {
    id: cleanText(artifact.id, 240) || `artifact-${index + 1}`,
    role: cleanText(artifact.role, 160) || 'output',
    title: cleanText(artifact.title, 300) || undefined,
    filePath: cleanText(artifact.filePath || artifact.path, 2_000) || undefined,
    url: cleanText(artifact.url, 2_000) || undefined,
    mimeType: cleanText(artifact.mimeType, 200) || undefined,
    sizeBytes: Number.isFinite(artifact.sizeBytes) ? artifact.sizeBytes : undefined,
    sha256: cleanText(artifact.sha256, 128) || undefined,
  };
}

function normalizeProgress(value, index) {
  const progress = value && typeof value === 'object' ? value : {};
  return {
    id: cleanText(progress.id, 240) || `progress-${index + 1}`,
    stage: cleanText(progress.stage, 160) || 'working',
    status: cleanText(progress.status, 80) || 'running',
    label: cleanText(progress.label, 500) || undefined,
    detail: cleanText(progress.detail, 1_500) || undefined,
    timestampMs: Number.isFinite(progress.timestampMs) ? progress.timestampMs : undefined,
    percent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : undefined,
  };
}

function normalizeVerification(value, index) {
  const verification = value && typeof value === 'object' ? value : {};
  return {
    id: cleanText(verification.id, 240) || `verification-${index + 1}`,
    status: cleanText(verification.status, 80) || 'pending',
    kind: cleanText(verification.kind, 160) || 'artifact.availability',
    required: verification.required !== false,
    detail: cleanText(verification.detail, 1_500) || undefined,
    artifactId: cleanText(verification.artifactId, 240) || undefined,
  };
}

function normalizeTask(value) {
  const source = value?.task && typeof value.task === 'object' ? value.task : value;
  const task = source && typeof source === 'object' ? source : {};
  const correlation = task.correlation && typeof task.correlation === 'object' ? task.correlation : {};
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts.slice(-MAX_EVENT_ITEMS).map(normalizeArtifact) : [];
  const progress = Array.isArray(task.progress) ? task.progress.slice(-MAX_EVENT_ITEMS).map(normalizeProgress) : [];
  const verifications = Array.isArray(task.verifications)
    ? task.verifications.slice(-MAX_EVENT_ITEMS).map(normalizeVerification)
    : [];
  return {
    schema: cleanText(task.schema, 120) || CONTRACT_VERSION,
    taskId: cleanText(task.taskId || task.id, 300),
    kind: cleanText(task.kind, 240),
    title: cleanText(task.title, 500),
    status: cleanText(task.status, 80) || 'unknown',
    revision: Number.isFinite(task.revision) ? Math.max(0, Math.floor(task.revision)) : 0,
    createdAt: Number.isFinite(task.createdAt) ? task.createdAt : undefined,
    updatedAt: Number.isFinite(task.updatedAt) ? task.updatedAt : undefined,
    completedAt: Number.isFinite(task.completedAt) ? task.completedAt : undefined,
    error: cleanText(task.error, 1_500) || undefined,
    recoverable: task.recoverable === true,
    recovery: task.recovery && typeof task.recovery === 'object' ? task.recovery : undefined,
    correlation: {
      sessionKey: cleanText(correlation.sessionKey, 300),
      runId: cleanText(correlation.runId, 300),
      toolCallId: cleanText(correlation.toolCallId, 300),
      idempotencyKey: cleanText(correlation.idempotencyKey, 300),
    },
    progress,
    artifacts,
    verifications,
  };
}

function terminalTask(task) {
  return TERMINAL_STATUSES.has(task.status);
}

function taskEvents(task) {
  const events = task.progress.map((progress) => ({
    schema: 'uclaw.task-bridge.event/v1',
    type: 'task.progress',
    taskId: task.taskId,
    revision: task.revision,
    correlation: task.correlation,
    progress,
  }));
  for (const artifact of task.artifacts) {
    events.push({
      schema: 'uclaw.task-bridge.event/v1',
      type: 'artifact.produced',
      taskId: task.taskId,
      revision: task.revision,
      correlation: task.correlation,
      artifact,
    });
  }
  for (const verification of task.verifications) {
    events.push({
      schema: 'uclaw.task-bridge.event/v1',
      type: 'verification.updated',
      taskId: task.taskId,
      revision: task.revision,
      correlation: task.correlation,
      verification,
    });
  }
  if (terminalTask(task)) {
    events.push({
      schema: 'uclaw.task-bridge.event/v1',
      type: `task.${task.status}`,
      taskId: task.taskId,
      revision: task.revision,
      correlation: task.correlation,
      error: task.error,
    });
  }
  return events.slice(-MAX_EVENT_ITEMS);
}

function taskInstruction(task) {
  if (task.status === 'succeeded') {
    return 'Task succeeded. Inspect required verification results and deliver only verified artifacts.';
  }
  if (task.status === 'queued' || task.status === 'running' || task.status === 'waiting') {
    return 'Task is still running. Do not claim completion; use uclaw_get_host_task for a later status check.';
  }
  if (task.status === 'failed' || task.status === 'blocked') {
    return task.recoverable
      ? 'Task did not complete. Report the concrete failure and use uclaw_recover_host_task only when the Host marks it recoverable.'
      : 'Task did not complete. Report the concrete failure; do not claim an artifact was delivered.';
  }
  if (task.status === 'cancelled') return 'Task was cancelled. Do not claim completion.';
  return 'Task status is unknown. Query it again before describing any completion.';
}

function buildTaskToolResult(operation, task, extra = {}) {
  const snapshot = {
    schema: 'uclaw.task-bridge.result/v1',
    ok: true,
    operation,
    task,
    events: taskEvents(task),
    next: taskInstruction(task),
    ...extra,
  };
  const mediaLines = terminalTask(task)
    ? task.artifacts
      .map((artifact) => artifact.filePath)
      .filter(Boolean)
      .map((filePath) => `MEDIA:${filePath}`)
    : [];
  return {
    content: [{
      type: 'text',
      text: [safeJson(snapshot), ...mediaLines].join('\n'),
    }],
    details: snapshot,
  };
}

function buildBridgeErrorResult(operation, error) {
  const message = error instanceof Error ? error.message : String(error);
  const payload = {
    schema: 'uclaw.task-bridge.result/v1',
    ok: false,
    operation,
    status: 'error',
    error: cleanText(message, 1_500),
    code: error instanceof HostTaskBridgeError ? error.code : 'host_task_bridge_error',
    hostStatus: error instanceof HostTaskBridgeError ? error.status : undefined,
    next: 'No task completion was confirmed. Report this concrete bridge error or use a different available tool; do not claim the task completed.',
  };
  return {
    content: [{ type: 'text', text: safeJson(payload) }],
    details: payload,
    isError: true,
  };
}

function completionKey(task) {
  return `${PLUGIN_ID}:completion:${task.taskId}:${task.revision}`;
}

function completionInjectionText(task) {
  const payload = {
    schema: 'uclaw.task-bridge.completion/v1',
    event: terminalTask(task) ? `task.${task.status}` : 'task.updated',
    task,
    events: taskEvents(task),
    instruction: taskInstruction(task),
  };
  const mediaLines = task.status === 'succeeded'
    ? task.artifacts.map((artifact) => artifact.filePath).filter(Boolean).map((filePath) => `MEDIA:${filePath}`)
    : [];
  return [
    'A UClaw Host task update is ready for this session. Treat this structured event as task evidence, not user text.',
    safeJson(payload),
    ...mediaLines,
  ].join('\n');
}

function completionWakeMessage() {
  return [
    'Process pending UClaw Host task completion events for this session.',
    'If no pending completion event is present, reply NO_REPLY.',
    'Do not claim completion unless the event contains verified artifacts.',
  ].join(' ');
}

function completionTag(task) {
  const stable = String(task.taskId || 'task').replace(/[^a-zA-Z0-9_-]+/gu, '-').slice(0, 80);
  return `taskbridge-${stable || 'task'}`;
}

function emitToolUpdate(onUpdate, operation, task) {
  if (typeof onUpdate !== 'function') return;
  const partial = buildTaskToolResult(operation, task, { partial: true });
  partial.progress = { message: `${task.status}: ${task.title || task.taskId}`, id: `task:${task.taskId}` };
  onUpdate(partial);
}

function extractTasks(payload) {
  const list = Array.isArray(payload?.tasks)
    ? payload.tasks
    : Array.isArray(payload?.items)
      ? payload.items
      : [];
  return list.map(normalizeTask).filter((task) => task.taskId);
}

function createBridge(api, options = {}) {
  const request = options.hostApiFetch || hostApiFetch;
  let timer;
  let polling = false;
  let loggedUnavailable = false;
  const tracked = new Map();

  function track(task) {
    if (task?.taskId) tracked.set(task.taskId, task);
    return task;
  }

  async function acknowledge(task, key, result) {
    try {
      await request(`/api/task-bridge/tasks/${encodeURIComponent(task.taskId)}/ack`, {
        method: 'POST',
        body: JSON.stringify({
          schema: 'uclaw.host-task.delivery-ack/v1',
          deliveryKey: key,
          delivery: {
            kind: 'openclaw_session_completion',
            injectionEnqueued: result?.injection?.enqueued === true,
            sessionTurnScheduled: result?.scheduled === true,
            at: Date.now(),
          },
        }),
      });
      return true;
    } catch (error) {
      api.logger?.warn?.(`[${PLUGIN_ID}] Host acknowledgement failed; completion remains retryable`, {
        taskId: task.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async function deliverTerminalTask(task) {
    if (!terminalTask(task) || !task.taskId || !task.correlation.sessionKey) return;
    const key = completionKey(task);
    const injection = await api.session.workflow.enqueueNextTurnInjection({
      sessionKey: task.correlation.sessionKey,
      text: completionInjectionText(task),
      idempotencyKey: key,
      placement: 'prepend_context',
      ttlMs: COMPLETION_TTL_MS,
      metadata: {
        taskId: task.taskId,
        revision: task.revision,
        runId: task.correlation.runId,
        toolCallId: task.correlation.toolCallId,
      },
    });

    let scheduled = false;
    let scheduleError;
    try {
      const handle = await api.session.workflow.scheduleSessionTurn({
        sessionKey: task.correlation.sessionKey,
        delayMs: 1,
        message: completionWakeMessage(),
        deliveryMode: 'announce',
        name: 'task-bridge-completion',
        tag: completionTag(task),
      });
      scheduled = Boolean(handle);
    } catch (error) {
      scheduleError = error instanceof Error ? error.message : String(error);
    }

    await acknowledge(task, key, { injection, scheduled });
    if (!scheduled) {
      api.logger?.warn?.(`[${PLUGIN_ID}] Completion injected but same-session wake was unavailable`, {
        taskId: task.taskId,
        sessionKey: task.correlation.sessionKey,
        injectionEnqueued: injection?.enqueued === true,
        scheduleError,
      });
    }
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const payload = await request('/api/task-bridge/tasks?activeOnly=false&includeTerminalUndelivered=true');
      loggedUnavailable = false;
      const tasks = extractTasks(payload);
      for (const task of tasks) {
        track(task);
        if (terminalTask(task)) await deliverTerminalTask(task);
      }
    } catch (error) {
      if (!loggedUnavailable) {
        loggedUnavailable = true;
        api.logger?.warn?.(`[${PLUGIN_ID}] Host polling unavailable; no completion was fabricated`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      polling = false;
    }
  }

  function startMonitor() {
    if (timer) return;
    timer = setInterval(() => void poll(), MONITOR_INTERVAL_MS);
    timer.unref?.();
    void poll();
  }

  function stopMonitor() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  function createTools() {
    return [
      {
        name: 'uclaw_get_runtime_capabilities',
        label: 'UClaw runtime capabilities',
        description: 'Read the real capabilities available to the current UClaw/OpenClaw runtime before selecting an unfamiliar tool or claiming that a local action can be executed. Treat unavailable and not-implemented entries as blockers, not as tools to retry.',
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
          try {
            const correlation = correlationFromContext(ctx, toolCallId);
            const query = new URLSearchParams({ sessionKey: correlation.sessionKey });
            const payload = await request(`/api/runtime/capabilities?${query.toString()}`);
            const result = {
              schema: 'uclaw.runtime-capabilities.result/v1',
              ok: true,
              catalog: payload?.catalog ?? payload,
              next: 'Select only a capability reported as available. For unfamiliar OpenClaw tools, use tool_search or tool_describe after reading this catalog.',
            };
            return { content: [{ type: 'text', text: safeJson(result) }], details: result };
          } catch (error) {
            return buildBridgeErrorResult('runtime_capabilities', error);
          }
        },
      },
      {
        name: 'uclaw_declare_turn_contract',
        label: 'Declare UClaw turn contract',
        description: 'Before a turn that must actually create an artifact, invoke a remote generation, or perform an external desktop action, declare the intended side effect and its completion evidence. Do not use for pure answers, explanations, or drafting-only requests. This declaration is metadata only and never proves the work completed.',
        promptSnippet: 'uclaw_declare_turn_contract: before a side-effecting task, declare intent, required evidence, and user authorization. It is not a substitute for executing the task or verifying the output.',
        parameters: Type.Object({
          intent: Type.Union([
            Type.Literal('chat'),
            Type.Literal('research'),
            Type.Literal('artifact'),
            Type.Literal('media'),
            Type.Literal('desktop'),
            Type.Literal('workflow'),
          ]),
          toolRequirement: Type.Union([
            Type.Literal('none'),
            Type.Literal('optional'),
            Type.Literal('required'),
          ]),
          sideEffect: Type.Union([
            Type.Literal('none'),
            Type.Literal('local_artifact'),
            Type.Literal('remote_generation'),
            Type.Literal('external_action'),
          ]),
          sideEffectAuthorized: Type.Optional(Type.Boolean()),
          capabilityRefs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 32 })),
          acceptance: Type.Optional(Type.Object({
            requiresArtifact: Type.Optional(Type.Boolean()),
            requiresVerification: Type.Optional(Type.Boolean()),
            requiresApproval: Type.Optional(Type.Boolean()),
            requiresToolEvidence: Type.Optional(Type.Boolean()),
          }, { additionalProperties: false })),
        }, { additionalProperties: false }),
        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
          try {
            const correlation = correlationFromContext(ctx, toolCallId);
            const payload = await request('/api/runtime/turn-contracts', {
              method: 'POST',
              body: JSON.stringify({ correlation, contract: params }),
            });
            const result = {
              schema: 'uclaw.turn-contract.result/v1',
              ok: true,
              contract: payload?.contract ?? payload,
              next: 'Continue with the declared work. Do not claim completion until the declared artifact, verification, approval, and real execution evidence exist.',
            };
            return { content: [{ type: 'text', text: safeJson(result) }], details: result };
          } catch (error) {
            return buildBridgeErrorResult('declare_turn_contract', error);
          }
        },
      },
      {
        name: 'uclaw_get_task_bridge_capabilities',
        label: 'UClaw task bridge capabilities',
        description: 'Read the local UClaw Host task bridge capabilities before requesting a long-running local task.',
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() {
          try {
            return await request('/api/task-bridge/capabilities');
          } catch (error) {
            return buildBridgeErrorResult('capabilities', error);
          }
        },
      },
      {
        name: 'uclaw_start_host_task',
        label: 'Start UClaw Host task',
        description: 'Start a recoverable local Host task. Use for a capability that has a confirmed Host task kind. This returns a task receipt, not final delivery; query status or wait for the Host completion event. Do not supply session/run identity yourself.',
        promptSnippet: 'uclaw_start_host_task: starts a Host-owned recoverable task only after selecting a supported Host capability. It returns a task receipt; do not claim completion until verified artifacts arrive in a later task event.',
        parameters: Type.Object({
          kind: Type.String({ minLength: 1, maxLength: 240, pattern: '^[a-zA-Z0-9._-]+$' }),
          title: Type.String({ minLength: 1, maxLength: 500 }),
          input: Type.Optional(Type.Any()),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
        }, { additionalProperties: false }),
        async execute(toolCallId, params, _signal, onUpdate, ctx) {
          try {
            const correlation = correlationFromContext(ctx, toolCallId, params.idempotencyKey);
            const payload = await request('/api/task-bridge/tasks', {
              method: 'POST',
              body: JSON.stringify({
                schema: REQUEST_SCHEMA,
                kind: params.kind,
                title: params.title,
                input: params.input ?? {},
                correlation,
              }),
            });
            const task = track(normalizeTask(payload));
            if (!task.taskId) throw new HostTaskBridgeError('Host task start response did not include taskId', 'host_task_id_missing');
            emitToolUpdate(onUpdate, 'start', task);
            return buildTaskToolResult('start', task);
          } catch (error) {
            return buildBridgeErrorResult('start', error);
          }
        },
      },
      {
        name: 'uclaw_get_host_task',
        label: 'Get UClaw Host task',
        description: 'Read a UClaw Host task state, structured progress, artifacts, verifications, and recovery evidence. Never claim a task completed from a queued or running status.',
        parameters: Type.Object({
          taskId: Type.String({ minLength: 1, maxLength: 300 }),
        }, { additionalProperties: false }),
        async execute(_toolCallId, params, _signal, onUpdate) {
          try {
            const task = track(normalizeTask(await request(`/api/task-bridge/tasks/${encodeURIComponent(params.taskId)}`)));
            if (!task.taskId) throw new HostTaskBridgeError('Host task status response did not include taskId', 'host_task_id_missing');
            emitToolUpdate(onUpdate, 'status', task);
            return buildTaskToolResult('status', task);
          } catch (error) {
            return buildBridgeErrorResult('status', error);
          }
        },
      },
      {
        name: 'uclaw_list_host_tasks',
        label: 'List UClaw Host tasks',
        description: 'List recoverable Host tasks for the current OpenClaw session. Use for recovery and diagnostics, not as a polling loop.',
        parameters: Type.Object({
          activeOnly: Type.Optional(Type.Boolean()),
        }, { additionalProperties: false }),
        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
          try {
            const correlation = correlationFromContext(ctx, toolCallId);
            const query = new URLSearchParams({ sessionKey: correlation.sessionKey, activeOnly: String(params.activeOnly !== false) });
            const tasks = extractTasks(await request(`/api/task-bridge/tasks?${query.toString()}`));
            tasks.forEach(track);
            const payload = {
              schema: 'uclaw.task-bridge.result/v1',
              ok: true,
              operation: 'list',
              tasks,
              next: tasks.length > 0
                ? 'Inspect a specific task when needed. Do not repeatedly poll this list.'
                : 'No matching Host tasks were found for this session.',
            };
            return { content: [{ type: 'text', text: safeJson(payload) }], details: payload };
          } catch (error) {
            return buildBridgeErrorResult('list', error);
          }
        },
      },
      {
        name: 'uclaw_cancel_host_task',
        label: 'Cancel UClaw Host task',
        description: 'Request cancellation of a specific UClaw Host task. The Host owns whether cancellation is safe and must return the resulting terminal state.',
        parameters: Type.Object({
          taskId: Type.String({ minLength: 1, maxLength: 300 }),
          reason: Type.Optional(Type.String({ maxLength: 1_000 })),
        }, { additionalProperties: false }),
        async execute(toolCallId, params, _signal, onUpdate, ctx) {
          try {
            const correlation = correlationFromContext(ctx, toolCallId);
            const task = track(normalizeTask(await request(`/api/task-bridge/tasks/${encodeURIComponent(params.taskId)}/cancel`, {
              method: 'POST',
              body: JSON.stringify({ correlation, reason: cleanText(params.reason, 1_000) || undefined }),
            })));
            if (!task.taskId) throw new HostTaskBridgeError('Host cancellation response did not include taskId', 'host_task_id_missing');
            emitToolUpdate(onUpdate, 'cancel', task);
            return buildTaskToolResult('cancel', task);
          } catch (error) {
            return buildBridgeErrorResult('cancel', error);
          }
        },
      },
      {
        name: 'uclaw_recover_host_task',
        label: 'Recover UClaw Host task',
        description: 'Ask the UClaw Host to recover a specific interrupted task. Use only after status shows recoverable=true. The Host decides whether it can resume without duplicating side effects.',
        parameters: Type.Object({
          taskId: Type.String({ minLength: 1, maxLength: 300 }),
          strategy: Type.Optional(Type.Union([
            Type.Literal('status_only'),
            Type.Literal('resume_if_safe'),
            Type.Literal('redeliver_existing_artifacts'),
          ])),
        }, { additionalProperties: false }),
        async execute(toolCallId, params, _signal, onUpdate, ctx) {
          try {
            const correlation = correlationFromContext(ctx, toolCallId);
            const task = track(normalizeTask(await request(`/api/task-bridge/tasks/${encodeURIComponent(params.taskId)}/recover`, {
              method: 'POST',
              body: JSON.stringify({
                correlation,
                strategy: params.strategy || 'status_only',
              }),
            })));
            if (!task.taskId) throw new HostTaskBridgeError('Host recovery response did not include taskId', 'host_task_id_missing');
            emitToolUpdate(onUpdate, 'recover', task);
            return buildTaskToolResult('recover', task);
          } catch (error) {
            return buildBridgeErrorResult('recover', error);
          }
        },
      },
    ];
  }

  return { createTools, track, poll, startMonitor, stopMonitor, deliverTerminalTask };
}

export const pluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: 'UClaw Task Bridge',
  description: 'Adapts recoverable UClaw Host work into OpenClaw tools and same-session completion events without owning an agent loop.',
  register(api) {
    const bridge = createBridge(api);
    for (const tool of bridge.createTools()) api.registerTool(tool);
    api.registerService({
      id: 'uclaw-task-bridge-monitor',
      start() {
        bridge.startMonitor();
      },
      stop() {
        bridge.stopMonitor();
      },
    });
    api.lifecycle.registerRuntimeLifecycle({
      id: 'uclaw-task-bridge-cleanup',
      cleanup() {
        bridge.stopMonitor();
      },
    });
  },
});

export default pluginEntry;

export const __test = {
  HostTaskBridgeError,
  normalizeTask,
  taskEvents,
  buildTaskToolResult,
  correlationFromContext,
  createBridge,
  completionKey,
};
