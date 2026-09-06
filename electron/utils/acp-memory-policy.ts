import { app } from 'electron';
import { freemem, totalmem } from 'node:os';

/**
 * Memory policy for the embedded ACP Node process.
 *
 * `--max-old-space-size` only limits V8's old generation.  It is deliberately
 * kept separate from RSS/commit limits: Buffers, native allocations, IPC and
 * Electron processes need memory outside of V8's heap.
 */
export const ACP_OLD_SPACE_MIN_MB = 1_024;
export const ACP_OLD_SPACE_MAX_MB = 4_096;
export const ACP_OLD_SPACE_DEFAULT_MB = 2_048;
export const ACP_OLD_SPACE_OVERRIDE_ENV = 'UCLAW_ACP_MAX_OLD_SPACE_MB';
export const ACP_MEMORY_PRESSURE_RATIO = 0.85;

const BYTES_PER_MIB = 1024 * 1024;
const BYTES_PER_GIB = 1024 * 1024 * 1024;

const ACP_OLD_SPACE_TIERS_MB = [
  ACP_OLD_SPACE_MIN_MB,
  2_048,
  3_072,
  ACP_OLD_SPACE_MAX_MB,
] as const;

export type AcpMemorySnapshot = {
  /** Physical memory, or the effective process/container limit, in bytes. */
  totalMemoryBytes: number;
  /** Memory currently available to this process, when known. */
  availableMemoryBytes?: number;
  /** Optional Windows commit/swap pressure estimate in [0, 1]. */
  commitUsageRatio?: number;
};

export type AcpMemoryPolicy = {
  oldSpaceMb: number;
  source: 'tier' | 'override' | 'pressure-clamped';
  totalMemoryBytes: number;
  availableMemoryBytes?: number;
  commitUsageRatio?: number;
};

export type AcpSystemMemoryInfo = {
  total?: number;
  free?: number;
  swapTotal?: number;
  swapFree?: number;
};

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteRatio(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined;
}

function parseOverride(env: NodeJS.ProcessEnv): number | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === ACP_OLD_SPACE_OVERRIDE_ENV.toLowerCase());
  const raw = key ? env[key]?.trim() : undefined;
  if (!raw || !/^\d+$/u.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return undefined;
  if (value < ACP_OLD_SPACE_MIN_MB) return undefined;
  return Math.min(ACP_OLD_SPACE_MAX_MB, value);
}

function tierForTotalMemory(totalMemoryBytes: number): number {
  if (totalMemoryBytes <= 8 * BYTES_PER_GIB) return ACP_OLD_SPACE_TIERS_MB[0];
  if (totalMemoryBytes <= 16 * BYTES_PER_GIB) return ACP_OLD_SPACE_TIERS_MB[1];
  if (totalMemoryBytes <= 32 * BYTES_PER_GIB) return ACP_OLD_SPACE_TIERS_MB[2];
  return ACP_OLD_SPACE_TIERS_MB[3];
}

function lowerTier(value: number, levels: number): number {
  const bounded = Math.max(ACP_OLD_SPACE_MIN_MB, Math.min(ACP_OLD_SPACE_MAX_MB, value));
  if (levels <= 0) return bounded;
  let index = ACP_OLD_SPACE_TIERS_MB.findIndex((tier) => tier > bounded) - 1;
  if (index < 0) index = ACP_OLD_SPACE_TIERS_MB.length - 1;
  return ACP_OLD_SPACE_TIERS_MB[Math.max(0, index - levels)];
}

function pressureLevel(snapshot: AcpMemorySnapshot, totalMemoryBytes: number): number {
  let level = 0;
  const commitUsageRatio = finiteRatio(snapshot.commitUsageRatio);
  if (commitUsageRatio !== undefined) {
    if (commitUsageRatio >= 0.92) level = Math.max(level, 2);
    else if (commitUsageRatio >= ACP_MEMORY_PRESSURE_RATIO) level = Math.max(level, 1);
  }

  const availableMemoryBytes = finitePositive(snapshot.availableMemoryBytes);
  if (availableMemoryBytes !== undefined && totalMemoryBytes > 0) {
    const availableRatio = availableMemoryBytes / totalMemoryBytes;
    // Keep a reserve for Electron/Gateway/system work.  These thresholds are
    // intentionally conservative and can be tuned from production telemetry.
    if (availableRatio <= 0.05 || availableMemoryBytes <= 2 * BYTES_PER_GIB) {
      level = Math.max(level, 2);
    } else if (availableRatio <= 0.15 || availableMemoryBytes <= 4 * BYTES_PER_GIB) {
      level = Math.max(level, 1);
    }
  }
  return level;
}

/**
 * Select an ACP V8 old-space limit without ever accepting an unlimited value.
 *
 * An environment override is intended for controlled A/B testing only.  It is
 * still clamped to the hard [1,024, 4,096] MiB range and is reduced when the
 * host is already under memory pressure.
 */
export function getAcpMemoryPolicy(
  snapshot: AcpMemorySnapshot,
  env: NodeJS.ProcessEnv = process.env,
): AcpMemoryPolicy {
  const measuredTotalMemoryBytes = finitePositive(snapshot.totalMemoryBytes);
  const totalMemoryBytes = measuredTotalMemoryBytes ?? (16 * BYTES_PER_GIB);
  const availableMemoryBytes = finitePositive(snapshot.availableMemoryBytes);
  const commitUsageRatio = finiteRatio(snapshot.commitUsageRatio);
  const override = parseOverride(env);
  const requested = override ?? (
    measuredTotalMemoryBytes === undefined
      ? ACP_OLD_SPACE_DEFAULT_MB
      : tierForTotalMemory(totalMemoryBytes)
  );
  const pressure = pressureLevel({ totalMemoryBytes, availableMemoryBytes, commitUsageRatio }, totalMemoryBytes);
  const oldSpaceMb = lowerTier(requested, pressure);

  return {
    oldSpaceMb,
    source: pressure > 0 ? 'pressure-clamped' : override !== undefined ? 'override' : 'tier',
    totalMemoryBytes,
    ...(availableMemoryBytes !== undefined ? { availableMemoryBytes } : {}),
    ...(commitUsageRatio !== undefined ? { commitUsageRatio } : {}),
  };
}

/**
 * Read a lightweight host memory snapshot.  Node 22's availableMemory() is
 * preferred because it accounts for process/container constraints; freemem()
 * is a safe fallback on older runtimes.
 */
export function readAcpMemorySnapshot(systemMemoryInfo?: AcpSystemMemoryInfo): AcpMemorySnapshot {
  const constrained = typeof process.constrainedMemory === 'function'
    ? process.constrainedMemory()
    : 0;
  const physical = totalmem();
  const constrainedBytes = finitePositive(constrained);
  const totalMemoryBytes = constrainedBytes !== undefined
    ? Math.min(physical, constrainedBytes)
    : physical;
  const availableFromProcess = typeof process.availableMemory === 'function'
    ? process.availableMemory()
    : 0;
  const availableMemoryBytes = finitePositive(availableFromProcess) ?? finitePositive(freemem());
  let commitUsageRatio: number | undefined;

  // Electron exposes physical + swap figures in the Main process.  On
  // Windows their combined free ratio is a conservative approximation of
  // commit pressure.  It is only used to lower a tier; it can never increase
  // the ACP budget or bypass the hard maximum.
  try {
    // The bundled Electron typings do not expose this Windows helper, so keep
    // the narrow optional cast local to the probe.
    const electronApp = app as typeof app & {
      getSystemMemoryInfo?: () => AcpSystemMemoryInfo;
    };
    const electronMemoryInfo = systemMemoryInfo ?? (
      typeof electronApp.getSystemMemoryInfo === 'function'
        ? electronApp.getSystemMemoryInfo()
        : undefined
    );
    const totalKb = finitePositive(electronMemoryInfo?.total);
    const freeKb = finitePositive(electronMemoryInfo?.free) ?? 0;
    const swapTotalKb = finitePositive(electronMemoryInfo?.swapTotal) ?? 0;
    const swapFreeKb = finitePositive(electronMemoryInfo?.swapFree) ?? 0;
    if (totalKb !== undefined && totalKb + swapTotalKb > 0) {
      const capacityKb = totalKb + swapTotalKb;
      const availableKb = Math.min(capacityKb, freeKb + swapFreeKb);
      commitUsageRatio = Math.max(0, Math.min(1, 1 - (availableKb / capacityKb)));
    }
  } catch {
    // Memory pressure is an optional guard.  Failure to read it must not stop
    // ACP startup; physical/available memory tiers remain in effect.
  }

  return {
    totalMemoryBytes,
    ...(availableMemoryBytes !== undefined ? { availableMemoryBytes } : {}),
    ...(commitUsageRatio !== undefined ? { commitUsageRatio } : {}),
  };
}

export const __test = {
  parseOverride,
  tierForTotalMemory,
  pressureLevel,
  lowerTier,
  mib: BYTES_PER_MIB,
  gib: BYTES_PER_GIB,
};
