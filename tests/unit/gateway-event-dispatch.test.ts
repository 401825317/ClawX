import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchProtocolEvent } from '@electron/gateway/event-dispatch';
import { logger } from '@electron/utils/logger';

function createMockEmitter() {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    emit: vi.fn((event: string, payload: unknown) => {
      emitted.push({ event, payload });
      return true;
    }),
    emitted,
  };
}

describe('dispatchProtocolEvent', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  it('dispatches gateway.ready event to gateway:ready', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'gateway.ready', { version: '4.11' });
    expect(emitter.emit).toHaveBeenCalledWith('gateway:ready', { version: '4.11' });
  });

  it('dispatches ready event to gateway:ready', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'ready', { skills: 31 });
    expect(emitter.emit).toHaveBeenCalledWith('gateway:ready', { skills: 31 });
  });

  it('dispatches channel.status to channel:status', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'channel.status', { channelId: 'telegram', status: 'connected' });
    expect(emitter.emit).toHaveBeenCalledWith('channel:status', { channelId: 'telegram', status: 'connected' });
  });

  it('dispatches native health and presence events separately from generic notifications', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'health', { ok: true });
    dispatchProtocolEvent(emitter, 'presence', [{ mode: 'gateway', ts: 1 }]);

    expect(emitter.emit).toHaveBeenCalledWith('gateway:health', { ok: true });
    expect(emitter.emit).toHaveBeenCalledWith('gateway:presence', [{ mode: 'gateway', ts: 1 }]);
    expect(emitter.emit).not.toHaveBeenCalledWith('notification', expect.objectContaining({ method: 'health' }));
    expect(emitter.emit).not.toHaveBeenCalledWith('notification', expect.objectContaining({ method: 'presence' }));
  });

  it('dispatches chat to chat:message', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'chat', { text: 'hello' });
    expect(emitter.emit).toHaveBeenCalledWith('chat:message', { message: { text: 'hello' } });
  });

  it('does not normalize non-terminal lifecycle phase=end as run.ended', () => {
    const emitter = createMockEmitter();
    const payload = {
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      stream: 'lifecycle',
      seq: 4,
      ts: 10,
      data: {
        phase: 'end',
        endedAt: 11,
      },
    };

    dispatchProtocolEvent(emitter, 'agent', payload);

    expect(emitter.emit).not.toHaveBeenCalledWith('chat:runtime-event', expect.objectContaining({
      type: 'run.ended',
      runId: 'run-1',
    }));
    expect(emitter.emit).toHaveBeenCalledWith('notification', {
      method: 'agent',
      params: payload,
    });
  });

  it('normalizes terminal lifecycle phases as run.ended', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      stream: 'lifecycle',
      seq: 5,
      ts: 12,
      data: {
        phase: 'completed',
        endedAt: 13,
      },
    });

    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', {
      type: 'run.ended',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      seq: 5,
      ts: 12,
      status: 'completed',
      endedAt: 13,
      livenessState: undefined,
      replayInvalid: undefined,
      stopReason: undefined,
    });
  });

  it('dispatches normalized agent runtime events alongside the legacy notification path', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      stream: 'tool',
      seq: 3,
      ts: 10,
      data: {
        phase: 'start',
        name: 'read',
        toolCallId: 'call-1',
        args: { filePath: '/tmp/demo.md' },
      },
    });

    expect(emitter.emit).toHaveBeenCalledWith('chat:runtime-event', {
      type: 'tool.started',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      seq: 3,
      ts: 10,
      toolCallId: 'call-1',
      name: 'read',
      args: { filePath: '/tmp/demo.md' },
    });
    expect(emitter.emit).toHaveBeenCalledWith('notification', {
      method: 'agent',
      params: expect.objectContaining({ runId: 'run-1', stream: 'tool' }),
    });
  });

  it('logs normalized runtime event summaries without assistant text deltas', () => {
    const emitter = createMockEmitter();

    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-log-tool',
      sessionKey: 'agent:main:main',
      stream: 'tool',
      seq: 7,
      ts: 10,
      data: {
        phase: 'start',
        name: 'exec_command',
        toolCallId: 'call-log-tool',
        args: { cmd: 'full user prompt should not be logged here' },
      },
    });

    expect(logger.info).toHaveBeenCalledWith('[metric] chat.runtime.event', {
      type: 'tool.started',
      runId: 'run-log-tool',
      sessionKey: 'agent:main:main',
      seq: 7,
      toolCallId: 'call-log-tool',
      name: 'exec_command',
      isError: undefined,
    });

    vi.mocked(logger.info).mockClear();
    dispatchProtocolEvent(emitter, 'agent', {
      runId: 'run-log-assistant',
      sessionKey: 'agent:main:main',
      stream: 'assistant',
      seq: 8,
      ts: 11,
      data: {
        delta: '这段 assistant 增量不应该进入诊断摘要',
      },
    });

    expect(logger.info).not.toHaveBeenCalled();
  });

  it('suppresses tick events', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'tick', {});
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('dispatches unknown events as notifications', () => {
    const emitter = createMockEmitter();
    dispatchProtocolEvent(emitter, 'some.custom.event', { data: 1 });
    expect(emitter.emit).toHaveBeenCalledWith('notification', { method: 'some.custom.event', params: { data: 1 } });
  });
});
