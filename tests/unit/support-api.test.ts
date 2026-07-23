// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
}));

vi.mock('@electron/services/support-service', () => ({
  getSupportContactConfig: (...args: unknown[]) => mocks.getConfig(...args),
}));

import { createSupportApi } from '@electron/services/support-api';

describe('support host API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes the read-only normalized support configuration', async () => {
    const config = {
      enabled: true as const,
      contacts: [{ id: 'support-1', qrCodeUrl: 'https://cdn.example.test/qr.png' }],
    };
    mocks.getConfig.mockResolvedValueOnce(config);

    await expect(createSupportApi().config()).resolves.toEqual(config);
    expect(mocks.getConfig).toHaveBeenCalledWith();
  });
});
