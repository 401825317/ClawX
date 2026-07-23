import { beforeEach, describe, expect, it, vi } from 'vitest';

const marketplaceSearchMock = vi.fn();
const marketplaceInstallMock = vi.fn();
const marketplaceUninstallMock = vi.fn();
const localMock = vi.fn();
const statusMock = vi.fn();
const updateConfigsMock = vi.fn();

vi.mock('@/i18n', () => ({ default: { language: 'en' } }));

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    skills: {
      marketplaceSearch: (input: unknown) => marketplaceSearchMock(input),
      marketplaceInstall: (input: unknown) => marketplaceInstallMock(input),
      marketplaceUninstall: (input: unknown) => marketplaceUninstallMock(input),
      local: () => localMock(),
      status: () => statusMock(),
      updateConfigs: (input: unknown) => updateConfigsMock(input),
    },
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('skills marketplace store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localMock.mockResolvedValue({ success: true, skills: [] });
    statusMock.mockResolvedValue({ skills: [] });
    updateConfigsMock.mockResolvedValue({ success: true });
  });

  it('loads Explore through the typed SkillHub route and reuses the short-lived cache', async () => {
    marketplaceSearchMock.mockResolvedValue({
      success: true,
      results: [{ slug: 'pdf', name: 'PDF', description: 'Docs', version: '1.0.0', provider: 'skillhub' }],
      total: 20,
      loaded: 1,
      totalKnown: true,
      source: 'skillhub',
      hasMore: true,
      nextCursor: '2',
    });
    const { useSkillsStore } = await import('@/stores/skills');

    await useSkillsStore.getState().searchSkills('');
    await useSkillsStore.getState().searchSkills('');

    expect(marketplaceSearchMock).toHaveBeenCalledTimes(1);
    expect(marketplaceSearchMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'skillhub',
      query: '',
      limit: 100,
      locale: 'en',
    }));
    expect(useSkillsStore.getState()).toMatchObject({
      searchResults: [{ slug: 'pdf', provider: 'skillhub' }],
      marketplaceMeta: { total: 20, loaded: 1, hasMore: true, nextCursor: '2' },
    });
  });

  it('does not let an older search overwrite the latest query', async () => {
    const older = deferred<Record<string, unknown>>();
    const latest = deferred<Record<string, unknown>>();
    marketplaceSearchMock.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise);
    const { useSkillsStore } = await import('@/stores/skills');

    const olderSearch = useSkillsStore.getState().searchSkills('older');
    const latestSearch = useSkillsStore.getState().searchSkills('latest');
    latest.resolve({
      success: true,
      results: [{ slug: 'latest', name: 'Latest', description: '', version: '', provider: 'skillhub' }],
      source: 'skillhub',
    });
    await latestSearch;
    older.resolve({
      success: true,
      results: [{ slug: 'older', name: 'Older', description: '', version: '', provider: 'skillhub' }],
      source: 'skillhub',
    });
    await olderSearch;

    expect(useSkillsStore.getState().searchResults.map((skill) => skill.slug)).toEqual(['latest']);
  });

  it('loads the next cursor and deduplicates existing results', async () => {
    marketplaceSearchMock
      .mockResolvedValueOnce({
        success: true,
        results: [{ slug: 'one', name: 'One', description: '', version: '', provider: 'skillhub' }],
        source: 'skillhub',
        query: '',
        hasMore: true,
        nextCursor: 'cursor-2',
      })
      .mockResolvedValueOnce({
        success: true,
        results: [
          { slug: 'one', name: 'One', description: '', version: '', provider: 'skillhub' },
          { slug: 'two', name: 'Two', description: '', version: '', provider: 'skillhub' },
        ],
        source: 'skillhub',
        query: '',
        hasMore: false,
      });
    const { useSkillsStore } = await import('@/stores/skills');

    await useSkillsStore.getState().searchSkills('');
    await useSkillsStore.getState().loadMoreMarketplaceSkills();

    expect(marketplaceSearchMock).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: 'skillhub',
      cursor: 'cursor-2',
      limit: 100,
    }));
    expect(useSkillsStore.getState().searchResults.map((skill) => skill.slug)).toEqual(['one', 'two']);
    expect(useSkillsStore.getState().marketplaceMeta.hasMore).toBe(false);
  });

  it('installs through the result provider and refreshes local skills without Gateway RPC', async () => {
    marketplaceInstallMock.mockResolvedValue({ success: true });
    localMock.mockResolvedValue({
      success: true,
      skills: [{
        id: 'demo',
        slug: 'demo',
        name: 'Demo',
        description: '',
        enabled: true,
        marketplace: { provider: 'clawhub', slug: 'demo' },
      }],
    });
    const { useSkillsStore } = await import('@/stores/skills');
    useSkillsStore.setState({
      searchResults: [{ slug: 'demo', name: 'Demo', description: '', version: '2.0.0', provider: 'clawhub' }],
    });

    await useSkillsStore.getState().installSkill('demo', '2.0.0');

    expect(marketplaceInstallMock).toHaveBeenCalledWith({
      slug: 'demo',
      version: '2.0.0',
      provider: 'clawhub',
    });
    expect(localMock).toHaveBeenCalledTimes(1);
    expect(statusMock).not.toHaveBeenCalled();
  });
});
