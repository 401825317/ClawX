import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILLS } from '../../electron/shared/skills/bundled-allowlist';

const state = vi.hoisted(() => ({
  homeDir: '',
  openclawDir: '',
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => state.homeDir,
  };
});

vi.mock('@electron/utils/paths', () => ({
  getOpenClawDir: () => state.openclawDir,
  getOpenClawResolvedDir: () => state.openclawDir,
  getResourcesDir: () => '',
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => state.homeDir,
  };
});

describe('bundled OpenClaw skill trimming', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('CLAWX_MANAGED_PROVIDER', '0');
    state.homeDir = '';
    state.openclawDir = '';
  });

  it('keeps the build-time OpenClaw skill allowlist in sync with runtime trimming', async () => {
    const scriptAllowlist = await import(pathToFileURL(join(process.cwd(), 'scripts/openclaw-bundled-skill-allowlist.mjs')).href);

    expect(scriptAllowlist.UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILLS).toEqual(UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILLS);
    expect(UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILLS).toEqual(expect.arrayContaining(['browser-automation', 'diagram-maker', 'summarize', 'weather']));
  });


  it('physically trims non-allowlisted bundled skills from a bundled skills root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-bundled-skills-'));
    mkdirSync(join(root, 'skill-creator'), { recursive: true });
    mkdirSync(join(root, 'weather'), { recursive: true });
    mkdirSync(join(root, 'diagram-maker'), { recursive: true });
    mkdirSync(join(root, 'summarize'), { recursive: true });
    mkdirSync(join(root, 'browser-use'), { recursive: true });
    writeFileSync(join(root, 'skill-creator', 'SKILL.md'), '---\nname: skill-creator\ndescription: keep\n---\n');
    writeFileSync(join(root, 'weather', 'SKILL.md'), '---\nname: weather\ndescription: keep\n---\n');
    writeFileSync(join(root, 'diagram-maker', 'SKILL.md'), '---\nname: diagram-maker\ndescription: keep\n---\n');
    writeFileSync(join(root, 'summarize', 'SKILL.md'), '---\nname: summarize\ndescription: keep\n---\n');
    writeFileSync(join(root, 'browser-use', 'SKILL.md'), '---\nname: browser-use\ndescription: remove\n---\n');

    const { trimBundledOpenClawSkills } = await import('@electron/utils/skill-config');
    const result = await trimBundledOpenClawSkills({ bundledSkillsRoot: root });

    expect(result.removed).toBe(1);
    expect(result.removedSlugs).toEqual(['browser-use']);
    expect(result.kept).toEqual(expect.arrayContaining(['diagram-maker', 'skill-creator', 'summarize', 'weather']));
    expect(existsSync(join(root, 'skill-creator'))).toBe(true);
    expect(existsSync(join(root, 'weather'))).toBe(true);
    expect(existsSync(join(root, 'diagram-maker'))).toBe(true);
    expect(existsSync(join(root, 'summarize'))).toBe(true);
    expect(existsSync(join(root, 'browser-use'))).toBe(false);
  });

  it('preserves bundled OpenClaw skills in JunFeiAI managed builds', async () => {
    vi.stubEnv('CLAWX_MANAGED_PROVIDER', '1');
    const root = mkdtempSync(join(tmpdir(), 'clawx-bundled-skills-managed-'));
    mkdirSync(join(root, 'skill-creator'), { recursive: true });
    mkdirSync(join(root, 'browser-use'), { recursive: true });
    writeFileSync(join(root, 'skill-creator', 'SKILL.md'), '---\nname: skill-creator\ndescription: keep\n---\n');
    writeFileSync(join(root, 'browser-use', 'SKILL.md'), '---\nname: browser-use\ndescription: keep too\n---\n');

    const { trimBundledOpenClawSkills } = await import('@electron/utils/skill-config');
    const result = await trimBundledOpenClawSkills({ bundledSkillsRoot: root });

    expect(result).toMatchObject({ removed: 0, removedSlugs: [], kept: ['*'] });
    expect(existsSync(join(root, 'skill-creator'))).toBe(true);
    expect(existsSync(join(root, 'browser-use'))).toBe(true);
  });

  it('removes only ClawX preinstalled managed skills and keeps OpenClaw bundled skills', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-remove-preinstalled-'));
    state.homeDir = root;
    state.openclawDir = join(root, 'openclaw');

    const managedSkillsRoot = join(root, '.openclaw', 'skills');
    mkdirSync(join(managedSkillsRoot, 'pdf'), { recursive: true });
    writeFileSync(join(managedSkillsRoot, 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: preinstalled\n---\n');
    writeFileSync(
      join(managedSkillsRoot, 'pdf', '.clawx-preinstalled.json'),
      JSON.stringify({ source: 'clawx-preinstalled', slug: 'pdf', version: '1.0.0', installedAt: '2026-06-08T00:00:00.000Z' }),
    );

    mkdirSync(join(managedSkillsRoot, 'market-user-skill', '.clawhub'), { recursive: true });
    writeFileSync(join(managedSkillsRoot, 'market-user-skill', 'SKILL.md'), '---\nname: market-user-skill\ndescription: user installed\n---\n');
    writeFileSync(join(managedSkillsRoot, 'market-user-skill', '.clawhub', 'origin.json'), JSON.stringify({ slug: 'market-user-skill', installedVersion: '1.0.0' }));

    mkdirSync(join(state.openclawDir, 'skills', 'skill-creator'), { recursive: true });
    writeFileSync(join(state.openclawDir, 'skills', 'skill-creator', 'SKILL.md'), '---\nname: skill-creator\ndescription: bundled\n---\n');

    const { removeClawXPreinstalledSkillsAndConfigsWithOptions } = await import('@electron/utils/skill-config');
    const result = await removeClawXPreinstalledSkillsAndConfigsWithOptions({
      skillsRoot: managedSkillsRoot,
    });

    expect(result).toMatchObject({ removed: 1, removedSlugs: ['pdf'] });
    expect(existsSync(join(managedSkillsRoot, 'pdf'))).toBe(false);
    expect(existsSync(join(managedSkillsRoot, 'market-user-skill'))).toBe(true);
    expect(existsSync(join(state.openclawDir, 'skills', 'skill-creator'))).toBe(true);
  });
});
