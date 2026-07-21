import type { ElectronApplication, Page } from '@playwright/test';
import type { ChatRuntimeEvent } from '../../shared/chat-runtime-events';
import type { RawMessage } from '../../src/stores/chat/types';
import { closeElectronApp, emitIpcEvent, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const RUN_ID = 'run-reasoning-timeline';
const REASONING_SECRET = 'sk-proj-reasoning-secret-123456';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(',')}}`;
}

const seededHistory: RawMessage[] = [{
  id: 'reasoning-user',
  role: 'user',
  content: '请分析这个任务再回答。',
  timestamp: Date.now() / 1000,
}, {
  id: 'reasoning-assistant',
  role: 'assistant',
  content: [{
    type: 'thinking',
    thinking: `先确认用户目标。 Authorization: Bearer ${REASONING_SECRET}`,
  }, {
    type: 'thinking',
    thinking: `先确认用户目标。 Authorization: Bearer ${REASONING_SECRET}\n\n再选择可验证的执行路径。`,
  }, {
    type: 'text',
    text: '已完成分析，这是最终回复。',
  }],
  timestamp: Date.now() / 1000,
}];

type ReasoningLevel = 'off' | 'on' | 'stream';

async function installReasoningMocks(
  app: ElectronApplication,
  reasoningLevel: ReasoningLevel | undefined,
  history: RawMessage[] = seededHistory,
): Promise<void> {
  const session = {
    key: SESSION_KEY,
    displayName: 'main',
    ...(reasoningLevel ? { reasoningLevel } : {}),
  };
  const historyResult = {
    messages: history,
    ...(reasoningLevel ? { reasoningLevel } : {}),
    thinkingLevel: 'xhigh',
  };
  await installIpcMocks(app, {
    gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
    gatewayRpc: {
      [stableStringify(['sessions.list', null])]: {
        success: true,
        result: { sessions: [session] },
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
        data: {
          status: 200,
          ok: true,
          json: { success: true, result: { sessions: [session] } },
        },
      },
      [stableStringify(['/api/chat/history', 'POST'])]: {
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: { success: true, result: historyResult },
        },
      },
      [stableStringify(['/api/chat/send', 'POST'])]: {
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: { success: true, result: { runId: RUN_ID } },
        },
      },
      [stableStringify(['/api/agents', 'GET'])]: {
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: { success: true, agents: [{ id: 'main', name: 'Main Agent' }] },
        },
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
  for (const event of events) await emitIpcEvent(app, 'chat:runtime-event', event);
}

test.describe('OpenClaw reasoning projection', () => {
  test('renders persistent reasoning separately from the final answer', async ({ launchElectronApp }, testInfo) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installReasoningMocks(app, 'on');
      const page = await openTimeline(app);
      await expect(page.getByTestId('conversation-timeline')).toHaveAttribute('data-reasoning-level', 'on');
      const panel = page.getByTestId('timeline-thinking');
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(panel).toContainText(/Reasoning|思考过程/u);
      await expect(panel.locator('button')).toHaveAttribute('aria-expanded', 'false');
      await expect(panel).not.toContainText('先确认用户目标');
      await panel.locator('button').click();
      await expect(panel).toContainText('先确认用户目标');
      await expect(panel).toContainText('再选择可验证的执行路径');
      await expect(panel).toContainText('[REDACTED]');
      await expect(page.locator('body')).not.toContainText(REASONING_SECRET);
      const panelText = await panel.textContent();
      expect(panelText?.match(/先确认用户目标/gu)).toHaveLength(1);
      await expect(page.getByText('已完成分析，这是最终回复。', { exact: true })).toBeVisible();

      const screenshotPath = testInfo.outputPath('timeline-thinking.png');
      await panel.screenshot({ path: screenshotPath });
      await testInfo.attach('timeline-thinking', { path: screenshotPath, contentType: 'image/png' });
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps persisted reasoning out of the Timeline when visibility is off', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installReasoningMocks(app, 'off');
      const page = await openTimeline(app);

      await expect(page.getByTestId('conversation-timeline')).toHaveAttribute('data-reasoning-level', 'off');
      await expect(page.getByTestId('timeline-thinking')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(REASONING_SECRET);
      await expect(page.getByText('已完成分析，这是最终回复。', { exact: true })).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('falls back to hidden reasoning when OpenClaw supplies no visibility level', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installReasoningMocks(app, undefined);
      const page = await openTimeline(app);

      await expect(page.getByTestId('conversation-timeline')).toHaveAttribute('data-reasoning-level', 'off');
      await expect(page.getByTestId('timeline-thinking')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(REASONING_SECRET);
      await expect(page.getByText('已完成分析，这是最终回复。', { exact: true })).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('shows streamed reasoning only while its Turn remains active', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installReasoningMocks(app, 'stream', []);
      const page = await openTimeline(app);

      await page.getByTestId('chat-composer-input').fill('Inspect and verify this request.');
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByTestId('conversation-timeline')).toHaveAttribute('data-reasoning-level', 'stream');
      const now = Date.now();
      await emitRuntimeEvents(app, [{
        type: 'run.started',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 1,
        startedAt: now,
        ts: now,
      }, {
        type: 'thinking.delta',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 2,
        delta: 'Inspect and ',
        ts: now + 1,
      }, {
        type: 'thinking.delta',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 3,
        delta: `verify Authorization: Bearer ${REASONING_SECRET}`,
        ts: now + 2,
      }]);

      const panel = page.getByTestId('timeline-thinking');
      await expect(panel).toBeVisible();
      await expect(panel.locator('button')).toHaveAttribute('aria-expanded', 'false');
      await panel.locator('button').click();
      await expect(panel).toContainText('Inspect and verify');
      await expect(panel).toContainText('[REDACTED]');
      await expect(page.locator('body')).not.toContainText(REASONING_SECRET);
      expect((await panel.textContent())?.match(/Inspect and verify/gu)).toHaveLength(1);

      const finalText = 'The streamed reasoning Turn is complete.';
      await emitIpcEvent(app, 'gateway:chat-message', {
        message: {
          state: 'final',
          runId: RUN_ID,
          sessionKey: SESSION_KEY,
          seq: 4,
          message: {
            role: 'assistant',
            id: 'reasoning-stream-final',
            timestamp: (now + 3) / 1_000,
            content: finalText,
          },
        },
      });
      await expect(page.getByText(finalText, { exact: true })).toBeVisible();
      await expect(panel).toHaveCount(0);
      await emitRuntimeEvents(app, [{
        type: 'run.ended',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        seq: 5,
        status: 'completed',
        endedAt: now + 4,
        ts: now + 4,
      }]);

      await expect(page.getByTestId('conversation-turn')).toHaveAttribute('data-turn-status', 'completed');
      await expect(page.getByTestId('timeline-thinking')).toHaveCount(0);

      await installReasoningMocks(app, 'stream');
      const reloaded = await openTimeline(app);
      await expect(reloaded.getByTestId('conversation-timeline')).toHaveAttribute('data-reasoning-level', 'stream');
      await expect(reloaded.getByTestId('timeline-thinking')).toHaveCount(0);
      await expect(reloaded.locator('body')).not.toContainText(REASONING_SECRET);
    } finally {
      await closeElectronApp(app);
    }
  });
});
