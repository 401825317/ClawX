import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/error-model';
import {
  getManagedAuthErrorKey,
  getManagedAuthErrorMessage,
  isManagedDeviceAuthorizationRequired,
} from '@/lib/managed-auth-errors';

const t = (key: string, options?: Record<string, unknown>) => {
  const defaults: Record<string, string> = {
    'auth.errors.activation_invalid': '激活码无效或已过期，请联系客服获取。',
    'auth.errors.invalid_credentials': '用户名或密码错误，请重新输入。',
    'auth.errors.device_authorization_required': '当前设备需要激活码授权。',
    'auth.errors.user_exists': '该用户名已存在，请更换新的用户名。',
    'auth.errors.password_policy': '密码长度需为 8-20 位。',
    'auth.errors.UNKNOWN': '服务暂时不可用，请稍后重试。',
  };
  return defaults[key] || String(options?.defaultValue ?? key);
};

describe('managed auth error mapping', () => {
  it('maps activation backend codes to customer-facing messages', () => {
    const error = new AppError('ACTIVATION_INVALID', 'activation_invalid', undefined, {
      backendCode: 'activation_invalid',
    });

    expect(getManagedAuthErrorKey(error)).toBe('activation_invalid');
    expect(getManagedAuthErrorMessage(t, error)).toBe('激活码无效或已过期，请联系客服获取。');
  });

  it('maps credential failures without leaking raw api errors', () => {
    const error = new AppError('AUTH_INVALID', '账号或密码错误', undefined, {
      backendCode: 'invalid_credentials',
    });

    expect(getManagedAuthErrorKey(error)).toBe('invalid_credentials');
    expect(getManagedAuthErrorMessage(t, error)).toBe('用户名或密码错误，请重新输入。');
  });

  it('detects device authorization requirements', () => {
    const error = new AppError('DEVICE_AUTH_REQUIRED', 'device authorization required', undefined, {
      backendCode: 'device_authorization_required',
    });

    expect(isManagedDeviceAuthorizationRequired(error)).toBe(true);
    expect(getManagedAuthErrorMessage(t, error)).toBe('当前设备需要激活码授权。');
  });

  it('maps taken usernames to the username replacement prompt', () => {
    const error = new AppError('UNKNOWN', '用户名已存在', 409, {
      backendCode: 'user_exists',
    });

    expect(getManagedAuthErrorKey(error)).toBe('user_exists');
    expect(getManagedAuthErrorMessage(t, error)).toBe('该用户名已存在，请更换新的用户名。');
  });

  it('infers password policy failures from backend messages', () => {
    const error = new AppError('UNKNOWN', '密码长度需为 8-20 位');

    expect(getManagedAuthErrorKey(error)).toBe('password_policy');
    expect(getManagedAuthErrorMessage(t, error)).toBe('密码长度需为 8-20 位。');
  });
});
