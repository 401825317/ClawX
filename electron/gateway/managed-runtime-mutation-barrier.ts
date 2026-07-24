import { getClawXProviderStore } from '../services/providers/store-instance';
import { isUclawManagedDistribution } from '../utils/junfeiai-distribution';

const MANAGED_RUNTIME_MARKER_KEY = 'uclawManagedRuntimeMutation';
const MANAGED_RUNTIME_MARKER_VERSION = 1 as const;

type ManagedRuntimeMutationMarker = {
  version: typeof MANAGED_RUNTIME_MARKER_VERSION;
  state: 'in_progress' | 'quarantined';
  operation: string;
  updatedAt: string;
  reason?: string;
};

declare const managedRuntimeMutationLeaseBrand: unique symbol;

/** Opaque authority held only by one managed credential transaction. */
export type ManagedRuntimeMutationLease = {
  readonly [managedRuntimeMutationLeaseBrand]: true;
};

const issuedLeases = new WeakSet<object>();
let activeLease: ManagedRuntimeMutationLease | null = null;

export class ManagedRuntimeStartBlockedError extends Error {
  constructor(message = 'Gateway start is blocked by a managed credential transaction') {
    super(message);
    this.name = 'ManagedRuntimeStartBlockedError';
  }
}

function requireActiveLease(lease: ManagedRuntimeMutationLease): void {
  if (!issuedLeases.has(lease) || activeLease !== lease) {
    throw new Error('Invalid or inactive managed runtime mutation lease');
  }
}

async function writeMarker(marker: ManagedRuntimeMutationMarker): Promise<void> {
  const store = await getClawXProviderStore();
  store.set(MANAGED_RUNTIME_MARKER_KEY, marker);
}

/** Synchronously reserve Gateway runtime mutation authority. */
export function acquireManagedRuntimeMutationLease(): ManagedRuntimeMutationLease {
  if (activeLease) {
    throw new ManagedRuntimeStartBlockedError('Another managed credential transaction is already active');
  }
  const lease = Object.freeze({}) as ManagedRuntimeMutationLease;
  issuedLeases.add(lease);
  activeLease = lease;
  return lease;
}

/** Release in-memory ownership after success, safe rollback, or persisted quarantine. */
export function releaseManagedRuntimeMutationLease(lease: ManagedRuntimeMutationLease): void {
  requireActiveLease(lease);
  activeLease = null;
}

/** Persist crash-safe evidence immediately before the first credential mutation. */
export async function markManagedRuntimeMutationStarted(
  lease: ManagedRuntimeMutationLease,
  operation: string,
): Promise<void> {
  requireActiveLease(lease);
  if (!isUclawManagedDistribution()) return;
  await writeMarker({
    version: MANAGED_RUNTIME_MARKER_VERSION,
    state: 'in_progress',
    operation,
    updatedAt: new Date().toISOString(),
  });
}

/** Keep Gateway fail-closed until a later managed recovery transaction succeeds. */
export async function quarantineManagedRuntimeMutation(
  lease: ManagedRuntimeMutationLease,
  operation: string,
  reason: string,
): Promise<void> {
  requireActiveLease(lease);
  if (!isUclawManagedDistribution()) return;
  await writeMarker({
    version: MANAGED_RUNTIME_MARKER_VERSION,
    state: 'quarantined',
    operation,
    updatedAt: new Date().toISOString(),
    reason,
  });
}

/** Clear persistent quarantine only after a complete managed transaction. */
export async function clearManagedRuntimeMutationMarker(
  lease: ManagedRuntimeMutationLease,
): Promise<void> {
  requireActiveLease(lease);
  if (!isUclawManagedDistribution()) return;
  const store = await getClawXProviderStore();
  store.delete(MANAGED_RUNTIME_MARKER_KEY);
}

/** Read the persisted crash/quarantine state before startup side effects. */
export async function hasManagedRuntimeMutationMarker(): Promise<boolean> {
  if (!isUclawManagedDistribution()) return false;
  const store = await getClawXProviderStore();
  // Presence is authoritative. Corrupt or newer marker data must not make a
  // quarantined runtime start again after an application restart.
  if (typeof store.has === 'function') {
    return store.has(MANAGED_RUNTIME_MARKER_KEY);
  }
  return store.get(MANAGED_RUNTIME_MARKER_KEY) !== undefined;
}

/** Reject ordinary lifecycle work immediately while an auth transaction owns the runtime. */
export function assertManagedRuntimeLaunchAllowed(
  lease?: ManagedRuntimeMutationLease,
): void {
  if (!isUclawManagedDistribution()) return;
  if (activeLease && activeLease !== lease) throw new ManagedRuntimeStartBlockedError();
  if (lease && activeLease !== lease) {
    throw new ManagedRuntimeStartBlockedError('Managed runtime mutation lease is no longer active');
  }
}

/** Check both in-memory ownership and crash-safe quarantine before starting Gateway. */
export async function assertManagedRuntimeStartAllowed(
  lease?: ManagedRuntimeMutationLease,
): Promise<void> {
  assertManagedRuntimeLaunchAllowed(lease);
  if (await hasManagedRuntimeMutationMarker()) {
    throw new ManagedRuntimeStartBlockedError('Gateway start is blocked until managed credentials are recovered');
  }
  // A lease could be acquired while the persisted marker was being read.
  assertManagedRuntimeLaunchAllowed(lease);
}

export function isManagedRuntimeMutationActive(): boolean {
  return isUclawManagedDistribution() && activeLease !== null;
}

export function isManagedRuntimeStartBlockedError(error: unknown): error is ManagedRuntimeStartBlockedError {
  return error instanceof ManagedRuntimeStartBlockedError;
}
