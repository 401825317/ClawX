import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const EXPECTED_OPENCLAW_VERSION = '2026.6.11';
const REGISTRY_PATCH_MARKER = 'UCLAW_OPENAI_RESPONSES_COMPATIBLE_FALLBACK_VERSION = 3';
const TRANSPORT_PATCH_MARKER = 'UCLAW_OPENAI_RESPONSES_TRANSPORT_COMPATIBLE_FALLBACK_VERSION = 3';
const REGISTRY_V2_MARKER = 'UCLAW_OPENAI_RESPONSES_COMPATIBLE_FALLBACK_VERSION = 2';
const TRANSPORT_V2_MARKER = 'UCLAW_OPENAI_RESPONSES_TRANSPORT_COMPATIBLE_FALLBACK_VERSION = 2';
const LEGACY_PROVIDER_SET = 'new Set(["openai", "lingzhiwuxian"])';
const CURRENT_PROVIDER_SET = 'new Set(["openai"])';

const REGISTRY_STREAM_ANCHOR = `const streamOpenAICompletions = createLazyStream(loadOpenAICompletionsProviderModule);
const streamSimpleOpenAICompletions = createLazySimpleStream(loadOpenAICompletionsProviderModule);
const streamOpenAIResponses = createLazyStream(loadOpenAIResponsesProviderModule);
const streamSimpleOpenAIResponses = createLazySimpleStream(loadOpenAIResponsesProviderModule);`;

const REGISTRY_STREAM_PATCH = `const streamOpenAICompletions = createLazyStream(loadOpenAICompletionsProviderModule);
const streamSimpleOpenAICompletions = createLazySimpleStream(loadOpenAICompletionsProviderModule);
const UCLAW_OPENAI_RESPONSES_COMPATIBLE_FALLBACK_VERSION = 3;
const UCLAW_OPENAI_RESPONSES_COMPATIBLE_FALLBACK_ERROR_PREFIX = "OpenAI API error (404):";
const UCLAW_OPENAI_RESPONSES_COMPATIBLE_FALLBACK_PROVIDERS = /* @__PURE__ */ new Set(["openai"]);
function shouldUclawFallbackOpenAIResponsesEvent(model, options, event, responseStarted) {
\treturn !responseStarted && !options?.signal?.aborted && UCLAW_OPENAI_RESPONSES_COMPATIBLE_FALLBACK_PROVIDERS.has(model.provider) && event?.type === "error" && typeof event.error?.errorMessage === "string" && event.error.errorMessage.startsWith(UCLAW_OPENAI_RESPONSES_COMPATIBLE_FALLBACK_ERROR_PREFIX);
}
function createUclawOpenAIResponsesCompatibleFallbackStream(loadResponsesModule, simple) {
\treturn (model, context, options) => {
\t\tconst outer = new AssistantMessageEventStream();
\t\t(async () => {
\t\t\ttry {
\t\t\t\tconst responsesModule = await loadResponsesModule();
\t\t\t\tconst responsesStream = simple ? responsesModule.streamSimple(model, context, options) : responsesModule.stream(model, context, options);
\t\t\t\tlet responseStarted = false;
\t\t\t\tfor await (const event of responsesStream) {
\t\t\t\t\tif (event?.type === "start") responseStarted = true;
\t\t\t\t\tif (!shouldUclawFallbackOpenAIResponsesEvent(model, options, event, responseStarted)) {
\t\t\t\t\t\touter.push(event);
\t\t\t\t\t\tcontinue;
\t\t\t\t\t}
\t\t\t\t\tconst completionsModule = await loadOpenAICompletionsProviderModule();
\t\t\t\t\tconst fallbackModel = { ...model, api: "openai-completions" };
\t\t\t\t\tconst fallbackStream = simple ? completionsModule.streamSimple(fallbackModel, context, options) : completionsModule.stream(fallbackModel, context, options);
\t\t\t\t\tfor await (const fallbackEvent of fallbackStream) outer.push(fallbackEvent);
\t\t\t\t\touter.end();
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\touter.end();
\t\t\t} catch (error) {
\t\t\t\tconst message = createLazyLoadErrorMessage(model, error);
\t\t\t\touter.push({ type: "error", reason: "error", error: message });
\t\t\t\touter.end(message);
\t\t\t}
\t\t})();
\t\treturn outer;
\t};
}
const streamOpenAIResponses = createUclawOpenAIResponsesCompatibleFallbackStream(loadOpenAIResponsesProviderModule, false);
const streamSimpleOpenAIResponses = createUclawOpenAIResponsesCompatibleFallbackStream(loadOpenAIResponsesProviderModule, true);`;

const TRANSPORT_FUNCTION_START = 'function createOpenAIResponsesTransportStreamFn() {';
const TRANSPORT_FUNCTION_END = '\nfunction resolveCacheRetention(cacheRetention) {';
const TRANSPORT_STREAM_ANCHOR = `\t\tconst eventStream = createAssistantMessageEventStream();
\t\tconst stream = eventStream;
\t\t(async () => {`;
const TRANSPORT_STREAM_PATCH = `\t\tconst eventStream = createAssistantMessageEventStream();
\t\tconst stream = eventStream;
\t\tlet uclawResponsesStarted = false;
\t\t(async () => {`;
const TRANSPORT_START_EVENT_ANCHOR = `\t\t\t\tstream.push({
\t\t\t\t\ttype: "start",
\t\t\t\t\tpartial: output
\t\t\t\t});`;
const TRANSPORT_START_EVENT_PATCH = `\t\t\t\tuclawResponsesStarted = true;
\t\t\t\tstream.push({
\t\t\t\t\ttype: "start",
\t\t\t\t\tpartial: output
\t\t\t\t});`;
const TRANSPORT_ERROR_ANCHOR = `\t\t\t} catch (error) {
\t\t\t\tlog.warn(\`[responses] error provider=\${model.provider} api=\${model.api} model=\${model.id} \` + summarizeOpenAITransportError(error));
\t\t\t\tassignTransportErrorDetails(output, error, options?.signal);
\t\t\t\tstream.push({
\t\t\t\t\ttype: "error",
\t\t\t\t\treason: output.stopReason,
\t\t\t\t\terror: output
\t\t\t\t});
\t\t\t\tstream.end();
\t\t\t}`;
const TRANSPORT_ERROR_PATCH = `\t\t\t} catch (error) {
\t\t\t\tif (shouldUclawFallbackOpenAIResponsesTransport(model, options, error, uclawResponsesStarted)) {
\t\t\t\t\ttry {
\t\t\t\t\t\tconst fallbackModel = { ...model, api: "openai-completions" };
\t\t\t\t\t\tconst fallbackStream = createOpenAICompletionsTransportStreamFn()(fallbackModel, context, options);
\t\t\t\t\t\tfor await (const fallbackEvent of fallbackStream) stream.push(fallbackEvent);
\t\t\t\t\t\tstream.end();
\t\t\t\t\t\treturn;
\t\t\t\t\t} catch (fallbackError) {
\t\t\t\t\t\terror = fallbackError;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tlog.warn(\`[responses] error provider=\${model.provider} api=\${model.api} model=\${model.id} \` + summarizeOpenAITransportError(error));
\t\t\t\tassignTransportErrorDetails(output, error, options?.signal);
\t\t\t\tstream.push({ type: "error", reason: output.stopReason, error: output });
\t\t\t\tstream.end();
\t\t\t}`;

const TRANSPORT_HELPERS = `const UCLAW_OPENAI_RESPONSES_TRANSPORT_COMPATIBLE_FALLBACK_VERSION = 3;
const UCLAW_OPENAI_RESPONSES_TRANSPORT_COMPATIBLE_FALLBACK_PROVIDERS = /* @__PURE__ */ new Set(["openai"]);
function isUclawOpenAIResponsesTransport404(error) {
\tif (!error || typeof error !== "object") return false;
\tconst status = error.status ?? error.statusCode ?? error.response?.status;
\treturn status === 404 || status === "404";
}
function shouldUclawFallbackOpenAIResponsesTransport(model, options, error, responseStarted) {
\treturn !responseStarted && !options?.signal?.aborted && UCLAW_OPENAI_RESPONSES_TRANSPORT_COMPATIBLE_FALLBACK_PROVIDERS.has(model.provider) && isUclawOpenAIResponsesTransport404(error);
}
`;

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function assertExpectedOpenClawVersion(distDir) {
  const packagePath = join(distDir, '..', 'package.json');
  if (!existsSync(packagePath)) {
    throw new Error(`[openclaw-responses-compatible-fallback-patch] Missing ${packagePath}`);
  }
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (packageJson.version !== EXPECTED_OPENCLAW_VERSION) {
    throw new Error(
      `[openclaw-responses-compatible-fallback-patch] Expected OpenClaw ${EXPECTED_OPENCLAW_VERSION}, found ${String(packageJson.version)}`,
    );
  }
}

function patchRegistryContent(content) {
  if (content.includes(REGISTRY_PATCH_MARKER)) return { content, changed: false, matched: true };
  if (content.includes(REGISTRY_V2_MARKER)) {
    return {
      content: content
        .replace(REGISTRY_V2_MARKER, REGISTRY_PATCH_MARKER)
        .replace(LEGACY_PROVIDER_SET, CURRENT_PROVIDER_SET),
      changed: true,
      matched: true,
    };
  }
  if (!content.includes(REGISTRY_STREAM_ANCHOR)) return { content, changed: false, matched: false };
  if (countOccurrences(content, REGISTRY_STREAM_ANCHOR) !== 1) {
    throw new Error('[openclaw-responses-compatible-fallback-patch] Registry anchor matched more than once');
  }
  return {
    content: content.replace(REGISTRY_STREAM_ANCHOR, REGISTRY_STREAM_PATCH),
    changed: true,
    matched: true,
  };
}

function patchTransportContent(content) {
  if (content.includes(TRANSPORT_PATCH_MARKER)) return { content, changed: false, matched: true };
  if (content.includes(TRANSPORT_V2_MARKER)) {
    return {
      content: content
        .replace(TRANSPORT_V2_MARKER, TRANSPORT_PATCH_MARKER)
        .replace(LEGACY_PROVIDER_SET, CURRENT_PROVIDER_SET),
      changed: true,
      matched: true,
    };
  }
  const startIndex = content.indexOf(TRANSPORT_FUNCTION_START);
  if (startIndex === -1) return { content, changed: false, matched: false };
  if (countOccurrences(content, TRANSPORT_FUNCTION_START) !== 1) {
    throw new Error('[openclaw-responses-compatible-fallback-patch] Transport function matched more than once');
  }
  const endIndex = content.indexOf(TRANSPORT_FUNCTION_END, startIndex);
  if (endIndex === -1) {
    throw new Error('[openclaw-responses-compatible-fallback-patch] Transport function end anchor not found');
  }
  if (!content.includes('function createOpenAICompletionsTransportStreamFn() {')) {
    throw new Error('[openclaw-responses-compatible-fallback-patch] Compatible transport function not found');
  }

  let target = content.slice(startIndex, endIndex);
  for (const [anchor, replacement, label] of [
    [TRANSPORT_FUNCTION_START, `${TRANSPORT_HELPERS}${TRANSPORT_FUNCTION_START}`, 'transport helpers'],
    [TRANSPORT_STREAM_ANCHOR, TRANSPORT_STREAM_PATCH, 'transport start state'],
    [TRANSPORT_START_EVENT_ANCHOR, TRANSPORT_START_EVENT_PATCH, 'transport start event'],
    [TRANSPORT_ERROR_ANCHOR, TRANSPORT_ERROR_PATCH, 'transport error handler'],
  ]) {
    if (countOccurrences(target, anchor) !== 1) {
      throw new Error(`[openclaw-responses-compatible-fallback-patch] Expected one ${label} anchor`);
    }
    target = target.replace(anchor, replacement);
  }
  return {
    content: `${content.slice(0, startIndex)}${target}${content.slice(endIndex)}`,
    changed: true,
    matched: true,
  };
}

export function patchOpenClawResponsesCompatibleFallbackRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-responses-compatible-fallback-patch] Missing dist directory: ${distDir}`);
  }
  assertExpectedOpenClawVersion(distDir);

  let registryMatches = 0;
  let transportMatches = 0;
  const pendingWrites = [];
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith('.js')) continue;
    const filePath = join(distDir, file);
    const original = readFileSync(filePath, 'utf8');
    const registry = patchRegistryContent(original);
    if (registry.matched) registryMatches++;
    const transport = patchTransportContent(registry.content);
    if (transport.matched) transportMatches++;
    if (registry.changed || transport.changed) {
      pendingWrites.push({ file, filePath, content: transport.content });
    }
  }

  if (registryMatches !== 1 || transportMatches !== 1) {
    throw new Error(
      `[openclaw-responses-compatible-fallback-patch] Expected one registry and one transport target, found registry=${registryMatches} transport=${transportMatches}`,
    );
  }

  for (const write of pendingWrites) {
    writeFileSync(write.filePath, write.content, 'utf8');
    logger.log?.(`[openclaw-responses-compatible-fallback-patch] Patched: ${write.file}`);
  }
  logger.log?.(
    `[openclaw-responses-compatible-fallback-patch] Ready. Changed ${pendingWrites.length} file(s).`,
  );
  return {
    patchedFiles: pendingWrites.length,
    registryMatches,
    transportMatches,
    distDir,
  };
}

export function patchInstalledOpenClawResponsesCompatibleFallbackRuntime(
  cwd = process.cwd(),
  options = {},
) {
  return patchOpenClawResponsesCompatibleFallbackRuntime(
    join(cwd, 'node_modules', 'openclaw', 'dist'),
    options,
  );
}
