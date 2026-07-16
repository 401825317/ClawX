import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('removes an existing transient plugin path while preserving normal plugins', async (t) => {
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
  await sanitizeOpenClawConfig();

  const sanitized = JSON.parse(await readFile(configPath, 'utf8')) as {
    plugins: {
      load: { paths: string[] };
      entries: Record<string, unknown>;
    };
  };
  assert.deepEqual(sanitized.plugins.load.paths, [normalPluginPath]);
  assert.deepEqual(sanitized.plugins.entries['uclaw-blender'], { enabled: true });
});
