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

const quotaHistory = [
  {
    role: 'user',
    content: [{ type: 'text', text: 'Generate the requested asset.' }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    id: 'quota-error-final',
    content: [],
    stopReason: 'error',
    errorMessage: 'insufficient_user_quota',
    timestamp: Date.now(),
  },
];

const genericFailureHistory = [
  {
    role: 'user',
    content: [{ type: 'text', text: 'Trigger the live quota terminal event.' }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    id: 'generic-failed-final',
    content: [{ type: 'text', text: 'The agent run failed before producing a reply.' }],
    timestamp: Date.now(),
  },
];

test('routes insufficient quota to recharge without a retry action', async ({ launchElectronApp }) => {
  const app = await launchElectronApp({ skipSetup: true });
  try {
    await installIpcMocks(app, {
      gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
      gatewayRpc: {
        [stableStringify(['sessions.list', {}])]: {
          success: true,
          result: { sessions: [{ key: SESSION_KEY, displayName: 'main' }] },
        },
        [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
          success: true,
          result: { messages: quotaHistory },
        },
        [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 1000, maxChars: 500000 }])]: {
          success: true,
          result: { messages: quotaHistory },
        },
      },
      hostApi: {
        [stableStringify(['/api/gateway/status', 'GET'])]: {
          ok: true,
          data: { status: 200, ok: true, json: { state: 'running', port: 18789, pid: 12345 } },
        },
        [stableStringify(['/api/chat/sessions', 'GET'])]: {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: { success: true, result: { sessions: [{ key: SESSION_KEY, displayName: 'main' }] } },
          },
        },
        [stableStringify(['/api/chat/history', 'POST'])]: {
          ok: true,
          data: { status: 200, ok: true, json: { success: true, result: { messages: quotaHistory } } },
        },
        [stableStringify(['/api/chat/send', 'POST'])]: {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: { success: true, result: { runId: 'quota-live-terminal' } },
          },
        },
        [stableStringify(['/api/agents', 'GET'])]: {
          ok: true,
          data: { status: 200, ok: true, json: { success: true, agents: [{ id: 'main', name: 'main' }] } },
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
    const callout = page.getByTestId('chat-run-error');
    await expect(callout).toBeVisible({ timeout: 30_000 });
    await expect(callout).toContainText(/Insufficient balance|余额不足|残高が不足|Недостаточно средств/u);
    await expect(page.getByTestId('chat-run-recharge')).toBeVisible();
    await expect(page.getByTestId('chat-run-retry')).toHaveCount(0);

    await installIpcMocks(app, {
      gatewayRpc: {
        [stableStringify(['sessions.list', {}])]: {
          success: true,
          result: { sessions: [{ key: SESSION_KEY, displayName: 'main' }] },
        },
        [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
          success: true,
          result: { messages: [] },
        },
        [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 1000, maxChars: 500000 }])]: {
          success: true,
          result: { messages: [] },
        },
      },
      hostApi: {
        [stableStringify(['/api/gateway/status', 'GET'])]: {
          ok: true,
          data: { status: 200, ok: true, json: { state: 'running', port: 18789, pid: 12345 } },
        },
        [stableStringify(['/api/chat/sessions', 'GET'])]: {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: { success: true, result: { sessions: [{ key: SESSION_KEY, displayName: 'main' }] } },
          },
        },
        [stableStringify(['/api/chat/history', 'POST'])]: {
          ok: true,
          data: { status: 200, ok: true, json: { success: true, result: { messages: [] } } },
        },
        [stableStringify(['/api/chat/send', 'POST'])]: {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: { success: true, result: { runId: 'quota-live-terminal' } },
          },
        },
        [stableStringify(['/api/agents', 'GET'])]: {
          ok: true,
          data: { status: 200, ok: true, json: { success: true, agents: [{ id: 'main', name: 'main' }] } },
        },
      },
    });

    try {
      await page.reload();
    } catch (error) {
      if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
    }
    await expect(page.getByTestId('main-layout')).toBeVisible();
    await expect(page.getByTestId('chat-run-error')).toHaveCount(0);
    const liveCallout = page.getByTestId('chat-run-error');
    await page.getByTestId('chat-composer-input').fill('Trigger the live quota terminal event.');
    await page.getByTestId('chat-composer-send').click();
    await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Stop|停止/u);
    await app.evaluate(({ BrowserWindow }, sessionKey) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('gateway:chat-message', {
          message: {
            state: 'error',
            runId: 'quota-live-terminal',
            sessionKey,
            errorMessage: 'API provider returned a billing error with an insufficient balance.',
          },
        });
      }
    }, SESSION_KEY);
    await expect(page.getByTestId('chat-run-recharge')).toBeVisible({ timeout: 30_000 });
    await expect(liveCallout).toBeVisible();
    await expect(page.getByTestId('chat-run-retry')).toHaveCount(0);

    await installIpcMocks(app, {
      gatewayRpc: {
        [stableStringify(['sessions.list', {}])]: {
          success: true,
          result: { sessions: [{ key: SESSION_KEY, displayName: 'main' }] },
        },
        [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
          success: true,
          result: { messages: genericFailureHistory },
        },
        [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 1000, maxChars: 500000 }])]: {
          success: true,
          result: { messages: genericFailureHistory },
        },
      },
      hostApi: {
        [stableStringify(['/api/gateway/status', 'GET'])]: {
          ok: true,
          data: { status: 200, ok: true, json: { state: 'running', port: 18789, pid: 12345 } },
        },
        [stableStringify(['/api/chat/sessions', 'GET'])]: {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: { success: true, result: { sessions: [{ key: SESSION_KEY, displayName: 'main' }] } },
          },
        },
        [stableStringify(['/api/chat/history', 'POST'])]: {
          ok: true,
          data: { status: 200, ok: true, json: { success: true, result: { messages: genericFailureHistory } } },
        },
        [stableStringify(['/api/chat/send', 'POST'])]: {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: { success: true, result: { runId: 'quota-live-terminal' } },
          },
        },
        [stableStringify(['/api/agents', 'GET'])]: {
          ok: true,
          data: { status: 200, ok: true, json: { success: true, agents: [{ id: 'main', name: 'main' }] } },
        },
      },
    });

    await app.evaluate(({ BrowserWindow }, sessionKey) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('gateway:chat-message', {
          message: {
            state: 'final',
            runId: 'quota-live-terminal',
            sessionKey,
            message: {
              role: 'assistant',
              content: [{
                type: 'text',
                text: 'The provider returned a billing error because the account has an insufficient balance.',
              }],
              timestamp: Date.now(),
            },
          },
        });
      }
    }, SESSION_KEY);
    await page.waitForTimeout(5_000);
    await expect(liveCallout).toBeVisible();
    await expect(page.getByTestId('chat-run-recharge')).toBeVisible();
    await expect(page.getByTestId('chat-run-retry')).toHaveCount(0);
  } finally {
    await closeElectronApp(app);
  }
});
