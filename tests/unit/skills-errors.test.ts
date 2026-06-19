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

  it('requests a larger marketplace catalog for browsing and searching', async () => {
    hostApiFetchMock.mockResolvedValue({ success: true, results: [] });

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().searchSkills('');
    await useSkillsStore.getState().searchSkills('browser');

    expect(hostApiFetchMock).toHaveBeenNthCalledWith(1, '/api/skills/marketplace/search', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"limit":100'),
    }));
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(1, '/api/skills/marketplace/search', expect.objectContaining({
      body: expect.stringContaining('"provider":"skillhub"'),
    }));
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/skills/marketplace/search', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"limit":80'),
    }));
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/skills/marketplace/search', expect.objectContaining({
      body: expect.stringContaining('"provider":"skillhub"'),
    }));
  });

  it('aggregates category marketplace searches from multiple queries', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({
        success: true,
        results: [
          { slug: 'photo-to-3d', displayName: 'Photo to 3D', summary: 'Generate 3D assets', metaContent: { Keywords: ['3d'] } },
          { slug: 'blender-mcp', displayName: 'Blender MCP', summary: 'Control Blender', metaContent: { Keywords: ['blender'] } },
        ],
        catalogTotal: 70414,
        catalogTotalKnown: true,
        source: 'skillhub',
      })
      .mockResolvedValueOnce({
        success: true,
        results: [
          { slug: 'blender-mcp', displayName: 'Blender MCP', summary: 'Control Blender', metaContent: { Keywords: ['blender'] } },
          { slug: 'cad-agent', displayName: 'CAD Agent', summary: 'Work with CAD files', metaContent: { Keywords: ['cad'] } },
        ],
        catalogTotal: 70414,
        catalogTotalKnown: true,
        source: 'skillhub',
      });

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().searchSkills(['3d', 'blender']);

    expect(hostApiFetchMock).toHaveBeenNthCalledWith(1, '/api/skills/marketplace/search', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"query":"3d"'),
    }));
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(1, '/api/skills/marketplace/search', expect.objectContaining({
      body: expect.stringContaining('"provider":"skillhub"'),
    }));
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/skills/marketplace/search', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"query":"blender"'),
    }));
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(1, '/api/skills/marketplace/search', expect.objectContaining({
      body: expect.stringContaining('"limit":24'),
    }));
    expect(useSkillsStore.getState().searchResults.map((skill) => skill.slug)).toEqual([
      'photo-to-3d',
      'blender-mcp',
      'cad-agent',
    ]);
    expect(useSkillsStore.getState().marketplaceMeta).toMatchObject({
      loaded: 3,
      total: 3,
      totalKnown: true,
      catalogTotal: 70414,
      catalogTotalKnown: true,
      hasMore: false,
    });
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

  it('stores marketplace catalog totals and appends additional pages', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({
        success: true,
        results: [
          {
            slug: 'self-improving-agent',
            displayName: 'Self Improving Agent',
            summary: 'Continuous learning',
          },
        ],
        total: 64486,
        loaded: 1,
        totalKnown: true,
        catalogTotal: 70414,
        catalogTotalKnown: true,
        query: '',
        sort: 'downloads',
        dir: 'desc',
        hasMore: true,
        nextCursor: 'cursor-1',
      })
      .mockResolvedValueOnce({
        success: true,
        results: [
          {
            slug: 'browser-automation',
            displayName: 'Browser Automation',
            summary: 'Browse and inspect websites',
          },
        ],
        total: 64486,
        loaded: 1,
        totalKnown: true,
        catalogTotal: 70414,
        catalogTotalKnown: true,
        query: '',
        sort: 'downloads',
        dir: 'desc',
        hasMore: false,
        nextCursor: '',
      });

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().searchSkills('');
    expect(useSkillsStore.getState().marketplaceMeta).toMatchObject({
      total: 64486,
      loaded: 1,
      totalKnown: true,
      hasMore: true,
      nextCursor: 'cursor-1',
    });

    await useSkillsStore.getState().loadMoreMarketplaceSkills();

    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/skills/marketplace/search', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"cursor":"cursor-1"'),
    }));
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/skills/marketplace/search', expect.objectContaining({
      body: expect.stringContaining('"provider":"skillhub"'),
    }));
    expect(useSkillsStore.getState().searchResults.map((skill) => skill.slug)).toEqual([
      'self-improving-agent',
      'browser-automation',
    ]);
    expect(useSkillsStore.getState().marketplaceMeta.loaded).toBe(2);
  });

  it('maps installSkill timeout result into installTimeoutError', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ success: false, error: 'request timeout' });

    const { useSkillsStore } = await import('@/stores/skills');
    await expect(useSkillsStore.getState().installSkill('demo-skill')).rejects.toThrow('installTimeoutError');
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/skills/marketplace/install', expect.objectContaining({ method: 'POST' }));
  });

  it('passes the marketplace provider when installing a SkillHub search result', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({
        success: true,
        results: [
          {
            slug: 'xiaohongshu-crawler-redfox',
            name: '小红书作品爬取',
            description_zh: '小红书作品爬取工具',
            version: '1.0.0',
            provider: 'skillhub',
            source: 'community',
          },
        ],
      })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true, skills: [] });
    rpcMock.mockResolvedValueOnce({ skills: [] });

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().searchSkills('小红书');
    await useSkillsStore.getState().installSkill('xiaohongshu-crawler-redfox', '1.0.0');

    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/skills/marketplace/install', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"provider":"skillhub"'),
    }));
  });
});
