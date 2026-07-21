import type { ElectronApplication, Page } from '@playwright/test';
import type { ChatRuntimeEvent } from '../../shared/chat-runtime-events';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  installIpcMocks,
  test,
} from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const RUN_ID = 'run-approval-e2e';
const APPROVAL_ID = 'approval-e2e-exec';
const DESKTOP_APPROVAL_ID = '12345678-1234-1234-1234-123456789012';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(',')}}`;
}

async function installApprovalMocks(app: ElectronApplication): Promise<void> {
  const sessions = [{ key: SESSION_KEY, displayName: 'main', status: 'done', hasActiveRun: false }];
  const historyResult = { messages: [], sessionInfo: { hasActiveRun: false } };
  await installIpcMocks(app, {
    gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
    gatewayRpc: {
      [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: {
        success: true,
        result: { sessions },
      },
      [stableStringify(['sessions.list', {}])]: { success: true, result: { sessions } },
      [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 100, maxChars: 500000 }])]: {
        success: true,
        result: historyResult,
      },
      [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 1000, maxChars: 500000 }])]: {
        success: true,
        result: historyResult,
      },
      [stableStringify(['chat.send', null])]: { success: true, result: { runId: RUN_ID } },
    },
    hostApi: {
      [stableStringify(['/api/gateway/status', 'GET'])]: {
        ok: true,
        data: { status: 200, ok: true, json: { state: 'running', port: 18789, pid: 12345, gatewayReady: true } },
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
        data: { status: 200, ok: true, json: { success: true, agents: [{ id: 'main', name: 'Main' }] } },
      },
      [stableStringify(['/api/files/thumbnails', 'POST'])]: {
        ok: true,
        data: { status: 200, ok: true, json: {} },
      },
      [stableStringify([`/api/computer/approvals/${DESKTOP_APPROVAL_ID}/deny`, 'POST'])]: {
        ok: true,
        data: { status: 200, ok: true, json: { success: true } },
      },
    },
    captureHostApiRequests: true,
  });

  await app.evaluate(({ ipcMain }) => {
    let attempts = 0;
    const calls: unknown[] = [];
    let desktopAttempts = 0;
    const desktopCalls: unknown[] = [];
    ipcMain.removeHandler('approval:resolve');
    ipcMain.handle('approval:resolve', async (_event, input: unknown) => {
      calls.push(input);
      attempts += 1;
      if (attempts === 1) return { success: false, error: 'temporary approval failure' };
      return { success: true, result: { accepted: true } };
    });
    ipcMain.removeHandler('desktop:approve');
    ipcMain.handle('desktop:approve', async (_event, approvalId: unknown) => {
      desktopCalls.push(approvalId);
      desktopAttempts += 1;
      if (desktopAttempts === 1) return { success: false, error: 'temporary desktop approval failure' };
      return { success: true, result: { status: 'completed' } };
    });
    (globalThis as Record<string, unknown>).__approvalResolveCalls = calls;
    (globalThis as Record<string, unknown>).__desktopApprovalCalls = desktopCalls;
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
  await expect(page.getByTestId('chat-page')).toBeVisible();
  await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
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

function desktopApprovalEvent(input: {
  ts: number;
  status: 'pending' | 'denied' | 'consumed';
}): Extract<ChatRuntimeEvent, { type: 'approval.updated' }> {
  const pending = input.status === 'pending';
  const denied = input.status === 'denied';
  return {
    type: 'approval.updated',
    producer: 'uclaw-desktop-approval',
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    ts: input.ts,
    approvalId: DESKTOP_APPROVAL_ID,
    approvalKind: 'desktop',
    allowedDecisions: ['allow-once', 'deny'],
    decision: pending ? undefined : denied ? 'deny' : 'allow-once',
    requestedAt: input.ts - (pending ? 0 : 1),
    expiresAt: input.ts + 60_000,
    request: { actionKind: 'type_text', appId: 'com.example.editor' },
    actionable: pending,
    resolutionSource: 'desktop-broker',
    itemId: DESKTOP_APPROVAL_ID,
    kind: 'desktop',
    phase: pending ? 'requested' : 'resolved',
    status: input.status,
    title: 'com.example.editor',
    message: 'Desktop actions require explicit approval from the local UClaw UI immediately before execution.',
  };
}

test.describe('Codex-style timeline approvals', () => {
  test('submits a keyboard decision through Main IPC, reports failure, retries, and waits for authoritative resolution', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installApprovalMocks(app);
      const page = await openTimeline(app);

      await page.getByTestId('chat-composer-input').fill('Run the typecheck command.');
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByText('Run the typecheck command.', { exact: true })).toBeVisible();

      const requestedAt = Date.now();
      await emitRuntimeEvents(app, [{
        type: 'approval.updated',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 2,
        ts: requestedAt,
        approvalId: APPROVAL_ID,
        approvalKind: 'exec',
        allowedDecisions: ['allow-once', 'allow-always', 'deny'],
        requestedAt,
        expiresAt: requestedAt + 60_000,
        request: { command: 'pnpm run typecheck' },
        actionable: true,
        itemId: APPROVAL_ID,
        kind: 'exec',
        phase: 'requested',
        status: 'pending',
        title: 'Run command',
        message: 'pnpm run typecheck',
      }]);

      const approval = page.getByTestId('timeline-approval');
      await expect(approval).toBeVisible();
      await expect(approval).toHaveAttribute('data-status', 'blocked');
      await expect(page.getByTestId('desktop-approval-overlay')).toHaveCount(0);
      await expect(page.getByTestId('timeline-approval-allow-always')).toBeVisible();
      await expect(page.getByTestId('timeline-approval-deny')).toBeVisible();

      const allowOnce = page.getByTestId('timeline-approval-allow-once');
      await allowOnce.focus();
      await expect(allowOnce).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('timeline-approval-error')).toContainText(/Could not submit approval decision|提交审批决定失败/u);
      await expect(page.getByText('temporary approval failure', { exact: true })).toHaveCount(0);

      await allowOnce.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('timeline-approval-error')).toHaveCount(0);
      await expect(allowOnce).toBeVisible();

      await expect.poll(async () => await app.evaluate(() => (
        (globalThis as Record<string, unknown>).__approvalResolveCalls as unknown[]
      ))).toEqual([
        { approvalId: APPROVAL_ID, approvalKind: 'exec', decision: 'allow-once' },
        { approvalId: APPROVAL_ID, approvalKind: 'exec', decision: 'allow-once' },
      ]);

      await emitRuntimeEvents(app, [{
        type: 'approval.updated',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 3,
        ts: requestedAt + 1,
        approvalId: APPROVAL_ID,
        approvalKind: 'exec',
        decision: 'allow-once',
        actionable: false,
        resolutionSource: 'gateway',
        itemId: APPROVAL_ID,
        kind: 'exec',
        phase: 'resolved',
        status: 'allow-once',
      }]);

      await expect(approval).toHaveAttribute('data-status', 'completed');
      await expect(page.getByTestId('timeline-approval-allow-once')).toHaveCount(0);
      await expect(page.getByTestId('timeline-approval-allow-always')).toHaveCount(0);
      await expect(page.getByTestId('timeline-approval-deny')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('denies a Main-owned desktop approval in Timeline and does not reopen it on replay or reload', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installApprovalMocks(app);
      let page = await openTimeline(app);

      await page.getByTestId('chat-composer-input').fill('Type a short note in the editor.');
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByText('Type a short note in the editor.', { exact: true })).toBeVisible();

      const requestedAt = Date.now();
      const pendingEvent = desktopApprovalEvent({ ts: requestedAt, status: 'pending' });
      await emitRuntimeEvents(app, [pendingEvent]);

      const approval = page.getByTestId('timeline-approval');
      await expect(approval).toBeVisible();
      await expect(approval).toHaveAttribute('data-status', 'blocked');
      await expect(approval).toHaveAttribute('data-approval-id', DESKTOP_APPROVAL_ID);
      await expect(approval).toContainText('com.example.editor');
      await expect(page.getByTestId('timeline-approval-allow-always')).toHaveCount(0);
      await expect(page.getByTestId('desktop-approval-overlay')).toHaveCount(0);

      await page.getByTestId('timeline-approval-deny').click();
      await expect.poll(async () => await app.evaluate((_electron, expectedPath) => {
        const requests = (globalThis as Record<string, unknown>).__clawxE2EHostApiRequests as Array<{
          path?: string;
          method?: string;
          body?: string;
        }>;
        return requests.some((request) => (
          request.path === expectedPath
          && request.method === 'POST'
        ));
      }, `/api/computer/approvals/${DESKTOP_APPROVAL_ID}/deny`)).toBe(true);

      await emitRuntimeEvents(app, [desktopApprovalEvent({ ts: requestedAt + 1, status: 'denied' })]);
      await expect(approval).toHaveAttribute('data-status', 'error');
      await expect(page.getByTestId('timeline-approval-allow-once')).toHaveCount(0);
      await expect(page.getByTestId('timeline-approval-deny')).toHaveCount(0);

      await emitRuntimeEvents(app, [pendingEvent]);
      await expect(approval).toHaveAttribute('data-status', 'error');
      await expect(page.getByTestId('timeline-approval-deny')).toHaveCount(0);

      await page.reload();
      page = await getStableWindow(app);
      await expect(page.getByTestId('chat-page')).toBeVisible();
      await expect(page.getByTestId('timeline-approval')).toHaveCount(0);
      await expect(page.getByTestId('desktop-approval-overlay')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('retries desktop approval IPC failure and waits for the authoritative Main resolution', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installApprovalMocks(app);
      const page = await openTimeline(app);

      await page.getByTestId('chat-composer-input').fill('Type a short note in the editor.');
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByText('Type a short note in the editor.', { exact: true })).toBeVisible();

      const requestedAt = Date.now();
      await emitRuntimeEvents(app, [desktopApprovalEvent({ ts: requestedAt, status: 'pending' })]);

      const approval = page.getByTestId('timeline-approval');
      const allowOnce = page.getByTestId('timeline-approval-allow-once');
      await expect(approval).toHaveAttribute('data-status', 'blocked');
      await allowOnce.click();
      await expect(page.getByTestId('timeline-approval-error')).toContainText(/Could not submit approval decision|提交审批决定失败/u);
      await expect(page.getByText('temporary desktop approval failure', { exact: true })).toHaveCount(0);
      await expect(allowOnce).toBeVisible();

      await allowOnce.click();
      await expect(page.getByTestId('timeline-approval-error')).toHaveCount(0);
      await expect(approval).toHaveAttribute('data-status', 'blocked');
      await expect(allowOnce).toBeVisible();
      await expect.poll(async () => await app.evaluate(() => (
        (globalThis as Record<string, unknown>).__desktopApprovalCalls as unknown[]
      ))).toEqual([DESKTOP_APPROVAL_ID, DESKTOP_APPROVAL_ID]);

      await emitRuntimeEvents(app, [desktopApprovalEvent({ ts: requestedAt + 1, status: 'consumed' })]);
      await expect(approval).toHaveAttribute('data-status', 'completed');
      await expect(page.getByTestId('timeline-approval-allow-once')).toHaveCount(0);
      await expect(page.getByTestId('timeline-approval-deny')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('authoritative abort stops the active tool, pending approval, and active task without success state', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installApprovalMocks(app);
      const page = await openTimeline(app);

      await page.getByTestId('chat-composer-input').fill('Start work that will be stopped.');
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByText('Start work that will be stopped.', { exact: true })).toBeVisible();

      const now = Date.now();
      const toolCallId = 'approval-abort-tool';
      const approvalId = 'approval-abort-pending';
      const taskId = 'approval-abort-task';
      await emitRuntimeEvents(app, [{
        type: 'run.started',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 1,
        startedAt: now,
        ts: now,
      }, {
        type: 'tool.started',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 2,
        ts: now + 1,
        toolCallId,
        name: 'exec',
        args: { command: 'pnpm run typecheck' },
      }, {
        type: 'approval.updated',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 3,
        ts: now + 2,
        toolCallId,
        approvalId,
        approvalKind: 'exec',
        allowedDecisions: ['allow-once', 'allow-always', 'deny'],
        requestedAt: now + 2,
        expiresAt: now + 60_000,
        request: { command: 'pnpm run typecheck' },
        actionable: true,
        itemId: approvalId,
        kind: 'exec',
        phase: 'requested',
        status: 'pending',
        title: 'Run abortable command',
        message: 'pnpm run typecheck',
      }, {
        type: 'task.updated',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 4,
        ts: now + 3,
        taskId,
        task: {
          taskId,
          flowId: 'approval-abort-flow',
          kind: 'execution',
          runtime: 'openclaw',
          title: 'Abortable background task',
          status: 'running',
          sourceStatus: 'running',
          startedAt: now + 3,
          updatedAt: now + 3,
        },
      }]);

      const turn = page.getByTestId('conversation-turn');
      const toolGroup = page.getByTestId('timeline-tool-group');
      const approval = page.getByTestId('timeline-approval');
      const subtasks = page.getByTestId('timeline-subtasks');
      await expect(turn).toHaveAttribute('data-turn-status', 'waiting_approval');
      await expect(toolGroup).toHaveAttribute('data-status', 'running');
      await expect(approval).toHaveAttribute('data-status', 'blocked');
      await expect(subtasks).toHaveAttribute('data-status', 'running');
      await expect(page.getByTestId('timeline-approval-allow-once')).toBeVisible();
      await expect(page.getByTestId('timeline-approval-deny')).toBeVisible();

      await emitRuntimeEvents(app, [{
        type: 'run.ended',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 5,
        status: 'aborted',
        stopReason: 'user',
        endedAt: now + 4,
        ts: now + 4,
      }]);

      await expect(turn).toHaveAttribute('data-turn-status', 'aborted');
      await expect(page.getByTestId('timeline-turn-status')).toHaveCount(0);
      await expect(toolGroup).toHaveAttribute('data-status', 'aborted');
      await expect(approval).toHaveAttribute('data-status', 'aborted');
      await expect(subtasks).toHaveAttribute('data-status', 'aborted');

      await page.getByTestId('timeline-tool-group-toggle').click();
      const toolDetails = page.getByTestId('timeline-tool-details');
      await expect(toolDetails).toContainText('exec');
      await expect(toolDetails).toContainText(/Stopped|已停止|停止済み|Остановлено/u);
      await expect(toolDetails).not.toContainText(/Completed|已完成|完了|Завершено/u);

      await expect(approval.locator('svg').first()).toHaveClass(/circle-stop/u);
      await expect(approval).toContainText(/Cancelled|已取消|キャンセル|Отменено/u);
      await expect(approval).not.toContainText(/Approved|Completed|已批准|已完成|承認済み|完了|Одобрено|Завершено/u);
      await expect(page.getByTestId('timeline-approval-allow-once')).toHaveCount(0);
      await expect(page.getByTestId('timeline-approval-allow-always')).toHaveCount(0);
      await expect(page.getByTestId('timeline-approval-deny')).toHaveCount(0);

      await page.getByTestId('timeline-subtasks-toggle').click();
      const subtaskDetails = page.getByTestId('timeline-subtask-details');
      await expect(subtaskDetails).toContainText('Abortable background task');
      await expect(subtaskDetails).toContainText(/Stopped|已停止|停止済み|Остановлено/u);
      await expect(subtaskDetails).not.toContainText(/Completed|已完成|完了|Завершено/u);

      await page.getByTestId('timeline-execution-details').click();
      const dialog = page.getByRole('dialog');
      const executionRows = dialog.getByTestId('chat-execution-step');
      const toolRow = executionRows.filter({ hasText: 'exec' });
      const approvalRow = executionRows.filter({ hasText: 'Run abortable command' });
      const taskRow = dialog.locator(`[data-testid="chat-execution-step"][data-task-id="${taskId}"]`)
        .filter({ hasText: 'Abortable background task' });
      for (const row of [toolRow, approvalRow, taskRow]) {
        await expect(row).toHaveCount(1);
        await expect(row).toHaveAttribute('data-step-status', 'aborted');
        await expect(row.locator('[data-status-icon="completed"]')).toHaveCount(0);
      }
      await expect(toolRow).toContainText(/Stopped|已停止|停止済み|Остановлено/u);
      await expect(approvalRow.locator('[data-status-icon="aborted"]')).toHaveCount(1);
      await expect(taskRow.locator('[data-status-icon="aborted"]')).toHaveCount(1);
      await expect(dialog.locator('[data-status-icon="completed"]')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('chat-composer-input')).toBeEnabled();
    } finally {
      await closeElectronApp(app);
    }
  });
});
