import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const PATCH_MARKER = 'UCLAW_MODEL_REQUEST_CONTRACT_DIAGNOSTIC';
const LIGHT_CHAT_PATCH_MARKER = 'UCLAW_LIGHT_CHAT_MODEL_REQUEST_OVERRIDE';

const BUILD_GUARDED_MODEL_FETCH_ANCHOR = `function buildGuardedModelFetch(model, timeoutMs, options) {`;

const CONTRACT_SUMMARY_HELPERS = `const UCLAW_MODEL_REQUEST_CONTRACT_DIAGNOSTIC = "safe-summary-v1";
const UCLAW_MODEL_REQUEST_CONTRACT_ENUMS = /* @__PURE__ */ new Set([
	"auto",
	"disabled",
	"function",
	"high",
	"low",
	"medium",
	"minimal",
	"none",
	"object",
	"required",
	"xhigh"
]);
function summarizeUClawModelRequestContractLabel(value) {
	if (typeof value !== "string") return value == null ? "missing" : typeof value;
	const normalized = value.trim().replace(/[\\u0000-\\u001f\\u007f]/g, "?");
	return normalized ? normalized.slice(0, 160) : "empty";
}
function summarizeUClawModelRequestContractKey(value) {
	return /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(value) ? value : "other-key";
}
function summarizeUClawModelRequestContractEnum(value) {
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		return UCLAW_MODEL_REQUEST_CONTRACT_ENUMS.has(normalized) ? normalized : "other-string";
	}
	if (value === null) return "null";
	return value === void 0 ? "missing" : typeof value;
}
function summarizeUClawModelRequestToolChoice(value) {
	if (typeof value === "string") return \`string:\${summarizeUClawModelRequestContractEnum(value)}\`;
	if (Array.isArray(value)) return "array";
	if (value && typeof value === "object") return \`object:\${summarizeUClawModelRequestContractEnum(value.type)}\`;
	return summarizeUClawModelRequestContractEnum(value);
}
function buildUClawModelRequestContractSummary(model, init) {
	const baseSummary = {
		diagnostic: UCLAW_MODEL_REQUEST_CONTRACT_DIAGNOSTIC,
		provider: summarizeUClawModelRequestContractLabel(model?.provider),
		api: summarizeUClawModelRequestContractLabel(model?.api),
		model: summarizeUClawModelRequestContractLabel(model?.id),
		requestModel: "unavailable",
		bodyStatus: init?.body == null ? "no-body" : typeof init.body === "string" ? "unparsed-json" : "non-string-body",
		messageCount: 0,
		inputItemCount: 0,
		toolsPresent: false,
		toolCount: 0,
		reasoningPresent: false,
		reasoningEffortSource: "none",
		reasoningEffort: "missing",
		toolChoice: "missing",
		promptCacheKeyPresent: false,
		promptCacheKeyNonEmpty: false,
		topLevelKeyCount: 0,
		topLevelKeys: []
	};
	if (typeof init?.body !== "string") return baseSummary;
	let payload;
	try {
		payload = JSON.parse(init.body);
	} catch {
		return { ...baseSummary, bodyStatus: "invalid-json" };
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {
		...baseSummary,
		bodyStatus: "json-non-object"
	};
	const hasOwn = (key) => Object.prototype.hasOwnProperty.call(payload, key);
	const topLevelKeys = Object.keys(payload).sort().map(summarizeUClawModelRequestContractKey);
	const inputItemCount = Array.isArray(payload.input) ? payload.input.length : hasOwn("input") && payload.input != null ? 1 : 0;
	const messageCount = Array.isArray(payload.messages) ? payload.messages.length : Array.isArray(payload.input) ? payload.input.reduce((count, item) => {
		if (!item || typeof item !== "object") return count;
		return typeof item.role === "string" || item.type === "message" ? count + 1 : count;
	}, 0) : typeof payload.input === "string" ? 1 : 0;
	const nestedReasoningEffort = payload.reasoning && typeof payload.reasoning === "object" && !Array.isArray(payload.reasoning) && Object.prototype.hasOwnProperty.call(payload.reasoning, "effort") ? payload.reasoning.effort : void 0;
	const reasoningEffortSource = nestedReasoningEffort !== void 0 ? "reasoning.effort" : hasOwn("reasoning_effort") ? "reasoning_effort" : "none";
	const reasoningEffort = nestedReasoningEffort !== void 0 ? nestedReasoningEffort : hasOwn("reasoning_effort") ? payload.reasoning_effort : void 0;
	return {
		...baseSummary,
		requestModel: summarizeUClawModelRequestContractLabel(payload.model),
		bodyStatus: "json-object",
		messageCount,
		inputItemCount,
		toolsPresent: hasOwn("tools"),
		toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
		reasoningPresent: hasOwn("reasoning"),
		reasoningEffortSource,
		reasoningEffort: summarizeUClawModelRequestContractEnum(reasoningEffort),
		toolChoice: summarizeUClawModelRequestToolChoice(payload.tool_choice),
		promptCacheKeyPresent: hasOwn("prompt_cache_key"),
		promptCacheKeyNonEmpty: typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.length > 0,
		topLevelKeyCount: topLevelKeys.length,
		topLevelKeys: topLevelKeys.slice(0, 64)
	};
}
`;

const LIGHT_CHAT_REQUEST_OVERRIDE_HELPERS = `const UCLAW_LIGHT_CHAT_MODEL_REQUEST_OVERRIDE = "disabled-v2";
function applyUClawLightChatModelRequestOverride(baseInit) {
\treturn baseInit;
}
`;

const LIGHT_CHAT_HELPER_START_MARKERS = [
  'const UCLAW_LIGHT_CHAT_MODEL_REQUEST_OVERRIDE = "reasoning-none-v1";',
  'const UCLAW_LIGHT_CHAT_MODEL_REQUEST_OVERRIDE = "disabled-v2";',
];
const LIGHT_CHAT_HELPER_VERSION_MARKER = LIGHT_CHAT_HELPER_START_MARKERS[1];
const LIGHT_CHAT_HELPER_END = '\nfunction buildGuardedModelFetch';

const BASE_INIT_ANCHOR = `		}) ?? init;
		const synthesizeJsonAsSse = await requestBodyHasStreamTrue(request, baseInit);`;

const BASE_INIT_PATCH = `		}) ?? init;
		const modelRequestContractSummary = buildUClawModelRequestContractSummary(model, baseInit);
		const synthesizeJsonAsSse = await requestBodyHasStreamTrue(request, baseInit);`;

const LIGHT_CHAT_BASE_INIT_DECLARATION_ANCHOR = `		const baseInit = (request && {`;
const LIGHT_CHAT_BASE_INIT_DECLARATION_PATCH = `		let baseInit = (request && {`;

const LIGHT_CHAT_CONTRACT_SUMMARY_ANCHOR = `		const modelRequestContractSummary = buildUClawModelRequestContractSummary(model, baseInit);
		const synthesizeJsonAsSse = await requestBodyHasStreamTrue(request, baseInit);`;

const LIGHT_CHAT_CONTRACT_SUMMARY_PATCH = `		baseInit = applyUClawLightChatModelRequestOverride(baseInit, function (event) {
			log$1.info(\`[model-request-light-chat] \${JSON.stringify(event)}\`);
		});
		const modelRequestContractSummary = buildUClawModelRequestContractSummary(model, baseInit);
		const synthesizeJsonAsSse = await requestBodyHasStreamTrue(request, baseInit);`;

const GUARDED_FETCH_ANCHOR = `			localServiceLease = await ensureModelProviderLocalService(model, baseInit?.headers, localServiceSignal);
			result = await fetchWithSsrFGuard(useEnvProxy ? withTrustedEnvProxyGuardedFetchMode(guardedFetchOptions) : guardedFetchOptions);`;

const GUARDED_FETCH_PATCH = `			localServiceLease = await ensureModelProviderLocalService(model, baseInit?.headers, localServiceSignal);
			log$1.info(\`[model-request-contract] \${JSON.stringify(modelRequestContractSummary)}\`);
			result = await fetchWithSsrFGuard(useEnvProxy ? withTrustedEnvProxyGuardedFetchMode(guardedFetchOptions) : guardedFetchOptions);`;

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function assertUniqueAnchor(content, anchor, label, filePath) {
  const count = countOccurrences(content, anchor);
  if (count !== 1) {
    throw new Error(
      `[openclaw-model-request-contract-patch] Expected exactly one ${label} anchor in ${filePath}; found ${count}.`,
    );
  }
}

function patchModelRequestContractContent(content, filePath) {
  let patched = content;
  let contractAlreadyPatched = content.includes(PATCH_MARKER);
  let lightChatAlreadyPatched = content.includes(LIGHT_CHAT_PATCH_MARKER);
  let lightChatHelperNeedsUpgrade = lightChatAlreadyPatched && !content.includes(LIGHT_CHAT_HELPER_VERSION_MARKER);

  if (contractAlreadyPatched) {
    const expectedPatchedSnippets = [
      'const modelRequestContractSummary = buildUClawModelRequestContractSummary(model, baseInit);',
      'log$1.info(`[model-request-contract] ${JSON.stringify(modelRequestContractSummary)}`);',
    ];
    if (!expectedPatchedSnippets.every((snippet) => content.includes(snippet))) {
      throw new Error(
        `[openclaw-model-request-contract-patch] Partial or incompatible existing patch in ${filePath}.`,
      );
    }
  } else {
    assertUniqueAnchor(patched, BUILD_GUARDED_MODEL_FETCH_ANCHOR, 'buildGuardedModelFetch', filePath);
    assertUniqueAnchor(patched, BASE_INIT_ANCHOR, 'baseInit', filePath);
    assertUniqueAnchor(patched, GUARDED_FETCH_ANCHOR, 'fetchWithSsrFGuard', filePath);

    patched = patched
      .replace(
        BUILD_GUARDED_MODEL_FETCH_ANCHOR,
        `${CONTRACT_SUMMARY_HELPERS}\n${BUILD_GUARDED_MODEL_FETCH_ANCHOR}`,
      )
      .replace(BASE_INIT_ANCHOR, BASE_INIT_PATCH)
      .replace(GUARDED_FETCH_ANCHOR, GUARDED_FETCH_PATCH);
  }

  if (lightChatHelperNeedsUpgrade) {
    const start = LIGHT_CHAT_HELPER_START_MARKERS
      .map((marker) => patched.indexOf(marker))
      .find((index) => index >= 0) ?? -1;
    const end = patched.indexOf(LIGHT_CHAT_HELPER_END, start);
    if (start < 0 || end < 0) {
      throw new Error(`[openclaw-model-request-contract-patch] Failed to locate light chat helper block in ${filePath}.`);
    }
    patched = `${patched.slice(0, start)}${LIGHT_CHAT_REQUEST_OVERRIDE_HELPERS}${patched.slice(end + 1)}`;
  } else if (!lightChatAlreadyPatched) {
    assertUniqueAnchor(patched, BUILD_GUARDED_MODEL_FETCH_ANCHOR, 'buildGuardedModelFetch', filePath);
    assertUniqueAnchor(patched, LIGHT_CHAT_BASE_INIT_DECLARATION_ANCHOR, 'baseInit declaration', filePath);
    assertUniqueAnchor(patched, LIGHT_CHAT_CONTRACT_SUMMARY_ANCHOR, 'light chat request override', filePath);
    patched = patched
      .replace(
        BUILD_GUARDED_MODEL_FETCH_ANCHOR,
        `${LIGHT_CHAT_REQUEST_OVERRIDE_HELPERS}\n${BUILD_GUARDED_MODEL_FETCH_ANCHOR}`,
      )
      .replace(LIGHT_CHAT_BASE_INIT_DECLARATION_ANCHOR, LIGHT_CHAT_BASE_INIT_DECLARATION_PATCH)
      .replace(LIGHT_CHAT_CONTRACT_SUMMARY_ANCHOR, LIGHT_CHAT_CONTRACT_SUMMARY_PATCH);
  }

  if (!patched.includes(PATCH_MARKER) || patched === content) {
    if (contractAlreadyPatched && lightChatAlreadyPatched) {
      return { content: patched, changed: false, alreadyPatched: true };
    }
    throw new Error(`[openclaw-model-request-contract-patch] Failed to construct patch for ${filePath}.`);
  }
  if (!patched.includes(LIGHT_CHAT_PATCH_MARKER)) {
    throw new Error(`[openclaw-model-request-contract-patch] Failed to construct light chat patch for ${filePath}.`);
  }

  return {
    content: patched,
    changed: patched !== content,
    alreadyPatched: contractAlreadyPatched && lightChatAlreadyPatched,
  };
}

export function patchOpenClawModelRequestContractRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-model-request-contract-patch] OpenClaw dist directory not found: ${distDir}`);
  }

  const javascriptFiles = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => ({
      file: entry.name,
      filePath: join(distDir, entry.name),
    }));
  const fileContents = javascriptFiles.map((entry) => ({
    ...entry,
    content: readFileSync(entry.filePath, 'utf8'),
  }));
  const markerFiles = fileContents.filter((entry) => entry.content.includes(PATCH_MARKER));

  if (markerFiles.length > 0) {
    if (markerFiles.length !== 1) {
      throw new Error(
        `[openclaw-model-request-contract-patch] Expected one patched runtime file in ${distDir}; found ${markerFiles.length}: ${markerFiles.map((entry) => entry.file).join(', ')}`,
      );
    }
    const patched = patchModelRequestContractContent(markerFiles[0].content, markerFiles[0].filePath);
    if (patched.changed && !dryRun) {
      writeFileSync(markerFiles[0].filePath, patched.content, 'utf8');
    }
    logger.log?.(
      `[openclaw-model-request-contract-patch] ${patched.changed ? (dryRun ? 'Dry-run would upgrade' : 'Upgraded') : 'Already patched'}: ${markerFiles[0].file}`,
    );
    return {
      patchedFiles: patched.changed && !dryRun ? 1 : 0,
      alreadyPatchedFiles: patched.changed ? 0 : 1,
      wouldPatchFiles: patched.changed && dryRun ? 1 : 0,
      distDir,
      targetFile: markerFiles[0].filePath,
    };
  }

  const targetFiles = fileContents.filter((entry) =>
    entry.content.includes(BUILD_GUARDED_MODEL_FETCH_ANCHOR),
  );
  if (targetFiles.length !== 1) {
    throw new Error(
      `[openclaw-model-request-contract-patch] Expected exactly one buildGuardedModelFetch runtime file in ${distDir}; found ${targetFiles.length}${targetFiles.length > 0 ? `: ${targetFiles.map((entry) => entry.file).join(', ')}` : ''}.`,
    );
  }

  const target = targetFiles[0];
  const patched = patchModelRequestContractContent(target.content, target.filePath);
  if (!dryRun) writeFileSync(target.filePath, patched.content, 'utf8');
  logger.log?.(
    `[openclaw-model-request-contract-patch] ${dryRun ? 'Dry-run matched' : 'Patched'}: ${target.file}`,
  );

  return {
    patchedFiles: dryRun ? 0 : 1,
    alreadyPatchedFiles: 0,
    wouldPatchFiles: dryRun ? 1 : 0,
    distDir,
    targetFile: target.filePath,
  };
}

export function patchInstalledOpenClawModelRequestContractRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawModelRequestContractRuntime(
    join(cwd, 'node_modules', 'openclaw', 'dist'),
    options,
  );
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const supportedArgs = new Set(['--check', '--dry-run']);
  const unknownArgs = process.argv.slice(2).filter((arg) => !supportedArgs.has(arg));
  if (unknownArgs.length > 0) {
    console.error(
      `[openclaw-model-request-contract-patch] Unsupported arguments: ${unknownArgs.join(', ')}`,
    );
    process.exitCode = 1;
  } else {
    try {
      patchInstalledOpenClawModelRequestContractRuntime(process.cwd(), {
        dryRun: process.argv.includes('--check') || process.argv.includes('--dry-run'),
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
