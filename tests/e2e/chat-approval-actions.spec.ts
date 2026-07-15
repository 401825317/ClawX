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
    },
  });

  await app.evaluate(({ ipcMain }) => {
    let attempts = 0;
    const calls: unknown[] = [];
    ipcMain.removeHandler('approval:resolve');
    ipcMain.handle('approval:resolve', async (_event, input: unknown) => {
      calls.push(input);
      attempts += 1;
      if (attempts === 1) return { success: false, error: 'temporary approval failure' };
      return { success: true, result: { accepted: true } };
    });
    (globalThis as Record<string, unknown>).__approvalResolveCalls = calls;
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
  await expect(page.getByTestId('chat-page')).toHaveAttribute('data-timeline-mode', 'timeline');
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

test.describe('Codex-style timeline approvals', () => {
  test('submits a keyboard decision through Main IPC, reports failure, retries, and waits for authoritative resolution', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true, chatTimelineMode: 'timeline' });
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
      await expect(page.getByTestId('timeline-approval-error')).toContainText('temporary approval failure');

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
});
