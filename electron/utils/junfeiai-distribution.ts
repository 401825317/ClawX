import {
  JUNFEIAI_PRODUCTION_ORIGIN as productionOrigin,
  JUNFEIAI_PRODUCTION_PROVIDER_BASE_URL,
} from '../../shared/junfeiai-endpoints';

export {
  JUNFEIAI_DEFAULT_API_PROTOCOL,
  JUNFEIAI_DEFAULT_MODEL_CONTEXT_WINDOW,
  JUNFEIAI_DEFAULT_THINKING_LEVEL,
  JUNFEIAI_IMAGE_GENERATION_TIMEOUT_MS,
  JUNFEIAI_MEDIA_GENERATION_CLIENT_TIMEOUT_BUFFER_MS,
  JUNFEIAI_MEDIA_GENERATION_TEST_TIMEOUT_MS,
  JUNFEIAI_OPENCLAW_EXEC_ASK,
  JUNFEIAI_OPENCLAW_EXEC_SECURITY,
  JUNFEIAI_OPENCLAW_MAX_ACTIVE_TRANSCRIPT_BYTES,
  JUNFEIAI_OPENCLAW_MID_TURN_PRECHECK_ENABLED,
  JUNFEIAI_OPENCLAW_TEXT_FAILOVER,
  JUNFEIAI_OPENCLAW_TEXT_FAILOVER_MODEL_REF,
  JUNFEIAI_OPENCLAW_TRUNCATE_AFTER_COMPACTION,
  JUNFEIAI_VIDEO_GENERATION_POLL_INTERVAL_MS,
  JUNFEIAI_VIDEO_GENERATION_DEFAULT_RESOLUTION,
  JUNFEIAI_VIDEO_GENERATION_DEFAULT_SIZE,
  JUNFEIAI_VIDEO_GENERATION_DEFAULT_SIZES,
  JUNFEIAI_VIDEO_GENERATION_TIMEOUT_MS,
} from '../../shared/junfeiai-endpoints';

export const JUNFEIAI_PROVIDER_ID = 'lingzhiwuxian';
export const JUNFEIAI_PROVIDER_NAME = '零至无限';
export const JUNFEIAI_PRODUCTION_ORIGIN = productionOrigin;
export const JUNFEIAI_DEFAULT_MODEL = 'smart-latest';
export const JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID = 'openai';
export const JUNFEIAI_MANAGED_OPENAI_API_PROTOCOL = 'openai-responses';
export const JUNFEIAI_PROVIDER_TIMEOUT_SECONDS = 300;
export const JUNFEIAI_AUTH_ACCOUNT_ID = 'lingzhiwuxian-auth';
export const JUNFEIAI_RUNTIME_CONTRACT_VERSION = 5;

export function normalizeJunFeiAIModelContextWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function getJunFeiAIDefaultBaseUrl(): string {
  return JUNFEIAI_PRODUCTION_PROVIDER_BASE_URL;
}

export function getJunFeiAIBackendOrigin(): string {
  return JUNFEIAI_PRODUCTION_ORIGIN;
}

export function getJunFeiAIProviderBaseUrl(): string {
  return JUNFEIAI_PRODUCTION_PROVIDER_BASE_URL;
}

export function getJunFeiAIOrigin(): string {
  return getJunFeiAIBackendOrigin();
}

export function isJunFeiAIManagedDistribution(): boolean {
  if (process.env.CLAWX_MANAGED_PROVIDER === '1') {
    return true;
  }
  if (process.env.CLAWX_MANAGED_PROVIDER === '0') {
    return false;
  }
  if (process.env.CLAWX_E2E === '1') {
    return false;
  }
  return true;
}
