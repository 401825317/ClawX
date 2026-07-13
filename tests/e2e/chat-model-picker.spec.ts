import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

const alphaModelRef = 'openai/smart-latest';
const betaModelRef = 'openai/qwen-latest';
const managedClientModelOptions = {
  text: {
    defaultModel: 'smart-latest',
    models: [
      { id: 'smart-latest', label: '智能路由', enabled: true },
      { id: 'qwen-latest', label: '通义千问', enabled: true },
    ],
  },
  image: {
    defaultModel: 'gpt-image-2',
    defaultSize: '1024x1024',
    defaultQuality: 'medium',
    models: [{
      id: 'gpt-image-2',
      label: 'Image 2',
      sizes: ['1024x1024', '2048x2048', '3840x2160'],
      qualities: ['low', 'medium', 'high'],
      defaultSize: '1024x1024',
      defaultQuality: 'medium',
      enabled: true,
    }],
  },
  video: {
    defaultModel: 'grok-image-video',
    defaultSize: '1280x720',
    defaultDurationSeconds: 4,
    models: [{
      id: 'grok-image-video',
      label: 'Grok Video',
      modes: ['text-to-video', 'image-to-video'],
      sizes: ['1280x720', '720x1280', '1024x1024'],
      durations: [4, 6, 8, 10, 12, 15],
      defaultSize: '1280x720',
      defaultDurationSeconds: 4,
      enabled: true,
    }],
  },
};

test.describe('ClawX chat model picker', () => {
  test('switches only the current session model without mutating the agent default', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await app.evaluate(async ({ app: _app }, refs) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');

        let currentSessionModelRef = refs.alphaModelRef;
        let currentSessionThinkingLevel: string | null = null;
        const hostRequests: Array<{ path: string; method: string; body: unknown }> = [];
        const now = new Date().toISOString();
        const makeResponse = (json: unknown, status = 200) => ({
          ok: true,
          data: {
            status,
            ok: status >= 200 && status < 300,
            json,
          },
        });

        const agentsSnapshot = () => ({
          success: true,
          agents: [{
            id: 'main',
            name: 'Main',
            isDefault: true,
            modelDisplay: refs.alphaModelRef.split('/').slice(1).join('/'),
            modelRef: refs.alphaModelRef,
            overrideModelRef: refs.alphaModelRef,
            inheritedModel: false,
            workspace: '~/.openclaw/workspace',
            agentDir: '~/.openclaw/agents/main/agent',
            mainSessionKey: 'agent:main:main',
            channelTypes: [],
          }],
          defaultAgentId: 'main',
          defaultModelRef: refs.alphaModelRef,
          configuredChannelTypes: [],
          channelOwners: {},
          channelAccountOwners: {},
        });

        ipcMain.removeHandler('gateway:status');
        ipcMain.handle('gateway:status', async () => ({ state: 'running', port: 18789, pid: 12345 }));

        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (_event: unknown, method: string, params: unknown) => {
          hostRequests.push({ path: `gateway:${method}`, method: 'RPC', body: params ?? null });
          if (method === 'sessions.list') {
            return {
              success: true,
              result: {
                sessions: [{
                  key: 'agent:main:main',
                  displayName: 'main',
                  model: currentSessionModelRef,
                  thinkingLevel: currentSessionThinkingLevel ?? undefined,
                  thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
                  thinkingDefault: 'high',
                }],
              },
            };
          }
          if (method === 'sessions.patch') {
            const request = params as { key?: string; model?: string | null; thinkingLevel?: string | null };
            if ('model' in request) {
              currentSessionModelRef = request.model ?? refs.alphaModelRef;
            }
            if ('thinkingLevel' in request) {
              currentSessionThinkingLevel = request.thinkingLevel ?? null;
            }
            return {
              success: true,
              result: {
                ok: true,
                key: request.key ?? 'agent:main:main',
                entry: currentSessionThinkingLevel ? { thinkingLevel: currentSessionThinkingLevel } : {},
                resolved: {
                  modelProvider: currentSessionModelRef.split('/')[0],
                  model: currentSessionModelRef.split('/').slice(1).join('/'),
                },
              },
            };
          }
          if (method === 'chat.history') {
            return { success: true, result: { messages: [] } };
          }
          return { success: true, result: {} };
        });

        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string; method?: string; body?: string | null }) => {
          const path = request?.path ?? '';
          const method = request?.method ?? 'GET';
          const body = request?.body ? JSON.parse(request.body) : null;
          hostRequests.push({ path, method, body });

          if (path === '/api/gateway/status' && method === 'GET') {
            return makeResponse({ state: 'running', port: 18789, pid: 12345, gatewayReady: true });
          }
          if (path === '/api/agents' && method === 'GET') {
            return makeResponse(agentsSnapshot());
          }
          if (path === '/api/junfeiai/client-config' && method === 'GET') {
            return makeResponse({
              announcements: { enabled: false, items: [] },
              support: { enabled: false },
              modelOptions: refs.clientModelOptions,
            });
          }
          if (path === '/api/provider-accounts' && method === 'GET') {
            return makeResponse([
              {
                id: 'alpha1234',
                vendorId: 'custom',
                label: 'Alpha',
                authMode: 'api_key',
                baseUrl: 'http://127.0.0.1:1111/v1',
                model: 'model-alpha',
                enabled: true,
                isDefault: true,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: 'beta5678',
                vendorId: 'custom',
                label: 'Beta',
                authMode: 'api_key',
                baseUrl: 'http://127.0.0.1:2222/v1',
                model: refs.betaModelRef,
                enabled: true,
                isDefault: false,
                createdAt: now,
                updatedAt: now,
              },
            ]);
          }
          if (path === '/api/providers' && method === 'GET') {
            return makeResponse([
              { id: 'alpha1234', type: 'custom', name: 'Alpha', enabled: true, hasKey: true, keyMasked: 'sk-***', createdAt: now, updatedAt: now },
              { id: 'beta5678', type: 'custom', name: 'Beta', enabled: true, hasKey: true, keyMasked: 'sk-***', createdAt: now, updatedAt: now },
            ]);
          }
          if (path === '/api/provider-vendors' && method === 'GET') {
            return makeResponse([]);
          }
          if (path === '/api/provider-accounts/default' && method === 'GET') {
            return makeResponse({ accountId: 'alpha1234' });
          }

          return makeResponse({});
        });

        (globalThis as typeof globalThis & { __chatModelPickerRequests?: typeof hostRequests }).__chatModelPickerRequests = hostRequests;
      }, { alphaModelRef, betaModelRef, clientModelOptions: managedClientModelOptions });

      const page = await getStableWindow(app);
      await page.evaluate((modelOptions) => {
        localStorage.setItem('clawx-client-config', JSON.stringify({
          state: { modelOptions },
          version: 0,
        }));
      }, managedClientModelOptions);
      await page.reload();
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.send('gateway:status-changed', { state: 'running', port: 18789, pid: 12345, gatewayReady: true });
      });

      await expect(page.getByTestId('chat-model-picker-button')).toContainText('智能路由');

      await expect.poll(async () => page.evaluate(() => {
        const modelTrigger = document.querySelector('[data-testid="chat-model-picker-button"]');
        const imageTrigger = document.querySelector('[data-testid="chat-composer-mode-image"]');
        const videoTrigger = document.querySelector('[data-testid="chat-composer-mode-video"]');
        const sendTrigger = document.querySelector('[data-testid="chat-composer-send"]');
        return Boolean(
          modelTrigger
          && imageTrigger
          && videoTrigger
          && sendTrigger
          && (modelTrigger.compareDocumentPosition(imageTrigger) & Node.DOCUMENT_POSITION_FOLLOWING)
          && (imageTrigger.compareDocumentPosition(videoTrigger) & Node.DOCUMENT_POSITION_FOLLOWING)
          && (videoTrigger.compareDocumentPosition(sendTrigger) & Node.DOCUMENT_POSITION_FOLLOWING),
        );
      })).toBe(true);

      await page.getByTestId('chat-composer-mode-image').click();
      await expect(page.getByTestId('chat-image-options')).toBeVisible();
      await expect(page.getByTestId('chat-video-options')).toHaveCount(0);
      await expect(page.getByTestId('chat-image-model')).toHaveCount(0);
      await page.getByTestId('chat-image-aspect-trigger').click();
      const aspectMenu = page.getByTestId('chat-image-aspect-menu');
      await expect(aspectMenu).toBeVisible();
      await expect(aspectMenu.getByRole('menuitemradio')).toHaveCount(5);
      await expect(aspectMenu).toHaveCSS('width', '138px');
      await page.getByTestId('chat-image-aspect-9-16').click();
      await expect(page.getByTestId('chat-image-aspect-trigger')).toContainText('9:16');

      await page.getByTestId('chat-composer-mode-video').click();
      await expect(page.getByTestId('chat-video-options')).toBeVisible();
      await expect(page.getByTestId('chat-image-options')).toHaveCount(0);
      await expect(page.getByTestId('chat-video-model')).toHaveCount(0);
      await expect(await page.getByTestId('chat-video-size').locator('option').allTextContents()).toEqual(['16:9', '9:16', '1:1']);

      await page.getByTestId('chat-model-picker-button').click();
      await expect(page.getByTestId('chat-model-picker-menu')).toBeVisible();
      await expect(page.getByTestId('chat-model-picker-menu')).toContainText('通义千问');
      await page.getByTestId('chat-model-picker-menu').getByRole('button', { name: '通义千问' }).click();

      await page.getByTestId('chat-thinking-picker-button').click();
      await expect(page.getByTestId('chat-thinking-picker-menu')).toBeVisible();
      await page.getByTestId('chat-thinking-option-medium').click();

      await expect.poll(async () => app.evaluate(() => (
        (globalThis as typeof globalThis & { __chatModelPickerRequests?: Array<{ path: string; method: string; body: unknown }> }).__chatModelPickerRequests ?? []
      ))).toContainEqual({
        path: 'gateway:sessions.patch',
        method: 'RPC',
        body: { key: 'agent:main:main', model: betaModelRef },
      });

      await page.reload();
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.send('gateway:status-changed', { state: 'running', port: 18789, pid: 12345, gatewayReady: true });
      });
      await expect(page.getByTestId('chat-model-picker-button')).toContainText('通义千问');

      const requests = await app.evaluate(() => (
        (globalThis as typeof globalThis & { __chatModelPickerRequests?: Array<{ path: string; method: string; body: unknown }> }).__chatModelPickerRequests ?? []
      ));
      expect(requests).toContainEqual({
        path: 'gateway:sessions.patch',
        method: 'RPC',
        body: { key: 'agent:main:main', model: betaModelRef },
      });
      expect(requests).toContainEqual({
        path: 'gateway:sessions.patch',
        method: 'RPC',
        body: { key: 'agent:main:main', thinkingLevel: 'medium' },
      });
      expect(requests.some((request) =>
        request.path === '/api/agents/main/model'
        || request.path === '/api/gateway/restart'
        || request.path === '/api/gateway/start'
        || request.path === 'gateway:config.patch'
      )).toBe(false);
    } finally {
      await closeElectronApp(app);
    }
  });
});
