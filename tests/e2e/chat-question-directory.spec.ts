import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

const longAnswer = [
  'This answer intentionally contains enough text to make the chat scrollable in the Electron window.',
  'It gives the question directory a meaningful target to jump to when the user selects an entry.',
  'The content itself is not important; the test only verifies that the in-chat question outline remains visible and clickable.',
].join(' ');

const seededHistory = [
  { role: 'user', content: 'First question: summarize the market opening.', timestamp: 1000 },
  { role: 'assistant', content: `${longAnswer}\n\n${longAnswer}\n\n${longAnswer}`, timestamp: 1001 },
  { role: 'user', content: 'Second question: list the strongest sectors.', timestamp: 1002 },
  { role: 'assistant', content: `${longAnswer}\n\n${longAnswer}\n\n${longAnswer}`, timestamp: 1003 },
  { role: 'user', content: 'Third question: explain notable risks.', timestamp: 1004 },
  { role: 'assistant', content: `${longAnswer}\n\n${longAnswer}\n\n${longAnswer}`, timestamp: 1005 },
  { role: 'user', content: 'Fourth question: prepare the final action plan.', timestamp: 1006 },
  { role: 'assistant', content: 'Here is the final action plan.', timestamp: 1007 },
];

test.describe('ClawX chat question directory', () => {
  test('opens a clickable directory on desktop and a closing sheet on compact viewports', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const sessions = [{ key: SESSION_KEY, displayName: 'main', status: 'done', hasActiveRun: false }];
      const historyResult = { messages: seededHistory, sessionInfo: { hasActiveRun: false } };
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
            data: { status: 200, ok: true, json: { success: true, tasks: [] } },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                agents: [{ id: 'main', name: 'main' }],
              },
            },
          },
          [stableStringify(['/api/files/thumbnails', 'POST'])]: {
            ok: true,
            data: { status: 200, ok: true, json: {} },
          },
        },
      });

      const page = await getStableWindow(app);
      await page.setViewportSize({ width: 1600, height: 900 });
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('main-layout')).toBeVisible();

      const toggle = page.getByTestId('chat-question-directory-toggle');
      await expect(toggle).toBeVisible();
      await expect(toggle).toBeEnabled({ timeout: 30_000 });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle).toHaveAttribute('aria-controls', 'chat-question-directory');
      await toggle.click();

      const directory = page.getByTestId('chat-question-directory');
      await expect(directory).toBeVisible({ timeout: 30_000 });
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(directory).toContainText(/Question directory|问题目录/u);
      await expect(directory).toContainText('First question: summarize the market opening.');
      await expect(directory).toContainText('Fourth question: prepare the final action plan.');
      await expect(directory.locator('button')).toHaveCount(4);

      const fourthTurn = page.getByTestId('conversation-turn').filter({ hasText: 'Fourth question: prepare the final action plan.' });
      await page.getByTestId('chat-question-directory-item-3').click();
      await expect(fourthTurn).toBeInViewport();

      await toggle.click();
      await expect(directory).toBeHidden();
      await page.setViewportSize({ width: 800, height: 900 });
      await toggle.click();
      await expect(directory).toBeVisible();
      await expect(directory).toHaveAttribute('role', 'dialog');
      await page.getByTestId('chat-question-directory-item-0').click();
      await expect(directory).toBeHidden();
      await expect(page.getByTestId('conversation-turn').filter({ hasText: 'First question: summarize the market opening.' })).toBeInViewport();
    } finally {
      await closeElectronApp(app);
    }
  });
});
