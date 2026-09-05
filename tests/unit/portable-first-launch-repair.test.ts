// @vitest-environment node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runPortableFirstLaunchRepair } from '../../electron/utils/portable-first-launch-repair';

const THIRD_PARTY_PLUGINS = [
  ['dingtalk', 'dingtalk', '@soimy/dingtalk'],
  ['wecom', 'wecom-openclaw-plugin', '@wecom/wecom-openclaw-plugin'],
  ['feishu-openclaw-plugin', 'openclaw-lark', '@larksuite/openclaw-lark'],
  ['discord', 'discord', '@openclaw/discord'],
  ['qqbot', 'qqbot', '@openclaw/qqbot'],
  ['whatsapp', 'whatsapp', '@openclaw/whatsapp'],
  ['openclaw-weixin', 'openclaw-weixin', '@tencent-weixin/openclaw-weixin'],
  ['parallel', 'parallel', '@openclaw/parallel-plugin'],
] as const;

const LOCAL_PLUGINS = [
  'clawx-openai-image',
  'uclaw-artifact-orchestrator',
  'uclaw-local-artifacts',
  'uclaw-blender',
  'uclaw-video',
] as const;

const version = '2.0.4';
const buildId = '0123456789ab-test-build';
const commit = '0123456789012345678901234567890123456789';
let temporaryRoots: string[] = [];

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function createPlugin(resourcesDir: string, id: string, manifestId: string, packageName: string): void {
  const pluginDir = join(resourcesDir, 'openclaw-plugins', id);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'index.mjs'), 'export default {};\n', 'utf8');
  const isLocal = LOCAL_PLUGINS.includes(id as typeof LOCAL_PLUGINS[number]);
  writeJson(join(pluginDir, 'package.json'), {
    name: packageName,
    version: '1.0.0',
    main: 'index.mjs',
    ...(isLocal ? { openclaw: { extensions: ['./index.mjs'] } } : {}),
  });
  writeJson(join(pluginDir, 'openclaw.plugin.json'), {
    id: manifestId,
    version: '1.0.0',
    entry: 'index.mjs',
  });
}

function createPortablePackage(): {
  rootDir: string;
  resourcesDir: string;
  runtimeProfileDir: string;
} {
  const rootDir = mkdtempSync(join(tmpdir(), 'uclaw-first-launch-'));
  temporaryRoots.push(rootDir);
  const resourcesDir = join(rootDir, 'resources');
  const runtimeProfileDir = join(rootDir, 'runtime-profile');
  mkdirSync(runtimeProfileDir, { recursive: true });
  mkdirSync(join(resourcesDir, 'openclaw'), { recursive: true });
  mkdirSync(join(resourcesDir, 'cli'), { recursive: true });
  mkdirSync(join(resourcesDir, 'bin'), { recursive: true });
  mkdirSync(join(resourcesDir, 'openclaw-plugins'), { recursive: true });
  mkdirSync(join(rootDir, 'UClawData'), { recursive: true });
  writeFileSync(join(rootDir, 'portable.flag'), 'UClaw USB portable mode\n', 'utf8');

  for (const filePath of [
    join(resourcesDir, 'app.asar'),
    join(resourcesDir, 'openclaw', 'openclaw.mjs'),
    join(resourcesDir, 'openclaw', 'package.json'),
    join(resourcesDir, 'cli', 'openclaw.cmd'),
    join(rootDir, 'UClaw.exe'),
    join(rootDir, 'UClaw-SelfCheck.cmd'),
    join(resourcesDir, 'bin', 'node.exe'),
    join(resourcesDir, 'bin', 'uv.exe'),
    join(resourcesDir, 'bin', 'agent-browser.exe'),
  ]) {
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, 'fixture\n', 'utf8');
  }

  const identity = {
    schemaVersion: 2,
    product: 'UClaw',
    appVersion: version,
    buildId,
    gitCommit: commit,
    sourceTreeState: 'clean',
    platform: 'win32',
    arch: 'x64',
    appAsarVersion: version,
  };
  writeJson(join(resourcesDir, 'openclaw', 'package.json'), { name: 'openclaw', version });
  writeJson(join(resourcesDir, 'uclaw-build.json'), identity);
  writeJson(join(rootDir, 'uclaw-usb-build.json'), {
    ...identity,
    packageType: 'portable_zip',
  });

  for (const [id, manifestId, packageName] of THIRD_PARTY_PLUGINS) {
    createPlugin(resourcesDir, id, manifestId, packageName);
  }
  for (const id of LOCAL_PLUGINS) createPlugin(resourcesDir, id, id, id);
  for (const filePath of [
    join(resourcesDir, 'openclaw', 'node_modules', 'sharp', 'package.json'),
    join(resourcesDir, 'openclaw', 'node_modules', '@img', 'sharp-win32-x64', 'package.json'),
    join(resourcesDir, 'openclaw', 'node_modules', '@img', 'sharp-win32-x64', 'lib', 'sharp-win32-x64.node'),
    join(resourcesDir, 'openclaw', 'node_modules', '@img', 'sharp-win32-x64', 'lib', 'libvips-42.dll'),
    join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'sharp', 'package.json'),
    join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@img', 'sharp-win32-x64', 'package.json'),
    join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@img', 'sharp-win32-x64', 'lib', 'sharp-win32-x64.node'),
    join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@img', 'sharp-win32-x64', 'lib', 'libvips-42.dll'),
    join(resourcesDir, 'openclaw-plugins', 'clawx-openai-image', 'node_modules', 'undici', 'package.json'),
    join(resourcesDir, 'resources', 'blender', 'runtime', 'uclaw_scene_runner.py'),
    join(resourcesDir, 'resources', 'blender', 'runtime', 'scene-spec.schema.json'),
    join(resourcesDir, 'resources', 'updater', 'win32-x64', 'uclaw-portable-updater.exe'),
  ]) {
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, 'fixture\n', 'utf8');
  }
  return { rootDir, resourcesDir, runtimeProfileDir };
}

function inputFor(packageRoot: ReturnType<typeof createPortablePackage>) {
  return {
    enabled: true,
    packaged: true,
    platform: 'win32',
    arch: 'x64',
    rootDir: packageRoot.rootDir,
    resourcesDir: packageRoot.resourcesDir,
    runtimeProfileDir: packageRoot.runtimeProfileDir,
    expectedVersion: version,
  } as const;
}

afterEach(() => {
  for (const rootDir of temporaryRoots.splice(0)) {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

describe('portable first-launch integrity repair', () => {
  it('accepts a complete manually extracted package and records a build marker', () => {
    const packageRoot = createPortablePackage();
    const result = runPortableFirstLaunchRepair(inputFor(packageRoot));

    expect(result.status).toBe('repaired');
    expect(result.errors).toEqual([]);
    expect(result.actions).toEqual(['wrote-first-launch-repair-marker']);
    expect(result.markerPath).toBe(join(packageRoot.runtimeProfileDir, '.uclaw-first-launch-repair.json'));
    expect(existsSync(result.markerPath!)).toBe(true);

    const secondRun = runPortableFirstLaunchRepair(inputFor(packageRoot));
    expect(secondRun.status).toBe('already-checked');
    expect(secondRun.actions).toEqual([]);
  });

  it('blocks startup when extraction dropped an immutable runtime file', () => {
    const packageRoot = createPortablePackage();
    unlinkSync(join(packageRoot.resourcesDir, 'bin', 'uv.exe'));

    const result = runPortableFirstLaunchRepair(inputFor(packageRoot));

    expect(result.status).toBe('blocked');
    expect(result.errors.some((error) => error.includes('uv.exe'))).toBe(true);
    expect(result.markerPath).toBeUndefined();
  });

  it('uses an isolated portable data root when the immutable package root is separate', () => {
    const packageRoot = createPortablePackage();
    const isolatedDataDir = mkdtempSync(join(tmpdir(), 'uclaw-first-launch-data-'));
    temporaryRoots.push(isolatedDataDir);

    const result = runPortableFirstLaunchRepair({
      ...inputFor(packageRoot),
      dataDir: isolatedDataDir,
    });

    expect(result.status).toBe('repaired');
    expect(result.errors).toEqual([]);
  });

  it('blocks startup when a packaged plugin dependency is incomplete', () => {
    const packageRoot = createPortablePackage();
    const packagePath = join(packageRoot.resourcesDir, 'openclaw-plugins', 'uclaw-blender', 'package.json');
    writeJson(packagePath, {
      name: 'uclaw-blender',
      version: '1.0.0',
      main: 'index.mjs',
      dependencies: { 'missing-runtime-package': '1.0.0' },
      openclaw: { extensions: ['./index.mjs'] },
    });

    const result = runPortableFirstLaunchRepair(inputFor(packageRoot));

    expect(result.status).toBe('blocked');
    expect(result.errors.some((error) => error.includes('missing-runtime-package'))).toBe(true);
  });

  it('does not inspect or mutate an installed/non-portable launch', () => {
    const packageRoot = createPortablePackage();
    const result = runPortableFirstLaunchRepair({
      ...inputFor(packageRoot),
      enabled: false,
    });

    expect(result).toEqual({ status: 'not-applicable', actions: [], errors: [] });
    expect(existsSync(join(packageRoot.runtimeProfileDir, '.uclaw-first-launch-repair.json'))).toBe(false);
  });
});
