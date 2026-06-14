export type ManagedAuthUser = Record<string, unknown> & {
  id?: string | number;
  userId?: string | number;
  user_id?: string | number;
  email?: string;
  username?: string;
  displayName?: string;
  display_name?: string;
  name?: string;
};

export type ManagedAuthStatus = {
  managed?: boolean;
  hasRelayToken?: boolean;
  hasAuthToken?: boolean;
  authValid?: boolean;
  authRejected?: boolean;
  authError?: string;
  deviceActivated?: boolean;
  activationRequired?: boolean;
  source?: 'remote' | 'fallback' | 'provided';
  bootstrap?: {
    service?: {
      name?: string;
      displayName?: string;
      apiOrigin?: string;
    };
    auth?: {
      registrationEnabled?: boolean;
      emailVerifyEnabled?: boolean;
      loginEnabled?: boolean;
      activationRequired?: boolean;
    };
    runtime?: {
      baseUrl?: string;
      defaultModel?: string;
    };
    offline?: {
      graceSeconds?: number;
    };
  };
  auth?: {
    user?: ManagedAuthUser | null;
  };
};

export type ManagedAuthStateKey =
  | 'ready'
  | 'checking'
  | 'loggedOut'
  | 'loginExpired'
  | 'activationRequired'
  | 'relayMissing'
  | 'unmanaged'
  | 'error';

function stringValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

function pickString(source: Record<string, unknown> | null | undefined, keys: string[]): string {
  if (!source) {
    return '';
  }
  for (const key of keys) {
    const value = stringValue(source[key]);
    if (value) {
      return value;
    }
  }
  return '';
}

export function isManagedActivationRequired(status: ManagedAuthStatus | null | undefined): boolean {
  if (!status || status.managed === false) {
    return false;
  }
  return (status.activationRequired ?? status.bootstrap?.auth?.activationRequired) === true
    && status.deviceActivated !== true;
}

export function isManagedAuthReady(status: ManagedAuthStatus | null | undefined): boolean {
  if (status?.managed === false) {
    return true;
  }
  return Boolean(status?.hasRelayToken)
    && Boolean(status?.authValid)
    && !isManagedActivationRequired(status);
}

export function getManagedAuthUser(status: ManagedAuthStatus | null | undefined): ManagedAuthUser | null {
  return status?.auth?.user ?? null;
}

export function getManagedAuthDisplayName(
  status: ManagedAuthStatus | null | undefined,
  fallback = '',
): string {
  const user = getManagedAuthUser(status);
  return pickString(user, ['displayName', 'display_name', 'username', 'email', 'name', 'userId', 'user_id', 'id'])
    || fallback;
}

export function getManagedAuthUserEmail(status: ManagedAuthStatus | null | undefined): string {
  return pickString(getManagedAuthUser(status), ['email']);
}

export function getManagedAuthServiceName(status: ManagedAuthStatus | null | undefined): string {
  return status?.bootstrap?.service?.displayName
    || status?.bootstrap?.service?.name
    || '';
}

export function getManagedAuthStateKey(
  status: ManagedAuthStatus | null | undefined,
  options: { loading?: boolean; error?: string | null } = {},
): ManagedAuthStateKey {
  if (!status) {
    return 'checking';
  }
  if (options.error) {
    return 'error';
  }
  if (status?.managed === false) {
    return 'unmanaged';
  }
  if (isManagedAuthReady(status)) {
    return 'ready';
  }
  if (!status?.hasAuthToken) {
    return 'loggedOut';
  }
  if (status.authRejected || !status.authValid) {
    return 'loginExpired';
  }
  if (isManagedActivationRequired(status)) {
    return 'activationRequired';
  }
  return 'relayMissing';
}
