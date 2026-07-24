// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = new Map<string, unknown>();
  return {
    state,
    store: {
      get: vi.fn((key: string) => state.get(key)),
      has: vi.fn((key: string) => state.has(key)),
      set: vi.fn((key: string, value: unknown) => {
        state.set(key, value);
      }),
      delete: vi.fn((key: string) => state.delete(key)),
    },
  };
});

vi.mock('@electron/services/providers/store-instance', () => ({
  getClawXProviderStore: async () => mocks.store,
}));

const MARKER_KEY = 'uclawManagedRuntimeMutation';
const originalManagedDistribution = process.env.CLAWX_MANAGED_PROVIDER;

describe('managed runtime mutation barrier', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.state.clear();
    process.env.CLAWX_MANAGED_PROVIDER = '1';
  });

  afterEach(() => {
    if (originalManagedDistribution === undefined) {
      delete process.env.CLAWX_MANAGED_PROVIDER;
    } else {
      process.env.CLAWX_MANAGED_PROVIDER = originalManagedDistribution;
    }
  });

  it('allows startup when the persistent marker key is absent', async () => {
    const barrier = await import('@electron/gateway/managed-runtime-mutation-barrier');

    await expect(barrier.hasManagedRuntimeMutationMarker()).resolves.toBe(false);
    await expect(barrier.assertManagedRuntimeStartAllowed()).resolves.toBeUndefined();
  });

  it.each([
    null,
    'corrupt-marker',
    {},
    { version: 999, state: 'unknown' },
  ])('fails closed when the persistent marker key contains malformed data: %j', async (marker) => {
    mocks.state.set(MARKER_KEY, marker);
    const barrier = await import('@electron/gateway/managed-runtime-mutation-barrier');

    await expect(barrier.hasManagedRuntimeMutationMarker()).resolves.toBe(true);
    await expect(barrier.assertManagedRuntimeStartAllowed()).rejects.toBeInstanceOf(
      barrier.ManagedRuntimeStartBlockedError,
    );
  });

  it('keeps startup blocked until recovery clears the marker and releases its lease', async () => {
    const barrier = await import('@electron/gateway/managed-runtime-mutation-barrier');
    const failedTransactionLease = barrier.acquireManagedRuntimeMutationLease();

    await barrier.markManagedRuntimeMutationStarted(failedTransactionLease, 'login');
    barrier.releaseManagedRuntimeMutationLease(failedTransactionLease);

    // A process restart cannot bypass persisted evidence from an incomplete transaction.
    await expect(barrier.assertManagedRuntimeStartAllowed()).rejects.toBeInstanceOf(
      barrier.ManagedRuntimeStartBlockedError,
    );

    const recoveryLease = barrier.acquireManagedRuntimeMutationLease();
    await barrier.clearManagedRuntimeMutationMarker(recoveryLease);

    // Clearing the marker does not expose the runtime while recovery still owns the lease.
    await expect(barrier.assertManagedRuntimeStartAllowed()).rejects.toBeInstanceOf(
      barrier.ManagedRuntimeStartBlockedError,
    );
    await expect(barrier.assertManagedRuntimeStartAllowed(recoveryLease)).resolves.toBeUndefined();

    barrier.releaseManagedRuntimeMutationLease(recoveryLease);
    await expect(barrier.assertManagedRuntimeStartAllowed()).resolves.toBeUndefined();
  });
});
