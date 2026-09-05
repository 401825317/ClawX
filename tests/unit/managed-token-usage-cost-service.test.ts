// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProviderAccount: vi.fn(),
  getProviderSecret: vi.fn(),
  proxyAwareFetch: vi.fn(),
  resolveRelayToken: vi.fn(),
  withProviderMutationLock: vi.fn(),
}));

vi.mock('@electron/utils/junfeiai-distribution', () => ({
  UCLAW_AUTH_ACCOUNT_ID: 'uclaw-auth',
  UCLAW_COMPATIBILITY_PROVIDER_ID: 'lingzhiwuxian',
  UCLAW_PROVIDER_ID: 'openai',
  getUclawBackendOrigin: () => 'https://production.example.test',
}));

vi.mock('@electron/utils/logger', () => ({
  logger: { debug: vi.fn() },
}));

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

vi.mock('@electron/services/providers/provider-store', () => ({
  getProviderAccount: mocks.getProviderAccount,
}));

vi.mock('@electron/services/providers/provider-mutation-lock', () => ({
  resolveValidUclawManagedRelayPairToken: mocks.resolveRelayToken,
  withProviderMutationLock: mocks.withProviderMutationLock,
}));

vi.mock('@electron/services/secrets/secret-store', () => ({
  getProviderSecret: mocks.getProviderSecret,
}));

import {
  enrichManagedTokenUsageCosts,
  getManagedTokenCostSnapshot,
  parseManagedTokenCostSnapshot,
  resetManagedTokenCostCacheForTests,
  type ManagedSettledUsageLog,
  type ManagedTokenCostSnapshot,
} from '@electron/services/managed-token-usage-cost-service';
import type { TokenUsageHistoryEntry } from '@electron/utils/token-usage-core';

const PRODUCTION_SAMPLE_TIMESTAMP = '2026-09-05T06:41:28.685Z';
const PRODUCTION_LOG_TIMESTAMP = '2026-09-05T06:41:27.000Z';

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetManagedTokenCostCacheForTests();
  mocks.withProviderMutationLock.mockImplementation(
    async (task: () => Promise<unknown>) => task(),
  );
  mocks.getProviderAccount.mockResolvedValue({ id: 'managed-account' });
  mocks.getProviderSecret.mockResolvedValue({ type: 'test-secret' });
  mocks.resolveRelayToken.mockReturnValue('validated-relay-key');
});

function managedEntry(
  overrides: Partial<TokenUsageHistoryEntry> = {},
): TokenUsageHistoryEntry {
  return {
    timestamp: PRODUCTION_SAMPLE_TIMESTAMP,
    sessionId: 'agent-session-managed-zero-cost',
    agentId: 'main',
    model: 'smart-latest',
    provider: 'openai',
    usageStatus: 'available',
    inputTokens: 12_206,
    outputTokens: 391,
    cacheReadTokens: 19_456,
    cacheWriteTokens: 0,
    totalTokens: 32_053,
    costUnavailable: true,
    ...overrides,
  };
}

function settledLog(
  overrides: Partial<ManagedSettledUsageLog> = {},
): ManagedSettledUsageLog {
  return {
    createdAtMs: Date.parse(PRODUCTION_LOG_TIMESTAMP),
    model: 'smart-latest',
    quota: 26_809,
    promptTokens: 31_662,
    completionTokens: 391,
    ...overrides,
  };
}

function snapshot(
  logs: ManagedSettledUsageLog[],
  quotaPerUnit = 500_000,
): ManagedTokenCostSnapshot {
  return { quotaPerUnit, logs };
}

describe('managed token usage cost snapshot parsing', () => {
  it('parses the production-shaped consumption sample used for unique cost enrichment', () => {
    const result = parseManagedTokenCostSnapshot(
      {
        success: true,
        data: [{
          type: 2,
          created_at: Date.parse(PRODUCTION_LOG_TIMESTAMP) / 1000,
          model_name: 'smart-latest',
          quota: 26_809,
          prompt_tokens: 31_662,
          completion_tokens: 391,
          request_id: 'server-request-1',
          upstream_request_id: 'upstream-request-1',
        }],
      },
      { success: true, data: { quota_per_unit: 500_000 } },
    );

    expect(result).toEqual({
      quotaPerUnit: 500_000,
      logs: [{
        createdAtMs: Date.parse(PRODUCTION_LOG_TIMESTAMP),
        model: 'smart-latest',
        quota: 26_809,
        promptTokens: 31_662,
        completionTokens: 391,
        requestId: 'server-request-1',
      }],
    });
  });

  it.each([
    ['failed token-log envelope', { success: false, data: [] }, { success: true, data: { quota_per_unit: 500_000 } }],
    ['missing token-log envelope', { data: [] }, { success: true, data: { quota_per_unit: 500_000 } }],
    ['non-array token-log data', { success: true, data: {} }, { success: true, data: { quota_per_unit: 500_000 } }],
    ['failed status envelope', { success: true, data: [] }, { success: false, data: { quota_per_unit: 500_000 } }],
  ])('rejects a malformed API envelope: %s', (_label, tokenLogPayload, statusPayload) => {
    expect(parseManagedTokenCostSnapshot(tokenLogPayload, statusPayload)).toBeNull();
  });

  it.each([0, -1, 'not-a-number', Number.POSITIVE_INFINITY])(
    'rejects invalid quotaPerUnit value %s',
    (quotaPerUnit) => {
      expect(parseManagedTokenCostSnapshot(
        { success: true, data: [] },
        { success: true, data: { quota_per_unit: quotaPerUnit } },
      )).toBeNull();
    },
  );

  it('filters non-consumption log types instead of treating them as settled usage', () => {
    const result = parseManagedTokenCostSnapshot(
      {
        success: true,
        data: [{
          type: 1,
          created_at: Date.parse(PRODUCTION_LOG_TIMESTAMP) / 1000,
          model_name: 'smart-latest',
          quota: 26_809,
          prompt_tokens: 31_662,
          completion_tokens: 391,
        }],
      },
      { success: true, data: { quota_per_unit: 500_000 } },
    );

    expect(result).toEqual({ quotaPerUnit: 500_000, logs: [] });
  });
});

describe('managed token usage cost enrichment', () => {
  it('applies the exact settled server charge to the production-shaped token sample', () => {
    const [result] = enrichManagedTokenUsageCosts(
      [managedEntry()],
      snapshot([settledLog()]),
    );

    expect(result.costUsd).toBe(0.053618);
    expect(result).not.toHaveProperty('costUnavailable');
  });

  it('matches a local model carrying its provider prefix', () => {
    const [result] = enrichManagedTokenUsageCosts(
      [managedEntry({ model: 'openai/smart-latest' })],
      snapshot([settledLog({ quota: 25_000 })]),
    );

    expect(result.costUsd).toBe(0.05);
    expect(result).not.toHaveProperty('costUnavailable');
  });

  it('prefers an exact provider request ID without relying on legacy matching fields', () => {
    const [result] = enrichManagedTokenUsageCosts(
      [managedEntry({
        providerRequestId: 'server-request-exact',
        timestamp: '2026-09-05T07:41:28.685Z',
        model: 'openai/smart-alias',
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
      })],
      snapshot([settledLog({
        requestId: 'server-request-exact',
        quota: 25_000,
      })]),
    );

    expect(result.costUsd).toBe(0.05);
    expect(result).not.toHaveProperty('costUnavailable');
  });

  it('does not fall back to time matching when a provider request ID is present', () => {
    const entry = managedEntry({ providerRequestId: 'server-request-local' });
    expect(enrichManagedTokenUsageCosts(
      [entry],
      snapshot([settledLog({ requestId: 'server-request-other' })]),
    )).toEqual([entry]);
  });

  it('does not apply a charge when more than one settled log matches', () => {
    const entry = managedEntry();
    const result = enrichManagedTokenUsageCosts(
      [entry],
      snapshot([
        settledLog({ quota: 10_000 }),
        settledLog({ quota: 20_000 }),
      ]),
    );

    expect(result).toEqual([entry]);
  });

  it.each([
    ['timestamp outside the matching window', { createdAtMs: Date.parse(PRODUCTION_SAMPLE_TIMESTAMP) + 15_001 }],
    ['different model', { model: 'deepseek-v4-flash' }],
    ['different prompt token count', { promptTokens: 31_663 }],
    ['different completion token count', { completionTokens: 392 }],
  ] satisfies Array<[string, Partial<ManagedSettledUsageLog>]>) (
    'does not apply a charge for a log with %s',
    (_label, logOverrides) => {
      const entry = managedEntry();
      expect(enrichManagedTokenUsageCosts(
        [entry],
        snapshot([settledLog(logOverrides)]),
      )).toEqual([entry]);
    },
  );

  it('does not reuse one settled log for two local usage entries', () => {
    const first = managedEntry({ sessionId: 'first' });
    const second = managedEntry({ sessionId: 'second' });
    const result = enrichManagedTokenUsageCosts(
      [first, second],
      snapshot([settledLog({ quota: 25_000 })]),
    );

    expect(result[0]).toEqual(first);
    expect(result[1]).toEqual(second);
  });

  it.each([null, '', false])('rejects malformed quota value %s instead of inventing zero cost', (quota) => {
    const parsed = parseManagedTokenCostSnapshot(
      {
        success: true,
        data: [{
          type: 2,
          created_at: Date.parse(PRODUCTION_LOG_TIMESTAMP) / 1000,
          model_name: 'smart-latest',
          quota,
          prompt_tokens: 31_662,
          completion_tokens: 391,
        }],
      },
      { success: true, data: { quota_per_unit: 500_000 } },
    );

    expect(parsed).toEqual({ quotaPerUnit: 500_000, logs: [] });
  });
});

describe('managed token usage cost snapshot loading', () => {
  it('uses only the validated relay key and coalesces concurrent snapshot requests', async () => {
    mocks.proxyAwareFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/api/log/token')) {
        return jsonResponse({ success: true, data: [] });
      }
      if (url.endsWith('/api/status')) {
        return jsonResponse({ success: true, data: { quota_per_unit: 500_000 } });
      }
      throw new Error('Unexpected managed usage URL');
    });

    const [first, second] = await Promise.all([
      getManagedTokenCostSnapshot(),
      getManagedTokenCostSnapshot(),
    ]);

    expect(first).toEqual({ quotaPerUnit: 500_000, logs: [] });
    expect(second).toEqual(first);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);

    const tokenLogCall = mocks.proxyAwareFetch.mock.calls.find(([input]) =>
      String(input).endsWith('/api/log/token'));
    const statusCall = mocks.proxyAwareFetch.mock.calls.find(([input]) =>
      String(input).endsWith('/api/status'));
    expect(tokenLogCall).toBeDefined();
    expect(statusCall).toBeDefined();

    const tokenLogHeaders = tokenLogCall?.[1]?.headers as Record<string, string>;
    const statusHeaders = statusCall?.[1]?.headers as Record<string, string>;
    expect(tokenLogHeaders).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer validated-relay-key',
    });
    expect(statusHeaders).toEqual({ Accept: 'application/json' });
    expect(statusHeaders).not.toHaveProperty('Authorization');
  });

  it('does not send network requests when relay identity validation fails', async () => {
    mocks.resolveRelayToken.mockReturnValue(null);

    await expect(getManagedTokenCostSnapshot()).resolves.toBeNull();

    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });
});
