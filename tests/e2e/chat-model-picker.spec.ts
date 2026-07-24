import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

const alphaModelRef = 'openai/smart-latest';
const betaModelRef = 'openai/deepseek-v4-pro';

test.describe('ClawX chat model picker', () => {
  test('switches only the current session using models supplied by new-api', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await app.evaluate(async ({ app: _app }, refs) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');

        let currentSessionModelRef = refs.alphaModelRef;
        const hostRequests: Array<{ path: string; method: string; body: unknown }> = [];
        const now = new Date().toISOString();
        let releaseClientModels: (() => void) | undefined;
        const clientModelsReady = new Promise<void>((resolve) => {
          releaseClientModels = resolve;
        });
        const originalHostInvoke = (ipcMain as unknown as {
          _invokeHandlers?: Map<string, (event: unknown, request: unknown) => Promise<unknown>>;
        })._invokeHandlers?.get('host:invoke');
        const makeResponse = (id: unknown, data: unknown) => ({
          id: typeof id === 'string' ? id : undefined,
          ok: true,
          data,
        });

        const workspacePath = '/tmp/clawx-model-picker-workspace';
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
            workspace: workspacePath,
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
            return { success: true, result: { sessions: [{ key: 'agent:main:main', displayName: 'main', model: currentSessionModelRef }] } };
          }
          if (method === 'sessions.patch') {
            const request = params as { key?: string; model?: string | null };
            currentSessionModelRef = request.model ?? refs.alphaModelRef;
            return {
              success: true,
              result: {
                entry: { model: currentSessionModelRef },
                resolved: {
                  modelProvider: currentSessionModelRef.split('/')[0],
                  model: currentSessionModelRef.split('/').slice(1).join('/'),
                },
              },
            };
          }
          if (method === 'sessions.create') {
            const request = params as { key?: string; model?: string | null };
            const model = request.model ?? refs.alphaModelRef;
            return {
              success: true,
              result: {
                entry: { key: request.key, model },
                resolved: {
                  modelProvider: model.split('/')[0],
                  model: model.split('/').slice(1).join('/'),
                },
              },
            };
          }
          if (method === 'chat.history') {
            return { success: true, result: { messages: [] } };
          }
          return { success: true, result: {} };
        });

        ipcMain.removeHandler('host:invoke');
        ipcMain.handle('host:invoke', async (event: unknown, request: {
          id?: string;
          module?: string;
          action?: string;
          payload?: Record<string, unknown>;
        }) => {
          const body = request?.payload ?? null;
          hostRequests.push({
            path: `${request?.module ?? ''}:${request?.action ?? ''}`,
            method: 'HOST',
            body,
          });

          if (request?.module === 'gateway' && request.action === 'status') {
            return makeResponse(request.id, { state: 'running', port: 18789, pid: 12345, gatewayReady: true });
          }
          if (request?.module === 'settings' && request.action === 'getAll') {
            return makeResponse(request.id, {
              language: 'en',
              setupComplete: true,
              chatWorkspacePath: workspacePath,
              recentWorkspacePaths: [workspacePath],
            });
          }
          if (request?.module === 'files' && request.action === 'resolveWorkspaceContext') {
            const workspaceRoot = typeof body?.workspaceRoot === 'string' ? body.workspaceRoot.trim() : '';
            const executionCwd = typeof body?.executionCwd === 'string' ? body.executionCwd.trim() : '';
            if (!workspaceRoot || !executionCwd) {
              return makeResponse(request.id, { ok: false, error: 'outsideSandbox' });
            }
            return makeResponse(request.id, { ok: true, workspaceRoot, executionCwd });
          }
          if (request?.module === 'chat' && request.action === 'loadAcpSession') {
            return makeResponse(request.id, { success: true, generation: 1 });
          }
          if (request?.module === 'chat' && request.action === 'sendAcpPrompt') {
            return makeResponse(request.id, { success: true, generation: 1 });
          }
          if (request?.module === 'gateway' && request.action === 'rpc') {
            const method = typeof body?.method === 'string' ? body.method : '';
            const params = body?.params ?? null;
            hostRequests.push({ path: `gateway:${method}`, method: 'RPC', body: params });
            if (method === 'sessions.list') {
              return makeResponse(request.id, { success: true, result: { sessions: [{ key: 'agent:main:main', displayName: 'main', model: currentSessionModelRef }] } });
            }
            if (method === 'sessions.patch') {
              const patch = params as { key?: string; model?: string | null };
              currentSessionModelRef = patch.model ?? refs.alphaModelRef;
              return makeResponse(request.id, {
                success: true,
                result: {
                  entry: { model: currentSessionModelRef },
                  resolved: {
                    modelProvider: currentSessionModelRef.split('/')[0],
                    model: currentSessionModelRef.split('/').slice(1).join('/'),
                  },
                },
              });
            }
            if (method === 'sessions.create') {
              const create = params as { key?: string; model?: string | null };
              const model = create.model ?? refs.alphaModelRef;
              return makeResponse(request.id, {
                success: true,
                result: {
                  entry: { key: create.key, model },
                  resolved: {
                    modelProvider: model.split('/')[0],
                    model: model.split('/').slice(1).join('/'),
                  },
                },
              });
            }
            if (method === 'chat.history') {
              return makeResponse(request.id, { success: true, result: { messages: [] } });
            }
            return makeResponse(request.id, { success: true, result: {} });
          }
          if (request?.module === 'agents' && request.action === 'list') {
            return makeResponse(request.id, agentsSnapshot());
          }
          if (request?.module === 'managedClientConfig' && request.action === 'textModels') {
            await clientModelsReady;
            return makeResponse(request.id, {
              defaultModel: 'smart-latest',
              models: [
                { id: 'smart-latest', label: 'Smart routing' },
                { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
              ],
            });
          }
          if (request?.module === 'providers' && request.action === 'accounts') {
            return makeResponse(request.id, [
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
              {
                id: 'openai-oauth',
                vendorId: 'openai',
                label: 'OpenAI',
                authMode: 'oauth_browser',
                model: 'openai/gpt-5.6',
                metadata: { customModels: ['gpt-5.5', 'openai/gpt-5.6'] },
                enabled: true,
                isDefault: false,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: 'moonshot-api-key',
                vendorId: 'moonshot',
                label: 'Moonshot',
                authMode: 'api_key',
                model: 'moonshot/kimi-k2.7',
                metadata: { customModels: ['kimi-k2.6', 'moonshot/kimi-k2.7'] },
                enabled: true,
                isDefault: false,
                createdAt: now,
                updatedAt: now,
              },
            ]);
          }
          if (request?.module === 'providers' && request.action === 'list') {
            return makeResponse(request.id, [
              { id: 'alpha1234', type: 'custom', name: 'Alpha', enabled: true, hasKey: true, keyMasked: 'sk-***', createdAt: now, updatedAt: now },
              { id: 'beta5678', type: 'custom', name: 'Beta', enabled: true, hasKey: true, keyMasked: 'sk-***', createdAt: now, updatedAt: now },
            ]);
          }
          if (request?.module === 'providers' && request.action === 'accountKeyInfo') {
            return makeResponse(request.id, [
              { accountId: 'alpha1234', hasKey: true, keyMasked: 'sk-***' },
              { accountId: 'beta5678', hasKey: true, keyMasked: 'sk-***' },
              { accountId: 'moonshot-api-key', hasKey: true, keyMasked: 'sk-***' },
            ]);
          }
          if (request?.module === 'providers' && request.action === 'vendors') {
            return makeResponse(request.id, [
              { id: 'openai', name: 'OpenAI', supportedAuthModes: ['api_key', 'oauth_browser'] },
              { id: 'moonshot', name: 'Moonshot', supportedAuthModes: ['api_key'] },
            ]);
          }
          if (request?.module === 'providers' && request.action === 'getDefaultAccount') {
            return makeResponse(request.id, { accountId: 'alpha1234' });
          }

          return originalHostInvoke?.(event, request) ?? makeResponse(request?.id, {});
        });

        (globalThis as typeof globalThis & { __chatModelPickerRequests?: typeof hostRequests }).__chatModelPickerRequests = hostRequests;
        (globalThis as typeof globalThis & {
          __releaseChatModelClientConfig?: () => void;
        }).__releaseChatModelClientConfig = releaseClientModels;
      }, { alphaModelRef, betaModelRef });

      const page = await getStableWindow(app);
      await page.reload();
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect.poll(async () => app.evaluate(() => (
        (globalThis as typeof globalThis & {
          __chatModelPickerRequests?: Array<{ path: string }>;
        }).__chatModelPickerRequests?.some((request) => request.path === 'managedClientConfig:textModels') ?? false
      ))).toBe(true);
      expect(await app.evaluate(() => (
        (globalThis as typeof globalThis & {
          __chatModelPickerRequests?: Array<{ path: string }>;
        }).__chatModelPickerRequests?.some((request) => request.path === 'agents:updateModel') ?? false
      ))).toBe(false);
      await app.evaluate(() => {
        (globalThis as typeof globalThis & {
          __releaseChatModelClientConfig?: () => void;
        }).__releaseChatModelClientConfig?.();
      });
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.send('gateway:status-changed', { state: 'running', port: 18789, pid: 12345, gatewayReady: true });
      });

      await expect(page.getByTestId('chat-model-picker-button')).toContainText('Smart routing');
      await page.getByTestId('chat-model-picker-button').click();
      await expect(page.getByTestId('chat-model-picker-menu')).toBeVisible();
      await expect(page.getByTestId('chat-model-picker-menu')).toContainText('DeepSeek V4 Pro');
      await expect(page.getByTestId('chat-model-picker-menu')).not.toContainText('Alpha');
      await expect(page.getByTestId('chat-model-picker-menu')).not.toContainText('Moonshot');
      await page.getByTestId('chat-model-picker-menu').getByRole('button', { name: 'DeepSeek V4 Pro' }).click();
      await expect(page.getByTestId('chat-model-picker-button')).toContainText('DeepSeek V4 Pro');

      await expect.poll(async () => app.evaluate((_electron, expectedModelRef) => (
        ((globalThis as typeof globalThis & {
          __chatModelPickerRequests?: Array<{ path: string; body: unknown }>;
        }).__chatModelPickerRequests ?? []).some((request) => (
          request.path === 'gateway:sessions.patch'
          && typeof request.body === 'object'
          && request.body !== null
          && (request.body as Record<string, unknown>).model === expectedModelRef
        ))
      ), betaModelRef)).toBe(true);

      const requests = await app.evaluate(() => (
        (globalThis as typeof globalThis & { __chatModelPickerRequests?: Array<{ path: string; method: string; body: unknown }> }).__chatModelPickerRequests ?? []
      ));
      expect(requests).toContainEqual({
        path: 'gateway:sessions.patch',
        method: 'RPC',
        body: { key: 'agent:main:main', model: betaModelRef },
      });
      expect(requests.some((request) =>
        request.path === 'agents:updateModel'
        || request.path === '/api/agents/main/model'
        || request.path === '/api/gateway/restart'
        || request.path === '/api/gateway/start'
        || request.path === 'gateway:restart'
        || request.path === 'gateway:start'
        || request.path === 'gateway:config.patch'
      )).toBe(false);

      await page.getByTestId('sidebar-new-chat').click();
      await expect(page.getByTestId('chat-model-picker-button')).toContainText('Smart routing');
      await page.getByTestId('chat-model-picker-button').click();
      await page.getByTestId('chat-model-picker-menu').getByRole('button', { name: 'DeepSeek V4 Pro' }).click();

      await expect.poll(async () => app.evaluate((_electron, expectedModelRef) => (
        ((globalThis as typeof globalThis & {
          __chatModelPickerRequests?: Array<{ path: string; body: unknown }>;
        }).__chatModelPickerRequests ?? []).some((request) => (
          request.path === 'gateway:sessions.create'
          && typeof request.body === 'object'
          && request.body !== null
          && (request.body as Record<string, unknown>).model === expectedModelRef
        ))
      ), betaModelRef)).toBe(true);

      const newSessionKey = await app.evaluate(() => {
        const create = ((globalThis as typeof globalThis & {
          __chatModelPickerRequests?: Array<{ path: string; body: unknown }>;
        }).__chatModelPickerRequests ?? []).findLast((request) => request.path === 'gateway:sessions.create');
        return typeof create?.body === 'object' && create.body !== null
          && typeof (create.body as Record<string, unknown>).key === 'string'
          ? (create.body as Record<string, string>).key
          : null;
      });
      expect(newSessionKey).toMatch(/^agent:main:session-/);

      await page.getByTestId('chat-composer-input').fill('Use the selected model in the new session');
      await page.getByTestId('chat-composer-input').press('Enter');
      await expect.poll(async () => app.evaluate((_electron, sessionKey) => (
        ((globalThis as typeof globalThis & {
          __chatModelPickerRequests?: Array<{ path: string; body: unknown }>;
        }).__chatModelPickerRequests ?? []).some((request) => (
          request.path === 'chat:sendAcpPrompt'
          && typeof request.body === 'object'
          && request.body !== null
          && (request.body as Record<string, unknown>).sessionKey === sessionKey
        ))
      ), newSessionKey)).toBe(true);

      const newSessionRequests = await app.evaluate(() => (
        (globalThis as typeof globalThis & {
          __chatModelPickerRequests?: Array<{ path: string; body: unknown }>;
        }).__chatModelPickerRequests ?? []
      ));
      const acpLoad = newSessionRequests.find((request) => (
        request.path === 'chat:loadAcpSession'
        && typeof request.body === 'object'
        && request.body !== null
        && (request.body as Record<string, unknown>).sessionKey === newSessionKey
      ));
      expect(acpLoad?.body).toMatchObject({
        sessionKey: newSessionKey,
        workspaceRoot: '~/.openclaw/workspace',
        cwd: '~/.openclaw/workspace',
      });
      expect(acpLoad?.body).not.toHaveProperty('createIfMissing');
    } finally {
      await closeElectronApp(app);
    }
  });
});
