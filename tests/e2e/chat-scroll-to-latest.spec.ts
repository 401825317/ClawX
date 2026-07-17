import { resolve } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { ChatRuntimeEvent } from '../../shared/chat-runtime-events';
import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const SECOND_SESSION_KEY = 'agent:main:second';
const RUN_ID = 'run-scroll-e2e';
const DYNAMIC_MEDIA_PATH = resolve(process.cwd(), 'src/assets/uclaw-welcome-robot.png');
const DYNAMIC_MEDIA_URL = 'https://clawx.test/dynamic-media.png';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

function plainHistory(turnCount: number, prefix: string, timestampBase = 10_000) {
  return Array.from({ length: turnCount }, (_, index) => {
    const turnNumber = index + 1;
    return [{
      id: `${prefix}-user-${turnNumber}`,
      role: 'user',
      content: `${prefix} question ${turnNumber}`,
      timestamp: timestampBase + index * 10,
    }, {
      id: `${prefix}-assistant-${turnNumber}`,
      role: 'assistant',
      content: `${prefix} response ${turnNumber}`,
      timestamp: timestampBase + 1 + index * 10,
    }];
  }).flat();
}

function expandableHistory() {
  const toolCalls = Array.from({ length: 2 }, (_, index) => ({
    type: 'toolCall',
    id: `anchor-tool-${index + 1}`,
    name: 'read_file',
    arguments: { path: `/tmp/anchor-${index + 1}.txt` },
  }));
  const toolResults = toolCalls.map((toolCall, index) => ({
    id: `anchor-result-${index + 1}`,
    role: 'toolResult',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{
      type: 'text',
      text: Array.from({ length: 4 }, (_, line) => `Tool ${index + 1} detail line ${line + 1}`).join('\n'),
    }],
    timestamp: 20_002 + index,
  }));

  return [{
    id: 'anchor-user',
    role: 'user',
    content: 'Expandable anchor turn',
    timestamp: 20_000,
  }, {
    id: 'anchor-tools',
    role: 'assistant',
    content: toolCalls,
    timestamp: 20_001,
  }, ...toolResults, {
    id: 'anchor-final',
    role: 'assistant',
    content: 'Expandable anchor turn complete',
    timestamp: 20_010,
  }, ...plainHistory(20, 'Dynamic', 30_000)];
}

function dynamicMediaHistory() {
  return [{
    id: 'dynamic-media-user',
    role: 'user',
    content: 'Render a delayed media preview',
    timestamp: 21_000,
  }, {
    id: 'dynamic-media-assistant',
    role: 'assistant',
    content: [{
      type: 'text',
      text: 'Delayed media preview',
    }, {
      type: 'image',
      source: {
        type: 'url',
        url: DYNAMIC_MEDIA_URL,
        media_type: 'image/png',
      },
    }],
    timestamp: 21_001,
  }, ...plainHistory(20, 'Media', 40_000)];
}

function compactedKilledHistory() {
  const toolCycles = Array.from({ length: 3 }, (_, index) => {
    const toolCallId = `compacted-tool-${index + 1}`;
    return [{
      role: 'assistant',
      content: [{
        type: 'thinking',
        thinking: `Compacted thinking ${index + 1}`,
      }, {
        type: 'toolCall',
        id: toolCallId,
        name: 'web_search',
        arguments: { query: `market query ${index + 1}` },
      }],
      stopReason: 'toolUse',
      timestamp: 50_001 + index * 10,
    }, {
      role: 'toolResult',
      toolCallId,
      toolName: 'web_search',
      content: [{ type: 'text', text: `Compacted tool result ${index + 1}` }],
      isError: false,
      timestamp: 50_002 + index * 10,
    }];
  }).flat();

  return [{
    role: 'user',
    content: 'Compacted killed question',
    timestamp: 50_000,
  }, ...toolCycles, {
    role: 'assistant',
    content: [{ type: 'text', text: 'The agent run failed before producing a reply.' }],
    stopReason: 'error',
    timestamp: 50_032,
  }, {
    role: 'system',
    content: [{ type: 'text', text: 'Compaction' }],
    timestamp: 50_033,
  }, {
    role: 'assistant',
    content: [{ type: 'text', text: 'Compacted final answer after retry.' }],
    stopReason: 'stop',
    timestamp: 50_034,
  }];
}

async function installChatMocks(app: ElectronApplication, history: unknown[]): Promise<void> {
  const sessions = [{ key: SESSION_KEY, displayName: 'main', status: 'done', hasActiveRun: false }];
  const historyResult = { messages: history, sessionInfo: { hasActiveRun: false } };

  await installIpcMocks(app, {
    gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
    gatewayRpc: {
      [stableStringify(['sessions.list', null])]: { success: true, result: { sessions } },
      [stableStringify(['chat.history', null])]: { success: true, result: historyResult },
      [stableStringify(['chat.send', null])]: { success: true, result: { runId: RUN_ID } },
    },
    hostApi: {
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
        data: { status: 200, ok: true, json: { success: true, result: historyResult } },
      },
      [stableStringify(['/api/chat/send', 'POST'])]: {
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
        data: { status: 200, ok: true, json: {} },
      },
    },
  });
}

async function installSessionSwitchMocks(
  app: ElectronApplication,
  histories: Record<string, unknown[]>,
  options: { secondStatus?: string; abortedLastRun?: boolean } = {},
): Promise<void> {
  await app.evaluate(async ({ app: _app }, payload) => {
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
    const { sessionHistories, sessionOptions } = payload;
    const sessions = [{
      key: 'agent:main:main',
      displayName: 'Main',
      status: 'done',
      hasActiveRun: false,
      updatedAt: Date.now(),
    }, {
      key: 'agent:main:second',
      displayName: 'Second',
      status: sessionOptions.secondStatus ?? 'done',
      hasActiveRun: false,
      abortedLastRun: sessionOptions.abortedLastRun,
      updatedAt: Date.now() - 1_000,
    }];
    const historyFor = (sessionKey: string | undefined) => sessionHistories[sessionKey ?? ''] ?? [];
    const response = (json: unknown) => ({
      ok: true,
      data: { status: 200, ok: true, json },
    });

    ipcMain.removeHandler('gateway:status');
    ipcMain.handle('gateway:status', async () => ({
      state: 'running',
      port: 18789,
      pid: 12345,
      gatewayReady: true,
    }));
    ipcMain.removeHandler('gateway:rpc');
    ipcMain.handle('gateway:rpc', async (_event: unknown, method: string, params: { sessionKey?: string } = {}) => {
      if (method === 'sessions.list') return { success: true, result: { sessions } };
      if (method === 'chat.history') {
        return {
          success: true,
          result: {
            messages: historyFor(params.sessionKey),
            sessionInfo: { hasActiveRun: false },
          },
        };
      }
      return { success: true, result: {} };
    });
    ipcMain.removeHandler('hostapi:fetch');
    ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string; body?: string }) => {
      if (request.path === '/api/gateway/status') {
        return response({ state: 'running', port: 18789, pid: 12345, gatewayReady: true });
      }
      if (request.path === '/api/chat/sessions') {
        return response({ success: true, result: { sessions } });
      }
      if (request.path === '/api/chat/history') {
        const body = request.body ? JSON.parse(request.body) as { sessionKey?: string } : {};
        return response({
          success: true,
          result: {
            messages: historyFor(body.sessionKey),
            sessionInfo: { hasActiveRun: false },
          },
        });
      }
      if (request.path === '/api/agents') {
        return response({ success: true, agents: [{ id: 'main', name: 'Main' }] });
      }
      if (request.path === '/api/files/thumbnails') return response({});
      return response({});
    });
  }, { sessionHistories: histories, sessionOptions: options });
}

async function openTimeline(
  app: ElectronApplication,
  waitUntil: 'load' | 'domcontentloaded' = 'load',
): Promise<Page> {
  let page = await getStableWindow(app);
  try {
    await page.reload({ waitUntil });
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

async function scrollMetrics(scrollContainer: Locator) {
  return await scrollContainer.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    distanceFromBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
  }));
}

async function firstVisibleTimelineRow(scrollContainer: Locator, excludedTurnId?: string) {
  return await scrollContainer.evaluate((element, excluded) => {
    const scrollerTop = element.getBoundingClientRect().top;
    const rows = Array.from(element.querySelectorAll<HTMLElement>('[data-timeline-row-id]'));
    const row = rows.find((candidate) => (
      candidate.dataset.turnId !== excluded
      && candidate.getBoundingClientRect().top >= scrollerTop - 1
    )) ?? rows.find((candidate) => (
      candidate.dataset.turnId !== excluded
      && candidate.getBoundingClientRect().bottom > scrollerTop
    ));
    if (!row?.dataset.turnId || !row.dataset.timelineRowId) throw new Error('No visible conversation timeline row found');
    return {
      rowId: row.dataset.timelineRowId,
      turnId: row.dataset.turnId,
      offsetTop: row.getBoundingClientRect().top - scrollerTop,
    };
  }, excludedTurnId);
}

async function expectTimelineRowAnchor(scrollContainer: Locator, rowId: string, expectedOffsetTop: number) {
  await expect.poll(async () => await scrollContainer.evaluate((element, anchor) => {
    const row = Array.from(element.querySelectorAll<HTMLElement>('[data-timeline-row-id]'))
      .find((candidate) => candidate.dataset.timelineRowId === anchor.rowId);
    if (!row) return Number.POSITIVE_INFINITY;
    const offsetTop = row.getBoundingClientRect().top - element.getBoundingClientRect().top;
    return Math.abs(offsetTop - anchor.expectedOffsetTop);
  }, { rowId, expectedOffsetTop }), { timeout: 10_000 }).toBeLessThanOrEqual(4);
}

async function installGatedTranscriptPage(app: ElectronApplication, messages: unknown[]): Promise<void> {
  await app.evaluate(async ({ app: _app }, transcriptMessages) => {
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
    let releasePage!: () => void;
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    (globalThis as typeof globalThis & { __releaseClawXTranscriptPage?: () => void })
      .__releaseClawXTranscriptPage = releasePage;

    ipcMain.removeHandler('hostapi:fetch');
    ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string }) => {
      if (request.path?.startsWith('/api/sessions/transcript?')) {
        await pageGate;
        return {
          ok: true,
          data: { status: 200, ok: true, json: { messages: transcriptMessages } },
        };
      }
      return { ok: true, data: { status: 200, ok: true, json: {} } };
    });
  }, messages);
}

async function releaseTranscriptPage(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const target = globalThis as typeof globalThis & { __releaseClawXTranscriptPage?: () => void };
    target.__releaseClawXTranscriptPage?.();
    delete target.__releaseClawXTranscriptPage;
  });
}

test.describe('ClawX Timeline scroll contract', () => {
  test('opens an equal-length session at its latest row instead of inheriting scrollTop', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installSessionSwitchMocks(app, {
        [SESSION_KEY]: plainHistory(40, 'Primary'),
        [SECOND_SESSION_KEY]: plainHistory(40, 'Secondary'),
      });
      const page = await openTimeline(app);
      await expect(page.getByText('Primary response 40', { exact: true })).toBeVisible({ timeout: 30_000 });

      const directoryToggle = page.getByTestId('chat-question-directory-toggle');
      await expect(directoryToggle).toBeEnabled();
      await directoryToggle.click();
      await page.getByTestId('chat-question-directory-item-0').click();
      const firstPrimaryTurn = page.getByTestId('conversation-turn').filter({
        has: page.getByText('Primary question 1', { exact: true }),
      });
      await expect(firstPrimaryTurn).toBeInViewport();
      await directoryToggle.click();
      await expect(page.getByTestId('chat-scroll-to-latest')).toBeVisible();

      await page.getByTestId(`sidebar-session-${SECOND_SESSION_KEY}`).click();
      await expect(page.getByText('Secondary response 40', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => Math.round((await scrollMetrics(page.getByTestId('chat-scroll-container'))).distanceFromBottom))
        .toBeLessThanOrEqual(12);
      await expect(page.getByTestId('chat-scroll-to-latest')).toBeHidden();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('opens a shorter killed single-turn history after an error, compaction, and final reply', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installSessionSwitchMocks(app, {
        [SESSION_KEY]: plainHistory(40, 'Primary'),
        [SECOND_SESSION_KEY]: compactedKilledHistory(),
      }, { secondStatus: 'killed', abortedLastRun: true });
      const page = await openTimeline(app);
      await expect(page.getByText('Primary response 40', { exact: true })).toBeVisible({ timeout: 30_000 });

      const directoryToggle = page.getByTestId('chat-question-directory-toggle');
      await directoryToggle.click();
      await page.getByTestId('chat-question-directory-item-0').click();
      const firstPrimaryTurn = page.getByTestId('conversation-turn').filter({
        has: page.getByText('Primary question 1', { exact: true }),
      });
      await expect(firstPrimaryTurn).toBeInViewport();
      await directoryToggle.click();
      await expect(page.getByTestId('chat-scroll-to-latest')).toBeVisible();

      await page.getByTestId(`sidebar-session-${SECOND_SESSION_KEY}`).click();
      const timeline = page.getByTestId('conversation-timeline');
      await expect(timeline).toHaveAttribute('data-turn-count', '1', { timeout: 30_000 });
      await expect(page.getByText('The agent run failed before producing a reply.', { exact: true })).toBeVisible();
      await expect(page.getByText('Compacted final answer after retry.', { exact: true })).toBeVisible();
      await expect.poll(async () => Math.round((await scrollMetrics(page.getByTestId('chat-scroll-container'))).distanceFromBottom))
        .toBeLessThanOrEqual(12);
      await expect(page.getByTestId('chat-scroll-to-latest')).toBeHidden();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('does not pull a detached reader to new content and restores follow at the bottom', async ({ launchElectronApp }, testInfo) => {
    const history = plainHistory(40, 'Follow');
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installChatMocks(app, history);
      const page = await openTimeline(app);
      await expect(page.getByText('Follow response 40', { exact: true })).toBeVisible({ timeout: 30_000 });

      const scrollContainer = page.getByTestId('chat-scroll-container');
      await scrollContainer.evaluate((element) => {
        element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 420);
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      const jumpButton = page.getByTestId('chat-scroll-to-latest');
      await expect(jumpButton).toBeVisible();
      const beforeAppend = await scrollMetrics(scrollContainer);

      await page.getByTestId('chat-composer-input').fill('New content while detached');
      await page.getByTestId('chat-composer-send').click();
      await expect.poll(async () => (await scrollMetrics(scrollContainer)).scrollHeight)
        .toBeGreaterThan(beforeAppend.scrollHeight);

      const afterAppend = await scrollMetrics(scrollContainer);
      expect(Math.abs(afterAppend.scrollTop - beforeAppend.scrollTop)).toBeLessThanOrEqual(4);
      expect(afterAppend.distanceFromBottom).toBeGreaterThan(12);
      await expect(jumpButton).toBeVisible();
      const detachedScreenshotPath = testInfo.outputPath('timeline-detached-new-content.png');
      await page.getByTestId('chat-page').screenshot({ path: detachedScreenshotPath });
      await testInfo.attach('timeline-detached-new-content', {
        path: detachedScreenshotPath,
        contentType: 'image/png',
      });

      await scrollContainer.hover();
      await page.mouse.wheel(0, 100_000);
      await expect.poll(async () => Math.round((await scrollMetrics(scrollContainer)).distanceFromBottom))
        .toBeLessThanOrEqual(12);
      await expect(jumpButton).toBeHidden({ timeout: 10_000 });
      await expect(page.getByText('New content while detached', { exact: true })).toBeVisible();

      await emitRuntimeEvents(app, [{
        type: 'assistant.delta',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        text: Array.from({ length: 12 }, (_, index) => `Follow-up line ${index + 1}`).join('\n\n'),
        replace: true,
        ts: Date.now(),
      }]);
      await expect.poll(async () => Math.round((await scrollMetrics(scrollContainer)).distanceFromBottom))
        .toBeLessThanOrEqual(12);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps the visible Turn and pixel offset stable while older history is prepended', async ({ launchElectronApp }) => {
    const fullHistory = plainHistory(100, 'Paged');
    const initialHistory = fullHistory.slice(-100);
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installChatMocks(app, initialHistory);
      const page = await openTimeline(app);
      await expect(page.getByText('Paged response 100', { exact: true })).toBeVisible({ timeout: 30_000 });
      await installGatedTranscriptPage(app, fullHistory);

      const scrollContainer = page.getByTestId('chat-scroll-container');
      await scrollContainer.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      const loadButton = page.getByTestId('chat-load-more-history');
      await expect(loadButton).toBeVisible();
      await loadButton.evaluate((element: HTMLButtonElement) => {
        if (!element.disabled) element.click();
      });
      await expect(loadButton).toBeDisabled();
      const anchor = await firstVisibleTimelineRow(scrollContainer);

      await releaseTranscriptPage(app);
      await expect(loadButton).toBeEnabled({ timeout: 10_000 });
      await expect.poll(async () => (await scrollMetrics(scrollContainer)).scrollTop, { timeout: 10_000 })
        .toBeGreaterThan(500);
      await expectTimelineRowAnchor(scrollContainer, anchor.rowId, anchor.offsetTop);

      await scrollContainer.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      await expect(page.getByText('Paged question 1', { exact: true })).toBeVisible({ timeout: 10_000 });
    } finally {
      await closeElectronApp(app);
    }
  });

  test('compensates expand and collapse measurements above the viewport', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installChatMocks(app, expandableHistory());
      const page = await openTimeline(app);
      await expect(page.getByText('Dynamic response 20', { exact: true })).toBeVisible({ timeout: 30_000 });

      const scrollContainer = page.getByTestId('chat-scroll-container');
      await scrollContainer.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      const toggle = page.getByTestId('timeline-tool-group-toggle');
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(page.getByTestId('timeline-tool-details')).toBeVisible();
      const expandableRowId = await toggle.evaluate((element) => (
        element.closest<HTMLElement>('[data-timeline-row-id]')?.dataset.timelineRowId ?? ''
      ));
      expect(expandableRowId).not.toBe('');

      await scrollContainer.evaluate((element, rowId) => {
        const expandableRow = Array.from(element.querySelectorAll<HTMLElement>('[data-timeline-row-id]'))
          .find((candidate) => candidate.dataset.timelineRowId === rowId);
        if (!expandableRow) throw new Error('Expandable row is not mounted');
        const distancePastRow = expandableRow.getBoundingClientRect().bottom - element.getBoundingClientRect().top + 40;
        element.scrollTop += distancePastRow;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      }, expandableRowId);
      await expect(page.getByTestId('chat-scroll-to-latest')).toBeVisible();
      await expect(toggle).toHaveCount(1);
      const anchor = await firstVisibleTimelineRow(scrollContainer);
      expect(anchor.rowId).not.toBe(expandableRowId);

      await toggle.evaluate((element: HTMLButtonElement) => element.click());
      await expect(page.getByTestId('timeline-tool-details')).toHaveCount(0);
      await expectTimelineRowAnchor(scrollContainer, anchor.rowId, anchor.offsetTop);

      await toggle.evaluate((element: HTMLButtonElement) => element.click());
      await expect(page.getByTestId('timeline-tool-details')).toBeVisible();
      await expectTimelineRowAnchor(scrollContainer, anchor.rowId, anchor.offsetTop);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps the detached row anchor stable while an earlier media preview resolves', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    let releaseMedia = () => {};

    try {
      await installChatMocks(app, dynamicMediaHistory());
      const mediaGate = new Promise<void>((resolveGate) => {
        releaseMedia = resolveGate;
      });
      let markMediaRequested!: () => void;
      const mediaRequested = new Promise<void>((resolveRequest) => {
        markMediaRequested = resolveRequest;
      });
      const routedPage = await getStableWindow(app);
      await routedPage.route(DYNAMIC_MEDIA_URL, async (route) => {
        markMediaRequested();
        await mediaGate;
        await route.fulfill({ path: DYNAMIC_MEDIA_PATH, contentType: 'image/png' });
      });
      const page = await openTimeline(app, 'domcontentloaded');
      await expect(page.getByText('Media response 20', { exact: true })).toBeVisible({ timeout: 30_000 });
      const scrollContainer = page.getByTestId('chat-scroll-container');
      await scrollContainer.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      const mediaText = page.getByText('Delayed media preview', { exact: true });
      await expect(mediaText).toBeVisible({ timeout: 10_000 });
      await mediaRequested;
      await expect(page.getByTestId('chat-image-preview-card')).toHaveCount(1);

      const mediaTurnId = await mediaText.evaluate((element) => (
        element.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId ?? ''
      ));
      expect(mediaTurnId).not.toBe('');
      await scrollContainer.evaluate((element, turnId) => {
        const turnRows = Array.from(element.querySelectorAll<HTMLElement>('[data-turn-id]'))
          .filter((candidate) => candidate.dataset.turnId === turnId);
        if (turnRows.length === 0) throw new Error('Dynamic media Turn is not mounted');
        const scrollerTop = element.getBoundingClientRect().top;
        const turnBottom = Math.max(...turnRows.map((row) => row.getBoundingClientRect().bottom));
        element.scrollTop += turnBottom - scrollerTop + 40;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      }, mediaTurnId);
      await expect(page.getByTestId('chat-scroll-to-latest')).toBeVisible();
      const anchor = await firstVisibleTimelineRow(scrollContainer, mediaTurnId);

      releaseMedia();
      const preview = page.getByTestId('chat-image-preview-card').first();
      await expect(preview).toBeVisible({ timeout: 10_000 });
      await expect.poll(async () => preview.locator('img').evaluate((image: HTMLImageElement) => (
        image.complete && image.naturalHeight > 0 ? image.getBoundingClientRect().height : 0
      )), { timeout: 10_000 }).toBeGreaterThan(300);
      await expectTimelineRowAnchor(scrollContainer, anchor.rowId, anchor.offsetTop);
    } finally {
      releaseMedia();
      await closeElectronApp(app);
    }
  });
});
