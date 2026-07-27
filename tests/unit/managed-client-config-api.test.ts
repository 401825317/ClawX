// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTextPolicy: vi.fn(),
  getVideoPolicy: vi.fn(),
}));

vi.mock('@electron/services/managed-client-config-service', () => ({
  getManagedClientTextModelPolicy: (...args: unknown[]) => mocks.getTextPolicy(...args),
  getManagedClientVideoModelPolicy: (...args: unknown[]) => mocks.getVideoPolicy(...args),
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
    mocks.getTextPolicy.mockResolvedValueOnce(policy);

    await expect(createManagedClientConfigApi().textModels({ refresh: true })).resolves.toEqual(policy);
    expect(mocks.getTextPolicy).toHaveBeenCalledWith({ refresh: true });
  });

  it('exposes the normalized video model policy through the typed Host API', async () => {
    const policy = {
      defaultModel: 'grok-image-video',
      defaultAspectRatio: '16:9',
      defaultResolution: '480P',
      defaultDurationSeconds: 6,
      models: [],
    };
    mocks.getVideoPolicy.mockResolvedValueOnce(policy);

    await expect(createManagedClientConfigApi().videoModels({ refresh: false })).resolves.toEqual(policy);
    expect(mocks.getVideoPolicy).toHaveBeenCalledWith({ refresh: false });
  });

  it('rejects malformed runtime payloads', () => {
    expect(() => createManagedClientConfigApi().textModels({ refresh: 'yes' } as never))
      .toThrow('Invalid managedClientConfig.textModels payload');
    expect(() => createManagedClientConfigApi().videoModels({ refresh: 'yes' } as never))
      .toThrow('Invalid managedClientConfig.videoModels payload');
  });
});
