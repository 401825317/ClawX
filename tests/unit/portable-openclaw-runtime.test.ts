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
  await mkdir(join(sourceDir, 'dist'), { recursive: true });
  await writeFile(join(sourceDir, 'openclaw.mjs'), 'export {};\n');
  await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ version: '2026.6.10' }));
  await writeFile(join(sourceDir, 'dist', 'runtime.js'), 'runtime-v1\n');
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

  it('rejects an incomplete packaged runtime without publishing a cache', async () => {
    const fixture = await createFixture();
    await rm(join(fixture.sourceDir, 'openclaw.mjs'));

    await expect(preparePortableOpenClawRuntime(fixture)).rejects.toThrow('incomplete');
  });
});
