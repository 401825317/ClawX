import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';
import type { ElectronApplication } from '@playwright/test';

const SESSION_KEY = 'agent:main:e2e-native-media';
const RETIRED_AGENT_BYPASS_PATHS = [
  '/api/composite-runs',
  '/api/local-artifacts/plan-batch',
  '/api/local-artifacts/create',
  '/api/local-artifacts/append-conversation',
  '/api/media/intent-plan',
  '/api/media/image-generation/chat-send',
  '/api/media/video-generation/chat-send',
] as const;

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

async function installImageEditRoutingMocks(
  app: ElectronApplication,
  options: { runId: string; historyMessages: unknown[] },
): Promise<void> {
  await installChatBootstrapMocks(app);
  await app.evaluate(({ app: _app }, { sessionKey, runId, historyMessages }) => {
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
    const requests: Array<{ path?: string; method?: string; body?: string }> = [];
    (globalThis as Record<string, unknown>).__nativeMediaRoutingRequests = requests;
    ipcMain.removeHandler('hostapi:fetch');
    ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string; method?: string; body?: string }) => {
      requests.push(request);
      if (request.path === '/api/chat/send' || request.path === '/api/chat/send-with-media') {
        return { ok: true, data: { status: 200, ok: true, json: { success: true, result: { runId } } } };
      }
      if (request.path === '/api/chat/sessions') {
        return { ok: true, data: { status: 200, ok: true, json: { success: true, result: { sessions: [{ key: sessionKey, displayName: 'main', model: 'openai/smart-latest', hasActiveRun: false }] } } } };
      }
      if (request.path === '/api/chat/history') {
        return { ok: true, data: { status: 200, ok: true, json: { success: true, result: { messages: historyMessages } } } };
      }
      if (request.path === '/api/gateway/status') {
        return { ok: true, data: { status: 200, ok: true, json: { state: 'running', port: 18789, pid: 12345, gatewayReady: true } } };
      }
      if (request.path === '/api/junfeiai/status' || request.path === '/api/junfeiai/status/local') {
        return { ok: true, data: { status: 200, ok: true, json: { managed: false } } };
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
      if (request.path === '/api/agents') {
        return { ok: true, data: { status: 200, ok: true, json: { success: true, agents: [{ id: 'main', name: 'Main' }] } } };
      }
      return { ok: true, data: { status: 200, ok: true, json: {} } };
    });
  }, {
    sessionKey: SESSION_KEY,
    runId: options.runId,
    historyMessages: options.historyMessages,
  });
}

test.describe('Native OpenClaw media routing', () => {
  const cases = [
    {
      mode: 'chat',
      prompt: '用三句话解释 RAG，不要调用工具',
    },
    {
      mode: 'image',
      prompt: '创作未来汽车海报',
      selector: 'chat-composer-mode-image',
      preferenceKey: 'image',
    },
    {
      mode: 'video',
      prompt: '创作五秒未来汽车短片',
      selector: 'chat-composer-mode-video',
      preferenceKey: 'video',
    },
  ] as const;

  for (const currentCase of cases) test(`sends ${currentCase.mode} through one normal agent turn without planner or direct media dispatch`, async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installChatBootstrapMocks(app);
      await app.evaluate(({ app: _app }, { sessionKey, runId }) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        const requests: Array<{ path?: string; method?: string; body?: string }> = [];
        (globalThis as Record<string, unknown>).__nativeMediaRoutingRequests = requests;
        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string; method?: string; body?: string }) => {
          requests.push(request);
          if (request.path === '/api/chat/send') {
            return { ok: true, data: { status: 200, ok: true, json: { success: true, result: { runId } } } };
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
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: {
                  success: true,
                  result: {
                    messages: [{
                      role: 'assistant',
                      content: 'Earlier image result',
                      timestamp: 1,
                      _attachedFiles: [{
                        fileName: 'prior.png',
                        mimeType: 'image/png',
                        fileSize: 1024,
                        filePath: '/tmp/prior.png',
                        preview: null,
                      }],
                    }],
                  },
                },
              },
            };
          }
          if (request.path === '/api/agents') {
            return { ok: true, data: { status: 200, ok: true, json: { success: true, agents: [{ id: 'main', name: 'Main' }] } } };
          }
          return { ok: true, data: { status: 200, ok: true, json: {} } };
        });
      }, { sessionKey: SESSION_KEY, runId: `native-${currentCase.mode}-run` });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }
      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await expect(page.getByTestId('chat-image-edit-reference')).toHaveCount(0);
      if ('selector' in currentCase) {
        await page.getByTestId(currentCase.selector).click();
      }
      await expect(page.getByTestId('chat-image-edit-reference')).toHaveCount(0);
      await page.getByTestId('chat-composer-input').fill(currentCase.prompt);
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Send|发送/);
      await page.getByTestId('chat-composer-send').click();

      await page.waitForTimeout(1_000);

      const requests = await app.evaluate(() => (
        (globalThis as Record<string, unknown>).__nativeMediaRoutingRequests as Array<{ path?: string; method?: string; body?: string }> ?? []
      ));
      const retiredBypassPaths = new Set<string>(RETIRED_AGENT_BYPASS_PATHS);
      expect(requests.some((request) => (
        request.method === 'POST' && retiredBypassPaths.has(request.path ?? '')
      ))).toBeFalsy();
      expect(
        requests.some((request) => request.path === '/api/chat/send-with-media'),
        JSON.stringify(requests, null, 2),
      ).toBeFalsy();
      const normalTurn = requests.find((request) => request.path === '/api/chat/send');
      expect(normalTurn).toBeTruthy();
      const payload = JSON.parse(normalTurn?.body ?? '{}') as {
        clientPreferences?: { mode?: string; image?: unknown; video?: unknown; selectedArtifacts?: unknown };
      };
      expect(payload.clientPreferences?.mode).toBe(currentCase.mode);
      expect(payload.clientPreferences?.selectedArtifacts).toBeUndefined();
      if ('preferenceKey' in currentCase) {
        expect(payload.clientPreferences?.[currentCase.preferenceKey]).toBeTruthy();
      } else {
        expect(payload.clientPreferences?.image).toBeUndefined();
        expect(payload.clientPreferences?.video).toBeUndefined();
      }
    } finally {
      await closeElectronApp(app);
    }
  });

  const hostFailureCases = [
    {
      name: 'transport failure',
      message: 'Host API transport unavailable for regression',
      response: { ok: false, error: { message: 'Host API transport unavailable for regression' } },
    },
    {
      name: 'HTTP 500',
      message: 'Host API 500 regression',
      response: {
        ok: true,
        data: {
          status: 500,
          ok: false,
          json: { success: false, error: 'Host API 500 regression' },
        },
      },
    },
  ] as const;

  for (const failureCase of hostFailureCases) test(`preserves Host API chat.send ${failureCase.name} without retrying through raw Gateway RPC`, async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installChatBootstrapMocks(app);
      await app.evaluate(({ app: _app }, { sessionKey, failureResponse }) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        const hostRequests: Array<{ path?: string; method?: string; body?: string }> = [];
        const gatewayMethods: string[] = [];
        (globalThis as Record<string, unknown>).__nativeMediaRoutingRequests = hostRequests;
        (globalThis as Record<string, unknown>).__nativeMediaGatewayMethods = gatewayMethods;

        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (_event: unknown, method: string) => {
          gatewayMethods.push(method);
          if (method === 'sessions.list') {
            return {
              success: true,
              result: { sessions: [{ key: sessionKey, displayName: 'main', model: 'openai/smart-latest', hasActiveRun: false }] },
            };
          }
          if (method === 'chat.history') {
            return { success: true, result: { messages: [] } };
          }
          return { success: true, result: {} };
        });

        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string; method?: string; body?: string }) => {
          hostRequests.push(request);
          if (request.path === '/api/chat/send') {
            return failureResponse;
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
            return { ok: true, data: { status: 200, ok: true, json: { success: true, result: { sessions: [{ key: sessionKey, displayName: 'main', model: 'openai/smart-latest', hasActiveRun: false }] } } } };
          }
          if (request.path === '/api/chat/history') {
            return { ok: true, data: { status: 200, ok: true, json: { success: true, result: { messages: [] } } } };
          }
          if (request.path === '/api/agents') {
            return { ok: true, data: { status: 200, ok: true, json: { success: true, agents: [{ id: 'main', name: 'Main' }] } } };
          }
          return { ok: true, data: { status: 200, ok: true, json: {} } };
        });
      }, { sessionKey: SESSION_KEY, failureResponse: failureCase.response });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }
      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('chat-composer-mode-image').click();
      await page.getByTestId('chat-composer-input').fill('做个婴儿尿不湿的电商主图成品图 不要白底图');
      await page.getByTestId('chat-composer-send').click();

      await expect(page.getByText(failureCase.message, { exact: true })).toBeVisible();
      const captured = await app.evaluate(() => ({
        hostRequests: (globalThis as Record<string, unknown>).__nativeMediaRoutingRequests as Array<{ path?: string; body?: string }> ?? [],
        gatewayMethods: (globalThis as Record<string, unknown>).__nativeMediaGatewayMethods as string[] ?? [],
      }));
      const sendRequests = captured.hostRequests.filter((request) => request.path === '/api/chat/send');
      expect(sendRequests).toHaveLength(1);
      const payload = JSON.parse(sendRequests[0]?.body ?? '{}') as { clientPreferences?: { mode?: string } };
      expect(payload.clientPreferences?.mode).toBe('image');
      expect(captured.gatewayMethods).not.toContain('chat.send');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('uses the latest session image for an explicit edit request without requiring a manual selection', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installImageEditRoutingMocks(app, {
        runId: 'implicit-image-reference-run',
        historyMessages: [{
          role: 'assistant',
          content: 'Earlier image result',
          timestamp: 1,
          _attachedFiles: [{
            fileName: 'prior.png',
            mimeType: 'image/png',
            fileSize: 1024,
            filePath: '/tmp/prior.png',
            preview: null,
          }],
        }],
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }
      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      const referenceButton = page.getByTestId('image-edit-reference-button');
      await expect(referenceButton).toHaveCount(1);
      await expect(page.getByTestId('chat-image-edit-reference')).toHaveCount(0);

      await page.getByTestId('chat-composer-input').fill('保留构图，把上一张图改成白天晴天');
      await page.getByTestId('chat-composer-send').click();
      await page.waitForTimeout(1_000);

      const requests = await app.evaluate(() => (
        (globalThis as Record<string, unknown>).__nativeMediaRoutingRequests as Array<{ path?: string; body?: string }> ?? []
      ));
      const implicitTurn = requests.find((request) => request.path === '/api/chat/send-with-media');
      expect(implicitTurn, JSON.stringify(requests, null, 2)).toBeTruthy();
      const payload = JSON.parse(implicitTurn?.body ?? '{}') as {
        inlineAttachments?: boolean;
        media?: Array<{ filePath?: string; mimeType?: string; fileName?: string }>;
        clientPreferences?: {
          mode?: string;
          selectedArtifacts?: Array<{ filePath?: string; mimeType?: string; title?: string }>;
        };
      };
      expect(payload.inlineAttachments).toBe(false);
      expect(payload.media).toEqual([{ filePath: '/tmp/prior.png', mimeType: 'image/png', fileName: 'prior.png' }]);
      expect(payload.clientPreferences).toEqual({
        mode: 'chat',
        selectedArtifacts: [{ filePath: '/tmp/prior.png', mimeType: 'image/png', title: 'prior.png' }],
      });
    } finally {
      await closeElectronApp(app);
    }
  });

  test('asks for a reference image instead of starting an agent run when none is available', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installImageEditRoutingMocks(app, {
        runId: 'missing-image-reference-run',
        historyMessages: [],
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }
      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('把这张图片改成白天晴天');
      await page.getByTestId('chat-composer-send').click();

      await expect(page.getByText(/你想编辑哪张图片|Which image would you like to edit/)).toBeVisible();
      const requests = await app.evaluate(() => (
        (globalThis as Record<string, unknown>).__nativeMediaRoutingRequests as Array<{ path?: string }> ?? []
      ));
      expect(requests.some((request) => (
        request.path === '/api/chat/send' || request.path === '/api/chat/send-with-media'
      )), JSON.stringify(requests, null, 2)).toBeFalsy();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('fails closed when a legacy agent bypass endpoint is called', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const page = await getStableWindow(app);
      const results = await page.evaluate(async (paths) => {
        const electron = (window as unknown as {
          electron: {
            ipcRenderer: {
              invoke: (channel: string, request: unknown) => Promise<{
                ok: boolean;
                data?: { status?: number; json?: { code?: string; replacement?: string } };
              }>;
            };
          };
        }).electron;
        return await Promise.all(paths.map(async (path) => {
          const response = await electron.ipcRenderer.invoke('hostapi:fetch', {
            path,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          return {
            path,
            transportOk: response.ok,
            status: response.data?.status,
            code: response.data?.json?.code,
            replacement: response.data?.json?.replacement,
          };
        }));
      }, RETIRED_AGENT_BYPASS_PATHS);

      expect(results).toHaveLength(RETIRED_AGENT_BYPASS_PATHS.length);
      for (const result of results) {
        expect(result).toEqual(expect.objectContaining({
          transportOk: true,
          status: 410,
          code: 'media_agent_bypass_retired',
          replacement: '/api/chat/send',
        }));
      }
    } finally {
      await closeElectronApp(app);
    }
  });
});
