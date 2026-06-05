export const JUNFEIAI_PROVIDER_ID = 'junfeiai';
export const JUNFEIAI_PROVIDER_NAME = 'JunFeiAI';
export const JUNFEIAI_DEFAULT_ORIGIN = 'https://junfeiai.com';
export const JUNFEIAI_DEFAULT_BASE_URL = `${JUNFEIAI_DEFAULT_ORIGIN}/v1`;
export const JUNFEIAI_DEFAULT_MODEL = 'gpt-5.5';
export const JUNFEIAI_DEFAULT_API_PROTOCOL = 'anthropic-messages';
export const JUNFEIAI_AUTH_ACCOUNT_ID = 'junfeiai-auth';

export function getJunFeiAIOrigin(): string {
  return (process.env.CLAWX_JUNFEIAI_ORIGIN || JUNFEIAI_DEFAULT_ORIGIN)
    .trim()
    .replace(/\/+$/, '');
}

export function isJunFeiAIManagedDistribution(): boolean {
  if (process.env.CLAWX_E2E === '1') {
    return false;
  }
  return process.env.CLAWX_MANAGED_PROVIDER !== '0';
}
