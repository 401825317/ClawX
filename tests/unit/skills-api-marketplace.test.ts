// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClawHubService } from '@electron/gateway/clawhub';
import type { GatewayManager } from '@electron/gateway/manager';
import { createSkillsApi } from '@electron/services/skills-api';

describe('skills marketplace host API', () => {
  const gatewayRpc = vi.fn();
  const marketplaceCapability = vi.fn();
  const marketplaceSearch = vi.fn();
  const marketplaceInstall = vi.fn();
  const marketplaceUninstall = vi.fn();

  const createApi = () => createSkillsApi({
    clawHubService: {
      getMarketplaceCapability: marketplaceCapability,
      search: marketplaceSearch,
      install: marketplaceInstall,
      uninstall: marketplaceUninstall,
    } as unknown as ClawHubService,
    gatewayManager: {
      rpc: gatewayRpc,
      getStatus: () => ({ state: 'stopped', port: 18789 }),
    } as unknown as GatewayManager,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    marketplaceCapability.mockResolvedValue({
      mode: 'multi-marketplace',
      canSearch: true,
      canInstall: true,
    });
    marketplaceSearch.mockResolvedValue({
      results: [],
      source: 'skillhub',
    });
    marketplaceInstall.mockResolvedValue(undefined);
    marketplaceUninstall.mockResolvedValue(undefined);
  });

  it('normalizes generic marketplace payloads without calling Gateway', async () => {
    const api = createApi();

    await expect(api.marketplaceCapability()).resolves.toMatchObject({
      success: true,
      capability: { canSearch: true, canInstall: true },
    });
    await expect(api.marketplaceSearch({
      provider: 'skillhub',
      query: '  pdf  ',
      limit: 24,
      cursor: '2',
      sort: 'score',
      dir: 'desc',
      force: true,
      locale: 'zh-CN',
    })).resolves.toMatchObject({ success: true, results: [], source: 'skillhub' });
    await expect(api.marketplaceInstall({
      provider: 'skillhub',
      slug: '  pdf  ',
      version: '1.0.0',
      force: true,
    })).resolves.toEqual({ success: true });
    await expect(api.marketplaceUninstall({ slug: '  pdf  ' })).resolves.toEqual({ success: true });

    expect(marketplaceSearch).toHaveBeenCalledWith({
      provider: 'skillhub',
      query: 'pdf',
      limit: 24,
      cursor: '2',
      sort: 'score',
      dir: 'desc',
      force: true,
      locale: 'zh-CN',
    });
    expect(marketplaceInstall).toHaveBeenCalledWith({
      provider: 'skillhub',
      slug: 'pdf',
      version: '1.0.0',
      force: true,
    });
    expect(marketplaceUninstall).toHaveBeenCalledWith({ slug: 'pdf' });
    expect(gatewayRpc).not.toHaveBeenCalled();
  });

  it('keeps legacy ClawHub actions as Main-side aliases only', () => {
    const api = createApi();

    expect(api.clawhubCapability).toBe(api.marketplaceCapability);
    expect(api.clawhubList).toBe(api.marketplaceList);
    expect(api.clawhubSearch).toBe(api.marketplaceSearch);
    expect(api.clawhubInstall).toBe(api.marketplaceInstall);
    expect(api.clawhubUninstall).toBe(api.marketplaceUninstall);
  });

  it('returns provider failures without touching Gateway state', async () => {
    marketplaceSearch.mockRejectedValueOnce(new Error('marketplace unavailable'));
    const api = createApi();

    await expect(api.marketplaceSearch({ query: 'pdf' })).resolves.toEqual({
      success: false,
      error: 'marketplace unavailable',
    });
    expect(gatewayRpc).not.toHaveBeenCalled();
  });
});
