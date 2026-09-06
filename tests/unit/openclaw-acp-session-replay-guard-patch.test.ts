// @vitest-environment node

import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const patchModulePath = resolve(
  repoRoot,
  'scripts/openclaw-acp-session-replay-guard-patch.mjs',
);
const tempRoots = new Set<string>();

const sourceConstants = [
  'const MAX_PROMPT_BYTES = 2 * 1024 * 1024;',
  'const ACP_LOAD_SESSION_REPLAY_LIMIT = 1e6;',
  'const ACP_GATEWAY_DISCONNECT_GRACE_MS = 5e3;',
].join('\n');

const sourceTranscriptMethod = [
  '\tasync getSessionTranscript(sessionKey) {',
  '\t\tconst result = await this.gateway.request("sessions.get", {',
  '\t\t\tkey: sessionKey,',
  '\t\t\tlimit: ACP_LOAD_SESSION_REPLAY_LIMIT',
  '\t\t});',
  '\t\tif (!Array.isArray(result.messages)) return [];',
  '\t\treturn result.messages;',
  '\t}',
].join('\n');

const upstreamRuntime = `${sourceConstants}\n${sourceTranscriptMethod}`;

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

async function importPatchModule(): Promise<
  typeof import('../../scripts/openclaw-acp-session-replay-guard-patch.mjs')
> {
  const root = await createTempRoot('uclaw-acp-replay-guard-module-');
  const modulePath = join(root, 'openclaw-acp-session-replay-guard-patch.mjs');
  const source = (await readFile(patchModulePath, 'utf8')).replace(/^#![^\r\n]*(?:\r?\n|$)/, '');
  await writeFile(modulePath, source, 'utf8');
  return await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}-${Math.random()}`);
}

async function writeRuntime(version = '2026.6.10', content = upstreamRuntime) {
  const root = await createTempRoot('uclaw-acp-replay-guard-runtime-');
  const dist = join(root, 'dist');
  await mkdir(dist, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ version }), 'utf8');
  const target = join(dist, 'acp-cli-test.js');
  await writeFile(target, content, 'utf8');
  return { root, dist, target };
}

afterEach(async () => {
  await Promise.all([...tempRoots].map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.clear();
});

describe('OpenClaw 2026.6.10 ACP session replay guard patch', () => {
  it('keeps only the newest 1,000 messages in chronological order', async () => {
    const { ACP_LOAD_SESSION_REPLAY_LIMIT, boundAcpSessionReplayMessages } =
      await importPatchModule();
    const messages = Array.from({ length: 1_105 }, (_, id) => ({ id, text: `message-${id}` }));

    const bounded = boundAcpSessionReplayMessages(messages);

    expect(ACP_LOAD_SESSION_REPLAY_LIMIT).toBe(1_000);
    expect(bounded).toHaveLength(1_000);
    expect(bounded[0]).toEqual(messages[105]);
    expect(bounded.at(-1)).toEqual(messages[1_104]);
  });

  it('enforces the byte ceiling while retaining the newest usable messages', async () => {
    const {
      boundAcpSessionReplayMessages,
      estimateAcpReplayValueBytes,
    } = await importPatchModule();
    const messages = Array.from({ length: 4 }, (_, id) => ({ id, text: `payload-${id}` }));
    const newestTwoBytes = estimateAcpReplayValueBytes(messages.slice(-2));
    const newestOneBytes = estimateAcpReplayValueBytes(messages.slice(-1));

    expect(boundAcpSessionReplayMessages(messages, 1_000, newestTwoBytes)).toEqual(
      messages.slice(-2),
    );
    expect(boundAcpSessionReplayMessages(messages, 1_000, newestOneBytes)).toEqual(
      messages.slice(-1),
    );
  });

  it('rejects a single oversized newest message instead of exceeding the byte limit', async () => {
    const {
      boundAcpSessionReplayMessages,
      estimateAcpReplayValueBytes,
    } = await importPatchModule();
    const oversized = { id: 'large', text: 'x'.repeat(4_096) };
    const serializedBytes = estimateAcpReplayValueBytes(oversized);

    expect(boundAcpSessionReplayMessages([oversized], 1_000, serializedBytes - 1)).toEqual([]);
  });

  it('skips an oversized newest message and keeps older messages within the budget', async () => {
    const { boundAcpSessionReplayMessages, estimateAcpReplayValueBytes } = await importPatchModule();
    const older = { id: 'older', text: 'usable' };
    const oversized = { id: 'large', text: 'x'.repeat(4_096) };
    const byteLimit = estimateAcpReplayValueBytes([older]);

    expect(boundAcpSessionReplayMessages([older, oversized], 1_000, byteLimit)).toEqual([older]);
  });

  it('counts JSON escaping and UTF-8 bytes without serializing the transcript', async () => {
    const { estimateAcpReplayValueBytes } = await importPatchModule();
    const value = {
      ascii: 'quote=" slash=\\ newline=\n',
      chinese: '历史回放',
      supplementary: '\ud83d\ude80',
      control: '\u0001',
    };

    expect(estimateAcpReplayValueBytes(value)).toBe(
      Buffer.byteLength(JSON.stringify(value), 'utf8'),
    );
  });

  it('fails closed for values that are not valid gateway JSON', async () => {
    const { boundAcpSessionReplayMessages } = await importPatchModule();
    const cyclic: Record<string, unknown> = { id: 'cycle' };
    cyclic.self = cyclic;

    expect(boundAcpSessionReplayMessages([{ value: undefined }], 1_000, 1_024)).toEqual([]);
    expect(boundAcpSessionReplayMessages([cyclic], 1_000, 1_024)).toEqual([]);
  });

  it('patches the exact supported layout and remains idempotent', async () => {
    expect(existsSync(patchModulePath)).toBe(true);
    const { patchOpenClawAcpSessionReplayRuntime } = await importPatchModule();
    const runtime = await writeRuntime();

    await expect(patchOpenClawAcpSessionReplayRuntime(runtime.root)).resolves.toEqual({
      filesPatched: 1,
      filesScanned: 1,
    });
    const patched = await readFile(runtime.target, 'utf8');
    expect(patched).toContain('const ACP_LOAD_SESSION_REPLAY_LIMIT = 1000;');
    expect(patched).toContain('const ACP_LOAD_SESSION_REPLAY_MAX_BYTES = 8388608;');
    expect(patched).toContain('return boundAcpSessionReplayMessages(result.messages);');
    expect(patched).not.toContain('ACP_LOAD_SESSION_REPLAY_LIMIT = 1e6');

    await expect(patchOpenClawAcpSessionReplayRuntime(runtime.root)).resolves.toEqual({
      filesPatched: 0,
      filesScanned: 1,
    });
  });

  it('rejects unsupported versions, unknown or partial layouts, and ambiguous files', async () => {
    const { patchOpenClawAcpSessionReplayRuntime, rewriteAcpSessionReplayGuard } =
      await importPatchModule();
    const wrongVersion = await writeRuntime('2026.6.11');
    await expect(patchOpenClawAcpSessionReplayRuntime(wrongVersion.root)).rejects.toThrow(
      'Expected OpenClaw 2026.6.10, found 2026.6.11',
    );

    const unknown = await writeRuntime('2026.6.10', 'unknown ACP runtime layout');
    await expect(patchOpenClawAcpSessionReplayRuntime(unknown.root)).rejects.toThrow(
      'Unsupported unknown OpenClaw ACP session replay layout',
    );

    const partial = await writeRuntime('2026.6.10', sourceConstants);
    await expect(patchOpenClawAcpSessionReplayRuntime(partial.root)).rejects.toThrow(
      'Unsupported partial OpenClaw ACP session replay layout',
    );
    expect(rewriteAcpSessionReplayGuard(sourceConstants)).toMatchObject({
      replacements: 0,
      supported: false,
      partial: true,
    });

    const duplicateLayout = await writeRuntime(
      '2026.6.10',
      `${upstreamRuntime}\n${upstreamRuntime}`,
    );
    await expect(patchOpenClawAcpSessionReplayRuntime(duplicateLayout.root)).rejects.toThrow(
      'Unsupported partial OpenClaw ACP session replay layout',
    );

    const ambiguous = await writeRuntime();
    await writeFile(join(ambiguous.dist, 'acp-cli-other.js'), upstreamRuntime, 'utf8');
    await expect(patchOpenClawAcpSessionReplayRuntime(ambiguous.root)).rejects.toThrow(
      'Expected exactly one OpenClaw ACP CLI runtime file, found 2',
    );
  });

  it('runs during dependency installation and OpenClaw bundling', async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
      scripts: Record<string, string>;
    };
    const bundleScript = await readFile(join(repoRoot, 'scripts/bundle-openclaw.mjs'), 'utf8');

    expect(packageJson.devDependencies?.openclaw).toBe('2026.6.10');
    expect(packageJson.scripts.postinstall).toContain(
      'openclaw-acp-session-replay-guard-patch.mjs',
    );
    expect(bundleScript).toContain(
      "import { patchOpenClawAcpSessionReplayRuntime } from './openclaw-acp-session-replay-guard-patch.mjs';",
    );
    expect(bundleScript).toContain('await patchOpenClawAcpSessionReplayRuntime(OUTPUT)');
  });
});
