import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pathState = vi.hoisted(() => ({ root: '' }));

vi.mock('@electron/utils/paths', () => ({
  expandOpenClawPath: (value: string) => value,
  getOpenClawConfigDir: () => pathState.root,
  resolveOpenClawStateDir: () => pathState.root,
}));

vi.mock('@electron/utils/logger', () => ({
  logger: { warn: vi.fn() },
  warn: vi.fn(),
}));

describe('agent profile persistence', () => {
  beforeEach(async () => {
    pathState.root = await mkdtemp(join(tmpdir(), 'uclaw-agent-profile-'));
  });

  afterEach(async () => {
    await rm(pathState.root, { recursive: true, force: true });
  });

  it('round-trips normalized profiles in the active OpenClaw config directory', async () => {
    const { readAgentProfiles, upsertAgentProfile } = await import('@electron/utils/agent-profile');

    const saved = await upsertAgentProfile('planner', {
      roleName: ' Product Lead ',
      personaName: ' Lin ',
      responsibility: ' Own planning ',
      capabilities: ['Roadmaps', '', 'Delivery'],
      boundaries: ['Confirm high-impact changes'],
      workspaceInstructions: ' Keep work traceable ',
      welcomeMessage: ' Ready to begin ',
      avatarId: 'strategist',
    });
    const profiles = await readAgentProfiles();

    expect(profiles.planner).toEqual(saved);
    expect(saved).toMatchObject({
      agentId: 'planner',
      roleName: 'Product Lead',
      personaName: 'Lin',
      responsibility: 'Own planning',
      capabilities: ['Roadmaps', 'Delivery'],
    });
    expect(JSON.parse(await readFile(join(pathState.root, 'uclaw-agent-profiles.json'), 'utf8')))
      .toHaveProperty('planner.personaName', 'Lin');
  });

  it('replaces the managed AGENTS block without duplicating user content', async () => {
    const { upsertAgentProfile, writeAgentProfileWorkspaceFiles } = await import('@electron/utils/agent-profile');
    const workspace = join(pathState.root, 'workspace-planner');
    const profile = await upsertAgentProfile('planner', {
      roleName: 'Product Lead',
      personaName: 'Lin',
      responsibility: 'Own planning',
      capabilities: ['Roadmaps'],
      boundaries: ['Confirm scope changes'],
      workspaceInstructions: 'Keep work traceable.',
      welcomeMessage: 'Ready to begin.',
      avatarId: 'strategist',
    });

    await writeAgentProfileWorkspaceFiles({ id: 'planner', workspace }, profile);
    await writeAgentProfileWorkspaceFiles({ id: 'planner', workspace }, {
      ...profile,
      responsibility: 'Own planning and delivery',
    });

    const agentsMd = await readFile(join(workspace, 'AGENTS.md'), 'utf8');
    const profileMd = await readFile(join(workspace, 'UCLAW_AGENT_PROFILE.md'), 'utf8');
    expect(agentsMd.match(/UCLAW_AGENT_PROFILE_START/g)).toHaveLength(1);
    expect(agentsMd).toContain('UCLAW_AGENT_PROFILE.md');
    expect(profileMd).toContain('Own planning and delivery');
  });

  it('writes an OpenClaw v3 assistant welcome transcript and session record', async () => {
    const { appendAgentWelcomeMessage } = await import('@electron/utils/chat-session-welcome-message');

    await appendAgentWelcomeMessage({
      sessionKey: 'agent:planner:main',
      content: 'Ready to plan the next milestone.',
      label: 'Lin',
    });

    const sessionsDir = join(pathState.root, 'agents', 'planner', 'sessions');
    const sessions = JSON.parse(await readFile(join(sessionsDir, 'sessions.json'), 'utf8'));
    const record = sessions['agent:planner:main'];
    const lines = (await readFile(record.sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(lines[0]).toMatchObject({ type: 'session', version: 3, id: record.sessionId });
    expect(lines[1]).toMatchObject({
      type: 'message',
      source: 'uclaw-agent-welcome',
      message: { role: 'assistant', content: 'Ready to plan the next milestone.' },
    });
    expect(record).toMatchObject({ label: 'Lin', status: 'completed' });
  });

  it('removes only the requested profile', async () => {
    const { deleteAgentProfile, readAgentProfiles, upsertAgentProfile } = await import('@electron/utils/agent-profile');
    const base = {
      roleName: 'Agent',
      personaName: 'Agent',
      responsibility: 'Help',
      capabilities: [],
      boundaries: [],
      workspaceInstructions: 'Help',
      welcomeMessage: '',
      avatarId: 'strategist',
    };
    await upsertAgentProfile('one', base);
    await upsertAgentProfile('two', base);

    await deleteAgentProfile('one');

    expect(Object.keys(await readAgentProfiles())).toEqual(['two']);
  });
});
