import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const EXPECTED_OPENCLAW_VERSION = '2026.6.11';
const REGISTRY_MARKER = 'UCLAW_OPENAI_RESPONSES_COMPATIBLE_FALLBACK_VERSION = 2';
const TRANSPORT_MARKER = 'UCLAW_OPENAI_RESPONSES_TRANSPORT_COMPATIBLE_FALLBACK_VERSION = 2';

const REGISTRY_ANCHOR = `const streamOpenAICompletions = createLazyStream(loadOpenAICompletionsProviderModule);
const streamSimpleOpenAICompletions = createLazySimpleStream(loadOpenAICompletionsProviderModule);
const streamOpenAIResponses = createLazyStream(loadOpenAIResponsesProviderModule);
const streamSimpleOpenAIResponses = createLazySimpleStream(loadOpenAIResponsesProviderModule);`;

const REGISTRY_PATCH = `const streamOpenAICompletions = createLazyStream(loadOpenAICompletionsProviderModule);
const streamSimpleOpenAICompletions = createLazySimpleStream(loadOpenAICompletionsProviderModule);
const UCLAW_OPENAI_RESPONSES_COMPATIBLE_FALLBACK_VERSION = 2;
const UCLAW_OPENAI_RESPONSES_COMPATIBLE_FALLBACK_ERROR_PREFIX = "OpenAI API error (404):";
const UCLAW_OPENAI_RESPONSES_COMPATIBLE_FALLBACK_PROVIDERS = /* @__PURE__ */ new Set(["openai", "lingzhiwuxian"]);
function shouldUclawFallbackOpenAIResponsesEvent(model, options, event, responseStarted) {
	return !responseStarted && !options?.signal?.aborted && UCLAW_OPENAI_RESPONSES_COMPATIBLE_FALLBACK_PROVIDERS.has(model.provider) && event?.type === "error" && typeof event.error?.errorMessage === "string" && event.error.errorMessage.startsWith(UCLAW_OPENAI_RESPONSES_COMPATIBLE_FALLBACK_ERROR_PREFIX);
}
function createUclawOpenAIResponsesCompatibleFallbackStream(loadResponsesModule, simple) {
	return (model, context, options) => {
		const outer = new AssistantMessageEventStream();
		(async () => {
			try {
				const responsesModule = await loadResponsesModule();
				const responsesStream = simple ? responsesModule.streamSimple(model, context, options) : responsesModule.stream(model, context, options);
				let responseStarted = false;
				for await (const event of responsesStream) {
					if (event?.type === "start") responseStarted = true;
					if (!shouldUclawFallbackOpenAIResponsesEvent(model, options, event, responseStarted)) {
						outer.push(event);
						continue;
					}
					const completionsModule = await loadOpenAICompletionsProviderModule();
					const fallbackModel = { ...model, api: "openai-completions" };
					const fallbackStream = simple ? completionsModule.streamSimple(fallbackModel, context, options) : completionsModule.stream(fallbackModel, context, options);
					for await (const fallbackEvent of fallbackStream) outer.push(fallbackEvent);
					outer.end();
					return;
				}
				outer.end();
			} catch (error) {
				const message = createLazyLoadErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			}
		})();
		return outer;
	};
}
const streamOpenAIResponses = createUclawOpenAIResponsesCompatibleFallbackStream(loadOpenAIResponsesProviderModule, false);
const streamSimpleOpenAIResponses = createUclawOpenAIResponsesCompatibleFallbackStream(loadOpenAIResponsesProviderModule, true);`;

const TRANSPORT_FUNCTION_START = 'function createOpenAIResponsesTransportStreamFn() {';
const TRANSPORT_FUNCTION_END = '\nfunction resolveCacheRetention(cacheRetention) {';
const TRANSPORT_STREAM_ANCHOR = `		const eventStream = createAssistantMessageEventStream();
		const stream = eventStream;
		(async () => {`;
const TRANSPORT_STREAM_PATCH = `		const eventStream = createAssistantMessageEventStream();
		const stream = eventStream;
		let uclawResponsesStarted = false;
		(async () => {`;
const TRANSPORT_START_ANCHOR = `				stream.push({
					type: "start",
					partial: output
				});`;
const TRANSPORT_START_PATCH = `				uclawResponsesStarted = true;
				stream.push({
					type: "start",
					partial: output
				});`;
const TRANSPORT_ERROR_ANCHOR = `			} catch (error) {
				log.warn(\`[responses] error provider=\${model.provider} api=\${model.api} model=\${model.id} \` + summarizeOpenAITransportError(error));
				assignTransportErrorDetails(output, error, options?.signal);
				stream.push({
					type: "error",
					reason: output.stopReason,
					error: output
				});
				stream.end();
			}`;
const TRANSPORT_ERROR_PATCH = `			} catch (error) {
				if (shouldUclawFallbackOpenAIResponsesTransport(model, options, error, uclawResponsesStarted)) {
					try {
						const fallbackModel = { ...model, api: "openai-completions" };
						const fallbackStream = createOpenAICompletionsTransportStreamFn()(fallbackModel, context, options);
						for await (const fallbackEvent of fallbackStream) stream.push(fallbackEvent);
						stream.end();
						return;
					} catch (fallbackError) {
						error = fallbackError;
					}
				}
				log.warn(\`[responses] error provider=\${model.provider} api=\${model.api} model=\${model.id} \` + summarizeOpenAITransportError(error));
				assignTransportErrorDetails(output, error, options?.signal);
				stream.push({
					type: "error",
					reason: output.stopReason,
					error: output
				});
				stream.end();
			}`;
const TRANSPORT_HELPERS = `const UCLAW_OPENAI_RESPONSES_TRANSPORT_COMPATIBLE_FALLBACK_VERSION = 2;
const UCLAW_OPENAI_RESPONSES_TRANSPORT_COMPATIBLE_FALLBACK_PROVIDERS = /* @__PURE__ */ new Set(["openai", "lingzhiwuxian"]);
function isUclawOpenAIResponsesTransport404(error) {
	if (!error || typeof error !== "object") return false;
	const status = error.status ?? error.statusCode ?? error.response?.status;
	return status === 404 || status === "404";
}
function shouldUclawFallbackOpenAIResponsesTransport(model, options, error, responseStarted) {
	return !responseStarted && !options?.signal?.aborted && UCLAW_OPENAI_RESPONSES_TRANSPORT_COMPATIBLE_FALLBACK_PROVIDERS.has(model.provider) && isUclawOpenAIResponsesTransport404(error);
}
`;

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function assertExpectedOpenClawVersion(distDir) {
  const packagePath = join(distDir, '..', 'package.json');
  if (!existsSync(packagePath)) throw new Error(`[responses-compatible-fallback] Missing ${packagePath}`);
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (packageJson.version !== EXPECTED_OPENCLAW_VERSION) {
    throw new Error(`[responses-compatible-fallback] Expected OpenClaw ${EXPECTED_OPENCLAW_VERSION}, found ${String(packageJson.version)}`);
  }
}

function patchRegistryContent(content) {
  if (content.includes(REGISTRY_MARKER)) return { content, changed: false, matched: true };
  if (countOccurrences(content, REGISTRY_ANCHOR) !== 1) return { content, changed: false, matched: false };
  return { content: content.replace(REGISTRY_ANCHOR, REGISTRY_PATCH), changed: true, matched: true };
}

function patchTransportContent(content) {
  if (content.includes(TRANSPORT_MARKER)) return { content, changed: false, matched: true };
  const start = content.indexOf(TRANSPORT_FUNCTION_START);
  const end = content.indexOf(TRANSPORT_FUNCTION_END, start);
  if (start === -1 || end === -1 || !content.includes('function createOpenAICompletionsTransportStreamFn() {')) {
    return { content, changed: false, matched: false };
  }
  let target = content.slice(start, end);
  for (const [anchor, replacement, label] of [
    [TRANSPORT_FUNCTION_START, `${TRANSPORT_HELPERS}${TRANSPORT_FUNCTION_START}`, 'transport helpers'],
    [TRANSPORT_STREAM_ANCHOR, TRANSPORT_STREAM_PATCH, 'transport start state'],
    [TRANSPORT_START_ANCHOR, TRANSPORT_START_PATCH, 'transport start event'],
    [TRANSPORT_ERROR_ANCHOR, TRANSPORT_ERROR_PATCH, 'transport error handler'],
  ]) {
    if (countOccurrences(target, anchor) !== 1) {
      throw new Error(`[responses-compatible-fallback] Missing ${label} anchor`);
    }
    target = target.replace(anchor, replacement);
  }
  return {
    content: `${content.slice(0, start)}${target}${content.slice(end)}`,
    changed: true,
    matched: true,
  };
}

export function patchOpenClawResponsesCompatibleFallbackRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  if (!existsSync(distDir)) throw new Error(`[responses-compatible-fallback] Missing dist directory: ${distDir}`);
  assertExpectedOpenClawVersion(distDir);
  let registryMatches = 0;
  let transportMatches = 0;
  let patchedFiles = 0;
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith('.js')) continue;
    const filePath = join(distDir, file);
    const original = readFileSync(filePath, 'utf8');
    const registry = patchRegistryContent(original);
    if (registry.matched) registryMatches += 1;
    const transport = patchTransportContent(registry.content);
    if (transport.matched) transportMatches += 1;
    if (registry.changed || transport.changed) {
      writeFileSync(filePath, transport.content, 'utf8');
      patchedFiles += 1;
      logger.log?.(`[responses-compatible-fallback] Patched: ${file}`);
    }
  }
  if (registryMatches !== 1 || transportMatches !== 1) {
    throw new Error(`[responses-compatible-fallback] Expected one registry and transport target, found registry=${registryMatches} transport=${transportMatches}`);
  }
  return { patchedFiles, registryMatches, transportMatches, distDir };
}

export function patchInstalledOpenClawResponsesCompatibleFallbackRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawResponsesCompatibleFallbackRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
