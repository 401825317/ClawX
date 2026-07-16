import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  patchOpenClawPluginSkillsSymlinkContent,
  patchOpenClawPluginSkillsSymlinkRuntime,
} from './openclaw-plugin-skills-symlink-patch.mjs';

function fixture() {
  return [
    'function publishPluginSkills(skillDirs, opts) {',
    '\tfor (const [name, target] of managedTargets) {',
    '\t\tconst linkPath = path.join(pluginSkillsDir, name);',
    '\t\ttry {',
    '\t\t\tfs.symlinkSync(target, linkPath, resolvePluginSkillLinkType());',
    '\t\t} catch (err) {',
    '\t\t\tlog.warn(`failed to create plugin skill symlink "${linkPath}" -> "${target}": ${String(err)}`);',
    '\t\t}',
    '\t}',
    '}',
    'function removeGeneratedPluginSkillEntry(linkPath) {}',
  ].join('\n');
}

test('patches Windows plugin-skill symlink creation with cleanup retry', () => {
  const first = patchOpenClawPluginSkillsSymlinkContent(fixture(), '<fixture>');
  assert.equal(first.matched, true);
  assert.equal(first.changed, true);
  assert.match(first.content, /UCLAW_PLUGIN_SKILLS_SYMLINK_RETRY_V1/);
  assert.match(first.content, /process\.platform === "win32"/);
  assert.match(first.content, /code === "EISDIR"/);
  assert.match(first.content, /code === "EEXIST"/);
  assert.match(first.content, /code === "EPERM"/);
  assert.match(first.content, /removeGeneratedPluginSkillEntry\(linkPath\)/);
  assert.match(first.content, /\bcontinue;/);

  const second = patchOpenClawPluginSkillsSymlinkContent(first.content, '<fixture>');
  assert.equal(second.matched, true);
  assert.equal(second.changed, false);
  assert.equal(second.content, first.content);
});

test('patches exactly one runtime file in a dist directory', () => {
  const distDir = mkdtempSync(join(tmpdir(), 'uclaw-plugin-skills-symlink-'));
  writeFileSync(join(distDir, 'unrelated.js'), 'const unrelated = true;');
  writeFileSync(join(distDir, 'symlink-targets-test.js'), fixture());

  const first = patchOpenClawPluginSkillsSymlinkRuntime(distDir, { logger: { log() {} } });
  assert.equal(first.patchedFiles, 1);
  assert.equal(first.alreadyPatchedFiles, 0);
  assert.match(readFileSync(join(distDir, 'symlink-targets-test.js'), 'utf8'), /UCLAW_PLUGIN_SKILLS_SYMLINK_RETRY_V1/);

  const second = patchOpenClawPluginSkillsSymlinkRuntime(distDir, { logger: { log() {} } });
  assert.equal(second.patchedFiles, 0);
  assert.equal(second.alreadyPatchedFiles, 1);
});
