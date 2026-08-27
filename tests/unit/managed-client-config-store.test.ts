import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedClientImageModelPolicy,
  ManagedClientVideoModelPolicy,
} from '@shared/managed-client-config';
import { createDefaultManagedClientTextModelPolicy } from '@shared/managed-client-config';

const mocks = vi.hoisted(() => ({
  imageModels: vi.fn(),
  runtimeConfig: vi.fn(),
  textModels: vi.fn(),
  videoModels: vi.fn(),
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    managedClientConfig: {
      imageModels: mocks.imageModels,
      runtimeConfig: mocks.runtimeConfig,
      textModels: mocks.textModels,
      videoModels: mocks.videoModels,
    },
  },
}));

import { useManagedClientConfigStore } from '@/stores/managed-client-config';

const initialMediaState = {
  imageModelPolicy: useManagedClientConfigStore.getState().imageModelPolicy,
  videoModelPolicy: useManagedClientConfigStore.getState().videoModelPolicy,
};

const imagePolicy = {
  defaultModel: 'future-image-model',
  defaultSize: '4096x1716',
  defaultQuality: 'ultra',
  models: [{
    id: 'future-image-model',
    sizes: ['4096x1716'],
    qualities: ['ultra'],
    defaultSize: '4096x1716',
    defaultQuality: 'ultra',
    supportsEditing: false,
  }],
} satisfies ManagedClientImageModelPolicy;

const videoPolicy = {
  defaultModel: 'future-video-model',
  defaultSize: '3840x1600',
  defaultAspectRatio: '12:5',
  defaultResolution: 'cinema-4k',
  defaultDurationSeconds: 37,
  models: [{
    id: 'future-video-model',
    modes: ['storyboard-to-video'],
    sizes: ['3840x1600'],
    aspectRatios: ['12:5'],
    resolutions: ['cinema-4k'],
    durations: [37],
    defaultSize: '3840x1600',
    defaultAspectRatio: '12:5',
    defaultResolution: 'cinema-4k',
    defaultDurationSeconds: 37,
    requiresImage: true,
  }],
} satisfies ManagedClientVideoModelPolicy;

describe('managed client-config Renderer store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useManagedClientConfigStore.setState({
      textModelPolicy: createDefaultManagedClientTextModelPolicy(),
      imageModelPolicy: null,
      videoModelPolicy: null,
    });
  });

  it('keeps the default fallback model hidden from the picker', () => {
    expect(createDefaultManagedClientTextModelPolicy().models).toContainEqual({
      id: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      visible: false,
    });
  });

  it('fills fields omitted by an older text-model policy response', async () => {
    mocks.textModels.mockResolvedValueOnce({
      defaultModel: 'smart-latest',
      models: [{ id: 'smart-latest', label: 'Smart routing' }],
    });

    const policy = await useManagedClientConfigStore.getState().loadTextModels(true);

    expect(policy).toMatchObject({
      defaultModel: 'smart-latest',
      defaultThinkingLevel: 'medium',
      fallbackModels: ['deepseek-v4-flash'],
    });
    expect(useManagedClientConfigStore.getState().textModelPolicy).toEqual(policy);
  });

  it('starts with managed image and video capabilities disabled', () => {
    expect(initialMediaState).toEqual({
      imageModelPolicy: null,
      videoModelPolicy: null,
    });
  });

  it('caches future image and exact video policies without narrowing fields', async () => {
    mocks.imageModels.mockResolvedValueOnce(imagePolicy);
    mocks.videoModels.mockResolvedValueOnce(videoPolicy);

    await expect(useManagedClientConfigStore.getState().loadImageModels(true))
      .resolves.toEqual(imagePolicy);
    await expect(useManagedClientConfigStore.getState().loadVideoModels(false))
      .resolves.toEqual(videoPolicy);

    expect(useManagedClientConfigStore.getState().imageModelPolicy).toEqual(imagePolicy);
    expect(useManagedClientConfigStore.getState().videoModelPolicy).toEqual(videoPolicy);
    expect(mocks.imageModels).toHaveBeenCalledWith({ refresh: true });
    expect(mocks.videoModels).toHaveBeenCalledWith({ refresh: false });
  });

  it('keeps media disabled when the Host API returns null or no policy', async () => {
    useManagedClientConfigStore.setState({
      imageModelPolicy: imagePolicy,
      videoModelPolicy: videoPolicy,
    });
    mocks.imageModels.mockResolvedValueOnce(null);
    mocks.videoModels.mockResolvedValueOnce(undefined);

    await expect(useManagedClientConfigStore.getState().loadImageModels()).resolves.toBeNull();
    await expect(useManagedClientConfigStore.getState().loadVideoModels()).resolves.toBeNull();
    expect(useManagedClientConfigStore.getState().imageModelPolicy).toBeNull();
    expect(useManagedClientConfigStore.getState().videoModelPolicy).toBeNull();
  });

  it('fails closed for empty catalogs instead of caching local defaults', async () => {
    mocks.imageModels.mockResolvedValueOnce({
      defaultModel: '',
      defaultSize: '',
      defaultQuality: '',
      models: [],
    } satisfies ManagedClientImageModelPolicy);
    mocks.videoModels.mockResolvedValueOnce({
      defaultModel: '',
      defaultSize: '',
      defaultAspectRatio: '',
      defaultResolution: '',
      defaultDurationSeconds: 0,
      models: [],
    } satisfies ManagedClientVideoModelPolicy);

    await expect(useManagedClientConfigStore.getState().loadImageModels()).resolves.toBeNull();
    await expect(useManagedClientConfigStore.getState().loadVideoModels()).resolves.toBeNull();
    expect(useManagedClientConfigStore.getState().imageModelPolicy).toBeNull();
    expect(useManagedClientConfigStore.getState().videoModelPolicy).toBeNull();
  });

  it('fails closed for explicitly disabled policy envelopes', async () => {
    mocks.imageModels.mockResolvedValueOnce({ ...imagePolicy, enabled: false });
    mocks.videoModels.mockResolvedValueOnce({ ...videoPolicy, enabled: false });

    await expect(useManagedClientConfigStore.getState().loadImageModels()).resolves.toBeNull();
    await expect(useManagedClientConfigStore.getState().loadVideoModels()).resolves.toBeNull();
    expect(useManagedClientConfigStore.getState().imageModelPolicy).toBeNull();
    expect(useManagedClientConfigStore.getState().videoModelPolicy).toBeNull();
  });

  it('clears previously cached media capabilities when refresh fails', async () => {
    useManagedClientConfigStore.setState({
      imageModelPolicy: imagePolicy,
      videoModelPolicy: videoPolicy,
    });
    mocks.imageModels.mockRejectedValueOnce(new Error('image policy expired'));
    mocks.videoModels.mockRejectedValueOnce(new Error('video policy expired'));

    await expect(useManagedClientConfigStore.getState().loadImageModels())
      .rejects.toThrow('image policy expired');
    await expect(useManagedClientConfigStore.getState().loadVideoModels())
      .rejects.toThrow('video policy expired');
    expect(useManagedClientConfigStore.getState().imageModelPolicy).toBeNull();
    expect(useManagedClientConfigStore.getState().videoModelPolicy).toBeNull();
  });

  it('disables stale media while any policy load is still pending', async () => {
    let resolveImage: (policy: ManagedClientImageModelPolicy) => void = () => undefined;
    let resolveVideo: (policy: ManagedClientVideoModelPolicy) => void = () => undefined;
    mocks.imageModels.mockReturnValueOnce(new Promise<ManagedClientImageModelPolicy>((resolve) => {
      resolveImage = resolve;
    }));
    mocks.videoModels.mockReturnValueOnce(new Promise<ManagedClientVideoModelPolicy>((resolve) => {
      resolveVideo = resolve;
    }));
    useManagedClientConfigStore.setState({
      imageModelPolicy: imagePolicy,
      videoModelPolicy: videoPolicy,
    });

    const imageLoad = useManagedClientConfigStore.getState().loadImageModels(false);
    const videoLoad = useManagedClientConfigStore.getState().loadVideoModels(false);
    expect(useManagedClientConfigStore.getState().imageModelPolicy).toBeNull();
    expect(useManagedClientConfigStore.getState().videoModelPolicy).toBeNull();

    resolveImage(imagePolicy);
    resolveVideo(videoPolicy);
    await expect(imageLoad).resolves.toEqual(imagePolicy);
    await expect(videoLoad).resolves.toEqual(videoPolicy);
  });

  it('does not let an older refresh overwrite a newer fail-closed result', async () => {
    let resolveOldImage: (policy: ManagedClientImageModelPolicy) => void = () => undefined;
    mocks.imageModels
      .mockReturnValueOnce(new Promise<ManagedClientImageModelPolicy>((resolve) => {
        resolveOldImage = resolve;
      }))
      .mockRejectedValueOnce(new Error('new image refresh failed'));

    const oldLoad = useManagedClientConfigStore.getState().loadImageModels(true);
    const newLoad = useManagedClientConfigStore.getState().loadImageModels(true);
    await expect(newLoad).rejects.toThrow('new image refresh failed');
    resolveOldImage(imagePolicy);
    await expect(oldLoad).resolves.toEqual(imagePolicy);
    expect(useManagedClientConfigStore.getState().imageModelPolicy).toBeNull();
  });
});
