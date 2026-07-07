import { AppError, normalizeAppError, type AppErrorCode } from '@/lib/error-model';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const BACKEND_CODE_TO_KEY: Record<string, string> = {
  invalid_credentials: 'invalid_credentials',
  auth_invalid: 'invalid_credentials',
  missing_credentials: 'missing_credentials',
  device_authorization_required: 'device_authorization_required',
  activation_required: 'device_authorization_required',
  activation_invalid: 'activation_invalid',
  activation_consumed: 'activation_consumed',
  activation_expired: 'activation_expired',
  activation_ticket_expired: 'activation_ticket_expired',
  activation_device_mismatch: 'activation_device_mismatch',
  registration_disabled: 'registration_disabled',
  login_disabled: 'login_disabled',
  password_policy: 'password_policy',
  invalid_username: 'invalid_username',
  invalid_email: 'invalid_email',
  email_taken: 'email_taken',
  verification_invalid: 'verification_invalid',
  device_required: 'device_required',
  user_exists: 'user_exists',
  permission_denied: 'PERMISSION',
};

const APP_CODE_TO_KEY: Record<AppErrorCode, string> = {
  AUTH_INVALID: 'invalid_credentials',
  ACTIVATION_INVALID: 'activation_invalid',
  ACTIVATION_EXPIRED: 'activation_expired',
  DEVICE_AUTH_REQUIRED: 'device_authorization_required',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMIT: 'RATE_LIMIT',
  PERMISSION: 'PERMISSION',
  CHANNEL_UNAVAILABLE: 'NETWORK',
  NETWORK: 'NETWORK',
  CONFIG: 'CONFIG',
  GATEWAY: 'NETWORK',
  UNKNOWN: 'UNKNOWN',
};

function stringValue(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function payloadErrorCode(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const record = payload as Record<string, unknown>;
  return stringValue(record.code)
    || stringValue(record.errorCode)
    || stringValue(record.error_code);
}

export function getManagedAuthBackendCode(error: unknown): string {
  const appError = error instanceof AppError ? error : normalizeAppError(error);
  return stringValue(appError.details?.backendCode)
    || payloadErrorCode(appError.details?.payload)
    || '';
}

function inferManagedAuthErrorKey(message: string): string {
  const lower = message.toLowerCase();

  if (lower.includes('device_authorization_required') || lower.includes('activation_required')) {
    return 'device_authorization_required';
  }
  if (lower.includes('invalid_credentials') || message.includes('账号或密码错误')) {
    return 'invalid_credentials';
  }
  if (lower.includes('activation_expired') || message.includes('激活码已过期')) {
    return 'activation_expired';
  }
  if (lower.includes('activation_consumed') || message.includes('激活码已使用')) {
    return 'activation_consumed';
  }
  if (
    lower.includes('activation_invalid')
    || lower.includes('activation_ticket_expired')
    || lower.includes('activation_device_mismatch')
    || message.includes('激活码无效')
  ) {
    return 'activation_invalid';
  }
  if (lower.includes('email_taken') || message.includes('邮箱已被占用')) {
    return 'email_taken';
  }
  if (lower.includes('user_exists') || message.includes('用户已存在')) {
    return 'user_exists';
  }
  if (lower.includes('invalid_username') || message.includes('用户名格式错误')) {
    return 'invalid_username';
  }
  if (
    lower.includes('password_policy')
    || lower.includes('password length')
    || lower.includes('8-20')
    || message.includes('密码长度')
  ) {
    return 'password_policy';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'TIMEOUT';
  }
  if (
    lower.includes('network')
    || lower.includes('fetch')
    || lower.includes('econnrefused')
    || lower.includes('econnreset')
    || lower.includes('enotfound')
  ) {
    return 'NETWORK';
  }
  return '';
}

export function getManagedAuthErrorKey(error: unknown): string {
  const appError = error instanceof AppError ? error : normalizeAppError(error);
  const backendCode = getManagedAuthBackendCode(appError);
  if (backendCode && BACKEND_CODE_TO_KEY[backendCode]) {
    return BACKEND_CODE_TO_KEY[backendCode];
  }

  const inferred = inferManagedAuthErrorKey(appError.message);
  if (inferred) {
    return inferred;
  }

  return APP_CODE_TO_KEY[appError.code] || 'UNKNOWN';
}

export function isManagedDeviceAuthorizationRequired(error: unknown): boolean {
  return getManagedAuthErrorKey(error) === 'device_authorization_required';
}

export function getManagedAuthErrorMessage(t: Translate, error: unknown): string {
  return t(`auth.errors.${getManagedAuthErrorKey(error)}`, {
    defaultValue: t('auth.errors.UNKNOWN'),
  });
}
