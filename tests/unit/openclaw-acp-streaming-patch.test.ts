// @vitest-environment node

import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const patchModulePath = resolve(repoRoot, 'scripts/openclaw-acp-streaming-patch.mjs');
const upstreamFragments = [
  'const streamedTextFragments = [];',
  'if (!isStatusNotice && reply.trimmedText) streamedTextFragments.push(reply.trimmedText);',
  'if (!didStream || streamedTextFragments.length === 0) return false;',
  'return normalize(streamedTextFragments.join("")) === normalize(reply.trimmedText);',
].join('\n');

describe('OpenClaw 6.10 ACP streaming runtime patch', () => {
  it('groups streamed fragments by assistant message and remains idempotent', async () => {
    expect(existsSync(patchModulePath)).toBe(true);

    const { rewriteMultiMessageStreamSuppression } = await import(patchModulePath);
    const rewritten = rewriteMultiMessageStreamSuppression(upstreamFragments);

    expect(rewritten.replacements).toBe(4);
    expect(rewritten.content).toContain('const streamedTextFragmentsByMessage = /* @__PURE__ */ new Map();');
    expect(rewritten.content).toContain('const assistantMessageIndex = getReplyPayloadMetadata(payload)?.assistantMessageIndex;');
    expect(rewritten.content).toContain('for (const fragments of streamedTextFragmentsByMessage.values())');
    expect(rewriteMultiMessageStreamSuppression(rewritten.content)).toEqual({
      content: rewritten.content,
      replacements: 0,
    });
  });

  it('patches only the supported OpenClaw 6.10 runtime layout', async () => {
    expect(existsSync(patchModulePath)).toBe(true);

    const { patchOpenClawAcpStreamingRuntime } = await import(patchModulePath);
    const root = await mkdtemp(join(tmpdir(), 'uclaw-acp-streaming-runtime-'));
    const dist = join(root, 'dist');
    await mkdir(dist, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '2026.6.10' }), 'utf8');
    const target = join(dist, 'block-reply-pipeline-test.js');
    await writeFile(target, upstreamFragments, 'utf8');

    await expect(patchOpenClawAcpStreamingRuntime(root)).resolves.toEqual({
      filesPatched: 1,
      filesScanned: 1,
    });
    await expect(readFile(target, 'utf8')).resolves.toContain('streamedTextFragmentsByMessage');
    await expect(patchOpenClawAcpStreamingRuntime(root)).resolves.toEqual({
      filesPatched: 0,
      filesScanned: 1,
    });

    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '2026.6.11' }), 'utf8');
    await expect(patchOpenClawAcpStreamingRuntime(root)).rejects.toThrow(
      'Expected OpenClaw 2026.6.10',
    );
  });

  it('rejects an unknown OpenClaw 6.10 runtime layout', async () => {
    expect(existsSync(patchModulePath)).toBe(true);

    const { patchOpenClawAcpStreamingRuntime } = await import(patchModulePath);
    const root = await mkdtemp(join(tmpdir(), 'uclaw-acp-streaming-unknown-'));
    const dist = join(root, 'dist');
    await mkdir(dist, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '2026.6.10' }), 'utf8');
    await writeFile(join(dist, 'block-reply-pipeline-test.js'), 'unknown runtime layout', 'utf8');

    await expect(patchOpenClawAcpStreamingRuntime(root)).rejects.toThrow(
      'Expected exactly one supported OpenClaw ACP streaming pipeline',
    );
  });

  it('applies the same patch during dependency installation and OpenClaw bundling', async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    const bundleScript = await readFile(join(repoRoot, 'scripts/bundle-openclaw.mjs'), 'utf8');

    expect(packageJson.devDependencies.openclaw).toBe('2026.6.10');
    expect(packageJson.scripts.postinstall).toContain('openclaw-acp-streaming-patch.mjs');
    expect(bundleScript).toContain('patchOpenClawAcpStreamingRuntime(OUTPUT)');
  });
});
