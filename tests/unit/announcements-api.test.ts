// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getConfig = vi.hoisted(() => vi.fn());

vi.mock('@electron/services/announcements-service', () => ({
  getClientAnnouncementConfig: (...args: unknown[]) => getConfig(...args),
}));

import { createAnnouncementsApi } from '@electron/services/announcements-api';

describe('announcements host API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes the normalized read-only announcement configuration', async () => {
    const config = { enabled: true as const, items: [] };
    getConfig.mockResolvedValueOnce(config);

    await expect(createAnnouncementsApi().config()).resolves.toEqual(config);
    expect(getConfig).toHaveBeenCalledWith();
  });
});
