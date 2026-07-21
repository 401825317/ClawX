import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { Type } from '@sinclair/typebox';

const PLUGIN_ID = 'uclaw-desktop-control';
const DEFAULT_HOST_API_ORIGIN = 'http://127.0.0.1:13210';
const TOOL_CONTEXT_LIMIT = 256;
const DESKTOP_RUNTIME_TOOL_NAMES = new Set([
  'desktop_get_app_state',
  'desktop_request_action',
]);
const runtimeContextByToolCallId = new Map();

function hostApiOrigin() {
  return String(process.env.CLAWX_HOST_API_ORIGIN || DEFAULT_HOST_API_ORIGIN).replace(/\/+$/u, '');
}

function hostApiToken() {
  const token = String(process.env.CLAWX_HOST_API_TOKEN || '').trim();
  if (!token) throw new Error('UClaw Host API token is not available for desktop-control tools');
  return token;
}

async function hostApiFetch(path, options = {}) {
  const response = await fetch(`${hostApiOrigin()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${hostApiToken()}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || `Host API request failed: ${response.status}`);
  }
  return payload?.result ?? payload;
}

function normalizedString(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

/** Retain host-authoritative Tool Search context until the target tool executes. */
function rememberRuntimeContext(event, ctx) {
  if (!DESKTOP_RUNTIME_TOOL_NAMES.has(normalizedString(event?.toolName))) return;
  const toolCallId = normalizedString(event?.toolCallId);
  const sessionKey = normalizedString(ctx?.sessionKey) || normalizedString(ctx?.session?.key);
  const runId = normalizedString(event?.runId) || normalizedString(ctx?.runId);
  if (!toolCallId || !sessionKey || !runId) return;
  const runtimeContext = { sessionKey, runId, toolCallId };
  runtimeContextByToolCallId.set(toolCallId, runtimeContext);
  while (runtimeContextByToolCallId.size > TOOL_CONTEXT_LIMIT) {
    const oldest = runtimeContextByToolCallId.keys().next().value;
    if (!oldest) break;
    runtimeContextByToolCallId.delete(oldest);
  }
  return {
    params: {
      ...(event?.params && typeof event.params === 'object' ? event.params : {}),
      __uclawRuntimeContext: runtimeContext,
    },
  };
}

function runContext(toolCallId, ctx, params) {
  const normalizedToolCallId = normalizedString(toolCallId);
  const injected = params?.__uclawRuntimeContext && typeof params.__uclawRuntimeContext === 'object'
    ? params.__uclawRuntimeContext
    : undefined;
  const remembered = normalizedToolCallId
    ? runtimeContextByToolCallId.get(normalizedToolCallId)
    : undefined;
  const sessionKey = String(
    ctx?.sessionKey
      || ctx?.session?.key
      || ctx?.session?.sessionKey
      || injected?.sessionKey
      || remembered?.sessionKey
      || params?.sessionKey
      || '',
  ).trim();
  const runId = String(
    ctx?.runId
      || ctx?.agentRunId
      || ctx?.session?.runId
      || injected?.runId
      || remembered?.runId
      || params?.runId
      || '',
  ).trim();
  if (!sessionKey || !runId) {
    throw new Error('Desktop actions require a runtime sessionKey and runId. The UClaw runtime must provide both before using desktop tools.');
  }
  return {
    sessionKey,
    runId,
    ...(normalizedString(injected?.toolCallId) || normalizedToolCallId
      ? { toolCallId: normalizedString(injected?.toolCallId) || normalizedToolCallId }
      : {}),
  };
}

const appTargetSchema = Type.Object({
  appId: Type.Optional(Type.String()),
  sourceId: Type.Optional(Type.String()),
  titleIncludes: Type.Optional(Type.String()),
}, { additionalProperties: false });

const actionSchema = Type.Object({
  kind: Type.Union([
    Type.Literal('click'),
    Type.Literal('drag'),
    Type.Literal('scroll'),
    Type.Literal('press_key'),
    Type.Literal('type_text'),
    Type.Literal('set_value'),
    Type.Literal('select_text'),
    Type.Literal('perform_secondary_action'),
  ]),
  appId: Type.String(),
  elementIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  fromX: Type.Optional(Type.Number()),
  fromY: Type.Optional(Type.Number()),
  toX: Type.Optional(Type.Number()),
  toY: Type.Optional(Type.Number()),
  button: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Literal('middle')])),
  direction: Type.Optional(Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right')])),
  pages: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  key: Type.Optional(Type.String({ maxLength: 128 })),
  text: Type.Optional(Type.String({ maxLength: 20000 })),
  value: Type.Optional(Type.String({ maxLength: 20000 })),
  action: Type.Optional(Type.String({ maxLength: 256 })),
}, { additionalProperties: false });

function createTools() {
  return [
    {
      name: 'desktop_get_capabilities',
      label: 'Desktop capabilities',
      description: 'Read the UClaw desktop-control capabilities and permissions. Do this before requesting desktop actions.',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return hostApiFetch('/api/computer/capabilities');
      },
    },
    {
      name: 'desktop_list_apps',
      label: 'List desktop apps',
      description: 'List observable local app windows. This is read-only.',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return hostApiFetch('/api/computer/apps');
      },
    },
    {
      name: 'desktop_get_app_state',
      label: 'Get desktop app state',
      description: 'Observe a desktop app and return a fresh snapshotId, screenshot path, and accessibility state. Always obtain a fresh state after an action attempt; element indices and snapshots expire quickly.',
      parameters: Type.Object({
        target: Type.Optional(appTargetSchema),
        maxScreenshotSide: Type.Optional(Type.Integer({ minimum: 640, maximum: 2560 })),
      }, { additionalProperties: false }),
      async execute(toolCallId, params, _signal, _onUpdate, ctx) {
        const context = runContext(toolCallId, ctx, params);
        return hostApiFetch('/api/computer/state', {
          method: 'POST',
          body: JSON.stringify({ ...context, target: params?.target, maxScreenshotSide: params?.maxScreenshotSide }),
        });
      },
    },
    {
      name: 'desktop_request_action',
      label: 'Request desktop action',
      description: 'Request one action against the latest snapshot. This never self-approves: the local UClaw UI must explicitly approve the exact action immediately before execution. On approval_required, report the pending approval and wait for the runtime event; do not claim the action completed.',
      parameters: Type.Object({
        snapshotId: Type.String(),
        action: actionSchema,
      }, { additionalProperties: false }),
      async execute(toolCallId, params, _signal, _onUpdate, ctx) {
        const context = runContext(toolCallId, ctx, params);
        return hostApiFetch('/api/computer/actions', {
          method: 'POST',
          body: JSON.stringify({
            ...context,
            snapshotId: params.snapshotId,
            action: params.action,
          }),
        });
      },
    },
  ];
}

export const pluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: 'UClaw Desktop Control',
  description: 'Cross-platform desktop observation with Main-owned approval-gated actions.',
  register(api) {
    if (typeof api.on === 'function') {
      api.on('before_tool_call', rememberRuntimeContext, {
        name: `${PLUGIN_ID}:runtime-context`,
        description: 'Retain authoritative runtime ownership for Tool Search delegated desktop calls.',
      });
    } else if (typeof api.registerHook === 'function') {
      api.registerHook('before_tool_call', rememberRuntimeContext, {
        name: `${PLUGIN_ID}:runtime-context`,
        description: 'Retain authoritative runtime ownership for Tool Search delegated desktop calls.',
      });
    }
    for (const tool of createTools()) api.registerTool(tool);
  },
});

export default pluginEntry;

export const __test = { createTools, runContext };
