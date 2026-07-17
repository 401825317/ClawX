import assert from 'node:assert/strict';
import test from 'node:test';

import { ApprovalBroker } from '../electron/services/computer/approval-broker.ts';
import { DesktopRunCoordinator } from '../electron/services/computer/desktop-run-coordinator.ts';
import type {
  ComputerUseBackend,
  DesktopAppState,
} from '../electron/services/computer/types.ts';

function createDesktopState(snapshotId: string): DesktopAppState {
  return {
    app: {
      id: 'desktop:primary',
      displayName: 'Primary desktop',
      isRunning: true,
      platform: 'darwin',
    },
    snapshotId,
    stateVersion: `state:${snapshotId}`,
    capturedAt: new Date().toISOString(),
    screenshot: null,
    accessibility: {
      supported: false,
      text: '',
      elements: [],
    },
    permission: 'granted',
  };
}

function createDesktopBackend(state: DesktopAppState): ComputerUseBackend {
  return {
    async getCapabilities() {
      return {
        platform: 'darwin',
        driver: 'test',
        capturePermission: 'granted',
        capabilities: [],
      };
    },
    async listApps() {
      return [state.app];
    },
    async observe() {
      return state;
    },
    async execute(action) {
      return { status: 'completed', action };
    },
  };
}

test('desktop approval replay retains terminal status and tool ownership without exposing its token', () => {
  const broker = new ApprovalBroker();
  const approval = broker.request({
    sessionKey: 'agent:main:desktop-approval-replay',
    runId: 'run-desktop-approval-replay',
    toolCallId: 'tool-call-desktop-approval-replay',
  }, {
    kind: 'press_key',
    appId: 'desktop:primary',
    key: 'F24',
  }, 'Approval required.');

  assert.equal(broker.listPending().length, 1);
  broker.deny(approval.id);
  assert.equal(broker.listPending().length, 0);

  const replay = broker.listForReplay();
  assert.equal(replay.length, 1);
  assert.equal(replay[0].status, 'denied');
  assert.equal(replay[0].toolCallId, 'tool-call-desktop-approval-replay');
  assert.equal('approvalToken' in replay[0], false);
});

test('desktop run coordinator preserves tool ownership on approval requests', async () => {
  const state = createDesktopState('snapshot-tool-owner');
  const coordinator = new DesktopRunCoordinator(createDesktopBackend(state));
  const context = {
    sessionKey: 'agent:main:desktop-owner',
    runId: 'run-desktop-owner',
    toolCallId: 'tool_search_code:call_outer_fc_real:desktop_request_action:2',
  };

  await coordinator.observe(context, {});
  const result = await coordinator.requestAction({
    ...context,
    snapshotId: state.snapshotId,
    action: {
      kind: 'press_key',
      appId: state.app.id,
      key: 'F24',
    },
  });

  assert.equal(result.status, 'approval_required');
  if (result.status !== 'approval_required') return;
  assert.equal(result.approval.sessionKey, context.sessionKey);
  assert.equal(result.approval.runId, context.runId);
  assert.equal(result.approval.toolCallId, context.toolCallId);
});

test('desktop plugin forwards Tool Search runtime ownership instead of model-supplied context', async () => {
  const pluginModuleUrl = new URL(
    '../resources/openclaw-plugins/uclaw-desktop-control/index.mjs',
    import.meta.url,
  ).href;
  const { pluginEntry } = await import(pluginModuleUrl);
  const tools = new Map<string, {
    execute: (...args: unknown[]) => Promise<unknown>;
  }>();
  let beforeToolCall: ((event: unknown, context: unknown) => Promise<unknown> | unknown) | undefined;
  pluginEntry.register({
    registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      tools.set(tool.name, tool);
    },
    on(name: string, handler: typeof beforeToolCall) {
      if (name === 'before_tool_call') beforeToolCall = handler;
    },
  });
  assert.ok(beforeToolCall);
  const actionTool = tools.get('desktop_request_action');
  assert.ok(actionTool);

  const previousToken = process.env.CLAWX_HOST_API_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.CLAWX_HOST_API_TOKEN = 'desktop-plugin-test-token';
  let postedBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    postedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({ success: true, result: { status: 'approval_required' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const toolCallId = 'tool_search_code:call_outer_fc_real:desktop_request_action:2';
    const hookResult = await beforeToolCall({
      toolName: 'desktop_request_action',
      toolCallId,
      runId: 'runtime-run-real',
      params: {},
    }, {
      sessionKey: 'agent:main:runtime-real',
      runId: 'runtime-run-real',
    }) as { params?: Record<string, unknown> } | undefined;
    await actionTool.execute(undefined, {
      sessionKey: 'agent:main:model-spoofed',
      runId: 'model-run-spoofed',
      snapshotId: 'snapshot-real',
      action: { kind: 'press_key', appId: 'desktop:primary', key: 'F24' },
      ...hookResult?.params,
    }, undefined, undefined, undefined);

    assert.equal(postedBody?.sessionKey, 'agent:main:runtime-real');
    assert.equal(postedBody?.runId, 'runtime-run-real');
    assert.equal(postedBody?.toolCallId, toolCallId);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken == null) delete process.env.CLAWX_HOST_API_TOKEN;
    else process.env.CLAWX_HOST_API_TOKEN = previousToken;
  }
});
