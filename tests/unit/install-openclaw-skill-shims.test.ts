// @vitest-environment node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const MANAGED_SHIMS = ['cad-editor', 'ecommerce-main-image'] as const;

describe('versioned OpenClaw skill shim installation', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('installs all allowlisted shims and writes version ownership markers', async () => {
    const skillsRoot = mkdtempSync(join(tmpdir(), 'uclaw-versioned-shims-'));
    tempRoots.push(skillsRoot);
    const module = await import('../../scripts/install-openclaw-skill-shims.mjs');

    const result = module.synchronizeOpenClawSkillShims({
      skillsRoot,
      shimsRoot: resolve(process.cwd(), 'resources/openclaw-skill-shims'),
    });

    expect(result.installed).toEqual(module.OPENCLAW_SKILL_SHIM_IDS);
    expect(result.synchronized).toEqual(MANAGED_SHIMS);
    for (const skillId of MANAGED_SHIMS) {
      const marker = JSON.parse(readFileSync(
        join(skillsRoot, skillId, '.uclaw-skill-shim.json'),
        'utf8',
      )) as Record<string, unknown>;
      expect(marker).toMatchObject({ managedBy: 'uclaw', id: skillId, version: 'v1' });
      expect(readFileSync(join(skillsRoot, skillId, 'SKILL.md'), 'utf8')).toBe(
        readFileSync(resolve(process.cwd(), 'resources/openclaw-skill-shims', skillId, 'SKILL.md'), 'utf8'),
      );
    }
  });

  it('replaces stale managed shims without overwriting existing compatibility skills', async () => {
    const skillsRoot = mkdtempSync(join(tmpdir(), 'uclaw-versioned-shims-'));
    tempRoots.push(skillsRoot);
    mkdirSync(join(skillsRoot, 'cad-editor'), { recursive: true });
    writeFileSync(join(skillsRoot, 'cad-editor', 'SKILL.md'), 'stale CAD shim\n', 'utf8');
    writeFileSync(join(skillsRoot, 'cad-editor', '.uclaw-skill-shim.json'), JSON.stringify({
      managedBy: 'uclaw', id: 'cad-editor', version: 'v0',
    }));
    mkdirSync(join(skillsRoot, 'document-maker'), { recursive: true });
    writeFileSync(join(skillsRoot, 'document-maker', 'SKILL.md'), 'OpenClaw-owned document skill\n', 'utf8');
    const module = await import('../../scripts/install-openclaw-skill-shims.mjs');

    const first = module.synchronizeOpenClawSkillShims({
      skillsRoot,
      shimsRoot: resolve(process.cwd(), 'resources/openclaw-skill-shims'),
    });
    const second = module.synchronizeOpenClawSkillShims({
      skillsRoot,
      shimsRoot: resolve(process.cwd(), 'resources/openclaw-skill-shims'),
    });

    expect(first.synchronized).toEqual(MANAGED_SHIMS);
    expect(second.synchronized).toEqual([]);
    expect(second.unchanged).toEqual(expect.arrayContaining(MANAGED_SHIMS));
    expect(readFileSync(join(skillsRoot, 'document-maker', 'SKILL.md'), 'utf8'))
      .toBe('OpenClaw-owned document skill\n');
    expect(readFileSync(join(skillsRoot, 'cad-editor', 'SKILL.md'), 'utf8'))
      .not.toContain('stale CAD shim');
  });

  it('fails closed when the manifest and bundle allowlist drift', async () => {
    const skillsRoot = mkdtempSync(join(tmpdir(), 'uclaw-versioned-shims-'));
    const manifestRoot = mkdtempSync(join(tmpdir(), 'uclaw-versioned-manifest-'));
    tempRoots.push(skillsRoot, manifestRoot);
    const manifestPath = join(manifestRoot, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, skills: [] }), 'utf8');
    const module = await import('../../scripts/install-openclaw-skill-shims.mjs');

    expect(() => module.synchronizeOpenClawSkillShims({
      skillsRoot,
      shimsRoot: resolve(process.cwd(), 'resources/openclaw-skill-shims'),
      manifestPath,
    })).toThrow('manifest does not match the bundle allowlist');
  });
});
