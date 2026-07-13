import endpoints from './junfeiai-endpoints.json';

/** Shared production endpoints for JunFeiAI consumers in both Electron processes. */
export const JUNFEIAI_PRODUCTION_ORIGIN = endpoints.productionOrigin.replace(/\/+$/, '');
export const JUNFEIAI_PRODUCTION_PROVIDER_BASE_URL = `${JUNFEIAI_PRODUCTION_ORIGIN}/v1`;

if (endpoints.defaultApiProtocol !== 'openai-responses' && endpoints.defaultApiProtocol !== 'openai-completions') {
  throw new Error('defaultApiProtocol in shared/junfeiai-endpoints.json must be an OpenAI protocol');
}

/** Shared API protocol for the managed text provider. */
export const JUNFEIAI_DEFAULT_API_PROTOCOL = endpoints.defaultApiProtocol;

if (!Number.isInteger(endpoints.defaultModelContextWindow) || endpoints.defaultModelContextWindow <= 0) {
  throw new Error('defaultModelContextWindow in shared/junfeiai-endpoints.json must be a positive integer');
}

/** Shared default model context window, measured in tokens. */
export const JUNFEIAI_DEFAULT_MODEL_CONTEXT_WINDOW = endpoints.defaultModelContextWindow;

/** Normalize an Origin before deriving JunFeiAI API endpoints from it. */
export function normalizeJunFeiAIOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** Convert an Origin or provider URL to the canonical OpenAI-compatible base URL. */
export function toJunFeiAIProviderBaseUrl(value: string): string {
  const normalized = normalizeJunFeiAIOrigin(value);
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}
