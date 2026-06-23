import { describe, expect, it, vi } from 'vitest';
import { shouldDisableHardwareAcceleration } from '@electron/main/hardware-acceleration';

function decide(options?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  switches?: string[];
}): boolean {
  const switches = new Set(options?.switches ?? []);
  return shouldDisableHardwareAcceleration({
    platform: options?.platform ?? 'win32',
    env: options?.env ?? {},
    hasSwitch: vi.fn((name: string) => switches.has(name)),
  });
}

describe('hardware acceleration policy', () => {
  it('keeps GPU acceleration enabled by default on Windows', () => {
    expect(decide({ platform: 'win32' })).toBe(false);
  });

  it('keeps the previous software-rendering default on non-Windows platforms', () => {
    expect(decide({ platform: 'darwin' })).toBe(true);
    expect(decide({ platform: 'linux' })).toBe(true);
  });

  it('allows Windows users to disable GPU with env or CLI switches', () => {
    expect(decide({ platform: 'win32', env: { CLAWX_DISABLE_GPU: '1' } })).toBe(true);
    expect(decide({ platform: 'win32', switches: ['disable-gpu'] })).toBe(true);
  });

  it('allows explicit GPU enablement on non-Windows platforms', () => {
    expect(decide({ platform: 'linux', env: { CLAWX_ENABLE_GPU: 'true' } })).toBe(false);
    expect(decide({ platform: 'darwin', switches: ['enable-gpu'] })).toBe(false);
  });

  it('gives explicit disable flags priority over enable flags', () => {
    expect(decide({
      platform: 'win32',
      env: {
        CLAWX_ENABLE_GPU: 'true',
        CLAWX_DISABLE_GPU: 'true',
      },
    })).toBe(true);
  });
});
