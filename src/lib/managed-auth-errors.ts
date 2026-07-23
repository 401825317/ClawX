export type ManagedAuthErrorKey =
  | 'invalid_credentials'
  | 'missing_credentials'
  | 'device_authorization_required'
  | 'activation_invalid'
  | 'activation_consumed'
  | 'activation_expired'
  | 'activation_ticket_expired'
  | 'activation_device_mismatch'
  | 'registration_disabled'
  | 'login_disabled'
  | 'password_policy'
  | 'invalid_email'
  | 'email_taken'
  | 'verification_invalid'
  | 'device_required'
  | 'user_exists'
  | 'invalid_username'
  | 'auth_in_progress'
  | 'provider_conflict'
  | 'AUTH_INVALID'
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'PERMISSION'
  | 'NETWORK'
  | 'CONFIG'
  | 'UNKNOWN';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const KNOWN_CODES = new Set<ManagedAuthErrorKey>([
  'invalid_credentials',
  'missing_credentials',
  'device_authorization_required',
  'activation_invalid',
  'activation_consumed',
  'activation_expired',
  'activation_ticket_expired',
  'activation_device_mismatch',
  'registration_disabled',
  'login_disabled',
  'password_policy',
  'invalid_email',
  'email_taken',
  'verification_invalid',
  'device_required',
  'user_exists',
  'invalid_username',
  'auth_in_progress',
  'provider_conflict',
  'AUTH_INVALID',
  'TIMEOUT',
  'RATE_LIMIT',
  'PERMISSION',
  'NETWORK',
  'CONFIG',
  'UNKNOWN',
]);

const CODE_ALIASES: Record<string, ManagedAuthErrorKey> = {
  auth_invalid: 'invalid_credentials',
  activation_required: 'device_authorization_required',
  permission_denied: 'PERMISSION',
  network_error: 'NETWORK',
  timeout: 'TIMEOUT',
  rate_limit: 'RATE_LIMIT',
  config_error: 'CONFIG',
};

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function explicitCode(error: unknown): string {
  if (typeof error === 'string') return error.trim();
  if (!error || typeof error !== 'object') return '';
  const record = error as Record<string, unknown>;
  return stringValue(record.errorCode)
    || stringValue(record.code)
    || stringValue(record.authErrorCode);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
}

export function getManagedAuthErrorKey(error: unknown): ManagedAuthErrorKey {
  const code = explicitCode(error);
  if (KNOWN_CODES.has(code as ManagedAuthErrorKey)) return code as ManagedAuthErrorKey;
  if (CODE_ALIASES[code]) return CODE_ALIASES[code];

  const message = errorMessage(error).toLowerCase();
  for (const knownCode of KNOWN_CODES) {
    if (knownCode !== 'UNKNOWN' && message.includes(knownCode.toLowerCase())) return knownCode;
  }
  for (const [alias, key] of Object.entries(CODE_ALIASES)) {
    if (message.includes(alias)) return key;
  }
  if (message.includes('401') || message.includes('unauthorized')) return 'AUTH_INVALID';
  if (message.includes('429') || message.includes('too many requests')) return 'RATE_LIMIT';
  if (message.includes('403') || message.includes('forbidden')) return 'PERMISSION';
  if (message.includes('timed out') || message.includes('timeout')) return 'TIMEOUT';
  if (
    message.includes('network')
    || message.includes('fetch')
    || message.includes('econnrefused')
    || message.includes('econnreset')
    || message.includes('enotfound')
  ) {
    return 'NETWORK';
  }
  return 'UNKNOWN';
}

export function isManagedDeviceAuthorizationRequired(error: unknown): boolean {
  return getManagedAuthErrorKey(error) === 'device_authorization_required';
}

export function getManagedAuthErrorMessage(t: Translate, error: unknown): string {
  return t(`auth.errors.${getManagedAuthErrorKey(error)}`);
}
