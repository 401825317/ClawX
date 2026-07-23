import {
  normalizeManagedVideoCapabilityContract,
  type ManagedVideoCapabilityContract,
} from '../../../shared/managed-video-capabilities';
import { getClawXProviderStore } from '../providers/store-instance';

const CACHE_KEY = 'managedVideoCapabilityContract';

type ManagedVideoCapabilityCacheRecord = {
  cachedAt: number;
  contract: ManagedVideoCapabilityContract;
};

export async function readManagedVideoCapabilityContract(): Promise<ManagedVideoCapabilityContract | null> {
  const store = await getClawXProviderStore();
  const cached = store.get(CACHE_KEY) as ManagedVideoCapabilityCacheRecord | null | undefined;
  return normalizeManagedVideoCapabilityContract(cached?.contract);
}

export async function cacheManagedVideoCapabilityContract(
  rawContract: unknown,
): Promise<{ contract: ManagedVideoCapabilityContract | null; changed: boolean }> {
  const store = await getClawXProviderStore();
  const previous = await readManagedVideoCapabilityContract();
  const contract = normalizeManagedVideoCapabilityContract(rawContract);
  const changed = JSON.stringify(previous) !== JSON.stringify(contract);
  if (!changed) return { contract, changed: false };

  if (contract) {
    store.set(CACHE_KEY, {
      cachedAt: Date.now(),
      contract,
    } satisfies ManagedVideoCapabilityCacheRecord);
  } else {
    store.set(CACHE_KEY, null);
  }
  return { contract, changed: true };
}

export async function mergeCachedVideoCapabilityIntoClientConfig<T extends Record<string, unknown>>(
  payload: T,
): Promise<T> {
  const contract = await readManagedVideoCapabilityContract();
  if (!contract) return payload;
  const modelOptions = payload.modelOptions && typeof payload.modelOptions === 'object'
    && !Array.isArray(payload.modelOptions)
    ? payload.modelOptions as Record<string, unknown>
    : {};
  return {
    ...payload,
    modelOptions: {
      ...modelOptions,
      video: contract,
    },
  };
}
