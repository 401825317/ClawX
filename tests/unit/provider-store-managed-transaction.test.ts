import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccount } from '@electron/shared/providers/types';
import {
  UCLAW_MANAGED_PROVIDER_BASE_URL,
  UCLAW_RUNTIME_CONTRACT_VERSION,
} from '@shared/junfeiai-endpoints';

const mocks = vi.hoisted(() => {
  const state = { value: {} as Record<string, unknown> };
  const storeWrite = vi.fn((value: Record<string, unknown>) => {
    state.value = structuredClone(value);
  });
  const store = {
    get store(): Record<string, unknown> {
      return structuredClone(state.value);
    },
    set store(value: Record<string, unknown>) {
      storeWrite(value);
    },
    get: vi.fn((key: string) => structuredClone(state.value[key])),
    set: vi.fn(),
    delete: vi.fn(),
  };

  return {
    state,
    store,
    storeWrite,
    replaceState(value: Record<string, unknown>) {
      state.value = structuredClone(value);
    },
    readState() {
      return structuredClone(state.value);
    },
  };
});

vi.mock('@electron/services/providers/store-instance', () => ({
  getClawXProviderStore: async () => mocks.store,
}));

import {
  buildManagedProviderAccounts,
  getManagedOpenAiTargetAccountIds,
  installManagedOpenAiProviderAccount,
  restoreManagedProviderStore,
  snapshotManagedProviderStore,
} from '@electron/services/providers/provider-store';

const CREATED_AT = '2026-07-01T00:00:00.000Z';
const UPDATED_AT = '2026-07-24T00:00:00.000Z';

function account(
  id: string,
  vendorId: ProviderAccount['vendorId'],
  overrides: Partial<ProviderAccount> = {},
): ProviderAccount {
  return {
    id,
    vendorId,
    label: id,
    authMode: 'api_key',
    enabled: true,
    isDefault: false,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function managedAccount(): ProviderAccount {
  return account('openai', 'openai', {
    label: 'OpenAI',
    baseUrl: UCLAW_MANAGED_PROVIDER_BASE_URL,
    apiProtocol: 'openai-responses',
    model: 'smart-latest',
    isDefault: true,
    metadata: {
      managedBy: 'uclaw',
      customModels: ['smart-latest'],
      managedDefaultModel: 'smart-latest',
      managedAllowedModels: ['smart-latest'],
      managedRuntimeContractVersion: UCLAW_RUNTIME_CONTRACT_VERSION,
    },
  });
}

function compatibilityAccount(): ProviderAccount {
  return account('lingzhiwuxian', 'lingzhiwuxian', {
    label: 'UClaw',
    baseUrl: UCLAW_MANAGED_PROVIDER_BASE_URL,
    apiProtocol: 'openai-responses',
    model: 'smart-latest',
    isDefault: false,
    metadata: {
      managedBy: 'uclaw',
      customModels: ['smart-latest'],
      managedDefaultModel: 'smart-latest',
      managedAllowedModels: ['smart-latest'],
      managedRuntimeContractVersion: UCLAW_RUNTIME_CONTRACT_VERSION,
    },
  });
}

describe('managed Provider store transaction', () => {
  beforeEach(() => {
    mocks.replaceState({});
    vi.clearAllMocks();
  });

  it('builds identical server-owned model sets for the default and compatibility accounts', () => {
    const [primary, compatibility] = buildManagedProviderAccounts({}, {
      defaultModel: 'smart-latest',
      models: [{ id: 'smart-latest' }, { id: 'reasoning-pro' }],
    }, { email: 'user@example.com' });

    expect(primary).toEqual(expect.objectContaining({
      id: 'openai',
      vendorId: 'openai',
      label: 'OpenAI',
      model: 'smart-latest',
      isDefault: true,
    }));
    expect(compatibility).toEqual(expect.objectContaining({
      id: 'lingzhiwuxian',
      vendorId: 'lingzhiwuxian',
      label: 'UClaw',
      model: 'smart-latest',
      isDefault: false,
    }));
    expect(primary.metadata?.customModels).toEqual(['smart-latest', 'reasoning-pro']);
    expect(compatibility.metadata?.customModels).toEqual(primary.metadata?.customModels);
    expect(compatibility.metadata?.managedAllowedModels)
      .toEqual(primary.metadata?.managedAllowedModels);
  });

  it('identifies every OpenAI takeover target without including unrelated accounts', async () => {
    mocks.replaceState({
      providerAccounts: {
        openai: account('openai', 'custom'),
        'openai-codex': account('openai-codex', 'custom'),
        'openai-secondary': account('openai-secondary', 'openai'),
        'legacy-uclaw-relay': account('legacy-uclaw-relay', 'custom', {
          baseUrl: `${UCLAW_MANAGED_PROVIDER_BASE_URL}/`,
          model: 'smart-latest',
        }),
        'custom-openai-compatible': account('custom-openai-compatible', 'custom', {
          baseUrl: 'https://llm.example.com/v1',
          model: 'smart-latest',
        }),
        deepseek: account('deepseek', 'deepseek'),
      },
    });

    const snapshot = await snapshotManagedProviderStore();

    expect(getManagedOpenAiTargetAccountIds(snapshot)).toEqual([
      'openai',
      'openai-codex',
      'openai-secondary',
      'legacy-uclaw-relay',
    ]);
  });

  it('atomically replaces all OpenAI targets with the two managed accounts', async () => {
    mocks.replaceState({
      providerAccounts: {
        openai: account('openai', 'openai'),
        'openai-codex': account('openai-codex', 'custom'),
        'openai-secondary': account('openai-secondary', 'openai'),
        'legacy-uclaw-relay': account('legacy-uclaw-relay', 'custom', {
          baseUrl: UCLAW_MANAGED_PROVIDER_BASE_URL,
          model: 'smart-latest',
        }),
        'custom-openai-compatible': account('custom-openai-compatible', 'custom', {
          baseUrl: 'https://llm.example.com/v1',
          model: 'smart-latest',
        }),
        deepseek: account('deepseek', 'deepseek', { isDefault: true }),
        moonshot: account('moonshot', 'moonshot', { isDefault: true }),
      },
      defaultProvider: 'deepseek',
      defaultProviderAccountId: 'deepseek',
      unrelated: { keep: true },
    });
    const managed = managedAccount();
    const compatibility = compatibilityAccount();

    const snapshot = await snapshotManagedProviderStore();

    await installManagedOpenAiProviderAccount(snapshot, managed, compatibility);

    expect(mocks.readState()).toEqual({
      providerAccounts: {
        deepseek: account('deepseek', 'deepseek', { isDefault: false }),
        moonshot: account('moonshot', 'moonshot', { isDefault: false }),
        'custom-openai-compatible': account('custom-openai-compatible', 'custom', {
          baseUrl: 'https://llm.example.com/v1',
          model: 'smart-latest',
          isDefault: false,
        }),
        openai: managed,
        lingzhiwuxian: compatibility,
      },
      defaultProvider: 'openai',
      defaultProviderAccountId: 'openai',
      unrelated: { keep: true },
    });
    expect(mocks.storeWrite).toHaveBeenCalledTimes(1);
    expect(mocks.store.set).not.toHaveBeenCalled();
    expect(mocks.store.delete).not.toHaveBeenCalled();
  });

  it('does not rewrite an already consistent managed Provider store', async () => {
    const managed = managedAccount();
    const compatibility = compatibilityAccount();
    mocks.replaceState({
      providerAccounts: { openai: managed, lingzhiwuxian: compatibility },
      defaultProvider: 'openai',
      defaultProviderAccountId: 'openai',
    });
    const snapshot = await snapshotManagedProviderStore();

    await expect(installManagedOpenAiProviderAccount(snapshot, managed, compatibility))
      .resolves.toBe(false);

    expect(mocks.storeWrite).not.toHaveBeenCalled();
  });

  it('restores the full snapshot and the original default-key presence atomically', async () => {
    const originalAccounts = {
      openai: account('openai', 'openai', {
        headers: { 'X-Previous': 'preserved' },
        fallbackModels: ['gpt-previous'],
        isDefault: true,
      }),
      deepseek: account('deepseek', 'deepseek'),
    };
    mocks.replaceState({
      providerAccounts: originalAccounts,
      defaultProvider: null,
      unrelated: { version: 1 },
    });
    const snapshot = await snapshotManagedProviderStore();
    originalAccounts.openai.headers!['X-Previous'] = 'mutated-after-snapshot';

    await installManagedOpenAiProviderAccount(snapshot, managedAccount(), compatibilityAccount());
    mocks.replaceState({
      ...mocks.readState(),
      unrelated: { version: 2 },
    });
    mocks.storeWrite.mockClear();

    await restoreManagedProviderStore(snapshot);

    const restored = mocks.readState();
    expect(restored.providerAccounts).toEqual({
      openai: account('openai', 'openai', {
        headers: { 'X-Previous': 'preserved' },
        fallbackModels: ['gpt-previous'],
        isDefault: true,
      }),
      deepseek: account('deepseek', 'deepseek'),
    });
    expect(Object.hasOwn(restored, 'defaultProvider')).toBe(true);
    expect(restored.defaultProvider).toBeNull();
    expect(Object.hasOwn(restored, 'defaultProviderAccountId')).toBe(false);
    expect(restored.unrelated).toEqual({ version: 2 });
    expect(mocks.storeWrite).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-managed account before modifying the store', async () => {
    mocks.replaceState({
      providerAccounts: { deepseek: account('deepseek', 'deepseek', { isDefault: true }) },
      defaultProvider: 'deepseek',
      defaultProviderAccountId: 'deepseek',
    });

    const snapshot = await snapshotManagedProviderStore();

    await expect(installManagedOpenAiProviderAccount(
      snapshot,
      account('openai', 'openai'),
      compatibilityAccount(),
    ))
      .rejects.toThrow('managed UClaw OpenAI account');

    expect(mocks.storeWrite).not.toHaveBeenCalled();
  });

  it('rejects installation when the Provider state changed after the snapshot', async () => {
    mocks.replaceState({
      providerAccounts: { deepseek: account('deepseek', 'deepseek', { isDefault: true }) },
      defaultProvider: 'deepseek',
      defaultProviderAccountId: 'deepseek',
    });
    const snapshot = await snapshotManagedProviderStore();
    mocks.replaceState({
      providerAccounts: {
        deepseek: account('deepseek', 'deepseek', { isDefault: true }),
        moonshot: account('moonshot', 'moonshot'),
      },
      defaultProvider: 'deepseek',
      defaultProviderAccountId: 'deepseek',
    });

    await expect(installManagedOpenAiProviderAccount(
      snapshot,
      managedAccount(),
      compatibilityAccount(),
    ))
      .rejects.toThrow('Provider store changed after the managed snapshot');

    expect(mocks.storeWrite).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.readState())).not.toContain('smart-latest');
  });

  it('rejects rollback over a concurrent Provider change but treats an already-restored state as a no-op', async () => {
    const before = {
      providerAccounts: { deepseek: account('deepseek', 'deepseek', { isDefault: true }) },
      defaultProvider: 'deepseek',
      defaultProviderAccountId: 'deepseek',
    };
    mocks.replaceState(before);
    const snapshot = await snapshotManagedProviderStore();
    await installManagedOpenAiProviderAccount(snapshot, managedAccount(), compatibilityAccount());
    mocks.replaceState({
      ...mocks.readState(),
      providerAccounts: {
        ...(mocks.readState().providerAccounts as Record<string, ProviderAccount>),
        moonshot: account('moonshot', 'moonshot'),
      },
    });
    mocks.storeWrite.mockClear();

    await expect(restoreManagedProviderStore(snapshot))
      .rejects.toThrow('Provider store changed after managed installation');
    expect(mocks.storeWrite).not.toHaveBeenCalled();

    mocks.replaceState(before);
    await restoreManagedProviderStore(snapshot);
    expect(mocks.storeWrite).not.toHaveBeenCalled();
  });
});
