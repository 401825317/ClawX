import type { ElectronApplication } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  test,
} from './fixtures/electron';
import type {
  ManagedClientImageModelPolicy,
  ManagedClientRuntimeConfig,
} from '../../shared/managed-client-config';

const IMAGE_MODEL_POLICY = {
  defaultModel: 'gpt-image-2',
  defaultSize: '1024x1024',
  defaultQuality: 'medium',
  models: [{
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    sizes: ['1024x1024', '1536x1024', '1024x1536'],
    qualities: ['low', 'medium', 'high'],
    defaultSize: '1024x1024',
    defaultQuality: 'medium',
    supportsEditing: true,
  }],
} satisfies ManagedClientImageModelPolicy;

function runtimeConfig(ecommerceEnabled: boolean): ManagedClientRuntimeConfig {
  return {
    observability: {
      enabled: false,
      rolloutPercentage: 0,
      tunnelPath: '/api/clawx/observability/envelope',
      crashSampleRate: 1,
      handledErrorSampleRate: 0.2,
      tracesSampleRate: 0.05,
      artifactSampleRate: 0.2,
      maxEventsPerHour: 30,
    },
    features: {
      artifacts: {
        enabled: true,
        rolloutPercentage: 100,
        eligible: true,
        modelAlias: 'uclaw-artifact-v1',
        policyVersion: 'v1',
      },
      ecommerceMainImage: {
        enabled: ecommerceEnabled,
        rolloutPercentage: ecommerceEnabled ? 100 : 0,
        eligible: ecommerceEnabled,
        skillVersion: 'v1',
      },
      htmlPreview: {
        enabled: false,
        rolloutPercentage: 0,
        eligible: false,
      },
      longTermRules: {
        enabled: false,
        rolloutPercentage: 0,
        eligible: false,
      },
    },
  };
}

async function installImageComposerMocks(
  app: ElectronApplication,
  workspacePath: string,
  ecommerceEnabled: boolean,
): Promise<void> {
  await app.evaluate(async ({ app: _app }, payload) => {
    const { config, imageModelPolicy, workspacePath } = payload;
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
    const originalHostInvoke = (ipcMain as unknown as {
      _invokeHandlers?: Map<string, (event: unknown, request: unknown) => Promise<unknown>>;
    })._invokeHandlers?.get('host:invoke');
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
        return respond(request.id, rpcResult(String(request.payload?.method ?? '')));
      }
      if (request.module === 'settings' && request.action === 'getAll') {
        return respond(request.id, {
          language: 'en',
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
      if (request.module === 'managedClientConfig' && request.action === 'imageModels') {
        return respond(request.id, imageModelPolicy);
      }
      if (request.module === 'managedClientConfig' && request.action === 'videoModels') {
        return respond(request.id, null);
      }
      if (request.module === 'managedClientConfig' && request.action === 'runtimeConfig') {
        return respond(request.id, config);
      }
      if (request.module === 'chat' && request.action === 'loadAcpSession') {
        return respond(request.id, { success: true, generation: 1 });
      }
      if (request.module === 'skills' && request.action === 'quickAccess') {
        return respond(request.id, { success: true, skills: [] });
      }
      return originalHostInvoke?.(event, request) ?? respond(request.id, {});
    });
  }, {
    config: runtimeConfig(ecommerceEnabled),
    imageModelPolicy: IMAGE_MODEL_POLICY,
    workspacePath,
  });
}

async function openChat(app: ElectronApplication) {
  const page = await getStableWindow(app);
  try {
    await page.reload();
  } catch (error) {
    if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
  }
  await expect(page.getByTestId('main-layout')).toBeVisible();
  await expect(page.getByTestId('chat-page')).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('gateway:status-changed', {
      state: 'running',
      gatewayReady: true,
      port: 18789,
      pid: 12345,
    });
  });
  await expect(page.getByTestId('chat-composer-input')).toBeEnabled();
  return page;
}

test.describe('Ecommerce main image preset', () => {
  test('exposes and selects the preset only for an eligible rollout', async ({ launchElectronApp, homeDir }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const workspacePath = join(homeDir, '.openclaw', 'workspace');
      await mkdir(workspacePath, { recursive: true });
      await installImageComposerMocks(app, workspacePath, true);
      const page = await openChat(app);
      const imageMode = page.getByTestId('chat-composer-mode-image');
      await expect(imageMode).toBeEnabled();
      await imageMode.click();
      const trigger = page.getByTestId('chat-image-options-trigger');
      await expect(trigger).toBeVisible();
      await trigger.click();
      await page.getByTestId('chat-image-preset-row').hover();
      const preset = page.getByTestId('chat-image-preset-ecommerce-main-image');
      await expect(preset).toBeVisible();
      await preset.click();
      await expect(trigger).toContainText('Ecommerce main image');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('does not expose the preset when the feature rollout is disabled', async ({ launchElectronApp, homeDir }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const workspacePath = join(homeDir, '.openclaw', 'workspace');
      await mkdir(workspacePath, { recursive: true });
      await installImageComposerMocks(app, workspacePath, false);
      const page = await openChat(app);
      const imageMode = page.getByTestId('chat-composer-mode-image');
      await expect(imageMode).toBeEnabled();
      await imageMode.click();
      const trigger = page.getByTestId('chat-image-options-trigger');
      await expect(trigger).toBeVisible();
      await trigger.click();
      await expect(page.getByTestId('chat-image-aspect-row')).toBeVisible();
      await expect(page.getByTestId('chat-image-preset-row')).toHaveCount(0);
      await expect(page.getByTestId('chat-image-preset-ecommerce-main-image')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });
});
