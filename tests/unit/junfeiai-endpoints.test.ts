// @vitest-environment node

import { describe, expect, it } from 'vitest';
import rawConfig from '@shared/junfeiai-endpoints.json';
import {
  UCLAW_AUTH_REQUEST_TIMEOUT_MS,
  UCLAW_BILLING_HISTORY_PAGE_SIZE,
  UCLAW_BILLING_ORDER_STATUS_POLL_INTERVAL_MS,
  UCLAW_BILLING_ROUTES,
  UCLAW_COMPACTION_MODE,
  UCLAW_COMPACTION_RESERVE_TOKENS_FLOOR,
  UCLAW_DEFAULT_API_PROTOCOL,
  UCLAW_DEFAULT_MODEL,
  UCLAW_EXEC_ASK,
  UCLAW_EXEC_SECURITY,
  UCLAW_MANAGED_ACCOUNT_ID,
  UCLAW_MANAGED_PROVIDER_BASE_URL,
  UCLAW_MANAGED_PROVIDER_ID,
  UCLAW_MANAGED_SERVICE_NAME,
  UCLAW_MARKETPLACE_CONFIG,
  UCLAW_MARKETPLACE_DEFAULT_PROVIDER,
  UCLAW_PRODUCTION_ORIGIN,
  UCLAW_SUPPORT_REFRESH_INTERVAL_MS,
  UCLAW_SUPPORT_REQUEST_TIMEOUT_MS,
  UCLAW_SUPPORT_ROUTES,
  UCLAW_VIDEO_GENERATION_PREFERRED_RESOLUTION,
  UCLAW_VIDEO_GENERATION_PREFERRED_SHORT_EDGE,
  validateUclawEndpointsConfig,
} from '@shared/junfeiai-endpoints';
import {
  getUclawBackendOrigin,
  getUclawProviderBaseUrl,
  UCLAW_AUTH_ACCOUNT_ID,
} from '@electron/utils/junfeiai-distribution';

type MutableTestConfig = {
  provider: {
    productionOrigin: string;
    providerName: string;
    defaultApiProtocol: string;
  };
  auth: {
    requestTimeoutMs: number;
  };
  billing: {
    requestTimeoutMs: number;
    routes: { overview: string };
  };
  support: {
    requestTimeoutMs: number;
    refreshIntervalMs: number;
    routes: { clientConfig: string };
  };
  media: {
    image: { defaultSize: string };
    video: { preferredResolution: string };
  };
  marketplace: {
    skillHubApiOrigin: string;
    requestTimeoutMs: number;
  };
};

describe('UClaw managed endpoint configuration', () => {
  it('keeps the managed OpenAI runtime contract centralized and fixed', () => {
    expect(UCLAW_MANAGED_PROVIDER_ID).toBe('openai');
    expect(UCLAW_MANAGED_ACCOUNT_ID).toBe('openai');
    expect(UCLAW_AUTH_ACCOUNT_ID).toBe('uclaw-auth');
    expect(UCLAW_DEFAULT_MODEL).toBe('smart-latest');
    expect(UCLAW_DEFAULT_API_PROTOCOL).toBe('openai-responses');
    expect(UCLAW_PRODUCTION_ORIGIN).toBe('https://zz-cn.lingzhiwuxian.com');
    expect(UCLAW_MANAGED_PROVIDER_BASE_URL).toBe('https://zz-cn.lingzhiwuxian.com/v1');
  });

  it('exposes only the UClaw service name and validated positive timeouts', () => {
    expect(UCLAW_MANAGED_SERVICE_NAME).toBe('UClaw');
    expect(getUclawBackendOrigin()).toBe(UCLAW_PRODUCTION_ORIGIN);
    expect(getUclawProviderBaseUrl()).toBe(UCLAW_MANAGED_PROVIDER_BASE_URL);
    expect(UCLAW_AUTH_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('accepts an HTTP origin for a locally configured backend', () => {
    const config = structuredClone(rawConfig) as unknown as MutableTestConfig;
    config.provider.productionOrigin = 'http://127.0.0.1:8083';

    expect(validateUclawEndpointsConfig(config).provider.productionOrigin).toBe('http://127.0.0.1:8083');
  });

  it('keeps provider, auth, billing, support, marketplace, runtime, and media settings in explicit sections', () => {
    expect(Object.keys(rawConfig).sort()).toEqual([
      'auth',
      'billing',
      'marketplace',
      'media',
      'provider',
      'runtimeDefaults',
      'support',
    ]);
    expect(UCLAW_EXEC_SECURITY).toBe('full');
    expect(UCLAW_EXEC_ASK).toBe('off');
    expect(UCLAW_COMPACTION_MODE).toBe('safeguard');
    expect(UCLAW_COMPACTION_RESERVE_TOKENS_FLOOR).toBe(50_000);
    expect(UCLAW_VIDEO_GENERATION_PREFERRED_RESOLUTION).toBe('480p');
    expect(UCLAW_VIDEO_GENERATION_PREFERRED_SHORT_EDGE).toBe(480);
    expect(UCLAW_MARKETPLACE_DEFAULT_PROVIDER).toBe('skillhub');
    expect(UCLAW_MARKETPLACE_CONFIG.skillHubApiOrigin).toBe('https://api.skillhub.cn');
    expect(UCLAW_BILLING_ORDER_STATUS_POLL_INTERVAL_MS).toBe(2_000);
    expect(UCLAW_BILLING_HISTORY_PAGE_SIZE).toBe(20);
    expect(UCLAW_BILLING_ROUTES.overview).toBe('/api/clawx/billing/checkout-info');
    expect(UCLAW_SUPPORT_REQUEST_TIMEOUT_MS).toBe(8_000);
    expect(UCLAW_SUPPORT_REFRESH_INTERVAL_MS).toBe(600_000);
    expect(UCLAW_SUPPORT_ROUTES.clientConfig).toBe('/api/clawx/client-config');
    expect(UCLAW_SUPPORT_ROUTES.bootstrap).toBe('/api/clawx/bootstrap');
  });

  it.each([
    ['unsupported production origin protocol', (config: MutableTestConfig) => { config.provider.productionOrigin = 'ftp://example.com'; }],
    ['non-UClaw visible provider name', (config: MutableTestConfig) => { config.provider.providerName = 'Legacy Brand'; }],
    ['unsupported API protocol', (config: MutableTestConfig) => { config.provider.defaultApiProtocol = 'anthropic-messages'; }],
    ['non-positive auth timeout', (config: MutableTestConfig) => { config.auth.requestTimeoutMs = 0; }],
    ['non-positive billing timeout', (config: MutableTestConfig) => { config.billing.requestTimeoutMs = 0; }],
    ['invalid billing route', (config: MutableTestConfig) => { config.billing.routes.overview = 'https://example.com/billing'; }],
    ['non-positive support timeout', (config: MutableTestConfig) => { config.support.requestTimeoutMs = 0; }],
    ['non-positive support refresh interval', (config: MutableTestConfig) => { config.support.refreshIntervalMs = 0; }],
    ['invalid support route', (config: MutableTestConfig) => { config.support.routes.clientConfig = 'https://example.com/support'; }],
    ['invalid image size', (config: MutableTestConfig) => { config.media.image.defaultSize = 'large'; }],
    ['invalid video resolution', (config: MutableTestConfig) => { config.media.video.preferredResolution = '480'; }],
    ['insecure marketplace origin', (config: MutableTestConfig) => { config.marketplace.skillHubApiOrigin = 'http://example.com'; }],
    ['non-positive marketplace timeout', (config: MutableTestConfig) => { config.marketplace.requestTimeoutMs = 0; }],
  ])('rejects %s', (_name, mutate) => {
    const config = structuredClone(rawConfig) as unknown as MutableTestConfig;
    mutate(config);
    expect(() => validateUclawEndpointsConfig(config)).toThrow(/junfeiai-endpoints\.json/);
  });
});
