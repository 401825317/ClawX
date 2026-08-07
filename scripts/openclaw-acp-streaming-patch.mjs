#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_OPENCLAW_VERSION = '2026.6.10';

const REWRITES = [
  [
    'const streamedTextFragments = [];',
    'const streamedTextFragmentsByMessage = /* @__PURE__ */ new Map();',
  ],
  [
    'if (!isStatusNotice && reply.trimmedText) streamedTextFragments.push(reply.trimmedText);',
    [
      'if (!isStatusNotice && reply.trimmedText) {',
      '\t\t\t\tconst assistantMessageIndex = getReplyPayloadMetadata(payload)?.assistantMessageIndex;',
      '\t\t\t\tconst fragments = streamedTextFragmentsByMessage.get(assistantMessageIndex) ?? [];',
      '\t\t\t\tfragments.push(reply.trimmedText);',
      '\t\t\t\tstreamedTextFragmentsByMessage.set(assistantMessageIndex, fragments);',
      '\t\t\t}',
    ].join('\n'),
  ],
  [
    'if (!didStream || streamedTextFragments.length === 0) return false;',
    'if (!didStream) return false;',
  ],
  [
    'return normalize(streamedTextFragments.join("")) === normalize(reply.trimmedText);',
    [
      'const target = normalize(reply.trimmedText);',
      '\t\t\tfor (const fragments of streamedTextFragmentsByMessage.values()) {',
      '\t\t\t\tif (fragments.length > 0 && normalize(fragments.join("")) === target) return true;',
      '\t\t\t}',
      '\t\t\treturn false;',
    ].join('\n'),
  ],
];

/**
 * Backport OpenClaw's per-assistant-message stream suppression fix.
 */
export function rewriteMultiMessageStreamSuppression(content) {
  let rewritten = content;
  let replacements = 0;

  for (const [source, target] of REWRITES) {
    if (!rewritten.includes(source)) continue;
    rewritten = rewritten.replace(source, target);
    replacements += 1;
  }

  return { content: rewritten, replacements };
}

/**
 * Patch exactly one supported OpenClaw 6.10 block-reply pipeline.
 */
export async function patchOpenClawAcpStreamingRuntime(openclawDir) {
  const packageJsonPath = join(openclawDir, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  if (packageJson.version !== SUPPORTED_OPENCLAW_VERSION) {
    throw new Error(
      `Expected OpenClaw ${SUPPORTED_OPENCLAW_VERSION}, found ${String(packageJson.version)}.`,
    );
  }

  const distDir = join(openclawDir, 'dist');
  const entries = await readdir(distDir, { withFileTypes: true });
  const runtimeFiles = entries
    .filter((entry) => entry.isFile() && /^block-reply-pipeline-.*\.js$/u.test(entry.name))
    .map((entry) => join(distDir, entry.name));

  let filesPatched = 0;
  let supportedFiles = 0;

  // Accept either the pristine 6.10 source or the fully patched form so installs stay idempotent.
  for (const filePath of runtimeFiles) {
    const content = await readFile(filePath, 'utf8');
    const hasSourceLayout = content.includes(REWRITES[0][0]);
    const hasPatchedLayout = content.includes(REWRITES[0][1]);
    if (!hasSourceLayout && !hasPatchedLayout) continue;
    supportedFiles += 1;

    const rewritten = rewriteMultiMessageStreamSuppression(content);
    const isFullyPatched = REWRITES.every(([, target]) => rewritten.content.includes(target));
    if (!isFullyPatched) {
      throw new Error(`Unsupported partial OpenClaw ACP streaming patch layout: ${filePath}`);
    }
    if (rewritten.replacements === 0) continue;

    await writeFile(filePath, rewritten.content, 'utf8');
    filesPatched += 1;
  }

  if (supportedFiles !== 1) {
    throw new Error(
      `Expected exactly one supported OpenClaw ACP streaming pipeline, found ${supportedFiles}.`,
    );
  }

  return { filesPatched, filesScanned: runtimeFiles.length };
}

async function main() {
  const openclawDir = join(process.cwd(), 'node_modules', 'openclaw');
  const result = await patchOpenClawAcpStreamingRuntime(openclawDir);
  console.log(
    `[patch-openclaw-acp-streaming] verified ${result.filesScanned} runtime file(s), patched ${result.filesPatched}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
