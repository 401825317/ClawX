import { beforeEach, describe, expect, it, vi } from 'vitest';

const statusMock = vi.fn();
const localMock = vi.fn();
const marketplaceSearchMock = vi.fn();
const marketplaceInstallMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    skills: {
      status: () => statusMock(),
      local: () => localMock(),
      marketplaceSearch: (input: unknown) => marketplaceSearchMock(input),
      marketplaceInstall: (input: unknown) => marketplaceInstallMock(input),
      marketplaceUninstall: vi.fn(),
      updateConfigs: vi.fn(),
    },
  },
}));

describe('skills store error mapping', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('maps fetchSkills rate-limit error when both local and gateway loading fail', async () => {
    statusMock.mockRejectedValueOnce(new Error('gateway unavailable'));
    localMock.mockRejectedValueOnce(new Error('rate limit exceeded'));

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().fetchSkills();

    expect(useSkillsStore.getState().error).toBe('fetchRateLimitError');
  });

  it('maps searchSkills timeout error by AppError code', async () => {
    marketplaceSearchMock.mockRejectedValueOnce(new Error('request timeout'));

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().searchSkills('git');

    expect(marketplaceSearchMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'skillhub',
      query: 'git',
      limit: 80,
    }));
    expect(useSkillsStore.getState().searchError).toBe('searchTimeoutError');
  });

  it('maps installSkill timeout result into installTimeoutError', async () => {
    marketplaceInstallMock.mockResolvedValueOnce({ success: false, error: 'request timeout' });

    const { useSkillsStore } = await import('@/stores/skills');
    await expect(useSkillsStore.getState().installSkill('demo-skill')).rejects.toThrow('installTimeoutError');
    expect(marketplaceInstallMock).toHaveBeenCalledWith({
      slug: 'demo-skill',
      version: undefined,
      provider: 'skillhub',
    });
  });
});
