import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('sanitizes transient plugin paths and preserves the OpenClaw version guard', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'uclaw-plugin-sanitize-'));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const stateDir = path.join(tempRoot, '.openclaw');
  process.env.OPENCLAW_STATE_DIR = stateDir;

  t.after(async () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const extensionsRoot = path.join(stateDir, 'extensions');
  const transientPath = path.join(
    extensionsRoot,
    '.uclaw-blender.uclaw-staging-8064-test',
  );
  const normalPluginPath = path.join(extensionsRoot, 'custom-plugin');
  await mkdir(transientPath, { recursive: true });
  await mkdir(normalPluginPath, { recursive: true });

  const configPath = path.join(stateDir, 'openclaw.json');
  await writeFile(configPath, JSON.stringify({
    meta: {
      lastTouchedVersion: '2026.6.11',
      lastTouchedAt: '2026-06-30T00:00:00.000Z',
    },
    plugins: {
      load: {
        paths: [transientPath, normalPluginPath],
      },
      entries: {
        'uclaw-blender': { enabled: true },
      },
    },
  }, null, 2));

  const { sanitizeOpenClawConfig } = await import('../electron/utils/openclaw-auth.ts');
  const { getOpenClawResolvedDir } = await import('../electron/utils/paths.ts');
  await sanitizeOpenClawConfig();

  const sanitized = JSON.parse(await readFile(configPath, 'utf8')) as {
    meta: {
      lastTouchedVersion: string;
      lastTouchedAt: string;
    };
    plugins: {
      load: { paths: string[] };
      entries: Record<string, unknown>;
    };
  };
  const runtimeManifest = JSON.parse(
    await readFile(path.join(getOpenClawResolvedDir(), 'package.json'), 'utf8'),
  ) as { version: string };
  assert.deepEqual(sanitized.plugins.load.paths, [normalPluginPath]);
  assert.deepEqual(sanitized.plugins.entries['uclaw-blender'], { enabled: true });
  assert.equal(sanitized.meta.lastTouchedVersion, runtimeManifest.version);
  assert.ok(Number.isFinite(Date.parse(sanitized.meta.lastTouchedAt)));

  const futureConfig = JSON.stringify({
    meta: {
      lastTouchedVersion: '9999.1.1',
      lastTouchedAt: '9999-01-01T00:00:00.000Z',
    },
    plugins: {
      load: {
        paths: [transientPath, normalPluginPath],
      },
    },
  }, null, 2);
  await writeFile(configPath, futureConfig);

  await assert.rejects(
    sanitizeOpenClawConfig(),
    /newer than or incompatible with bundled OpenClaw/,
  );
  assert.equal(await readFile(configPath, 'utf8'), futureConfig);
});
