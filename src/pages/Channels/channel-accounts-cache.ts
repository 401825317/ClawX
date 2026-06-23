import { hostApiFetch } from '@/lib/host-api';

const CHANNELS_ACCOUNTS_CACHE_TTL_MS = 30_000;
const CHANNELS_ACCOUNTS_RUNTIME_CACHE_TTL_MS = 15_000;

const channelsAccountsCache = new Map<string, { createdAt: number; response: unknown }>();
const channelsAccountsInFlight = new Map<string, Promise<unknown>>();

function getCacheTtl(path: string): number {
  return path.includes('probe=1')
    ? CHANNELS_ACCOUNTS_CACHE_TTL_MS
    : path.includes('mode=config')
      ? CHANNELS_ACCOUNTS_CACHE_TTL_MS
      : CHANNELS_ACCOUNTS_RUNTIME_CACHE_TTL_MS;
}

export function getCachedChannelsAccounts<T>(path: string): T | null {
  const cached = channelsAccountsCache.get(path);
  if (!cached) return null;
  if (Date.now() - cached.createdAt >= getCacheTtl(path)) {
    return null;
  }
  return cached.response as T;
}

export function invalidateChannelsAccountsCache(): void {
  channelsAccountsCache.clear();
}

export function clearChannelsAccountsCacheForTests(): void {
  invalidateChannelsAccountsCache();
  channelsAccountsInFlight.clear();
}

export async function fetchChannelsAccounts<T>(
  path: string,
  options?: { force?: boolean },
): Promise<T> {
  const now = Date.now();
  if (!options?.force) {
    const cached = channelsAccountsCache.get(path);
    if (cached && now - cached.createdAt < getCacheTtl(path)) {
      return cached.response as T;
    }
  }

  const existing = channelsAccountsInFlight.get(path);
  if (existing) {
    return await existing as T;
  }

  const promise = hostApiFetch<T>(path)
    .then((response) => {
      if ((response as { success?: unknown })?.success !== false) {
        channelsAccountsCache.set(path, {
          createdAt: Date.now(),
          response,
        });
      }
      return response;
    })
    .finally(() => {
      channelsAccountsInFlight.delete(path);
    });

  channelsAccountsInFlight.set(path, promise);
  return await promise;
}
