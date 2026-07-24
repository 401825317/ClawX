// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPolicy: vi.fn(),
}));

vi.mock('@electron/services/managed-client-config-service', () => ({
  getManagedClientTextModelPolicy: (...args: unknown[]) => mocks.getPolicy(...args),
}));

import { createManagedClientConfigApi } from '@electron/services/managed-client-config-api';

describe('managed client-config host API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes the normalized text model policy through the typed Host API', async () => {
    const policy = {
      defaultModel: 'smart-latest',
      models: [{ id: 'smart-latest', label: 'Smart' }],
    };
    mocks.getPolicy.mockResolvedValueOnce(policy);

    await expect(createManagedClientConfigApi().textModels({ refresh: true })).resolves.toEqual(policy);
    expect(mocks.getPolicy).toHaveBeenCalledWith({ refresh: true });
  });

  it('rejects malformed runtime payloads', () => {
    expect(() => createManagedClientConfigApi().textModels({ refresh: 'yes' } as never))
      .toThrow('Invalid managedClientConfig.textModels payload');
  });
});
