import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_MARKER = 'UCLAW_PLUGIN_TOOL_RUN_CONTEXT';
const CONTEXT_MARKER = `${PATCH_MARKER}_CONTEXT`;
const FORWARD_MARKER = `${PATCH_MARKER}_FORWARD`;
const RESULT_MIDDLEWARE_MARKER = `${PATCH_MARKER}_RESULT_MIDDLEWARE`;

const RUNTIME_ANCHOR = `\t\t\tagentId: sessionAgentId,
\t\t\tsessionKey: options?.agentSessionKey,
\t\t\tsessionId: options?.sessionId,
\t\t\tactiveModel,`;

const RUNTIME_PATCH = `\t\t\tagentId: sessionAgentId,
\t\t\tsessionKey: options?.agentSessionKey,
\t\t\trunId: options?.runId, // ${CONTEXT_MARKER}
\t\t\tsessionId: options?.sessionId,
\t\t\tactiveModel,`;

const FORWARD_ANCHOR = `\tconst pluginToolsOnly = includeOpenClawTools || !includePluginTools ? [] : resolveOpenClawPluginToolsForOptions({
\t\toptions: {
\t\t\tagentSessionKey: options?.sessionKey,
\t\t\tagentChannel: resolveGatewayMessageChannel(options?.messageProvider),`;

const FORWARD_PATCH = `\tconst pluginToolsOnly = includeOpenClawTools || !includePluginTools ? [] : resolveOpenClawPluginToolsForOptions({
\t\toptions: {
\t\t\tagentSessionKey: options?.sessionKey,
\t\t\trunId: options?.runId, // ${FORWARD_MARKER}
\t\t\tagentChannel: resolveGatewayMessageChannel(options?.messageProvider),`;

const RESULT_MIDDLEWARE_ANCHOR = `\tconst runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" });`;

const RESULT_MIDDLEWARE_PATCH = `\tconst runner = createAgentToolResultMiddlewareRunner({
\t\truntime: "openclaw",
\t\trunId // ${RESULT_MIDDLEWARE_MARKER}
\t});`;

const TYPE_ANCHOR = `  sessionKey?: string; /** Ephemeral session UUID - regenerated on /new and /reset. Use for per-conversation isolation. */
  sessionId?: string;`;

const TYPE_PATCH = `  sessionKey?: string; /** Ephemeral session UUID - regenerated on /new and /reset. Use for per-conversation isolation. */
  /** Trusted id of the active agent run. Added by the UClaw runtime bundle. */
  runId?: string; // ${CONTEXT_MARKER}
  sessionId?: string;`;

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function patchRuntimeContent(content, filePath) {
  if (!content.includes('function resolveOpenClawPluginToolInputs(params)')) return null;
  if (
    content.includes(CONTEXT_MARKER)
    || content.includes(`runId: options?.runId, // ${PATCH_MARKER}`)
  ) return { content, changed: false, category: 'runtime-context' };
  const count = countOccurrences(content, RUNTIME_ANCHOR);
  if (count !== 1) {
    throw new Error(
      `[openclaw-plugin-tool-run-context-patch] Expected one plugin context runtime anchor in ${filePath}; found ${count}.`,
    );
  }
  return {
    content: content.replace(RUNTIME_ANCHOR, RUNTIME_PATCH),
    changed: true,
    category: 'runtime-context',
  };
}

function patchForwardContent(content, filePath) {
  if (!content.includes('const pluginToolsOnly = includeOpenClawTools || !includePluginTools')) return null;
  if (content.includes(FORWARD_MARKER)) return { content, changed: false, category: 'runtime-forward' };
  const count = countOccurrences(content, FORWARD_ANCHOR);
  if (count !== 1) {
    throw new Error(
      `[openclaw-plugin-tool-run-context-patch] Expected one plugin context forward anchor in ${filePath}; found ${count}.`,
    );
  }
  return {
    content: content.replace(FORWARD_ANCHOR, FORWARD_PATCH),
    changed: true,
    category: 'runtime-forward',
  };
}

function patchResultMiddlewareContent(content, filePath) {
  if (!content.includes('function buildAgentToolResultMiddlewareFactory(sessionManager, runId)')) return null;
  if (content.includes(RESULT_MIDDLEWARE_MARKER)) {
    return { content, changed: false, category: 'result-middleware-context' };
  }
  const count = countOccurrences(content, RESULT_MIDDLEWARE_ANCHOR);
  if (count !== 1) {
    throw new Error(
      `[openclaw-plugin-tool-run-context-patch] Expected one tool result middleware context anchor in ${filePath}; found ${count}.`,
    );
  }
  return {
    content: content.replace(RESULT_MIDDLEWARE_ANCHOR, RESULT_MIDDLEWARE_PATCH),
    changed: true,
    category: 'result-middleware-context',
  };
}

function patchTypeContent(content, filePath) {
  if (!content.includes('type OpenClawPluginToolContext = {')) return null;
  if (
    content.includes(CONTEXT_MARKER)
    || content.includes(`runId?: string; // ${PATCH_MARKER}`)
  ) return { content, changed: false, category: 'type' };
  const count = countOccurrences(content, TYPE_ANCHOR);
  if (count !== 1) {
    throw new Error(
      `[openclaw-plugin-tool-run-context-patch] Expected one plugin context type anchor in ${filePath}; found ${count}.`,
    );
  }
  return {
    content: content.replace(TYPE_ANCHOR, TYPE_PATCH),
    changed: true,
    category: 'type',
  };
}

export function patchOpenClawPluginToolRunContextContent(content, filePath = '<fixture>') {
  return patchRuntimeContent(content, filePath)
    ?? patchForwardContent(content, filePath)
    ?? patchResultMiddlewareContent(content, filePath)
    ?? patchTypeContent(content, filePath)
    ?? { content, changed: false, category: null };
}

function walkFiles(rootDir) {
  const files = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const filePath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(filePath));
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts'))) {
      files.push(filePath);
    }
  }
  return files;
}

export function patchOpenClawPluginToolRunContextRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-plugin-tool-run-context-patch] OpenClaw dist directory not found: ${distDir}`);
  }

  const categoryCounts = new Map();
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  for (const filePath of walkFiles(distDir)) {
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawPluginToolRunContextContent(content, filePath);
    if (!result.category) continue;
    categoryCounts.set(result.category, (categoryCounts.get(result.category) ?? 0) + 1);
    if (result.changed) {
      patchedFiles += 1;
      if (!dryRun) writeFileSync(filePath, result.content, 'utf8');
    } else {
      alreadyPatchedFiles += 1;
    }
  }

  const runtimeContextCount = categoryCounts.get('runtime-context') ?? 0;
  const runtimeForwardCount = categoryCounts.get('runtime-forward') ?? 0;
  const resultMiddlewareContextCount = categoryCounts.get('result-middleware-context') ?? 0;
  const typeCount = categoryCounts.get('type') ?? 0;
  if (runtimeContextCount !== 1) {
    throw new Error(
      `[openclaw-plugin-tool-run-context-patch] Expected one plugin context runtime file in ${distDir}; found ${runtimeContextCount}.`,
    );
  }
  if (runtimeForwardCount !== 1) {
    throw new Error(
      `[openclaw-plugin-tool-run-context-patch] Expected one plugin context forward file in ${distDir}; found ${runtimeForwardCount}.`,
    );
  }
  if (resultMiddlewareContextCount !== 1) {
    throw new Error(
      `[openclaw-plugin-tool-run-context-patch] Expected one tool result middleware context file in ${distDir}; found ${resultMiddlewareContextCount}.`,
    );
  }
  if (typeCount < 1) {
    throw new Error(
      `[openclaw-plugin-tool-run-context-patch] Expected at least one plugin context type file in ${distDir}; found ${typeCount}.`,
    );
  }

  logger.log?.(
    `[openclaw-plugin-tool-run-context-patch] ${dryRun ? 'Dry-run matched' : 'Patched'} ${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`,
  );
  return {
    patchedFiles,
    alreadyPatchedFiles,
    categoryCounts: Object.fromEntries(categoryCounts),
  };
}

export function patchInstalledOpenClawPluginToolRunContextRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawPluginToolRunContextRuntime(
    join(cwd, 'node_modules', 'openclaw', 'dist'),
    options,
  );
}
