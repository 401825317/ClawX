import type { ElectronApplication } from '@playwright/test';
import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

const VIDEO_POLICY = {
  defaultModel: 'grok-image-video',
  defaultAspectRatio: '16:9',
  defaultResolution: '480P',
  defaultDurationSeconds: 6,
  models: [
    {
      id: 'grok-image-video',
      label: 'Grok Video',
      modes: ['text-to-video', 'image-to-video'],
      aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
      resolutions: ['480P', '720P'],
      durations: [6, 10, 15],
      defaultAspectRatio: '16:9',
      defaultResolution: '480P',
      defaultDurationSeconds: 6,
      requiresImage: false,
    },
    {
      id: 'grok-video-1.5',
      label: 'Grok Video 1.5',
      modes: ['image-to-video'],
      aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
      resolutions: ['480P', '720P'],
      durations: [6, 10, 15],
      defaultAspectRatio: '16:9',
      defaultResolution: '480P',
      defaultDurationSeconds: 6,
      requiresImage: true,
    },
  ],
};

/** Keep this UI test independent from a developer's Gateway and managed account. */
async function installVideoComposerMocks(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ app: _app }, videoPolicy) => {
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
    const originalHostInvoke = (ipcMain as unknown as {
      _invokeHandlers?: Map<string, (event: unknown, request: unknown) => Promise<unknown>>;
    })._invokeHandlers?.get('host:invoke');
    const workspacePath = '/tmp/clawx-video-composer-workspace';
    const gatewayStatus = { state: 'running', gatewayReady: true, port: 18789, pid: 12345 };
    const respond = (id: unknown, data: unknown) => ({
      id: typeof id === 'string' ? id : undefined,
      ok: true,
      data,
    });
    const rpcResult = (method: string) => {
      if (method === 'sessions.list') return { success: true, result: { sessions: [] } };
      if (method === 'chat.history') return { success: true, result: { messages: [] } };
      return { success: true, result: {} };
    };

    ipcMain.removeHandler('gateway:status');
    ipcMain.handle('gateway:status', async () => gatewayStatus);
    ipcMain.removeHandler('gateway:rpc');
    ipcMain.handle('gateway:rpc', async (_event: unknown, method: string) => rpcResult(method));

    ipcMain.removeHandler('host:invoke');
    ipcMain.handle('host:invoke', async (event: unknown, request: {
      id?: string;
      module?: string;
      action?: string;
      payload?: Record<string, unknown>;
    }) => {
      if (request.module === 'gateway' && request.action === 'status') {
        return respond(request.id, gatewayStatus);
      }
      if (request.module === 'gateway' && request.action === 'rpc') {
        const method = typeof request.payload?.method === 'string' ? request.payload.method : '';
        return respond(request.id, rpcResult(method));
      }
      if (request.module === 'settings' && request.action === 'getAll') {
        return respond(request.id, {
          language: 'zh',
          setupComplete: true,
          chatWorkspacePath: workspacePath,
          recentWorkspacePaths: [workspacePath],
        });
      }
      if (request.module === 'files' && request.action === 'resolveWorkspaceContext') {
        return respond(request.id, {
          ok: true,
          workspaceRoot: workspacePath,
          executionCwd: workspacePath,
        });
      }
      if (request.module === 'agents' && request.action === 'list') {
        return respond(request.id, {
          success: true,
          agents: [{
            id: 'main',
            name: 'Main',
            isDefault: true,
            modelDisplay: 'smart-latest',
            modelRef: 'openai/smart-latest',
            inheritedModel: true,
            workspace: workspacePath,
            agentDir: '~/.openclaw/agents/main/agent',
            mainSessionKey: 'agent:main:main',
            channelTypes: [],
          }],
          defaultAgentId: 'main',
          defaultModelRef: 'openai/smart-latest',
          configuredChannelTypes: [],
          channelOwners: {},
          channelAccountOwners: {},
        });
      }
      if (request.module === 'managedClientConfig' && request.action === 'textModels') {
        return respond(request.id, {
          defaultModel: 'smart-latest',
          models: [{ id: 'smart-latest', label: 'Smart' }],
        });
      }
      if (request.module === 'managedClientConfig' && request.action === 'videoModels') {
        return respond(request.id, videoPolicy);
      }
      if (request.module === 'chat' && request.action === 'loadAcpSession') {
        return respond(request.id, { success: true, generation: 1 });
      }
      if (request.module === 'skills' && request.action === 'quickAccess') {
        return respond(request.id, { success: true, skills: [] });
      }
      return originalHostInvoke?.(event, request) ?? respond(request.id, {});
    });
  }, VIDEO_POLICY);
}

test.describe('ClawX video generation options', () => {
  test('shows the five managed Grok aspect ratios in a compact picker', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installVideoComposerMocks(app);
      const page = await getStableWindow(app);
      await page.reload();
      await expect(page.getByTestId('main-layout')).toBeVisible();

      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('gateway:status-changed', {
          state: 'running',
          gatewayReady: true,
          port: 18789,
          pid: 12345,
        });
      });

      const videoMode = page.getByTestId('chat-composer-mode-video');
      await expect(videoMode).toBeEnabled();
      await videoMode.click();

      await expect(page.getByTestId('chat-video-model')).toHaveValue('grok-image-video');
      await expect(page.getByTestId('chat-video-aspect-trigger')).toHaveText('16:9');
      await expect(page.getByTestId('chat-video-resolution')).toHaveValue('480P');
      await expect(page.getByTestId('chat-video-duration')).toHaveValue('6');

      await page.getByTestId('chat-video-aspect-trigger').click();
      const menu = page.getByTestId('chat-video-aspect-menu');
      const options = menu.getByRole('menuitemradio');
      await expect(menu).toBeVisible();
      await expect(options).toHaveCount(5);
      await expect(options.nth(0)).toHaveText(/2:3\s*高/);
      await expect(options.nth(1)).toHaveText(/3:2\s*宽/);
      await expect(options.nth(2)).toHaveText(/1:1\s*正方形/);
      await expect(options.nth(3)).toHaveText(/9:16\s*垂直/);
      await expect(options.nth(4)).toHaveText(/16:9\s*宽屏/);

      const [menuBox, optionBox] = await Promise.all([menu.boundingBox(), options.first().boundingBox()]);
      expect(menuBox?.width).toBeLessThanOrEqual(164);
      expect(optionBox?.height).toBeLessThanOrEqual(34);
      await expect(options.first()).toHaveCSS('font-size', '12px');

      await page.getByTestId('chat-video-aspect-2-3').click();
      await expect(page.getByTestId('chat-video-aspect-trigger')).toHaveText('2:3');
      await page.getByTestId('chat-video-resolution').selectOption('720P');
      await page.getByTestId('chat-video-duration').selectOption('15');
      await expect(page.getByTestId('chat-video-resolution')).toHaveValue('720P');
      await expect(page.getByTestId('chat-video-duration')).toHaveValue('15');
    } finally {
      await closeElectronApp(app);
    }
  });
});
