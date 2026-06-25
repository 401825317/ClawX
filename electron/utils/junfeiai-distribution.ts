export const JUNFEIAI_PROVIDER_ID = 'lingzhiwuxian';
export const JUNFEIAI_PROVIDER_NAME = '零至无限';
export const JUNFEIAI_PRODUCTION_ORIGIN = 'https://zz-cn.lingzhiwuxian.com';
export const JUNFEIAI_DEFAULT_MODEL = 'smart-latest';
export const JUNFEIAI_DEFAULT_API_PROTOCOL = 'openai-completions';
export const JUNFEIAI_AUTH_ACCOUNT_ID = 'lingzhiwuxian-auth';

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
  return JUNFEIAI_PRODUCTION_ORIGIN;
}

export function getJunFeiAIDefaultBaseUrl(): string {
  return `${getJunFeiAIDefaultOrigin()}/v1`;
}

export function isJunFeiAIDevOverrideEnabled(): boolean {
  return Boolean(process.env.VITE_DEV_SERVER_URL);
}

function getDevEnvOverride(...keys: string[]): string {
  if (!isJunFeiAIDevOverrideEnabled()) {
    return '';
  }
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return '';
}

export function getJunFeiAIBackendOrigin(): string {
  return normalizeOrigin(
    getDevEnvOverride('CLAWX_JUNFEIAI_BACKEND_ORIGIN', 'CLAWX_JUNFEIAI_ORIGIN')
      || getJunFeiAIDefaultOrigin(),
  );
}

export function getJunFeiAIProviderBaseUrl(): string {
  return normalizeProviderBaseUrl(
    getDevEnvOverride('CLAWX_JUNFEIAI_PROVIDER_BASE_URL', 'CLAWX_JUNFEIAI_BASE_URL')
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
