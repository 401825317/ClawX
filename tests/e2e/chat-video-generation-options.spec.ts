import type { ElectronApplication } from '@playwright/test';
import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

const VIDEO_GENERATION_TASK_ID = '27c3d85f-0d5e-4bf5-b5d3-c8316db9ddde';

const VIDEO_POLICY = {
  defaultModel: 'grok-image-video',
  defaultAspectRatio: '16:9',
  defaultResolution: '480P',
  defaultDurationSeconds: 6,
  models: [
    {
      id: 'grok-image-video',
      label: 'Grok Video',
      modes: ['text-to-video'],
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

async function emitAcpSessionUpdate(app: ElectronApplication, update: Record<string, unknown>): Promise<void> {
  await app.evaluate(async ({ app: _app }, payload) => {
    const { BrowserWindow } = process.mainModule!.require('electron') as typeof import('electron');
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('chat:acp-session-update', {
        sessionKey: 'agent:main:main',
        generation: 1,
        notification: {
          sessionId: 'agent:main:main',
          update: payload,
        },
      });
    }
  }, update);
}

async function emitChatRuntimeEvent(app: ElectronApplication, event: Record<string, unknown>): Promise<void> {
  await app.evaluate(async ({ app: _app }, payload) => {
    const { BrowserWindow } = process.mainModule!.require('electron') as typeof import('electron');
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('chat:runtime-event', payload);
    }
  }, event);
}

test.describe('ClawX video generation options', () => {
  test('shows the five managed Grok aspect ratios in a compact picker', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installVideoComposerMocks(app);
      const page = await getStableWindow(app);
      await page.reload();
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await page.setViewportSize({ width: 720, height: 720 });

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

      await expect(page.getByTestId('chat-video-model')).toHaveCount(0);
      const optionsTrigger = page.getByTestId('chat-video-options-trigger');
      await expect(optionsTrigger).toContainText('16:9');
      await expect(optionsTrigger).toContainText('480P');
      await expect(optionsTrigger).toContainText('6s');

      await optionsTrigger.click();
      await page.getByTestId('chat-video-aspect-row').hover();
      const menu = page.getByTestId('chat-video-aspect-menu');
      const options = menu.getByRole('menuitemradio');
      await expect(menu).toBeVisible();
      await expect(options).toHaveCount(5);
      await options.first().hover();
      await expect(options.nth(0)).toHaveText(/2:3\s*高/);
      await expect(options.nth(1)).toHaveText(/3:2\s*宽/);
      await expect(options.nth(2)).toHaveText(/1:1\s*正方形/);
      await expect(options.nth(3)).toHaveText(/9:16\s*垂直/);
      await expect(options.nth(4)).toHaveText(/16:9\s*宽屏/);

      const [menuBox, optionBox] = await Promise.all([menu.boundingBox(), options.first().boundingBox()]);
      await expect(menu).toHaveCSS('min-width', '132px');
      expect(menuBox?.width).toBeGreaterThanOrEqual(124);
      expect(menuBox?.width).toBeLessThanOrEqual(176);
      expect(optionBox?.height).toBeLessThanOrEqual(34);
      await expect(options.first()).toHaveCSS('font-size', '12px');
      await expect(page.getByTestId('chat-video-aspect-1-1-description')).toHaveText('正方形');
      expect(await page.getByTestId('chat-video-aspect-1-1-description').evaluate((element) => (
        element.scrollWidth <= element.clientWidth
      ))).toBe(true);

      await page.getByTestId('chat-video-aspect-2-3').click();
      await expect(optionsTrigger).toContainText('2:3');
      await expect(page.getByTestId('chat-video-options-menu')).toBeHidden();
      await optionsTrigger.click();
      await page.getByTestId('chat-video-resolution-row').hover();
      await page.getByTestId('chat-video-resolution-option-720p').click();
      await expect(page.getByTestId('chat-video-options-menu')).toBeHidden();
      await optionsTrigger.click();
      await page.getByTestId('chat-video-duration-row').hover();
      await page.getByTestId('chat-video-duration-option-15').click();
      await expect(optionsTrigger).toContainText('720P');
      await expect(optionsTrigger).toContainText('15s');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('blocks another send while an asynchronous video task is running', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installVideoComposerMocks(app);
      const page = await getStableWindow(app);
      const rendererErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') rendererErrors.push(message.text());
      });
      page.on('pageerror', (error) => rendererErrors.push(error.message));
      await page.reload();
      await expect(page.getByTestId('main-layout')).toBeVisible();

      await emitAcpSessionUpdate(app, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'video-tool',
        status: 'completed',
        content: [{
          type: 'content',
          content: {
            type: 'text',
            text: `Background task started for video generation (${VIDEO_GENERATION_TASK_ID}).`,
          },
        }],
      });

      const indicator = page.getByTestId('chat-composer-video-generation-indicator');
      await expect(indicator).toBeVisible();
      await expect(indicator).toContainText('视频生成中，请稍候');
      await expect(page.getByTestId('chat-composer-image-generation-indicator')).toHaveCount(0);

      const input = page.getByTestId('chat-composer-input');
      await input.fill('视频完成后发送这条消息');
      await expect(input).toHaveValue('视频完成后发送这条消息');
      await expect(page.getByTestId('chat-composer-send')).toBeDisabled();

      await emitChatRuntimeEvent(app, {
        type: 'run.started',
        runId: `video_generate:${VIDEO_GENERATION_TASK_ID}:ok`,
        sessionKey: `video_generate:${VIDEO_GENERATION_TASK_ID}`,
      });
      await expect(indicator).toBeVisible();

      await emitChatRuntimeEvent(app, {
        type: 'run.ended',
        status: 'completed',
        runId: `video_generate:${VIDEO_GENERATION_TASK_ID}:ok`,
        sessionKey: `video_generate:${VIDEO_GENERATION_TASK_ID}`,
      });
      await expect(indicator).toHaveCount(0);
      await expect(page.getByTestId('chat-composer-send')).toBeEnabled();
      expect(rendererErrors).toEqual([]);
    } finally {
      await closeElectronApp(app);
    }
  });
});
