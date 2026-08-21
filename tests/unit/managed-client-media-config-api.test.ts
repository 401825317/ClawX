// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedClientImageModelPolicy,
  ManagedClientVideoModelPolicy,
} from '@shared/managed-client-config';

const mocks = vi.hoisted(() => ({
  getImagePolicy: vi.fn(),
  getRuntimeConfig: vi.fn(),
  getTextPolicy: vi.fn(),
  getVideoPolicy: vi.fn(),
}));

vi.mock('@electron/services/managed-client-config-service', () => ({
  getManagedClientImageModelPolicy: (...args: unknown[]) => mocks.getImagePolicy(...args),
  getManagedClientRuntimeConfig: (...args: unknown[]) => mocks.getRuntimeConfig(...args),
  getManagedClientTextModelPolicy: (...args: unknown[]) => mocks.getTextPolicy(...args),
  getManagedClientVideoModelPolicy: (...args: unknown[]) => mocks.getVideoPolicy(...args),
}));

import { createManagedClientConfigApi } from '@electron/services/managed-client-config-api';

const imagePolicy = {
  defaultModel: 'future-image-model',
  defaultSize: '3072x1728',
  defaultQuality: 'ultra',
  models: [{
    id: 'future-image-model',
    sizes: ['3072x1728'],
    qualities: ['ultra'],
    defaultSize: '3072x1728',
    defaultQuality: 'ultra',
    supportsEditing: true,
  }],
} satisfies ManagedClientImageModelPolicy;

const videoPolicy = {
  defaultModel: 'future-video-model',
  defaultSize: '2560x1080',
  defaultAspectRatio: '64:27',
  defaultResolution: 'UWQHD',
  defaultDurationSeconds: 23,
  models: [{
    id: 'future-video-model',
    modes: ['cinematic-video'],
    sizes: ['2560x1080'],
    aspectRatios: ['64:27'],
    resolutions: ['UWQHD'],
    durations: [23],
    defaultSize: '2560x1080',
    defaultAspectRatio: '64:27',
    defaultResolution: 'UWQHD',
    defaultDurationSeconds: 23,
    requiresImage: false,
  }],
} satisfies ManagedClientVideoModelPolicy;

describe('managed media client-config Host API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes future image and exact video policies through without narrowing', async () => {
    mocks.getImagePolicy.mockResolvedValueOnce(imagePolicy);
    mocks.getVideoPolicy.mockResolvedValueOnce(videoPolicy);
    const api = createManagedClientConfigApi();

    await expect(api.imageModels({ refresh: true })).resolves.toEqual(imagePolicy);
    await expect(api.videoModels({ refresh: false })).resolves.toEqual(videoPolicy);
    expect(mocks.getImagePolicy).toHaveBeenCalledWith({ refresh: true });
    expect(mocks.getVideoPolicy).toHaveBeenCalledWith({ refresh: false });
  });

  it('preserves null when managed media is disabled', async () => {
    mocks.getImagePolicy.mockResolvedValueOnce(null);
    mocks.getVideoPolicy.mockResolvedValueOnce(null);
    const api = createManagedClientConfigApi();

    await expect(api.imageModels()).resolves.toBeNull();
    await expect(api.videoModels()).resolves.toBeNull();
  });

  it('rejects malformed media refresh requests', () => {
    const api = createManagedClientConfigApi();

    expect(() => api.imageModels({ refresh: 'yes' } as never))
      .toThrow('Invalid managedClientConfig.imageModels payload');
    expect(() => api.videoModels({ refresh: 1 } as never))
      .toThrow('Invalid managedClientConfig.videoModels payload');
  });
});
