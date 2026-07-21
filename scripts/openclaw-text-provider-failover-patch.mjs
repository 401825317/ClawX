import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_OPENCLAW_VERSION = '2026.7.1-2';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ENDPOINTS_PATH = join(SCRIPT_DIR, '..', 'shared', 'junfeiai-endpoints.json');
const CANDIDATE_PATCH_MARKER = 'UCLAW_TEXT_PROVIDER_FAILOVER_VERSION = 2';
const SESSION_PATCH_MARKER = 'UCLAW_TEXT_PROVIDER_FAILOVER_SESSION_VERSION = 1';
const LEGACY_REGISTRY_MARKER = 'UCLAW_OPENAI_RESPONSES_COMPATIBLE_FALLBACK_VERSION =';
const LEGACY_TRANSPORT_MARKER = 'UCLAW_OPENAI_RESPONSES_TRANSPORT_COMPATIBLE_FALLBACK_VERSION =';

const LEGACY_REGISTRY_START = `const streamOpenAICompletions = createLazyStream(loadOpenAICompletionsProviderModule);
const streamSimpleOpenAICompletions = createLazySimpleStream(loadOpenAICompletionsProviderModule);`;
const LEGACY_REGISTRY_END = 'const streamSimpleOpenAIResponses = createUclawOpenAIResponsesCompatibleFallbackStream(loadOpenAIResponsesProviderModule, true);';
const ORIGINAL_REGISTRY_STREAMS = `${LEGACY_REGISTRY_START}
const streamOpenAIResponses = createLazyStream(loadOpenAIResponsesProviderModule);
const streamSimpleOpenAIResponses = createLazySimpleStream(loadOpenAIResponsesProviderModule);`;

const TRANSPORT_FUNCTION_START = 'function createOpenAIResponsesTransportStreamFn() {';
const ORIGINAL_TRANSPORT_STREAM_START = `\t\tconst eventStream = createAssistantMessageEventStream();
\t\tconst stream = eventStream;
\t\t(async () => {`;
const LEGACY_TRANSPORT_STREAM_START = `\t\tconst eventStream = createAssistantMessageEventStream();
\t\tconst stream = eventStream;
\t\tlet uclawResponsesStarted = false;
\t\t(async () => {`;
const ORIGINAL_TRANSPORT_START_EVENT = `\t\t\t\tstream.push({
\t\t\t\t\ttype: "start",
\t\t\t\t\tpartial: output
\t\t\t\t});`;
const LEGACY_TRANSPORT_START_EVENT = `\t\t\t\tuclawResponsesStarted = true;
${ORIGINAL_TRANSPORT_START_EVENT}`;

const CANDIDATE_FUNCTION_ANCHOR = 'function resolveFallbackCandidatesUncached(params) {';
const CANDIDATE_PRIMARY_ANCHOR = `\taddExplicitCandidate(normalizeCandidateRef(resolvedPrimary.provider, resolvedPrimary.model));
\tconst modelFallbacks = params.fallbacksOverride !== void 0 ? params.fallbacksOverride : resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model);`;
const CANDIDATE_ATTEMPT_ANCHOR = `\t\tconst attemptRun = await runFallbackAttempt({
\t\t\trun: params.run,
\t\t\t...candidate,
\t\t\tattempts,
\t\t\toptions: {`;
const SESSION_STATE_ANCHOR = 'const FALLBACK_SELECTION_STATE_KEYS = [';
const SESSION_PERSISTENCE_ANCHOR = `\tconst persistFallbackCandidateSelection = async (provider, model, candidateRun) => {
\t\tif (!params.sessionKey || !params.activeSessionStore || preserveUserFacingSessionState || provider === effectiveRun.provider && model === effectiveRun.model) return;`;

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function replaceUnique(content, search, replacement, label, filePath) {
  const count = countOccurrences(content, search);
  if (count !== 1) {
    throw new Error(`[openclaw-text-provider-failover-patch] Expected exactly one ${label} anchor in ${filePath}; found ${count}.`);
  }
  return content.replace(search, replacement);
}

function readNonEmptyString(value, key) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`[openclaw-text-provider-failover-patch] ${key} must be a non-empty string in ${ENDPOINTS_PATH}.`);
  }
  return value.trim();
}

export function readOpenClawTextProviderFailoverConfig() {
  const endpoints = JSON.parse(readFileSync(ENDPOINTS_PATH, 'utf8'));
  const raw = endpoints.openClawTextFailover;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`[openclaw-text-provider-failover-patch] openClawTextFailover is required in ${ENDPOINTS_PATH}.`);
  }
  if (typeof raw.enabled !== 'boolean') {
    throw new Error(`[openclaw-text-provider-failover-patch] openClawTextFailover.enabled must be boolean in ${ENDPOINTS_PATH}.`);
  }
  const primaryProvider = readNonEmptyString(raw.primaryProvider, 'openClawTextFailover.primaryProvider');
  const fallbackProvider = readNonEmptyString(raw.fallbackProvider, 'openClawTextFailover.fallbackProvider');
  const fallbackModel = readNonEmptyString(raw.fallbackModel, 'openClawTextFailover.fallbackModel');
  const fallbackApiProtocol = readNonEmptyString(raw.fallbackApiProtocol, 'openClawTextFailover.fallbackApiProtocol');
  if (primaryProvider === fallbackProvider) {
    throw new Error('[openclaw-text-provider-failover-patch] primaryProvider and fallbackProvider must differ.');
  }
  if (!['openai-completions', 'openai-responses'].includes(fallbackApiProtocol)) {
    throw new Error('[openclaw-text-provider-failover-patch] fallbackApiProtocol must be an OpenAI protocol.');
  }
  if (raw.reusePrimaryBaseUrl !== true || raw.reusePrimaryApiKey !== true) {
    throw new Error('[openclaw-text-provider-failover-patch] fallback must reuse the primary base URL and API key.');
  }
  return {
    enabled: raw.enabled,
    primaryProvider,
    fallbackProvider,
    fallbackModel,
    fallbackApiProtocol,
  };
}

function candidateConstants(config) {
  return `const UCLAW_TEXT_PROVIDER_FAILOVER_VERSION = 2;
const UCLAW_TEXT_PROVIDER_FAILOVER_ENABLED = ${JSON.stringify(config.enabled)};
const UCLAW_TEXT_PROVIDER_FAILOVER_MANAGED_DISTRIBUTION = typeof process === "undefined" || process.env.CLAWX_MANAGED_PROVIDER !== "0";
const UCLAW_TEXT_PROVIDER_FAILOVER_PRIMARY_PROVIDER = ${JSON.stringify(config.primaryProvider)};
const UCLAW_TEXT_PROVIDER_FAILOVER_PROVIDER = ${JSON.stringify(config.fallbackProvider)};
const UCLAW_TEXT_PROVIDER_FAILOVER_MODEL = ${JSON.stringify(config.fallbackModel)};
let uclawTextProviderFailoverTestFailureConsumed = false;
function createUclawTextProviderFailoverTestRun(run, candidate, isPrimary, sessionId) {
\tconst shouldInject = UCLAW_TEXT_PROVIDER_FAILOVER_ENABLED
\t\t&& UCLAW_TEXT_PROVIDER_FAILOVER_MANAGED_DISTRIBUTION
\t\t&& typeof process !== "undefined"
\t\t&& process.env.CLAWX_TEXT_FAILOVER_TEST_ALLOWED === "1"
\t\t&& process.env.CLAWX_TEXT_FAILOVER_TEST_MODE === "fail-primary-once"
\t\t&& !uclawTextProviderFailoverTestFailureConsumed
\t\t&& Boolean(sessionId)
\t\t&& isPrimary
\t\t&& normalizeProviderId(candidate?.provider) === normalizeProviderId(UCLAW_TEXT_PROVIDER_FAILOVER_PRIMARY_PROVIDER);
\tif (!shouldInject) return run;
\tuclawTextProviderFailoverTestFailureConsumed = true;
\treturn async () => {
\t\tconst error = new Error("UClaw simulated OpenAI Provider failure before visible output");
\t\terror.name = "UclawSimulatedProviderFailure";
\t\terror.status = 500;
\t\terror.code = "UCLAW_SIMULATED_PROVIDER_FAILURE";
\t\tconsole.warn("[uclaw-text-provider-failover-test] Injecting one-time failure for " + candidate.provider + "/" + candidate.model);
\t\tthrow error;
\t};
}
`;
}

function sessionConstants(config) {
  return `const UCLAW_TEXT_PROVIDER_FAILOVER_SESSION_VERSION = 1;
const UCLAW_TEXT_PROVIDER_FAILOVER_SESSION_ENABLED = ${JSON.stringify(config.enabled)};
const UCLAW_TEXT_PROVIDER_FAILOVER_SESSION_MANAGED_DISTRIBUTION = typeof process === "undefined" || process.env.CLAWX_MANAGED_PROVIDER !== "0";
const UCLAW_TEXT_PROVIDER_FAILOVER_SESSION_PRIMARY_PROVIDER = ${JSON.stringify(config.primaryProvider)};
const UCLAW_TEXT_PROVIDER_FAILOVER_SESSION_PROVIDER = ${JSON.stringify(config.fallbackProvider)};
const UCLAW_TEXT_PROVIDER_FAILOVER_SESSION_MODEL = ${JSON.stringify(config.fallbackModel)};
function normalizeUclawTextProviderFailoverValue(value) {
\treturn typeof value === "string" ? value.trim().toLowerCase() : "";
}
function shouldKeepUclawTextProviderFallbackEphemeral(effectiveRun, provider, model) {
\treturn UCLAW_TEXT_PROVIDER_FAILOVER_SESSION_ENABLED
\t\t&& UCLAW_TEXT_PROVIDER_FAILOVER_SESSION_MANAGED_DISTRIBUTION
\t\t&& normalizeUclawTextProviderFailoverValue(effectiveRun?.provider) === normalizeUclawTextProviderFailoverValue(UCLAW_TEXT_PROVIDER_FAILOVER_SESSION_PRIMARY_PROVIDER)
\t\t&& normalizeUclawTextProviderFailoverValue(provider) === normalizeUclawTextProviderFailoverValue(UCLAW_TEXT_PROVIDER_FAILOVER_SESSION_PROVIDER)
\t\t&& (typeof model === "string" ? model.trim() : "") === UCLAW_TEXT_PROVIDER_FAILOVER_SESSION_MODEL;
}
`;
}

function removeLegacyRegistryFallback(content, filePath) {
  if (!content.includes(LEGACY_REGISTRY_MARKER)) return null;
  const startIndex = content.indexOf(LEGACY_REGISTRY_START);
  const endIndex = content.indexOf(LEGACY_REGISTRY_END, startIndex);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`[openclaw-text-provider-failover-patch] Legacy registry fallback anchors are incomplete in ${filePath}.`);
  }
  const endOffset = endIndex + LEGACY_REGISTRY_END.length;
  return {
    content: `${content.slice(0, startIndex)}${ORIGINAL_REGISTRY_STREAMS}${content.slice(endOffset)}`,
    changed: true,
    category: 'legacy-registry-cleanup',
  };
}

function removeLegacyTransportFallback(content, filePath) {
  if (!content.includes(LEGACY_TRANSPORT_MARKER)) return null;
  const helperStart = content.indexOf('const UCLAW_OPENAI_RESPONSES_TRANSPORT_COMPATIBLE_FALLBACK_VERSION =');
  const functionStart = content.indexOf(TRANSPORT_FUNCTION_START, helperStart);
  if (helperStart === -1 || functionStart === -1) {
    throw new Error(`[openclaw-text-provider-failover-patch] Legacy transport fallback helper anchors are incomplete in ${filePath}.`);
  }
  let patched = `${content.slice(0, helperStart)}${content.slice(functionStart)}`;
  patched = replaceUnique(patched, LEGACY_TRANSPORT_STREAM_START, ORIGINAL_TRANSPORT_STREAM_START, 'legacy transport stream state', filePath);
  patched = replaceUnique(patched, LEGACY_TRANSPORT_START_EVENT, ORIGINAL_TRANSPORT_START_EVENT, 'legacy transport start event', filePath);
  const fallbackStart = patched.indexOf('\t\t\t\tif (shouldUclawFallbackOpenAIResponsesTransport(');
  const warningStart = patched.indexOf('\t\t\t\tlog.warn(`[responses] error provider=', fallbackStart);
  if (fallbackStart === -1 || warningStart === -1) {
    throw new Error(`[openclaw-text-provider-failover-patch] Legacy transport retry block is incomplete in ${filePath}.`);
  }
  patched = `${patched.slice(0, fallbackStart)}${patched.slice(warningStart)}`;
  return { content: patched, changed: true, category: 'legacy-transport-cleanup' };
}

function patchCandidateChain(content, filePath, config) {
  if (!content.includes(CANDIDATE_FUNCTION_ANCHOR) && !content.includes(CANDIDATE_PATCH_MARKER)) return null;
  let patched = content;
  const constants = candidateConstants(config);
  const constantsPattern = /const UCLAW_TEXT_PROVIDER_FAILOVER_VERSION = (?:1|2);[\s\S]*?(?=function resolveFallbackCandidatesUncached\(params\) \{)/u;
  const constantsMatches = patched.match(constantsPattern) ?? [];
  if (constantsMatches.length > 1) {
    throw new Error(`[openclaw-text-provider-failover-patch] Multiple candidate config blocks found in ${filePath}.`);
  }
  if (constantsMatches.length === 1) {
    patched = patched.replace(constantsPattern, constants);
  } else {
    patched = replaceUnique(patched, CANDIDATE_FUNCTION_ANCHOR, `${constants}${CANDIDATE_FUNCTION_ANCHOR}`, 'candidate function', filePath);
  }

  const candidateBranch = `\taddExplicitCandidate(normalizeCandidateRef(resolvedPrimary.provider, resolvedPrimary.model));
\tif (UCLAW_TEXT_PROVIDER_FAILOVER_ENABLED && UCLAW_TEXT_PROVIDER_FAILOVER_MANAGED_DISTRIBUTION && normalizeProviderId(resolvedPrimary.provider) === normalizeProviderId(UCLAW_TEXT_PROVIDER_FAILOVER_PRIMARY_PROVIDER)) {
\t\taddExplicitCandidate(normalizeCandidateRef(UCLAW_TEXT_PROVIDER_FAILOVER_PROVIDER, UCLAW_TEXT_PROVIDER_FAILOVER_MODEL));
\t\treturn candidates;
\t}
\tconst modelFallbacks = params.fallbacksOverride !== void 0 ? params.fallbacksOverride : resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model);`;
  if (!patched.includes('UCLAW_TEXT_PROVIDER_FAILOVER_ENABLED && UCLAW_TEXT_PROVIDER_FAILOVER_MANAGED_DISTRIBUTION && normalizeProviderId(resolvedPrimary.provider)')) {
    const existingCondition = /\tif \(UCLAW_TEXT_PROVIDER_FAILOVER_ENABLED(?: && UCLAW_TEXT_PROVIDER_FAILOVER_MANAGED_DISTRIBUTION)? && normalizeProviderId\(resolvedPrimary\.provider\) === normalizeProviderId\(UCLAW_TEXT_PROVIDER_FAILOVER_PRIMARY_PROVIDER\)\) \{/u;
    if (existingCondition.test(patched)) {
      patched = patched.replace(
        existingCondition,
        '\tif (UCLAW_TEXT_PROVIDER_FAILOVER_ENABLED && UCLAW_TEXT_PROVIDER_FAILOVER_MANAGED_DISTRIBUTION && normalizeProviderId(resolvedPrimary.provider) === normalizeProviderId(UCLAW_TEXT_PROVIDER_FAILOVER_PRIMARY_PROVIDER)) {',
      );
    } else {
      patched = replaceUnique(patched, CANDIDATE_PRIMARY_ANCHOR, candidateBranch, 'candidate primary', filePath);
    }
  }

  const candidateAttempt = `\t\tconst attemptRun = await runFallbackAttempt({
\t\t\trun: createUclawTextProviderFailoverTestRun(params.run, candidate, isPrimary, params.sessionId),
\t\t\t...candidate,
\t\t\tattempts,
\t\t\toptions: {`;
  if (!patched.includes('\t\t\trun: createUclawTextProviderFailoverTestRun(params.run, candidate, isPrimary, params.sessionId),')) {
    patched = replaceUnique(patched, CANDIDATE_ATTEMPT_ANCHOR, candidateAttempt, 'candidate attempt', filePath);
  }
  return {
    content: patched,
    changed: patched !== content,
    category: 'candidate-chain',
  };
}

function patchSessionPersistence(content, filePath, config) {
  if (!content.includes(SESSION_STATE_ANCHOR) && !content.includes(SESSION_PATCH_MARKER)) return null;
  if (!content.includes('persistFallbackCandidateSelection')) return null;
  let patched = content;
  const constants = sessionConstants(config);
  const constantsPattern = /const UCLAW_TEXT_PROVIDER_FAILOVER_SESSION_VERSION = 1;[\s\S]*?(?=const FALLBACK_SELECTION_STATE_KEYS = \[)/u;
  const constantsMatches = patched.match(constantsPattern) ?? [];
  if (constantsMatches.length > 1) {
    throw new Error(`[openclaw-text-provider-failover-patch] Multiple session config blocks found in ${filePath}.`);
  }
  if (constantsMatches.length === 1) {
    patched = patched.replace(constantsPattern, constants);
  } else {
    patched = replaceUnique(patched, SESSION_STATE_ANCHOR, `${constants}${SESSION_STATE_ANCHOR}`, 'fallback selection state', filePath);
  }

  const persistenceGuard = `\tconst persistFallbackCandidateSelection = async (provider, model, candidateRun) => {
\t\tif (shouldKeepUclawTextProviderFallbackEphemeral(effectiveRun, provider, model)) return;
\t\tif (!params.sessionKey || !params.activeSessionStore || preserveUserFacingSessionState || provider === effectiveRun.provider && model === effectiveRun.model) return;`;
  if (!patched.includes('\t\tif (shouldKeepUclawTextProviderFallbackEphemeral(effectiveRun, provider, model)) return;')) {
    patched = replaceUnique(patched, SESSION_PERSISTENCE_ANCHOR, persistenceGuard, 'fallback persistence guard', filePath);
  }
  return {
    content: patched,
    changed: patched !== content,
    category: 'session-persistence',
  };
}

export function patchOpenClawTextProviderFailoverContent(
  content,
  filePath = '<fixture>',
  config = readOpenClawTextProviderFailoverConfig(),
) {
  let patched = content;
  let changed = false;
  const categories = [];
  for (const patcher of [
    removeLegacyRegistryFallback,
    removeLegacyTransportFallback,
    (value, path) => patchCandidateChain(value, path, config),
    (value, path) => patchSessionPersistence(value, path, config),
  ]) {
    const result = patcher(patched, filePath);
    if (!result) continue;
    categories.push(result.category);
    changed = result.changed || changed;
    patched = result.content;
  }
  return { content: patched, changed, categories };
}

function assertExpectedOpenClawVersion(distDir) {
  const packagePath = join(distDir, '..', 'package.json');
  if (!existsSync(packagePath)) {
    throw new Error(`[openclaw-text-provider-failover-patch] Missing ${packagePath}`);
  }
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (packageJson.version !== EXPECTED_OPENCLAW_VERSION) {
    throw new Error(
      `[openclaw-text-provider-failover-patch] Expected OpenClaw ${EXPECTED_OPENCLAW_VERSION}, found ${String(packageJson.version)}`,
    );
  }
}

export function patchOpenClawTextProviderFailoverRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-text-provider-failover-patch] Missing dist directory: ${distDir}`);
  }
  assertExpectedOpenClawVersion(distDir);

  const config = readOpenClawTextProviderFailoverConfig();
  const categoryCounts = new Map();
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith('.js')) continue;
    const filePath = join(distDir, file);
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawTextProviderFailoverContent(content, filePath, config);
    if (result.categories.length === 0) continue;
    for (const category of result.categories) {
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    }
    if (result.changed) {
      patchedFiles += 1;
      if (!dryRun) writeFileSync(filePath, result.content, 'utf8');
      logger.log?.(`[openclaw-text-provider-failover-patch] Patched: ${file}`);
    } else {
      alreadyPatchedFiles += 1;
    }
  }

  for (const category of ['candidate-chain', 'session-persistence']) {
    const count = categoryCounts.get(category) ?? 0;
    if (count !== 1) {
      throw new Error(`[openclaw-text-provider-failover-patch] Expected exactly one ${category} runtime file; found ${count}.`);
    }
  }
  for (const category of ['legacy-registry-cleanup', 'legacy-transport-cleanup']) {
    const count = categoryCounts.get(category) ?? 0;
    if (count > 1) {
      throw new Error(`[openclaw-text-provider-failover-patch] Expected at most one ${category} runtime file; found ${count}.`);
    }
  }

  logger.log?.(
    `[openclaw-text-provider-failover-patch] ${dryRun ? 'Dry-run matched' : 'Ready'}. Changed ${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`,
  );
  return {
    patchedFiles,
    alreadyPatchedFiles,
    categoryCounts: Object.fromEntries(categoryCounts),
    distDir,
  };
}

export function patchInstalledOpenClawTextProviderFailoverRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawTextProviderFailoverRuntime(
    join(cwd, 'node_modules', 'openclaw', 'dist'),
    options,
  );
}
