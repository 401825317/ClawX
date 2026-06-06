export const JUNFEIAI_PROVIDER_ID = 'junfeiai';
export const JUNFEIAI_PROVIDER_NAME = 'JunFeiAI';
export const JUNFEIAI_DEVELOPMENT_ORIGIN = 'https://junfeiai.com';
export const JUNFEIAI_PRODUCTION_ORIGIN = 'https://zz-cn.lingzhiwuxian.com';
export const JUNFEIAI_DEFAULT_MODEL = 'gpt-5.5';
export const JUNFEIAI_DEFAULT_API_PROTOCOL = 'anthropic-messages';
export const JUNFEIAI_AUTH_ACCOUNT_ID = 'junfeiai-auth';

function isDevelopmentRuntime(): boolean {
  return process.env.NODE_ENV === 'development' || Boolean(process.env.VITE_DEV_SERVER_URL);
}

function normalizeOrigin(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, '');
}

function normalizeProviderBaseUrl(value: string): string {
  const normalized = normalizeOrigin(value);
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

function getJunFeiAIDefaultOrigin(): string {
  return isDevelopmentRuntime()
    ? JUNFEIAI_DEVELOPMENT_ORIGIN
    : JUNFEIAI_PRODUCTION_ORIGIN;
}

export function getJunFeiAIDefaultBaseUrl(): string {
  return `${getJunFeiAIDefaultOrigin()}/v1`;
}

export function getJunFeiAIBackendOrigin(): string {
  return normalizeOrigin(
    process.env.CLAWX_JUNFEIAI_BACKEND_ORIGIN
      || process.env.CLAWX_JUNFEIAI_ORIGIN
      || getJunFeiAIDefaultOrigin(),
  );
}

export function getJunFeiAIProviderBaseUrl(): string {
  return normalizeProviderBaseUrl(
    process.env.CLAWX_JUNFEIAI_PROVIDER_BASE_URL
      || process.env.CLAWX_JUNFEIAI_BASE_URL
      || `${getJunFeiAIBackendOrigin()}/v1`,
  );
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
