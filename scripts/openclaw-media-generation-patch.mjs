#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const UPSTREAM_DETACH_POLICY = [
  'function shouldDetachMediaGenerationTask(sessionKey) {',
  '\tconst normalizedSessionKey = sessionKey?.trim();',
  '\treturn Boolean(normalizedSessionKey);',
  '}',
].join('\n');

const UCLAW_SYNC_MEDIA_POLICY = [
  'function shouldDetachMediaGenerationTask(sessionKey) {',
  '\tconst normalizedSessionKey = sessionKey?.trim();',
  '\treturn process.env.UCLAW_SYNC_MEDIA_GENERATION === "1" ? false : Boolean(normalizedSessionKey);',
  '}',
].join('\n');

/**
 * Keep generated media in the originating turn for UClaw's local chat runtime.
 * The upstream fallback remains intact when the UClaw-specific flag is absent.
 */
export function rewriteMediaGenerationDetachPolicy(content) {
  if (content.includes(UCLAW_SYNC_MEDIA_POLICY)) {
    return { content, replacements: 0 };
  }

  if (!content.includes(UPSTREAM_DETACH_POLICY)) {
    return { content, replacements: 0 };
  }

  return {
    content: content.replace(UPSTREAM_DETACH_POLICY, UCLAW_SYNC_MEDIA_POLICY),
    replacements: 1,
  };
}

/**
 * Apply the media completion patch to one OpenClaw runtime and reject unknown layouts.
 */
export async function patchOpenClawMediaGenerationRuntime(openclawDir) {
  const distDir = join(openclawDir, 'dist');
  let entries;
  try {
    entries = await readdir(distDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`OpenClaw dist directory not found: ${distDir}`);
    }
    throw error;
  }

  const runtimeFiles = entries
    .filter((entry) => entry.isFile() && /^openclaw-tools-.*\.js$/u.test(entry.name))
    .map((entry) => join(distDir, entry.name));
  let filesPatched = 0;
  let sourceMatches = 0;
  let patchedMatches = 0;

  for (const filePath of runtimeFiles) {
    const content = await readFile(filePath, 'utf8');
    if (content.includes(UPSTREAM_DETACH_POLICY)) sourceMatches += 1;
    if (content.includes(UCLAW_SYNC_MEDIA_POLICY)) patchedMatches += 1;

    const rewritten = rewriteMediaGenerationDetachPolicy(content);
    if (rewritten.replacements === 0) continue;
    await writeFile(filePath, rewritten.content, 'utf8');
    filesPatched += 1;
  }

  if (sourceMatches + patchedMatches !== 1) {
    throw new Error(
      `Expected exactly one OpenClaw media generation detach policy, found ${sourceMatches + patchedMatches}.`,
    );
  }

  return { filesPatched, filesScanned: runtimeFiles.length };
}

async function main() {
  const openclawDir = join(process.cwd(), 'node_modules', 'openclaw');
  const result = await patchOpenClawMediaGenerationRuntime(openclawDir);
  console.log(
    `[patch-openclaw-media-generation] verified ${result.filesScanned} runtime file(s), patched ${result.filesPatched}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
