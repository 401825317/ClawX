// @vitest-environment node

import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const patchModulePath = resolve(repoRoot, 'scripts/openclaw-model-catalog-cache-patch.mjs');
const tempRoots = new Set<string>();

const resolverSource = [
  'function resolveBundledStaticCatalogModel(params) {',
  '\treturn createBundledStaticCatalogModelResolver({',
  '\t\t...params.env ? { env: params.env } : {},',
  '\t\t...params.includeRuntimeDiscovery !== void 0 ? { includeRuntimeDiscovery: params.includeRuntimeDiscovery } : {}',
  '\t})(params);',
  '}',
].join('\n');

const providerAliasSource = [
  'function canonicalizeManifestModelCatalogProviderAlias(params) {',
  '\tconst provider = normalizeProviderId(params.provider);',
  '\tif (!provider) return params.provider;',
  '\treturn resolveManifestModelCatalogProviderAlias({',
  '\t\tprovider,',
  '\t\tplugins: loadPluginManifestRegistry({',
  '\t\t\tconfig: params.cfg,',
  '\t\t\tworkspaceDir: params.workspaceDir,',
  '\t\t\tenv: params.env ?? process.env',
  '\t\t}).plugins',
  '\t}) ?? params.provider;',
  '}',
].join('\n');

const runtimeSource = `
let resolverCreations = 0;
let manifestScans = 0;
function createBundledStaticCatalogModelResolver(options = {}) {
  resolverCreations += 1;
  return (lookup) => ({ options, modelId: lookup.modelId });
}
function normalizeProviderId(provider) {
  return typeof provider === 'string' ? provider.trim().toLowerCase() : '';
}
function loadPluginManifestRegistry() {
  manifestScans += 1;
  return {
    plugins: [{
      providers: ['plugin-provider'],
      modelCatalog: { aliases: { friendly: { provider: 'plugin-provider' } } },
    }],
  };
}
function resolveManifestModelCatalogProviderAlias(params) {
  const targets = new Set();
  for (const plugin of params.plugins) {
    for (const [rawAlias, alias] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
      const normalizedAlias = normalizeProviderId(rawAlias);
      const normalizedTarget = normalizeProviderId(alias.provider);
      if (
        normalizedAlias === params.provider
        && normalizedTarget
        && plugin.providers.some((providerId) => normalizeProviderId(providerId) === normalizedTarget)
      ) targets.add(normalizedTarget);
    }
  }
  return targets.size === 1 ? [...targets][0] : undefined;
}
${resolverSource}
${providerAliasSource}
export function exerciseResolvers() {
  resolveBundledStaticCatalogModel({ modelId: 'first' });
  resolveBundledStaticCatalogModel({ modelId: 'second' });
  resolveBundledStaticCatalogModel({ modelId: 'explicit-env-1', env: {} });
  resolveBundledStaticCatalogModel({ modelId: 'explicit-env-2', env: {} });
  resolveBundledStaticCatalogModel({ modelId: 'runtime-1', includeRuntimeDiscovery: true });
  resolveBundledStaticCatalogModel({ modelId: 'runtime-2', includeRuntimeDiscovery: true });
  const staticRow = resolveBundledStaticCatalogModel({ modelId: 'static', includeRuntimeDiscovery: false });
  const runtimeRow = resolveBundledStaticCatalogModel({ modelId: 'runtime', includeRuntimeDiscovery: true });
  if (staticRow.options.includeRuntimeDiscovery !== false || runtimeRow.options.includeRuntimeDiscovery !== true) {
    throw new Error('Catalog modes must remain isolated');
  }
  return resolverCreations;
}
export function exerciseProviderAliases() {
  const explicitConfig = { models: { providers: { openai: {} } } };
  const normalizedConfig = { models: { providers: { OpenAI: {} } } };
  const explicit = canonicalizeManifestModelCatalogProviderAlias({ provider: 'openai', cfg: explicitConfig });
  const scansAfterExplicit = manifestScans;
  const normalizedExplicit = canonicalizeManifestModelCatalogProviderAlias({ provider: 'OPENAI', cfg: normalizedConfig });
  const scansAfterNormalizedExplicit = manifestScans;
  const alias = canonicalizeManifestModelCatalogProviderAlias({ provider: 'friendly', cfg: {} });
  const unknown = canonicalizeManifestModelCatalogProviderAlias({ provider: 'unknown', cfg: {} });
  const empty = canonicalizeManifestModelCatalogProviderAlias({ provider: '', cfg: {} });
  return {
    alias,
    empty,
    explicit,
    normalizedExplicit,
    scansAfterExplicit,
    scansAfterNormalizedExplicit,
    totalScans: manifestScans,
    unknown,
  };
}
`;

interface RuntimeFixture {
  exerciseProviderAliases: () => {
    alias: string;
    empty: string;
    explicit: string;
    normalizedExplicit: string;
    scansAfterExplicit: number;
    scansAfterNormalizedExplicit: number;
    totalScans: number;
    unknown: string;
  };
  exerciseResolvers: () => number;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

async function importPatchModule(): Promise<typeof import('../../scripts/openclaw-model-catalog-cache-patch.mjs')> {
  const root = await createTempRoot('uclaw-model-catalog-module-');
  const modulePath = join(root, 'openclaw-model-catalog-cache-patch.mjs');
  const source = (await readFile(patchModulePath, 'utf8')).replace(/^#![^\r\n]*(?:\r?\n|$)/, '');
  await writeFile(modulePath, source, 'utf8');
  return await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}-${Math.random()}`);
}

async function importFixture(source: string): Promise<RuntimeFixture> {
  const root = await createTempRoot('uclaw-model-catalog-fixture-');
  const fixturePath = join(root, 'runtime.mjs');
  await writeFile(fixturePath, source, 'utf8');
  return await import(`${pathToFileURL(fixturePath).href}?test=${Date.now()}-${Math.random()}`);
}

async function writeRuntime(
  version = '2026.6.10',
  source = runtimeSource,
  fileName = 'model.static-catalog-test.js',
): Promise<{ root: string; target: string }> {
  const root = await createTempRoot('uclaw-model-catalog-runtime-');
  const dist = join(root, 'dist');
  const target = join(dist, fileName);
  await mkdir(dist, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ version }), 'utf8');
  await writeFile(target, source, 'utf8');
  return { root, target };
}

afterEach(async () => {
  await Promise.all([...tempRoots].map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.clear();
});

describe('OpenClaw 6.10 bundled model catalog cache patch', () => {
  it('reuses only the ordinary process-local resolver and remains idempotent', async () => {
    expect(existsSync(patchModulePath)).toBe(true);
    const { rewriteBundledModelCatalogResolver } = await importPatchModule();
    const rewritten = rewriteBundledModelCatalogResolver(runtimeSource);

    expect(rewritten).toMatchObject({ replacements: 1, supported: true });
    expect(rewriteBundledModelCatalogResolver(rewritten.content)).toEqual({
      content: rewritten.content,
      replacements: 0,
      supported: true,
    });

    const runtime = await importFixture(rewritten.content);
    expect(runtime.exerciseResolvers()).toBe(4);
  });

  it('skips plugin discovery for explicit providers while preserving alias discovery', async () => {
    const { rewriteExplicitProviderAliasDiscovery } = await importPatchModule();
    const rewritten = rewriteExplicitProviderAliasDiscovery(runtimeSource);

    expect(rewritten).toMatchObject({ replacements: 1, supported: true });
    expect(rewriteExplicitProviderAliasDiscovery(rewritten.content)).toEqual({
      content: rewritten.content,
      replacements: 0,
      supported: true,
    });

    const runtime = await importFixture(rewritten.content);
    expect(runtime.exerciseProviderAliases()).toEqual({
      alias: 'plugin-provider',
      empty: '',
      explicit: 'openai',
      normalizedExplicit: 'OPENAI',
      scansAfterExplicit: 0,
      scansAfterNormalizedExplicit: 0,
      totalScans: 2,
      unknown: 'unknown',
    });
  });

  it('patches exactly one supported runtime file and rejects other versions', async () => {
    const { patchOpenClawModelCatalogCacheRuntime } = await importPatchModule();
    const runtime = await writeRuntime();

    await expect(patchOpenClawModelCatalogCacheRuntime(runtime.root)).resolves.toEqual({
      filesPatched: 1,
      filesScanned: 1,
    });
    await expect(readFile(runtime.target, 'utf8')).resolves.toContain(
      'defaultBundledStaticCatalogModelResolvers.set',
    );
    await expect(patchOpenClawModelCatalogCacheRuntime(runtime.root)).resolves.toEqual({
      filesPatched: 0,
      filesScanned: 1,
    });

    const unsupported = await writeRuntime('2026.6.11');
    await expect(patchOpenClawModelCatalogCacheRuntime(unsupported.root)).rejects.toThrow(
      'Expected OpenClaw 2026.6.10',
    );
  });

  it('fails closed for unknown, partial, missing, and duplicate runtime layouts', async () => {
    const { patchOpenClawModelCatalogCacheRuntime } = await importPatchModule();

    const unknown = await writeRuntime('2026.6.10', 'unknown runtime layout');
    await expect(patchOpenClawModelCatalogCacheRuntime(unknown.root)).rejects.toThrow(
      'Unsupported OpenClaw static model catalog layout across 1 runtime file(s)',
    );

    const partial = await writeRuntime(
      '2026.6.10',
      `${runtimeSource}\nlet defaultBundledStaticCatalogModelResolver;`,
    );
    await expect(patchOpenClawModelCatalogCacheRuntime(partial.root)).rejects.toThrow(
      'Unsupported partial bundled model catalog cache patch layout',
    );

    const partialAlias = await writeRuntime(
      '2026.6.10',
      runtimeSource.replace(
        providerAliasSource,
        'function canonicalizeManifestModelCatalogProviderAlias(params) { return params.provider; }',
      ),
    );
    await expect(patchOpenClawModelCatalogCacheRuntime(partialAlias.root)).rejects.toThrow(
      'Unsupported partial provider alias discovery patch layout',
    );

    const missing = await writeRuntime('2026.6.10', runtimeSource, 'other-runtime.js');
    await expect(patchOpenClawModelCatalogCacheRuntime(missing.root)).rejects.toThrow(
      'Expected at least one OpenClaw static model catalog runtime file, found 0',
    );

    const duplicate = await writeRuntime();
    await writeFile(
      join(duplicate.root, 'dist', 'model.static-catalog-second.js'),
      runtimeSource,
      'utf8',
    );
    await expect(patchOpenClawModelCatalogCacheRuntime(duplicate.root)).rejects.toThrow(
      'Expected one supported static model catalog layout, found 2',
    );
  });

  it('runs during dependency installation and OpenClaw bundling', async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
      scripts: Record<string, string>;
    };
    const bundleScript = await readFile(join(repoRoot, 'scripts/bundle-openclaw.mjs'), 'utf8');

    expect(packageJson.devDependencies?.openclaw).toBe('2026.6.10');
    expect(packageJson.scripts.postinstall).toContain('openclaw-model-catalog-cache-patch.mjs');
    expect(bundleScript).toContain(
      "import { patchOpenClawModelCatalogCacheRuntime } from './openclaw-model-catalog-cache-patch.mjs';",
    );
    expect(bundleScript).toContain('await patchOpenClawModelCatalogCacheRuntime(OUTPUT)');
  });
});
