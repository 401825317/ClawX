import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarketplaceProviderExtension } from '@electron/extensions/types';

const testGlobal = globalThis as typeof globalThis & {
  __clawhubSearchParams?: unknown;
  __clawhubSearchResult?: unknown;
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
  return globalThis.__clawhubSearchResult ?? [
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
    delete testGlobal.__clawhubSearchResult;
    delete testGlobal.__clawhubInstallParams;
    delete testGlobal.__clawhubInstallResult;
    for (const root of fixtureRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    vi.doUnmock('@electron/utils/paths');
    vi.doUnmock('@electron/utils/store');
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
    vi.stubEnv('OPENCLAW_CLAWHUB_URL', 'https://enterprise.example.test/clawhub/');
    const { openclawRoot, configDir } = createFixture({ runtime: 'status' });
    const extension = await loadExtension(openclawRoot, configDir);

    await expect(extension.getCapability()).resolves.toEqual({
      mode: 'public-clawhub',
      canSearch: true,
      canInstall: true,
    });
    await expect(extension.search({ query: 'browser' })).resolves.toMatchObject({
      results: [
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
      ],
      total: 1,
      loaded: 1,
      totalKnown: true,
    });
    await expect(extension.install({ slug: 'browser-automation' })).resolves.toBeUndefined();
    expect(testGlobal.__clawhubInstallParams).toMatchObject({
      workspaceDir: configDir,
      slug: 'browser-automation',
      baseUrl: 'https://enterprise.example.test/clawhub/',
    });
  });

  it('normalizes nested marketplace result metadata into installable skill slugs', async () => {
    vi.stubEnv('OPENCLAW_CLAWHUB_URL', 'https://enterprise.example.test/clawhub/');
    const { openclawRoot, configDir } = createFixture({ runtime: 'status' });
    const extension = await loadExtension(openclawRoot, configDir);
    testGlobal.__clawhubSearchResult = [
      {
        skill: {
          slug: 'nested-browser',
          displayName: 'Nested Browser',
          summary: 'Nested summary',
        },
        latestVersion: { version: '3.0.0' },
        owner: { handle: 'nested-owner' },
        metaContent: { Keywords: ['developer_tools'] },
      },
      {
        slug: 'undefined',
        displayName: 'Broken Skill',
      },
    ];

    await expect(extension.search({ query: 'browser' })).resolves.toMatchObject({
      results: [
        {
          slug: 'nested-browser',
          name: 'Nested Browser',
          description: 'Nested summary',
          version: '3.0.0',
          author: 'nested-owner',
          downloads: undefined,
          stars: undefined,
          keywords: ['developer_tools'],
        },
      ],
      total: 1,
      loaded: 1,
      totalKnown: true,
    });
  });

  it('uses a broad default query for empty marketplace searches and maps ClawHub results', async () => {
    const { openclawRoot, configDir } = createFixture();
    const extension = await loadExtension(openclawRoot, configDir);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as { path?: string };
      if (String(input).includes('/api/query') && body.path === 'skills:listPublicPageV4') {
        return new Response(JSON.stringify({
          status: 'success',
          value: {
            hasMore: true,
            nextCursor: 'cursor-1',
            page: [
              {
                ownerHandle: 'pskoett',
                latestVersion: { version: '3.0.23' },
                owner: { handle: 'pskoett', displayName: 'pskoett' },
                skill: {
                  slug: 'self-improving-agent',
                  displayName: 'self-improving agent',
                  summary: 'Captures learnings and corrections',
                  stats: { downloads: 462502, stars: 3796 },
                  categories: ['agents'],
                  capabilityTags: ['memory'],
                },
              },
            ],
          },
        }), { status: 200 });
      }
      if (String(input).includes('/api/query') && body.path === 'skills:countPublicSkills') {
        return new Response(JSON.stringify({ status: 'success', value: 64486 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(extension.search({ query: '   ', limit: 250 })).resolves.toEqual(
      expect.objectContaining({
        results: expect.arrayContaining([
          expect.objectContaining({
            slug: 'self-improving-agent',
            name: 'self-improving agent',
            description: 'Captures learnings and corrections',
            version: '3.0.23',
            author: 'pskoett',
            downloads: 462502,
            stars: 3796,
            keywords: ['agents', 'memory'],
          }),
        ]),
        total: 64486,
        loaded: 250,
        totalKnown: true,
        catalogTotal: 64486,
        catalogTotalKnown: true,
        hasMore: true,
        nextCursor: 'cursor-1',
      }),
    );
    expect(testGlobal.__clawhubSearchParams).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://wry-manatee-359.convex.cloud/api/query',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('skills:listPublicPageV4'),
      }),
    );
  });

  it('prefers the Chinese marketplace description when the app language is zh', async () => {
    vi.stubEnv('OPENCLAW_CLAWHUB_URL', 'https://enterprise.example.test/clawhub/');
    const { openclawRoot, configDir } = createFixture();
    const extension = await loadExtension(openclawRoot, configDir, { language: 'zh' });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(extension.search({ query: 'home assistant' })).resolves.toMatchObject({
      results: [
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
      ],
      total: 1,
      loaded: 1,
      totalKnown: true,
    });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('Accept-Language')).toBe('zh-CN,zh;q=0.9,en;q=0.6');
  });

  it('prefers the request locale over the persisted app language', async () => {
    vi.stubEnv('OPENCLAW_CLAWHUB_URL', 'https://enterprise.example.test/clawhub/');
    const { openclawRoot, configDir } = createFixture();
    const extension = await loadExtension(openclawRoot, configDir, { language: 'en' });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(extension.search({ query: 'home assistant', locale: 'zh-CN' })).resolves.toMatchObject({
      results: [
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
      ],
      total: 1,
      loaded: 1,
      totalKnown: true,
    });

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

  it('uses the official ClawHub install resolver when the marketplace result has no version', async () => {
    const { openclawRoot, configDir } = createFixture();
    const extension = await loadExtension(openclawRoot, configDir);

    await expect(extension.install({ slug: 'home-assistant' })).resolves.toBeUndefined();
    expect(testGlobal.__clawhubInstallParams).toMatchObject({
      workspaceDir: configDir,
      slug: 'home-assistant',
      baseUrl: 'https://clawhub.ai',
    });
  });

  it('uses an explicitly configured ClawHub URL for both search and install', async () => {
    vi.stubEnv('OPENCLAW_CLAWHUB_URL', 'https://enterprise.example.test/clawhub/');
    const { openclawRoot, configDir } = createFixture();
    const extension = await loadExtension(openclawRoot, configDir);

    await extension.search({ query: 'home assistant' });
    await extension.install({ slug: 'home-assistant' });

    expect(testGlobal.__clawhubSearchParams).toMatchObject({
      baseUrl: 'https://enterprise.example.test/clawhub/',
    });
    expect(testGlobal.__clawhubInstallParams).toMatchObject({
      baseUrl: 'https://enterprise.example.test/clawhub/',
    });
  });

  it('surfaces ClawHub install failures', async () => {
    const { openclawRoot, configDir } = createFixture();
    const extension = await loadExtension(openclawRoot, configDir);
    testGlobal.__clawhubInstallResult = { ok: false, error: 'install failed' };

    await expect(extension.install({ slug: 'home-assistant' })).rejects.toThrow('install failed');
  });

  it('normalizes malformed install resolution errors from incompatible marketplace mirrors', async () => {
    const { openclawRoot, configDir } = createFixture();
    const extension = await loadExtension(openclawRoot, configDir);
    testGlobal.__clawhubInstallResult = { ok: false, error: 'Skill "undefined" is not installable.' };

    await expect(extension.install({ slug: 'home-assistant' })).rejects.toThrow(
      'Marketplace install source returned an incompatible install response for "https://clawhub.ai"',
    );
  });
});
