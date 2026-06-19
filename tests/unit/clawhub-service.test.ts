import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function loadServiceForHome(homeDir: string) {
  vi.resetModules();
  const paths = await import('@electron/utils/paths');
  vi.spyOn(paths, 'getOpenClawConfigDir').mockReturnValue(join(homeDir, '.openclaw'));
  const mod = await import('@electron/gateway/clawhub');
  return mod.ClawHubService;
}

describe('ClawHubService marketplace compatibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('reports local-only capability when no marketplace provider is registered', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'clawx-clawhub-home-'));
    const ClawHubService = await loadServiceForHome(homeDir);
    const service = new ClawHubService();

    await expect(service.getMarketplaceCapability()).resolves.toEqual({
      mode: 'local-only',
      canSearch: false,
      canInstall: false,
      reason: 'marketplace-disabled',
    });
  });

  it('delegates search and install to a registered marketplace provider', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'clawx-clawhub-home-'));
    const ClawHubService = await loadServiceForHome(homeDir);
    const service = new ClawHubService();
    const provider = {
      getCapability: vi.fn().mockResolvedValue({ mode: 'enterprise-marketplace', canSearch: true, canInstall: true }),
      search: vi.fn().mockResolvedValue([{ slug: 'pdf', name: 'PDF', description: 'Docs', version: '1.0.0' }]),
      install: vi.fn().mockResolvedValue(undefined),
    };

    service.setMarketplaceProvider(provider);

    await expect(service.search({ query: 'pdf' })).resolves.toEqual({
      results: [
        { slug: 'pdf', name: 'PDF', description: 'Docs', version: '1.0.0' },
      ],
      loaded: 1,
      total: 1,
      totalKnown: true,
      query: 'pdf',
      hasMore: false,
    });
    await expect(service.install({ slug: 'pdf' })).resolves.toBeUndefined();
    expect(provider.search).toHaveBeenCalledWith({ query: 'pdf' });
    expect(provider.install).toHaveBeenCalledWith({ slug: 'pdf' });
  });

  it('prefers SkillHub as the default marketplace when multiple providers are registered', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'clawx-clawhub-home-'));
    const ClawHubService = await loadServiceForHome(homeDir);
    const service = new ClawHubService();
    const clawhubProvider = {
      id: 'clawhub',
      getCapability: vi.fn().mockResolvedValue({ mode: 'public-clawhub', canSearch: true, canInstall: true }),
      search: vi.fn().mockResolvedValue([{ slug: 'clawhub-skill', name: 'ClawHub Skill', description: 'Docs', version: '1.0.0' }]),
      install: vi.fn().mockResolvedValue(undefined),
    };
    const skillhubProvider = {
      id: 'skillhub',
      getCapability: vi.fn().mockResolvedValue({ mode: 'public-skillhub', canSearch: true, canInstall: true }),
      search: vi.fn().mockResolvedValue([{ slug: 'skillhub-skill', name: 'SkillHub Skill', description: 'Docs', version: '1.0.0' }]),
      install: vi.fn().mockResolvedValue(undefined),
    };

    service.setMarketplaceProviders([clawhubProvider, skillhubProvider]);

    await expect(service.search({ query: '' })).resolves.toMatchObject({
      results: [
        { slug: 'skillhub-skill', name: 'SkillHub Skill' },
      ],
    });
    await service.install({ slug: 'clawhub-skill', provider: 'clawhub' });

    expect(skillhubProvider.search).toHaveBeenCalledWith({ query: '' });
    expect(clawhubProvider.search).not.toHaveBeenCalled();
    expect(clawhubProvider.install).toHaveBeenCalledWith({ slug: 'clawhub-skill', provider: 'clawhub' });
    expect(skillhubProvider.install).not.toHaveBeenCalled();
  });

  it('rejects missing or placeholder marketplace install slugs before calling the provider', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'clawx-clawhub-home-'));
    const ClawHubService = await loadServiceForHome(homeDir);
    const service = new ClawHubService();
    const provider = {
      getCapability: vi.fn().mockResolvedValue({ mode: 'enterprise-marketplace', canSearch: true, canInstall: true }),
      search: vi.fn().mockResolvedValue([]),
      install: vi.fn().mockResolvedValue(undefined),
    };

    service.setMarketplaceProvider(provider);

    await expect(service.install({ slug: 'undefined' })).rejects.toThrow('Marketplace install requires a valid skill slug');
    await expect(service.install({ slug: '' })).rejects.toThrow('Marketplace install requires a valid skill slug');
    expect(provider.install).not.toHaveBeenCalled();
  });

  it('lists installed managed skills from the filesystem without the clawhub CLI', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'clawx-clawhub-home-'));
    const openclawDir = join(homeDir, '.openclaw');
    const skillDir = join(openclawDir, 'skills', 'pdf');
    mkdirSync(join(skillDir, '.clawhub'), { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: PDF\n---\n');
    writeFileSync(join(skillDir, 'manifest.json'), JSON.stringify({ version: '1.2.3' }));
    writeFileSync(join(skillDir, '.clawhub', 'origin.json'), JSON.stringify({ installedVersion: '1.2.4' }));

    const ClawHubService = await loadServiceForHome(homeDir);
    const service = new ClawHubService();

    await expect(service.listInstalled()).resolves.toEqual([
      {
        slug: 'pdf',
        version: '1.2.4',
        source: 'openclaw-managed',
        baseDir: skillDir,
      },
    ]);
  });

  it('rejects uninstall for preinstalled managed skills', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'clawx-clawhub-home-'));
    const openclawDir = join(homeDir, '.openclaw');
    const skillDir = join(openclawDir, 'skills', 'pdf');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: PDF\n---\n');
    writeFileSync(join(skillDir, '.clawx-preinstalled.json'), JSON.stringify({ slug: 'pdf', version: '1.0.0' }));

    const ClawHubService = await loadServiceForHome(homeDir);
    const service = new ClawHubService();

    await expect(service.uninstall({ slug: 'pdf' })).rejects.toThrow('Preinstalled skills cannot be uninstalled');
    expect(existsSync(skillDir)).toBe(true);
  });
});
