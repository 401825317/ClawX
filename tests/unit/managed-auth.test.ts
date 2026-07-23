import { describe, expect, it, vi } from 'vitest';
import type { ManagedAuthStatus } from '@shared/managed-auth';
import {
  MANAGED_AUTH_BRAND,
  getManagedAuthDisplayName,
  getManagedAuthStateKey,
  isManagedAuthReady,
} from '@/lib/managed-auth';
import { getManagedAuthErrorKey, getManagedAuthErrorMessage } from '@/lib/managed-auth-errors';
import { isManagedUsernameValid } from '@/lib/managed-username';

function status(overrides: Partial<ManagedAuthStatus> = {}): ManagedAuthStatus {
  return {
    managed: true,
    hasAuthToken: false,
    hasRefreshToken: false,
    hasRelayToken: false,
    authValid: false,
    deviceActivated: false,
    activationRequired: false,
    bootstrap: {},
    ...overrides,
  };
}

describe('managed auth renderer projection', () => {
  it('treats unmanaged builds and complete managed sessions as ready', () => {
    expect(isManagedAuthReady(status({ managed: false }))).toBe(true);
    expect(isManagedAuthReady(status({
      hasAuthToken: true,
      hasRelayToken: true,
      authValid: true,
      deviceActivated: true,
    }))).toBe(true);
  });

  it('keeps activation-required sessions blocked', () => {
    const current = status({
      hasAuthToken: true,
      hasRelayToken: true,
      authValid: true,
      activationRequired: true,
    });
    expect(isManagedAuthReady(current)).toBe(false);
    expect(getManagedAuthStateKey(current)).toBe('activationRequired');
  });

  it('exposes offline grace as a stable non-blocking state', () => {
    expect(getManagedAuthStateKey(status({
      localOnly: true,
      hasRefreshToken: true,
      hasRelayToken: true,
      offlineGraceExpiresAt: Date.now() + 60_000,
    }))).toBe('offlineGrace');
  });

  it('uses account identity without exposing the backend service name', () => {
    const current = status({
      user: { username: 'uclaw-user', email: 'user@example.com' },
      bootstrap: { service: { displayName: 'backend-display-name' } },
    });
    expect(getManagedAuthDisplayName(current)).toBe('uclaw-user');
    expect(MANAGED_AUTH_BRAND).toBe('UClaw');
  });
});

describe('managed auth error projection', () => {
  it('maps structured and inferred failures to a closed key set', () => {
    expect(getManagedAuthErrorKey({ errorCode: 'activation_expired' })).toBe('activation_expired');
    expect(getManagedAuthErrorKey(new Error('request timed out'))).toBe('TIMEOUT');
    expect(getManagedAuthErrorKey(new Error('private backend detail'))).toBe('UNKNOWN');
  });

  it('never returns an unknown backend message as display text', () => {
    const translate = vi.fn((key: string) => `translated:${key}`);
    expect(getManagedAuthErrorMessage(translate, new Error('private backend detail')))
      .toBe('translated:auth.errors.UNKNOWN');
  });
});

describe('managed username validation', () => {
  it('accepts the supported format and rejects invalid boundaries', () => {
    expect(isManagedUsernameValid('user_01')).toBe(true);
    expect(isManagedUsernameValid('-user')).toBe(false);
    expect(isManagedUsernameValid('user-')).toBe(false);
    expect(isManagedUsernameValid('A'.repeat(21))).toBe(false);
    expect(isManagedUsernameValid('用户')).toBe(false);
  });
});
