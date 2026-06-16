import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.fn();
const rpcMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      rpc: (...args: unknown[]) => rpcMock(...args),
    }),
  },
}));

describe('skills store error mapping', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('maps fetchSkills rate-limit error when both local and gateway loading fail', async () => {
    rpcMock.mockRejectedValueOnce(new Error('gateway unavailable'));
    hostApiFetchMock.mockRejectedValueOnce(new Error('rate limit exceeded'));

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().fetchSkills();

    expect(useSkillsStore.getState().error).toBe('fetchRateLimitError');
  });

  it('maps searchSkills timeout error by AppError code', async () => {
    hostApiFetchMock.mockRejectedValueOnce(new Error('request timeout'));

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().searchSkills('git');

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/skills/marketplace/search', expect.objectContaining({ method: 'POST' }));
    expect(useSkillsStore.getState().searchError).toBe('searchTimeoutError');
  });

  it('normalizes raw ClawHub marketplace results before rendering install buttons', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      success: true,
      results: [
        {
          id: 'browser-automation',
          displayName: 'Browser Automation',
          summary: 'Browse and inspect websites',
          metaContent: { Keywords: ['developer_tools'], latest: { version: '2.0.0' } },
          owner: { handle: 'openclaw' },
        },
        {
          slug: 'undefined',
          displayName: 'Broken Skill',
          summary: 'Missing install target',
        },
      ],
    });

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().searchSkills('browser');

    expect(useSkillsStore.getState().searchResults).toEqual([
      {
        slug: 'browser-automation',
        name: 'Browser Automation',
        description: 'Browse and inspect websites',
        version: '2.0.0',
        author: 'openclaw',
        downloads: undefined,
        stars: undefined,
        keywords: ['developer_tools'],
      },
    ]);
  });

  it('maps installSkill timeout result into installTimeoutError', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ success: false, error: 'request timeout' });

    const { useSkillsStore } = await import('@/stores/skills');
    await expect(useSkillsStore.getState().installSkill('demo-skill')).rejects.toThrow('installTimeoutError');
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/skills/marketplace/install', expect.objectContaining({ method: 'POST' }));
  });
});
