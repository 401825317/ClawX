import type { ManagedAuthStatus, ManagedAuthUser } from '@shared/managed-auth';

export type ManagedAuthStateKey =
  | 'ready'
  | 'offlineGrace'
  | 'checking'
  | 'loggedOut'
  | 'loginExpired'
  | 'activationRequired'
  | 'relayMissing'
  | 'unmanaged'
  | 'error';

export const MANAGED_AUTH_BRAND = 'UClaw';

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function pickString(source: Record<string, unknown> | null | undefined, keys: string[]): string {
  if (!source) return '';
  for (const key of keys) {
    const value = stringValue(source[key]);
    if (value) return value;
  }
  return '';
}

export function isManagedActivationRequired(status: ManagedAuthStatus | null | undefined): boolean {
  return status?.managed !== false
    && status?.activationRequired === true
    && status.deviceActivated !== true;
}

export function isManagedAuthReady(status: ManagedAuthStatus | null | undefined): boolean {
  if (status?.managed === false) return true;
  return Boolean(status?.authValid)
    && Boolean(status?.hasRelayToken)
    && !isManagedActivationRequired(status);
}

export function isManagedAuthLocallyReady(status: ManagedAuthStatus | null | undefined): boolean {
  if (status?.managed === false) return true;
  return Boolean(status?.localOnly)
    && Boolean(status?.hasAuthToken || status?.hasRefreshToken)
    && Boolean(status?.hasRelayToken)
    && !isManagedActivationRequired(status);
}

export function isManagedAuthRecoverableLocalSession(
  status: ManagedAuthStatus | null | undefined,
): boolean {
  if (status?.managed === false) return true;
  return Boolean(status?.hasRefreshToken)
    && Boolean(status?.hasRelayToken)
    && (status?.offlineGraceExpiresAt ?? 0) > Date.now()
    && !isManagedActivationRequired(status);
}

export function getManagedAuthUser(
  status: ManagedAuthStatus | null | undefined,
): ManagedAuthUser | null {
  return status?.user ?? status?.auth?.user ?? null;
}

export function getManagedAuthDisplayName(
  status: ManagedAuthStatus | null | undefined,
  fallback = '',
): string {
  const user = getManagedAuthUser(status);
  return pickString(user, ['displayName', 'username', 'email', 'id']) || fallback;
}

export function getManagedAuthUserEmail(status: ManagedAuthStatus | null | undefined): string {
  return pickString(getManagedAuthUser(status), ['email']);
}

export function getManagedAuthStateKey(
  status: ManagedAuthStatus | null | undefined,
  options: { loading?: boolean; error?: string | null } = {},
): ManagedAuthStateKey {
  if (!status) return options.error ? 'error' : 'checking';
  if (status.managed === false) return 'unmanaged';
  if (isManagedAuthLocallyReady(status) || isManagedAuthRecoverableLocalSession(status)) {
    return status.localOnly ? 'offlineGrace' : 'ready';
  }
  if (options.error) return 'error';
  if (isManagedAuthReady(status)) return 'ready';
  if (!status.hasAuthToken && !status.hasRefreshToken) return 'loggedOut';
  if (status.authRejected || !status.authValid) return 'loginExpired';
  if (isManagedActivationRequired(status)) return 'activationRequired';
  if (!status.hasRelayToken) return 'relayMissing';
  return options.loading ? 'checking' : 'error';
}
