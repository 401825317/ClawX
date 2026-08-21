// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock('@electron/utils/store', () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
}));

import { __test, getOrCreateInstallationId } from '@electron/utils/installation-id';

describe('installation id', () => {
  beforeEach(() => {
    __test.reset();
    vi.clearAllMocks();
  });

  it('preserves an existing installation identity', async () => {
    mocks.getSetting.mockResolvedValue('existing-installation');
    await expect(getOrCreateInstallationId()).resolves.toBe('existing-installation');
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it('creates and persists one random identity for concurrent callers', async () => {
    mocks.getSetting.mockResolvedValue('');
    mocks.setSetting.mockResolvedValue(undefined);
    const [first, second] = await Promise.all([
      getOrCreateInstallationId(),
      getOrCreateInstallationId(),
    ]);

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    expect(second).toBe(first);
    expect(mocks.getSetting).toHaveBeenCalledTimes(1);
    expect(mocks.setSetting).toHaveBeenCalledOnce();
    expect(mocks.setSetting).toHaveBeenCalledWith('machineId', first);
  });
});
