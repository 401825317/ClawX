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

const OPENAI_VIDEO_PROVIDER_REGISTRATION =
  '\t\tapi.registerVideoGenerationProvider(buildOpenAIVideoGenerationProvider());';
const UCLAW_OPENAI_VIDEO_PROVIDER_DISABLED =
  '\t\t// UCLAW_BUNDLED_OPENAI_VIDEO_PROVIDER_DISABLED';

function countOccurrences(content, value) {
  return content.split(value).length - 1;
}

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

/** Keep the managed UClaw video catalog isolated from OpenAI text credentials. */
export function rewriteOpenAiVideoProviderRegistration(content) {
  const sourceMatches = countOccurrences(content, OPENAI_VIDEO_PROVIDER_REGISTRATION);
  const patchedMatches = countOccurrences(content, UCLAW_OPENAI_VIDEO_PROVIDER_DISABLED);

  if (sourceMatches + patchedMatches !== 1) {
    throw new Error(
      `Expected exactly one OpenAI video provider registration state, found ${sourceMatches} source and ${patchedMatches} patched.`,
    );
  }
  if (patchedMatches === 1) {
    if (content.includes('registerVideoGenerationProvider(')) {
      throw new Error('OpenAI video provider registration remains after applying the UClaw patch.');
    }
    return { content, replacements: 0 };
  }

  const rewritten = content.replace(
    OPENAI_VIDEO_PROVIDER_REGISTRATION,
    UCLAW_OPENAI_VIDEO_PROVIDER_DISABLED,
  );
  if (rewritten.includes('registerVideoGenerationProvider(')) {
    throw new Error('OpenAI video provider registration remains after applying the UClaw patch.');
  }
  return { content: rewritten, replacements: 1 };
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
  let sourceMatches = 0;
  let patchedMatches = 0;
  const pendingWrites = [];

  for (const filePath of runtimeFiles) {
    const content = await readFile(filePath, 'utf8');
    if (content.includes(UPSTREAM_DETACH_POLICY)) sourceMatches += 1;
    if (content.includes(UCLAW_SYNC_MEDIA_POLICY)) patchedMatches += 1;

    const rewritten = rewriteMediaGenerationDetachPolicy(content);
    if (rewritten.replacements > 0) pendingWrites.push({ filePath, content: rewritten.content });
  }

  if (sourceMatches + patchedMatches !== 1) {
    throw new Error(
      `Expected exactly one OpenClaw media generation detach policy, found ${sourceMatches + patchedMatches}.`,
    );
  }

  const openAiExtensionFile = join(distDir, 'extensions', 'openai', 'index.js');
  let openAiExtensionContent;
  try {
    openAiExtensionContent = await readFile(openAiExtensionFile, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`OpenClaw OpenAI extension not found: ${openAiExtensionFile}`);
    }
    throw error;
  }
  const openAiRewrite = rewriteOpenAiVideoProviderRegistration(openAiExtensionContent);
  if (openAiRewrite.replacements > 0) {
    pendingWrites.push({ filePath: openAiExtensionFile, content: openAiRewrite.content });
  }

  for (const pending of pendingWrites) {
    await writeFile(pending.filePath, pending.content, 'utf8');
  }

  return { filesPatched: pendingWrites.length, filesScanned: runtimeFiles.length + 1 };
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
