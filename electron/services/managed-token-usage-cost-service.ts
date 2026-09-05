import { createHash } from 'node:crypto';
import type { TokenUsageHistoryEntry } from '../utils/token-usage-core';
import {
  UCLAW_AUTH_ACCOUNT_ID,
  UCLAW_COMPATIBILITY_PROVIDER_ID,
  UCLAW_PROVIDER_ID,
  getUclawBackendOrigin,
} from '../utils/junfeiai-distribution';
import { logger } from '../utils/logger';
import { proxyAwareFetch } from '../utils/proxy-fetch';
import { getProviderAccount } from './providers/provider-store';
import {
  resolveValidUclawManagedRelayPairToken,
  withProviderMutationLock,
} from './providers/provider-mutation-lock';
import { getProviderSecret } from './secrets/secret-store';

const TOKEN_LOG_PATH = '/api/log/token';
const STATUS_PATH = '/api/status';
const REQUEST_TIMEOUT_MS = 10_000;
const SUCCESS_CACHE_MS = 5_000;
const MATCH_WINDOW_MS = 15_000;
const CONSUMPTION_LOG_TYPE = 2;

type JsonRecord = Record<string, unknown>;

export type ManagedSettledUsageLog = {
  createdAtMs: number;
  model: string;
  quota: number;
  promptTokens: number;
  completionTokens: number;
  requestId?: string;
};

export type ManagedTokenCostSnapshot = {
  quotaPerUnit: number;
  logs: ManagedSettledUsageLog[];
};

type CachedSnapshot = {
  tokenFingerprint: string;
  fetchedAt: number;
  value: ManagedTokenCostSnapshot;
};

type InFlightSnapshot = {
  tokenFingerprint: string;
  promise: Promise<ManagedTokenCostSnapshot | null>;
};

let cachedSnapshot: CachedSnapshot | null = null;
const snapshotsInFlight = new Map<string, InFlightSnapshot>();

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizedRequestId(value: unknown): string | undefined {
  const normalized = nonEmptyString(value);
  return normalized && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(normalized)
    ? normalized
    : undefined;
}

function unwrapData(value: unknown): unknown {
  if (!isRecord(value) || value.success !== true) return undefined;
  return value.data;
}

function epochMilliseconds(value: unknown): number | undefined {
  const timestamp = nonNegativeInteger(value);
  if (timestamp === undefined || timestamp === 0) return undefined;
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

export function parseManagedTokenCostSnapshot(
  tokenLogPayload: unknown,
  statusPayload: unknown,
): ManagedTokenCostSnapshot | null {
  const status = unwrapData(statusPayload);
  const quotaPerUnit = isRecord(status)
    ? finiteNumber(status.quota_per_unit ?? status.quotaPerUnit)
    : undefined;
  const rawLogs = unwrapData(tokenLogPayload);
  if (!quotaPerUnit || quotaPerUnit <= 0 || !Array.isArray(rawLogs)) return null;

  const logs = rawLogs.flatMap((value): ManagedSettledUsageLog[] => {
    if (!isRecord(value)) return [];
    const type = nonNegativeInteger(value.type);
    const createdAtMs = epochMilliseconds(value.created_at ?? value.createdAt);
    const model = nonEmptyString(value.model_name ?? value.model);
    const quota = nonNegativeInteger(value.quota);
    const promptTokens = nonNegativeInteger(value.prompt_tokens ?? value.promptTokens);
    const completionTokens = nonNegativeInteger(value.completion_tokens ?? value.completionTokens);
    const requestId = normalizedRequestId(value.request_id ?? value.requestId);
    if (
      type !== CONSUMPTION_LOG_TYPE
      || createdAtMs === undefined
      || !model
      || quota === undefined
      || promptTokens === undefined
      || completionTokens === undefined
    ) {
      return [];
    }

    return [{
      createdAtMs,
      model,
      quota,
      promptTokens,
      completionTokens,
      ...(requestId ? { requestId } : {}),
    }];
  });

  return { quotaPerUnit, logs };
}

function normalizedModel(value: string | undefined, provider?: string): string {
  const normalized = value?.trim().toLowerCase() ?? '';
  const providerPrefix = provider?.trim().toLowerCase();
  return providerPrefix && normalized.startsWith(`${providerPrefix}/`)
    ? normalized.slice(providerPrefix.length + 1)
    : normalized;
}

function withoutUnavailableFlag(entry: TokenUsageHistoryEntry, costUsd: number): TokenUsageHistoryEntry {
  const { costUnavailable: _costUnavailable, ...rest } = entry;
  return { ...rest, costUsd };
}

/** Apply a settled charge only when the server row has one unambiguous local match. */
export function enrichManagedTokenUsageCosts(
  entries: readonly TokenUsageHistoryEntry[],
  snapshot: ManagedTokenCostSnapshot | null,
): TokenUsageHistoryEntry[] {
  if (!snapshot) return [...entries];

  const matchesByEntry = entries.map((entry): number[] => {
    if (!entry.costUnavailable || entry.usageStatus !== 'available') return [];
    const timestampMs = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestampMs)) return [];

    const model = normalizedModel(entry.model, entry.provider);
    const promptTokens = entry.inputTokens + entry.cacheReadTokens + entry.cacheWriteTokens;
    const matches: number[] = [];
    for (let index = 0; index < snapshot.logs.length; index += 1) {
      const log = snapshot.logs[index];
      const matchesRequestId = entry.providerRequestId
        && log.requestId === entry.providerRequestId;
      const matchesHistoricalFields = !entry.providerRequestId
        && normalizedModel(log.model) === model
        && log.promptTokens === promptTokens
        && log.completionTokens === entry.outputTokens
        && Math.abs(log.createdAtMs - timestampMs) <= MATCH_WINDOW_MS;
      if (matchesRequestId || matchesHistoricalFields) {
        matches.push(index);
      }
    }
    return matches;
  });

  const matchingEntryCountByLog = new Map<number, number>();
  for (const matches of matchesByEntry) {
    for (const logIndex of matches) {
      matchingEntryCountByLog.set(
        logIndex,
        (matchingEntryCountByLog.get(logIndex) ?? 0) + 1,
      );
    }
  }

  return entries.map((entry, entryIndex) => {
    const matches = matchesByEntry[entryIndex];
    if (matches.length !== 1 || matchingEntryCountByLog.get(matches[0]) !== 1) {
      return entry;
    }
    const matchedIndex = matches[0];
    return withoutUnavailableFlag(
      entry,
      snapshot.logs[matchedIndex].quota / snapshot.quotaPerUnit,
    );
  });
}

async function loadManagedRelayToken(): Promise<string | null> {
  return withProviderMutationLock(async () => {
    const [account, compatibilityAccount, authSecret, relaySecret, compatibilityRelaySecret] = await Promise.all([
      getProviderAccount(UCLAW_PROVIDER_ID),
      getProviderAccount(UCLAW_COMPATIBILITY_PROVIDER_ID),
      getProviderSecret(UCLAW_AUTH_ACCOUNT_ID, { migrate: false }),
      getProviderSecret(UCLAW_PROVIDER_ID, { migrate: false }),
      getProviderSecret(UCLAW_COMPATIBILITY_PROVIDER_ID, { migrate: false }),
    ]);
    return resolveValidUclawManagedRelayPairToken(
      account,
      compatibilityAccount,
      authSecret,
      relaySecret,
      compatibilityRelaySecret,
    );
  });
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Managed usage request failed with HTTP ${response.status}`);
  return response.json();
}

async function fetchSnapshot(relayToken: string): Promise<ManagedTokenCostSnapshot | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const origin = getUclawBackendOrigin();
  try {
    const [tokenLogResponse, statusResponse] = await Promise.all([
      proxyAwareFetch(`${origin}${TOKEN_LOG_PATH}`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${relayToken}`,
        },
        signal: controller.signal,
      }),
      proxyAwareFetch(`${origin}${STATUS_PATH}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }),
    ]);
    const [tokenLogPayload, statusPayload] = await Promise.all([
      responseJson(tokenLogResponse),
      responseJson(statusResponse),
    ]);
    return parseManagedTokenCostSnapshot(tokenLogPayload, statusPayload);
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch only settled, user-visible billing fields; credentials never leave Main. */
export async function getManagedTokenCostSnapshot(): Promise<ManagedTokenCostSnapshot | null> {
  const relayToken = await loadManagedRelayToken().catch(() => null);
  if (!relayToken) return null;

  const tokenFingerprint = createHash('sha256').update(relayToken).digest('hex');
  if (
    cachedSnapshot
    && cachedSnapshot.tokenFingerprint === tokenFingerprint
    && Date.now() - cachedSnapshot.fetchedAt < SUCCESS_CACHE_MS
  ) {
    return cachedSnapshot.value;
  }
  const existingRequest = snapshotsInFlight.get(tokenFingerprint);
  if (existingRequest) {
    return existingRequest.promise;
  }

  const promise = fetchSnapshot(relayToken)
    .then(async (value) => {
      const currentRelayToken = await loadManagedRelayToken().catch(() => null);
      if (
        !currentRelayToken
        || createHash('sha256').update(currentRelayToken).digest('hex') !== tokenFingerprint
      ) {
        return null;
      }
      if (value) {
        cachedSnapshot = { tokenFingerprint, fetchedAt: Date.now(), value };
      }
      return value;
    })
    .catch((error) => {
      logger.debug('Failed to load settled managed token usage cost:', error);
      return null;
    })
    .finally(() => {
      if (snapshotsInFlight.get(tokenFingerprint)?.promise === promise) {
        snapshotsInFlight.delete(tokenFingerprint);
      }
    });
  snapshotsInFlight.set(tokenFingerprint, { tokenFingerprint, promise });
  return promise;
}

export function resetManagedTokenCostCacheForTests(): void {
  cachedSnapshot = null;
  snapshotsInFlight.clear();
}
