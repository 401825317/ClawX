// @vitest-environment node

import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const patchModulePath = resolve(repoRoot, 'scripts/openclaw-media-generation-patch.mjs');
const tempRoots = new Set<string>();
const upstreamDetachPolicy = [
  'function shouldDetachMediaGenerationTask(sessionKey) {',
  '\tconst normalizedSessionKey = sessionKey?.trim();',
  '\treturn Boolean(normalizedSessionKey);',
  '}',
].join('\n');

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

async function importPatchModule(): Promise<typeof import('../../scripts/openclaw-media-generation-patch.mjs')> {
  const root = await createTempRoot('uclaw-media-patch-module-');
  const modulePath = join(root, 'openclaw-media-generation-patch.mjs');
  const source = (await readFile(patchModulePath, 'utf8')).replace(/^#![^\r\n]*(?:\r?\n|$)/, '');
  await writeFile(modulePath, source, 'utf8');
  return await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}-${Math.random()}`);
}

afterEach(async () => {
  await Promise.all([...tempRoots].map(root => rm(root, { recursive: true, force: true })));
  tempRoots.clear();
});

describe('OpenClaw media generation runtime patch', () => {
  it('keeps UClaw image and video generation attached to the active turn', async () => {
    expect(existsSync(patchModulePath)).toBe(true);

    const { rewriteMediaGenerationDetachPolicy } = await importPatchModule();
    const source = `before\n${upstreamDetachPolicy}\nafter`;
    const rewritten = rewriteMediaGenerationDetachPolicy(source);

    expect(rewritten.replacements).toBe(1);
    expect(rewritten.content).toContain(
      'return process.env.UCLAW_SYNC_MEDIA_GENERATION === "1" ? false : Boolean(normalizedSessionKey);',
    );
    expect(rewriteMediaGenerationDetachPolicy(rewritten.content)).toEqual({
      content: rewritten.content,
      replacements: 0,
    });
  });

  it('patches the copied runtime and rejects an unsupported OpenClaw layout', async () => {
    expect(existsSync(patchModulePath)).toBe(true);

    const { patchOpenClawMediaGenerationRuntime } = await importPatchModule();
    const root = await createTempRoot('uclaw-media-runtime-');
    const dist = join(root, 'dist');
    await mkdir(dist, { recursive: true });
    const target = join(dist, 'openclaw-tools-test.js');
    await writeFile(target, `before\n${upstreamDetachPolicy}\nafter`, 'utf8');

    await expect(patchOpenClawMediaGenerationRuntime(root)).resolves.toEqual({
      filesPatched: 1,
      filesScanned: 1,
    });
    await expect(readFile(target, 'utf8')).resolves.toContain('UCLAW_SYNC_MEDIA_GENERATION');

    await expect(patchOpenClawMediaGenerationRuntime(join(root, 'missing')))
      .rejects.toThrow('OpenClaw dist directory not found');
  });
});
