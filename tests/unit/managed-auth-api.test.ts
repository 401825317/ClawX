import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkActivation: vi.fn(),
  getBootstrap: vi.fn(),
  getLocalStatus: vi.fn(),
  getStatus: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  refresh: vi.fn(),
  register: vi.fn(),
  sendVerificationCode: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('@electron/services/managed-auth-service', () => ({
  checkManagedAuthActivation: (...args: unknown[]) => mocks.checkActivation(...args),
  getManagedAuthBootstrap: (...args: unknown[]) => mocks.getBootstrap(...args),
  getManagedAuthLocalStatus: (...args: unknown[]) => mocks.getLocalStatus(...args),
  getManagedAuthStatus: (...args: unknown[]) => mocks.getStatus(...args),
  loginManagedAuth: (...args: unknown[]) => mocks.login(...args),
  logoutManagedAuth: (...args: unknown[]) => mocks.logout(...args),
  refreshManagedAuth: (...args: unknown[]) => mocks.refresh(...args),
  registerManagedAuth: (...args: unknown[]) => mocks.register(...args),
  sendManagedAuthVerificationCode: (...args: unknown[]) => mocks.sendVerificationCode(...args),
  toManagedAuthError: (error: unknown) => ({
    code: 'request_failed',
    message: error instanceof Error ? error.message : 'UClaw request failed',
  }),
  verifyManagedAuth: (...args: unknown[]) => mocks.verify(...args),
}));

import { createManagedAuthApi } from '@electron/services/managed-auth-api';

const gatewayManager = { getStatus: vi.fn() };

describe('managed auth host API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBootstrap.mockResolvedValue({ service: { displayName: 'UClaw' } });
    mocks.getLocalStatus.mockResolvedValue({ managed: true });
    mocks.getStatus.mockResolvedValue({ managed: true });
    mocks.checkActivation.mockResolvedValue({ valid: true });
    mocks.sendVerificationCode.mockResolvedValue({ success: true, countdown: 60 });
    mocks.login.mockResolvedValue({ success: true });
    mocks.register.mockResolvedValue({ success: true });
    mocks.verify.mockResolvedValue({ success: true });
    mocks.refresh.mockResolvedValue({ success: true });
    mocks.logout.mockResolvedValue({ success: true });
  });

  it('routes managed auth actions and injects GatewayManager where runtime can change', async () => {
    const api = createManagedAuthApi({ gatewayManager: gatewayManager as never });

    await api.bootstrap();
    await api.localStatus();
    await api.status({ force: true });
    await api.checkActivation({ code: '  activation-code  ' });
    await api.sendVerificationCode({ account: '  user@example.com  ' });
    await api.login({ account: '  user@example.com  ', password: ' pass word ' });
    await api.register({
      account: '  user@example.com  ',
      username: '  UClaw User  ',
      password: ' pass word ',
      verifyCode: ' 123456 ',
    });
    await api.verify({ force: false });
    await api.refresh();
    await api.logout();

    expect(mocks.getBootstrap).toHaveBeenCalledWith();
    expect(mocks.getLocalStatus).toHaveBeenCalledWith();
    expect(mocks.getStatus).toHaveBeenCalledWith({ force: true }, gatewayManager);
    expect(mocks.checkActivation).toHaveBeenCalledWith('activation-code');
    expect(mocks.sendVerificationCode).toHaveBeenCalledWith({
      account: 'user@example.com',
      turnstileToken: undefined,
    });
    expect(mocks.login).toHaveBeenCalledWith({
      account: 'user@example.com',
      password: ' pass word ',
      activationCode: undefined,
      verifyCode: undefined,
      turnstileToken: undefined,
    }, gatewayManager);
    expect(mocks.register).toHaveBeenCalledWith({
      account: 'user@example.com',
      username: 'UClaw User',
      password: ' pass word ',
      activationCode: undefined,
      verifyCode: '123456',
      turnstileToken: undefined,
    }, gatewayManager);
    expect(mocks.verify).toHaveBeenCalledWith({ force: false }, gatewayManager);
    expect(mocks.refresh).toHaveBeenCalledWith({}, gatewayManager);
    expect(mocks.logout).toHaveBeenCalledWith(gatewayManager);
  });

  it.each([
    ['checkActivation', undefined],
    ['checkActivation', { code: '' }],
    ['checkActivation', { code: `abc\u0000def` }],
    ['sendVerificationCode', { account: 42 }],
    ['sendVerificationCode', { account: 'a'.repeat(321) }],
    ['login', { account: 'user@example.com', password: '' }],
    ['login', { account: 'user@example.com', password: 'secret\nvalue' }],
    ['register', { account: 'user@example.com', password: 'secret', username: 'x'.repeat(129) }],
    ['status', { force: 'yes' }],
    ['verify', []],
    ['refresh', { force: 1 }],
  ] as const)('rejects invalid %s payloads before calling the service', async (action, payload) => {
    const api = createManagedAuthApi({ gatewayManager: gatewayManager as never });

    await expect(async () => (api[action] as (value?: unknown) => Promise<unknown>)(payload))
      .rejects.toThrow(`Invalid managedAuth.${action} payload`);

    expect(mocks.checkActivation).not.toHaveBeenCalled();
    expect(mocks.sendVerificationCode).not.toHaveBeenCalled();
    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.getStatus).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('strips credential-bearing fields and redacts error text from service results', async () => {
    mocks.login.mockResolvedValue({
      success: false,
      accessToken: 'access-secret',
      nested: {
        refresh_token: 'refresh-secret',
        activationTicket: 'ticket-secret',
      },
      status: {
        managed: true,
        hasAuthToken: true,
        authError: 'password=plain-secret access_token: access-secret',
      },
      message: 'Bearer bearer-secret relay-token=relay-secret {"token":"generic-secret"}',
    });
    const api = createManagedAuthApi({ gatewayManager: gatewayManager as never });

    const result = await api.login({ account: 'user@example.com', password: 'input-secret' });

    expect(result).toEqual({
      success: false,
      nested: {},
      status: {
        managed: true,
        hasAuthToken: true,
        authError: 'password=[redacted] access_token=[redacted]',
      },
      message: 'Bearer [redacted] relay-token=[redacted] {"token":"[redacted]"}',
    });
    expect(JSON.stringify(result)).not.toContain('access-secret');
    expect(JSON.stringify(result)).not.toContain('refresh-secret');
    expect(JSON.stringify(result)).not.toContain('ticket-secret');
    expect(JSON.stringify(result)).not.toContain('plain-secret');
    expect(JSON.stringify(result)).not.toContain('bearer-secret');
    expect(JSON.stringify(result)).not.toContain('relay-secret');
    expect(JSON.stringify(result)).not.toContain('generic-secret');
  });

  it('preserves stable verification-code business errors as results', async () => {
    mocks.sendVerificationCode.mockResolvedValue({
      success: false,
      errorCode: 'verification_rate_limited',
    });
    const api = createManagedAuthApi({ gatewayManager: gatewayManager as never });

    await expect(api.sendVerificationCode({ account: 'user@example.com' })).resolves.toEqual({
      success: false,
      errorCode: 'verification_rate_limited',
    });
  });

  it('redacts credential values from thrown service errors', async () => {
    mocks.sendVerificationCode.mockRejectedValue(
      new Error('UClaw request failed: password=plain-secret ticket: ticket-secret'),
    );
    const api = createManagedAuthApi({ gatewayManager: gatewayManager as never });

    await expect(api.sendVerificationCode({ account: 'user@example.com' }))
      .rejects.toThrow('UClaw request failed: password=[redacted] ticket=[redacted]');
  });
});
