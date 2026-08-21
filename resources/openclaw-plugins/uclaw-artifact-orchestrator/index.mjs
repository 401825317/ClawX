import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { definePluginEntry } from 'openclaw/plugin-sdk/core';

const PLUGIN_ID = 'uclaw-artifact-orchestrator';
const POLICY_SCHEMA_VERSION = 1;
const CONTRACTS = new Set([
  'presentation-maker:v1',
  'document-maker:v1',
  'spreadsheet-maker:v1',
  'uclaw-local-artifacts:v1',
  'cad-editor:v1',
  'ecommerce-main-image:v1',
]);
const KINDS = new Set([
  'presentation',
  'document',
  'spreadsheet',
  'webpage',
  'cad',
  'ecommerce-main-image',
]);
const SKILL_BY_KIND = new Map([
  ['presentation', 'presentation-maker'],
  ['document', 'document-maker'],
  ['spreadsheet', 'spreadsheet-maker'],
  ['webpage', 'uclaw-local-artifacts'],
  ['cad', 'cad-editor'],
  ['ecommerce-main-image', 'ecommerce-main-image'],
]);
const LOCAL_TOOLS_BY_KIND = new Map([
  ['presentation', new Set(['create_designed_pptx_file', 'create_pptx_file', 'repair_designed_pptx_file'])],
  ['document', new Set(['create_docx_file'])],
  ['spreadsheet', new Set(['create_xlsx_file'])],
  ['webpage', new Set(['create_html_app_file', 'prepare_workspace_html_preview'])],
  ['cad', new Set(['create_dxf_file'])],
  ['ecommerce-main-image', new Set(['image_generate'])],
]);
const PRIMARY_RENDER_TOOLS_BY_KIND = new Map([
  ['presentation', new Set(['create_designed_pptx_file', 'create_pptx_file'])],
  ['document', new Set(['create_docx_file'])],
  ['spreadsheet', new Set(['create_xlsx_file'])],
  ['webpage', new Set(['create_html_app_file'])],
  ['cad', new Set(['create_dxf_file'])],
  ['ecommerce-main-image', new Set(['image_generate'])],
]);
const REPAIR_TOOLS_BY_KIND = new Map([
  ['presentation', new Set(['repair_designed_pptx_file'])],
]);
const REFINED_NETWORK_TOOLS = new Set(['web_search', 'web_fetch']);
const IMAGE_GENERATION_TOOLS = new Set(['image_generate']);
const runAttempts = new Map();

function registerHook(api, name, handler, options) {
  if (typeof api.on === 'function') {
    api.on(name, handler, options);
    return;
  }
  if (typeof api.registerHook === 'function') api.registerHook(name, handler, options);
}

function policyPath(sessionKey) {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (!stateDir) return null;
  const digest = createHash('sha256').update(sessionKey).digest('hex');
  return path.join(stateDir, 'uclaw', 'artifact-policies', `${digest}.json`);
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readPolicy(ctx) {
  const sessionKey = typeof ctx?.sessionKey === 'string' ? ctx.sessionKey : '';
  if (!sessionKey) return null;
  const filePath = policyPath(sessionKey);
  if (!filePath) return null;
  try {
    const policy = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!policy || policy.schemaVersion !== POLICY_SCHEMA_VERSION || policy.sessionKey !== sessionKey) return null;
    if (!KINDS.has(policy.kind) || !CONTRACTS.has(policy.promptContract)) return null;
    if (policy.skillId !== SKILL_BY_KIND.get(policy.kind) || !policy.promptContract.startsWith(`${policy.skillId}:`)) return null;
    if (typeof policy.workspaceRoot !== 'string' || !path.isAbsolute(policy.workspaceRoot)) return null;
    if (ctx.workspaceDir && !isInside(policy.workspaceRoot, ctx.workspaceDir)) return null;
    if (policy.targetFile && (typeof policy.targetFile !== 'string' || !path.isAbsolute(policy.targetFile) || !isInside(policy.workspaceRoot, policy.targetFile))) return null;
    if (typeof policy.expiresAt !== 'string' || Date.parse(policy.expiresAt) <= Date.now()) return null;
    if (typeof policy.modelAlias !== 'string' || !policy.modelAlias.trim()) return null;
    if (!['create', 'modify'].includes(policy.intent) || !['fast', 'refined'].includes(policy.mode)) return null;
    const fastMode = policy.mode === 'fast';
    if (policy.fastMode !== fastMode || policy.thinkingLevel !== (fastMode ? 'minimal' : 'high')) return null;
    if (policy.maxRepairs !== (fastMode ? 1 : 2)) return null;
    if (policy.allowNetwork !== (!fastMode && policy.kind !== 'cad')) return null;
    if (typeof policy.allowImageGeneration !== 'boolean') return null;
    if (fastMode && policy.kind !== 'ecommerce-main-image' && policy.allowImageGeneration) return null;
    if (policy.kind === 'cad' && policy.allowImageGeneration) return null;
    return policy;
  } catch {
    return null;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The Main process projects the managed client config into this plugin config.
 * Keep the flat form for early builds and accept the shared runtime-config shape
 * so an emergency remote disable invalidates already persisted task policies.
 */
function artifactsFeatureEnabled(pluginConfig) {
  if (!isRecord(pluginConfig)) return true;
  if (pluginConfig.artifactsEnabled === false) return false;
  const features = isRecord(pluginConfig.features) ? pluginConfig.features : null;
  const artifacts = features && isRecord(features.artifacts) ? features.artifacts : null;
  return artifacts?.enabled !== false;
}

function normalizeToolName(event, ctx) {
  const raw = String(event?.toolName || ctx?.toolName || '').trim();
  return raw.toLowerCase();
}

function allowedToolsFor(policy) {
  const allowed = new Set(LOCAL_TOOLS_BY_KIND.get(policy.kind) || []);
  if (policy.mode === 'refined' && policy.allowNetwork) {
    for (const toolName of REFINED_NETWORK_TOOLS) allowed.add(toolName);
  }
  if (policy.allowImageGeneration) {
    for (const toolName of IMAGE_GENERATION_TOOLS) allowed.add(toolName);
  }
  return allowed;
}

function contractText(policy) {
  const common = [
    `UClaw artifact contract ${policy.promptContract} is active for this turn.`,
    `Use the ${policy.skillId} skill and finish the requested artifact in this turn.`,
    'Return the generated absolute file path. Do not stop after a plan or progress message.',
    `Render once, then perform at most ${policy.maxRepairs} targeted repair(s).`,
  ];
  if (policy.mode === 'fast') {
    common.push('Fast mode: use explicit attachments and local artifact tools only; do not browse, search, download, or generate decorative assets.');
  } else {
    common.push('Refined mode: only use network or generated assets when they materially improve the requested result.');
  }
  if (policy.intent === 'modify' && policy.targetFile) {
    common.push(`Modify the existing artifact at ${policy.targetFile}; preserve unrelated content and write the result inside the workspace.`);
  }
  if (policy.kind === 'ecommerce-main-image') {
    common.push('Choose white-background, scene, or selling-point composition from the request. With references, preserve product structure, packaging, logo, and readable product text exactly; never invent product facts.');
  }
  if (policy.kind === 'cad') {
    common.push('You must call create_dxf_file and deliver its verified editable DXF output. image_generate and raster images must never replace the DXF artifact.');
  }
  return common.join('\n');
}

function runKey(event, ctx) {
  return event?.runId || ctx?.runId || ctx?.sessionKey || '';
}

function blockReason(category) {
  return `UClaw artifact ${category} is disabled by the active deterministic task policy.`;
}

export const pluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: 'UClaw Artifact Orchestrator',
  description: 'Enforces deterministic, versioned artifact task policies.',
  register(api) {
    const runtimeArtifactsEnabled = artifactsFeatureEnabled(api?.pluginConfig);
    const activePolicy = (ctx) => (runtimeArtifactsEnabled ? readPolicy(ctx) : null);

    registerHook(api, 'before_model_resolve', (_event, ctx) => {
      const policy = activePolicy(ctx);
      if (!policy) return undefined;
      const separator = policy.modelAlias.indexOf('/');
      if (separator > 0) {
        return {
          providerOverride: policy.modelAlias.slice(0, separator),
          modelOverride: policy.modelAlias.slice(separator + 1),
        };
      }
      return {
        ...(ctx.modelProviderId ? { providerOverride: ctx.modelProviderId } : {}),
        modelOverride: policy.modelAlias,
      };
    }, { name: `${PLUGIN_ID}:model`, priority: 200 });

    registerHook(api, 'before_prompt_build', (_event, ctx) => {
      const policy = activePolicy(ctx);
      return policy ? { appendSystemContext: contractText(policy) } : undefined;
    }, { name: `${PLUGIN_ID}:contract`, priority: 200 });

    registerHook(api, 'before_tool_call', (event, ctx) => {
      const policy = activePolicy(ctx);
      if (!policy) return undefined;
      const toolName = normalizeToolName(event, ctx);
      if (!allowedToolsFor(policy).has(toolName)) {
        return { block: true, blockReason: blockReason(`tool "${toolName || 'unknown'}"`) };
      }

      const key = runKey(event, ctx);
      const attempts = runAttempts.get(key) || { renders: 0, repairs: 0 };
      const primaryRenderTools = PRIMARY_RENDER_TOOLS_BY_KIND.get(policy.kind) || new Set();
      const repairTools = REPAIR_TOOLS_BY_KIND.get(policy.kind) || new Set();
      if (repairTools.has(toolName) && attempts.renders === 0) {
        return { block: true, blockReason: 'Render the initial artifact before requesting a repair.' };
      }
      if (primaryRenderTools.has(toolName) && attempts.renders >= 1) {
        return { block: true, blockReason: 'The initial artifact render budget for this turn has been exhausted.' };
      }
      if (repairTools.has(toolName) && attempts.repairs >= policy.maxRepairs) {
        return { block: true, blockReason: 'The artifact repair budget for this turn has been exhausted.' };
      }
      if (primaryRenderTools.has(toolName)) attempts.renders += 1;
      if (repairTools.has(toolName)) attempts.repairs += 1;
      if (primaryRenderTools.has(toolName) || repairTools.has(toolName)) runAttempts.set(key, attempts);
      return undefined;
    }, { name: `${PLUGIN_ID}:tools`, priority: 200 });

    registerHook(api, 'agent_end', (event, ctx) => {
      const key = runKey(event, ctx);
      if (key) runAttempts.delete(key);
    }, { name: `${PLUGIN_ID}:cleanup` });
  },
});

export default pluginEntry;

export const __test = { artifactsFeatureEnabled, contractText, isInside, readPolicy };
