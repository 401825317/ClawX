import type { HostApiContract } from '@shared/host-api/contract';
import type {
  ManagedAuthLoginPayload,
  ManagedAuthRegisterPayload,
  ManagedAuthVerificationCodePayload,
} from '@shared/managed-auth';
import type { GatewayManager } from '../gateway/manager';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import {
  checkManagedAuthActivation,
  getManagedAuthBootstrap,
  getManagedAuthLocalStatus,
  getManagedAuthStatus,
  loginManagedAuth,
  logoutManagedAuth,
  refreshManagedAuth,
  registerManagedAuth,
  sendManagedAuthVerificationCode,
  toManagedAuthError,
  verifyManagedAuth,
} from './managed-auth-service';
import { isRecord } from './payload-utils';

type ManagedAuthApiContext = {
  gatewayManager: GatewayManager;
};

type ManagedAuthPayload<Action extends keyof HostApiContract['managedAuth']> =
  Parameters<HostApiContract['managedAuth'][Action]>[0];

type StringFieldOptions = {
  required?: boolean;
  trim?: boolean;
  maxLength: number;
};

const SENSITIVE_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'relaytoken',
  'password',
  'ticket',
  'activationticket',
  'apikey',
  'secret',
]);
const ERROR_TEXT_KEYS = new Set(['message', 'error', 'autherror', 'gatewayreloaderror']);

function invalidPayload(action: keyof HostApiContract['managedAuth']): Error {
  return new Error(`Invalid managedAuth.${action} payload`);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code >= 0x7f && code <= 0x9f) return true;
  }
  return false;
}

function payloadRecord(
  payload: unknown,
  action: keyof HostApiContract['managedAuth'],
  optional = false,
): Record<string, unknown> {
  if (payload === undefined && optional) return {};
  if (!isRecord(payload)) throw invalidPayload(action);
  return payload;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  action: keyof HostApiContract['managedAuth'],
  options: StringFieldOptions,
): string | undefined {
  const value = record[key];
  if (value === undefined && !options.required) return undefined;
  if (typeof value !== 'string') throw invalidPayload(action);
  const normalized = options.trim === false ? value : value.trim();
  if ((options.required && normalized.length === 0)
    || normalized.length > options.maxLength
    || hasControlCharacter(normalized)) {
    throw invalidPayload(action);
  }
  return normalized;
}

function optionalBooleanPayload(
  payload: unknown,
  action: 'status' | 'verify' | 'refresh',
): { force?: boolean } {
  const record = payloadRecord(payload, action, true);
  if (record.force !== undefined && typeof record.force !== 'boolean') {
    throw invalidPayload(action);
  }
  return record.force === undefined ? {} : { force: record.force };
}

function activationPayload(payload: unknown): { code: string } {
  const record = payloadRecord(payload, 'checkActivation');
  return {
    code: stringField(record, 'code', 'checkActivation', {
      required: true,
      maxLength: 256,
    })!,
  };
}

function verificationCodePayload(payload: unknown): ManagedAuthVerificationCodePayload {
  const record = payloadRecord(payload, 'sendVerificationCode');
  return {
    account: stringField(record, 'account', 'sendVerificationCode', {
      required: true,
      maxLength: 320,
    })!,
    turnstileToken: stringField(record, 'turnstileToken', 'sendVerificationCode', {
      maxLength: 4096,
    }),
  };
}

function loginPayload(payload: unknown): ManagedAuthLoginPayload {
  const record = payloadRecord(payload, 'login');
  return {
    account: stringField(record, 'account', 'login', {
      required: true,
      maxLength: 320,
    })!,
    password: stringField(record, 'password', 'login', {
      required: true,
      trim: false,
      maxLength: 1024,
    })!,
    activationCode: stringField(record, 'activationCode', 'login', { maxLength: 256 }),
    verifyCode: stringField(record, 'verifyCode', 'login', { maxLength: 64 }),
    turnstileToken: stringField(record, 'turnstileToken', 'login', { maxLength: 4096 }),
  };
}

function registerPayload(payload: unknown): ManagedAuthRegisterPayload {
  const record = payloadRecord(payload, 'register');
  return {
    account: stringField(record, 'account', 'register', {
      required: true,
      maxLength: 320,
    })!,
    username: stringField(record, 'username', 'register', { maxLength: 128 }),
    password: stringField(record, 'password', 'register', {
      required: true,
      trim: false,
      maxLength: 1024,
    })!,
    activationCode: stringField(record, 'activationCode', 'register', { maxLength: 256 }),
    verifyCode: stringField(record, 'verifyCode', 'register', { maxLength: 64 }),
    turnstileToken: stringField(record, 'turnstileToken', 'register', { maxLength: 4096 }),
  };
}

function normalizedSensitiveKey(key: string): string {
  return key.replace(/[_-]/g, '').toLowerCase();
}

function redactErrorText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(
      /(["'])(access[\s_-]?token|refresh[\s_-]?token|relay[\s_-]?token|api[\s_-]?key|password|activation[\s_-]?ticket|ticket|token)\1\s*:\s*(["'])[^"']*\3/gi,
      '$1$2$1:$3[redacted]$3',
    )
    .replace(
      /\b(access[\s_-]?token|refresh[\s_-]?token|relay[\s_-]?token|api[\s_-]?key|password|activation[\s_-]?ticket|ticket|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[redacted]',
    );
}

function sanitizeOutbound<T>(value: T, key = ''): T {
  if (typeof value === 'string') {
    return (ERROR_TEXT_KEYS.has(normalizedSensitiveKey(key)) ? redactErrorText(value) : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeOutbound(entry)) as T;
  }
  if (!isRecord(value)) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(normalizedSensitiveKey(entryKey))) continue;
    sanitized[entryKey] = sanitizeOutbound(entryValue, entryKey);
  }
  return sanitized as T;
}

async function callSafely<T>(task: () => Promise<T>): Promise<T> {
  try {
    return sanitizeOutbound(await task());
  } catch (error) {
    const managedError = toManagedAuthError(error);
    throw new Error(redactErrorText(managedError.message), { cause: error });
  }
}

export function createManagedAuthApi(
  { gatewayManager }: ManagedAuthApiContext,
): CompleteHostServiceRegistry['managedAuth'] {
  return {
    bootstrap: () => callSafely(() => getManagedAuthBootstrap()),
    localStatus: () => callSafely(() => getManagedAuthLocalStatus()),
    status: (payload: ManagedAuthPayload<'status'>) => {
      const options = optionalBooleanPayload(payload, 'status');
      return callSafely(() => getManagedAuthStatus(options, gatewayManager));
    },
    checkActivation: (payload: ManagedAuthPayload<'checkActivation'>) => {
      const body = activationPayload(payload);
      return callSafely(() => checkManagedAuthActivation(body.code));
    },
    sendVerificationCode: (payload: ManagedAuthPayload<'sendVerificationCode'>) => {
      const body = verificationCodePayload(payload);
      return callSafely(() => sendManagedAuthVerificationCode(body));
    },
    login: (payload: ManagedAuthPayload<'login'>) => {
      const body = loginPayload(payload);
      return callSafely(() => loginManagedAuth(body, gatewayManager));
    },
    register: (payload: ManagedAuthPayload<'register'>) => {
      const body = registerPayload(payload);
      return callSafely(() => registerManagedAuth(body, gatewayManager));
    },
    verify: (payload: ManagedAuthPayload<'verify'>) => {
      const options = optionalBooleanPayload(payload, 'verify');
      return callSafely(() => verifyManagedAuth(options, gatewayManager));
    },
    refresh: (payload: ManagedAuthPayload<'refresh'>) => {
      const options = optionalBooleanPayload(payload, 'refresh');
      return callSafely(() => refreshManagedAuth(options, gatewayManager));
    },
    logout: () => callSafely(() => logoutManagedAuth(gatewayManager)),
  };
}
