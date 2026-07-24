// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UCLAW_DEFAULT_MODEL,
  UCLAW_SUPPORT_ROUTES,
} from '@shared/junfeiai-endpoints';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  isManaged: vi.fn(() => true),
  origin: 'https://uclaw.example.test',
  store: new Map<string, unknown>(),
  storeLoadGate: null as Promise<void> | null,
}));

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: (...args: unknown[]) => mocks.fetch(...args),
}));

vi.mock('@electron/utils/junfeiai-distribution', () => ({
  getUclawBackendOrigin: () => mocks.origin,
  isUclawManagedDistribution: () => mocks.isManaged(),
}));

vi.mock('@electron/utils/logger', () => ({
  logger: { warn: vi.fn() },
}));

vi.mock('electron-store', async () => {
  if (mocks.storeLoadGate) await mocks.storeLoadGate;
  return {
    default: class FakeStore {
      get(key: string): unknown {
        return mocks.store.get(key);
      }

      set(key: string, value: unknown): void {
        mocks.store.set(key, value);
      }
    },
  };
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function loadService() {
  vi.resetModules();
  return import('@electron/services/managed-client-config-service');
}

describe('managed client-config service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetch.mockReset();
    mocks.store.clear();
    mocks.isManaged.mockReturnValue(true);
    mocks.origin = 'https://uclaw.example.test';
    mocks.storeLoadGate = null;
  });

  it('keeps only enabled unique text models and validates the remote default', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        modelOptions: {
          text: {
            defaultModel: 'disabled-model',
            models: [
              { id: 'smart-latest', label: 'Smart', enabled: true },
              { id: 'disabled-model', label: 'Disabled', enabled: false },
              { id: 'deepseek-v4-pro', description: 'Reasoning', enabled: true },
              { id: 'deepseek-v4-pro', label: 'Duplicate' },
            ],
          },
        },
      },
    }));
    const { getManagedClientTextModelPolicy } = await loadService();

    await expect(getManagedClientTextModelPolicy({ refresh: true })).resolves.toEqual({
      defaultModel: 'smart-latest',
      models: [
        { id: 'smart-latest', label: 'Smart' },
        { id: 'deepseek-v4-pro', description: 'Reasoning' },
      ],
    });
    expect(mocks.store.get('textModelPolicy')).toEqual({
      version: 2,
      policiesByOrigin: {
        'https://uclaw.example.test': expect.objectContaining({ defaultModel: 'smart-latest' }),
      },
    });
  });

  it('accepts code 200 when HTTP and success do not report a failure', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      code: 200,
      data: {
        modelOptions: {
          text: {
            defaultModel: 'smart-latest',
            models: [{ id: 'smart-latest', label: 'Smart' }],
          },
        },
      },
    }));
    const { getManagedClientTextModelPolicy } = await loadService();

    await expect(getManagedClientTextModelPolicy({ refresh: true })).resolves.toEqual({
      defaultModel: 'smart-latest',
      models: [{ id: 'smart-latest', label: 'Smart' }],
    });
  });

  it('does not fall back to bootstrap when an HTTP-success payload reports success false', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      success: false,
      code: 200,
      message: 'client config unavailable',
    }));
    const { getManagedClientTextModelPolicy } = await loadService();

    await expect(getManagedClientTextModelPolicy({ refresh: true })).resolves.toEqual({
      defaultModel: UCLAW_DEFAULT_MODEL,
      models: [{ id: UCLAW_DEFAULT_MODEL }],
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('normalizes managed provider prefixes and excludes other provider refs', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        modelOptions: {
          text: {
            defaultModel: 'lingzhiwuxian/reasoning-pro',
            models: [
              { id: 'openai/smart-latest', label: 'Smart' },
              { id: 'lingzhiwuxian/reasoning-pro', label: 'Reasoning' },
              { id: 'deepseek/deepseek-chat', label: 'Third party' },
              { id: 'smart-latest', label: 'Duplicate managed model' },
            ],
          },
        },
      },
    }));
    const { getManagedClientTextModelPolicy } = await loadService();

    await expect(getManagedClientTextModelPolicy({ refresh: true })).resolves.toEqual({
      defaultModel: 'reasoning-pro',
      models: [
        { id: 'smart-latest', label: 'Smart' },
        { id: 'reasoning-pro', label: 'Reasoning' },
      ],
    });
  });

  it('falls back to bootstrap.client only when client-config is missing', async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ message: 'Not found' }, 404))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          client: {
            modelOptions: {
              text: {
                defaultModel: 'deepseek-v4-pro',
                models: [{ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
              },
            },
          },
        },
      }));
    const { getManagedClientTextModelPolicy } = await loadService();

    await expect(getManagedClientTextModelPolicy({ refresh: true })).resolves.toEqual({
      defaultModel: 'deepseek-v4-pro',
      models: [{ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
    });
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      2,
      `https://uclaw.example.test${UCLAW_SUPPORT_ROUTES.bootstrap}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('preserves the persisted last successful policy when refresh fails', async () => {
    mocks.store.set('textModelPolicy', {
      version: 2,
      policiesByOrigin: {
        'https://uclaw.example.test': {
          defaultModel: 'cached-model',
          models: [{ id: 'cached-model', label: 'Cached' }],
        },
      },
    });
    mocks.fetch.mockRejectedValueOnce(new Error('offline'));
    const { getManagedClientTextModelPolicy } = await loadService();

    await expect(getManagedClientTextModelPolicy({ refresh: true })).resolves.toEqual({
      defaultModel: 'cached-model',
      models: [{ id: 'cached-model', label: 'Cached' }],
    });
  });

  it('uses the centralized default when no verified policy exists', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('offline'));
    const { getManagedClientTextModelPolicy } = await loadService();

    await expect(getManagedClientTextModelPolicy({ refresh: true })).resolves.toEqual({
      defaultModel: UCLAW_DEFAULT_MODEL,
      models: [{ id: UCLAW_DEFAULT_MODEL }],
    });
  });

  it('accepts a bootstrap payload from login without persisting credentials', async () => {
    const { cacheManagedClientTextModelPolicyFromPayload } = await loadService();
    const policy = await cacheManagedClientTextModelPolicyFromPayload({
      accessToken: 'secret-access-token',
      client: {
        modelOptions: {
          text: {
            defaultModel: 'smart-latest',
            models: [{ id: 'smart-latest', label: 'Smart' }],
          },
        },
      },
    });

    expect(policy).toEqual({
      defaultModel: 'smart-latest',
      models: [{ id: 'smart-latest', label: 'Smart' }],
    });
    expect(JSON.stringify([...mocks.store.values()])).not.toContain('secret-access-token');
  });

  it('refreshes client-config when an authenticated payload omits model options', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        modelOptions: {
          text: {
            defaultModel: 'login-current-model',
            models: [{ id: 'login-current-model', label: 'Current' }],
          },
        },
      },
    }));
    const { cacheManagedClientTextModelPolicyFromPayload } = await loadService();

    await expect(cacheManagedClientTextModelPolicyFromPayload({
      accessToken: 'secret-access-token',
    })).resolves.toEqual({
      defaultModel: 'login-current-model',
      models: [{ id: 'login-current-model', label: 'Current' }],
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      `https://uclaw.example.test${UCLAW_SUPPORT_ROUTES.clientConfig}`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(JSON.stringify([...mocks.store.values()])).not.toContain('secret-access-token');
  });

  it('isolates persisted and in-memory policies by backend origin', async () => {
    mocks.origin = 'https://first.example.test';
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        modelOptions: {
          text: {
            defaultModel: 'first-model',
            models: [{ id: 'first-model' }],
          },
        },
      },
    }));
    const { getManagedClientTextModelPolicy } = await loadService();
    await expect(getManagedClientTextModelPolicy({ refresh: true })).resolves.toEqual({
      defaultModel: 'first-model',
      models: [{ id: 'first-model' }],
    });

    mocks.origin = 'https://second.example.test';
    mocks.fetch.mockRejectedValueOnce(new Error('second origin offline'));
    await expect(getManagedClientTextModelPolicy({ refresh: true })).resolves.toEqual({
      defaultModel: UCLAW_DEFAULT_MODEL,
      models: [{ id: UCLAW_DEFAULT_MODEL }],
    });

    mocks.origin = 'https://first.example.test';
    await expect(getManagedClientTextModelPolicy()).resolves.toEqual({
      defaultModel: 'first-model',
      models: [{ id: 'first-model' }],
    });
  });

  it('does not let an older in-flight refresh overwrite a newer embedded login policy', async () => {
    let resolveRefresh!: (response: Response) => void;
    mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    }));
    const {
      cacheManagedClientTextModelPolicyFromPayload,
      getManagedClientTextModelPolicy,
    } = await loadService();

    const refresh = getManagedClientTextModelPolicy({ refresh: true });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    await expect(cacheManagedClientTextModelPolicyFromPayload({
      client: {
        modelOptions: {
          text: {
            defaultModel: 'embedded-new',
            models: [{ id: 'embedded-new', label: 'Embedded New' }],
          },
        },
      },
    })).resolves.toEqual({
      defaultModel: 'embedded-new',
      models: [{ id: 'embedded-new', label: 'Embedded New' }],
    });

    resolveRefresh(jsonResponse({
      data: {
        modelOptions: {
          text: {
            defaultModel: 'remote-old',
            models: [{ id: 'remote-old', label: 'Remote Old' }],
          },
        },
      },
    }));

    await expect(refresh).resolves.toEqual({
      defaultModel: 'embedded-new',
      models: [{ id: 'embedded-new', label: 'Embedded New' }],
    });
    await expect(getManagedClientTextModelPolicy()).resolves.toEqual({
      defaultModel: 'embedded-new',
      models: [{ id: 'embedded-new', label: 'Embedded New' }],
    });
  });

  it('orders refreshes from invocation time even while the initial cache is loading', async () => {
    let releaseStoreLoad!: () => void;
    let resolveRefresh!: (response: Response) => void;
    mocks.storeLoadGate = new Promise<void>((resolve) => {
      releaseStoreLoad = resolve;
    });
    mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    }));
    const {
      cacheManagedClientTextModelPolicyFromPayload,
      getManagedClientTextModelPolicy,
    } = await loadService();

    const refresh = getManagedClientTextModelPolicy({ refresh: true });
    const embedded = cacheManagedClientTextModelPolicyFromPayload({
      client: {
        modelOptions: {
          text: {
            defaultModel: 'embedded-new',
            models: [{ id: 'embedded-new', label: 'Embedded New' }],
          },
        },
      },
    });
    releaseStoreLoad();
    await expect(embedded).resolves.toEqual({
      defaultModel: 'embedded-new',
      models: [{ id: 'embedded-new', label: 'Embedded New' }],
    });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());

    resolveRefresh(jsonResponse({
      data: {
        modelOptions: {
          text: {
            defaultModel: 'remote-old',
            models: [{ id: 'remote-old', label: 'Remote Old' }],
          },
        },
      },
    }));

    await expect(refresh).resolves.toEqual({
      defaultModel: 'embedded-new',
      models: [{ id: 'embedded-new', label: 'Embedded New' }],
    });
    await expect(getManagedClientTextModelPolicy()).resolves.toEqual({
      defaultModel: 'embedded-new',
      models: [{ id: 'embedded-new', label: 'Embedded New' }],
    });
  });
});
