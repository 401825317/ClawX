export const SUPERVISED_SYSTEMD_ENV_KEYS = [
  'OPENCLAW_SYSTEMD_UNIT',
  'INVOCATION_ID',
  'SYSTEMD_EXEC_PID',
  'JOURNAL_STREAM',
] as const;

export type GatewayEnv = Record<string, string | undefined>;

const UCLAW_MANAGED_PROVIDER_ENV_KEYS = [
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_API_KEYS',
  'OPENCLAW_LIVE_OPENAI_KEY',
] as const;
const UCLAW_MANAGED_PROVIDER_ENV_KEY_SET = new Set<string>(UCLAW_MANAGED_PROVIDER_ENV_KEYS);
const UCLAW_MANAGED_PROVIDER_ENV_PREFIXES = ['OPENAI_API_KEY_'] as const;

export const UCLAW_LOGIN_REQUIRED_PROVIDER_KEY = 'uclaw-login-required';

export type ManagedOpenAiProviderEnv = {
  providerEnv: Record<string, string>;
  loadedProviderKeyCount: number;
};

function isManagedProviderEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return UCLAW_MANAGED_PROVIDER_ENV_KEY_SET.has(normalized)
    || UCLAW_MANAGED_PROVIDER_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * OpenClaw CLI treats certain environment variables as systemd supervisor hints.
 * When present in ClawX-owned child-process launches, it can mistakenly enter
 * a supervised process retry loop. Strip those variables so startup follows
 * ClawX lifecycle.
 */
export function stripSystemdSupervisorEnv(env: GatewayEnv): GatewayEnv {
  const next = { ...env };
  for (const key of SUPERVISED_SYSTEMD_ENV_KEYS) {
    delete next[key];
  }
  return next;
}

/** Remove inherited OpenAI credentials before UClaw installs its canonical values. */
export function stripManagedProviderEnv(env: GatewayEnv, managedDistribution: boolean): GatewayEnv {
  if (!managedDistribution) return { ...env };
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (isManagedProviderEnvKey(key)) {
      delete next[key];
    }
  }
  return next;
}

/** Decide before secret lookup whether a Provider key may be injected. */
export function shouldInjectProviderEnv(envVar: string | undefined, managedDistribution: boolean): boolean {
  return typeof envVar === 'string'
    && envVar.length > 0
    && (!managedDistribution || !isManagedProviderEnvKey(envVar));
}

/** Pin OpenClaw's primary and rotation paths to one managed credential generation. */
export function buildManagedOpenAiProviderEnv(apiKey: string | null | undefined): ManagedOpenAiProviderEnv {
  const managedKey = apiKey?.trim() || UCLAW_LOGIN_REQUIRED_PROVIDER_KEY;
  return {
    providerEnv: Object.fromEntries(
      UCLAW_MANAGED_PROVIDER_ENV_KEYS.map((envVar) => [envVar, managedKey]),
    ),
    loadedProviderKeyCount: apiKey?.trim() ? 1 : 0,
  };
}
