// @vitest-environment node

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  homeDir: '',
  openclawDir: '',
  configPath: '',
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => state.homeDir,
  };
});

vi.mock('@electron/utils/paths', () => ({
  getOpenClawConfigDir: () => state.openclawDir,
  getOpenClawDir: () => state.openclawDir,
  getOpenClawResolvedDir: () => state.openclawDir,
  getResourcesDir: () => '',
  resolveOpenClawConfigPath: () => state.configPath,
}));

describe('retired UClaw preinstalled skills', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('removes only UClaw-owned retired skills and their config entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uclaw-retired-skills-'));
    state.homeDir = root;
    state.openclawDir = join(root, '.openclaw');
    state.configPath = join(state.openclawDir, 'openclaw.json');
    const skillsRoot = join(state.openclawDir, 'skills');

    mkdirSync(join(skillsRoot, 'docx'), { recursive: true });
    writeFileSync(join(skillsRoot, 'docx', 'SKILL.md'), 'managed docx');
    writeFileSync(join(skillsRoot, 'docx', '.clawx-preinstalled.json'), JSON.stringify({
      source: 'clawx-preinstalled',
      slug: 'docx',
      version: 'managed-version',
    }));

    mkdirSync(join(skillsRoot, 'pdf'), { recursive: true });
    writeFileSync(join(skillsRoot, 'pdf', 'SKILL.md'), 'user-owned pdf');

    mkdirSync(join(skillsRoot, 'pptx'), { recursive: true });
    writeFileSync(join(skillsRoot, 'pptx', 'SKILL.md'), 'marker belongs to another slug');
    writeFileSync(join(skillsRoot, 'pptx', '.clawx-preinstalled.json'), JSON.stringify({
      source: 'clawx-preinstalled',
      slug: 'different-skill',
      version: 'managed-version',
    }));

    writeFileSync(state.configPath, JSON.stringify({
      skills: {
        entries: {
          docx: { enabled: true },
          pdf: { enabled: false },
          pptx: { enabled: true },
          custom: { enabled: true },
        },
      },
    }));

    const { removeRetiredPreinstalledSkills } = await import('@electron/utils/skill-config');
    const result = await removeRetiredPreinstalledSkills();

    expect(result).toEqual({ removed: 1, removedSlugs: ['docx'], removedConfigs: 1 });
    expect(existsSync(join(skillsRoot, 'docx'))).toBe(false);
    expect(existsSync(join(skillsRoot, 'pdf'))).toBe(true);
    expect(existsSync(join(skillsRoot, 'pptx'))).toBe(true);

    const config = JSON.parse(readFileSync(state.configPath, 'utf-8')) as {
      skills: { entries: Record<string, unknown> };
    };
    expect(config.skills.entries).toEqual({
      pdf: { enabled: false },
      pptx: { enabled: true },
      custom: { enabled: true },
    });
  });
});
