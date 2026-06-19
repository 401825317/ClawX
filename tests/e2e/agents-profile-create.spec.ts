import type { ElectronApplication } from '@playwright/test';
import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

type CapturedAgentRequest = {
  profileRequest: Record<string, unknown> | null;
  createRequest: Record<string, unknown> | null;
};

async function installAgentCreateMocks(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ app: _app }) => {
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');

    const respond = (json: unknown, status = 200) => ({
      ok: true,
      data: {
        status,
        ok: status >= 200 && status < 300,
        json,
      },
    });

    const capture: CapturedAgentRequest = {
      profileRequest: null,
      createRequest: null,
    };
    let created = false;
    const mainAgent = {
      id: 'main',
      name: 'Main Agent',
      isDefault: true,
      modelDisplay: '智能路由',
      modelRef: 'lingzhiwuxian/smart-latest',
      overrideModelRef: null,
      inheritedModel: true,
      workspace: '~/.openclaw/workspace',
      agentDir: '~/.openclaw/agents/main/agent',
      mainSessionKey: 'agent:main:main',
      channelTypes: [],
      profile: null,
    };

    const buildGeneratedProfile = (body: Record<string, unknown>) => ({
      roleName: '增长营销专家',
      personaName: 'Mira · 营销专家',
      responsibility: '把粗略的营销需求拆成内容、活动、投放和复盘四类可执行工作。',
      capabilities: ['制定活动策略', '撰写营销文案', '规划投放实验', '复盘转化数据'],
      boundaries: ['缺少产品定位时先追问', '涉及预算时先确认约束'],
      workspaceInstructions: '优先给出可执行清单、关键假设和下一步验证方式。',
      welcomeMessage: '我是你的营销专家 Mira，我刚上线。你可以继续为我命名或调整我的职责。',
      avatarId: String(body.avatarId || 'strategist'),
    });

    const createdAgent = () => ({
      id: 'mira-marketing',
      name: 'Mira · 营销专家',
      isDefault: false,
      modelDisplay: '智能路由',
      modelRef: 'lingzhiwuxian/smart-latest',
      overrideModelRef: null,
      inheritedModel: true,
      workspace: '~/.openclaw/workspace-mira-marketing',
      agentDir: '~/.openclaw/agents/mira-marketing/agent',
      mainSessionKey: 'agent:mira-marketing:main',
      channelTypes: [],
      profile: {
        agentId: 'mira-marketing',
        ...(capture.createRequest?.profile as Record<string, unknown>),
        createdAt: '2026-06-18T00:00:00.000Z',
        updatedAt: '2026-06-18T00:00:00.000Z',
      },
    });

    const snapshot = () => ({
      success: true,
      agents: created ? [mainAgent, createdAgent()] : [mainAgent],
      defaultAgentId: 'main',
      defaultModelRef: 'lingzhiwuxian/smart-latest',
      configuredChannelTypes: [],
      channelOwners: {},
      channelAccountOwners: {},
      ...(created ? { createdAgentId: 'mira-marketing' } : {}),
    });

    (globalThis as typeof globalThis & { __uclawAgentE2E?: CapturedAgentRequest }).__uclawAgentE2E = capture;

    ipcMain.removeHandler('hostapi:fetch');
    ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string; method?: string; body?: string | null }) => {
      const path = request?.path ?? '';
      const method = request?.method ?? 'GET';
      const body = request?.body ? JSON.parse(request.body) as Record<string, unknown> : {};

      if (path === '/api/agents' && method === 'GET') return respond(snapshot());
      if (path === '/api/agents/generate-profile' && method === 'POST') {
        capture.profileRequest = body;
        return respond({ success: true, profile: buildGeneratedProfile(body) });
      }
      if (path === '/api/agents' && method === 'POST') {
        capture.createRequest = body;
        created = true;
        return respond(snapshot());
      }

      if (path === '/api/channels/accounts' && method === 'GET') {
        return respond({ success: true, channels: [] });
      }
      if (path === '/api/provider-accounts' && method === 'GET') return respond([]);
      if (path === '/api/provider-accounts/key-info' && method === 'GET') return respond([]);
      if (path === '/api/provider-vendors' && method === 'GET') return respond([]);
      if (path === '/api/provider-accounts/default' && method === 'GET') return respond({ accountId: null });
      if (path === '/api/junfeiai/status' && method === 'GET') return respond({ managed: false });
      if (path === '/api/junfeiai/client-config' && method === 'GET') {
        return respond({ announcements: { enabled: false, items: [] }, support: { enabled: false } });
      }
      if (path === '/api/chat/sessions' && method === 'GET') {
        return respond({
          success: true,
          result: {
            sessions: created
              ? [
                { key: 'agent:main:main', label: 'Main Agent', status: 'completed' },
                { key: 'agent:mira-marketing:main', label: 'Mira · 营销专家', status: 'completed' },
              ]
              : [{ key: 'agent:main:main', label: 'Main Agent', status: 'completed' }],
          },
        });
      }
      if (path === '/api/chat/history' && method === 'POST') {
        return respond({
          success: true,
          result: {
            messages: [],
            thinkingLevel: null,
          },
        });
      }
      if (path === '/api/sessions/summaries' && method === 'POST') {
        return respond({ success: true, summaries: [] });
      }

      return respond({});
    });

    ipcMain.removeHandler('gateway:status');
    ipcMain.handle('gateway:status', async () => ({ state: 'running', port: 18789, pid: 12345, gatewayReady: true }));
  });
}

async function installAgentStatusMocks(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ app: _app }) => {
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');

    const respond = (json: unknown, status = 200) => ({
      ok: true,
      data: {
        status,
        ok: status >= 200 && status < 300,
        json,
      },
    });

    const agents = [
      {
        id: 'main',
        name: 'Main Agent',
        isDefault: true,
        modelDisplay: '智能路由',
        modelRef: 'lingzhiwuxian/smart-latest',
        overrideModelRef: null,
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
        profile: null,
      },
      {
        id: 'research',
        name: 'Research Agent',
        isDefault: false,
        modelDisplay: '智能路由',
        modelRef: 'lingzhiwuxian/smart-latest',
        overrideModelRef: null,
        inheritedModel: true,
        workspace: '~/.openclaw/workspace-research',
        agentDir: '~/.openclaw/agents/research/agent',
        mainSessionKey: 'agent:research:main',
        channelTypes: [],
        profile: {
          roleName: 'Researcher',
          personaName: 'Research Agent',
          responsibility: 'Research market signals and summarize useful findings.',
          capabilities: ['Research'],
          boundaries: [],
          workspaceInstructions: '',
          welcomeMessage: '',
          avatarId: 'analyst',
          agentId: 'research',
          createdAt: '2026-06-18T00:00:00.000Z',
          updatedAt: '2026-06-18T00:00:00.000Z',
        },
      },
    ];

    ipcMain.removeHandler('hostapi:fetch');
    ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string; method?: string; body?: string | null }) => {
      const path = request?.path ?? '';
      const method = request?.method ?? 'GET';

      if (path === '/api/agents' && method === 'GET') {
        return respond({
          success: true,
          agents,
          defaultAgentId: 'main',
          defaultModelRef: 'lingzhiwuxian/smart-latest',
          configuredChannelTypes: [],
          channelOwners: {},
          channelAccountOwners: {},
        });
      }
      if (path === '/api/channels/accounts' && method === 'GET') return respond({ success: true, channels: [] });
      if (path === '/api/provider-accounts' && method === 'GET') return respond([]);
      if (path === '/api/provider-accounts/key-info' && method === 'GET') return respond([]);
      if (path === '/api/provider-vendors' && method === 'GET') return respond([]);
      if (path === '/api/provider-accounts/default' && method === 'GET') return respond({ accountId: null });
      if (path === '/api/junfeiai/status' && method === 'GET') return respond({ managed: false });
      if (path === '/api/junfeiai/client-config' && method === 'GET') {
        return respond({ announcements: { enabled: false, items: [] }, support: { enabled: false } });
      }
      if (path === '/api/chat/sessions' && method === 'GET') {
        return respond({
          success: true,
          result: {
            sessions: [
              { key: 'agent:main:main', label: 'Main Agent', status: 'completed', hasActiveRun: false },
              { key: 'agent:research:main', label: 'Research Agent', status: 'running', hasActiveRun: true },
            ],
          },
        });
      }
      if (path === '/api/chat/history' && method === 'POST') {
        return respond({
          success: true,
          result: {
            messages: [],
            thinkingLevel: null,
          },
        });
      }
      if (path === '/api/sessions/summaries' && method === 'POST') {
        return respond({ success: true, summaries: [] });
      }

      return respond({});
    });

    ipcMain.removeHandler('gateway:status');
    ipcMain.handle('gateway:status', async () => ({ state: 'running', port: 18789, pid: 12345, gatewayReady: true }));
  });
}

async function getCapturedAgentRequests(app: ElectronApplication): Promise<CapturedAgentRequest> {
  return await app.evaluate(async ({ app: _app }) => {
    return (globalThis as typeof globalThis & { __uclawAgentE2E?: CapturedAgentRequest }).__uclawAgentE2E ?? {
      profileRequest: null,
      createRequest: null,
    };
  });
}

test.describe('Agent persona creation', () => {
  test('generates a profile, creates the Agent, and opens its chat', async ({ launchElectronApp }) => {
    const electronApp = await launchElectronApp({ skipSetup: true });

    try {
      await installAgentCreateMocks(electronApp);
      const page = await getStableWindow(electronApp);
      await expect(page.getByTestId('main-layout')).toBeVisible();

      await page.getByTestId('sidebar-nav-agents').click();
      await expect(page.getByTestId('agents-page')).toBeVisible();

      await page.getByTestId('agents-add-button').click();
      await expect(page.getByTestId('agent-create-dialog')).toBeVisible();

      await page.getByTestId('agent-create-role-name').fill('营销专家');
      await page.getByTestId('agent-create-responsibility').fill('帮我处理营销内容');
      await page.getByTestId('agent-create-avatar-creator').click();
      await page.getByTestId('agent-create-submit').click();

      await expect(page.getByTestId('chat-page')).toBeVisible();
      await expect(page.getByTestId('chat-agent-switcher')).toContainText('Mira · 营销专家');

      const captured = await getCapturedAgentRequests(electronApp);
      expect(captured.profileRequest).toMatchObject({
        roleName: '营销专家',
        responsibility: '帮我处理营销内容',
        avatarId: 'creator',
      });
      expect(captured.createRequest).toMatchObject({
        name: 'Mira · 营销专家',
        profile: expect.objectContaining({
          avatarId: 'creator',
          personaName: 'Mira · 营销专家',
          welcomeMessage: expect.stringContaining('我刚上线'),
        }),
      });
    } finally {
      await closeElectronApp(electronApp);
    }
  });

  test('shows agent work status and opens a running agent chat from the card', async ({ launchElectronApp }) => {
    const electronApp = await launchElectronApp({ skipSetup: true });

    try {
      await installAgentStatusMocks(electronApp);
      const page = await getStableWindow(electronApp);
      await expect(page.getByTestId('main-layout')).toBeVisible();

      await page.getByTestId('sidebar-nav-agents').click();
      await expect(page.getByTestId('agents-page')).toBeVisible();

      await expect(page.getByTestId('agent-card-research')).toContainText('Research Agent');
      await expect(page.getByTestId('agent-card-research').getByTestId('agent-work-status')).toContainText('正在执行任务…');
      await expect(page.getByTestId('agent-card-main').getByTestId('agent-work-status')).toContainText('任务已完成');

      await page.getByTestId('agent-card-research').click();

      await expect(page.getByTestId('chat-page')).toBeVisible();
      await expect(page.getByTestId('chat-agent-switcher')).toContainText('Research Agent');
    } finally {
      await closeElectronApp(electronApp);
    }
  });
});
