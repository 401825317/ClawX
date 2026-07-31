import { completeSetup, expect, installIpcMocks, test } from './fixtures/electron';

const INTERNAL_PROFILE_SESSION_KEY = 'agent:main:uclaw-profile-e2e';
const CREATED_AGENT_SESSION_KEY = 'agent:atlas:main';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

const generatedProfile = {
  roleName: 'Research lead',
  personaName: 'Atlas',
  responsibility: 'Find and verify primary sources.',
  capabilities: ['Source research'],
  boundaries: ['Do not invent sources'],
  workspaceInstructions: 'Verify claims with primary sources.',
  welcomeMessage: 'What should I research?',
  avatarId: 'strategist',
};

const createdProfile = {
  ...generatedProfile,
  avatarId: 'analyst',
  createdAt: '2026-07-31T00:00:00.000Z',
  updatedAt: '2026-07-31T00:00:00.000Z',
};

const mainAgent = {
  id: 'main',
  name: 'Main Agent',
  isDefault: true,
  modelDisplay: 'Default model',
  modelRef: 'openai/gpt-5',
  overrideModelRef: null,
  inheritedModel: true,
  workspace: '~/.openclaw/workspace',
  agentDir: '~/.openclaw/agents/main/agent',
  mainSessionKey: 'agent:main:main',
  channelTypes: [],
  profile: null,
};

const createdAgent = {
  id: 'atlas',
  name: 'Atlas',
  isDefault: false,
  modelDisplay: 'Default model',
  modelRef: 'openai/gpt-5',
  overrideModelRef: null,
  inheritedModel: true,
  workspace: '~/.openclaw/workspace-atlas',
  agentDir: '~/.openclaw/agents/atlas/agent',
  mainSessionKey: CREATED_AGENT_SESSION_KEY,
  channelTypes: [],
  profile: createdProfile,
};

function agentsSnapshot(agents: Array<typeof mainAgent | typeof createdAgent>, createdAgentId?: string) {
  return {
    success: true,
    agents,
    defaultAgentId: 'main',
    defaultModelRef: 'openai/gpt-5',
    configuredChannelTypes: [],
    channelOwners: {},
    channelAccountOwners: {},
    ...(createdAgentId ? { createdAgentId } : {}),
  };
}

test.describe('Agent persona creation', () => {
  test('creates through typed Host API and keeps the internal profile session hidden', async ({ electronApp, page }) => {
    const sessions = {
      sessions: [
        {
          key: INTERNAL_PROFILE_SESSION_KEY,
          displayName: 'Internal profile generation',
          updatedAt: Date.now(),
        },
        {
          key: CREATED_AGENT_SESSION_KEY,
          displayName: 'Atlas research',
          updatedAt: Date.now() - 1,
        },
      ],
    };
    const generationInput = {
      roleName: 'Research lead',
      responsibility: 'Find and verify primary sources.',
      avatarId: 'analyst',
      locale: 'en',
    };
    const createInput = {
      name: 'Atlas',
      inheritWorkspace: false,
      profile: { ...generatedProfile, avatarId: 'analyst' },
    };

    await installIpcMocks(electronApp, {
      gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
      gatewayRpc: {
        [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: sessions,
        [stableStringify(['sessions.list', {}])]: sessions,
        [stableStringify(['chat.history', null])]: { messages: [] },
      },
      hostApi: {
        [stableStringify(['agents', 'list', null])]: agentsSnapshot([mainAgent, createdAgent]),
        [stableStringify(['agents', 'generateProfile', generationInput])]: {
          success: true,
          profile: generatedProfile,
        },
        [stableStringify(['agents', 'create', createInput])]: agentsSnapshot([mainAgent, createdAgent], 'atlas'),
        [stableStringify(['channels', 'accounts', null])]: { success: true, channels: [] },
      },
      recordHostInvocations: true,
    });

    await completeSetup(page);
    await page.getByTestId('sidebar-nav-agents').click();
    await expect(page.getByTestId('agents-page')).toBeVisible();

    await page.getByTestId('agents-add-button').click();
    await page.getByTestId('agent-create-role-name').fill('Research lead');
    await page.getByTestId('agent-create-responsibility').fill('Find and verify primary sources.');
    await page.getByTestId('agent-create-avatar-analyst').click();
    await expect(page.getByTestId('agent-create-avatar-analyst')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('agent-create-submit').click();

    await expect(page.getByTestId('chat-page')).toBeVisible();
    await expect(page.getByTestId('chat-agent-switcher')).toContainText('Atlas');
    await expect(page.getByTestId('chat-agent-avatar-atlas')).toBeVisible();
    await expect(page.getByTestId(`sidebar-session-${INTERNAL_PROFILE_SESSION_KEY}`)).toHaveCount(0);

    const invocations = await electronApp.evaluate(() => (
      (globalThis as unknown as {
        __e2eHostInvocations?: Array<{ module?: string; action?: string; payload?: unknown }>;
      }).__e2eHostInvocations ?? []
    ));
    expect(invocations).toContainEqual({ module: 'agents', action: 'generateProfile', payload: generationInput });
    expect(invocations).toContainEqual({ module: 'agents', action: 'create', payload: createInput });
  });
});
