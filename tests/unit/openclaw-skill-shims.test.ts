// @vitest-environment node

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const EXPECTED_SHIMS = [
  'presentation-maker',
  'spreadsheet-maker',
  'document-maker',
  'blender-maker',
] as const;

describe('OpenClaw bundled skill shims', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('installs all four maker shims into an empty bundled skills directory', async () => {
    const module = await import('../../scripts/install-openclaw-skill-shims.mjs').catch(() => null);
    expect(module).not.toBeNull();

    const skillsRoot = mkdtempSync(join(tmpdir(), 'uclaw-openclaw-skills-'));
    tempRoots.push(skillsRoot);
    const installed = module!.installOpenClawSkillShims({
      skillsRoot,
      shimsRoot: resolve(process.cwd(), 'resources/openclaw-skill-shims'),
    });

    expect(installed).toEqual(EXPECTED_SHIMS);
    for (const skillId of EXPECTED_SHIMS) {
      expect(existsSync(join(skillsRoot, skillId, 'SKILL.md'))).toBe(true);
    }
  });

  it('does not overwrite an existing bundled skill with the same id', async () => {
    const module = await import('../../scripts/install-openclaw-skill-shims.mjs').catch(() => null);
    expect(module).not.toBeNull();

    const skillsRoot = mkdtempSync(join(tmpdir(), 'uclaw-openclaw-skills-'));
    tempRoots.push(skillsRoot);
    const existingDir = join(skillsRoot, 'document-maker');
    mkdirSync(existingDir, { recursive: true });
    writeFileSync(join(existingDir, 'SKILL.md'), 'user-selected bundled implementation\n', 'utf8');

    const installed = module!.installOpenClawSkillShims({
      skillsRoot,
      shimsRoot: resolve(process.cwd(), 'resources/openclaw-skill-shims'),
    });

    expect(installed).not.toContain('document-maker');
    expect(readFileSync(join(existingDir, 'SKILL.md'), 'utf8')).toBe('user-selected bundled implementation\n');
  });

  it('verifies every OpenClaw-owned skill file is preserved byte-for-byte', async () => {
    const module = await import('../../scripts/install-openclaw-skill-shims.mjs');
    const sourceSkillsRoot = mkdtempSync(join(tmpdir(), 'uclaw-openclaw-source-skills-'));
    const bundledSkillsRoot = mkdtempSync(join(tmpdir(), 'uclaw-openclaw-bundled-skills-'));
    tempRoots.push(sourceSkillsRoot, bundledSkillsRoot);

    for (const skillId of ['skill-creator', 'native-extra']) {
      mkdirSync(join(sourceSkillsRoot, skillId, 'references'), { recursive: true });
      mkdirSync(join(bundledSkillsRoot, skillId, 'references'), { recursive: true });
      writeFileSync(join(sourceSkillsRoot, skillId, 'SKILL.md'), `${skillId}\n`, 'utf8');
      writeFileSync(join(bundledSkillsRoot, skillId, 'SKILL.md'), `${skillId}\n`, 'utf8');
      writeFileSync(join(sourceSkillsRoot, skillId, 'references', 'guide.md'), 'same content\n', 'utf8');
      writeFileSync(join(bundledSkillsRoot, skillId, 'references', 'guide.md'), 'same content\n', 'utf8');
    }

    expect(module.verifyOpenClawSkillsPreserved({ sourceSkillsRoot, bundledSkillsRoot }))
      .toEqual(['native-extra', 'skill-creator']);

    writeFileSync(join(bundledSkillsRoot, 'native-extra', 'references', 'guide.md'), 'changed\n', 'utf8');
    expect(() => module.verifyOpenClawSkillsPreserved({ sourceSkillsRoot, bundledSkillsRoot }))
      .toThrow('Bundled OpenClaw skill file was modified: native-extra/references/guide.md');

    rmSync(join(bundledSkillsRoot, 'native-extra'), { recursive: true, force: true });
    expect(() => module.verifyOpenClawSkillsPreserved({ sourceSkillsRoot, bundledSkillsRoot }))
      .toThrow('Bundled OpenClaw skill is missing: native-extra');
  });

  it('wires development and packaged OpenClaw preparation to the same installer', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const bundleSource = readFileSync(resolve(process.cwd(), 'scripts/bundle-openclaw.mjs'), 'utf8');

    expect(packageJson.scripts?.postinstall).toContain('install-openclaw-skill-shims.mjs');
    expect(packageJson.scripts?.predev).toContain('install-openclaw-skill-shims.mjs');
    expect(bundleSource).toContain('installOpenClawSkillShims');
    expect(bundleSource).toContain('verifyOpenClawSkillsPreserved');
  });

  it('keeps blender-maker eligible when Blender is installed outside PATH', () => {
    const skillSource = readFileSync(
      resolve(process.cwd(), 'resources/openclaw-skill-shims/blender-maker/SKILL.md'),
      'utf8',
    );

    expect(skillSource).not.toMatch(/"bins"\s*:\s*\[\s*"blender"\s*\]/u);
    expect(skillSource).toContain('blender_get_capabilities');
  });
});
