import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchJsonRpcNotification, dispatchProtocolEvent } from '../electron/gateway/event-dispatch.ts';
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
