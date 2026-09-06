import { describe, expect, it } from 'vitest';
import {
  ACP_MEMORY_PRESSURE_RATIO,
  ACP_OLD_SPACE_MAX_MB,
  ACP_OLD_SPACE_MIN_MB,
  ACP_OLD_SPACE_OVERRIDE_ENV,
  getAcpMemoryPolicy,
  readAcpMemorySnapshot,
} from '@electron/utils/acp-memory-policy';

const GiB = 1024 * 1024 * 1024;

describe('ACP memory policy', () => {
  it.each([
    [4, 1_024],
    [8, 1_024],
    [12, 2_048],
    [16, 2_048],
    [24, 3_072],
    [32, 3_072],
    [64, 4_096],
  ])('selects a bounded tier for %d GiB hosts', (gib, expected) => {
    expect(getAcpMemoryPolicy({ totalMemoryBytes: gib * GiB }).oldSpaceMb).toBe(expected);
  });

  it('reduces the tier when available memory is already low', () => {
    const policy = getAcpMemoryPolicy({
      totalMemoryBytes: 32 * GiB,
      availableMemoryBytes: 3 * GiB,
    });

    expect(policy.oldSpaceMb).toBe(2_048);
    expect(policy.source).toBe('pressure-clamped');
  });

  it('reduces two tiers under severe commit pressure', () => {
    const policy = getAcpMemoryPolicy({
      totalMemoryBytes: 64 * GiB,
      commitUsageRatio: 0.95,
    });

    expect(policy.oldSpaceMb).toBe(2_048);
    expect(policy.source).toBe('pressure-clamped');
  });

  it('uses the safe 2048 MiB default when host memory cannot be measured', () => {
    expect(getAcpMemoryPolicy({ totalMemoryBytes: 0 }).oldSpaceMb).toBe(2_048);
  });

  it('accepts a controlled override but never an unlimited or out-of-range value', () => {
    expect(getAcpMemoryPolicy(
      { totalMemoryBytes: 32 * GiB },
      { [ACP_OLD_SPACE_OVERRIDE_ENV]: '3584' },
    )).toMatchObject({ oldSpaceMb: 3_584, source: 'override' });

    expect(getAcpMemoryPolicy(
      { totalMemoryBytes: 32 * GiB },
      { uclaw_acp_max_old_space_mb: '3072' },
    )).toMatchObject({ oldSpaceMb: 3_072, source: 'override' });

    expect(getAcpMemoryPolicy(
      { totalMemoryBytes: 32 * GiB },
      { [ACP_OLD_SPACE_OVERRIDE_ENV]: '999999' },
    )).toMatchObject({ oldSpaceMb: ACP_OLD_SPACE_MAX_MB, source: 'override' });

    expect(getAcpMemoryPolicy(
      { totalMemoryBytes: 32 * GiB },
      { [ACP_OLD_SPACE_OVERRIDE_ENV]: '0' },
    ).oldSpaceMb).toBe(3_072);
  });

  it('clamps pressure ratios and preserves the hard bounds', () => {
    const low = getAcpMemoryPolicy({ totalMemoryBytes: 64 * GiB, commitUsageRatio: 2 });
    const high = getAcpMemoryPolicy({ totalMemoryBytes: 4 * GiB, commitUsageRatio: -1 });

    expect(low.oldSpaceMb).toBe(2_048);
    expect(high.oldSpaceMb).toBe(ACP_OLD_SPACE_MIN_MB);
    expect(low.oldSpaceMb).toBeLessThanOrEqual(ACP_OLD_SPACE_MAX_MB);
    expect(ACP_MEMORY_PRESSURE_RATIO).toBe(0.85);
  });

  it('derives commit pressure from Electron physical and swap memory info', () => {
    const snapshot = readAcpMemorySnapshot({
      total: 32 * 1024 * 1024,
      free: 8 * 1024 * 1024,
      swapTotal: 16 * 1024 * 1024,
      swapFree: 4 * 1024 * 1024,
    });

    // 12 GiB available out of 48 GiB total => 75% committed.
    expect(snapshot.commitUsageRatio).toBeCloseTo(0.75, 5);
  });
});
