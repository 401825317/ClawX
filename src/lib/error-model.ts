export type AppErrorCode =
  | 'AUTH_INVALID'
  | 'ACTIVATION_INVALID'
  | 'ACTIVATION_EXPIRED'
  | 'DEVICE_AUTH_REQUIRED'
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'PERMISSION'
  | 'CHANNEL_UNAVAILABLE'
  | 'NETWORK'
  | 'CONFIG'
  | 'GATEWAY'
  | 'UNKNOWN';

export class AppError extends Error {
  code: AppErrorCode;
  cause?: unknown;
  details?: Record<string, unknown>;

  constructor(code: AppErrorCode, message: string, cause?: unknown, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.details = details;
  }
}

export function mapBackendErrorCode(code?: string): AppErrorCode {
  switch (code) {
    case 'invalid_credentials':
    case 'auth_invalid':
      return 'AUTH_INVALID';
    case 'activation_invalid':
    case 'activation_consumed':
    case 'activation_ticket_expired':
    case 'activation_device_mismatch':
      return 'ACTIVATION_INVALID';
    case 'activation_expired':
      return 'ACTIVATION_EXPIRED';
    case 'device_authorization_required':
    case 'activation_required':
      return 'DEVICE_AUTH_REQUIRED';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'PERMISSION':
      return 'PERMISSION';
    case 'GATEWAY':
      return 'GATEWAY';
    case 'VALIDATION':
      return 'CONFIG';
    case 'UNSUPPORTED':
      return 'CHANNEL_UNAVAILABLE';
    default:
      return 'UNKNOWN';
  }
}

function classifyMessage(message: string): AppErrorCode {
  const lower = message.toLowerCase();

  if (
    lower.includes('invalid ipc channel')
    || lower.includes('no handler registered')
    || lower.includes('window is not defined')
    || lower.includes('unsupported')
  ) {
    return 'CHANNEL_UNAVAILABLE';
  }
  if (
    lower.includes('invalid authentication')
    || lower.includes('unauthorized')
    || lower.includes('auth failed')
    || lower.includes('invalid_credentials')
    || lower.includes('账号或密码错误')
    || lower.includes('401')
  ) {
    return 'AUTH_INVALID';
  }
  if (
    lower.includes('activation_expired')
    || lower.includes('激活码已过期')
  ) {
    return 'ACTIVATION_EXPIRED';
  }
  if (
    lower.includes('activation_invalid')
    || lower.includes('activation_consumed')
    || lower.includes('activation_ticket_expired')
    || lower.includes('activation_device_mismatch')
    || lower.includes('激活码无效')
  ) {
    return 'ACTIVATION_INVALID';
  }
  if (
    lower.includes('device_authorization_required')
    || lower.includes('activation_required')
  ) {
    return 'DEVICE_AUTH_REQUIRED';
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('abort')) {
    return 'TIMEOUT';
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return 'RATE_LIMIT';
  }
  if (
    lower.includes('permission')
    || lower.includes('forbidden')
    || lower.includes('denied')
    || lower.includes('403')
  ) {
    return 'PERMISSION';
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
  if (lower.includes('gateway')) {
    return 'GATEWAY';
  }
  if (lower.includes('config') || lower.includes('invalid') || lower.includes('validation') || lower.includes('400')) {
    return 'CONFIG';
  }

  return 'UNKNOWN';
}

export function normalizeAppError(err: unknown, details?: Record<string, unknown>): AppError {
  if (err instanceof AppError) {
    return new AppError(err.code, err.message, err.cause ?? err, { ...(err.details ?? {}), ...(details ?? {}) });
  }

  const message = err instanceof Error ? err.message : String(err);
  return new AppError(classifyMessage(message), message, err, details);
}
