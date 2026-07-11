import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';
import type { ElectronApplication } from '@playwright/test';

const SESSION_KEY = 'agent:main:e2e-native-media';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

async function installChatBootstrapMocks(app: ElectronApplication): Promise<void> {
  await installIpcMocks(app, {
    gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
    gatewayRpc: {
      [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: {
        success: true,
        result: { sessions: [{ key: SESSION_KEY, displayName: 'main', model: 'lingzhiwuxian/smart-latest', hasActiveRun: false }] },
      },
      [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
        success: true,
        result: { messages: [] },
      },
    },
    hostApi: {
      [stableStringify(['/api/gateway/status', 'GET'])]: { ok: true, data: { status: 200, ok: true, json: { state: 'running', port: 18789, pid: 12345, gatewayReady: true } } },
      [stableStringify(['/api/chat/sessions', 'GET'])]: { ok: true, data: { status: 200, ok: true, json: { success: true, result: { sessions: [{ key: SESSION_KEY, displayName: 'main', model: 'lingzhiwuxian/smart-latest', hasActiveRun: false }] } } } },
      [stableStringify(['/api/chat/history', 'POST'])]: { ok: true, data: { status: 200, ok: true, json: { success: true, result: { messages: [] } } } },
      [stableStringify(['/api/agents', 'GET'])]: { ok: true, data: { status: 200, ok: true, json: { success: true, agents: [{ id: 'main', name: 'Main' }] } } },
    },
  });
}

test.describe('Native OpenClaw media routing', () => {
  test('sends image-mode defaults in one normal agent turn without renderer media job dispatch', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installChatBootstrapMocks(app);
      await app.evaluate(({ app: _app }, sessionKey) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        const requests: Array<{ path?: string; method?: string; body?: string }> = [];
        (globalThis as Record<string, unknown>).__nativeMediaRoutingRequests = requests;
        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string; method?: string; body?: string }) => {
          requests.push(request);
          if (request.path === '/api/chat/send') {
            return { ok: true, data: { status: 200, ok: true, json: { success: true, result: { runId: 'native-image-run' } } } };
          }
          if (request.path === '/api/provider-accounts'
            || request.path === '/api/provider-accounts/key-info'
            || request.path === '/api/provider-vendors'
            || request.path === '/api/providers') {
            return { ok: true, data: { status: 200, ok: true, json: [] } };
          }
          if (request.path === '/api/provider-accounts/default') {
            return { ok: true, data: { status: 200, ok: true, json: { accountId: null } } };
          }
          if (request.path?.startsWith('/api/sessions/transcript?')) {
            return { ok: true, data: { status: 200, ok: true, json: { messages: [] } } };
          }
          if (request.path === '/api/junfeiai/status' || request.path === '/api/junfeiai/status/local') {
            return { ok: true, data: { status: 200, ok: true, json: { managed: false } } };
          }
          if (request.path === '/api/gateway/status') {
            return { ok: true, data: { status: 200, ok: true, json: { state: 'running', port: 18789, pid: 12345, gatewayReady: true } } };
          }
          if (request.path === '/api/chat/sessions') {
            return { ok: true, data: { status: 200, ok: true, json: { success: true, result: { sessions: [{ key: sessionKey, displayName: 'main', model: 'lingzhiwuxian/smart-latest', hasActiveRun: false }] } } } };
          }
          if (request.path === '/api/chat/history') {
            return { ok: true, data: { status: 200, ok: true, json: { success: true, result: { messages: [] } } } };
          }
          if (request.path === '/api/agents') {
            return { ok: true, data: { status: 200, ok: true, json: { success: true, agents: [{ id: 'main', name: 'Main' }] } } };
          }
          return { ok: true, data: { status: 200, ok: true, json: {} } };
        });
      }, SESSION_KEY);

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }
      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('chat-composer-mode-image').click();
      await page.getByTestId('chat-composer-input').fill('创作未来汽车海报');
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Send|发送/);
      await page.getByTestId('chat-composer-send').click();

      await page.waitForTimeout(1_000);

      const requests = await app.evaluate(() => (
        (globalThis as Record<string, unknown>).__nativeMediaRoutingRequests as Array<{ path?: string; body?: string }> ?? []
      ));
      expect(requests.some((request) => request.path?.includes('/api/media/') && request.path?.includes('/chat-send'))).toBeFalsy();
      const normalTurn = requests.find((request) => request.path === '/api/chat/send');
      const payload = JSON.parse(normalTurn?.body ?? '{}') as { clientPreferences?: { mode?: string; image?: unknown } };
      expect(payload.clientPreferences?.mode).toBe('image');
      expect(payload.clientPreferences?.image).toBeTruthy();
    } finally {
      await closeElectronApp(app);
    }
  });
});
