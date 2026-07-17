import type { ElectronApplication, Page } from '@playwright/test';
import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const IDEMPOTENCY_KEY = 'host-task-restart-idempotency';
const TASK_ID = 'host-task-restart-presentation';
const TASK_TITLE = 'Render the durable presentation';
const ARTIFACT_TITLE = 'restart-launch-deck.pptx';
const VERIFICATION_TITLE = 'Restart artifact integrity';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(',')}}`;
}

const createdAt = 1_720_000_000_100;
const historyMessages = [{
  id: 'host-task-restart-user',
  role: 'user',
  idempotencyKey: IDEMPOTENCY_KEY,
  content: 'Create a presentation that survives restart.',
  timestamp: (createdAt - 100) / 1_000,
}, {
  id: 'host-task-restart-final',
  role: 'assistant',
  content: 'The durable presentation is ready.',
  timestamp: (createdAt + 500) / 1_000,
}];
const persistedHostTask = {
  schema: 'uclaw.host-task/v1',
  taskId: TASK_ID,
  kind: 'local.presentation.render',
  title: TASK_TITLE,
  status: 'succeeded',
  revision: 5,
  createdAt,
  updatedAt: createdAt + 400,
  correlation: {
    sessionKey: SESSION_KEY,
    runId: 'host-task-restart-run',
    toolCallId: 'host-task-restart-tool',
    idempotencyKey: IDEMPOTENCY_KEY,
  },
  progress: [{
    id: 'progress:host-task-restart-presentation:5',
    stage: 'local.presentation.render',
    status: 'completed',
    label: TASK_TITLE,
    detail: 'Presentation restored from the durable task ledger.',
    percent: 100,
    timestampMs: createdAt + 400,
  }],
  artifacts: [{
    id: 'host-task-restart-artifact',
    kind: 'presentation',
    title: ARTIFACT_TITLE,
    filePath: `/tmp/${ARTIFACT_TITLE}`,
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    sizeBytes: 4_096,
  }],
  verifications: [{
    id: 'host-task-restart-verification',
    status: 'passed',
    kind: 'artifact.integrity',
    required: true,
    title: VERIFICATION_TITLE,
    artifactId: 'host-task-restart-artifact',
  }],
  lifecycle: {
    operations: [{
      kind: 'start',
      status: 'completed',
      attempt: 1,
      startedAt: createdAt + 50,
      finishedAt: createdAt + 400,
    }],
  },
};

async function installRestartRecoveryMocks(app: ElectronApplication): Promise<void> {
  const sessions = [{
    key: SESSION_KEY,
    displayName: 'main',
    status: 'done',
    hasActiveRun: false,
  }];
  const historyResult = {
    messages: historyMessages,
    sessionInfo: { hasActiveRun: false, status: 'done' },
  };

  await installIpcMocks(app, {
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
        success: true,
        result: historyResult,
      },
      [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
        success: true,
        result: historyResult,
      },
      [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 1000, maxChars: 500000 }])]: {
        success: true,
        result: historyResult,
      },
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
      [stableStringify([`/api/task-bridge/tasks?activeOnly=false&sessionKey=${encodeURIComponent(SESSION_KEY)}`, 'GET'])]: {
        ok: true,
        data: { status: 200, ok: true, json: { success: true, tasks: [persistedHostTask] } },
      },
      [stableStringify(['/api/files/thumbnails', 'POST'])]: {
        ok: true,
        data: { status: 200, ok: true, json: {} },
      },
      [stableStringify(['/api/agents', 'GET'])]: {
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: { success: true, agents: [{ id: 'main', name: 'Main' }] },
        },
      },
    },
  });
}

async function openRecoveredTimeline(app: ElectronApplication): Promise<Page> {
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

async function expectDurableTaskRecovery(page: Page): Promise<void> {
  await expect(page.getByTestId('conversation-turn')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByText('Create a presentation that survives restart.', { exact: true })).toHaveCount(1);
  await expect(page.getByText('The durable presentation is ready.', { exact: true })).toHaveCount(1);
  await expect(page.getByTestId('timeline-subtasks')).toHaveCount(1);
  await expect(page.getByTestId('timeline-plan')).toHaveCount(0);
  await expect(page.getByTestId('timeline-tool-group')).toHaveCount(0);
  await expect(page.getByTestId('timeline-artifacts')).toContainText(ARTIFACT_TITLE);
  await expect(page.getByTestId('timeline-verification')).toHaveCount(0);

  await page.getByTestId('timeline-execution-details').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('chat-execution-step').filter({ hasText: TASK_TITLE })).toHaveAttribute('data-task-id', TASK_ID);
  await expect(dialog.getByTestId('chat-execution-step').filter({ hasText: 'host.local.presentation.render' })).toBeVisible();
  await expect(dialog.getByTestId('chat-execution-step').filter({ hasText: ARTIFACT_TITLE })).toBeVisible();
  await expect(dialog.getByTestId('chat-execution-step').filter({ hasText: VERIFICATION_TITLE })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

test.describe('Host Task history recovery', () => {
  test('rehydrates one owning Turn with durable task evidence after an Electron restart', async ({ launchElectronApp }, testInfo) => {
    const firstApp = await launchElectronApp({ skipSetup: true });
    try {
      await installRestartRecoveryMocks(firstApp);
      await expectDurableTaskRecovery(await openRecoveredTimeline(firstApp));
    } finally {
      await closeElectronApp(firstApp);
    }

    // Relaunch against the same HOME and userData directories to exercise process-level recovery.
    const restartedApp = await launchElectronApp({ skipSetup: true });
    try {
      await installRestartRecoveryMocks(restartedApp);
      const restartedPage = await openRecoveredTimeline(restartedApp);
      await expectDurableTaskRecovery(restartedPage);
      const restartScreenshotPath = testInfo.outputPath('timeline-restored-host-task-session.png');
      await restartedPage.getByTestId('conversation-timeline').screenshot({ path: restartScreenshotPath });
      await testInfo.attach('timeline-restored-host-task-session', {
        path: restartScreenshotPath,
        contentType: 'image/png',
      });
    } finally {
      await closeElectronApp(restartedApp);
    }
  });
});
