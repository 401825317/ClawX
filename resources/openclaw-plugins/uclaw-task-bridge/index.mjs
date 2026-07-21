import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { Type } from '@sinclair/typebox';

const PLUGIN_ID = 'uclaw-task-bridge';
const CONTRACT_VERSION = 'uclaw.host-task/v1';
const REQUEST_SCHEMA = 'uclaw.host-task.request/v1';
const TOOL_NAMES = [
  'uclaw_get_runtime_capabilities',
  'uclaw_get_task_bridge_capabilities',
  'uclaw_start_host_task',
  'uclaw_get_host_task',
  'uclaw_list_host_tasks',
  'uclaw_cancel_host_task',
  'uclaw_recover_host_task',
];
const DEFAULT_HOST_API_ORIGIN = 'http://127.0.0.1:13210';
const MONITOR_INTERVAL_MS = 2_500;
const COMPLETION_RETRY_BASE_MS = 15_000;
const COMPLETION_RETRY_MAX_MS = 5 * 60 * 1_000;
const COMPLETION_RETRY_MAX_ATTEMPTS = 5;
const COMPLETION_RETRY_MAX_AGE_MS = 10 * 60 * 1_000;
const MAX_COMPLETION_RETRY_ENTRIES = 2_000;
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
  const lifecycle = task.lifecycle && typeof task.lifecycle === 'object' ? task.lifecycle : {};
  const acceptance = task.acceptance && typeof task.acceptance === 'object' ? task.acceptance : {};
  const completion = task.completion && typeof task.completion === 'object' ? task.completion : {};
  const delivery = task.delivery && typeof task.delivery === 'object' ? task.delivery : {};
  const operations = Array.isArray(lifecycle.operations)
    ? lifecycle.operations.slice(-MAX_EVENT_ITEMS).map((operation) => ({
        kind: cleanText(operation?.kind, 80),
        status: cleanText(operation?.status, 80),
        attempt: Number.isFinite(operation?.attempt) ? Math.max(1, Math.floor(operation.attempt)) : 1,
        startedAt: Number.isFinite(operation?.startedAt) ? operation.startedAt : undefined,
        finishedAt: Number.isFinite(operation?.finishedAt) ? operation.finishedAt : undefined,
        error: cleanText(operation?.error, 1_500) || undefined,
      }))
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
    lifecycle: { operations },
    correlation: {
      sessionKey: cleanText(correlation.sessionKey, 300),
      runId: cleanText(correlation.runId, 300),
      toolCallId: cleanText(correlation.toolCallId, 300),
      idempotencyKey: cleanText(correlation.idempotencyKey, 300),
    },
    acceptance: {
      source: 'host_capability',
      requiresArtifact: acceptance.requiresArtifact === true,
      requiresVerification: acceptance.requiresVerification === true,
      requiredVerificationKinds: Array.isArray(acceptance.requiredVerificationKinds)
        ? acceptance.requiredVerificationKinds.map((kind) => cleanText(kind, 160)).filter(Boolean)
        : [],
      outputDescription: cleanText(acceptance.outputDescription, 1_000) || undefined,
    },
    completion: {
      mode: completion.mode === 'replan'
        ? 'replan'
        : completion.mode === 'internal'
          ? 'internal'
          : 'direct',
      reason: cleanText(completion.reason, 1_000) || undefined,
    },
    delivery: {
      status: ['pending', 'delivered', 'expired', 'not_applicable'].includes(cleanText(delivery.status, 80))
        ? cleanText(delivery.status, 80)
        : 'pending',
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
  if (task.recoverable) return 'Task did not complete, but the Host reported a supported recovery path. Inspect task.recovery before requesting it.';
  return 'Task status is unknown. Query it again before describing any completion.';
}

function deliverableArtifacts(task) {
  if (task.status !== 'succeeded') return [];
  if (task.acceptance.requiresVerification !== true) return task.artifacts;
  const passedArtifactIds = new Set(
    task.verifications
      .filter((verification) => verification.status === 'passed' && verification.artifactId)
      .map((verification) => verification.artifactId),
  );
  return task.artifacts.filter((artifact) => passedArtifactIds.has(artifact.id));
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
  const mediaLines = deliverableArtifacts(task)
    .map((artifact) => artifact.filePath)
    .filter(Boolean)
    .map((filePath) => `MEDIA:${filePath}`);
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
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const completionRetryBaseMs = Number.isFinite(options.completionRetryBaseMs)
    ? Math.max(1, Math.floor(options.completionRetryBaseMs))
    : COMPLETION_RETRY_BASE_MS;
  const completionRetryMaxMs = Number.isFinite(options.completionRetryMaxMs)
    ? Math.max(completionRetryBaseMs, Math.floor(options.completionRetryMaxMs))
    : COMPLETION_RETRY_MAX_MS;
  const completionRetryMaxAttempts = Number.isFinite(options.completionRetryMaxAttempts)
    ? Math.max(1, Math.floor(options.completionRetryMaxAttempts))
    : COMPLETION_RETRY_MAX_ATTEMPTS;
  const completionRetryMaxAgeMs = Number.isFinite(options.completionRetryMaxAgeMs)
    ? Math.max(completionRetryBaseMs, Math.floor(options.completionRetryMaxAgeMs))
    : COMPLETION_RETRY_MAX_AGE_MS;
  let timer;
  let polling = false;
  let loggedUnavailable = false;
  const tracked = new Map();
  const completionRetries = new Map();
  const scheduleSessionWake = typeof options.scheduleSessionWake === 'function'
    ? options.scheduleSessionWake
    : typeof api?.uclawHost?.scheduleSessionWake === 'function'
      ? api.uclawHost.scheduleSessionWake
      : async ({ sessionKey, tasks }) => await request('/api/task-bridge/session-wakes', {
        method: 'POST',
        body: JSON.stringify({
          schema: 'uclaw.host-task.session-wake/v1',
          sessionKey,
          taskIds: tasks.map((task) => task.taskId),
        }),
      });

  function track(task) {
    if (task?.taskId) tracked.set(task.taskId, task);
    return task;
  }

  function completionRetryKey(task) {
    return `${task.taskId}:${task.revision}`;
  }

  function completionRetryDue(task) {
    const retry = completionRetries.get(completionRetryKey(task));
    return !retry || retry.nextAttemptAt <= now();
  }

  function completionRetryState(task) {
    return completionRetries.get(completionRetryKey(task));
  }

  function clearCompletionRetry(task) {
    completionRetries.delete(completionRetryKey(task));
  }

  function scheduleCompletionRetry(task, reason, details = {}) {
    const key = completionRetryKey(task);
    const previous = completionRetries.get(key);
    const attemptedAt = now();
    const firstAttemptAt = previous?.firstAttemptAt ?? attemptedAt;
    const attempts = (previous?.attempts || 0) + 1;
    const exhausted = attempts >= completionRetryMaxAttempts
      || attemptedAt - firstAttemptAt >= completionRetryMaxAgeMs;
    const delayMs = Math.min(
      completionRetryMaxMs,
      completionRetryBaseMs * (2 ** Math.min(attempts - 1, 20)),
    );
    const retry = {
      attempts,
      firstAttemptAt,
      lastAttemptAt: attemptedAt,
      nextAttemptAt: exhausted ? attemptedAt : attemptedAt + delayMs,
      exhausted,
      reason,
      details,
    };
    completionRetries.set(key, retry);
    while (completionRetries.size > MAX_COMPLETION_RETRY_ENTRIES) {
      completionRetries.delete(completionRetries.keys().next().value);
    }
    api.logger?.warn?.(`[${PLUGIN_ID}] ${exhausted
      ? 'Completion delivery retry budget exhausted'
      : 'Completion delivery deferred with bounded retry'}`, {
      taskId: task.taskId,
      sessionKey: task.correlation.sessionKey,
      reason,
      attempt: attempts,
      retryInMs: exhausted ? 0 : delayMs,
      ...details,
    });
    return retry;
  }

  async function acknowledge(task, key, result) {
    try {
      await request(`/api/task-bridge/tasks/${encodeURIComponent(task.taskId)}/ack`, {
        method: 'POST',
        body: JSON.stringify({
          schema: 'uclaw.host-task.delivery-ack/v1',
          deliveryKey: key,
          sessionKey: task.correlation.sessionKey,
          delivery: {
            outcome: result?.outcome === 'abandoned' ? 'abandoned' : 'delivered',
            kind: result?.kind || (task.completion.mode === 'internal'
              ? 'internal_host_step'
              : task.completion.mode === 'replan'
                ? 'openclaw_session_replan'
                : 'openclaw_runtime_events'),
            injectionEnqueued: result?.injectionReady === true,
            runtimeEventsEmitted: result?.runtimeEventsEmitted === true,
            sessionTurnScheduled: result?.scheduled === true,
            attempts: result?.attempts,
            firstAttemptAt: result?.firstAttemptAt,
            lastAttemptAt: result?.lastAttemptAt,
            reason: result?.reason,
            details: result?.details,
            at: now(),
          },
        }),
      });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function settleExhaustedCompletion(task, retry) {
    const deliveredBeforeAckFailure = retry.reason === 'host_acknowledgement_failed'
      && retry.details?.scheduledTurnRetained === true;
    const acknowledged = await acknowledge(task, completionKey(task), {
      outcome: deliveredBeforeAckFailure ? 'delivered' : 'abandoned',
      injectionReady: retry.details?.injectionEnqueued === true,
      runtimeEventsEmitted: retry.details?.runtimeEventsEmitted === true,
      scheduled: retry.details?.scheduledTurnRetained === true,
      attempts: retry.attempts,
      firstAttemptAt: retry.firstAttemptAt,
      lastAttemptAt: retry.lastAttemptAt,
      reason: retry.reason,
      details: retry.details,
    });
    if (acknowledged.ok) {
      clearCompletionRetry(task);
      api.logger?.warn?.(`[${PLUGIN_ID}] Completion delivery settled after retry exhaustion`, {
        taskId: task.taskId,
        sessionKey: task.correlation.sessionKey,
        outcome: deliveredBeforeAckFailure ? 'delivered' : 'abandoned',
        reason: retry.reason,
        attempts: retry.attempts,
      });
      return;
    }
    retry.nextAttemptAt = now() + completionRetryMaxMs;
    completionRetries.set(completionRetryKey(task), retry);
    api.logger?.warn?.(`[${PLUGIN_ID}] Completion delivery settlement acknowledgement failed`, {
      taskId: task.taskId,
      sessionKey: task.correlation.sessionKey,
      reason: retry.reason,
      attempts: retry.attempts,
      error: acknowledged.error,
      retryInMs: completionRetryMaxMs,
    });
  }

  async function deferCompletion(task, reason, details = {}) {
    const retry = scheduleCompletionRetry(task, reason, details);
    if (retry.exhausted) await settleExhaustedCompletion(task, retry);
  }

  async function scheduleCompletionTurn(sessionKey, tasks) {
    try {
      const result = await scheduleSessionWake({
        sessionKey,
        tasks,
        name: tasks.length > 1 ? 'task-bridge-batch' : 'task-bridge-completion',
      });
      return result?.scheduled === true && result?.wake?.id
        ? { ok: true, handle: result.wake }
        : { ok: false, error: 'host_session_wake_not_confirmed' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function prepareTerminalTaskDelivery(task) {
    if (!terminalTask(task) || !task.taskId || !task.correlation.sessionKey) return;
    const retry = completionRetryState(task);
    if (retry?.exhausted) {
      if (completionRetryDue(task)) await settleExhaustedCompletion(task, retry);
      return;
    }
    if (!completionRetryDue(task)) return;
    const key = completionKey(task);
    if (task.completion.mode === 'internal') {
      const acknowledged = await acknowledge(task, key, {
        injectionReady: false,
        runtimeEventsEmitted: false,
        scheduled: false,
      });
      if (acknowledged.ok) {
        clearCompletionRetry(task);
      } else {
        await deferCompletion(task, 'internal_host_step_acknowledgement_failed', {
          error: acknowledged.error,
        });
      }
      return undefined;
    }
    return { task, key, injectionReady: false };
  }

  async function deliverTerminalTasks(tasks) {
    const readyBySession = new Map();
    for (const task of tasks) {
      const ready = await prepareTerminalTaskDelivery(task);
      if (!ready) continue;
      const sessionKey = task.correlation.sessionKey;
      const entries = readyBySession.get(sessionKey) || [];
      entries.push(ready);
      readyBySession.set(sessionKey, entries);
    }

    for (const [sessionKey, entries] of readyBySession) {
      // The Host wake contains validated, persisted task evidence. The bridge
      // does not depend on plugin prompt injection or the plugin SDK's
      // bundled-only session scheduler.
      const scheduledTurn = await scheduleCompletionTurn(sessionKey, entries.map((entry) => entry.task));
      if (scheduledTurn.ok) {
        for (const entry of entries) {
          const acknowledged = await acknowledge(entry.task, entry.key, {
            kind: 'host_durable_session_wake',
            injectionReady: entry.injectionReady,
            runtimeEventsEmitted: false,
            scheduled: true,
          });
          if (acknowledged.ok) {
            clearCompletionRetry(entry.task);
          } else {
            await deferCompletion(entry.task, 'host_acknowledgement_failed', {
              error: acknowledged.error,
              scheduledTurnRetained: true,
            });
          }
        }
      } else {
        for (const entry of entries) {
          await deferCompletion(entry.task, 'session_wake_failed', {
            injectionEnqueued: entry.injectionReady,
            scheduleError: scheduledTurn.error,
          });
        }
      }
    }
  }

  async function deliverTerminalTask(task) {
    await deliverTerminalTasks([task]);
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const payload = await request('/api/task-bridge/tasks?activeOnly=true&includeTerminalUndelivered=true');
      loggedUnavailable = false;
      const tasks = extractTasks(payload);
      for (const task of tasks) {
        track(task);
      }
      await deliverTerminalTasks(tasks.filter(terminalTask));
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

  function createTools(toolContext) {
    return [
      {
        name: 'uclaw_get_runtime_capabilities',
        label: 'UClaw runtime capabilities',
        description: 'Read the real capabilities available to the current UClaw/OpenClaw runtime before selecting an unfamiliar tool or claiming that a local action can be executed. Treat unavailable and not-implemented entries as blockers, not as tools to retry.',
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute(toolCallId) {
          try {
            const correlation = correlationFromContext(toolContext, toolCallId);
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
        name: 'uclaw_get_task_bridge_capabilities',
        label: 'UClaw task bridge capabilities',
        description: 'Read the local UClaw Host task bridge capabilities before requesting a long-running local task. For long-form generated video, first use video_generate with one shared parentTaskId and distinct segmentId values, then compose verified video scenes. Preserve generated source audio by default; add narration only when the user requests it or the source has no usable speech. local.video.timeline.render may combine managed video scenes, optional narration, captions, and music; an image-only timeline is a disclosed fallback after provider generation is unavailable or fails, not an equivalent replacement for generated motion.',
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
        description: 'Start a recoverable local Host task after selecting a confirmed Host capability. For long-form generated video, compose verified video_generate segments; use one shared parentTaskId and distinct segmentId values while generating them. Preserve generated source audio by default and request narration only for explicit narration intent or missing/unusable source speech. local.video.timeline.render accepts managed image/video scenes and produces a verified local MP4, while local.video.compose only concatenates existing video segments. An image-only timeline must be disclosed as fallback and must not be presented as provider-generated motion. This returns a task receipt, not final delivery; query status or wait for the Host completion event. Do not supply session/run identity yourself.',
        promptSnippet: 'uclaw_start_host_task: starts a Host-owned recoverable task only after selecting a supported Host capability. For long-form generated video, generate distinct shots with video_generate using a shared parentTaskId and unique segmentId values, verify them, then pass the managed video paths to local.video.timeline.render or local.video.compose. Keep generated source audio unless the user explicitly asks to replace it; narrationText is an optional overlay, not the default video path. Use still-image scenes only as an explicit fallback after provider generation is unavailable or fails, and disclose that fallback. The Host task returns a receipt; do not claim completion until verified artifacts arrive in a later task event.',
        parameters: Type.Object({
          kind: Type.String({ minLength: 1, maxLength: 240, pattern: '^[a-zA-Z0-9._-]+$' }),
          title: Type.String({ minLength: 1, maxLength: 500 }),
          input: Type.Optional(Type.Any()),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
          completion: Type.Optional(Type.Object({
            mode: Type.Union([Type.Literal('direct'), Type.Literal('replan')]),
            reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
          }, { additionalProperties: false })),
        }, { additionalProperties: false }),
        async execute(toolCallId, params, _signal, onUpdate) {
          try {
            const correlation = correlationFromContext(toolContext, toolCallId, params.idempotencyKey);
            const payload = await request('/api/task-bridge/tasks', {
              method: 'POST',
              body: JSON.stringify({
                schema: REQUEST_SCHEMA,
                kind: params.kind,
                title: params.title,
                input: params.input ?? {},
                completion: params.completion ?? { mode: 'direct' },
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
        async execute(toolCallId, params, _signal, onUpdate) {
          try {
            const correlation = correlationFromContext(toolContext, toolCallId);
            const query = new URLSearchParams({ sessionKey: correlation.sessionKey });
            const task = track(normalizeTask(await request(`/api/task-bridge/tasks/${encodeURIComponent(params.taskId)}?${query.toString()}`)));
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
        async execute(toolCallId, params) {
          try {
            const correlation = correlationFromContext(toolContext, toolCallId);
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
        description: 'Request cancellation of a specific UClaw Host task. The registered Host executor owns cancellation. The returned snapshot may only confirm that cancellation was delegated; wait for terminal evidence before claiming it stopped.',
        parameters: Type.Object({
          taskId: Type.String({ minLength: 1, maxLength: 300 }),
          reason: Type.Optional(Type.String({ maxLength: 1_000 })),
        }, { additionalProperties: false }),
        async execute(toolCallId, params, _signal, onUpdate) {
          try {
            const correlation = correlationFromContext(toolContext, toolCallId);
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
        description: 'Ask the UClaw Host to recover a specific interrupted task. Use only after status shows recoverable=true and task.recovery lists the requested strategy. resume_if_safe is delegated only to the registered executor and never replays a generic side effect.',
        parameters: Type.Object({
          taskId: Type.String({ minLength: 1, maxLength: 300 }),
          strategy: Type.Optional(Type.Union([
            Type.Literal('status_only'),
            Type.Literal('resume_if_safe'),
            Type.Literal('redeliver_existing_artifacts'),
          ])),
        }, { additionalProperties: false }),
        async execute(toolCallId, params, _signal, onUpdate) {
          try {
            const correlation = correlationFromContext(toolContext, toolCallId);
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

  return { createTools, track, poll, startMonitor, stopMonitor, deliverTerminalTask, deliverTerminalTasks };
}

export const pluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: 'UClaw Task Bridge',
  description: 'Adapts recoverable UClaw Host work into OpenClaw tools and same-session completion events without owning an agent loop.',
  register(api) {
    const bridge = createBridge(api);
    api.registerTool((toolContext) => bridge.createTools(toolContext), { names: TOOL_NAMES });
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
  terminalTask,
  taskEvents,
  deliverableArtifacts,
  buildTaskToolResult,
  correlationFromContext,
  createBridge,
  completionKey,
};
