import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dispatchCanonicalApprovalRuntimeEvent,
  dispatchJsonRpcNotification,
  dispatchProtocolEvent,
} from '../electron/gateway/event-dispatch.ts';
import {
  GatewayApprovalRecoveryCoordinator,
  normalizeGatewayApprovalListRuntimeEvents,
  replayPendingGatewayApprovalRuntimeEvents,
} from '../electron/gateway/chat-runtime-events.ts';
import { GatewayManager } from '../electron/gateway/manager.ts';
import {
  CHAT_SYNTHETIC_TERMINAL_PRODUCER,
  type ChatRuntimeEvent,
} from '../shared/chat-runtime-events.ts';

type Emission = { event: string; payload: unknown };

function replayProtocolEvents(events: Array<{ event: string; payload: unknown }>): Emission[] {
  const emissions: Emission[] = [];
  const emitter = {
    emit(event: string, payload: unknown): boolean {
      emissions.push({ event, payload });
      return true;
    },
  };

  for (const event of events) {
    dispatchProtocolEvent(emitter, event.event, event.payload);
  }
  return emissions;
}

function runtimeEvents(emissions: Emission[]): ChatRuntimeEvent[] {
  return emissions
    .filter((emission) => emission.event === 'chat:runtime-event')
    .map((emission) => emission.payload as ChatRuntimeEvent);
}

test('terminal assistant final closes the matching runtime run', () => {
  const payload = {
    runId: 'run-final-without-lifecycle',
    sessionKey: 'agent:main:session-final-without-lifecycle',
    seq: 8,
    state: 'final',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'The presentation is ready.' }],
      stopReason: 'stop',
      timestamp: 1_783_967_161_370,
    },
  };

  const emissions = replayProtocolEvents([{ event: 'chat', payload }]);

  const terminalEvents = runtimeEvents(emissions);
  assert.equal(terminalEvents.length, 1);
  assert.deepEqual({
    type: terminalEvents[0]?.type,
    runId: terminalEvents[0]?.runId,
    sessionKey: terminalEvents[0]?.sessionKey,
    seq: terminalEvents[0]?.seq,
    ts: terminalEvents[0]?.ts,
    status: terminalEvents[0]?.type === 'run.ended' ? terminalEvents[0].status : undefined,
    endedAt: terminalEvents[0]?.type === 'run.ended' ? terminalEvents[0].endedAt : undefined,
    stopReason: terminalEvents[0]?.type === 'run.ended' ? terminalEvents[0].stopReason : undefined,
  }, {
    type: 'run.ended',
    runId: payload.runId,
    sessionKey: payload.sessionKey,
    seq: payload.seq,
    ts: payload.message.timestamp,
    status: 'completed',
    endedAt: payload.message.timestamp,
    stopReason: 'stop',
  });
  assert.equal(emissions.filter((emission) => emission.event === 'chat:message').length, 1);
});

test('tool-use final keeps the runtime run open', () => {
  const emissions = replayProtocolEvents([{
    event: 'chat',
    payload: {
      runId: 'run-awaiting-tool',
      sessionKey: 'agent:main:session-awaiting-tool',
      seq: 3,
      state: 'final',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will create the requested file.' },
          { type: 'toolCall', id: 'tool-call-1', name: 'write_file', arguments: {} },
        ],
        stopReason: 'tool_use',
        timestamp: 1_783_967_162_000,
      },
    },
  }]);

  assert.equal(runtimeEvents(emissions).length, 0);
  assert.equal(emissions.filter((emission) => emission.event === 'chat:message').length, 1);
});

test('tool-result-only final keeps the runtime run open', () => {
  const emissions = replayProtocolEvents([{
    event: 'chat',
    payload: {
      runId: 'run-awaiting-post-tool-reply',
      sessionKey: 'agent:main:session-awaiting-post-tool-reply',
      seq: 7,
      state: 'final',
      message: {
        role: 'assistant',
        content: [{ type: 'toolResult', toolCallId: 'tool-call-1', content: 'written' }],
        timestamp: 1_783_967_162_500,
      },
    },
  }]);

  assert.equal(runtimeEvents(emissions).length, 0);
  assert.equal(emissions.filter((emission) => emission.event === 'chat:message').length, 1);
});

test('function-call output finals keep the runtime run open', () => {
  const functionCall = replayProtocolEvents([{
    event: 'chat',
    payload: {
      runId: 'run-awaiting-function',
      sessionKey: 'agent:main:session-awaiting-function',
      state: 'final',
      message: {
        role: 'assistant',
        output: [{ type: 'function_call', callId: 'call-1', name: 'write_file', arguments: '{}' }],
      },
    },
  }]);
  const functionOutput = replayProtocolEvents([{
    event: 'chat',
    payload: {
      runId: 'run-awaiting-function-reply',
      sessionKey: 'agent:main:session-awaiting-function-reply',
      state: 'final',
      message: {
        role: 'assistant',
        output: [{ type: 'function_call_output', callId: 'call-1', output: 'written' }],
      },
    },
  }]);

  assert.equal(runtimeEvents(functionCall).length, 0);
  assert.equal(runtimeEvents(functionOutput).length, 0);
});

test('duplicate terminal finals emit one runtime completion while preserving chat delivery', () => {
  const payload = {
    runId: 'run-duplicate-final',
    sessionKey: 'agent:main:session-duplicate-final',
    state: 'final',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }],
      stopReason: 'stop',
      timestamp: 1_783_967_163_000,
    },
  };
  const emissions = replayProtocolEvents([
    { event: 'chat', payload: { ...payload, seq: 5 } },
    { event: 'chat', payload: { ...payload, seq: 6 } },
  ]);

  assert.equal(runtimeEvents(emissions).filter((event) => event.type === 'run.ended').length, 1);
  assert.equal(emissions.filter((emission) => emission.event === 'chat:message').length, 2);
});

test('message-less final still closes the identified runtime run', () => {
  const emissions = replayProtocolEvents([{
    event: 'chat',
    payload: {
      runId: 'run-silent-final',
      sessionKey: 'agent:main:session-silent-final',
      seq: 4,
      state: 'final',
      stopReason: 'stop',
      ts: 1_783_967_164_000,
    },
  }]);

  const terminalEvents = runtimeEvents(emissions);
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0]?.type, 'run.ended');
  assert.equal(terminalEvents[0]?.runId, 'run-silent-final');
  assert.equal(terminalEvents[0]?.sessionKey, 'agent:main:session-silent-final');
  assert.equal(terminalEvents[0]?.type === 'run.ended' ? terminalEvents[0].stopReason : undefined, 'stop');
});

test('JSON-RPC chat delivery also closes a terminal runtime run', () => {
  const emissions: Emission[] = [];
  const emitter = {
    emit(event: string, payload: unknown): boolean {
      emissions.push({ event, payload });
      return true;
    },
  };

  dispatchJsonRpcNotification(emitter, {
    jsonrpc: '2.0',
    method: 'chat.message_received',
    params: {
      runId: 'run-json-rpc-final',
      sessionKey: 'agent:main:session-json-rpc-final',
      seq: 9,
      state: 'final',
      stopReason: 'stop',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Delivered through JSON-RPC.' }],
        timestamp: 1_783_967_165_000,
      },
    },
  });

  const terminalEvents = runtimeEvents(emissions);
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0]?.runId, 'run-json-rpc-final');
  assert.equal(terminalEvents[0]?.sessionKey, 'agent:main:session-json-rpc-final');
});

test('native exec and plugin approval wire events emit structured canonical approvals', () => {
  const now = Date.now();
  const execSessionKey = 'agent:main:approval-exec';
  const execRequest = {
    command: 'pnpm run typecheck',
    commandPreview: 'pnpm run typecheck',
    allowedDecisions: ['allow-once', 'deny'],
    sessionKey: execSessionKey,
  };
  const execEvents = runtimeEvents(replayProtocolEvents([
    {
      event: 'exec.approval.requested',
      payload: {
        id: 'exec-approval-wire',
        request: execRequest,
        createdAtMs: now,
        expiresAtMs: now + 60_000,
      },
    },
    {
      event: 'exec.approval.resolved',
      payload: {
        id: 'exec-approval-wire',
        decision: 'allow-once',
        resolvedBy: 'test-device',
        ts: now + 1,
        request: execRequest,
      },
    },
  ])).filter((event): event is Extract<ChatRuntimeEvent, { type: 'approval.updated' }> => (
    event.type === 'approval.updated'
  ));
  assert.equal(execEvents.length, 2);
  assert.deepEqual({
    runId: execEvents[0].runId,
    sessionKey: execEvents[0].sessionKey,
    approvalId: execEvents[0].approvalId,
    approvalKind: execEvents[0].approvalKind,
    allowedDecisions: execEvents[0].allowedDecisions,
    requestedAt: execEvents[0].requestedAt,
    expiresAt: execEvents[0].expiresAt,
    actionable: execEvents[0].actionable,
    phase: execEvents[0].phase,
    status: execEvents[0].status,
    message: execEvents[0].message,
  }, {
    runId: 'approval:exec:exec-approval-wire',
    sessionKey: execSessionKey,
    approvalId: 'exec-approval-wire',
    approvalKind: 'exec',
    allowedDecisions: ['allow-once', 'deny'],
    requestedAt: now,
    expiresAt: now + 60_000,
    actionable: true,
    phase: 'requested',
    status: 'pending',
    message: 'pnpm run typecheck',
  });
  assert.deepEqual({
    decision: execEvents[1].decision,
    actionable: execEvents[1].actionable,
    phase: execEvents[1].phase,
    status: execEvents[1].status,
  }, {
    decision: 'allow-once',
    actionable: false,
    phase: 'resolved',
    status: 'allow-once',
  });

  const pluginSessionKey = 'agent:main:approval-plugin';
  const pluginRequest = {
    pluginId: 'plugin.example',
    title: 'Publish artifact',
    description: 'Publish the generated artifact to the configured destination.',
    toolName: 'publish_artifact',
    toolCallId: 'tool-call-plugin-approval',
    allowedDecisions: ['allow-once', 'allow-always', 'deny'],
    sessionKey: pluginSessionKey,
  };
  const pluginEmissions: Emission[] = [];
  const emitter = {
    emit(event: string, payload: unknown): boolean {
      pluginEmissions.push({ event, payload });
      return true;
    },
  };
  dispatchJsonRpcNotification(emitter, {
    jsonrpc: '2.0',
    method: 'plugin.approval.requested',
    params: {
      id: 'plugin-approval-wire',
      request: pluginRequest,
      createdAtMs: now + 2,
      expiresAtMs: now + 60_002,
    },
  });
  dispatchJsonRpcNotification(emitter, {
    jsonrpc: '2.0',
    method: 'plugin.approval.resolved',
    params: {
      id: 'plugin-approval-wire',
      decision: 'deny',
      resolvedBy: 'test-device',
      ts: now + 3,
      request: pluginRequest,
    },
  });
  const pluginEvents = runtimeEvents(pluginEmissions)
    .filter((event): event is Extract<ChatRuntimeEvent, { type: 'approval.updated' }> => (
      event.type === 'approval.updated'
    ));
  assert.equal(pluginEvents.length, 2);
  assert.deepEqual({
    producer: pluginEvents[0].producer,
    runId: pluginEvents[0].runId,
    sessionKey: pluginEvents[0].sessionKey,
    toolCallId: pluginEvents[0].toolCallId,
    title: pluginEvents[0].title,
    message: pluginEvents[0].message,
    allowedDecisions: pluginEvents[0].allowedDecisions,
  }, {
    producer: 'plugin',
    runId: 'approval:plugin:plugin-approval-wire',
    sessionKey: pluginSessionKey,
    toolCallId: 'tool-call-plugin-approval',
    title: 'Publish artifact',
    message: 'Publish the generated artifact to the configured destination.',
    allowedDecisions: ['allow-once', 'allow-always', 'deny'],
  });
  assert.equal(pluginEvents[1].decision, 'deny');
  assert.equal(pluginEvents[1].actionable, false);
  assert.equal(pluginEvents[1].status, 'deny');
});

test('requestless native resolutions recover only from the matching pending approval identity', () => {
  const now = Date.now();
  const sharedApprovalId = 'shared-native-approval-id';
  const execSessionKey = 'agent:main:requestless-exec';
  const pluginSessionKey = 'agent:main:requestless-plugin';
  const events = runtimeEvents(replayProtocolEvents([{
    event: 'exec.approval.requested',
    payload: {
      id: sharedApprovalId,
      request: { command: 'pnpm run typecheck', sessionKey: execSessionKey },
      createdAtMs: now,
      expiresAtMs: now + 60_000,
    },
  }, {
    event: 'plugin.approval.requested',
    payload: {
      id: sharedApprovalId,
      request: {
        title: 'Publish artifact',
        description: 'Publish the generated artifact.',
        sessionKey: pluginSessionKey,
      },
      createdAtMs: now + 1,
      expiresAtMs: now + 60_001,
    },
  }, {
    event: 'exec.approval.resolved',
    payload: {
      id: sharedApprovalId,
      decision: 'allow-once',
      sessionKey: 'agent:main:untrusted-top-level',
      ts: now + 2,
    },
  }, {
    event: 'plugin.approval.resolved',
    payload: {
      id: sharedApprovalId,
      decision: 'deny',
      sessionKey: 'agent:main:untrusted-top-level',
      ts: now + 3,
    },
  }])).filter((event): event is Extract<ChatRuntimeEvent, { type: 'approval.updated' }> => (
    event.type === 'approval.updated'
  ));

  assert.equal(events.length, 4);
  assert.deepEqual(events.slice(2).map((event) => ({
    approvalKind: event.approvalKind,
    sessionKey: event.sessionKey,
    decision: event.decision,
    request: event.request,
  })), [{
    approvalKind: 'exec',
    sessionKey: execSessionKey,
    decision: 'allow-once',
    request: undefined,
  }, {
    approvalKind: 'plugin',
    sessionKey: pluginSessionKey,
    decision: 'deny',
    request: undefined,
  }]);
});

test('requestless resolution rejects untrusted routing after pending identity cleanup', () => {
  const now = Date.now();
  const approvalId = 'approval-session-cleanup';
  const events = runtimeEvents(replayProtocolEvents([{
    event: 'exec.approval.resolved',
    payload: {
      id: 'orphan-resolution',
      decision: 'allow-once',
      sessionKey: 'agent:main:untrusted-orphan',
      ts: now,
    },
  }, {
    event: 'exec.approval.requested',
    payload: {
      id: approvalId,
      request: { command: 'pnpm run typecheck', sessionKey: 'agent:main:cleanup' },
      createdAtMs: now + 1,
      expiresAtMs: now + 60_001,
    },
  }, {
    event: 'exec.approval.resolved',
    payload: { id: approvalId, decision: 'allow-once', ts: now + 2 },
  }, {
    event: 'exec.approval.resolved',
    payload: {
      id: approvalId,
      decision: 'allow-once',
      sessionKey: 'agent:main:untrusted-duplicate',
      ts: now + 3,
    },
  }])).filter((event): event is Extract<ChatRuntimeEvent, { type: 'approval.updated' }> => (
    event.type === 'approval.updated'
  ));

  assert.equal(events.length, 2);
  assert.equal(events[0].phase, 'requested');
  assert.equal(events[1].phase, 'resolved');
  assert.equal(events[1].sessionKey, 'agent:main:cleanup');
});

test('pending approval list replay seeds requestless resolution correlation', () => {
  const now = Date.now();
  const approvalId = 'approval-replay-correlation';
  const sessionKey = 'agent:main:approval-replay-correlation';
  const [pending] = normalizeGatewayApprovalListRuntimeEvents('exec', [{
    id: approvalId,
    request: { command: 'pnpm run typecheck', sessionKey },
    createdAtMs: now,
    expiresAtMs: now + 60_000,
  }], now);
  assert.ok(pending);

  const emissions: Emission[] = [];
  const emitter = {
    emit(event: string, payload: unknown): boolean {
      emissions.push({ event, payload });
      return true;
    },
  };
  dispatchCanonicalApprovalRuntimeEvent(emitter, pending);
  dispatchProtocolEvent(emitter, 'exec.approval.resolved', {
    id: approvalId,
    decision: 'allow-once',
    ts: now + 1,
  });

  const events = runtimeEvents(emissions)
    .filter((event): event is Extract<ChatRuntimeEvent, { type: 'approval.updated' }> => (
      event.type === 'approval.updated'
    ));
  assert.equal(events.length, 2);
  assert.equal(events[1].phase, 'resolved');
  assert.equal(events[1].sessionKey, sessionKey);
  assert.equal(events[1].request, undefined);
});

test('pending approval lookup replay restores only valid session-owned requests', () => {
  const now = Date.now();
  const events = normalizeGatewayApprovalListRuntimeEvents('exec', {
    approvals: [{
      id: 'exec-approval-replayed',
      sessionKey: 'agent:main:wrong-top-level-session',
      request: {
        command: 'pnpm run typecheck',
        sessionKey: 'agent:main:approval-replay',
        allowedDecisions: ['allow-once', 'deny'],
      },
      createdAtMs: now,
      expiresAtMs: now + 60_000,
    }, {
      id: 'approval-without-session',
      request: { command: 'ignored' },
      createdAtMs: now,
      expiresAtMs: now + 60_000,
    }, {
      id: 'expired-approval',
      request: {
        command: 'ignored after expiry',
        sessionKey: 'agent:main:approval-replay',
      },
      createdAtMs: now - 120_000,
      expiresAtMs: now - 60_000,
    }],
  }, now);

  assert.equal(events.length, 1);
  assert.equal(events[0].approvalId, 'exec-approval-replayed');
  assert.equal(events[0].sessionKey, 'agent:main:approval-replay');
  assert.equal(events[0].phase, 'requested');
  assert.equal(events[0].actionable, true);
  assert.equal(events[0].expiresAt, now + 60_000);
});

test('pending approval recovery queries exec and plugin stores through the canonical adapter', async () => {
  const now = Date.now();
  const calls: Array<{ method: string; params: unknown; timeoutMs: number }> = [];
  const emitted: Array<Extract<ChatRuntimeEvent, { type: 'approval.updated' }>> = [];

  await replayPendingGatewayApprovalRuntimeEvents({
    rpc: async (method, params, timeoutMs) => {
      calls.push({ method, params, timeoutMs });
      const approvalKind = method.startsWith('exec.') ? 'exec' : 'plugin';
      return [{
        id: `${approvalKind}-approval-recovery`,
        request: {
          sessionKey: `agent:main:${approvalKind}-approval-recovery`,
          title: `${approvalKind} approval`,
        },
        createdAtMs: now,
        expiresAtMs: now + 60_000,
      }];
    },
    emit: (event) => emitted.push(event),
    nowMs: () => now,
  });

  assert.deepEqual(calls.map((call) => call.method), [
    'exec.approval.list',
    'plugin.approval.list',
  ]);
  assert.equal(calls.every((call) => call.timeoutMs === 5_000), true);
  assert.deepEqual(
    emitted.map((event) => [event.approvalKind, event.sessionKey, event.phase, event.actionable]).sort(),
    [
      ['exec', 'agent:main:exec-approval-recovery', 'requested', true],
      ['plugin', 'agent:main:plugin-approval-recovery', 'requested', true],
    ],
  );
});

test('renderer-ready recovery queues one fresh replay behind an active connection replay', async () => {
  let connected = true;
  let replayCount = 0;
  let releaseFirstReplay!: () => void;
  const firstReplayGate = new Promise<void>((resolve) => {
    releaseFirstReplay = resolve;
  });
  const coordinator = new GatewayApprovalRecoveryCoordinator({
    isConnected: () => connected,
    replayOnce: async () => {
      replayCount += 1;
      if (replayCount === 1) await firstReplayGate;
    },
  });

  const connectionReplay = coordinator.replay();
  const rendererReadyReplay = coordinator.replay({ queueAfterActive: true });
  assert.equal(replayCount, 1);
  releaseFirstReplay();
  await Promise.all([connectionReplay, rendererReadyReplay]);
  assert.equal(replayCount, 2);

  connected = false;
  await coordinator.replay({ queueAfterActive: true });
  assert.equal(replayCount, 2);
});

test('a stale pending approval replay cannot reopen terminal native evidence', () => {
  const now = Date.now();
  const request = {
    command: 'pnpm run typecheck',
    sessionKey: 'agent:main:approval-terminal-lock',
  };
  const approval = {
    id: 'exec-approval-terminal-lock',
    request,
    createdAtMs: now,
    expiresAtMs: now + 60_000,
  };

  const events = runtimeEvents(replayProtocolEvents([{
    event: 'exec.approval.requested',
    payload: approval,
  }, {
    event: 'exec.approval.resolved',
    payload: {
      id: approval.id,
      decision: 'allow-once',
      resolvedBy: 'test-device',
      ts: now + 1,
      request,
    },
  }, {
    event: 'exec.approval.requested',
    payload: approval,
  }])).filter((event): event is Extract<ChatRuntimeEvent, { type: 'approval.updated' }> => (
    event.type === 'approval.updated'
  ));

  assert.equal(events.length, 2);
  assert.equal(events[0].phase, 'requested');
  assert.equal(events[1].phase, 'resolved');
  assert.equal(events[1].decision, 'allow-once');
});

test('native approval expiry emits a derived terminal event when OpenClaw sends no resolution', async () => {
  const now = Date.now();
  const approvalEvents: Array<Extract<ChatRuntimeEvent, { type: 'approval.updated' }>> = [];
  let resolveExpired: ((event: Extract<ChatRuntimeEvent, { type: 'approval.updated' }>) => void) | undefined;
  const expiredEventPromise = new Promise<Extract<ChatRuntimeEvent, { type: 'approval.updated' }>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('approval expiry event timed out')), 1_000);
    resolveExpired = (event) => {
      clearTimeout(timeout);
      resolve(event);
    };
  });
  const emitter = {
    emit(event: string, payload: unknown): boolean {
      if (event === 'chat:runtime-event') {
        const runtimeEvent = payload as ChatRuntimeEvent;
        if (runtimeEvent.type === 'approval.updated') {
          approvalEvents.push(runtimeEvent);
          if (runtimeEvent.status === 'expired') {
            resolveExpired?.(runtimeEvent);
            resolveExpired = undefined;
          }
        }
      }
      return true;
    },
  };
  dispatchProtocolEvent(emitter, 'exec.approval.requested', {
    id: 'exec-approval-expiry',
    request: {
      command: 'pnpm run build:vite',
      sessionKey: 'agent:main:approval-expiry',
    },
    createdAtMs: now,
    expiresAtMs: now + 20,
  });
  const expiredEvent = await expiredEventPromise;

  assert.equal(expiredEvent.producer, 'gateway-approval-expiry');
  assert.equal(expiredEvent.approvalId, 'exec-approval-expiry');
  assert.equal(expiredEvent.decision, undefined);
  assert.equal(expiredEvent.actionable, false);
  assert.equal(expiredEvent.phase, 'resolved');
  assert.equal(expiredEvent.status, 'expired');
  dispatchProtocolEvent(emitter, 'exec.approval.resolved', {
    id: 'exec-approval-expiry',
    decision: 'allow-once',
    sessionKey: 'agent:main:untrusted-after-expiry',
    ts: now + 21,
  });
  assert.equal(approvalEvents.length, 2);
});

test('authoritative lifecycle failure corrects an earlier synthesized completion', () => {
  const runId = 'run-terminal-correction';
  const sessionKey = 'agent:main:session-terminal-correction';
  const finalPayload = {
    runId,
    sessionKey,
    seq: 10,
    state: 'final',
    stopReason: 'stop',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Apparently complete.' }],
      timestamp: 1_783_967_166_000,
    },
  };
  const lifecycleFailure = {
    runId,
    sessionKey,
    seq: 11,
    stream: 'lifecycle',
    data: {
      phase: 'failed',
      endedAt: 1_783_967_166_100,
      error: 'Persistence failed after final delivery.',
    },
  };

  const corrected = runtimeEvents(replayProtocolEvents([
    { event: 'chat', payload: finalPayload },
    { event: 'agent', payload: lifecycleFailure },
  ])).filter((event): event is Extract<ChatRuntimeEvent, { type: 'run.ended' }> => event.type === 'run.ended');
  assert.deepEqual(corrected.map((event) => event.status), ['completed', 'error']);

  const authoritativeFirst = runtimeEvents(replayProtocolEvents([
    { event: 'agent', payload: lifecycleFailure },
    { event: 'chat', payload: finalPayload },
  ])).filter((event): event is Extract<ChatRuntimeEvent, { type: 'run.ended' }> => event.type === 'run.ended');
  assert.deepEqual(authoritativeFirst.map((event) => event.status), ['error']);

  const synthesizedFailureThenNativeCompletion = runtimeEvents(replayProtocolEvents([
    {
      event: 'chat',
      payload: {
        runId,
        sessionKey,
        state: 'error',
        errorMessage: 'Temporary synthesized failure.',
      },
    },
    {
      event: 'agent',
      payload: {
        runId,
        sessionKey,
        stream: 'lifecycle',
        data: { phase: 'completed' },
      },
    },
  ])).filter((event): event is Extract<ChatRuntimeEvent, { type: 'run.ended' }> => event.type === 'run.ended');
  assert.deepEqual(synthesizedFailureThenNativeCompletion.map((event) => event.status), ['error', 'completed']);

  const nativeAbortThenSynthesizedFailure = runtimeEvents(replayProtocolEvents([
    {
      event: 'agent',
      payload: {
        runId,
        sessionKey,
        stream: 'lifecycle',
        data: { phase: 'aborted' },
      },
    },
    {
      event: 'chat',
      payload: {
        runId,
        sessionKey,
        state: 'error',
        errorMessage: 'Late synthesized failure.',
      },
    },
  ])).filter((event): event is Extract<ChatRuntimeEvent, { type: 'run.ended' }> => event.type === 'run.ended');
  assert.deepEqual(nativeAbortThenSynthesizedFailure.map((event) => event.status), ['aborted']);
});

test('chat error and aborted states close their runtime runs', () => {
  const emissions = replayProtocolEvents([
    {
      event: 'chat',
      payload: {
        runId: 'run-chat-error',
        sessionKey: 'agent:main:session-chat-error',
        seq: 2,
        state: 'error',
        errorMessage: 'Provider request failed.',
        ts: 1_783_967_167_000,
      },
    },
    {
      event: 'chat',
      payload: {
        runId: 'run-chat-aborted',
        sessionKey: 'agent:main:session-chat-aborted',
        seq: 3,
        state: 'aborted',
        ts: 1_783_967_167_100,
      },
    },
  ]);

  const terminals = runtimeEvents(emissions)
    .filter((event): event is Extract<ChatRuntimeEvent, { type: 'run.ended' }> => event.type === 'run.ended');
  assert.deepEqual(terminals.map((event) => ({
    runId: event.runId,
    status: event.status,
    error: event.error,
  })), [
    { runId: 'run-chat-error', status: 'error', error: 'Provider request failed.' },
    { runId: 'run-chat-aborted', status: 'aborted', error: undefined },
  ]);
});

test('a new lifecycle start permits a reused session run identity to finish again', () => {
  const runId = 'run-reused-after-start';
  const sessionKey = 'agent:main:session-reused-after-start';
  const finalPayload = {
    runId,
    sessionKey,
    state: 'final',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  };
  const emissions = replayProtocolEvents([
    { event: 'chat', payload: { ...finalPayload, seq: 2 } },
    {
      event: 'agent',
      payload: { runId, sessionKey, seq: 1, stream: 'lifecycle', data: { phase: 'start' } },
    },
    { event: 'chat', payload: { ...finalPayload, seq: 2 } },
  ]);

  const terminals = runtimeEvents(emissions).filter((event) => event.type === 'run.ended');
  assert.equal(terminals.length, 2);
});

test('the same run ID remains isolated across sessions', () => {
  const runId = 'run-shared-id';
  const emissions = replayProtocolEvents([
    {
      event: 'chat',
      payload: {
        runId,
        sessionKey: 'agent:main:session-a',
        state: 'final',
        message: { role: 'assistant', content: 'Session A done.' },
      },
    },
    {
      event: 'chat',
      payload: {
        runId,
        sessionKey: 'agent:main:session-b',
        state: 'final',
        message: { role: 'assistant', content: 'Session B done.' },
      },
    },
  ]);

  const terminals = runtimeEvents(emissions).filter((event) => event.type === 'run.ended');
  assert.deepEqual(terminals.map((event) => event.sessionKey), [
    'agent:main:session-a',
    'agent:main:session-b',
  ]);
});

test('runtime work tracking migrates an unscoped run and clears it from an unscoped terminal', () => {
  const manager = new GatewayManager();
  const runtimeState = manager as unknown as {
    activeRuntimeRuns: Map<string, { sessionKey?: string }>;
    activeRuntimeRunKeysByRunId: Map<string, Set<string>>;
  };

  manager.emit('chat:runtime-event', {
    type: 'run.started',
    runId: 'run-late-session-key',
    producer: 'gateway',
  });
  manager.emit('chat:runtime-event', {
    type: 'run.progress',
    runId: 'run-late-session-key',
    sessionKey: 'agent:main:session-late-key',
    producer: 'gateway',
  });

  assert.equal(runtimeState.activeRuntimeRuns.size, 1);
  assert.equal(runtimeState.activeRuntimeRunKeysByRunId.get('run-late-session-key')?.size, 1);
  assert.equal([...runtimeState.activeRuntimeRuns.values()][0]?.sessionKey, 'agent:main:session-late-key');

  manager.emit('chat:runtime-event', {
    type: 'run.ended',
    runId: 'run-late-session-key',
    producer: 'gateway',
    status: 'completed',
  });

  assert.equal(runtimeState.activeRuntimeRuns.size, 0);
  assert.equal(runtimeState.activeRuntimeRunKeysByRunId.size, 0);
});

test('an unscoped terminal never clears session-scoped runs that share a run ID', () => {
  const manager = new GatewayManager();
  const runtimeState = manager as unknown as {
    activeRuntimeRuns: Map<string, unknown>;
    activeRuntimeRunKeysByRunId: Map<string, Set<string>>;
  };
  const runId = 'run-shared-manager-id';

  manager.emit('chat:runtime-event', {
    type: 'run.started',
    runId,
    sessionKey: 'agent:main:session-a',
    producer: 'gateway',
  });
  manager.emit('chat:runtime-event', {
    type: 'run.started',
    runId,
    sessionKey: 'agent:main:session-b',
    producer: 'gateway',
  });
  manager.emit('chat:runtime-event', {
    type: 'run.ended',
    runId,
    producer: 'gateway',
    status: 'completed',
  });

  assert.equal(runtimeState.activeRuntimeRuns.size, 2);
  assert.equal(runtimeState.activeRuntimeRunKeysByRunId.get(runId)?.size, 2);

  for (const sessionKey of ['agent:main:session-a', 'agent:main:session-b']) {
    manager.emit('chat:runtime-event', {
      type: 'run.ended',
      runId,
      sessionKey,
      producer: 'gateway',
      status: 'completed',
    });
  }

  assert.equal(runtimeState.activeRuntimeRuns.size, 0);
  assert.equal(runtimeState.activeRuntimeRunKeysByRunId.size, 0);
});

test('Gateway process exit clears process-local runtime work before reconnect', () => {
  const manager = new GatewayManager();
  const runtimeState = manager as unknown as {
    activeRuntimeRuns: Map<string, unknown>;
    activeRuntimeRunKeysByRunId: Map<string, Set<string>>;
    activeRuntimeTasks: Map<string, unknown>;
    clearRuntimeWorkAfterProcessExit: (code: number | null, childPid?: number) => number;
  };

  for (const [runId, sessionKey] of [
    ['run-before-crash-a', 'agent:main:session-a'],
    ['run-before-crash-b', 'agent:main:session-b'],
  ]) {
    manager.emit('chat:runtime-event', {
      type: 'run.started',
      runId,
      sessionKey,
      producer: 'gateway',
    });
  }
  manager.emit('chat:runtime-event', {
    type: 'task.updated',
    runId: 'tool:image_generate:before-crash',
    sessionKey: 'agent:main:session-a',
    producer: 'openclaw-task-ledger',
    task: {
      taskId: 'image-before-crash',
      title: 'Generate image',
      status: 'running',
    },
  });

  assert.equal(runtimeState.activeRuntimeRuns.size, 2);
  assert.equal(runtimeState.activeRuntimeTasks.size, 1);
  assert.equal(runtimeState.clearRuntimeWorkAfterProcessExit(137, 4242), 3);
  assert.equal(runtimeState.activeRuntimeRuns.size, 0);
  assert.equal(runtimeState.activeRuntimeRunKeysByRunId.size, 0);
  assert.equal(runtimeState.activeRuntimeTasks.size, 0);
  assert.equal(manager.getDiagnostics().recentLifecycleEvents?.at(-1)?.event, 'runtime_work_reset');
  assert.deepEqual(manager.getDiagnostics().recentLifecycleEvents?.at(-1)?.details, {
    code: 137,
    childPid: 4242,
    interruptedRunCount: 2,
    interruptedTaskCount: 1,
  });
});

test('active detached task keeps a deferred Gateway restart pending after the parent run ends', async () => {
  const manager = new GatewayManager();
  const runtimeState = manager as unknown as {
    activeRuntimeRuns: Map<string, unknown>;
    activeRuntimeTasks: Map<string, unknown>;
  };
  const sessionKey = 'agent:main:session-image-task';

  manager.emit('chat:runtime-event', {
    type: 'run.started',
    runId: 'run-image-request',
    sessionKey,
    producer: 'gateway',
  });
  manager.emit('chat:runtime-event', {
    type: 'task.updated',
    runId: 'tool:image_generate:image-task',
    sessionKey,
    producer: 'openclaw-task-ledger',
    task: {
      taskId: 'image-task',
      title: 'Generate image',
      status: 'running',
    },
  });

  await manager.restart({ reason: 'provider-switch', source: 'gateway-reload' });
  let restartCount = 0;
  manager.restart = async () => {
    restartCount += 1;
  };

  manager.emit('chat:runtime-event', {
    type: 'run.ended',
    runId: 'run-image-request',
    sessionKey,
    producer: 'gateway',
    status: 'completed',
  });

  assert.equal(runtimeState.activeRuntimeRuns.size, 0);
  assert.equal(runtimeState.activeRuntimeTasks.size, 1);
  assert.equal(restartCount, 0);

  manager.emit('chat:runtime-event', {
    type: 'task.updated',
    runId: 'tool:image_generate:image-task',
    sessionKey,
    producer: 'openclaw-task-ledger',
    task: {
      taskId: 'image-task',
      title: 'Generate image',
      status: 'completed',
    },
  });

  assert.equal(runtimeState.activeRuntimeTasks.size, 0);
  assert.equal(restartCount, 1);
});

test('history task replay does not fabricate active Gateway work', () => {
  const manager = new GatewayManager();
  const runtimeState = manager as unknown as {
    activeRuntimeTasks: Map<string, unknown>;
  };

  manager.emit('chat:runtime-event', {
    type: 'task.updated',
    runId: 'tool:image_generate:history-task',
    sessionKey: 'agent:main:history-task',
    producer: 'history',
    task: {
      taskId: 'history-task',
      title: 'Generate image',
      status: 'running',
    },
  });

  assert.equal(runtimeState.activeRuntimeTasks.size, 0);
});

test('non-lifecycle runtime replay cannot fabricate active Gateway work', () => {
  const manager = new GatewayManager();
  const runtimeState = manager as unknown as {
    activeRuntimeRuns: Map<string, unknown>;
  };

  manager.emit('chat:runtime-event', {
    type: 'approval.updated',
    runId: 'approval:exec:replayed-pending',
    sessionKey: 'agent:main:approval-replay',
    producer: 'openclaw',
    approval: {
      id: 'replayed-pending',
      kind: 'exec',
      phase: 'requested',
      status: 'pending',
    },
  });
  assert.equal(runtimeState.activeRuntimeRuns.size, 0);

  manager.emit('chat:runtime-event', {
    type: 'run.started',
    runId: 'run-with-approval',
    sessionKey: 'agent:main:approval-replay',
    producer: 'gateway',
  });
  manager.emit('chat:runtime-event', {
    type: 'approval.updated',
    runId: 'run-with-approval',
    sessionKey: 'agent:main:approval-replay',
    producer: 'openclaw',
    approval: {
      id: 'owned-pending',
      kind: 'exec',
      phase: 'requested',
      status: 'pending',
    },
  });
  assert.equal(runtimeState.activeRuntimeRuns.size, 1);
});

test('history terminal replay does not suppress a later live final', () => {
  const runId = 'run-history-then-live';
  const sessionKey = 'agent:main:session-history-then-live';
  const emissions = replayProtocolEvents([
    {
      event: 'agent',
      payload: {
        producer: 'history',
        runId,
        sessionKey,
        stream: 'lifecycle',
        data: { phase: 'completed', endedAt: 1_783_967_168_000 },
      },
    },
    {
      event: 'chat',
      payload: {
        runId,
        sessionKey,
        state: 'final',
        message: { role: 'assistant', content: 'Live final.' },
      },
    },
  ]);

  const terminals = runtimeEvents(emissions)
    .filter((event): event is Extract<ChatRuntimeEvent, { type: 'run.ended' }> => event.type === 'run.ended');
  assert.deepEqual(terminals.map((event) => event.producer), ['history', CHAT_SYNTHETIC_TERMINAL_PRODUCER]);
});

test('unidentified or non-terminal chat events never synthesize runtime completion', () => {
  const message = { role: 'assistant', content: 'Not safely terminal.' };
  const emissions = replayProtocolEvents([
    { event: 'chat', payload: { runId: 'run-missing-session', state: 'final', message } },
    { event: 'chat', payload: { sessionKey: 'agent:main:session-missing-run', state: 'final', message } },
    {
      event: 'chat',
      payload: {
        runId: 'run-delta',
        sessionKey: 'agent:main:session-delta',
        state: 'delta',
        message,
      },
    },
  ]);

  assert.equal(runtimeEvents(emissions).length, 0);
  assert.equal(emissions.filter((emission) => emission.event === 'chat:message').length, 3);
});
