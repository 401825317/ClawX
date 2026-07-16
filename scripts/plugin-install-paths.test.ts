import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isTransientPluginInstallPath,
  resolvePluginInstallWorkPaths,
  resolvePluginInstallWorkRoot,
} from '../electron/utils/plugin-install-paths.ts';

test('recognizes legacy plugin staging and backup paths on Windows', () => {
  assert.equal(isTransientPluginInstallPath(
    'M:\\UClawData\\openclaw-home\\.openclaw\\extensions\\.uclaw-blender.uclaw-staging-8064-id',
  ), true);
  assert.equal(isTransientPluginInstallPath(
    'M:\\UClawData\\openclaw-home\\.openclaw\\extensions\\.uclaw-task-bridge.uclaw-backup-8064-id',
  ), true);
});

test('recognizes the isolated plugin install work root', () => {
  assert.equal(isTransientPluginInstallPath(
    'M:\\UClawData\\openclaw-home\\.openclaw\\.uclaw-plugin-install\\uclaw-blender.staging-1-id',
  ), true);
});

test('does not classify normal plugin paths as transient', () => {
  assert.equal(isTransientPluginInstallPath(
    'M:\\UClawData\\openclaw-home\\.openclaw\\extensions\\uclaw-blender',
  ), false);
  assert.equal(isTransientPluginInstallPath('/opt/openclaw/extensions/custom-plugin'), false);
});

test('places plugin staging and backup directories outside extensions', () => {
  const configRoot = path.join('/tmp', 'openclaw-state');
  const extensionsRoot = path.join(configRoot, 'extensions');
  const targetDir = path.join(extensionsRoot, 'uclaw-blender');
  const work = resolvePluginInstallWorkPaths(targetDir, '1234-test');

  assert.equal(work.workRoot, path.join(configRoot, '.uclaw-plugin-install'));
  assert.equal(path.relative(extensionsRoot, work.stagingDir).startsWith('..'), true);
  assert.equal(path.relative(extensionsRoot, work.backupDir).startsWith('..'), true);
  assert.match(path.basename(work.stagingDir), /^uclaw-blender\.staging-/u);
  assert.match(path.basename(work.backupDir), /^uclaw-blender\.backup-/u);
  assert.equal(resolvePluginInstallWorkRoot(extensionsRoot), work.workRoot);
});

test('copies root node_modules packages on Windows without realpath long-path failures', async (t) => {
  const sourcePackage = path.join(process.cwd(), 'node_modules', '@sinclair', 'typebox');
  if (!existsSync(path.join(sourcePackage, 'package.json'))) {
    t.skip('fixture package @sinclair/typebox is not installed');
    return;
  }

  const mod = await import('../electron/utils/plugin-install.ts');
  const installUtils = (mod.default ?? mod['module.exports'] ?? mod) as {
    copyPluginFromNodeModules: (npmPkgPath: string, targetDir: string, npmName: string) => void;
  };
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'uclaw-plugin-copy-'));
  const targetDir = path.join(tempRoot, 'typebox-copy');

  try {
    installUtils.copyPluginFromNodeModules(sourcePackage, targetDir, '@sinclair/typebox');
    assert.equal(existsSync(path.join(targetDir, 'package.json')), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
