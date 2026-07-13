import endpoints from './junfeiai-endpoints.json';

const VALID_DEFAULT_THINKING_LEVELS = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

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

if (!VALID_DEFAULT_THINKING_LEVELS.has(endpoints.defaultThinkingLevel)) {
  throw new Error('defaultThinkingLevel in shared/junfeiai-endpoints.json must be a supported thinking level');
}

/** Shared default thinking level for managed JunFeiAI chat. */
export const JUNFEIAI_DEFAULT_THINKING_LEVEL = endpoints.defaultThinkingLevel;
