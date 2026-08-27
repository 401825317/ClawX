// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UCLAW_DEFAULT_FALLBACK_MODEL,
  UCLAW_DEFAULT_MODEL,
  UCLAW_DEFAULT_THINKING_LEVEL,
  UCLAW_SUPPORT_REFRESH_INTERVAL_MS,
  UCLAW_SUPPORT_ROUTES,
} from '@shared/junfeiai-endpoints';

const defaultFallbackModels = [UCLAW_DEFAULT_FALLBACK_MODEL];
const hiddenDefaultFallbackModel = {
  id: UCLAW_DEFAULT_FALLBACK_MODEL,
  label: 'DeepSeek V4 Flash',
  visible: false,
};

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  isManaged: vi.fn(() => true),
  origin: 'https://uclaw.example.test',
  store: new Map<string, unknown>(),
  storeLoadGate: null as Promise<void> | null,
  secret: null as null | { type: 'oauth'; accessToken: string },
  installationId: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  installationIdError: null as Error | null,
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: (...args: unknown[]) => mocks.fetch(...args),
}));

vi.mock('@electron/utils/junfeiai-distribution', () => ({
  getUclawBackendOrigin: () => mocks.origin,
  isUclawManagedDistribution: () => mocks.isManaged(),
  UCLAW_AUTH_ACCOUNT_ID: 'uclaw-auth',
}));

vi.mock('@electron/utils/logger', () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn },
}));

vi.mock('@electron/utils/installation-id', () => ({
  getOrCreateInstallationId: async () => {
    if (mocks.installationIdError) throw mocks.installationIdError;
    return mocks.installationId;
  },
}));

vi.mock('@electron/services/secrets/secret-store', () => ({
  getProviderSecret: async () => mocks.secret,
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
    mocks.secret = null;
    mocks.installationId = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    mocks.installationIdError = null;
  });

  it('keeps only enabled unique text models and validates the remote default', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        modelOptions: {
          text: {
            defaultModel: 'disabled-model',
            fallbackModels: [
              'lingzhiwuxian/deepseek-v4-pro',
              'openai/standard-chat',
              'disabled-model',
              'smart-latest',
              'deepseek-v4-pro',
              'third-party/other-model',
            ],
            defaultThinkingLevel: 'HIGH',
            models: [
              { id: 'smart-latest', label: 'Smart', enabled: true },
              { id: 'disabled-model', label: 'Disabled', enabled: false },
              { id: 'deepseek-v4-pro', description: 'Reasoning', enabled: true },
              { id: 'standard-chat', label: 'Standard Chat', enabled: true },
              { id: 'deepseek-v4-pro', label: 'Duplicate' },
            ],
          },
        },
      },
    }));
    const { getManagedClientTextModelPolicy } = await loadService();

    await expect(getManagedClientTextModelPolicy({ refresh: true })).resolves.toEqual({
      defaultModel: 'smart-latest',
      fallbackModels: ['deepseek-v4-pro', 'standard-chat', 'deepseek-v4-flash'],
      defaultThinkingLevel: 'high',
      models: [
        { id: 'smart-latest', label: 'Smart' },
        { id: 'deepseek-v4-pro', description: 'Reasoning' },
        { id: 'standard-chat', label: 'Standard Chat' },
        { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', visible: false },
      ],
    });
    expect(mocks.store.get('textModelPolicy')).toEqual({
      version: 3,
      policiesByOrigin: {
        'https://uclaw.example.test': expect.objectContaining({
          defaultModel: 'smart-latest',
          fallbackModels: ['deepseek-v4-pro', 'standard-chat', 'deepseek-v4-flash'],
          defaultThinkingLevel: 'high',
        }),
      },
    });
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      '[managed-client-config] Managed text fallback policy accepted',
      expect.objectContaining({
        event: 'managed_text_fallback_policy',
        result: 'accepted',
        fallbackModels: ['deepseek-v4-pro', 'standard-chat', 'deepseek-v4-flash'],
      }),
    );
  });

  it('hides an existing default fallback model from the picker', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        modelOptions: {
          text: {
            defaultModel: 'smart-latest',
            models: [
              { id: 'smart-latest', label: 'Smart' },
              { id: UCLAW_DEFAULT_FALLBACK_MODEL, label: 'DeepSeek V4 Flash' },
            ],
          },
        },
      },
    }));
    const { getManagedClientTextModelPolicy } = await loadService();

    await expect(getManagedClientTextModelPolicy({ refresh: true })).resolves.toEqual({
      defaultModel: 'smart-latest',
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: 'smart-latest', label: 'Smart' }, hiddenDefaultFallbackModel],
    });
  });

  it('applies artifact and ecommerce rollout before exposing runtime features', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        observability: {
          enabled: true,
          rolloutPercentage: 100,
          sentryDsn: 'https://public@sentry.example.test/42',
          tunnelPath: '/api/clawx/observability/envelope',
          crashSampleRate: 1,
          handledErrorSampleRate: 0.2,
          tracesSampleRate: 0.05,
          artifactSampleRate: 0.2,
          maxEventsPerHour: 30,
        },
        features: {
          artifacts: {
            enabled: true,
            rolloutPercentage: 100,
            eligible: false,
            modelAlias: 'uclaw-artifact-v1',
            policyVersion: 'v1',
          },
          ecommerceMainImage: {
            enabled: true,
            rolloutPercentage: 100,
            eligible: false,
            skillVersion: 'v1',
          },
          htmlPreview: { enabled: true, rolloutPercentage: 100, eligible: false },
          longTermRules: { enabled: true, rolloutPercentage: 100, eligible: false },
        },
      },
    }));
    const { getManagedClientRuntimeConfig } = await loadService();

    await expect(getManagedClientRuntimeConfig({ refresh: true })).resolves.toEqual({
      observability: {
        enabled: true,
        rolloutPercentage: 100,
        sentryDsn: 'https://public@sentry.example.test/42',
        tunnelPath: '/api/clawx/observability/envelope',
        crashSampleRate: 1,
        handledErrorSampleRate: 0.2,
        tracesSampleRate: 0.05,
        artifactSampleRate: 0.2,
        maxEventsPerHour: 30,
      },
      features: {
        artifacts: {
          enabled: true,
          rolloutPercentage: 100,
          eligible: false,
          modelAlias: 'uclaw-artifact-v1',
          policyVersion: 'v1',
        },
        ecommerceMainImage: {
          enabled: true,
          rolloutPercentage: 100,
          eligible: false,
          skillVersion: 'v1',
        },
        htmlPreview: { enabled: true, rolloutPercentage: 100, eligible: false },
        longTermRules: { enabled: true, rolloutPercentage: 100, eligible: false },
      },
    });
  });

  it('uses the backend-compatible artifact rollout hash vectors', async () => {
    const {
      managedRuntimeRolloutBucket,
      managedRuntimeRolloutBucketForNormalizedInstallationId,
      normalizeManagedRuntimeInstallationId,
    } = await loadService();
    expect(managedRuntimeRolloutBucketForNormalizedInstallationId(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'artifacts',
    )).toBe(9961);
    expect(managedRuntimeRolloutBucketForNormalizedInstallationId(
      'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
      'artifacts',
    )).toBe(3084);
    expect(managedRuntimeRolloutBucketForNormalizedInstallationId(
      '0000000000000000000000000000000000000000000000000000000000000000',
      'artifacts',
    )).toBe(3437);
    expect(managedRuntimeRolloutBucket('550e8400-e29b-41d4-a716-446655440000', 'artifacts')).toBe(6100);
    expect(managedRuntimeRolloutBucket('LEGACY-MACHINE-ID-ABC', 'artifacts')).toBe(9225);
    expect(normalizeManagedRuntimeInstallationId('550e8400-e29b-41d4-a716-446655440000'))
      .toBe('a3a9e1ed9732cab28868127be00f1ce921acaefdd5c3b23a6e9e0072bd9c1a34');
    expect(normalizeManagedRuntimeInstallationId(
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    )).toBe('df0790f236013511e91fa4532fb7761f62320a51a3868dabf4a13fe5f53e3263');
    expect(normalizeManagedRuntimeInstallationId('')).toBeNull();
  });

  it('sends the normalized UUID hash used by both client and backend rollout buckets', async () => {
    mocks.installationId = '550e8400-e29b-41d4-a716-446655440000';
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        features: {
          htmlPreview: { enabled: true, rolloutPercentage: 100, eligible: false },
        },
      },
    }));
    const { getManagedClientRuntimeConfig } = await loadService();

    await expect(getManagedClientRuntimeConfig({ refresh: true }))
      .resolves.toMatchObject({ features: { htmlPreview: { enabled: true } } });
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://uclaw.example.test/api/clawx/client-config',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-UClaw-Install-Id': 'a3a9e1ed9732cab28868127be00f1ce921acaefdd5c3b23a6e9e0072bd9c1a34',
        }),
      }),
    );
  });

  it('fails percentage rollouts closed when the installation identity is unavailable', async () => {
    mocks.installationIdError = new Error('installation identity unavailable');
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        observability: {
          enabled: true,
          rolloutPercentage: 100,
          sentryDsn: 'https://public@sentry.example.test/42',
          tunnelPath: '/api/clawx/observability/envelope',
          crashSampleRate: 1,
          handledErrorSampleRate: 0.2,
          tracesSampleRate: 0.05,
          artifactSampleRate: 0.2,
          maxEventsPerHour: 30,
        },
        features: {
          artifacts: {
            enabled: true,
            rolloutPercentage: 100,
            eligible: false,
            modelAlias: 'uclaw-artifact-v1',
            policyVersion: 'v1',
          },
          ecommerceMainImage: { enabled: true, rolloutPercentage: 100, eligible: false, skillVersion: 'v1' },
          htmlPreview: { enabled: true, rolloutPercentage: 100, eligible: false },
          longTermRules: { enabled: true, rolloutPercentage: 100, eligible: false },
        },
      },
    }));
    const { getManagedClientRuntimeConfig } = await loadService();
    const config = await getManagedClientRuntimeConfig({ refresh: true });

    expect(config.observability.enabled).toBe(false);
    expect(config.features.artifacts.enabled).toBe(false);
    expect(config.features.ecommerceMainImage.enabled).toBe(false);
    expect(config.features.htmlPreview.enabled).toBe(false);
    expect(config.features.longTermRules.enabled).toBe(false);
    expect(mocks.fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('X-UClaw-Install-Id');
  });

  it('fails closed per runtime capability for missing or malformed remote gates', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        observability: {
          enabled: true,
          rolloutPercentage: '100',
          sentryDsn: 'https://public@sentry.example.test/42',
          tunnelPath: '/api/clawx/observability/envelope',
          crashSampleRate: 1,
          handledErrorSampleRate: 0.2,
          tracesSampleRate: 0.05,
          artifactSampleRate: 0.2,
          maxEventsPerHour: 30,
        },
        features: {
          artifacts: { enabled: true, rolloutPercentage: 100, modelAlias: 'uclaw-artifact-v1', policyVersion: 'v1' },
          ecommerceMainImage: { enabled: true, rolloutPercentage: 100, skillVersion: 'v1' },
          htmlPreview: { enabled: true, rolloutPercentage: 101 },
          longTermRules: { enabled: 'true', rolloutPercentage: 100 },
        },
      },
    }));
    const { getManagedClientRuntimeConfig } = await loadService();
    const config = await getManagedClientRuntimeConfig({ refresh: true });

    expect(config.observability.enabled).toBe(false);
    expect(config.features.artifacts.enabled).toBe(true);
    expect(config.features.ecommerceMainImage.enabled).toBe(true);
    expect(config.features.htmlPreview).toEqual({ enabled: false, rolloutPercentage: 0, eligible: false });
    expect(config.features.longTermRules).toEqual({ enabled: false, rolloutPercentage: 100, eligible: false });
  });

  it('keeps each remote stop switch effective even when its rollout is 100 percent', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        observability: { enabled: false, rolloutPercentage: 100 },
        features: {
          artifacts: { enabled: false, rolloutPercentage: 100 },
          ecommerceMainImage: { enabled: false, rolloutPercentage: 100 },
          htmlPreview: { enabled: false, rolloutPercentage: 100 },
          longTermRules: { enabled: false, rolloutPercentage: 100 },
        },
      },
    }));
    const { getManagedClientRuntimeConfig } = await loadService();
    const config = await getManagedClientRuntimeConfig({ refresh: true });

    expect(config.observability.enabled).toBe(false);
    expect(config.features.artifacts.enabled).toBe(false);
    expect(config.features.ecommerceMainImage.enabled).toBe(false);
    expect(config.features.htmlPreview.enabled).toBe(false);
    expect(config.features.longTermRules.enabled).toBe(false);
  });

  it('fails observability closed when the remote object contains an unknown field', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        observability: {
          enabled: true,
          rolloutPercentage: 100,
          sentryDsn: 'https://public@sentry.example.test/42',
          tunnelPath: '/api/clawx/observability/envelope',
          crashSampleRate: 1,
          handledErrorSampleRate: 0.2,
          tracesSampleRate: 0.05,
          artifactSampleRate: 0.2,
          maxEventsPerHour: 30,
          unexpected: true,
        },
      },
    }));
    const { getManagedClientRuntimeConfig } = await loadService();

    await expect(getManagedClientRuntimeConfig({ refresh: true }))
      .resolves.toMatchObject({ observability: { enabled: false } });
  });

  it('accepts server eligibility for a zero-percent internal account without exposing IDs', async () => {
    mocks.secret = { type: 'oauth', accessToken: 'test-access-token' };
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        features: {
          artifacts: {
            enabled: true,
            rolloutPercentage: 0,
            eligible: true,
            modelAlias: 'uclaw-artifact-v1',
            policyVersion: 'v1',
          },
          ecommerceMainImage: { enabled: false, rolloutPercentage: 0, eligible: false },
          htmlPreview: { enabled: false, rolloutPercentage: 0, eligible: false },
          longTermRules: { enabled: false, rolloutPercentage: 0, eligible: false },
        },
      },
    }));
    const { getManagedClientRuntimeConfig } = await loadService();
    const config = await getManagedClientRuntimeConfig({ refresh: true });

    expect(config.features.artifacts.enabled).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://uclaw.example.test/api/clawx/client-config',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-access-token',
          'X-UClaw-Install-Id': 'df0790f236013511e91fa4532fb7761f62320a51a3868dabf4a13fe5f53e3263',
        }),
      }),
    );
  });

  it('rejects unknown artifact aliases even when the remote gate says enabled', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        features: {
          artifacts: {
            enabled: true,
            rolloutPercentage: 100,
            eligible: true,
            modelAlias: 'uclaw-artifact-v2',
            policyVersion: 'v2',
          },
        },
      },
    }));
    const { getManagedClientRuntimeConfig } = await loadService();
    const config = await getManagedClientRuntimeConfig({ refresh: true });

    expect(config.features.artifacts.enabled).toBe(false);
    expect(config.features.artifacts.modelAlias).toBe('uclaw-artifact-v1');
  });

  it('keeps ordinary snapshot reads offline and refreshes high-risk switches in the background', async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ data: { features: { htmlPreview: { enabled: true, rolloutPercentage: 100 } } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { features: { htmlPreview: { enabled: false, rolloutPercentage: 100 } } } }));
    const { getManagedClientRuntimeConfig, refreshManagedClientRuntimeConfig } = await loadService();

    expect((await getManagedClientRuntimeConfig({ refresh: true })).features.htmlPreview.enabled).toBe(true);
    now += 14_999;
    expect((await getManagedClientRuntimeConfig()).features.htmlPreview.enabled).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    now += 2;
    expect((await getManagedClientRuntimeConfig()).features.htmlPreview.enabled).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect((await refreshManagedClientRuntimeConfig()).config.features.htmlPreview.enabled).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('fails closed after an offline refresh and negative-caches the result for fifteen seconds', async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ data: { features: { htmlPreview: { enabled: true, rolloutPercentage: 100 } } } }))
      .mockRejectedValueOnce(new Error('offline'));
    const { getManagedClientRuntimeConfig, refreshManagedClientRuntimeConfig } = await loadService();

    expect((await getManagedClientRuntimeConfig({ refresh: true })).features.htmlPreview.enabled).toBe(true);
    now += 15_001;
    expect((await refreshManagedClientRuntimeConfig()).config.features.htmlPreview.enabled).toBe(false);
    expect((await getManagedClientRuntimeConfig()).features.htmlPreview.enabled).toBe(false);
    await refreshManagedClientRuntimeConfig();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('uses one in-flight runtime request and publishes an epoch transition to subscribers', async () => {
    let resolveFetch!: (response: Response) => void;
    mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const {
      getManagedClientRuntimeConfigSnapshot,
      refreshManagedClientRuntimeConfig,
      subscribeManagedClientRuntimeConfig,
    } = await loadService();
    const changes: Array<[number, number]> = [];
    const unsubscribe = subscribeManagedClientRuntimeConfig((current, previous) => {
      changes.push([previous.epoch, current.epoch]);
    });

    const first = refreshManagedClientRuntimeConfig({ force: true });
    const second = refreshManagedClientRuntimeConfig({ force: true });
    expect(getManagedClientRuntimeConfigSnapshot().config.features.htmlPreview.enabled).toBe(false);
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    resolveFetch(jsonResponse({ data: { features: { htmlPreview: { enabled: true, rolloutPercentage: 100 } } } }));
    const [left, right] = await Promise.all([first, second]);

    expect(left.config.features.htmlPreview.enabled).toBe(true);
    expect(right.epoch).toBe(left.epoch);
    expect(changes).toEqual([[0, 1]]);
    unsubscribe();
  });

  it('rechecks runtime gates after fifteen seconds and stops the watcher cleanly', async () => {
    vi.useFakeTimers();
    let stop = () => undefined;
    try {
      mocks.fetch
        .mockResolvedValueOnce(jsonResponse({ data: { features: { htmlPreview: { enabled: true, rolloutPercentage: 100 } } } }))
        .mockResolvedValueOnce(jsonResponse({ data: { features: { htmlPreview: { enabled: false, rolloutPercentage: 100 } } } }));
      const {
        getManagedClientRuntimeConfigSnapshot,
        startManagedClientRuntimeConfigRefresh,
      } = await loadService();

      stop = startManagedClientRuntimeConfigRefresh();
      await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
      expect(getManagedClientRuntimeConfigSnapshot().config.features.htmlPreview.enabled).toBe(true);

      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
      expect(getManagedClientRuntimeConfigSnapshot().config.features.htmlPreview.enabled).toBe(false);

      stop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it('keeps dependent ecommerce UI disabled when the artifact rollout is off', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        features: {
          artifacts: {
            enabled: true,
            rolloutPercentage: 0,
            modelAlias: 'uclaw-artifact-v1',
            policyVersion: 'v1',
          },
          ecommerceMainImage: {
            enabled: true,
            rolloutPercentage: 100,
            skillVersion: 'v1',
          },
        },
      },
    }));
    const { getManagedClientRuntimeConfig } = await loadService();
    const config = await getManagedClientRuntimeConfig({ refresh: true });

    expect(config.features.artifacts.enabled).toBe(false);
    expect(config.features.ecommerceMainImage.enabled).toBe(false);
  });

  it('normalizes dynamic image models and keeps future quality tokens', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        modelOptions: {
          image: {
            defaultModel: 'future-image-model',
            defaultSize: '3000x2000',
            defaultQuality: 'ultra',
            models: [
              {
                id: 'future-image-model',
                label: 'Future Image',
                sizes: ['2048x2048', '3000x2000', 'invalid'],
                qualities: ['standard', 'ultra', 'ultra'],
                defaultSize: '2048x2048',
                defaultQuality: 'standard',
                supportsEditing: true,
                enabled: true,
              },
            ],
          },
        },
      },
    }));
    const { getManagedClientImageModelPolicy } = await loadService();

    await expect(getManagedClientImageModelPolicy({ refresh: true })).resolves.toEqual({
      defaultModel: 'future-image-model',
      defaultSize: '3000x2000',
      defaultQuality: 'ultra',
      models: [
        {
          id: 'future-image-model',
          label: 'Future Image',
          sizes: ['2048x2048', '3000x2000'],
          qualities: ['standard', 'ultra'],
          defaultSize: '2048x2048',
          defaultQuality: 'standard',
          supportsEditing: true,
        },
      ],
    });
    expect(mocks.store.get('imageModelPolicy')).toEqual({
      version: 1,
      policiesByOrigin: {
        'https://uclaw.example.test': {
          policy: expect.objectContaining({ defaultModel: 'future-image-model' }),
          verifiedAt: expect.any(Number),
        },
      },
    });
  });

  it('keeps exact video sizes and derives dynamic display values without a local model allowlist', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        modelOptions: {
          video: {
            defaultModel: 'future-video-model',
            defaultSize: '2560x1080',
            defaultDurationSeconds: 21,
            models: [{
              id: 'future-video-model',
              label: 'Future Video',
              modes: ['text-to-video', 'storyboard-to-video'],
              sizes: ['1280x720', '2560x1080', 'bad-size'],
              resolutions: ['720P', 'cinema-ultra'],
              durations: [7, 21, -1],
              defaultSize: '1280x720',
              defaultResolution: '720P',
              defaultDurationSeconds: 7,
            }],
          },
        },
      },
    }));
    const { getManagedClientVideoModelPolicy } = await loadService();

    await expect(getManagedClientVideoModelPolicy({ refresh: true })).resolves.toEqual({
      defaultModel: 'future-video-model',
      defaultSize: '2560x1080',
      defaultAspectRatio: '64:27',
      defaultResolution: '720P',
      defaultDurationSeconds: 21,
      models: [{
        id: 'future-video-model',
        label: 'Future Video',
        modes: ['text-to-video', 'storyboard-to-video'],
        sizes: ['1280x720', '2560x1080'],
        aspectRatios: ['16:9', '64:27'],
        resolutions: ['720P', 'cinema-ultra'],
        durations: [7, 21],
        defaultSize: '1280x720',
        defaultAspectRatio: '16:9',
        defaultResolution: '720P',
        defaultDurationSeconds: 7,
        requiresImage: false,
      }],
    });
  });

  it('keeps backend defaultSize 1280x720 as the exact upstream value while deriving 720P', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        modelOptions: {
          video: {
            defaultModel: 'server-video',
            defaultSize: '1280x720',
            defaultDurationSeconds: 10,
            models: [{
              id: 'server-video',
              modes: ['text-to-video'],
              sizes: ['720x1280', '1280x720'],
              durations: [6, 10],
              defaultSize: '720x1280',
              defaultDurationSeconds: 6,
            }],
          },
        },
      },
    }));
    const { getManagedClientVideoModelPolicy } = await loadService();

    await expect(getManagedClientVideoModelPolicy({ refresh: true })).resolves.toMatchObject({
      defaultSize: '1280x720',
      defaultAspectRatio: '16:9',
      defaultResolution: '720P',
      defaultDurationSeconds: 10,
      models: [{ sizes: ['720x1280', '1280x720'] }],
    });
  });

  it('fails closed for missing or empty managed media catalogs', async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ data: { modelOptions: { image: { models: [] } } } }))
      .mockRejectedValueOnce(new Error('offline'));
    const {
      getManagedClientImageModelPolicy,
      getManagedClientVideoModelPolicy,
    } = await loadService();

    await expect(getManagedClientImageModelPolicy({ refresh: true })).resolves.toBeNull();
    await expect(getManagedClientVideoModelPolicy({ refresh: true })).resolves.toBeNull();
  });

  it('uses only unexpired verified media cache entries and rejects legacy timestamp-free cache', async () => {
    let now = 50_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    mocks.store.set('imageModelPolicy', {
      version: 1,
      policiesByOrigin: {
        'https://uclaw.example.test': {
          verifiedAt: now,
          policy: {
            defaultModel: 'cached-image',
            defaultSize: '2048x2048',
            defaultQuality: 'ultra',
            models: [{
              id: 'cached-image',
              sizes: ['2048x2048'],
              qualities: ['ultra'],
              defaultSize: '2048x2048',
              defaultQuality: 'ultra',
              supportsEditing: false,
            }],
          },
        },
      },
    });
    mocks.store.set('videoModelPolicy', {
      version: 1,
      policiesByOrigin: {
        'https://uclaw.example.test': {
          defaultModel: 'legacy-video-without-verified-at',
          models: [],
        },
      },
    });
    const {
      getManagedClientImageModelPolicy,
      getManagedClientVideoModelPolicy,
    } = await loadService();

    await expect(getManagedClientImageModelPolicy()).resolves.toMatchObject({
      defaultModel: 'cached-image',
    });
    await expect(getManagedClientVideoModelPolicy()).resolves.toBeNull();
    now += UCLAW_SUPPORT_REFRESH_INTERVAL_MS;
    await expect(getManagedClientImageModelPolicy()).resolves.toBeNull();
    nowSpy.mockRestore();
  });

  it('commits image policy while refreshing video from the same payload and exposes safe snapshots', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        modelOptions: {
          image: {
            defaultModel: 'future-image',
            defaultSize: '4096x2048',
            defaultQuality: 'ultra',
            models: [{
              id: 'future-image',
              sizes: ['4096x2048'],
              qualities: ['ultra'],
              defaultSize: '4096x2048',
              defaultQuality: 'ultra',
            }],
          },
          video: {
            defaultModel: 'future-video',
            defaultSize: '1280x720',
            defaultDurationSeconds: 12,
            models: [{
              id: 'future-video',
              modes: ['text-to-video'],
              sizes: ['1280x720'],
              durations: [12],
            }],
          },
        },
      },
    }));
    const {
      getManagedClientVideoModelPolicy,
      getVerifiedManagedClientImageModelPolicySnapshot,
      getVerifiedManagedClientVideoModelPolicySnapshot,
    } = await loadService();

    await expect(getManagedClientVideoModelPolicy({ refresh: true })).resolves.toMatchObject({
      defaultModel: 'future-video',
      defaultSize: '1280x720',
    });
    expect(getVerifiedManagedClientImageModelPolicySnapshot()).toMatchObject({
      defaultModel: 'future-image',
      defaultQuality: 'ultra',
    });
    expect(getVerifiedManagedClientVideoModelPolicySnapshot()).toMatchObject({
      defaultModel: 'future-video',
      defaultSize: '1280x720',
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('commits image alongside text and video from an embedded login payload', async () => {
    const { cacheManagedClientModelPoliciesFromPayload } = await loadService();
    const result = await cacheManagedClientModelPoliciesFromPayload({
      client: {
        modelOptions: {
          text: { defaultModel: 'smart-latest', models: [{ id: 'smart-latest' }] },
          image: {
            defaultModel: 'embedded-image',
            defaultSize: '2048x2048',
            defaultQuality: 'ultra',
            models: [{
              id: 'embedded-image',
              sizes: ['2048x2048'],
              qualities: ['ultra'],
            }],
          },
          video: {
            defaultModel: 'embedded-video',
            defaultSize: '1920x1080',
            defaultDurationSeconds: 9,
            models: [{
              id: 'embedded-video',
              modes: ['text-to-video'],
              sizes: ['1920x1080'],
              durations: [9],
            }],
          },
        },
      },
    });

    expect(result.image).toMatchObject({ defaultModel: 'embedded-image' });
    expect(result.video).toMatchObject({ defaultModel: 'embedded-video', defaultSize: '1920x1080' });
    expect(mocks.fetch).not.toHaveBeenCalled();
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
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: 'smart-latest', label: 'Smart' }, hiddenDefaultFallbackModel],
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
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: UCLAW_DEFAULT_MODEL }, hiddenDefaultFallbackModel],
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
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [
        { id: 'smart-latest', label: 'Smart' },
        { id: 'reasoning-pro', label: 'Reasoning' },
        hiddenDefaultFallbackModel,
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
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }, hiddenDefaultFallbackModel],
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
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: 'cached-model', label: 'Cached' }, hiddenDefaultFallbackModel],
    });
  });

  it('uses the centralized default when no verified policy exists', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('offline'));
    const { getManagedClientTextModelPolicy } = await loadService();

    await expect(getManagedClientTextModelPolicy({ refresh: true })).resolves.toEqual({
      defaultModel: UCLAW_DEFAULT_MODEL,
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: UCLAW_DEFAULT_MODEL }, hiddenDefaultFallbackModel],
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
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: 'smart-latest', label: 'Smart' }, hiddenDefaultFallbackModel],
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
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: 'login-current-model', label: 'Current' }, hiddenDefaultFallbackModel],
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
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: 'first-model' }, hiddenDefaultFallbackModel],
    });

    mocks.origin = 'https://second.example.test';
    mocks.fetch.mockRejectedValueOnce(new Error('second origin offline'));
    await expect(getManagedClientTextModelPolicy({ refresh: true })).resolves.toEqual({
      defaultModel: UCLAW_DEFAULT_MODEL,
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: UCLAW_DEFAULT_MODEL }, hiddenDefaultFallbackModel],
    });

    mocks.origin = 'https://first.example.test';
    await expect(getManagedClientTextModelPolicy()).resolves.toEqual({
      defaultModel: 'first-model',
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: 'first-model' }, hiddenDefaultFallbackModel],
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
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: 'embedded-new', label: 'Embedded New' }, hiddenDefaultFallbackModel],
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
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: 'embedded-new', label: 'Embedded New' }, hiddenDefaultFallbackModel],
    });
    await expect(getManagedClientTextModelPolicy()).resolves.toEqual({
      defaultModel: 'embedded-new',
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: 'embedded-new', label: 'Embedded New' }, hiddenDefaultFallbackModel],
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
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: 'embedded-new', label: 'Embedded New' }, hiddenDefaultFallbackModel],
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
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: 'embedded-new', label: 'Embedded New' }, hiddenDefaultFallbackModel],
    });
    await expect(getManagedClientTextModelPolicy()).resolves.toEqual({
      defaultModel: 'embedded-new',
      fallbackModels: defaultFallbackModels,
      defaultThinkingLevel: UCLAW_DEFAULT_THINKING_LEVEL,
      models: [{ id: 'embedded-new', label: 'Embedded New' }, hiddenDefaultFallbackModel],
    });
  });
});
