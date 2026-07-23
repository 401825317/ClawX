import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedAuthStatus } from '@shared/managed-auth';
import { hostApi } from '@/lib/host-api';
import { useManagedAuthStore } from '@/stores/managed-auth';

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

describe('managed auth store', () => {
  beforeEach(() => {
    useManagedAuthStore.setState({
      status: null,
      loading: false,
      verifying: false,
      initialized: false,
      error: null,
    });
  });

  it('loads local status through the typed managedAuth host API', async () => {
    const local = status({ managed: false });
    const spy = vi.spyOn(hostApi.managedAuth, 'localStatus').mockResolvedValue(local);

    await expect(useManagedAuthStore.getState().loadLocalStatus()).resolves.toEqual(local);
    expect(spy).toHaveBeenCalledOnce();
    expect(useManagedAuthStore.getState()).toMatchObject({
      status: local,
      initialized: true,
      error: null,
    });
  });

  it('records only a mapped error key when remote verification fails', async () => {
    vi.spyOn(hostApi.managedAuth, 'status').mockRejectedValue(new Error('sensitive backend response'));

    await expect(useManagedAuthStore.getState().refreshStatus()).rejects.toThrow();
    expect(useManagedAuthStore.getState().error).toBe('UNKNOWN');
  });

  it('keeps a usable local session when remote verification throws', async () => {
    const local = status({
      localOnly: true,
      hasRefreshToken: true,
      hasRelayToken: true,
      offlineGraceExpiresAt: Date.now() + 60_000,
    });
    useManagedAuthStore.setState({ status: local, initialized: true });
    vi.spyOn(hostApi.managedAuth, 'status').mockRejectedValue(new Error('network failure'));

    await expect(useManagedAuthStore.getState().refreshStatus()).rejects.toThrow();
    expect(useManagedAuthStore.getState()).toMatchObject({ status: local, error: null });
  });

  it('uses the returned logout status without calling an untyped transport', async () => {
    const loggedIn = status({
      hasAuthToken: true,
      hasRefreshToken: true,
      hasRelayToken: true,
      authValid: true,
    });
    const loggedOut = status({
      gatewayReloaded: false,
      gatewayReloadError: 'Gateway reload failed',
    });
    useManagedAuthStore.setState({ status: loggedIn, initialized: true });
    vi.spyOn(hostApi.managedAuth, 'logout').mockResolvedValue({ success: true, status: loggedOut });

    await expect(useManagedAuthStore.getState().logout()).resolves.toEqual(loggedOut);
    expect(useManagedAuthStore.getState()).toMatchObject({ status: loggedOut, initialized: true });
  });
});
