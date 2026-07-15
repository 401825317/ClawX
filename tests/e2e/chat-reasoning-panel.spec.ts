import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(',')}}`;
}

const seededHistory = [{
  id: 'reasoning-user',
  role: 'user',
  content: '请分析这个任务再回答。',
  timestamp: Date.now() / 1000,
}, {
  id: 'reasoning-assistant',
  role: 'assistant',
  content: [{
    type: 'thinking',
    thinking: '先确认用户目标。\n\n再选择可验证的执行路径。',
  }, {
    type: 'text',
    text: '已完成分析，这是最终回复。',
  }],
  timestamp: Date.now() / 1000,
}];

test.describe('OpenClaw reasoning projection', () => {
  test('renders persistent reasoning separately from the final answer', async ({ launchElectronApp }, testInfo) => {
    const app = await launchElectronApp({ skipSetup: true, chatTimelineMode: 'timeline' });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
        gatewayRpc: {
          [stableStringify(['sessions.list', null])]: {
            success: true,
            result: {
              sessions: [{ key: SESSION_KEY, displayName: 'main', reasoningLevel: 'on' }],
            },
          },
          [stableStringify(['chat.history', null])]: {
            success: true,
            result: { messages: seededHistory, reasoningLevel: 'on', thinkingLevel: 'xhigh' },
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
              json: {
                success: true,
                result: {
                  sessions: [{ key: SESSION_KEY, displayName: 'main', reasoningLevel: 'on' }],
                },
              },
            },
          },
          [stableStringify(['/api/chat/history', 'POST'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                result: { messages: seededHistory, reasoningLevel: 'on', thinkingLevel: 'xhigh' },
              },
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

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByTestId('chat-page')).toHaveAttribute('data-timeline-mode', 'timeline');
      const panel = page.getByTestId('timeline-thinking');
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(panel).toContainText(/Reasoning|思考过程/u);
      await expect(panel.locator('button')).toHaveAttribute('aria-expanded', 'false');
      await expect(panel).not.toContainText('先确认用户目标');
      await panel.locator('button').click();
      await expect(panel).toContainText('先确认用户目标');
      await expect(panel).toContainText('再选择可验证的执行路径');
      await expect(page.getByText('已完成分析，这是最终回复。', { exact: true })).toBeVisible();

      const screenshotPath = testInfo.outputPath('timeline-thinking.png');
      await panel.screenshot({ path: screenshotPath });
      await testInfo.attach('timeline-thinking', { path: screenshotPath, contentType: 'image/png' });
    } finally {
      await closeElectronApp(app);
    }
  });
});
