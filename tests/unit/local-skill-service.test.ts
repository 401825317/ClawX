import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listAgentsSnapshotMock = vi.fn();
const getOpenClawSkillsDirMock = vi.fn();
const getOpenClawResolvedDirMock = vi.fn();
const getAllSkillConfigsMock = vi.fn();
const getSettingMock = vi.fn();

vi.mock('@electron/utils/agent-config', () => ({
  listAgentsSnapshot: () => listAgentsSnapshotMock(),
}));

vi.mock('@electron/utils/paths', () => ({
  expandPath: (value: string) => value,
  getOpenClawSkillsDir: () => getOpenClawSkillsDirMock(),
  getOpenClawResolvedDir: () => getOpenClawResolvedDirMock(),
}));

vi.mock('@electron/utils/skill-config', () => ({
  getAllSkillConfigs: () => getAllSkillConfigsMock(),
}));

vi.mock('@electron/utils/store', () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
}));

describe('local skill service', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('CLAWX_MANAGED_PROVIDER', '0');
    getSettingMock.mockResolvedValue('zh');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes bundled skill-creator but filters out other bundled openclaw skills', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-local-skills-'));
    const managedRoot = join(root, 'managed');
    const bundledRoot = join(root, 'openclaw');

    mkdirSync(join(managedRoot, 'pdf'), { recursive: true });
    writeFileSync(join(managedRoot, 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: managed pdf\n---\n');

    mkdirSync(join(bundledRoot, 'skills', 'skill-creator'), { recursive: true });
    writeFileSync(join(bundledRoot, 'skills', 'skill-creator', 'SKILL.md'), '---\nname: skill-creator\ndescription: bundled creator\n---\n');

    mkdirSync(join(bundledRoot, 'skills', 'other-bundled'), { recursive: true });
    writeFileSync(join(bundledRoot, 'skills', 'other-bundled', 'SKILL.md'), '---\nname: other-bundled\ndescription: should not appear\n---\n');

    listAgentsSnapshotMock.mockResolvedValue({ agents: [] });
    getOpenClawSkillsDirMock.mockReturnValue(managedRoot);
    getOpenClawResolvedDirMock.mockReturnValue(bundledRoot);
    getAllSkillConfigsMock.mockResolvedValue({});

    const { listLocalSkills } = await import('@electron/services/skills/local-skill-service');
    const skills = await listLocalSkills();

    expect(skills.map((skill) => skill.id)).toEqual(['pdf', 'skill-creator']);
    expect(skills.find((skill) => skill.id === 'skill-creator')).toMatchObject({
      source: 'openclaw-bundled',
      isBundled: true,
      enabled: true,
    });
    expect(skills.find((skill) => skill.id === 'other-bundled')).toBeUndefined();
  });

  it('includes all bundled OpenClaw skills in JunFeiAI managed builds', async () => {
    vi.stubEnv('CLAWX_MANAGED_PROVIDER', '1');
    const root = mkdtempSync(join(tmpdir(), 'clawx-local-skills-managed-'));
    const managedRoot = join(root, 'managed');
    const bundledRoot = join(root, 'openclaw');

    mkdirSync(join(bundledRoot, 'skills', 'skill-creator'), { recursive: true });
    writeFileSync(join(bundledRoot, 'skills', 'skill-creator', 'SKILL.md'), '---\nname: skill-creator\ndescription: bundled creator\n---\n');

    mkdirSync(join(bundledRoot, 'skills', 'browser-use'), { recursive: true });
    writeFileSync(join(bundledRoot, 'skills', 'browser-use', 'SKILL.md'), '---\nname: browser-use\ndescription: bundled browser\n---\n');

    listAgentsSnapshotMock.mockResolvedValue({ agents: [] });
    getOpenClawSkillsDirMock.mockReturnValue(managedRoot);
    getOpenClawResolvedDirMock.mockReturnValue(bundledRoot);
    getAllSkillConfigsMock.mockResolvedValue({});

    const { listLocalSkills } = await import('@electron/services/skills/local-skill-service');
    const skills = await listLocalSkills();

    expect(skills.map((skill) => skill.id)).toEqual(['browser-use', 'skill-creator']);
    expect(skills.every((skill) => skill.source === 'openclaw-bundled')).toBe(true);
  });

  it('does not invent a default version when local metadata has no version', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-local-skills-versionless-'));
    const managedRoot = join(root, 'managed');

    mkdirSync(join(managedRoot, 'self-improvement'), { recursive: true });
    writeFileSync(join(managedRoot, 'self-improvement', 'SKILL.md'), '---\nname: self-improvement\ndescription: versionless skill\n---\n');

    listAgentsSnapshotMock.mockResolvedValue({ agents: [] });
    getOpenClawSkillsDirMock.mockReturnValue(managedRoot);
    getOpenClawResolvedDirMock.mockReturnValue(join(root, 'openclaw'));
    getAllSkillConfigsMock.mockResolvedValue({});

    const { listLocalSkills } = await import('@electron/services/skills/local-skill-service');
    const skills = await listLocalSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ id: 'self-improvement', version: undefined });
  });

  it('shows manifest versions and ignores preinstalled hash-only versions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-local-skills-placeholder-version-'));
    const managedRoot = join(root, 'managed');

    mkdirSync(join(managedRoot, 'pdf'), { recursive: true });
    writeFileSync(join(managedRoot, 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: placeholder version skill\n---\n');
    writeFileSync(join(managedRoot, 'pdf', 'manifest.json'), JSON.stringify({ slug: 'pdf', version: '1.0.0' }));

    mkdirSync(join(managedRoot, 'docx'), { recursive: true });
    writeFileSync(join(managedRoot, 'docx', 'SKILL.md'), '---\nname: docx\ndescription: preinstalled hash version skill\n---\n');
    writeFileSync(join(managedRoot, 'docx', '.clawx-preinstalled.json'), JSON.stringify({ slug: 'docx', version: 'da20c92503b2e8ff1cf28ca81a0df4673debdbf7' }));

    mkdirSync(join(managedRoot, 'custom-skill'), { recursive: true });
    writeFileSync(join(managedRoot, 'custom-skill', 'SKILL.md'), '---\nname: custom-skill\ndescription: custom version skill\n---\n');
    writeFileSync(join(managedRoot, 'custom-skill', 'manifest.json'), JSON.stringify({ slug: 'custom-skill', version: '0.1.3' }));

    listAgentsSnapshotMock.mockResolvedValue({ agents: [] });
    getOpenClawSkillsDirMock.mockReturnValue(managedRoot);
    getOpenClawResolvedDirMock.mockReturnValue(join(root, 'openclaw'));
    getAllSkillConfigsMock.mockResolvedValue({});

    const { listLocalSkills } = await import('@electron/services/skills/local-skill-service');
    const skills = await listLocalSkills();

    expect(skills.find((skill) => skill.id === 'pdf')?.version).toBe('1.0.0');
    expect(skills.find((skill) => skill.id === 'docx')?.version).toBeUndefined();
    expect(skills.find((skill) => skill.id === 'custom-skill')?.version).toBe('0.1.3');
    expect(skills.find((skill) => skill.id === 'docx')?.uninstallable).toBe(false);
  });

  it('marks only user-installed managed skills as uninstallable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-local-skills-uninstallable-'));
    const managedRoot = join(root, 'managed');

    mkdirSync(join(managedRoot, 'market-user-skill', '.clawhub'), { recursive: true });
    writeFileSync(join(managedRoot, 'market-user-skill', 'SKILL.md'), '---\nname: market-user-skill\ndescription: user installed\n---\n');
    writeFileSync(join(managedRoot, 'market-user-skill', '.clawhub', 'origin.json'), JSON.stringify({ slug: 'market-user-skill', installedVersion: '1.0.0' }));

    mkdirSync(join(managedRoot, 'pdf'), { recursive: true });
    writeFileSync(join(managedRoot, 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: preinstalled\n---\n');
    writeFileSync(join(managedRoot, 'pdf', '.clawx-preinstalled.json'), JSON.stringify({ slug: 'pdf', version: '1.0.0' }));

    listAgentsSnapshotMock.mockResolvedValue({ agents: [] });
    getOpenClawSkillsDirMock.mockReturnValue(managedRoot);
    getOpenClawResolvedDirMock.mockReturnValue(join(root, 'openclaw'));
    getAllSkillConfigsMock.mockResolvedValue({});

    const { listLocalSkills } = await import('@electron/services/skills/local-skill-service');
    const skills = await listLocalSkills();

    expect(skills.find((skill) => skill.id === 'market-user-skill')?.uninstallable).toBe(true);
    expect(skills.find((skill) => skill.id === 'pdf')?.uninstallable).toBe(false);
  });

  it('prefers localized display description cached in origin metadata for ClawHub-installed skills', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-local-skills-localized-origin-'));
    const managedRoot = join(root, 'managed');

    mkdirSync(join(managedRoot, 'assess-me', '.clawhub'), { recursive: true });
    writeFileSync(
      join(managedRoot, 'assess-me', 'SKILL.md'),
      '---\nname: Assess Me\ndescription: Run this when debugging goes in circles.\n---\n',
    );
    writeFileSync(
      join(managedRoot, 'assess-me', '.clawhub', 'origin.json'),
      JSON.stringify({
        slug: 'assess-me',
        installedVersion: '1.0.0',
        displayDescription: '当调试绕圈、结果混乱时，帮你梳理目标、进度与阻碍，理清认知状态',
        defaultDescription: 'Run this when debugging goes in circles.',
      }),
    );

    listAgentsSnapshotMock.mockResolvedValue({ agents: [] });
    getOpenClawSkillsDirMock.mockReturnValue(managedRoot);
    getOpenClawResolvedDirMock.mockReturnValue(join(root, 'openclaw'));
    getAllSkillConfigsMock.mockResolvedValue({});

    const { listLocalSkills } = await import('@electron/services/skills/local-skill-service');
    const skills = await listLocalSkills();

    expect(skills.find((skill) => skill.id === 'assess-me')?.description)
      .toBe('当调试绕圈、结果混乱时，帮你梳理目标、进度与阻碍，理清认知状态');
  });

  it('backfills localized display description for older ClawHub installs on first scan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-local-skills-localized-backfill-'));
    const managedRoot = join(root, 'managed');
    const originPath = join(managedRoot, 'assess-me', '.clawhub', 'origin.json');

    mkdirSync(join(managedRoot, 'assess-me', '.clawhub'), { recursive: true });
    writeFileSync(
      join(managedRoot, 'assess-me', 'SKILL.md'),
      '---\nname: Assess Me\ndescription: Run this when debugging goes in circles.\n---\n',
    );
    writeFileSync(
      originPath,
      JSON.stringify({
        slug: 'assess-me',
        installedVersion: '1.0.0',
        registry: 'https://mirror-cn.clawhub.com',
      }),
    );

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      skill: {
        displayName: 'Assess Me',
        summary: 'Run this when debugging goes in circles.',
      },
      metaContent: {
        DisplayDescription: '当调试绕圈、结果混乱时，帮你梳理目标、进度与阻碍，理清认知状态',
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    listAgentsSnapshotMock.mockResolvedValue({ agents: [] });
    getOpenClawSkillsDirMock.mockReturnValue(managedRoot);
    getOpenClawResolvedDirMock.mockReturnValue(join(root, 'openclaw'));
    getAllSkillConfigsMock.mockResolvedValue({});

    const { listLocalSkills } = await import('@electron/services/skills/local-skill-service');
    const skills = await listLocalSkills();

    expect(skills.find((skill) => skill.id === 'assess-me')?.description)
      .toBe('当调试绕圈、结果混乱时，帮你梳理目标、进度与阻碍，理清认知状态');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { readFile } = await import('node:fs/promises');
    expect(JSON.parse(await readFile(originPath, 'utf-8'))).toMatchObject({
      displayDescription: '当调试绕圈、结果混乱时，帮你梳理目标、进度与阻碍，理清认知状态',
      defaultDescription: 'Run this when debugging goes in circles.',
    });
  });
});
