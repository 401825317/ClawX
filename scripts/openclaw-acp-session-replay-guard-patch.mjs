#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUPPORTED_OPENCLAW_VERSION = '2026.6.10';
export const ACP_LOAD_SESSION_REPLAY_LIMIT = 1_000;
export const ACP_LOAD_SESSION_REPLAY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Return the exact UTF-8 byte count of a JSON string, including quotes and
 * escaping. Gateway session messages are JSON values, so this lets the guard
 * enforce a byte ceiling without allocating a second serialized transcript.
 */
export function estimateAcpReplayJsonStringBytes(value) {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Conservatively count a gateway JSON value. Unknown prototypes and cycles
 * exceed the budget deliberately so an unexpected runtime shape fails closed.
 */
export function estimateAcpReplayValueBytes(value, maxBytes = ACP_LOAD_SESSION_REPLAY_MAX_BYTES) {
  const budget = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : ACP_LOAD_SESSION_REPLAY_MAX_BYTES;
  const stack = [value];
  const seen = new WeakSet();
  let bytes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null) bytes += 4;
    else if (typeof current === "string") bytes += estimateAcpReplayJsonStringBytes(current);
    else if (typeof current === "boolean") bytes += current ? 4 : 5;
    else if (typeof current === "number" && Number.isFinite(current)) bytes += String(current).length;
    else if (typeof current !== "object") return budget + 1;
    else {
      if (seen.has(current)) return budget + 1;
      seen.add(current);
      if (Array.isArray(current)) {
        bytes += 2 + Math.max(0, current.length - 1);
        for (let index = current.length - 1; index >= 0; index -= 1) stack.push(current[index]);
      } else {
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null) return budget + 1;
        const keys = Object.keys(current);
        bytes += 2 + Math.max(0, keys.length - 1);
        for (const key of keys) {
          bytes += estimateAcpReplayJsonStringBytes(key) + 1;
          stack.push(current[key]);
        }
      }
    }
    if (bytes > budget) return budget + 1;
  }

  return bytes;
}

/**
 * Select the newest messages that fit, then restore chronological order for
 * replay. An oversized message is skipped so older usable context survives;
 * no single message can break the total byte ceiling.
 */
export function boundAcpSessionReplayMessages(
  messages,
  maxMessages = ACP_LOAD_SESSION_REPLAY_LIMIT,
  maxBytes = ACP_LOAD_SESSION_REPLAY_MAX_BYTES,
) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const messageLimit = Number.isFinite(maxMessages) ? Math.max(0, Math.floor(maxMessages)) : ACP_LOAD_SESSION_REPLAY_LIMIT;
  const byteLimit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : ACP_LOAD_SESSION_REPLAY_MAX_BYTES;
  if (messageLimit === 0 || byteLimit < 2) return [];

  const tail = [];
  const firstAllowedIndex = Math.max(0, messages.length - messageLimit);
  let totalBytes = 2;
  for (let index = messages.length - 1; index >= firstAllowedIndex; index -= 1) {
    const commaBytes = tail.length > 0 ? 1 : 0;
    const remainingBytes = byteLimit - totalBytes - commaBytes;
    if (remainingBytes < 0) break;
    const messageBytes = estimateAcpReplayValueBytes(messages[index], remainingBytes);
    if (messageBytes > remainingBytes) continue;
    tail.push(messages[index]);
    totalBytes += commaBytes + messageBytes;
  }

  tail.reverse();
  return tail;
}

const SOURCE_CONSTANTS = [
  'const MAX_PROMPT_BYTES = 2 * 1024 * 1024;',
  'const ACP_LOAD_SESSION_REPLAY_LIMIT = 1e6;',
  'const ACP_GATEWAY_DISCONNECT_GRACE_MS = 5e3;',
].join('\n');

const TARGET_CONSTANTS = [
  'const MAX_PROMPT_BYTES = 2 * 1024 * 1024;',
  `const ACP_LOAD_SESSION_REPLAY_LIMIT = ${ACP_LOAD_SESSION_REPLAY_LIMIT};`,
  `const ACP_LOAD_SESSION_REPLAY_MAX_BYTES = ${ACP_LOAD_SESSION_REPLAY_MAX_BYTES};`,
  estimateAcpReplayJsonStringBytes.toString(),
  estimateAcpReplayValueBytes.toString(),
  boundAcpSessionReplayMessages.toString(),
  'const ACP_GATEWAY_DISCONNECT_GRACE_MS = 5e3;',
].join('\n');

const SOURCE_TRANSCRIPT_RETURN = [
  '\tasync getSessionTranscript(sessionKey) {',
  '\t\tconst result = await this.gateway.request("sessions.get", {',
  '\t\t\tkey: sessionKey,',
  '\t\t\tlimit: ACP_LOAD_SESSION_REPLAY_LIMIT',
  '\t\t});',
  '\t\tif (!Array.isArray(result.messages)) return [];',
  '\t\treturn result.messages;',
  '\t}',
].join('\n');

const TARGET_TRANSCRIPT_RETURN = SOURCE_TRANSCRIPT_RETURN.replace(
  '\t\treturn result.messages;',
  '\t\treturn boundAcpSessionReplayMessages(result.messages);',
);

function countOccurrences(content, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

export function rewriteAcpSessionReplayGuard(content) {
  const constantsSource = countOccurrences(content, SOURCE_CONSTANTS);
  const constantsTarget = countOccurrences(content, TARGET_CONSTANTS);
  const transcriptSource = countOccurrences(content, SOURCE_TRANSCRIPT_RETURN);
  const transcriptTarget = countOccurrences(content, TARGET_TRANSCRIPT_RETURN);

  if (
    constantsSource === 0 &&
    transcriptSource === 0 &&
    constantsTarget === 1 &&
    transcriptTarget === 1
  ) {
    return { content, replacements: 0, supported: true, partial: false };
  }
  if (
    constantsSource === 1 &&
    transcriptSource === 1 &&
    constantsTarget === 0 &&
    transcriptTarget === 0
  ) {
    const rewritten = content
      .replace(SOURCE_CONSTANTS, TARGET_CONSTANTS)
      .replace(SOURCE_TRANSCRIPT_RETURN, TARGET_TRANSCRIPT_RETURN);
    if (
      countOccurrences(rewritten, SOURCE_CONSTANTS) !== 0 ||
      countOccurrences(rewritten, SOURCE_TRANSCRIPT_RETURN) !== 0 ||
      countOccurrences(rewritten, TARGET_CONSTANTS) !== 1 ||
      countOccurrences(rewritten, TARGET_TRANSCRIPT_RETURN) !== 1
    ) {
      return { content, replacements: 0, supported: false, partial: true };
    }
    return {
      content: rewritten,
      replacements: 2,
      supported: true,
      partial: false,
    };
  }

  const partial = constantsSource + constantsTarget + transcriptSource + transcriptTarget > 0;
  return { content, replacements: 0, supported: false, partial };
}

/**
 * Patch exactly one known OpenClaw 2026.6.10 ACP CLI layout. Any version,
 * file-count, partial-patch, or generated-code drift aborts without writing.
 */
export async function patchOpenClawAcpSessionReplayRuntime(openclawDir) {
  const packageJson = JSON.parse(await readFile(join(openclawDir, 'package.json'), 'utf8'));
  if (packageJson.version !== SUPPORTED_OPENCLAW_VERSION) {
    throw new Error(
      `Expected OpenClaw ${SUPPORTED_OPENCLAW_VERSION}, found ${String(packageJson.version)}.`,
    );
  }

  const distDir = join(openclawDir, 'dist');
  const entries = await readdir(distDir, { withFileTypes: true });
  const runtimeFiles = entries
    .filter((entry) => entry.isFile() && /^acp-cli-.*\.js$/u.test(entry.name))
    .map((entry) => join(distDir, entry.name));
  if (runtimeFiles.length !== 1) {
    throw new Error(
      `Expected exactly one OpenClaw ACP CLI runtime file, found ${runtimeFiles.length}.`,
    );
  }

  const [filePath] = runtimeFiles;
  const content = await readFile(filePath, 'utf8');
  const rewritten = rewriteAcpSessionReplayGuard(content);
  if (!rewritten.supported) {
    const layout = rewritten.partial ? 'partial' : 'unknown';
    throw new Error(`Unsupported ${layout} OpenClaw ACP session replay layout: ${filePath}`);
  }
  if (rewritten.replacements === 0) {
    return { filesPatched: 0, filesScanned: 1 };
  }

  await writeFile(filePath, rewritten.content, 'utf8');
  return { filesPatched: 1, filesScanned: 1 };
}

async function main() {
  const openclawDir = join(process.cwd(), 'node_modules', 'openclaw');
  const result = await patchOpenClawAcpSessionReplayRuntime(openclawDir);
  console.log(
    `[patch-openclaw-acp-session-replay-guard] verified ${result.filesScanned} runtime file(s), patched ${result.filesPatched}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
