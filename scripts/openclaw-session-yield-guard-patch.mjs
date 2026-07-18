import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_NAME = 'openclaw-session-yield-guard-patch';
const PATCH_MARKER = 'UCLAW_SESSION_YIELD_GUARD_V1';

const YIELD_TOOL_DESCRIPTION_ANCHOR = `\t\tdescription: "End current turn. Use after spawning subagents; results arrive as next message.",`;
const YIELD_TOOL_DESCRIPTION_PATCH = `\t\tdescription: "End current turn only when this session has active spawned child work. If no spawned child work is active, return an error instead of yielding.",`;

const YIELD_TOOL_EXECUTE_ANCHOR = `\t\texecute: async (_toolCallId, args) => {\n\t\t\tconst message = readStringParam(args, "message") || "Turn yielded.";\n\t\t\tif (!opts?.sessionId) return jsonResult({\n\t\t\t\tstatus: "error",\n\t\t\t\terror: "No session context"\n\t\t\t});\n\t\t\tif (!opts?.onYield) return jsonResult({\n\t\t\t\tstatus: "error",\n\t\t\t\terror: "Yield not supported in this context"\n\t\t\t});\n\t\t\tawait opts.onYield(message);\n\t\t\treturn jsonResult({\n\t\t\t\tstatus: "yielded",\n\t\t\t\tmessage\n\t\t\t});\n\t\t}`;
const YIELD_TOOL_EXECUTE_PATCH = `\t\texecute: async (_toolCallId, args) => {\n\t\t\tconst message = readStringParam(args, "message") || "Turn yielded.";\n\t\t\tif (!opts?.sessionId) return jsonResult({\n\t\t\t\tstatus: "error",\n\t\t\t\terror: "No session context"\n\t\t\t});\n\t\t\tif (!opts?.onYield) return jsonResult({\n\t\t\t\tstatus: "error",\n\t\t\t\terror: "Yield not supported in this context"\n\t\t\t});\n\t\t\tconst activeChildren = opts?.sessionKey ? countActiveRunsForSession(opts.sessionKey) : 0;\n\t\t\tif (activeChildren <= 0) return jsonResult({\n\t\t\t\tstatus: "error",\n\t\t\t\terror: "No active spawned child work is registered for this session; do not call sessions_yield."\n\t\t\t});\n\t\t\tawait opts.onYield(message);\n\t\t\treturn jsonResult({\n\t\t\t\tstatus: "yielded",\n\t\t\t\tmessage\n\t\t\t});\n\t\t}`;

const YIELD_TOOL_CALLSITE_ANCHOR = `\t\tcreateSessionsYieldTool({\n\t\t\tsessionId: options?.sessionId,\n\t\t\tonYield: options?.onYield\n\t\t}),`;
const YIELD_TOOL_CALLSITE_PATCH = `\t\tcreateSessionsYieldTool({\n\t\t\tsessionId: options?.sessionId,\n\t\t\tsessionKey: options?.sessionKey,\n\t\t\tonYield: options?.onYield\n\t\t}),`;

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function replaceUnique(content, search, replacement, label, filePath) {
  const count = countOccurrences(content, search);
  if (count !== 1) {
    throw new Error(`[${PATCH_NAME}] Expected exactly one ${label} anchor in ${filePath}; found ${count}.`);
  }
  return content.replace(search, replacement);
}

export function patchOpenClawSessionYieldGuardContent(content, filePath = '<fixture>') {
  if (!content.includes('function createSessionsYieldTool(opts) {')) {
    return { content, changed: false, matched: false };
  }
  if (content.includes(PATCH_MARKER)) {
    return { content, changed: false, matched: true };
  }

  let patched = content;
  patched = replaceUnique(patched, YIELD_TOOL_DESCRIPTION_ANCHOR, YIELD_TOOL_DESCRIPTION_PATCH, 'sessions_yield description', filePath);
  patched = replaceUnique(patched, YIELD_TOOL_EXECUTE_ANCHOR, YIELD_TOOL_EXECUTE_PATCH, 'sessions_yield execute', filePath);
  patched = replaceUnique(patched, YIELD_TOOL_CALLSITE_ANCHOR, YIELD_TOOL_CALLSITE_PATCH, 'sessions_yield callsite', filePath);
  return { content: `${patched}\n/* ${PATCH_MARKER} */`, changed: true, matched: true };
}

export function patchOpenClawSessionYieldGuardRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[${PATCH_NAME}] OpenClaw dist directory not found: ${distDir}`);
  }

  let matchedFiles = 0;
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('openclaw-tools-') || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawSessionYieldGuardContent(content, filePath);
    if (!result.matched) continue;
    matchedFiles += 1;
    if (result.changed) {
      patchedFiles += 1;
      if (!dryRun) writeFileSync(filePath, result.content, 'utf8');
    } else {
      alreadyPatchedFiles += 1;
    }
  }

  if (matchedFiles !== 1) {
    throw new Error(`[${PATCH_NAME}] Expected one OpenClaw tool runtime file; found ${matchedFiles}.`);
  }
  logger.log?.(
    `[${PATCH_NAME}] ${dryRun ? 'Dry-run matched' : 'Patched'} ${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`,
  );
  return { matchedFiles, patchedFiles, alreadyPatchedFiles };
}

export function patchInstalledOpenClawSessionYieldGuardRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawSessionYieldGuardRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
