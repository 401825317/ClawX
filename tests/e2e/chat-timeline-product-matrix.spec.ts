import type { ElectronApplication, Page } from '@playwright/test';
import type { ChatRuntimeEvent } from '../../shared/chat-runtime-events';
import type { RawMessage } from '../../src/stores/chat/types';
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
  hasActiveRun?: boolean;
  status?: string;
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
  await expect(page.getByTestId('chat-page')).toHaveAttribute('data-timeline-mode', 'timeline');
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
});
