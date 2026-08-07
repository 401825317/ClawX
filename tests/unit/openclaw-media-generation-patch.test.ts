// @vitest-environment node

import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const patchModulePath = resolve(repoRoot, 'scripts/openclaw-media-generation-patch.mjs');
const upstreamDetachPolicy = [
  'function shouldDetachMediaGenerationTask(sessionKey) {',
  '\tconst normalizedSessionKey = sessionKey?.trim();',
  '\treturn Boolean(normalizedSessionKey);',
  '}',
].join('\n');

describe('OpenClaw media generation runtime patch', () => {
  it('keeps UClaw image and video generation attached to the active turn', async () => {
    expect(existsSync(patchModulePath)).toBe(true);

    const { rewriteMediaGenerationDetachPolicy } = await import(patchModulePath);
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

    const { patchOpenClawMediaGenerationRuntime } = await import(patchModulePath);
    const root = await mkdtemp(join(tmpdir(), 'uclaw-media-runtime-'));
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
