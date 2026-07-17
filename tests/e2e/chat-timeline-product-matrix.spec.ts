import type { ElectronApplication, Page } from '@playwright/test';
import type { ChatRuntimeEvent } from '../../shared/chat-runtime-events';
import { CHAT_SEND_OUTBOX_SCHEMA_VERSION, type ChatSendOutboxItem } from '../../shared/chat-send-outbox';
import type { RawMessage } from '../../src/stores/chat/types';
import { createTurnId } from '../../src/stores/conversation/identity';
import {
  closeElectronApp,
  emitIpcEvent,
  expect,
  getStableWindow,
  installIpcMocks,
  test,
} from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const RUN_ID = 'run-product-matrix';
const EXTERNAL_RUN_ID = 'run-product-matrix-external';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(',')}}`;
}

type ProductMatrixMockOptions = {
  history?: RawMessage[];
  transcript?: RawMessage[];
  hasActiveRun?: boolean;
  status?: string;
  captureHostApiRequests?: boolean;
  outboxItems?: ChatSendOutboxItem[];
};

/** Install a local-only OpenClaw surface for Product Matrix Timeline scenarios. */
async function installProductMatrixMocks(
  app: ElectronApplication,
  options: ProductMatrixMockOptions = {},
): Promise<void> {
  const history = options.history ?? [];
  const session = {
    key: SESSION_KEY,
    displayName: 'main',
    status: options.status ?? (options.hasActiveRun ? 'running' : 'done'),
    hasActiveRun: options.hasActiveRun ?? false,
  };
  const historyResult = {
    messages: history,
    sessionInfo: {
      status: session.status,
      hasActiveRun: session.hasActiveRun,
    },
  };
  const sessionResult = { sessions: [session] };
  const response = (json: unknown) => ({
    ok: true,
    data: { status: 200, ok: true, json },
  });

  await installIpcMocks(app, {
    captureHostApiRequests: options.captureHostApiRequests,
    gatewayStatus: { state: 'running', port: 18789, pid: 41001, gatewayReady: true },
    gatewayRpc: {
      [stableStringify(['sessions.list', null])]: {
        success: true,
        result: sessionResult,
      },
      [stableStringify(['chat.history', null])]: {
        success: true,
        result: historyResult,
      },
      [stableStringify(['chat.send', null])]: {
        success: true,
        result: { runId: RUN_ID },
      },
    },
    hostApi: {
      [stableStringify(['/api/settings', 'GET'])]: response({ devModeUnlocked: false }),
      [stableStringify(['/api/gateway/status', 'GET'])]: response({
        state: 'running',
        port: 18789,
        pid: 41001,
        gatewayReady: true,
      }),
      [stableStringify(['/api/chat/sessions', 'GET'])]: response({
        success: true,
        result: sessionResult,
      }),
      [stableStringify(['/api/chat/history', 'POST'])]: response({
        success: true,
        result: historyResult,
      }),
      [stableStringify(['/api/chat/outbox', 'GET'])]: response({
        success: true,
        durable: true,
        items: options.outboxItems ?? [],
        rejected: [],
      }),
      [stableStringify([`/api/sessions/transcript?sessionKey=${encodeURIComponent(SESSION_KEY)}&limit=200`, 'GET'])]: response({
        messages: options.transcript ?? [],
      }),
      [stableStringify(['/api/chat/send', 'POST'])]: response({
        success: true,
        result: { runId: RUN_ID },
      }),
      [stableStringify([`/api/task-bridge/tasks?activeOnly=false&sessionKey=${encodeURIComponent(SESSION_KEY)}`, 'GET'])]: response({
        success: true,
        tasks: [],
      }),
      [stableStringify(['/api/files/thumbnails', 'POST'])]: response({}),
      [stableStringify(['/api/agents', 'GET'])]: response({
        success: true,
        agents: [{ id: 'main', name: 'Main' }],
      }),
    },
  });
}

function matrixOutboxItem(prompt: string, acceptedAt = Date.now()): ChatSendOutboxItem {
  const idempotencyKey = 'matrix-durable-outbox-intent';
  return {
    version: CHAT_SEND_OUTBOX_SCHEMA_VERSION,
    id: idempotencyKey,
    sessionKey: SESSION_KEY,
    turnId: createTurnId({ sessionKey: SESSION_KEY, idempotencyKey }),
    idempotencyKey,
    userMessageId: 'matrix-durable-outbox-user',
    acceptedAt,
    expiresAt: acceptedAt + 60_000,
    text: prompt,
    mode: 'chat',
    attachments: [],
    referenceImages: [],
  };
}

/** Read Main-captured Host API requests for transport-level assertions. */
async function capturedHostApiRequests(
  app: ElectronApplication,
): Promise<Array<{ path?: string; method?: string; body?: string }>> {
  return await app.evaluate(() => {
    const requests = (globalThis as Record<string, unknown>).__clawxE2EHostApiRequests;
    return Array.isArray(requests) ? requests : [];
  });
}

/** Hold a real workspace mutation so an external run can win the session slot. */
async function installQueuedSendRaceControls(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ app: _app }) => {
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
    type QueueRaceControl = {
      workspacePatchStarted: boolean;
      releaseWorkspacePatch: () => void;
    };
    let releaseWorkspacePatch = () => {};
    const workspacePatchGate = new Promise<void>((resolve) => {
      releaseWorkspacePatch = resolve;
    });
    const control: QueueRaceControl = {
      workspacePatchStarted: false,
      releaseWorkspacePatch,
    };
    (globalThis as typeof globalThis & { __clawxE2EQueueRace?: QueueRaceControl }).__clawxE2EQueueRace = control;

    ipcMain.removeHandler('dialog:open');
    ipcMain.handle('dialog:open', async (_event: unknown, options: { properties?: string[] } = {}) => {
      if (options.properties?.includes('openDirectory')) {
        return { canceled: false, filePaths: ['/tmp/queued-workspace'] };
      }
      return { canceled: true, filePaths: [] };
    });

    ipcMain.removeHandler('gateway:rpc');
    ipcMain.handle('gateway:rpc', async (_event: unknown, method: string, params: unknown) => {
      if (method === 'sessions.patch') {
        const request = params as { key?: string; cwd?: string | null };
        if ('cwd' in request) {
          control.workspacePatchStarted = true;
          await workspacePatchGate;
          return {
            success: true,
            result: {
              ok: true,
              key: request.key ?? 'agent:main:main',
              entry: { cwd: request.cwd ?? null },
            },
          };
        }
      }
      if (method === 'sessions.list') {
        return {
          success: true,
          result: {
            sessions: [{ key: 'agent:main:main', displayName: 'main', status: 'done', hasActiveRun: false }],
          },
        };
      }
      if (method === 'chat.history') {
        return {
          success: true,
          result: {
            messages: [],
            sessionInfo: { status: 'done', hasActiveRun: false },
          },
        };
      }
      if (method === 'chat.send') {
        return { success: true, result: { runId: 'run-product-matrix-queued-send' } };
      }
      return { success: true, result: {} };
    });
  });
}

async function waitForWorkspacePatch(app: ElectronApplication): Promise<void> {
  await expect.poll(async () => await app.evaluate(() => (
    (globalThis as typeof globalThis & {
      __clawxE2EQueueRace?: { workspacePatchStarted?: boolean };
    }).__clawxE2EQueueRace?.workspacePatchStarted === true
  ))).toBe(true);
}

async function releaseWorkspacePatch(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    (globalThis as typeof globalThis & {
      __clawxE2EQueueRace?: { releaseWorkspacePatch?: () => void };
    }).__clawxE2EQueueRace?.releaseWorkspacePatch?.();
  });
}

/** Reload after Main mocks are installed and wait for the canonical renderer. */
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
  await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
  return page;
}

/** Deliver structured runtime evidence through the same preload event channel as Main. */
async function emitRuntimeEvents(
  app: ElectronApplication,
  events: ChatRuntimeEvent[],
): Promise<void> {
  for (const event of events) {
    await emitIpcEvent(app, 'chat:runtime-event', event);
  }
}

/** Assert that an ordinary direct answer has no fabricated process projection. */
async function expectNoFabricatedProcess(page: Page): Promise<void> {
  await expect(page.getByTestId('timeline-plan')).toHaveCount(0);
  await expect(page.getByTestId('timeline-tool-group')).toHaveCount(0);
  await expect(page.getByTestId('timeline-subtasks')).toHaveCount(0);
  await expect(page.getByTestId('timeline-execution-details')).toHaveCount(0);
  await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
}

/** Assert one settled Turn and one final answer after live/history convergence. */
async function expectSettledDirectTurn(
  page: Page,
  prompt: string,
  finalText: string,
): Promise<void> {
  const turn = page.getByTestId('conversation-turn');
  await expect(turn).toHaveCount(1);
  await expect(turn).toHaveAttribute('data-turn-status', 'completed');
  await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);
  await expect(page.getByText(finalText, { exact: true })).toHaveCount(1);
  await expect(page.getByTestId('timeline-turn-status')).toHaveCount(0);
  await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Send|发送/u);
  await expectNoFabricatedProcess(page);
}

/** Assert replayed terminal parent/child tasks remain one settled owning Turn. */
async function expectTerminalSubagentReplay(
  page: Page,
  prompt: string,
  finalText: string,
): Promise<void> {
  await expect(page.getByTestId('conversation-turn')).toHaveCount(1);
  await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);
  await expect(page.getByText(finalText, { exact: true })).toHaveCount(1);
  const subtasks = page.getByTestId('timeline-subtasks');
  await expect(subtasks).toHaveCount(2);
  await expect(subtasks.first()).toHaveAttribute('data-status', 'completed');
  await expect(subtasks.nth(1)).toHaveAttribute('data-status', 'completed');

  const toggles = page.getByTestId('timeline-subtasks-toggle');
  await expect(toggles).toHaveCount(2);
  for (let index = 0; index < await toggles.count(); index += 1) {
    if (await toggles.nth(index).getAttribute('aria-expanded') !== 'true') {
      await toggles.nth(index).click();
    }
  }
  const details = page.getByTestId('timeline-subtask-details');
  await expect(details).toHaveCount(2);
  await expect(details.filter({ hasText: 'Coordinate matrix research' })).toHaveCount(1);
  await expect(details.filter({ hasText: 'Inspect matrix evidence' })).toHaveCount(1);
  await expect(details.filter({ hasText: /Running|执行中/u })).toHaveCount(0);

  await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);
  await page.getByTestId('timeline-execution-details').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const parent = dialog.locator('[data-testid="chat-execution-step"][data-task-id="matrix-parent"]')
    .filter({ hasText: 'Coordinate matrix research' });
  const child = dialog.locator('[data-testid="chat-execution-step"][data-task-id="matrix-child"]')
    .filter({ hasText: 'Inspect matrix evidence' });
  await expect(parent).toHaveAttribute('data-step-status', 'completed');
  await expect(child).toHaveAttribute('data-step-status', 'completed');
  await expect(child).toHaveAttribute('data-parent-id', 'plan-step:task:matrix-parent');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Send|发送/u);
}

test.describe('Codex Timeline Product Matrix', () => {
  test('keeps ordinary direct chat as one final with no fabricated process in live and history', async ({ launchElectronApp }) => {
    const prompt = 'Answer this ordinary question directly.';
    const finalText = 'This is one direct answer without a fabricated workflow.';
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installProductMatrixMocks(app);
      const page = await openTimeline(app);

      // Deliver the ordinary answer through live chat/runtime evidence.
      await page.getByTestId('chat-composer-input').fill(prompt);
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Stop|停止/u);
      await emitRuntimeEvents(app, [{
        type: 'run.started',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 1,
        startedAt: Date.now(),
        ts: Date.now(),
      }]);
      const timestamp = Date.now() / 1_000;
      await emitIpcEvent(app, 'gateway:chat-message', {
        message: {
          state: 'final',
          runId: RUN_ID,
          sessionKey: SESSION_KEY,
          seq: 2,
          message: {
            role: 'assistant',
            id: 'matrix-direct-live-final',
            timestamp,
            content: finalText,
          },
        },
      });
      await expect(page.getByText(finalText, { exact: true })).toHaveCount(1);

      const history: RawMessage[] = [{
        id: 'matrix-direct-history-user',
        role: 'user',
        content: prompt,
        timestamp: timestamp - 1,
      }, {
        id: 'matrix-direct-history-final',
        role: 'assistant',
        content: finalText,
        timestamp,
      }];

      // Terminal history becomes available before lifecycle completion refreshes it.
      await installProductMatrixMocks(app, { history, hasActiveRun: false });
      await emitRuntimeEvents(app, [{
        type: 'run.ended',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 3,
        status: 'completed',
        endedAt: Date.now(),
        ts: Date.now(),
      }]);
      await expectSettledDirectTurn(page, prompt, finalText);
      const liveTurnId = await page.getByTestId('conversation-turn').getAttribute('data-turn-id');

      // Manual history replay must preserve the same Turn and exactly one final.
      await page.getByRole('button', { name: /Refresh|刷新/u }).click();
      await expectSettledDirectTurn(page, prompt, finalText);
      await expect(page.getByTestId('conversation-turn')).toHaveAttribute('data-turn-id', liveTurnId!);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps successful live parent and child subagents terminal across history replay', async ({ launchElectronApp }) => {
    const prompt = 'Coordinate a successful delegated matrix check.';
    const finalText = 'The parent and child delegated checks completed successfully.';
    const timestamp = Math.floor(Date.now() / 1_000);
    const history: RawMessage[] = [{
      id: 'matrix-subagent-user',
      role: 'user',
      content: prompt,
      timestamp,
    }, {
      id: 'matrix-parent-terminal',
      role: 'user',
      content: [{
        type: 'task_completion',
        taskId: 'matrix-parent',
        runId: RUN_ID,
        runtime: 'subagent',
        title: 'Coordinate matrix research',
        taskStatus: 'completed',
        status: 'completed',
        childSessionKey: 'agent:coordinator:matrix-parent',
        updatedAt: (timestamp + 1) * 1_000,
      }],
      timestamp: timestamp + 1,
    }, {
      id: 'matrix-child-terminal',
      role: 'user',
      content: [{
        type: 'task_completion',
        taskId: 'matrix-child',
        parentTaskId: 'matrix-parent',
        runId: 'run-product-matrix-child',
        runtime: 'subagent',
        title: 'Inspect matrix evidence',
        taskStatus: 'completed',
        status: 'completed',
        childSessionKey: 'agent:researcher:matrix-child',
        updatedAt: (timestamp + 2) * 1_000,
      }],
      timestamp: timestamp + 2,
    }, {
      id: 'matrix-subagent-final',
      role: 'assistant',
      content: finalText,
      timestamp: timestamp + 3,
    }];
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installProductMatrixMocks(app);
      let page = await openTimeline(app);

      // Native live task facts establish parent/child ownership in one Turn.
      await page.getByTestId('chat-composer-input').fill(prompt);
      await page.getByTestId('chat-composer-send').click();
      const now = Date.now();
      const parentTask = {
        taskId: 'matrix-parent',
        flowId: 'matrix-flow',
        kind: 'orchestration',
        runtime: 'subagent',
        title: 'Coordinate matrix research',
        childSessionKey: 'agent:coordinator:matrix-parent',
      };
      const childTask = {
        taskId: 'matrix-child',
        parentTaskId: 'matrix-parent',
        flowId: 'matrix-flow',
        kind: 'research',
        runtime: 'subagent',
        title: 'Inspect matrix evidence',
        childSessionKey: 'agent:researcher:matrix-child',
      };
      await emitRuntimeEvents(app, [{
        type: 'run.started',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 1,
        startedAt: now,
        ts: now,
      }, {
        type: 'task.updated',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        taskId: 'matrix-parent',
        seq: 2,
        task: { ...parentTask, status: 'running', updatedAt: now + 1 },
        ts: now + 1,
      }, {
        type: 'task.updated',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        taskId: 'matrix-child',
        parentTaskId: 'matrix-parent',
        seq: 3,
        task: { ...childTask, status: 'running', updatedAt: now + 2 },
        ts: now + 2,
      }]);

      await expect(page.getByTestId('conversation-turn')).toHaveCount(1);
      await expect(page.getByTestId('timeline-subtasks')).toHaveCount(2);
      const liveTurnId = await page.getByTestId('conversation-turn').getAttribute('data-turn-id');
      const idempotencyKey = liveTurnId?.split(':').slice(2).join(':');
      expect(idempotencyKey).toEqual(expect.any(String));
      history[0] = { ...history[0], idempotencyKey };
      await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);
      await page.getByTestId('timeline-execution-details').click();
      let dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const liveParent = dialog.locator('[data-testid="chat-execution-step"][data-task-id="matrix-parent"]')
        .filter({ hasText: 'Coordinate matrix research' });
      const liveChild = dialog.locator('[data-testid="chat-execution-step"][data-task-id="matrix-child"]')
        .filter({ hasText: 'Inspect matrix evidence' });
      await expect(liveParent).toHaveAttribute('data-step-status', 'running');
      await expect(liveChild).toHaveAttribute('data-step-status', 'running');
      await expect(liveChild).toHaveAttribute('data-parent-id', 'plan-step:task:matrix-parent');
      await page.keyboard.press('Escape');

      // Both tasks and the owning run settle before terminal history refresh.
      await emitRuntimeEvents(app, [{
        type: 'task.updated',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        taskId: 'matrix-child',
        parentTaskId: 'matrix-parent',
        seq: 4,
        task: {
          ...childTask,
          status: 'completed',
          deliveryStatus: 'delivered',
          terminalOutcome: 'succeeded',
          updatedAt: now + 3,
          endedAt: now + 3,
        },
        ts: now + 3,
      }, {
        type: 'task.updated',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        taskId: 'matrix-parent',
        seq: 5,
        task: {
          ...parentTask,
          status: 'completed',
          deliveryStatus: 'delivered',
          terminalOutcome: 'succeeded',
          updatedAt: now + 4,
          endedAt: now + 4,
        },
        ts: now + 4,
      }]);
      await emitIpcEvent(app, 'gateway:chat-message', {
        message: {
          state: 'final',
          runId: RUN_ID,
          sessionKey: SESSION_KEY,
          seq: 6,
          message: {
            role: 'assistant',
            id: 'matrix-subagent-live-final',
            timestamp: timestamp + 3,
            content: finalText,
          },
        },
      });
      await installProductMatrixMocks(app, { history, hasActiveRun: false });
      await emitRuntimeEvents(app, [{
        type: 'run.ended',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 7,
        status: 'completed',
        endedAt: now + 5,
        ts: now + 5,
      }]);
      await expectTerminalSubagentReplay(page, prompt, finalText);
      const initialTurnId = await page.getByTestId('conversation-turn').getAttribute('data-turn-id');

      // A renderer restart replays the same terminal task facts from history.
      page = await openTimeline(app);
      await expectTerminalSubagentReplay(page, prompt, finalText);
      await expect(page.getByTestId('conversation-turn')).toHaveAttribute('data-turn-id', initialTurnId!);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps queued execution work in one owning Turn through terminal history replay', async ({ launchElectronApp }) => {
    const prompt = 'Run this queued matrix task in order.';
    const finalText = 'The queued matrix task completed once.';
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installProductMatrixMocks(app);
      const page = await openTimeline(app);
      await page.getByTestId('chat-composer-input').fill(prompt);
      await page.getByTestId('chat-composer-send').click();

      const now = Date.now();
      const task = {
        taskId: 'matrix-queued-task',
        flowId: 'matrix-queue-flow',
        kind: 'execution',
        runtime: 'openclaw',
        title: 'Queued matrix execution',
      };
      await emitRuntimeEvents(app, [{
        type: 'run.started',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 1,
        startedAt: now,
        ts: now,
      }, {
        type: 'task.updated',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        taskId: task.taskId,
        seq: 2,
        task: {
          ...task,
          status: 'pending',
          sourceStatus: 'queued',
          updatedAt: now + 1,
        },
        ts: now + 1,
      }]);

      const turn = page.getByTestId('conversation-turn');
      const subtasks = page.getByTestId('timeline-subtasks');
      await expect(turn).toHaveCount(1);
      await expect(turn).toHaveAttribute('data-turn-status', 'running');
      await expect(subtasks).toHaveCount(1);
      await expect(subtasks).toHaveAttribute('data-status', 'running');
      await page.getByTestId('timeline-subtasks-toggle').click();
      const details = page.getByTestId('timeline-subtask-details');
      await expect(details.locator(':scope > div')).toHaveCount(1);
      await expect(details).toContainText('Queued matrix execution');

      await emitRuntimeEvents(app, [{
        type: 'task.updated',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        taskId: task.taskId,
        seq: 3,
        task: {
          ...task,
          status: 'running',
          sourceStatus: 'running',
          updatedAt: now + 2,
        },
        ts: now + 2,
      }]);
      await expect(turn).toHaveCount(1);
      await expect(subtasks).toHaveCount(1);
      await expect(details.locator(':scope > div')).toHaveCount(1);

      await emitRuntimeEvents(app, [{
        type: 'task.updated',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        taskId: task.taskId,
        seq: 4,
        task: {
          ...task,
          status: 'completed',
          sourceStatus: 'completed',
          deliveryStatus: 'delivered',
          terminalOutcome: 'succeeded',
          updatedAt: now + 3,
          endedAt: now + 3,
        },
        ts: now + 3,
      }]);
      await expect(subtasks).toHaveCount(1);
      await expect(subtasks).toHaveAttribute('data-status', 'completed');

      const timestamp = now / 1_000;
      const liveTurnId = await turn.getAttribute('data-turn-id');
      const idempotencyKey = liveTurnId?.split(':').slice(2).join(':');
      const history: RawMessage[] = [{
        id: 'matrix-queue-user',
        role: 'user',
        content: prompt,
        timestamp: timestamp - 1,
        idempotencyKey,
      }, {
        id: 'matrix-queue-task-terminal',
        role: 'user',
        content: [{
          type: 'task_completion',
          taskId: task.taskId,
          runId: RUN_ID,
          runtime: task.runtime,
          title: task.title,
          taskStatus: 'completed',
          status: 'completed',
          updatedAt: now + 3,
        }],
        timestamp: timestamp + 1,
      }, {
        id: 'matrix-queue-final',
        role: 'assistant',
        content: finalText,
        timestamp: timestamp + 2,
      }];
      await emitIpcEvent(app, 'gateway:chat-message', {
        message: {
          state: 'final',
          runId: RUN_ID,
          sessionKey: SESSION_KEY,
          seq: 5,
          message: history[2],
        },
      });
      await installProductMatrixMocks(app, { history, hasActiveRun: false });
      await emitRuntimeEvents(app, [{
        type: 'run.ended',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 6,
        status: 'completed',
        endedAt: now + 4,
        ts: now + 4,
      }]);

      await expect(turn).toHaveCount(1);
      await expect(turn).toHaveAttribute('data-turn-status', 'completed');
      await expect(page.getByText(finalText, { exact: true })).toHaveCount(1);
      await expect(subtasks).toHaveCount(1);
      await expect(subtasks).toHaveAttribute('data-status', 'completed');
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Send|发送/u);

      await page.getByRole('button', { name: /Refresh|刷新/u }).click();
      await expect(turn).toHaveCount(1);
      await expect(turn).toHaveAttribute('data-turn-id', liveTurnId!);
      await expect(turn).toHaveAttribute('data-turn-status', 'completed');
      await expect(page.getByText(finalText, { exact: true })).toHaveCount(1);
      await expect(subtasks).toHaveCount(1);
      await expect(subtasks).toHaveAttribute('data-status', 'completed');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('serializes a user send that races an external same-session run and preserves its media intent', async ({ launchElectronApp }) => {
    const queuedPrompt = 'Render the queued video exactly once with the selected settings.';
    const followUpPrompt = 'Keep this follow-up queued until the video Turn finishes.';
    const externalFinal = 'The external matrix Turn is complete.';
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installProductMatrixMocks(app, { captureHostApiRequests: true });
      await installQueuedSendRaceControls(app);
      const page = await openTimeline(app);

      // Prepare the complete queued intent through public composer controls.
      await page.getByTestId('chat-composer-mode-video').click();
      await page.getByTestId('chat-video-size').selectOption('1280x720');
      await page.getByTestId('chat-video-duration').selectOption('6');
      await page.getByTestId('chat-composer-input').fill(queuedPrompt);

      // Start a real session mutation and submit while the store is awaiting it.
      await page.getByRole('button', { name: /Workspace|工作空间/u }).click();
      await page.getByRole('button', { name: /Choose project folder|选择项目文件夹/u }).click();
      await waitForWorkspacePatch(app);
      await page.getByTestId('chat-composer-send').click();

      // A second accepted request can arrive before either asynchronous send
      // acquires the session run slot. It must remain behind the first intent.
      await page.getByTestId('chat-composer-mode-video').click();
      await page.getByTestId('chat-composer-input').fill(followUpPrompt);
      await page.getByTestId('chat-composer-send').click();

      // An external OpenClaw run can legitimately take the same session slot
      // before the user's pre-send mutation settles.
      await emitIpcEvent(app, 'gateway:chat-message', {
        message: {
          state: 'started',
          runId: EXTERNAL_RUN_ID,
          sessionKey: SESSION_KEY,
          seq: 1,
        },
      });
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Stop|停止/u);
      await releaseWorkspacePatch(app);

      // The user intent must stay local until authoritative idle releases it.
      await expect.poll(async () => (
        (await capturedHostApiRequests(app))
          .filter((request) => request.path === '/api/chat/send' || request.path === '/api/chat/send-with-media')
          .map((request) => request.path)
      )).toEqual([]);
      // The accepted local request is immediately visible as queued. The
      // external run still has no user/final evidence and remains invisible.
      const queuedTurn = page.getByTestId('conversation-turn').filter({ hasText: queuedPrompt });
      const followUpTurn = page.getByTestId('conversation-turn').filter({ hasText: followUpPrompt });
      await expect(page.getByTestId('conversation-turn')).toHaveCount(2);
      await expect(queuedTurn).toHaveCount(1);
      await expect(queuedTurn).toHaveAttribute('data-turn-status', 'queued');
      await expect(followUpTurn).toHaveCount(1);
      await expect(followUpTurn).toHaveAttribute('data-turn-status', 'queued');
      await expect(page.getByText(externalFinal, { exact: true })).toHaveCount(0);
      const queuedTurnId = await queuedTurn.getAttribute('data-turn-id');
      const followUpTurnId = await followUpTurn.getAttribute('data-turn-id');

      const finalPayload = {
        message: {
          state: 'final',
          runId: EXTERNAL_RUN_ID,
          sessionKey: SESSION_KEY,
          seq: 2,
          message: {
            id: 'matrix-send-queue-first-final',
            role: 'assistant',
            content: externalFinal,
            timestamp: Date.now() / 1_000,
          },
        },
      };

      // The final starts settlement; the mocked OpenClaw session row supplies authoritative idle.
      await emitIpcEvent(app, 'gateway:chat-message', finalPayload);
      await expect.poll(async () => (
        (await capturedHostApiRequests(app))
          .filter((request) => request.path === '/api/chat/send' || request.path === '/api/chat/send-with-media')
          .map((request) => request.path)
      )).toEqual(['/api/chat/send']);

      const turns = page.getByTestId('conversation-turn');
      await expect(turns.filter({ hasText: queuedPrompt })).toHaveCount(1);
      await expect(turns.filter({ hasText: queuedPrompt })).toHaveAttribute('data-turn-id', queuedTurnId!);
      await expect(turns.filter({ hasText: queuedPrompt })).toHaveAttribute('data-turn-status', 'running');
      await expect(turns.filter({ hasText: followUpPrompt })).toHaveCount(1);
      await expect(turns.filter({ hasText: followUpPrompt })).toHaveAttribute('data-turn-id', followUpTurnId!);
      await expect(turns.filter({ hasText: followUpPrompt })).toHaveAttribute('data-turn-status', 'queued');
      const sendRequests = (await capturedHostApiRequests(app))
        .filter((request) => request.path === '/api/chat/send' || request.path === '/api/chat/send-with-media');
      const queuedRequest = JSON.parse(sendRequests[0]?.body ?? '{}') as Record<string, unknown>;
      expect(queuedRequest).toMatchObject({
        sessionKey: SESSION_KEY,
        message: queuedPrompt,
        clientPreferences: {
          mode: 'video',
          video: {
            size: '1280x720',
            durationSeconds: 6,
          },
        },
      });

      // Duplicate terminal evidence cannot flush the already-dequeued intent twice.
      await emitIpcEvent(app, 'gateway:chat-message', finalPayload);
      await page.waitForTimeout(500);
      expect((await capturedHostApiRequests(app))
        .filter((request) => request.path === '/api/chat/send' || request.path === '/api/chat/send-with-media')
        .map((request) => request.path))
        .toEqual(['/api/chat/send']);
      await expect(turns.filter({ hasText: followUpPrompt })).toHaveAttribute('data-turn-status', 'queued');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('restores a durable queued send with its original Turn identity while the session is busy', async ({ launchElectronApp }) => {
    const prompt = 'Restore this durable intent without changing its Turn identity.';
    const outboxItem = matrixOutboxItem(prompt);
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installProductMatrixMocks(app, {
        captureHostApiRequests: true,
        hasActiveRun: true,
        status: 'running',
        outboxItems: [outboxItem],
      });
      const page = await openTimeline(app);
      const restoredTurn = page.getByTestId('conversation-turn').filter({ hasText: prompt });

      await expect(restoredTurn).toHaveCount(1);
      await expect(restoredTurn).toHaveAttribute('data-turn-id', outboxItem.turnId);
      await expect(restoredTurn).toHaveAttribute('data-turn-status', 'queued');
      expect((await capturedHostApiRequests(app))
        .filter((request) => request.path === '/api/chat/send' || request.path === '/api/chat/send-with-media'))
        .toEqual([]);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('acknowledges a durable intent already present in transcript without replaying it', async ({ launchElectronApp }) => {
    const prompt = 'This durable intent was already accepted before renderer restart.';
    const outboxItem = matrixOutboxItem(prompt);
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installProductMatrixMocks(app, {
        captureHostApiRequests: true,
        outboxItems: [outboxItem],
        transcript: [{
          role: 'user',
          id: 'persisted-outbox-user',
          idempotencyKey: outboxItem.idempotencyKey,
          content: prompt,
          timestamp: outboxItem.acceptedAt / 1_000,
        }],
      });
      const page = await openTimeline(app);

      await expect(page.getByTestId('conversation-turn')).toHaveCount(0);
      await expect.poll(async () => (
        (await capturedHostApiRequests(app)).map((request) => request.path)
      )).toContain(`/api/chat/outbox/${encodeURIComponent(outboxItem.id)}/ack`);
      expect((await capturedHostApiRequests(app))
        .filter((request) => request.path === '/api/chat/send' || request.path === '/api/chat/send-with-media'))
        .toEqual([]);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('converges one Turn after Gateway reconnect without duplicate final or ghost run', async ({ launchElectronApp }) => {
    const prompt = 'Keep this Turn stable across a reconnect.';
    const finalText = 'The reconnect delivered this final exactly once.';
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installProductMatrixMocks(app);
      const page = await openTimeline(app);

      // Start one local Turn, then lose Gateway transport while the run is active.
      await page.getByTestId('chat-composer-input').fill(prompt);
      await page.getByTestId('chat-composer-send').click();
      const startedAt = Date.now();
      const runStarted: ChatRuntimeEvent = {
        type: 'run.started',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 1,
        startedAt,
        ts: startedAt,
      };
      await emitRuntimeEvents(app, [runStarted]);
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Stop|停止/u);
      const initialTurnId = await page.getByTestId('conversation-turn').getAttribute('data-turn-id');
      await emitIpcEvent(app, 'gateway:status-changed', {
        state: 'error',
        port: 18789,
        pid: 41001,
        gatewayReady: false,
        error: 'fixture transport disconnected',
      });
      await emitIpcEvent(app, 'gateway:status-changed', {
        state: 'reconnecting',
        port: 18789,
        pid: 41001,
        gatewayReady: false,
        reconnectAttempts: 1,
      });

      const timestamp = Date.now() / 1_000;
      const history: RawMessage[] = [{
        id: 'matrix-reconnect-user',
        role: 'user',
        content: prompt,
        timestamp: timestamp - 1,
      }, {
        id: 'matrix-reconnect-final',
        role: 'assistant',
        content: finalText,
        timestamp,
      }];

      // Reconnect returns terminal history while transport retransmits the final.
      await installProductMatrixMocks(app, { history, hasActiveRun: false });
      await emitIpcEvent(app, 'gateway:status-changed', {
        state: 'running',
        port: 18789,
        pid: 41002,
        gatewayReady: true,
        connectedAt: Date.now(),
      });
      const finalPayload = {
        message: {
          state: 'final',
          runId: RUN_ID,
          sessionKey: SESSION_KEY,
          message: {
            role: 'assistant',
            id: 'matrix-reconnect-live-final',
            timestamp,
            content: finalText,
          },
        },
      };
      await emitIpcEvent(app, 'gateway:chat-message', finalPayload);
      await emitIpcEvent(app, 'gateway:chat-message', finalPayload);
      await emitRuntimeEvents(app, [{
        type: 'run.ended',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 3,
        status: 'completed',
        endedAt: Date.now(),
        ts: Date.now(),
      }]);

      // A late replay of the old start cannot resurrect a terminal Turn.
      await emitRuntimeEvents(app, [runStarted]);
      await expectSettledDirectTurn(page, prompt, finalText);
      await expect(page.getByTestId('conversation-turn')).toHaveAttribute('data-turn-id', initialTurnId!);
      await expect(page.getByTestId('timeline-error')).toHaveCount(0);

      await page.getByRole('button', { name: /Refresh|刷新/u }).click();
      await expectSettledDirectTurn(page, prompt, finalText);
      await expect(page.getByTestId('conversation-turn')).toHaveAttribute('data-turn-id', initialTurnId!);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('settles an interrupted Turn when recovery skips directly to a new running Gateway generation', async ({ launchElectronApp }) => {
    const prompt = 'Settle this interrupted Turn from backend truth.';
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installProductMatrixMocks(app);
      const page = await openTimeline(app);

      await page.getByTestId('chat-composer-input').fill(prompt);
      await page.getByTestId('chat-composer-send').click();
      const startedAt = Date.now();
      await emitRuntimeEvents(app, [{
        type: 'run.started',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 1,
        startedAt,
        ts: startedAt,
      }]);
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Stop|停止/u);
      const initialTurnId = await page.getByTestId('conversation-turn').getAttribute('data-turn-id');

      await installProductMatrixMocks(app, {
        captureHostApiRequests: true,
        history: [{
          id: 'matrix-reconnect-idle-user',
          role: 'user',
          content: prompt,
          timestamp: Date.now() / 1_000,
        }],
        hasActiveRun: false,
      });
      // Main can restart the Gateway before Renderer receives the intermediate
      // stopped/reconnecting events. The new process identity must still trigger
      // backend reconciliation for the interrupted Turn.
      await emitIpcEvent(app, 'gateway:status-changed', {
        state: 'running',
        port: 18789,
        pid: 41002,
        gatewayReady: true,
        connectedAt: Date.now(),
      });

      await expect.poll(async () => (
        (await capturedHostApiRequests(app)).map((request) => request.path)
      )).toContain('/api/chat/sessions');
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Send|发送/u);
      await expect(page.getByTestId('conversation-turn')).toHaveCount(1);
      await expect(page.getByTestId('conversation-turn')).toHaveAttribute('data-turn-id', initialTurnId!);
      await expect(page.getByTestId('conversation-turn')).toHaveAttribute('data-turn-status', 'completed');
      await expect(page.getByTestId('timeline-final')).toHaveCount(0);
      await expect(page.getByTestId('timeline-error')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });
});
