import type { ChatRuntimeRunState, RawMessage } from '../../src/stores/chat/types';
import {
  IMAGE_GENERATION_TIMEOUT_MS,
  isImageGenerationPending,
} from '../../src/pages/Chat/image-generation-status';
import { expect, test } from '@playwright/test';

const TASK_ID = '11111111-2222-4333-8444-555555555555';
const NOW = 2_000_000_000_000;

function imageGenerationMessages(startedAt = NOW): RawMessage[] {
  return [
    {
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'image-generate-call',
        name: 'image_generate',
        arguments: { prompt: 'Create a noodle shop poster' },
      }],
      timestamp: startedAt,
    },
    {
      role: 'toolresult',
      toolCallId: 'image-generate-call',
      toolName: 'image_generate',
      content: [{
        type: 'text',
        text: `Background task started for image generation (${TASK_ID}). Wait for the generated image completion event.`,
      }],
      timestamp: startedAt,
    },
  ];
}

function runtimeRunWithTask(
  task: NonNullable<ChatRuntimeRunState['tasks']>[number],
): Pick<ChatRuntimeRunState, 'tasks' | 'asyncTaskLedger'> {
  return { tasks: [task] };
}

test.describe('image generation pending state', () => {
  test('stays pending after async start when the runtime task is still running', () => {
    expect(isImageGenerationPending(imageGenerationMessages(), [], {
      now: NOW,
      runtimeRun: runtimeRunWithTask({
        taskId: TASK_ID,
        title: 'Generate image',
        status: 'running',
      }),
    })).toBe(true);
  });

  test('does not let an unrelated terminal runtime task settle the image task', () => {
    expect(isImageGenerationPending(imageGenerationMessages(), [], {
      now: NOW,
      runtimeRun: runtimeRunWithTask({
        taskId: '99999999-8888-4777-8666-555555555555',
        title: 'Other task',
        status: 'completed',
      }),
    })).toBe(true);
  });

  for (const status of ['completed', 'error', 'partial'] as const) {
    test(`settles immediately when the matching runtime task is ${status}`, () => {
      expect(isImageGenerationPending(imageGenerationMessages(), [], {
        now: NOW,
        runtimeRun: runtimeRunWithTask({
          taskId: TASK_ID,
          title: 'Generate image',
          status,
        }),
      })).toBe(false);
    });
  }

  test('settles immediately when the matching runtime task was cancelled', () => {
    expect(isImageGenerationPending(imageGenerationMessages(), [], {
      now: NOW,
      runtimeRun: runtimeRunWithTask({
        taskId: TASK_ID,
        title: 'Generate image',
        status: 'running',
        terminalOutcome: 'cancelled',
      }),
    })).toBe(false);
  });

  test('settles from the matching async task evidence ledger without transcript completion prose', () => {
    expect(isImageGenerationPending(imageGenerationMessages(), [], {
      now: NOW,
      runtimeRun: {
        asyncTaskLedger: {
          [`task:${TASK_ID}`]: {
            id: `task:${TASK_ID}`,
            taskId: TASK_ID,
            status: 'error',
            source: 'task-completion',
            updatedAt: NOW,
          },
        },
      },
    })).toBe(false);
  });

  test('still settles when a user-visible image is delivered', () => {
    const messages = imageGenerationMessages();
    messages.push({
      role: 'assistant',
      content: [],
      _attachedFiles: [{
        fileName: 'poster.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
        preview: null,
        source: 'gateway-media',
        gatewayUrl: '/api/chat/media/outgoing/session/poster.jpg',
      }],
      timestamp: NOW + 1000,
    });

    expect(isImageGenerationPending(messages, [], { now: NOW + 1000 })).toBe(false);
  });

  test('keeps the existing timeout fallback', () => {
    expect(isImageGenerationPending(imageGenerationMessages(NOW), [], {
      now: NOW + IMAGE_GENERATION_TIMEOUT_MS + 15_001,
    })).toBe(false);
  });

  test('keeps the legacy numeric now argument compatible', () => {
    expect(isImageGenerationPending(imageGenerationMessages(), [], NOW)).toBe(true);
  });
});
