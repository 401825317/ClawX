import { describe, expect, it } from 'vitest';
import {
  getManagedAuthDisplayName,
  getManagedAuthStateKey,
  isManagedAuthLocallyReady,
  isManagedAuthRecoverableLocalSession,
  isManagedAuthReady,
  type ManagedAuthStatus,
} from '@/lib/managed-auth';

describe('managed auth helpers', () => {
  it('treats unmanaged builds as ready', () => {
    const status: ManagedAuthStatus = { managed: false };

    expect(isManagedAuthReady(status)).toBe(true);
    expect(getManagedAuthStateKey(status)).toBe('unmanaged');
  });

  it('requires both a valid auth session and relay token', () => {
    expect(isManagedAuthReady({ managed: true, authValid: true, hasRelayToken: true })).toBe(true);
    expect(getManagedAuthStateKey({ managed: true, authValid: true, hasRelayToken: true })).toBe('ready');
    expect(getManagedAuthStateKey({ managed: true, authValid: true, hasRelayToken: false, hasAuthToken: true })).toBe('relayMissing');
  });

  it('blocks managed UI while auth status is still unknown', () => {
    expect(isManagedAuthReady(null)).toBe(false);
    expect(getManagedAuthStateKey(null)).toBe('checking');
  });

  it('separates logged out, expired, and activation-required states', () => {
    expect(getManagedAuthStateKey({ managed: true, hasAuthToken: false })).toBe('loggedOut');
    expect(getManagedAuthStateKey({
      managed: true,
      hasAuthToken: false,
      authValid: false,
      activationRequired: true,
      deviceActivated: false,
    })).toBe('loggedOut');
    expect(getManagedAuthStateKey({ managed: true, hasAuthToken: true, authValid: false })).toBe('loginExpired');
    expect(getManagedAuthStateKey({
      managed: true,
      hasAuthToken: true,
      authValid: true,
      hasRelayToken: true,
      activationRequired: true,
      deviceActivated: false,
    })).toBe('activationRequired');
  });

  it('treats status refresh errors as blocking even when stale status looked ready', () => {
    const staleReady: ManagedAuthStatus = { managed: true, authValid: true, hasRelayToken: true };

    expect(getManagedAuthStateKey(staleReady, { error: 'fetch failed' })).toBe('error');
  });

  it('allows a local-only ready snapshot to survive background refresh errors', () => {
    const localReady: ManagedAuthStatus = {
      managed: true,
      localOnly: true,
      hasAuthToken: true,
      hasRelayToken: true,
      authValid: false,
    };

    expect(isManagedAuthReady(localReady)).toBe(false);
    expect(isManagedAuthLocallyReady(localReady)).toBe(true);
    expect(getManagedAuthStateKey(localReady, { error: 'fetch failed' })).toBe('ready');
  });

  it('treats a local refresh token as a recoverable managed-auth session', () => {
    const localRefreshable: ManagedAuthStatus = {
      managed: true,
      localOnly: true,
      hasAuthToken: false,
      hasRefreshToken: true,
      hasRelayToken: true,
      authValid: false,
    };

    expect(isManagedAuthReady(localRefreshable)).toBe(false);
    expect(isManagedAuthLocallyReady(localRefreshable)).toBe(true);
    expect(getManagedAuthStateKey(localRefreshable)).toBe('ready');
  });

  it('keeps a relay-backed session ready during auth refresh synchronization', () => {
    const syncingSession: ManagedAuthStatus = {
      managed: true,
      hasAuthToken: true,
      hasRefreshToken: true,
      hasRelayToken: true,
      authValid: false,
      authRejected: true,
      offlineGraceExpiresAt: Date.now() + 60_000,
    };

    expect(isManagedAuthLocallyReady(syncingSession)).toBe(false);
    expect(isManagedAuthRecoverableLocalSession(syncingSession)).toBe(true);
    expect(getManagedAuthStateKey(syncingSession)).toBe('ready');
  });

  it('uses stable account display-name priority', () => {
    expect(getManagedAuthDisplayName({
      auth: {
        user: {
          email: 'user@example.com',
          username: 'renyi',
        },
      },
    })).toBe('renyi');
    expect(getManagedAuthDisplayName({ auth: { user: { id: 42 } } }, 'unknown')).toBe('42');
    expect(getManagedAuthDisplayName(null, 'unknown')).toBe('unknown');
  });
});
