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

function writeRuntimeModule(openclawRoot: string): void {
  const distDir = join(openclawRoot, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(distDir, 'skills-clawhub-test.js'),
    `
export async function r(params) {
  globalThis.__clawhubSearchParams = params;
  return [
    {
      slug: 'home-assistant',
      displayName: 'Home Assistant',
      summary: 'Control Home Assistant devices',
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

async function loadExtension(openclawRoot: string, configDir: string): Promise<MarketplaceProviderExtension> {
  vi.resetModules();
  vi.doMock('@electron/utils/paths', () => ({
    getOpenClawResolvedDir: () => openclawRoot,
    getOpenClawConfigDir: () => configDir,
  }));

  const mod = await import('@electron/extensions/builtin/clawhub-marketplace');
  return mod.createClawHubMarketplaceExtension() as MarketplaceProviderExtension;
}

function createFixture() {
  const root = mkdtempSync(join(process.cwd(), '.vitest-clawhub-runtime-'));
  fixtureRoots.push(root);
  const openclawRoot = join(root, 'openclaw');
  const configDir = join(root, '.openclaw');
  writeRuntimeModule(openclawRoot);
  return { openclawRoot, configDir };
}

describe('ClawHub marketplace extension', () => {
  afterEach(() => {
    delete testGlobal.__clawhubSearchParams;
    delete testGlobal.__clawhubInstallParams;
    delete testGlobal.__clawhubInstallResult;
    for (const root of fixtureRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    vi.doUnmock('@electron/utils/paths');
    vi.resetModules();
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

  it('uses a broad default query for empty marketplace searches and maps ClawHub results', async () => {
    const { openclawRoot, configDir } = createFixture();
    const extension = await loadExtension(openclawRoot, configDir);

    await expect(extension.search({ query: '   ', limit: 250 })).resolves.toEqual([
      {
        slug: 'home-assistant',
        name: 'Home Assistant',
        description: 'Control Home Assistant devices',
        version: '',
        author: 'iahmadzain',
        downloads: 123,
        stars: 7,
      },
    ]);
    expect(testGlobal.__clawhubSearchParams).toEqual({ query: 'skill', limit: 100 });
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
    });
  });

  it('surfaces ClawHub install failures', async () => {
    const { openclawRoot, configDir } = createFixture();
    const extension = await loadExtension(openclawRoot, configDir);
    testGlobal.__clawhubInstallResult = { ok: false, error: 'install failed' };

    await expect(extension.install({ slug: 'home-assistant' })).rejects.toThrow('install failed');
  });
});
