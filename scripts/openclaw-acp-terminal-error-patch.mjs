#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_OPENCLAW_VERSION = '2026.6.10';

const ACP_ERROR_HELPER_SOURCE = '/** ACP Agent implementation backed by the OpenClaw Gateway and replay ledger. */';
const ACP_ERROR_HELPER_LEGACY_TARGET = [
  'function buildAcpPromptError(value, fallback) {',
  '\tconst record = value && typeof value === "object" ? value : void 0;',
  '\tconst messageText = record?.message && typeof record.message === "object" && Array.isArray(record.message.content) ? record.message.content.map((block) => typeof block?.text === "string" ? block.text : "").filter(Boolean).join("\\n").trim() : "";',
  '\tconst message = typeof record?.errorMessage === "string" && record.errorMessage.trim() || typeof record?.error === "string" && record.error.trim() || typeof record?.message === "string" && record.message.trim() || messageText || fallback;',
  '\treturn new Error(message, { cause: value });',
  '}',
  ACP_ERROR_HELPER_SOURCE,
].join('\n');
const ACP_ERROR_HELPER_TARGET = [
  'function buildAcpPromptError(value, fallback) {',
  '\tconst record = value && typeof value === "object" ? value : void 0;',
  '\tconst messageText = record?.message && typeof record.message === "object" && Array.isArray(record.message.content) ? record.message.content.map((block) => typeof block?.text === "string" ? block.text : "").filter(Boolean).join("\\n").trim() : "";',
  '\tconst message = typeof record?.errorMessage === "string" && record.errorMessage.trim() || typeof record?.error === "string" && record.error.trim() || typeof record?.message === "string" && record.message.trim() || messageText || fallback;',
  '\treturn new Error(message, { cause: value });',
  '}',
  'function getUclawTranscriptMessage(value) {',
  '\tconst record = value && typeof value === "object" && !Array.isArray(value) ? value : void 0;',
  '\tconst nested = record?.message && typeof record.message === "object" && !Array.isArray(record.message) ? record.message : void 0;',
  '\treturn nested && typeof nested.role === "string" ? nested : record;',
  '}',
  'function getUclawTranscriptError(message) {',
  '\tif (!message || message.role !== "assistant" || message.stopReason !== "error") return;',
  '\tconst errorMessage = typeof message.errorMessage === "string" && message.errorMessage.trim();',
  '\tif (!errorMessage) return;',
  '\tconst errorCode = typeof message.errorCode === "string" && message.errorCode.trim() || typeof message.errorType === "string" && message.errorType.trim() || void 0;',
  '\treturn { errorMessage, ...errorCode ? { errorCode } : {} };',
  '}',
  'function findUclawLatestTurnTranscriptError(transcript) {',
  '\tif (!Array.isArray(transcript)) return;',
  '\tlet latestUserIndex = -1;',
  '\tfor (let index = transcript.length - 1; index >= 0; index -= 1) {',
  '\t\tif (getUclawTranscriptMessage(transcript[index])?.role !== "user") continue;',
  '\t\tlatestUserIndex = index;',
  '\t\tbreak;',
  '\t}',
  '\tif (latestUserIndex < 0) return;',
  '\tfor (let index = transcript.length - 1; index > latestUserIndex; index -= 1) {',
  '\t\tconst message = getUclawTranscriptMessage(transcript[index]);',
  '\t\tif (message?.role !== "assistant") continue;',
  '\t\treturn getUclawTranscriptError(message);',
  '\t}',
  '}',
  'function getUclawTranscriptUserMessageId(message, index) {',
  '\tfor (const key of ["messageId", "idempotencyKey", "id"]) {',
  '\t\tconst value = message?.[key];',
  '\t\tif (typeof value === "string" && value.trim()) return value.trim();',
  '\t}',
  '\treturn `uclaw-transcript-user-${index}`;',
  '}',
  ACP_ERROR_HELPER_SOURCE,
].join('\n');

const ACP_STATE_ERROR_SOURCE = [
  '\t\tif (state === "error") {',
  '\t\t\tconst stopReason = payload.errorKind === "refusal" ? "refusal" : "end_turn";',
  '\t\t\tthis.finishPrompt(pending.sessionId, pending, stopReason);',
  '\t\t}',
].join('\n');
const ACP_STATE_ERROR_TARGET = [
  '\t\tif (state === "error") {',
  '\t\t\tawait this.rejectPendingPromptWithFailure(pending, payload, "ACP prompt failed");',
  '\t\t}',
].join('\n');
const ACP_STATE_ERROR_INTERMEDIATE = [
  '\t\tif (state === "error") {',
  '\t\t\tthis.rejectPendingPrompt(pending, buildAcpPromptError(payload, "ACP prompt failed"));',
  '\t\t}',
].join('\n');

const ACP_RECONCILE_ERROR_SOURCE = [
  '\t\tif (result?.status === "error") {',
  '\t\t\tthis.finishPrompt(sessionId, currentPending, "end_turn");',
  '\t\t\treturn false;',
  '\t\t}',
].join('\n');
const ACP_RECONCILE_ERROR_TARGET = [
  '\t\tif (result?.status === "error") {',
  '\t\t\tawait this.rejectPendingPromptWithFailure(currentPending, result, "ACP prompt failed after reconnect");',
  '\t\t\treturn false;',
  '\t\t}',
].join('\n');
const ACP_RECONCILE_ERROR_INTERMEDIATE = [
  '\t\tif (result?.status === "error") {',
  '\t\t\tthis.rejectPendingPrompt(currentPending, buildAcpPromptError(result, "ACP prompt failed after reconnect"));',
  '\t\t\treturn false;',
  '\t\t}',
].join('\n');

const ACP_PENDING_MESSAGE_SOURCE = [
  '\t\t\t\tidempotencyKey: runId,',
  '\t\t\t\tdisconnectContext: this.activeDisconnectContext ?? void 0,',
].join('\n');
const ACP_PENDING_MESSAGE_TARGET = [
  '\t\t\t\tidempotencyKey: runId,',
  '\t\t\t\tuserMessageId: typeof params.messageId === "string" && params.messageId.trim() || runId,',
  '\t\t\t\tdisconnectContext: this.activeDisconnectContext ?? void 0,',
].join('\n');

const ACP_REJECT_METHOD_SOURCE = '\trejectPendingPrompt(pending, error) {';
const ACP_REJECT_METHOD_LEGACY_TARGET = [
  '\tasync rejectPendingPromptWithFailure(pending, value, fallback) {',
  '\t\tconst error = buildAcpPromptError(value, fallback);',
  '\t\ttry {',
  '\t\t\tawait this.sessionUpdates.emit({',
  '\t\t\t\tsessionId: pending.sessionId,',
  '\t\t\t\tsessionKey: pending.sessionKey,',
  '\t\t\t\t...pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {},',
  '\t\t\t\trunId: pending.idempotencyKey,',
  '\t\t\t\trecord: true,',
  '\t\t\t\tupdate: {',
  '\t\t\t\t\tsessionUpdate: "uclaw_turn_failure",',
  '\t\t\t\t\tuserMessageId: pending.userMessageId,',
  '\t\t\t\t\terrorMessage: error.message',
  '\t\t\t\t}',
  '\t\t\t});',
  '\t\t} catch (recordError) {',
  '\t\t\tthis.log(`terminal prompt failure record failed for ${pending.sessionId}: ${String(recordError)}`);',
  '\t\t}',
  '\t\tthis.rejectPendingPrompt(pending, error);',
  '\t}',
  ACP_REJECT_METHOD_SOURCE,
].join('\n');
const ACP_REJECT_METHOD_TARGET = [
  '\tasync rejectPendingPromptWithFailure(pending, value, fallback) {',
  '\t\tlet error = buildAcpPromptError(value, fallback);',
  '\t\tlet transcriptFailure;',
  '\t\ttry {',
  '\t\t\ttranscriptFailure = findUclawLatestTurnTranscriptError(await this.getSessionTranscript(pending.sessionKey));',
  '\t\t\tif (transcriptFailure) error = new Error(transcriptFailure.errorMessage, { cause: value });',
  '\t\t} catch {',
  '\t\t\tthis.log(`terminal prompt transcript recovery failed for ${pending.sessionId}`);',
  '\t\t}',
  '\t\ttry {',
  '\t\t\tawait this.sessionUpdates.emit({',
  '\t\t\t\tsessionId: pending.sessionId,',
  '\t\t\t\tsessionKey: pending.sessionKey,',
  '\t\t\t\t...pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {},',
  '\t\t\t\trunId: pending.idempotencyKey,',
  '\t\t\t\trecord: true,',
  '\t\t\t\tupdate: {',
  '\t\t\t\t\tsessionUpdate: "uclaw_turn_failure",',
  '\t\t\t\t\tuserMessageId: pending.userMessageId,',
  '\t\t\t\t\terrorMessage: error.message,',
  '\t\t\t\t\t...transcriptFailure?.errorCode ? { errorCode: transcriptFailure.errorCode } : {}',
  '\t\t\t\t}',
  '\t\t\t});',
  '\t\t} catch (recordError) {',
  '\t\t\tthis.log(`terminal prompt failure record failed for ${pending.sessionId}: ${String(recordError)}`);',
  '\t\t}',
  '\t\tthis.rejectPendingPrompt(pending, error);',
  '\t}',
  ACP_REJECT_METHOD_SOURCE,
].join('\n');

const ACP_REPLAY_TRANSCRIPT_SOURCE = [
  '\tasync replaySessionTranscript(sessionId, transcript) {',
  '\t\tfor (const message of transcript) {',
  '\t\t\tconst replayChunks = extractReplayChunks(message);',
  '\t\t\tfor (const chunk of replayChunks) await this.sessionUpdates.emit({',
  '\t\t\t\tsessionId,',
  '\t\t\t\tupdate: {',
  '\t\t\t\t\tsessionUpdate: chunk.sessionUpdate,',
  '\t\t\t\t\tcontent: {',
  '\t\t\t\t\t\ttype: "text",',
  '\t\t\t\t\t\ttext: chunk.text',
  '\t\t\t\t\t}',
  '\t\t\t\t}',
  '\t\t\t});',
  '\t\t}',
  '\t}',
].join('\n');
const ACP_REPLAY_TRANSCRIPT_TARGET = [
  '\tasync replaySessionTranscript(sessionId, transcript) {',
  '\t\tlet latestUserMessageId;',
  '\t\tfor (const [messageIndex, message] of transcript.entries()) {',
  '\t\t\tconst transcriptMessage = getUclawTranscriptMessage(message);',
  '\t\t\tif (transcriptMessage?.role === "user") latestUserMessageId = getUclawTranscriptUserMessageId(transcriptMessage, messageIndex);',
  '\t\t\tconst replayChunks = extractReplayChunks(message);',
  '\t\t\tfor (const chunk of replayChunks) await this.sessionUpdates.emit({',
  '\t\t\t\tsessionId,',
  '\t\t\t\tupdate: {',
  '\t\t\t\t\tsessionUpdate: chunk.sessionUpdate,',
  '\t\t\t\t\t...chunk.sessionUpdate === "user_message_chunk" && latestUserMessageId ? { messageId: latestUserMessageId } : {},',
  '\t\t\t\t\tcontent: {',
  '\t\t\t\t\t\ttype: "text",',
  '\t\t\t\t\t\ttext: chunk.text',
  '\t\t\t\t\t}',
  '\t\t\t\t}',
  '\t\t\t});',
  '\t\t\tconst transcriptFailure = getUclawTranscriptError(transcriptMessage);',
  '\t\t\tif (!transcriptFailure) continue;',
  '\t\t\tawait this.sessionUpdates.emit({',
  '\t\t\t\tsessionId,',
  '\t\t\t\tupdate: {',
  '\t\t\t\t\tsessionUpdate: "uclaw_turn_failure",',
  '\t\t\t\t\tuserMessageId: latestUserMessageId,',
  '\t\t\t\t\terrorMessage: transcriptFailure.errorMessage,',
  '\t\t\t\t\t...transcriptFailure.errorCode ? { errorCode: transcriptFailure.errorCode } : {}',
  '\t\t\t\t}',
  '\t\t\t});',
  '\t\t}',
  '\t}',
].join('\n');

const USER_QUOTA_HELPER_SOURCE = 'function isRateLimitAssistantError(msg) {';
const USER_QUOTA_HELPER_TARGET = [
  'function isUclawManagedUserQuotaError(raw) {',
  '\tif (!raw) return false;',
  '\treturn /insufficient[_ -]?user[_ -]?quota|用户额度不足|预扣费额度失败|订阅额度不足或未配置订阅/i.test(raw);',
  '}',
  'function isRateLimitAssistantError(msg) {',
].join('\n');

const RATE_LIMIT_ASSISTANT_SOURCE = [
  'function isRateLimitAssistantError(msg) {',
  '\tif (!msg || msg.stopReason !== "error") return false;',
  '\treturn isRateLimitErrorMessage(msg.errorMessage ?? "");',
  '}',
].join('\n');
const RATE_LIMIT_ASSISTANT_TARGET = [
  'function isRateLimitAssistantError(msg) {',
  '\tif (!msg || msg.stopReason !== "error" || isUclawManagedUserQuotaError(msg.errorMessage)) return false;',
  '\treturn isRateLimitErrorMessage(msg.errorMessage ?? "");',
  '}',
].join('\n');

const BILLING_ASSISTANT_SOURCE = [
  'function isBillingAssistantError(msg) {',
  '\tif (!msg || msg.stopReason !== "error") return false;',
  '\treturn isBillingErrorMessage(msg.errorMessage ?? "");',
  '}',
].join('\n');
const BILLING_ASSISTANT_TARGET = [
  'function isBillingAssistantError(msg) {',
  '\tif (!msg || msg.stopReason !== "error" || isUclawManagedUserQuotaError(msg.errorMessage)) return false;',
  '\treturn isBillingErrorMessage(msg.errorMessage ?? "");',
  '}',
].join('\n');

const AUTH_ASSISTANT_SOURCE = [
  'function isAuthAssistantError(msg) {',
  '\tif (!msg || msg.stopReason !== "error") return false;',
  '\treturn isAuthErrorMessage(msg.errorMessage ?? "");',
  '}',
].join('\n');
const AUTH_ASSISTANT_TARGET = [
  'function isAuthAssistantError(msg) {',
  '\tif (!msg || msg.stopReason !== "error" || isUclawManagedUserQuotaError(msg.errorMessage)) return false;',
  '\treturn isAuthErrorMessage(msg.errorMessage ?? "");',
  '}',
].join('\n');

const CLASSIFY_MESSAGE_SOURCE = [
  'function classifyFailoverClassificationFromMessage(raw, provider, opts) {',
  '\tif (isImageDimensionErrorMessage(raw)) return null;',
].join('\n');
const CLASSIFY_MESSAGE_TARGET = [
  'function classifyFailoverClassificationFromMessage(raw, provider, opts) {',
  '\tif (isUclawManagedUserQuotaError(raw)) return toReasonClassification("format");',
  '\tif (isImageDimensionErrorMessage(raw)) return null;',
].join('\n');

function applyRewrite(content, source, target) {
  if (content.includes(target)) return { content, changed: false, supported: true };
  const sources = Array.isArray(source) ? source : [source];
  const matched = sources.find((candidate) => content.includes(candidate));
  if (!matched) return { content, changed: false, supported: false };
  return { content: content.replace(matched, target), changed: true, supported: true };
}

export function rewriteAcpTerminalErrors(content) {
  let rewritten = content;
  let replacements = 0;
  for (const [source, target] of [
    [[ACP_ERROR_HELPER_LEGACY_TARGET, ACP_ERROR_HELPER_SOURCE], ACP_ERROR_HELPER_TARGET],
    [ACP_PENDING_MESSAGE_SOURCE, ACP_PENDING_MESSAGE_TARGET],
    [[ACP_REJECT_METHOD_LEGACY_TARGET, ACP_REJECT_METHOD_SOURCE], ACP_REJECT_METHOD_TARGET],
    [[ACP_STATE_ERROR_SOURCE, ACP_STATE_ERROR_INTERMEDIATE], ACP_STATE_ERROR_TARGET],
    [[ACP_RECONCILE_ERROR_SOURCE, ACP_RECONCILE_ERROR_INTERMEDIATE], ACP_RECONCILE_ERROR_TARGET],
    [ACP_REPLAY_TRANSCRIPT_SOURCE, ACP_REPLAY_TRANSCRIPT_TARGET],
  ]) {
    const result = applyRewrite(rewritten, source, target);
    if (!result.supported) return { content: rewritten, replacements, supported: false };
    rewritten = result.content;
    if (result.changed) replacements += 1;
  }
  return { content: rewritten, replacements, supported: true };
}

export function rewriteManagedUserQuotaHandling(content) {
  let rewritten = content;
  let replacements = 0;
  for (const [source, target] of [
    [USER_QUOTA_HELPER_SOURCE, USER_QUOTA_HELPER_TARGET],
    [RATE_LIMIT_ASSISTANT_SOURCE, RATE_LIMIT_ASSISTANT_TARGET],
    [BILLING_ASSISTANT_SOURCE, BILLING_ASSISTANT_TARGET],
    [AUTH_ASSISTANT_SOURCE, AUTH_ASSISTANT_TARGET],
    [CLASSIFY_MESSAGE_SOURCE, CLASSIFY_MESSAGE_TARGET],
  ]) {
    const result = applyRewrite(rewritten, source, target);
    if (!result.supported) return { content: rewritten, replacements, supported: false };
    rewritten = result.content;
    if (result.changed) replacements += 1;
  }
  return { content: rewritten, replacements, supported: true };
}

async function patchExactlyOne(distDir, pattern, rewrite, label) {
  const entries = await readdir(distDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && pattern.test(entry.name));
  let supportedFiles = 0;
  let filesPatched = 0;

  for (const entry of files) {
    const filePath = join(distDir, entry.name);
    const content = await readFile(filePath, 'utf8');
    const result = rewrite(content);
    if (!result.supported) continue;
    supportedFiles += 1;
    if (result.replacements === 0) continue;
    await writeFile(filePath, result.content, 'utf8');
    filesPatched += 1;
  }

  if (supportedFiles !== 1) {
    throw new Error(`Expected exactly one supported OpenClaw ${label} runtime, found ${supportedFiles}.`);
  }
  return { filesPatched, filesScanned: files.length };
}

/**
 * Preserve terminal provider failures through ACP and keep UClaw end-user quota
 * errors out of OpenClaw's provider-profile failover and cooldown machinery.
 */
export async function patchOpenClawAcpTerminalErrorRuntime(openclawDir) {
  const packageJson = JSON.parse(await readFile(join(openclawDir, 'package.json'), 'utf8'));
  if (packageJson.version !== SUPPORTED_OPENCLAW_VERSION) {
    throw new Error(`Expected OpenClaw ${SUPPORTED_OPENCLAW_VERSION}, found ${String(packageJson.version)}.`);
  }

  const distDir = join(openclawDir, 'dist');
  const acp = await patchExactlyOne(distDir, /^acp-cli-.*\.js$/u, rewriteAcpTerminalErrors, 'ACP CLI');
  const errors = await patchExactlyOne(
    distDir,
    /^errors-.*\.js$/u,
    rewriteManagedUserQuotaHandling,
    'error classifier',
  );
  return {
    filesPatched: acp.filesPatched + errors.filesPatched,
    filesScanned: acp.filesScanned + errors.filesScanned,
  };
}

async function main() {
  const openclawDir = join(process.cwd(), 'node_modules', 'openclaw');
  const result = await patchOpenClawAcpTerminalErrorRuntime(openclawDir);
  console.log(
    `[patch-openclaw-acp-terminal-error] verified ${result.filesScanned} runtime file(s), patched ${result.filesPatched}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
