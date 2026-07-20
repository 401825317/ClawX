import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  patchOpenClawPluginSkillsSymlinkContent,
  patchOpenClawPluginSkillsSymlinkRuntime,
} from './openclaw-plugin-skills-symlink-patch.mjs';

async function findPublisherFixture() {
  const distDir = join(process.cwd(), 'node_modules', 'openclaw', 'dist');
  for (const entry of await readdir(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = readFileSync(filePath, 'utf8');
    if (content.includes('function publishPluginSkills(skillDirs, opts) {')) {
      return { distDir, filePath, content };
    }
  }
  throw new Error('OpenClaw plugin skill publisher fixture was not found.');
}

test('migrates Skill publishing to a gap-free manifest-owned copy contract', async () => {
  const fixture = await findPublisherFixture();
  const first = patchOpenClawPluginSkillsSymlinkContent(fixture.content, fixture.filePath);
  assert.equal(first.matched, true);
  assert.match(first.content, /UCLAW_PLUGIN_SKILLS_COPY_V3/u);
  assert.match(first.content, /uclaw\.plugin-skill-copy\/v2/u);
  assert.match(first.content, /sourceFingerprint/u);
  assert.match(first.content, /syncPluginSkillTree/u);
  assert.match(first.content, /deferOwnershipManifest/u);
  assert.match(first.content, /reconcile: false/u);
  assert.match(first.content, /user-owned directory or file; preserving it/u);
  assert.doesNotMatch(first.content, /backupPath/u);
  assert.doesNotMatch(first.content, /failed to create plugin skill symlink/u);

  const legacy = first.content.replace('UCLAW_PLUGIN_SKILLS_COPY_V3', 'UCLAW_PLUGIN_SKILLS_COPY_V2');
  const migrated = patchOpenClawPluginSkillsSymlinkContent(legacy, fixture.filePath);
  assert.equal(migrated.changed, true);
  assert.match(migrated.content, /UCLAW_PLUGIN_SKILLS_COPY_V3/u);
  assert.doesNotMatch(migrated.content, /UCLAW_PLUGIN_SKILLS_COPY_V2/u);

  const second = patchOpenClawPluginSkillsSymlinkContent(first.content, fixture.filePath);
  assert.equal(second.matched, true);
  assert.equal(second.changed, false);
  assert.equal(second.content, first.content);
});

test('patches exactly one installed runtime file and supports a dry run', async () => {
  const fixture = await findPublisherFixture();
  const distDir = mkdtempSync(join(tmpdir(), 'uclaw-plugin-skills-copy-'));
  writeFileSync(join(distDir, 'unrelated.js'), 'const unrelated = true;');
  writeFileSync(join(distDir, 'publisher.js'), fixture.content);

  const dryRun = patchOpenClawPluginSkillsSymlinkRuntime(distDir, { dryRun: true, logger: { log() {} } });
  assert.equal(dryRun.patchedFiles + dryRun.alreadyPatchedFiles, 1);
  assert.equal(readFileSync(join(distDir, 'publisher.js'), 'utf8'), fixture.content);

  const applied = patchOpenClawPluginSkillsSymlinkRuntime(distDir, { logger: { log() {} } });
  assert.equal(applied.patchedFiles + applied.alreadyPatchedFiles, 1);
  assert.match(readFileSync(join(distDir, 'publisher.js'), 'utf8'), /UCLAW_PLUGIN_SKILLS_COPY_V3/u);

  const second = patchOpenClawPluginSkillsSymlinkRuntime(distDir, { logger: { log() {} } });
  assert.equal(second.patchedFiles, 0);
  assert.equal(second.alreadyPatchedFiles, 1);
});

test('updates managed copies without a visibility gap and preserves user-owned entries', async () => {
  const fixture = await findPublisherFixture();
  const patched = patchOpenClawPluginSkillsSymlinkContent(fixture.content, fixture.filePath);
  const helperStart = patched.content.indexOf('function isUclawManagedPluginSkillManifest');
  const helperEnd = patched.content.indexOf('function isNotFoundError(err) {', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);

  const root = mkdtempSync(join(tmpdir(), 'uclaw-plugin-skills-copy-behavior-'));
  const pluginSkillsDir = join(root, 'plugin-skills');
  const sourceDir = join(root, 'sources', 'managed-regression-skill');
  const managedEntry = join(pluginSkillsDir, 'managed-regression-skill');
  const staleEntry = join(pluginSkillsDir, 'stale-managed-skill');
  const warnings = [];
  const renameEvents = [];
  const copyEvents = [];
  const instrumentedFs = new Proxy(fs, {
    get(target, property, receiver) {
      if (property === 'renameSync') {
        return (source, destination) => {
          renameEvents.push([String(source), String(destination)]);
          return fs.renameSync(source, destination);
        };
      }
      if (property === 'copyFileSync') {
        return (source, destination) => {
          copyEvents.push([String(source), String(destination)]);
          return fs.copyFileSync(source, destination);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  try {
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(join(sourceDir, 'SKILL.md'), '# managed v1\n', 'utf8');
    fs.writeFileSync(join(sourceDir, 'asset.txt'), 'managed-v1\n', 'utf8');

    const context = vm.createContext({
      fs: instrumentedFs,
      path,
      process,
      log: { warn: (message) => warnings.push(String(message)) },
      resolveDefaultPluginSkillsDir: () => pluginSkillsDir,
      collectSkillTargets: (dir, targets) => targets.set(path.basename(dir), dir),
    });
    const helperSource = patched.content.slice(helperStart, helperEnd)
      + '\nglobalThis.publishPluginSkillsForRegression = publishPluginSkills;';
    new vm.Script(helperSource).runInContext(context);

    context.publishPluginSkillsForRegression([sourceDir], { pluginSkillsDir });
    assert.equal(readFileSync(join(managedEntry, 'asset.txt'), 'utf8'), 'managed-v1\n');
    const firstManifest = JSON.parse(readFileSync(join(managedEntry, '.uclaw-skill-manifest.json'), 'utf8'));
    assert.equal(firstManifest.schema, 'uclaw.plugin-skill-copy/v2');
    assert.equal(firstManifest.name, 'managed-regression-skill');
    assert.equal(typeof firstManifest.sourceFingerprint, 'string');

    renameEvents.length = 0;
    copyEvents.length = 0;
    fs.writeFileSync(join(sourceDir, 'asset.txt'), 'managed-v2-expanded\n', 'utf8');
    context.publishPluginSkillsForRegression([sourceDir], { pluginSkillsDir });
    assert.equal(readFileSync(join(managedEntry, 'asset.txt'), 'utf8'), 'managed-v2-expanded\n');
    assert.equal(renameEvents.length, 0, 'managed directory updates must not remove and rename the live entry');
    assert.ok(copyEvents.length > 0);

    copyEvents.length = 0;
    context.publishPluginSkillsForRegression([sourceDir], { pluginSkillsDir });
    assert.equal(copyEvents.length, 0, 'unchanged managed Skill trees should not be recopied');

    context.publishPluginSkillsForRegression([], { pluginSkillsDir, reconcile: false });
    assert.equal(fs.existsSync(managedEntry), true, 'non-authoritative scans must not remove managed Skills');

    fs.rmSync(managedEntry, { recursive: true, force: true });
    fs.mkdirSync(managedEntry, { recursive: true });
    fs.writeFileSync(join(managedEntry, 'SKILL.md'), '# user owned\n', 'utf8');
    fs.writeFileSync(join(managedEntry, 'user-sentinel.txt'), 'preserve-me\n', 'utf8');

    fs.mkdirSync(staleEntry, { recursive: true });
    fs.writeFileSync(join(staleEntry, '.uclaw-skill-manifest.json'), `${JSON.stringify({
      schema: 'uclaw.plugin-skill-copy/v1',
      name: 'stale-managed-skill',
    }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(join(staleEntry, 'stale.txt'), 'remove-me\n', 'utf8');

    context.publishPluginSkillsForRegression([sourceDir], { pluginSkillsDir });
    assert.equal(readFileSync(join(managedEntry, 'user-sentinel.txt'), 'utf8'), 'preserve-me\n');
    assert.equal(fs.existsSync(join(managedEntry, '.uclaw-skill-manifest.json')), false);
    assert.equal(fs.existsSync(staleEntry), false);
    assert.ok(warnings.some((message) => message.includes('user-owned directory or file; preserving it')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
