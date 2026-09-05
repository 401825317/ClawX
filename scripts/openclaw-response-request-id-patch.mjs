#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_OPENCLAW_VERSION = '2026.6.10';

const RESPONSE_LIFECYCLE_SOURCE = [
  '\t\tconst { data: openaiStream, response } = await client.responses.create(requestParams, buildResponsesRequestOptions(options)).withResponse();',
  '\t\tawait options?.onResponse?.({',
].join('\n');

const PROVIDER_REQUEST_ID_LINES = [
  '\t\tconst providerRequestId = response.headers.get("x-oneapi-request-id");',
  '\t\tif (providerRequestId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(providerRequestId)) output.providerRequestId = providerRequestId;',
].join('\n');

const LEGACY_PROVIDER_REQUEST_ID_LINES = [
  '\t\tconst providerRequestId = ["x-oneapi-request-id", "x-request-id", "request-id"]',
  '\t\t\t.map((headerName) => response.headers.get(headerName))',
  '\t\t\t.find((value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value));',
  '\t\tif (providerRequestId) output.providerRequestId = providerRequestId;',
].join('\n');

const TRIMMED_PROVIDER_REQUEST_ID_LINES = [
  '\t\tconst providerRequestId = response.headers.get("x-oneapi-request-id")?.trim();',
  '\t\tif (providerRequestId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(providerRequestId)) output.providerRequestId = providerRequestId;',
].join('\n');

const RESPONSE_LIFECYCLE_TARGET = [
  '\t\tconst { data: openaiStream, response } = await client.responses.create(requestParams, buildResponsesRequestOptions(options)).withResponse();',
  PROVIDER_REQUEST_ID_LINES,
  '\t\tawait options?.onResponse?.({',
].join('\n');

const LEGACY_RESPONSE_LIFECYCLE_TARGET = [
  '\t\tconst { data: openaiStream, response } = await client.responses.create(requestParams, buildResponsesRequestOptions(options)).withResponse();',
  LEGACY_PROVIDER_REQUEST_ID_LINES,
  '\t\tawait options?.onResponse?.({',
].join('\n');

const TRIMMED_RESPONSE_LIFECYCLE_TARGET = [
  '\t\tconst { data: openaiStream, response } = await client.responses.create(requestParams, buildResponsesRequestOptions(options)).withResponse();',
  TRIMMED_PROVIDER_REQUEST_ID_LINES,
  '\t\tawait options?.onResponse?.({',
].join('\n');

const PARTIAL_PATCH_MARKERS = [
  'response.headers.get("x-oneapi-request-id")',
  'output.providerRequestId = providerRequestId',
];

function countOccurrences(content, value) {
  return content.split(value).length - 1;
}

/** Persist a safe upstream request ID on the assistant output transcript record. */
export function rewriteResponseRequestIdPersistence(content) {
  const patchedMatches = countOccurrences(content, RESPONSE_LIFECYCLE_TARGET);
  if (patchedMatches === 1) {
    return { content, replacements: 0, supported: true };
  }
  if (patchedMatches > 1) {
    throw new Error(`Expected one patched OpenClaw Responses lifecycle, found ${patchedMatches}.`);
  }

  const trimmedMatches = countOccurrences(content, TRIMMED_RESPONSE_LIFECYCLE_TARGET);
  if (trimmedMatches === 1) {
    return {
      content: content.replace(TRIMMED_RESPONSE_LIFECYCLE_TARGET, RESPONSE_LIFECYCLE_TARGET),
      replacements: 1,
      supported: true,
    };
  }
  if (trimmedMatches > 1) {
    throw new Error(`Expected one trimmed OpenClaw Responses lifecycle, found ${trimmedMatches}.`);
  }

  const legacyMatches = countOccurrences(content, LEGACY_RESPONSE_LIFECYCLE_TARGET);
  if (legacyMatches === 1) {
    return {
      content: content.replace(LEGACY_RESPONSE_LIFECYCLE_TARGET, RESPONSE_LIFECYCLE_TARGET),
      replacements: 1,
      supported: true,
    };
  }
  if (legacyMatches > 1) {
    throw new Error(`Expected one legacy OpenClaw Responses lifecycle, found ${legacyMatches}.`);
  }

  const sourceMatches = countOccurrences(content, RESPONSE_LIFECYCLE_SOURCE);
  const hasPartialPatch = PARTIAL_PATCH_MARKERS.some((marker) => content.includes(marker));
  if (hasPartialPatch) {
    throw new Error('Unsupported partial OpenClaw Responses request ID patch layout.');
  }
  if (sourceMatches === 0) {
    return { content, replacements: 0, supported: false };
  }
  if (sourceMatches !== 1) {
    throw new Error(`Expected one pristine OpenClaw Responses lifecycle, found ${sourceMatches}.`);
  }

  return {
    content: content.replace(RESPONSE_LIFECYCLE_SOURCE, RESPONSE_LIFECYCLE_TARGET),
    replacements: 1,
    supported: true,
  };
}

/** Patch exactly one OpenClaw 2026.6.10 Responses runtime layout. */
export async function patchOpenClawResponseRequestIdRuntime(openclawDir) {
  const packageJson = JSON.parse(await readFile(join(openclawDir, 'package.json'), 'utf8'));
  if (packageJson.version !== SUPPORTED_OPENCLAW_VERSION) {
    throw new Error(
      `Expected OpenClaw ${SUPPORTED_OPENCLAW_VERSION}, found ${String(packageJson.version)}.`,
    );
  }

  const distDir = join(openclawDir, 'dist');
  const entries = await readdir(distDir, { withFileTypes: true });
  const runtimeFiles = entries
    .filter((entry) => entry.isFile() && /^openai-responses-shared-.*\.js$/u.test(entry.name))
    .map((entry) => join(distDir, entry.name));

  if (runtimeFiles.length !== 1) {
    throw new Error(
      `Expected exactly one OpenClaw Responses runtime file, found ${runtimeFiles.length}.`,
    );
  }

  const [filePath] = runtimeFiles;
  const content = await readFile(filePath, 'utf8');
  const rewritten = rewriteResponseRequestIdPersistence(content);
  if (!rewritten.supported) {
    throw new Error(`Unsupported OpenClaw Responses request ID layout: ${filePath}`);
  }
  if (rewritten.replacements > 0) {
    await writeFile(filePath, rewritten.content, 'utf8');
  }

  return { filesPatched: rewritten.replacements, filesScanned: runtimeFiles.length };
}

async function main() {
  const openclawDir = join(process.cwd(), 'node_modules', 'openclaw');
  const result = await patchOpenClawResponseRequestIdRuntime(openclawDir);
  console.log(
    `[patch-openclaw-response-request-id] verified ${result.filesScanned} runtime file(s), patched ${result.filesPatched}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
