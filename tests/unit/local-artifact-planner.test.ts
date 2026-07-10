import { beforeEach, describe, expect, it, vi } from 'vitest';

const getProviderSecretMock = vi.fn();
const getProviderAccountMock = vi.fn();
const proxyAwareFetchMock = vi.fn();

vi.mock('@electron/services/secrets/secret-store', () => ({
  getProviderSecret: (...args: unknown[]) => getProviderSecretMock(...args),
}));

vi.mock('@electron/services/providers/provider-store', () => ({
  getProviderAccount: (...args: unknown[]) => getProviderAccountMock(...args),
}));

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: (...args: unknown[]) => proxyAwareFetchMock(...args),
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('planLocalArtifactBatch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getProviderSecretMock.mockResolvedValue({
      type: 'api_key',
      accountId: 'lingzhiwuxian',
      apiKey: 'sk-test',
    });
    getProviderAccountMock.mockResolvedValue({
      id: 'lingzhiwuxian',
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      model: 'smart-latest',
      headers: {},
    });
  });

  it('uses the local executable fast path for a first-time single PPT artifact', async () => {
    const { planLocalArtifactBatch } = await import('@electron/utils/local-artifact-planner');

    const result = await planLocalArtifactBatch([{
      id: 'task-1-presentation',
      request: {
        kind: 'presentation',
        title: '制作 PPT',
        sourcePrompt: '做一份 10 页科技展厅方案 PPT，带案例图片，做好后打开。',
        originalPrompt: '做一份 10 页科技展厅方案 PPT，带案例图片，做好后打开。',
      },
    }]);

    expect(result.source).toBe('fallback');
    expect(result.error).toBe('artifact_planner_single_artifact_fast_path');
    expect(result.items[0]?.request).toEqual(expect.objectContaining({
      kind: 'presentation',
      planningMode: 'prompt-heuristic',
    }));
    expect(getProviderSecretMock).not.toHaveBeenCalled();
    expect(getProviderAccountMock).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
  });

  it('does not use the single artifact fast path when repair feedback is present', async () => {
    getProviderSecretMock.mockResolvedValue(null);
    const { planLocalArtifactBatch } = await import('@electron/utils/local-artifact-planner');

    const result = await planLocalArtifactBatch([{
      id: 'task-1-presentation',
      request: {
        kind: 'presentation',
        title: '制作 PPT',
        sourcePrompt: '做一份 8 页 PPT。',
        originalPrompt: '做一份 8 页 PPT。',
      },
      verificationFeedback: {
        detail: 'PPT 成品验证未通过：页数不匹配。',
        evidence: 'slides=9 expected=8',
      },
    }]);

    expect(result.source).toBe('fallback');
    expect(result.error).toBe('artifact_planner_api_key_unavailable');
    expect(getProviderSecretMock).toHaveBeenCalled();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
  });
});
