#!/usr/bin/env node

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_VERSION = '2026.6.10';
export const ACP_BINDING_RUNTIME_FILE = 'acp-cli-CDV6Zyhn.js';

const CONSTRUCTOR_SOURCE = '\t\tthis.approvalRelays = /* @__PURE__ */ new Map();';
const CONSTRUCTOR_TARGET = `${CONSTRUCTOR_SOURCE}\n\t\tthis.uclawApprovalBindings = /* @__PURE__ */ new Map();\n\t\tthis.uclawApprovalBindingsOverflow = false;`;
const CREATE_SOURCE = '\t\tconst session = this.sessionStore.createSession({';
const CREATE_TARGET = '\t\tconst session = this.createUclawBoundSession({';
const NATIVE_SOURCE = [
  '\thandleExecApprovalRequestEvent(evt) {',
  '\t\tconst payload = evt.payload;',
  '\t\tif (!payload) return;',
  '\t\tconst approvalEvent = parseGatewayExecApprovalRequestEventPayload(payload);',
  '\t\tif (!approvalEvent) return;',
  '\t\tconst request = payload.request;',
  '\t\tconst sessionKey = normalizeOptionalString(request?.sessionKey);',
  '\t\tif (!sessionKey) return;',
  '\t\tthis.startApprovalRelay({',
  '\t\t\tsessionKey,',
  '\t\t\tapprovalEvent',
  '\t\t});',
  '\t}',
].join('\n');
const NATIVE_TARGET = NATIVE_SOURCE.replace(
  '\t\tthis.startApprovalRelay({',
  [
    '\t\t// Optional run IDs are accepted only from the trusted Gateway envelope.',
    '\t\t// Stock 2026.6.10 omits them; timestamps and approval IDs are not run proof.',
    '\t\tconst payloadRunId = normalizeOptionalString(payload.runId);',
    '\t\tconst requestRunId = normalizeOptionalString(request?.runId);',
    '\t\tconst runId = payloadRunId ?? requestRunId;',
    '\t\tif (payloadRunId && requestRunId && payloadRunId !== requestRunId || runId && ![...this.pendingPrompts.values()].some((pending) => pending.sessionKey === sessionKey && pending.idempotencyKey === runId)) {',
    '\t\t\tvoid this.resolveGatewayApproval(approvalEvent.approvalId, "deny");',
    '\t\t\treturn;',
    '\t\t}',
    '\t\tthis.startApprovalRelay({',
    '\t\t\trunId,',
  ].join('\n'),
);
const RELAY_SOURCE = [
  '\tstartApprovalRelay(params) {',
  '\t\tconst approvalEvent = params.approvalEvent;',
  '\t\tif (this.approvalRelays.has(approvalEvent.approvalId)) return;',
  '\t\tconst pending = params.runId ? this.findPendingBySessionKey(params.sessionKey, params.runId) : this.findUniquePendingBySessionKey(params.sessionKey);',
  '\t\tif (!pending) return;',
  '\t\tconst relay = {',
  '\t\t\tapprovalId: approvalEvent.approvalId,',
  '\t\t\trunId: pending.idempotencyKey,',
  '\t\t\tsessionId: pending.sessionId,',
  '\t\t\tsessionKey: pending.sessionKey,',
  '\t\t\tstate: "active"',
  '\t\t};',
  '\t\tthis.approvalRelays.set(relay.approvalId, relay);',
  '\t\tthis.runApprovalRelay(relay, approvalEvent);',
  '\t}',
].join('\n');
const BINDING_HELPERS = [
  '\t/** Tracks protocol ownership without touching Gateway history or resetting sessions. */',
  '\tcreateUclawBoundSession(params) {',
  '\t\tconst session = this.sessionStore.createSession(params);',
  '\t\tconst previous = this.uclawApprovalBindings.get(session.sessionKey);',
  '\t\t// The explicit uclaw-binding protocol ID also carries rotation intent across ACP process replacement.',
  '\t\tconst requiresRunId = previous?.requiresRunId === true || session.sessionId.startsWith("uclaw-binding:") || previous !== void 0 && previous.sessionId !== session.sessionId;',
  '\t\tif (previous !== void 0 || this.uclawApprovalBindings.size < 5e3) this.uclawApprovalBindings.set(session.sessionKey, { sessionId: session.sessionId, requiresRunId });',
  '\t\t// Never evict a rotation tombstone: forgetting it would re-enable stale approvals.',
  '\t\telse this.uclawApprovalBindingsOverflow = true;',
  '\t\treturn session;',
  '\t}',
  '\t/** Runless approvals cannot prove ownership after rotation; unknown overflow keys fail closed. */',
  '\tuclawApprovalRequiresRunId(sessionKey) {',
  '\t\tconst binding = this.uclawApprovalBindings.get(sessionKey);',
  '\t\treturn binding ? binding.requiresRunId : this.uclawApprovalBindingsOverflow;',
  '\t}',
].join('\n');
const RELAY_TARGET = `${BINDING_HELPERS}\n${RELAY_SOURCE.replace(
  '\t\tconst pending = params.runId ?',
  [
    '\t\t// Gateway 2026.6.10 native approval/get has no trustworthy run identity.',
    '\t\t// Do not hydrate or send an ambiguous request to the replacement ACP client.',
    '\t\tif (!params.runId && this.uclawApprovalRequiresRunId(params.sessionKey)) {',
    '\t\t\tthis.log("denied unscoped approval after ACP binding rotation");',
    '\t\t\tvoid this.resolveGatewayApproval(approvalEvent.approvalId, "deny");',
    '\t\t\treturn;',
    '\t\t}',
    '\t\tconst pending = params.runId ?',
  ].join('\n'),
)}`;

const REWRITES = [
  { label: 'constructor', source: CONSTRUCTOR_SOURCE, target: CONSTRUCTOR_TARGET, expected: 1 },
  { label: 'new/load/resume session creation', source: CREATE_SOURCE, target: CREATE_TARGET, expected: 3 },
  { label: 'native approval correlation', source: NATIVE_SOURCE, target: NATIVE_TARGET, expected: 1 },
  { label: 'approval relay', source: RELAY_SOURCE, target: RELAY_TARGET, expected: 1 },
];

function occurrences(content, snippet) {
  return content.split(snippet).length - 1;
}

/**
 * Only the pinned generated ACP layout is supported. All edits must be absent
 * or present together; partial patches and layout drift are rejected before IO.
 * State is in-memory only, with a bounded, sticky logical-session quarantine.
 * Existing nonrotated approvals and run-correlated approvals keep their relay.
 * Cost: even genuine new runless approvals are denied on a rotated logical chat.
 */
export function rewriteAcpBindingIsolation(content) {
  const states = REWRITES.map(({ label, source, target, expected }) => {
    const targets = occurrences(content, target);
    const sources = occurrences(content.split(target).join(''), source);
    if (targets === 0 && sources === expected) return 'original';
    if (targets === expected && sources === 0) return 'patched';
    throw new Error(`Unsupported OpenClaw ACP binding isolation layout: ${label}`);
  });
  if (!states.every((state) => state === states[0])) {
    throw new Error('Unsupported OpenClaw ACP binding isolation layout: partial patch');
  }
  if (states[0] === 'patched') return { content, replacements: 0 };
  let rewritten = content;
  for (const { source, target } of REWRITES) rewritten = rewritten.split(source).join(target);
  return { content: rewritten, replacements: 6 };
}

/** Patch only an explicitly supplied runtime; no provider, auth, DB or installed-tree discovery. */
export async function patchOpenClawAcpBindingIsolationRuntime(openclawDir, fileOps = { writeFile }) {
  const pkg = JSON.parse(await readFile(join(openclawDir, 'package.json'), 'utf8'));
  if (pkg.version !== SUPPORTED_VERSION) {
    throw new Error(`Expected OpenClaw ${SUPPORTED_VERSION}, found ${String(pkg.version)}.`);
  }
  const dist = join(openclawDir, 'dist');
  const candidates = (await readdir(dist, { withFileTypes: true }))
    .filter((entry) => /^acp-cli-.*\.js$/u.test(entry.name));
  if (candidates.length !== 1 || candidates[0].name !== ACP_BINDING_RUNTIME_FILE || !candidates[0].isFile()) {
    throw new Error('Expected exactly one regular pinned OpenClaw 2026.6.10 ACP CLI chunk.');
  }
  const path = join(dist, ACP_BINDING_RUNTIME_FILE);
  const original = await readFile(path, 'utf8');
  const result = rewriteAcpBindingIsolation(original);
  if (result.replacements === 0) return { filesPatched: 0, filesScanned: 1 };
  try {
    await fileOps.writeFile(path, result.content, 'utf8');
  } catch (error) {
    // A failed writer can have truncated the only target. Restore this invocation's original.
    try {
      await fileOps.writeFile(path, original, 'utf8');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'ACP binding patch and rollback failed');
    }
    throw error;
  }
  return { filesPatched: 1, filesScanned: 1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtime = process.argv[2];
  if (!runtime || process.argv.length !== 3) throw new Error('Usage: node openclaw-acp-binding-isolation-patch.mjs <runtime-directory>');
  const result = await patchOpenClawAcpBindingIsolationRuntime(resolve(runtime));
  console.log(`[patch-openclaw-acp-binding-isolation] verified ${result.filesScanned} chunk, patched ${result.filesPatched}.`);
}
