import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarketplaceProviderExtension } from '@electron/extensions/types';

const testGlobal = globalThis as typeof globalThis & {
  __clawhubSearchParams?: unknown;
  __clawhubInstallParams?: unknown;
  __clawhubInstallResult?: unknown;
};

const fixtureRoots: string[] = [];

function writeLegacyRuntimeModule(openclawRoot: string): void {
  const distDir = join(openclawRoot, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(distDir, 'skills-clawhub-test.js'),
    `
export async function r(params) {
  globalThis.__clawhubSearchParams = params;
  if (typeof params.fetchImpl === 'function') {
    await params.fetchImpl('https://example.invalid/locale-probe', { headers: { 'X-Test': '1' } });
  }
  return [
    {
      slug: 'home-assistant',
      displayName: 'Home Assistant',
      summary: 'Control Home Assistant devices',
      metaContent: {
        DisplayDescription: '控制 Home Assistant 设备',
        Keywords: ['home_automation', 'industry_skills']
      },
      version: null,
      ownerHandle: 'iahmadzain',
      downloads: 123,
      stars: 7
    }
  ];
}

export async function t(params) {
  globalThis.__clawhubInstallParams = params;
  return globalThis.__clawhubInstallResult ?? { ok: true };
}
`,
  );
}

function writeStatusRuntimeModule(openclawRoot: string): void {
  const distDir = join(openclawRoot, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(distDir, 'status-test.js'),
    `
async function searchSkillsFromClawHub(params) {
  globalThis.__clawhubSearchParams = params;
  return [
    {
      slug: 'browser-automation',
      name: 'Browser Automation',
      description: 'Browse and inspect websites',
      version: '2.0.0',
      owner: { handle: 'openclaw' },
      metaContent: { Keywords: ['automation', 'developer_tools'] }
    }
  ];
}

async function installSkillFromClawHub(params) {
  globalThis.__clawhubInstallParams = params;
  return globalThis.__clawhubInstallResult ?? { ok: true };
}

export { installSkillFromClawHub as r, searchSkillsFromClawHub as s };
`,
  );
}

async function loadExtension(
  openclawRoot: string,
  configDir: string,
  options: { language?: string } = {},
): Promise<MarketplaceProviderExtension> {
  vi.resetModules();
  vi.doMock('@electron/utils/paths', () => ({
    getOpenClawResolvedDir: () => openclawRoot,
    getOpenClawConfigDir: () => configDir,
  }));
  vi.doMock('@electron/utils/store', () => ({
    getSetting: async (key: string) => key === 'language' ? (options.language ?? 'en') : undefined,
  }));

  const mod = await import('@electron/extensions/builtin/clawhub-marketplace');
  return mod.createClawHubMarketplaceExtension() as MarketplaceProviderExtension;
}

function createFixture(options: { runtime?: 'legacy' | 'status' } = {}) {
  const root = mkdtempSync(join(process.cwd(), '.vitest-clawhub-runtime-'));
  fixtureRoots.push(root);
  const openclawRoot = join(root, 'openclaw');
  const configDir = join(root, '.openclaw');
  if (options.runtime === 'status') {
    writeStatusRuntimeModule(openclawRoot);
  } else {
    writeLegacyRuntimeModule(openclawRoot);
  }
  return { openclawRoot, configDir };
}

describe('ClawHub marketplace extension', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });

  afterEach(() => {
    delete testGlobal.__clawhubSearchParams;
    delete testGlobal.__clawhubInstallParams;
    delete testGlobal.__clawhubInstallResult;
    for (const root of fixtureRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    vi.doUnmock('@electron/utils/paths');
    vi.doUnmock('@electron/utils/store');
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('reports the public ClawHub marketplace capability when the OpenClaw runtime is available', async () => {
    const { openclawRoot, configDir } = createFixture();
    const extension = await loadExtension(openclawRoot, configDir);

    await expect(extension.getCapability()).resolves.toEqual({
      mode: 'public-clawhub',
      canSearch: true,
      canInstall: true,
    });
  });

  it('supports the OpenClaw 2026.6 status runtime module exports', async () => {
    const { openclawRoot, configDir } = createFixture({ runtime: 'status' });
    const extension = await loadExtension(openclawRoot, configDir);

    await expect(extension.getCapability()).resolves.toEqual({
      mode: 'public-clawhub',
      canSearch: true,
      canInstall: true,
    });
    await expect(extension.search({ query: 'browser' })).resolves.toEqual([
      {
        slug: 'browser-automation',
        name: 'Browser Automation',
        description: 'Browse and inspect websites',
        version: '2.0.0',
        author: 'openclaw',
        downloads: undefined,
        stars: undefined,
        keywords: ['automation', 'developer_tools'],
      },
    ]);
    await expect(extension.install({ slug: 'browser-automation' })).resolves.toBeUndefined();
    expect(testGlobal.__clawhubInstallParams).toMatchObject({
      workspaceDir: configDir,
      slug: 'browser-automation',
      baseUrl: 'https://mirror-cn.clawhub.com',
    });
  });

  it('uses a broad default query for empty marketplace searches and maps ClawHub results', async () => {
    const { openclawRoot, configDir } = createFixture();
    const extension = await loadExtension(openclawRoot, configDir);
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(extension.search({ query: '   ', limit: 250 })).resolves.toEqual([
      {
        slug: 'home-assistant',
        name: 'Home Assistant',
        description: 'Control Home Assistant devices',
        version: '',
        author: 'iahmadzain',
        downloads: 123,
        stars: 7,
        keywords: ['home_automation', 'industry_skills'],
      },
    ]);
    expect(testGlobal.__clawhubSearchParams).toMatchObject({
      query: 'skill',
      limit: 100,
      baseUrl: 'https://mirror-cn.clawhub.com',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.invalid/locale-probe',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('Accept-Language')).toBe('en-US,en;q=0.9');
    expect(headers.get('X-Test')).toBe('1');
  });

  it('prefers the Chinese marketplace description when the app language is zh', async () => {
    const { openclawRoot, configDir } = createFixture();
    const extension = await loadExtension(openclawRoot, configDir, { language: 'zh' });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(extension.search({ query: 'home assistant' })).resolves.toEqual([
      {
        slug: 'home-assistant',
        name: 'Home Assistant',
        description: '控制 Home Assistant 设备',
        version: '',
        author: 'iahmadzain',
        downloads: 123,
        stars: 7,
        keywords: ['home_automation', 'industry_skills'],
      },
    ]);

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('Accept-Language')).toBe('zh-CN,zh;q=0.9,en;q=0.6');
  });

  it('prefers the request locale over the persisted app language', async () => {
    const { openclawRoot, configDir } = createFixture();
    const extension = await loadExtension(openclawRoot, configDir, { language: 'en' });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(extension.search({ query: 'home assistant', locale: 'zh-CN' })).resolves.toEqual([
      {
        slug: 'home-assistant',
        name: 'Home Assistant',
        description: '控制 Home Assistant 设备',
        version: '',
        author: 'iahmadzain',
        downloads: 123,
        stars: 7,
        keywords: ['home_automation', 'industry_skills'],
      },
    ]);

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('Accept-Language')).toBe('zh-CN,zh;q=0.9,en;q=0.6');
  });

  it('installs marketplace skills into the OpenClaw config directory', async () => {
    const { openclawRoot, configDir } = createFixture();
    const extension = await loadExtension(openclawRoot, configDir);

    await expect(extension.install({ slug: 'home-assistant', version: '1.0.0', force: true })).resolves.toBeUndefined();
    expect(testGlobal.__clawhubInstallParams).toMatchObject({
      workspaceDir: configDir,
      slug: 'home-assistant',
      version: '1.0.0',
      force: true,
      baseUrl: 'https://mirror-cn.clawhub.com',
    });
  });

  it('surfaces ClawHub install failures', async () => {
    const { openclawRoot, configDir } = createFixture();
    const extension = await loadExtension(openclawRoot, configDir);
    testGlobal.__clawhubInstallResult = { ok: false, error: 'install failed' };

    await expect(extension.install({ slug: 'home-assistant' })).rejects.toThrow('install failed');
  });
});
