// @vitest-environment node

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configurePortableOpenClawRuntime,
  findPreparedPortableOpenClawRuntime,
  prepareConfiguredPortableOpenClawRuntime,
  preparePortableOpenClawRuntime,
  resolvePortableOpenClawCacheRoot,
} from '@electron/utils/portable-openclaw-runtime';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createFixture(appVersion = '2.0.1') {
  const root = await mkdtemp(join(tmpdir(), 'uclaw-portable-openclaw-'));
  tempDirs.push(root);
  const resourcesDir = join(root, 'resources');
  const sourceDir = join(resourcesDir, 'openclaw');
  const profileDir = join(root, 'profile');
  const chalkDir = join(sourceDir, 'node_modules', 'chalk');
  const ansiStylesDir = join(chalkDir, 'source', 'vendor', 'ansi-styles');
  await mkdir(join(sourceDir, 'dist'), { recursive: true });
  await mkdir(ansiStylesDir, { recursive: true });
  await writeFile(join(sourceDir, 'openclaw.mjs'), 'export {};\n');
  await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ version: '2026.6.10' }));
  await writeFile(join(sourceDir, 'dist', 'runtime.js'), 'runtime-v1\n');
  await writeFile(join(chalkDir, 'package.json'), JSON.stringify({
    name: 'chalk',
    version: '5.4.1',
    type: 'module',
    imports: {
      '#ansi-styles': './source/vendor/ansi-styles/index.js',
    },
  }));
  await writeFile(join(chalkDir, 'source', 'index.js'), 'export default {};\n');
  await writeFile(join(ansiStylesDir, 'index.js'), 'export default {};\n');
  await writeFile(join(resourcesDir, 'uclaw-build.json'), JSON.stringify({
    appVersion,
    gitCommit: appVersion === '2.0.1' ? 'a'.repeat(40) : 'b'.repeat(40),
    buildId: `${appVersion}-build`,
    platform: process.platform,
    arch: process.arch,
  }));
  return { resourcesDir, sourceDir, profileDir };
}

describe('portable OpenClaw runtime cache', () => {
  it('publishes a complete local runtime and reuses it on the next launch', async () => {
    const fixture = await createFixture();
    expect(findPreparedPortableOpenClawRuntime(fixture)).toBeNull();
    const first = await preparePortableOpenClawRuntime(fixture);
    const second = await preparePortableOpenClawRuntime(fixture);

    expect(first.cacheHit).toBe(false);
    expect(second).toEqual({ ...first, cacheHit: true });
    expect(findPreparedPortableOpenClawRuntime(fixture)).toEqual(second);
    await expect(readFile(join(first.runtimeDir, 'dist', 'runtime.js'), 'utf8')).resolves.toBe('runtime-v1\n');
    await expect(readFile(join(first.runtimeDir, '.uclaw-openclaw-runtime.json'), 'utf8'))
      .resolves.toContain(first.cacheKey);
  });

  it('selects a stable local path before asynchronously publishing first-launch bytes', async () => {
    const fixture = await createFixture();
    const selected = configurePortableOpenClawRuntime(fixture);

    expect(selected.cacheHit).toBe(false);
    expect(process.env.CLAWX_OPENCLAW_RUNTIME_DIR).toBe(selected.runtimeDir);
    await expect(readFile(join(selected.runtimeDir, 'openclaw.mjs'), 'utf8')).rejects.toThrow();

    const prepared = await prepareConfiguredPortableOpenClawRuntime();
    expect(prepared).toEqual({ ...selected, cacheHit: false });
    await expect(readFile(join(selected.runtimeDir, 'openclaw.mjs'), 'utf8')).resolves.toBe('export {};\n');
  });

  it('uses a new cache directory when the packaged build identity changes', async () => {
    const fixture = await createFixture();
    const first = await preparePortableOpenClawRuntime(fixture);
    await writeFile(join(fixture.resourcesDir, 'uclaw-build.json'), JSON.stringify({
      appVersion: '2.0.2',
      gitCommit: 'b'.repeat(40),
      buildId: '2.0.2-build',
      platform: process.platform,
      arch: process.arch,
    }));
    const second = await preparePortableOpenClawRuntime(fixture);

    expect(second.cacheHit).toBe(false);
    expect(second.runtimeDir).not.toBe(first.runtimeDir);
  });

  it('keeps immutable runtime code in a short cache outside the state profile', async () => {
    const fixture = await createFixture();
    const runtimeRootDir = join(fixture.resourcesDir, '..', 'runtime');
    const portableId = '7b9c6bb9-63f1-482f-8248-ef8d80030205';
    const profileDir = join(runtimeRootDir, 'profiles', portableId);
    const cacheRootDir = resolvePortableOpenClawCacheRoot(
      runtimeRootDir,
      portableId,
    );
    const result = await preparePortableOpenClawRuntime({ ...fixture, profileDir, cacheRootDir });
    const legacyRuntimeDir = join(profileDir, 'openclaw-runtime', result.cacheKey);

    expect(result.runtimeDir).toBe(join(cacheRootDir, result.cacheKey));
    expect(result.runtimeDir).not.toBe(legacyRuntimeDir);
    expect(result.runtimeDir.length).toBeLessThan(legacyRuntimeDir.length);
    expect(cacheRootDir).toMatch(/[\\/]oc[\\/][a-f0-9]{16}$/u);
    expect(cacheRootDir).not.toContain(portableId);
  });

  it('derives a stable isolated cache scope for each portable identity', () => {
    const runtimeRootDir = join('C:', 'Users', 'tester', 'AppData', 'Local', 'UClawRuntime');
    const first = resolvePortableOpenClawCacheRoot(runtimeRootDir, 'portable-a');
    const repeated = resolvePortableOpenClawCacheRoot(runtimeRootDir, 'portable-a');
    const second = resolvePortableOpenClawCacheRoot(runtimeRootDir, 'portable-b');

    expect(repeated).toBe(first);
    expect(second).not.toBe(first);
  });

  it('rebuilds a marked cache when a required Chalk source file is deleted', async () => {
    const fixture = await createFixture();
    const first = await preparePortableOpenClawRuntime(fixture);
    const chalkSourcePath = join(first.runtimeDir, 'node_modules', 'chalk', 'source', 'index.js');
    await rm(chalkSourcePath);

    expect(findPreparedPortableOpenClawRuntime(fixture)).toBeNull();
    const repaired = await preparePortableOpenClawRuntime(fixture);

    expect(repaired).toEqual({ ...first, cacheHit: false });
    await expect(readFile(chalkSourcePath, 'utf8')).resolves.toBe('export default {};\n');
    expect(findPreparedPortableOpenClawRuntime(fixture)).toEqual({ ...repaired, cacheHit: true });
  });

  it('rebuilds a marked cache when the Chalk ansi-styles import is damaged', async () => {
    const fixture = await createFixture();
    const first = await preparePortableOpenClawRuntime(fixture);
    const chalkPackagePath = join(first.runtimeDir, 'node_modules', 'chalk', 'package.json');
    const damagedPackage = JSON.parse(await readFile(chalkPackagePath, 'utf8')) as Record<string, unknown>;
    damagedPackage.imports = {
      '#ansi-styles': './source/vendor/ansi-styles/missing.js',
    };
    await writeFile(chalkPackagePath, JSON.stringify(damagedPackage));

    expect(findPreparedPortableOpenClawRuntime(fixture)).toBeNull();
    const repaired = await preparePortableOpenClawRuntime(fixture);
    const repairedPackage = JSON.parse(await readFile(chalkPackagePath, 'utf8')) as {
      imports: Record<string, string>;
    };

    expect(repaired).toEqual({ ...first, cacheHit: false });
    expect(repairedPackage.imports['#ansi-styles'])
      .toBe('./source/vendor/ansi-styles/index.js');
    expect(findPreparedPortableOpenClawRuntime(fixture)).toEqual({ ...repaired, cacheHit: true });
  });

  it('rejects an incomplete packaged runtime without publishing a cache', async () => {
    const fixture = await createFixture();
    await rm(join(fixture.sourceDir, 'openclaw.mjs'));

    await expect(preparePortableOpenClawRuntime(fixture)).rejects.toThrow('incomplete');
  });
});
