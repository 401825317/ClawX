import type { ElectronApplication, Page } from '@playwright/test';
import type { ChatRuntimeEvent } from '../../shared/chat-runtime-events';
import type { ConversationPerformanceSnapshot } from '../../src/stores/conversation/metrics';
import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const RUN_ID = 'run-timeline-e2e';
const STREAM_FRAME_COUNT = 24;
const STREAM_EVENTS_PER_FRAME = 8;

type TimelinePerformanceTestWindow = Window & {
  __clawxTimelinePerformance?: {
    reset: () => void;
    snapshot: () => ConversationPerformanceSnapshot;
  };
};

function performanceThreshold(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured >= 0 ? configured : fallback;
}

async function waitForAnimationFrames(page: Page, count = 1): Promise<void> {
  await page.evaluate(async (frameCount) => await new Promise<void>((resolve) => {
    let remaining = frameCount;
    const next = () => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
        return;
      }
      window.requestAnimationFrame(next);
    };
    window.requestAnimationFrame(next);
  }), count);
}

async function resetTimelinePerformance(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as TimelinePerformanceTestWindow).__clawxTimelinePerformance;
    if (!api) throw new Error('Timeline performance test API is unavailable');
    api.reset();
  });
  await waitForAnimationFrames(page, 2);
}

async function timelinePerformanceSnapshot(page: Page): Promise<ConversationPerformanceSnapshot> {
  return await page.evaluate(() => {
    const api = (window as TimelinePerformanceTestWindow).__clawxTimelinePerformance;
    if (!api) throw new Error('Timeline performance test API is unavailable');
    return api.snapshot();
  });
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(',')}}`;
}

async function installTimelineMocks(
  app: ElectronApplication,
  history: unknown[],
  options: {
    historyError?: string;
    devModeUnlocked?: boolean;
    captureHostApiRequests?: boolean;
    thumbnailResults?: Record<string, unknown>;
    reasoningLevel?: 'off' | 'on' | 'stream';
  } = {},
): Promise<void> {
  const sessions = [{
    key: SESSION_KEY,
    displayName: 'main',
    status: 'done',
    hasActiveRun: false,
    ...(options.reasoningLevel ? { reasoningLevel: options.reasoningLevel } : {}),
  }];
  const historyResult = {
    messages: history,
    sessionInfo: { hasActiveRun: false },
    ...(options.reasoningLevel ? { reasoningLevel: options.reasoningLevel } : {}),
  };

  const gatewayHistoryResponse = options.historyError
    ? { success: false, error: options.historyError }
    : { success: true, result: historyResult };
  const hostHistoryResponse = options.historyError
    ? { success: false, error: options.historyError }
    : { success: true, result: historyResult };

  await installIpcMocks(app, {
    captureHostApiRequests: options.captureHostApiRequests,
    gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
    gatewayRpc: {
      [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: {
        success: true,
        result: { sessions },
      },
      [stableStringify(['sessions.list', {}])]: {
        success: true,
        result: { sessions },
      },
      [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 100, maxChars: 500000 }])]: {
        ...gatewayHistoryResponse,
      },
      [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 1000, maxChars: 500000 }])]: {
        ...gatewayHistoryResponse,
      },
      [stableStringify(['chat.send', null])]: {
        success: true,
        result: { runId: RUN_ID },
      },
    },
    hostApi: {
      [stableStringify(['/api/settings', 'GET'])]: {
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: { devModeUnlocked: options.devModeUnlocked ?? false },
        },
      },
      [stableStringify(['/api/gateway/status', 'GET'])]: {
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
        },
      },
      [stableStringify(['/api/chat/sessions', 'GET'])]: {
        ok: true,
        data: { status: 200, ok: true, json: { success: true, result: { sessions } } },
      },
      [stableStringify(['/api/chat/history', 'POST'])]: {
        ok: true,
        data: { status: 200, ok: true, json: hostHistoryResponse },
      },
      [stableStringify(['/api/chat/send', 'POST'])]: {
        ok: true,
        data: { status: 200, ok: true, json: { success: true, result: { runId: RUN_ID } } },
      },
      [stableStringify(['/api/chat/send-with-media', 'POST'])]: {
        ok: true,
        data: { status: 200, ok: true, json: { success: true, result: { runId: RUN_ID } } },
      },
      [stableStringify(['/api/agents', 'GET'])]: {
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: { success: true, agents: [{ id: 'main', name: 'Main' }] },
        },
      },
      [stableStringify(['/api/files/thumbnails', 'POST'])]: {
        ok: true,
        data: { status: 200, ok: true, json: options.thumbnailResults ?? {} },
      },
    },
  });
}

async function openTimeline(app: ElectronApplication): Promise<Page> {
  let page = await getStableWindow(app);
  try {
    await page.reload();
  } catch (error) {
    if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
  }
  page = await getStableWindow(app);
  await expect(page.getByTestId('main-layout')).toBeVisible();
  await expect(page.getByTestId('chat-page')).toBeVisible();
  return page;
}

async function emitRuntimeEvents(app: ElectronApplication, events: ChatRuntimeEvent[]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, runtimeEvents) => {
    for (const event of runtimeEvents) {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('chat:runtime-event', event);
      }
    }
  }, events);
}

async function emitGatewayChatMessage(app: ElectronApplication, payload: unknown): Promise<void> {
  await app.evaluate(({ BrowserWindow }, chatPayload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('gateway:chat-message', chatPayload);
    }
  }, payload);
}

async function capturedHostApiRequests(
  app: ElectronApplication,
): Promise<Array<{ path?: string; method?: string; body?: string }>> {
  return await app.evaluate(() => {
    const requests = (globalThis as Record<string, unknown>).__clawxE2EHostApiRequests;
    return Array.isArray(requests) ? requests : [];
  });
}

const semanticHistory = [
  {
    id: 'timeline-user',
    role: 'user',
    content: 'Inspect the timeline fixture.',
    timestamp: 1_000,
  },
  {
    id: 'timeline-commentary',
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Private fixture reasoning made explicitly displayable.' },
      { type: 'text', text: 'I am checking the relevant files.' },
    ],
    timestamp: 1_001,
  },
  {
    id: 'timeline-tools',
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'read-fixture-a', name: 'read_file', arguments: { path: '/tmp/a.ts' } },
      { type: 'toolCall', id: 'read-fixture-a', name: 'read_file', arguments: { path: '/tmp/a.ts' } },
      { type: 'toolCall', id: 'read-fixture-b', name: 'open_file', arguments: { path: '/tmp/b.ts' } },
    ],
    timestamp: 1_002,
  },
  {
    id: 'timeline-result-a',
    role: 'toolResult',
    toolCallId: 'read-fixture-a',
    toolName: 'read_file',
    content: [{ type: 'text', text: 'a.ts contents' }],
    timestamp: 1_003,
  },
  {
    id: 'timeline-result-b',
    role: 'toolResult',
    toolCallId: 'read-fixture-b',
    toolName: 'open_file',
    content: [{ type: 'text', text: 'b.ts contents' }],
    timestamp: 1_004,
  },
  {
    id: 'timeline-final',
    role: 'assistant',
    content: 'The timeline fixture is complete.',
    timestamp: 1_005,
  },
];

function singleLongTurnHistory(toolCount = 160): unknown[] {
  const history: unknown[] = [{
    id: 'long-turn-user',
    role: 'user',
    content: 'Process a long sequence inside one Turn.',
    timestamp: 50_000,
  }];

  for (let index = 0; index < toolCount; index += 1) {
    const toolCallId = `long-turn-tool-${index + 1}`;
    history.push({
      id: `long-turn-assistant-${index + 1}`,
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: toolCallId,
        name: 'read_file',
        arguments: { path: `/tmp/long-turn-${index + 1}.txt` },
      }, {
        type: 'text',
        text: `Long Turn commentary ${index + 1}`,
      }],
      timestamp: 50_001 + index * 2,
    }, {
      id: `long-turn-result-${index + 1}`,
      role: 'toolResult',
      toolCallId,
      toolName: 'read_file',
      content: [{ type: 'text', text: `Long Turn tool result ${index + 1}` }],
      timestamp: 50_002 + index * 2,
    });
  }

  history.push({
    id: 'long-turn-final',
    role: 'assistant',
    content: 'Long single-Turn final answer.',
    timestamp: 60_000,
  });
  return history;
}

test.describe('Codex-style conversation timeline', () => {
  test('drives composer activity from the canonical Turn instead of legacy sending state', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installTimelineMocks(app, []);
      const page = await openTimeline(app);
      const sendButton = page.getByTestId('chat-composer-send');

      await page.getByTestId('chat-composer-input').fill('Keep the composer bound to the canonical Turn.');
      await sendButton.click();
      await expect(sendButton).toHaveAttribute('title', /Stop|停止/);

      await app.evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('gateway:chat-message', {
            message: {
              state: 'error',
              runId: 'run-timeline-e2e',
              sessionKey: 'agent:main:main',
              errorMessage: 'connection reset while the legacy recovery timer is still active',
            },
          });
        }
      });

      await expect(sendButton).toHaveAttribute('title', /Send|发送/);
      await expect(page.getByTestId('timeline-error')).toContainText('connection reset while the legacy recovery timer is still active');
      await expect(page.getByTestId('chat-run-error')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('retries only the latest recoverable Turn and preserves its media send intent', async ({ launchElectronApp }) => {
    const history = [{
      id: 'retry-source-user',
      role: 'user',
      content: 'Create the source image.',
      timestamp: 900,
    }, {
      id: 'retry-source-final',
      role: 'assistant',
      content: 'The source image is ready.',
      timestamp: 901,
      _attachedFiles: [{
        fileName: 'retry-source.png',
        mimeType: 'image/png',
        fileSize: 128,
        preview: 'data:image/png;base64,aW1hZ2U=',
        filePath: '/tmp/retry-source.png',
        source: 'tool-result',
        disposition: 'output-delivery',
      }],
    }];
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installTimelineMocks(app, history, { captureHostApiRequests: true });
      const page = await openTimeline(app);
      await page.getByTestId('image-edit-reference-button').click();
      await expect(page.getByTestId('chat-image-edit-reference')).toContainText('retry-source.png');
      await page.getByTestId('chat-composer-mode-image').click();
      await page.getByTestId('chat-composer-input').fill('Keep the composition and change the lighting.');
      await page.getByTestId('chat-composer-send').click();

      await expect.poll(async () => (
        (await capturedHostApiRequests(app)).filter((request) => request.path === '/api/chat/send-with-media').length
      )).toBe(1);

      await emitGatewayChatMessage(app, {
        message: {
          state: 'error',
          runId: RUN_ID,
          sessionKey: SESSION_KEY,
          errorMessage: 'connection reset while reading the image response',
        },
      });

      const timelineError = page.getByTestId('timeline-error');
      await expect(timelineError).toHaveAttribute('data-recoverable', 'true');
      const retryButton = page.getByTestId('timeline-error-retry');
      await expect(retryButton).toBeVisible();
      await retryButton.click();

      await expect.poll(async () => (
        (await capturedHostApiRequests(app)).filter((request) => request.path === '/api/chat/send-with-media').length
      )).toBe(2);
      await expect(page.getByTestId('timeline-error-retry')).toHaveCount(0);

      const sendRequests = (await capturedHostApiRequests(app))
        .filter((request) => request.path === '/api/chat/send-with-media');
      const first = JSON.parse(sendRequests[0]?.body ?? '{}') as Record<string, unknown>;
      const retried = JSON.parse(sendRequests[1]?.body ?? '{}') as Record<string, unknown>;
      expect(retried.message).toBe(first.message);
      expect(retried.inlineAttachments).toBe(true);
      expect(retried.media).toEqual(first.media);
      expect(retried.clientPreferences).toEqual(first.clientPreferences);
      expect(retried.clientPreferences).toMatchObject({
        mode: 'image',
        selectedArtifacts: [{
          filePath: '/tmp/retry-source.png',
          mimeType: 'image/png',
          title: 'retry-source.png',
        }],
      });
      expect(retried.idempotencyKey).not.toBe(first.idempotencyKey);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('shows runtime failures without a retry command when they are not recoverable', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installTimelineMocks(app, []);
      const page = await openTimeline(app);
      await page.getByTestId('chat-composer-input').fill('Use a provider with no remaining quota.');
      await page.getByTestId('chat-composer-send').click();
      await emitRuntimeEvents(app, [{
        type: 'run.ended',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        status: 'error',
        error: 'Provider quota exceeded',
        ts: Date.now(),
      }]);

      const timelineError = page.getByTestId('timeline-error');
      await expect(timelineError).toContainText('Provider quota exceeded');
      await expect(timelineError).toHaveAttribute('data-recoverable', 'false');
      await expect(page.getByTestId('timeline-error-retry')).toHaveCount(0);
      await expect(page.getByTestId('chat-run-error')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps legacy turn errors out of Timeline while exposing history operation failures', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installTimelineMocks(app, [], { historyError: 'history-operation-error-remains-visible' });
      const page = await openTimeline(app);

      const historyError = page.getByTestId('chat-history-error');
      await expect(historyError).toContainText('history-operation-error-remains-visible');
      await expect(page.getByText('history-operation-error-remains-visible', { exact: true })).toHaveCount(1);
      await historyError.locator('button').last().click();
      await expect(historyError).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('replays a stable user, commentary, grouped-tool, and final sequence', async ({ launchElectronApp }, testInfo) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installTimelineMocks(app, semanticHistory, { reasoningLevel: 'on' });
      const page = await openTimeline(app);

      const turnRows = page.getByTestId('conversation-turn');
      await expect(turnRows).toHaveCount(1, { timeout: 30_000 });
      await expect(page.getByText('Inspect the timeline fixture.', { exact: true })).toBeVisible();
      await expect(page.getByTestId('timeline-commentary')).toContainText('I am checking the relevant files.');
      await expect(page.getByText('The timeline fixture is complete.', { exact: true })).toBeVisible();

      const timelineRows = page.getByTestId('conversation-timeline').locator('[data-timeline-row-id]');
      const turnIds = await timelineRows.evaluateAll((elements) => (
        [...new Set(elements.map((element) => (element as HTMLElement).dataset.turnId).filter(Boolean))]
      ));
      expect(turnIds).toHaveLength(1);

      const itemOrder = await timelineRows.evaluateAll((elements) => {
        const indexContaining = (value: string) => elements.findIndex((element) => element.textContent?.includes(value));
        const toolIndex = elements.findIndex((element) => (
          element.matches('[data-testid="timeline-tool-group"]')
          || element.querySelector('[data-testid="timeline-tool-group"]')
        ));
        return {
          user: indexContaining('Inspect the timeline fixture.'),
          commentary: indexContaining('I am checking the relevant files.'),
          tool: toolIndex,
          final: indexContaining('The timeline fixture is complete.'),
        };
      });
      expect(itemOrder.user).toBeGreaterThanOrEqual(0);
      expect(itemOrder.commentary).toBeGreaterThan(itemOrder.user);
      expect(itemOrder.tool).toBeGreaterThan(itemOrder.commentary);
      expect(itemOrder.final).toBeGreaterThan(itemOrder.tool);

      await expect(page.getByTestId('timeline-tool-group')).toHaveCount(1);
      await page.getByTestId('timeline-tool-group-toggle').click();
      await expect(page.getByTestId('timeline-tool-details').locator(':scope > div')).toHaveCount(2);
      await expect(page.getByTestId('timeline-tool-details')).toContainText('read_file');
      await expect(page.getByTestId('timeline-tool-details')).toContainText('open_file');
      const expandedToolsScreenshotPath = testInfo.outputPath('timeline-expanded-tool-details.png');
      await page.getByTestId('conversation-timeline').screenshot({ path: expandedToolsScreenshotPath });
      await testInfo.attach('timeline-expanded-tool-details', {
        path: expandedToolsScreenshotPath,
        contentType: 'image/png',
      });
      await page.getByTestId('timeline-tool-group-toggle').click();
      await expect(page.getByTestId('timeline-tool-details')).toHaveCount(0);

      const thinking = page.getByTestId('timeline-thinking');
      await expect(thinking.locator('button')).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByText('Private fixture reasoning made explicitly displayable.', { exact: true })).toHaveCount(0);
      await thinking.locator('button').click();
      await expect(page.getByText('Private fixture reasoning made explicitly displayable.', { exact: true })).toBeVisible();
      await thinking.locator('button').click();
      await expect(thinking.locator('button')).toHaveAttribute('aria-expanded', 'false');

      // This restored-history turn has no legacy runtimeRun. Execution details
      // must therefore come from the reduced canonical tool item.
      await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);
      await page.getByTestId('timeline-execution-details').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByTestId('chat-execution-step').filter({ hasText: 'read_file' })).toBeVisible();
      await expect(page.getByTestId('chat-execution-step').filter({ hasText: 'open_file' })).toBeVisible();
      const executionDetailsScreenshotPath = testInfo.outputPath('timeline-execution-details.png');
      await page.getByRole('dialog').screenshot({ path: executionDetailsScreenshotPath });
      await testInfo.attach('timeline-execution-details', {
        path: executionDetailsScreenshotPath,
        contentType: 'image/png',
      });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);

      const screenshotPath = testInfo.outputPath('codex-style-conversation-timeline.png');
      await page.getByTestId('conversation-timeline').screenshot({ path: screenshotPath });
      await testInfo.attach('codex-style-conversation-timeline', {
        path: screenshotPath,
        contentType: 'image/png',
      });
    } finally {
      await closeElectronApp(app);
    }
  });

  test('renders artifact-owned output media once while preserving final input references', async ({ launchElectronApp }) => {
    const outputData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const outputPreview = `data:image/png;base64,${outputData}`;
    const referencePreview = 'data:image/png;base64,cmVmZXJlbmNl';
    const history = [{
      id: 'media-owner-user',
      role: 'user',
      content: 'Generate an image from my reference.',
      timestamp: 7_000,
    }, {
      id: 'media-owner-final',
      role: 'assistant',
      content: [{
        type: 'text',
        text: 'The generated image is ready.\nMEDIA:/tmp/generated-output.png',
      }, {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: outputData },
      }],
      timestamp: 7_001,
      _attachedFiles: [{
        fileName: 'generated-output.png',
        mimeType: 'image/png',
        fileSize: 128,
        preview: outputPreview,
        filePath: '/tmp/generated-output.png',
        source: 'tool-result',
        disposition: 'output-delivery',
      }, {
        fileName: 'reference-input.png',
        mimeType: 'image/png',
        fileSize: 64,
        preview: referencePreview,
        source: 'user-upload',
        disposition: 'input-reference',
      }],
    }];
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installTimelineMocks(app, history);
      const page = await openTimeline(app);

      await expect(page.getByText('The generated image is ready.')).toBeVisible();
      await expect(page.getByTestId('chat-image-preview-card')).toHaveCount(2);
      await expect(page.locator('img[alt="generated-output.png"]')).toHaveCount(1);
      await expect(page.locator('img[alt="reference-input.png"]')).toHaveCount(1);
      await expect(page.locator('img[alt="image"]')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps owner and completion-wake finals in one Turn across history refresh', async ({ launchElectronApp }) => {
    const prompt = 'Generate one image without duplicating the final reply.';
    const finalText = 'The generated image is ready once.';
    const taskId = 'timeline-completion-wake-task';
    const wakeRunId = `image_generate:${taskId}:ok`;
    const outputPath = '/tmp/timeline-completion-wake.png';
    const outputPreview = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const timestamp = Date.now() / 1_000;
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installTimelineMocks(app, []);
      const page = await openTimeline(app);
      await page.getByTestId('chat-composer-input').fill(prompt);
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);

      await emitRuntimeEvents(app, [{
        type: 'task.updated',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        taskId,
        seq: 11,
        ts: timestamp + 2,
        task: {
          taskId,
          title: 'Generate image',
          status: 'running',
          updatedAt: timestamp + 2,
        },
      }]);
      await expect(page.getByTestId('timeline-subtasks')).toBeVisible();

      await emitGatewayChatMessage(app, {
        message: {
          state: 'final',
          runId: RUN_ID,
          sessionKey: SESSION_KEY,
          seq: 12,
          message: {
            role: 'assistant',
            id: 'timeline-owner-final',
            timestamp: timestamp + 1,
            content: 'The image task was queued.',
          },
        },
      });
      await expect(page.getByText('The image task was queued.', { exact: true })).toHaveCount(1);
      const liveCommentaryTop = await page.getByText('The image task was queued.', { exact: true }).boundingBox();
      const liveTaskTop = await page.getByTestId('timeline-subtasks').boundingBox();
      expect(liveCommentaryTop).not.toBeNull();
      expect(liveTaskTop).not.toBeNull();
      expect(liveCommentaryTop!.y).toBeLessThan(liveTaskTop!.y);

      await emitRuntimeEvents(app, [{
        type: 'artifact.produced',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        taskId,
        seq: 13,
        ts: timestamp + 3,
        artifact: {
          id: 'timeline-completion-wake-artifact',
          title: 'timeline-completion-wake.png',
          filePath: outputPath,
          mimeType: 'image/png',
          preview: outputPreview,
          availability: 'available',
        },
      }, {
        type: 'task.updated',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        taskId,
        seq: 14,
        ts: timestamp + 4,
        task: {
          taskId,
          title: 'Generate image',
          status: 'completed',
          deliveryStatus: 'delivered',
          updatedAt: timestamp + 4,
        },
      }]);
      await expect(page.getByTestId('timeline-artifacts')).toBeVisible();

      await emitGatewayChatMessage(app, {
        message: {
          state: 'final',
          runId: wakeRunId,
          seq: 1,
          message: {
            role: 'assistant',
            id: 'timeline-wake-final',
            timestamp: timestamp + 5,
            content: finalText,
          },
        },
      });
      await expect(page.getByText(finalText, { exact: true })).toHaveCount(1);
      await expect(page.getByText('The image task was queued.', { exact: true })).toHaveCount(1);

      await installTimelineMocks(app, [{
        id: 'timeline-history-user',
        role: 'user',
        content: prompt,
        timestamp,
      }, {
        id: 'timeline-history-process',
        role: 'assistant',
        content: [{
          type: 'text',
          text: 'The image task was queued.',
        }, {
          type: 'toolCall',
          id: 'timeline-history-image-tool',
          name: 'image_generate',
          arguments: { prompt },
        }],
        timestamp: timestamp + 1,
      }, {
        id: 'timeline-history-tool-result',
        role: 'toolresult',
        content: 'Background image task started.',
        timestamp: timestamp + 3,
        toolCallId: 'timeline-history-image-tool',
        toolName: 'image_generate',
        details: {
          async: true,
          status: 'started',
          taskId,
          runId: `tool:image_generate:${taskId}`,
        },
      }, {
        id: 'timeline-history-final',
        role: 'assistant',
        content: `${finalText}\n\nMEDIA:${outputPath}`,
        timestamp: timestamp + 5,
        _attachedFiles: [{
          fileName: 'timeline-completion-wake.png',
          mimeType: 'image/png',
          fileSize: 64,
          preview: outputPreview,
          filePath: outputPath,
          availability: 'available',
          source: 'message-ref',
          disposition: 'output-delivery',
        }],
      }]);
      await page.getByRole('button', { name: /Refresh|刷新/u }).click();

      await expect(page.getByTestId('conversation-turn')).toHaveCount(1);
      await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);
      await expect(page.getByText(finalText, { exact: true })).toHaveCount(1);
      await expect(page.getByText('The image task was queued.', { exact: true })).toHaveCount(1);
      const commentaryTop = await page.getByText('The image task was queued.', { exact: true }).boundingBox();
      const artifactTop = await page.getByTestId('timeline-artifacts').boundingBox();
      const finalTop = await page.getByText(finalText, { exact: true }).boundingBox();
      expect(commentaryTop).not.toBeNull();
      expect(artifactTop).not.toBeNull();
      expect(finalTop).not.toBeNull();
      expect(commentaryTop!.y).toBeLessThan(artifactTop!.y);
      expect(artifactTop!.y).toBeLessThan(finalTop!.y);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps one Turn-level execution details entry for plan-only evidence', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installTimelineMocks(app, []);
      const page = await openTimeline(app);
      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('Plan the release without running tools.');
      await page.getByTestId('chat-composer-send').click();

      const now = Date.now();
      await emitRuntimeEvents(app, [{
        type: 'run.started',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        startedAt: now,
        ts: now,
      }, {
        type: 'run.plan.updated',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        objective: 'Plan the release',
        summary: 'One planning step',
        steps: [{ id: 'plan-only-step', title: 'Review the release plan', status: 'running', order: 1 }],
        ts: now + 1,
      }, {
        type: 'run.ended',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        status: 'completed',
        endedAt: now + 2_000,
        ts: now + 2_000,
      }]);

      await expect(page.getByTestId('timeline-plan')).toBeVisible();
      await expect(page.getByTestId('timeline-tool-group')).toHaveCount(0);
      await expect(page.getByTestId('timeline-subtasks')).toHaveCount(0);
      await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);
      await page.getByTestId('timeline-execution-details').click();
      await expect(page.getByTestId('chat-execution-step').filter({ hasText: 'Review the release plan' })).toBeVisible();
      await expect(page.getByTestId('chat-execution-graph')).not.toContainText('整体耗时');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps execution graph opt-in while surfacing approval, artifact, and verification evidence', async ({ launchElectronApp }, testInfo) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installTimelineMocks(app, [], {
        devModeUnlocked: true,
        thumbnailResults: {
          '/tmp/timeline-release.txt': {
            fileName: 'timeline-release.txt',
            mimeType: 'text/plain',
            fileSize: 42,
            preview: null,
          },
        },
      });
      const page = await openTimeline(app);
      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('Build and verify the release artifact.');
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByText('Build and verify the release artifact.', { exact: true })).toBeVisible();
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Stop|停止/);

      const now = Date.now();
      await emitRuntimeEvents(app, [{
        type: 'run.started',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        startedAt: now,
        ts: now,
      }, {
        type: 'run.plan.updated',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        objective: 'Build and verify an artifact',
        summary: 'One structured release step',
        steps: [{ id: 'release-step', title: 'Create release evidence', status: 'running', order: 1 }],
        ts: now + 1,
      }, {
        type: 'task.updated',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        taskId: 'release-research',
        parentTaskId: 'release-parent',
        task: {
          taskId: 'release-research',
          parentTaskId: 'release-parent',
          kind: 'research',
          runtime: 'subagent',
          title: 'Research release requirements',
          status: 'completed',
          updatedAt: now + 2,
        },
        ts: now + 2,
      }, {
        type: 'task.updated',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        taskId: 'release-review',
        parentTaskId: 'release-parent',
        task: {
          taskId: 'release-review',
          parentTaskId: 'release-parent',
          kind: 'review',
          runtime: 'subagent',
          title: 'Review release evidence',
          status: 'running',
          updatedAt: now + 3,
        },
        ts: now + 3,
      }, {
        type: 'tool.started',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        toolCallId: 'write-release-artifact',
        name: 'write_file',
        args: { path: '/tmp/timeline-release.txt' },
        ts: now + 4,
      }, {
        type: 'tool.completed',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        toolCallId: 'write-release-artifact',
        name: 'write_file',
        result: { path: '/tmp/timeline-release.txt', bytes: 42 },
        durationMs: 12,
        ts: now + 5,
      }, {
        type: 'approval.updated',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        itemId: 'publish-release',
        title: 'Approve release publication',
        kind: 'external_action',
        phase: 'requested',
        status: 'pending',
        message: 'Review the release artifact before publishing.',
        ts: now + 6,
      }, {
        type: 'artifact.produced',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        toolCallId: 'write-release-artifact',
        artifact: {
          id: 'timeline-release-artifact',
          kind: 'document',
          title: 'timeline-release.txt',
          filePath: '/tmp/timeline-release.txt',
          mimeType: 'text/plain',
          sizeBytes: 42,
          sourceToolCallId: 'write-release-artifact',
        },
        ts: now + 7,
      }, {
        type: 'verification.completed',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        toolCallId: 'write-release-artifact',
        verification: {
          id: 'timeline-release-verification',
          status: 'passed',
          kind: 'artifact.integrity',
          required: true,
          title: 'Artifact integrity',
          artifactId: 'timeline-release-artifact',
        },
        ts: now + 8,
      }, {
        type: 'run.step.updated',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        timelineVisibility: 'diagnostics',
        step: {
          id: 'diagnostics-only-step',
          title: 'Diagnostics-only raw step',
          status: 'completed',
        },
        ts: now + 9,
      }, {
        type: 'run.step.updated',
        producer: 'uclaw-host-task',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        taskId: 'release-review',
        timelineVisibility: 'diagnostics',
        step: {
          id: 'owned-diagnostics-step',
          title: 'Owned canonical diagnostics step',
          kind: 'host.local.presentation.render',
          status: 'completed',
          taskId: 'release-review',
          toolCallId: 'owned-diagnostics-tool',
        },
        ts: now + 10,
      }, {
        type: 'run.ended',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        status: 'completed',
        endedAt: now + 2_000,
        ts: now + 2_000,
      }]);

      await expect(page.getByTestId('timeline-tool-group')).toHaveCount(1);
      const subtasks = page.getByTestId('timeline-subtasks');
      await expect(subtasks).toHaveCount(1);
      await expect(page.getByTestId('timeline-subtasks-toggle')).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('timeline-subtask-details')).toHaveCount(0);
      await page.getByTestId('timeline-subtasks-toggle').click();
      const subtaskDetails = page.getByTestId('timeline-subtask-details');
      await expect(subtaskDetails.locator(':scope > div')).toHaveCount(2);
      await expect(subtaskDetails).toContainText('Research release requirements');
      await expect(subtaskDetails).toContainText('Review release evidence');
      await expect(subtaskDetails).toContainText(/Completed|已完成/);
      await expect(subtaskDetails).toContainText(/Running|执行中/);
      await expect(page.getByTestId('timeline-approval')).toContainText('Approve release publication');
      await expect(page.getByTestId('timeline-artifacts')).toContainText('timeline-release.txt');
      await expect(page.getByTestId('timeline-verification')).toBeVisible();

      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
      await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);
      await page.getByTestId('timeline-execution-details').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByTestId('chat-execution-graph')).toBeVisible();
      await expect(page.getByTestId('chat-execution-step').filter({ hasText: 'Create release evidence' })).toBeVisible();
      await expect(page.getByTestId('chat-execution-step').filter({ hasText: 'write_file' })).toBeVisible();
      await expect(page.getByTestId('chat-execution-step').filter({ hasText: 'host.local.presentation.render' })).toBeVisible();
      await expect(page.getByTestId('chat-execution-graph')).not.toContainText('整体耗时');
      await expect(page.getByTestId('chat-execution-graph')).not.toContainText('Diagnostics-only raw step');
      await expect(page.getByTestId('timeline-assignment-diagnostics')).toBeVisible();
      await expect(page.getByTestId('timeline-assignment-diagnostics')).toContainText('explicit-turn');
      await expect(page.getByTestId('timeline-assignment-diagnostics')).toContainText('root-run-alias');
      const diagnosticsScreenshotPath = testInfo.outputPath('timeline-developer-diagnostics.png');
      await page.getByRole('dialog').screenshot({ path: diagnosticsScreenshotPath });
      await testInfo.attach('timeline-developer-diagnostics', {
        path: diagnosticsScreenshotPath,
        contentType: 'image/png',
      });
    } finally {
      await closeElectronApp(app);
    }
  });

  test('measures real-frame streaming without completed Turn renders or sustained main-thread stalls', async ({ launchElectronApp }, testInfo) => {
    const history = [{
      id: 'performance-completed-user',
      role: 'user',
      content: 'Completed Turn before the performance stream.',
      timestamp: 9_000,
    }, {
      id: 'performance-completed-final',
      role: 'assistant',
      content: 'Completed answer before the performance stream.',
      timestamp: 9_001,
    }];
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installTimelineMocks(app, history);
      const page = await openTimeline(app);
      await page.bringToFront();
      const completedAnswer = page.getByText('Completed answer before the performance stream.', { exact: true });
      await expect(completedAnswer).toBeVisible({ timeout: 30_000 });
      const completedTurnId = await completedAnswer.evaluate((element) => (
        element.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId ?? ''
      ));
      expect(completedTurnId).not.toBe('');

      await expect(page.getByTestId('chat-composer-input')).toBeEnabled();
      await page.getByTestId('chat-composer-input').fill('Performance stream active Turn.');
      await page.getByTestId('chat-composer-send').click();
      const activeMessage = page.getByText('Performance stream active Turn.', { exact: true });
      await expect(activeMessage).toBeVisible();
      const activeTurnId = await activeMessage.evaluate((element) => (
        element.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId ?? ''
      ));
      expect(activeTurnId).not.toBe('');
      expect(activeTurnId).not.toBe(completedTurnId);

      const startedAt = Date.now();
      await emitRuntimeEvents(app, [{
        type: 'run.started',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        startedAt,
        seq: 0,
        ts: startedAt,
      }, {
        type: 'assistant.delta',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        text: 'Performance stream seed.',
        replace: true,
        seq: 1,
        ts: startedAt + 1,
      }]);
      await expect(page.getByTestId('timeline-commentary').filter({ hasText: 'Performance stream seed.' })).toBeVisible();
      await expect(page.locator(`[data-turn-id="${completedTurnId}"]`).first()).toBeVisible();

      await resetTimelinePerformance(page);
      let sequence = 2;
      let finalText = '';
      const measurementStartedAt = Date.now();
      for (let frameIndex = 0; frameIndex < STREAM_FRAME_COUNT; frameIndex += 1) {
        const events = Array.from({ length: STREAM_EVENTS_PER_FRAME }, (_, eventIndex): ChatRuntimeEvent => {
          const eventSequence = sequence;
          sequence += 1;
          finalText = `Performance frame ${frameIndex + 1}, update ${eventIndex + 1}. ${'stream payload '.repeat(48)}`;
          return {
            type: 'assistant.delta',
            producer: 'openclaw',
            runId: RUN_ID,
            sessionKey: SESSION_KEY,
            text: finalText,
            replace: true,
            seq: eventSequence,
            ts: startedAt + eventSequence,
          };
        });
        await emitRuntimeEvents(app, events);
        await waitForAnimationFrames(page);
      }
      await expect(page.getByTestId('timeline-commentary').filter({ hasText: finalText })).toBeVisible();
      await waitForAnimationFrames(page, 3);

      const elapsedMs = Date.now() - measurementStartedAt;
      const snapshot = await timelinePerformanceSnapshot(page);
      const minimumFps = performanceThreshold('CLAWX_TIMELINE_MIN_FPS', 30);
      const maximumLongTaskCount = performanceThreshold('CLAWX_TIMELINE_MAX_LONG_TASKS', 1);
      const maximumLongTaskShare = performanceThreshold('CLAWX_TIMELINE_MAX_LONG_TASK_SHARE', 0.1);
      const longTaskShare = snapshot.longTasks.totalMs / Math.max(1, elapsedMs);
      const evidence = {
        fixture: {
          frames: STREAM_FRAME_COUNT,
          eventsPerFrame: STREAM_EVENTS_PER_FRAME,
          elapsedMs,
        },
        thresholds: {
          targetFps: 60,
          minimumFps,
          maximumLongTaskCount,
          maximumLongTaskShare,
        },
        completedTurnId,
        activeTurnId,
        completedTurnRenders: snapshot.itemRendersByTurnId[completedTurnId] ?? 0,
        activeTurnRenders: snapshot.itemRendersByTurnId[activeTurnId] ?? 0,
        longTaskShare,
        snapshot,
      };
      console.info(`[timeline-performance] ${JSON.stringify(evidence)}`);
      await testInfo.attach('timeline-stream-performance', {
        body: Buffer.from(JSON.stringify(evidence, null, 2)),
        contentType: 'application/json',
      });

      expect(snapshot.maxStoreCommitsPerFrame).toBeLessThanOrEqual(1);
      expect(snapshot.storeCommits).toBeGreaterThan(0);
      expect(snapshot.itemRendersByTurnId[completedTurnId] ?? 0).toBe(0);
      expect(snapshot.itemRendersByTurnId[activeTurnId] ?? 0).toBeGreaterThan(0);
      expect(snapshot.sampledFrames).toBeGreaterThanOrEqual(STREAM_FRAME_COUNT);
      expect(snapshot.longTaskObserverSupported).toBe(true);
      expect(snapshot.averageFps).toBeGreaterThanOrEqual(minimumFps);
      expect(snapshot.longTasks.count).toBeLessThanOrEqual(maximumLongTaskCount);
      expect(longTaskShare).toBeLessThanOrEqual(maximumLongTaskShare);
    } finally {
      await closeElectronApp(app);
    }
  });

  for (const messageCount of [500, 1_000]) {
    test(`keeps a ${messageCount}-message replay DOM bounded to the virtualized viewport`, async ({ launchElectronApp }, testInfo) => {
      const history = Array.from({ length: messageCount }, (_, index) => ({
        id: `virtual-message-${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `Virtual timeline message ${index + 1}`,
        timestamp: 10_000 + index,
      }));
      const interactiveStartedAt = Date.now();
      const app = await launchElectronApp({ skipSetup: true });

      try {
        await installTimelineMocks(app, history);
        const page = await openTimeline(app);
        await expect(page.getByText(`Virtual timeline message ${messageCount}`, { exact: true })).toBeVisible({ timeout: 30_000 });

        const timeline = page.getByTestId('conversation-timeline');
        await expect(timeline).toHaveAttribute('data-total-row-count', String(messageCount));
        const mountedRows = timeline.locator('[data-timeline-row-id]');
        const mountedCount = await mountedRows.count();
        const snapshot = await timelinePerformanceSnapshot(page);
        const evidence = {
          messageCount,
          turnCount: Number(await timeline.getAttribute('data-turn-count')),
          totalRows: Number(await timeline.getAttribute('data-total-row-count')),
          mountedRows: mountedCount,
          initialInteractiveMs: Date.now() - interactiveStartedAt,
          historyReplayMs: snapshot.historyReplay.lastMs,
          maxMountedRows: snapshot.maxMountedRows,
        };
        console.info(`[timeline-dom-performance] ${JSON.stringify(evidence)}`);
        await testInfo.attach(`timeline-dom-performance-${messageCount}`, {
          body: Buffer.from(JSON.stringify(evidence, null, 2)),
          contentType: 'application/json',
        });

        expect(mountedCount).toBeGreaterThan(0);
        expect(mountedCount).toBeLessThan(80);
        expect(mountedCount).toBeLessThan(messageCount);
      } finally {
        await closeElectronApp(app);
      }
    });
  }

  test('keeps one Turn with hundreds of timeline items DOM-bounded', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installTimelineMocks(app, singleLongTurnHistory());
      const page = await openTimeline(app);
      await expect(page.getByText('Long single-Turn final answer.', { exact: true })).toBeVisible({ timeout: 30_000 });

      const timeline = page.getByTestId('conversation-timeline');
      await expect(timeline).toHaveAttribute('data-turn-count', '1');
      const totalRowCount = Number(await timeline.getAttribute('data-total-row-count'));
      expect(totalRowCount).toBeGreaterThan(300);

      const mountedRows = timeline.locator('[data-timeline-row-id]');
      const mountedCount = await mountedRows.count();
      expect(mountedCount).toBeGreaterThan(0);
      expect(mountedCount).toBeLessThan(80);
      expect(mountedCount).toBeLessThan(totalRowCount);

      const mountedTurnIds = await mountedRows.evaluateAll((elements) => (
        [...new Set(elements.map((element) => (element as HTMLElement).dataset.turnId).filter(Boolean))]
      ));
      expect(mountedTurnIds).toHaveLength(1);
    } finally {
      await closeElectronApp(app);
    }
  });
});
