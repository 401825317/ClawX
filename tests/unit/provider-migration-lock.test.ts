import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = new Map<string, unknown>();
  return {
    state,
    getClawXProviderStore: vi.fn(async () => ({
      get: (key: string) => state.get(key),
      set: (key: string, value: unknown) => state.set(key, value),
    })),
    getDefaultProviderAccountId: vi.fn(),
    providerConfigToAccount: vi.fn((provider: Record<string, unknown>) => provider),
    saveProviderAccount: vi.fn(),
  };
});

vi.mock('@electron/services/providers/store-instance', () => ({
  getClawXProviderStore: mocks.getClawXProviderStore,
}));

vi.mock('@electron/services/providers/provider-store', () => ({
  getDefaultProviderAccountId: mocks.getDefaultProviderAccountId,
  providerConfigToAccount: mocks.providerConfigToAccount,
  saveProviderAccount: mocks.saveProviderAccount,
}));

import { ensureProviderStoreMigrated } from '@electron/services/providers/provider-migration';
import { withProviderMutationLock } from '@electron/services/providers/provider-mutation-lock';

function installLegacyProviderState(): void {
  mocks.state.set('schemaVersion', 0);
  mocks.state.set('defaultProvider', 'openai');
  mocks.state.set('providers', {
    openai: {
      id: 'openai',
      name: 'Legacy OpenAI',
      type: 'openai',
      enabled: true,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
  });
}

describe('Provider store migration lock', () => {
  beforeEach(() => {
    mocks.state.clear();
    vi.clearAllMocks();
    mocks.getDefaultProviderAccountId.mockResolvedValue(undefined);
    mocks.saveProviderAccount.mockResolvedValue(undefined);
  });

  it('runs concurrent first-use migrations once under the shared mutation lock', async () => {
    installLegacyProviderState();
    let releaseSave!: () => void;
    const saveBlocked = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let migrationEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      migrationEntered = resolve;
    });
    mocks.saveProviderAccount.mockImplementationOnce(async () => {
      migrationEntered();
      await saveBlocked;
    });

    const first = ensureProviderStoreMigrated();
    await entered;
    const second = ensureProviderStoreMigrated();
    await Promise.resolve();

    expect(mocks.getClawXProviderStore).toHaveBeenCalledTimes(1);
    expect(mocks.saveProviderAccount).toHaveBeenCalledTimes(1);

    releaseSave();
    await Promise.all([first, second]);

    expect(mocks.saveProviderAccount).toHaveBeenCalledTimes(1);
    expect(mocks.state.get('schemaVersion')).toBe(2);
    expect(mocks.state.get('providers')).toEqual({});
  });

  it('does not let a managed takeover enter while first-use migration is paused', async () => {
    installLegacyProviderState();
    let releaseSave!: () => void;
    const saveBlocked = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let migrationEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      migrationEntered = resolve;
    });
    mocks.saveProviderAccount.mockImplementationOnce(async () => {
      migrationEntered();
      await saveBlocked;
    });
    const migration = ensureProviderStoreMigrated();
    await entered;

    let takeoverEntered = false;
    const takeover = withProviderMutationLock(async () => {
      takeoverEntered = true;
    });
    await Promise.resolve();
    expect(takeoverEntered).toBe(false);

    releaseSave();
    await migration;
    await takeover;
    expect(takeoverEntered).toBe(true);
  });
});
