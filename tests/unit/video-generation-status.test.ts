import { describe, expect, it } from 'vitest';
import {
  extractVideoGenerationStartFromAcpEnvelope,
  extractVideoGenerationTerminalFromAcpEnvelope,
  extractVideoGenerationTerminalTaskIdFromAcpEnvelope,
  extractVideoGenerationTerminalTaskIdFromGatewayChatMessage,
  extractVideoGenerationTerminalTaskIdFromRuntimeEvent,
} from '@/lib/acp/video-generation-status';

const TASK_ID = '27c3d85f-0d5e-4bf5-b5d3-c8316db9ddde';

describe('video generation task status extraction', () => {
  it('extracts an async video task start from an ACP tool result', () => {
    expect(extractVideoGenerationStartFromAcpEnvelope({
      sessionKey: 'agent:main:main',
      generation: 1,
      notification: {
        sessionId: 'agent:main:main',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'video-tool',
          status: 'completed',
          content: [{
            type: 'content',
            content: {
              type: 'text',
              text: `Background task started for video generation (${TASK_ID}).`,
            },
          }],
        },
      },
    } as never)).toEqual({ taskId: TASK_ID, toolCallId: 'video-tool' });
  });

  it('extracts a terminal task from an ACP inter-session completion event', () => {
    expect(extractVideoGenerationTerminalTaskIdFromAcpEnvelope({
      sessionKey: 'agent:main:main',
      generation: 1,
      notification: {
        sessionId: 'agent:main:main',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'text',
            text: `[Inter-session message] sourceSession=video_generate:${TASK_ID} sourceTool=video_generate\n[Internal task completion event]\nstatus: completed successfully`,
          },
        },
      },
    } as never)).toBe(TASK_ID);
  });

  it('extracts an immediate failed video task from the native internal completion event', () => {
    expect(extractVideoGenerationTerminalFromAcpEnvelope({
      sessionKey: 'agent:main:main',
      generation: 1,
      notification: {
        sessionId: 'agent:main:main',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'text',
            text: [
              '[Internal task completion event]',
              'source: video_generation',
              `session_key: video_generate:${TASK_ID}`,
              'status: failed',
              '',
              'Reference image exceeds the managed limit.',
            ].join('\n'),
          },
        },
      },
    } as never)).toEqual({ taskId: TASK_ID, status: 'failed' });
  });

  it('uses only the completion envelope identity from Gateway messages', () => {
    expect(extractVideoGenerationTerminalTaskIdFromGatewayChatMessage({
      message: {
        sessionKey: `video_generate:${TASK_ID}`,
        runId: `video_generate:${TASK_ID}:ok`,
        state: 'final',
        message: { role: 'assistant', content: 'Video generation completed.' },
      },
    })).toBe(TASK_ID);

    expect(extractVideoGenerationTerminalTaskIdFromGatewayChatMessage({
      message: {
        sessionKey: `video_generate:${TASK_ID}`,
        runId: `video_generate:${TASK_ID}:ok`,
        state: 'delta',
        message: { role: 'assistant', content: 'Still working.' },
      },
    })).toBeNull();

    expect(extractVideoGenerationTerminalTaskIdFromGatewayChatMessage({
      message: {
        sessionKey: 'agent:main:main',
        runId: 'original-agent-run',
        state: 'final',
        message: {
          role: 'toolresult',
          details: { runId: `video_generate:${TASK_ID}:pending` },
        },
      },
    })).toBeNull();
  });

  it('settles only terminal runtime events for the detached video task', () => {
    expect(extractVideoGenerationTerminalTaskIdFromRuntimeEvent({
      type: 'run.started',
      runId: `video_generate:${TASK_ID}:run`,
      sessionKey: `video_generate:${TASK_ID}`,
    })).toBeNull();
    expect(extractVideoGenerationTerminalTaskIdFromRuntimeEvent({
      type: 'run.ended',
      status: 'error',
      runId: `video_generate:${TASK_ID}:run`,
      sessionKey: `video_generate:${TASK_ID}`,
    })).toBe(TASK_ID);
  });
});
