#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_OPENCLAW_VERSION = '2026.6.10';

const RESOLVER_SOURCE = [
  'function resolveBundledStaticCatalogModel(params) {',
  '\treturn createBundledStaticCatalogModelResolver({',
  '\t\t...params.env ? { env: params.env } : {},',
  '\t\t...params.includeRuntimeDiscovery !== void 0 ? { includeRuntimeDiscovery: params.includeRuntimeDiscovery } : {}',
  '\t})(params);',
  '}',
].join('\n');

const LEGACY_RESOLVER_TARGET = [
  'let defaultBundledStaticCatalogModelResolver;',
  'function resolveBundledStaticCatalogModel(params) {',
  '\tif (!params.env && params.includeRuntimeDiscovery === void 0) {',
  '\t\tdefaultBundledStaticCatalogModelResolver ??= createBundledStaticCatalogModelResolver();',
  '\t\treturn defaultBundledStaticCatalogModelResolver(params);',
  '\t}',
  '\treturn createBundledStaticCatalogModelResolver({',
  '\t\t...params.env ? { env: params.env } : {},',
  '\t\t...params.includeRuntimeDiscovery !== void 0 ? { includeRuntimeDiscovery: params.includeRuntimeDiscovery } : {}',
  '\t})(params);',
  '}',
].join('\n');

const RESOLVER_TARGET = [
  'const defaultBundledStaticCatalogModelResolvers = new Map();',
  'function resolveBundledStaticCatalogModel(params) {',
  '\tif (!params.env) {',
  '\t\tconst includeRuntimeDiscovery = Boolean(params.includeRuntimeDiscovery);',
  '\t\tlet resolver = defaultBundledStaticCatalogModelResolvers.get(includeRuntimeDiscovery);',
  '\t\tif (!resolver) {',
  '\t\t\tresolver = createBundledStaticCatalogModelResolver({ includeRuntimeDiscovery });',
  '\t\t\tdefaultBundledStaticCatalogModelResolvers.set(includeRuntimeDiscovery, resolver);',
  '\t\t}',
  '\t\treturn resolver(params);',
  '\t}',
  '\treturn createBundledStaticCatalogModelResolver({',
  '\t\t...params.env ? { env: params.env } : {},',
  '\t\t...params.includeRuntimeDiscovery !== void 0 ? { includeRuntimeDiscovery: params.includeRuntimeDiscovery } : {}',
  '\t})(params);',
  '}',
].join('\n');

const PROVIDER_ALIAS_SOURCE = [
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

const PROVIDER_ALIAS_TARGET = [
  'function canonicalizeManifestModelCatalogProviderAlias(params) {',
  '\tconst provider = normalizeProviderId(params.provider);',
  '\tif (!provider) return params.provider;',
  '\tif (Object.keys(params.cfg?.models?.providers ?? {}).some((candidate) => normalizeProviderId(candidate) === provider)) return params.provider;',
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

function countOccurrences(content, value) {
  return content.split(value).length - 1;
}

/** Reuse immutable bundled model-catalog discovery for ordinary runtime lookups. */
export function rewriteBundledModelCatalogResolver(content) {
  if (countOccurrences(content, LEGACY_RESOLVER_TARGET) === 1) {
    return rewriteBundledModelCatalogResolver(content.replace(LEGACY_RESOLVER_TARGET, RESOLVER_SOURCE));
  }
  const patchedMatches = countOccurrences(content, RESOLVER_TARGET);
  if (patchedMatches === 1) {
    return { content, replacements: 0, supported: true };
  }
  if (patchedMatches > 1) {
    throw new Error(`Expected one patched bundled model catalog resolver, found ${patchedMatches}.`);
  }

  if (content.includes('defaultBundledStaticCatalogModelResolver')) {
    throw new Error('Unsupported partial bundled model catalog cache patch layout.');
  }

  const sourceMatches = countOccurrences(content, RESOLVER_SOURCE);
  if (sourceMatches === 0) {
    return { content, replacements: 0, supported: false };
  }
  if (sourceMatches !== 1) {
    throw new Error(`Expected one pristine bundled model catalog resolver, found ${sourceMatches}.`);
  }

  return {
    content: content.replace(RESOLVER_SOURCE, RESOLVER_TARGET),
    replacements: 1,
    supported: true,
  };
}

/** Honor explicit provider configuration before discovering plugin aliases. */
export function rewriteExplicitProviderAliasDiscovery(content) {
  const patchedMatches = countOccurrences(content, PROVIDER_ALIAS_TARGET);
  if (patchedMatches === 1) {
    return { content, replacements: 0, supported: true };
  }
  if (patchedMatches > 1) {
    throw new Error(`Expected one patched provider alias resolver, found ${patchedMatches}.`);
  }

  const sourceMatches = countOccurrences(content, PROVIDER_ALIAS_SOURCE);
  if (sourceMatches === 0) {
    if (content.includes('function canonicalizeManifestModelCatalogProviderAlias(params)')) {
      throw new Error('Unsupported partial provider alias discovery patch layout.');
    }
    return { content, replacements: 0, supported: false };
  }
  if (sourceMatches !== 1) {
    throw new Error(`Expected one pristine provider alias resolver, found ${sourceMatches}.`);
  }

  return {
    content: content.replace(PROVIDER_ALIAS_SOURCE, PROVIDER_ALIAS_TARGET),
    replacements: 1,
    supported: true,
  };
}

/** Patch exactly one OpenClaw 2026.6.10 static model-catalog runtime file. */
export async function patchOpenClawModelCatalogCacheRuntime(openclawDir) {
  const packageJson = JSON.parse(await readFile(join(openclawDir, 'package.json'), 'utf8'));
  if (packageJson.version !== SUPPORTED_OPENCLAW_VERSION) {
    throw new Error(
      `Expected OpenClaw ${SUPPORTED_OPENCLAW_VERSION}, found ${String(packageJson.version)}.`,
    );
  }

  const distDir = join(openclawDir, 'dist');
  const entries = await readdir(distDir, { withFileTypes: true });
  const runtimeFiles = entries
    .filter((entry) => entry.isFile() && /^model\.static-catalog-.*\.js$/u.test(entry.name))
    .map((entry) => join(distDir, entry.name));

  if (runtimeFiles.length === 0) {
    throw new Error(
      'Expected at least one OpenClaw static model catalog runtime file, found 0.',
    );
  }

  const inspected = await Promise.all(runtimeFiles.map(async (filePath) => {
    const content = await readFile(filePath, 'utf8');
    const resolver = rewriteBundledModelCatalogResolver(content);
    const providerAlias = rewriteExplicitProviderAliasDiscovery(resolver.content);
    return {
      filePath,
      rewritten: {
        content: providerAlias.content,
        replacements: resolver.replacements + providerAlias.replacements,
        supported: resolver.supported && providerAlias.supported,
      },
    };
  }));
  const supported = inspected.filter((entry) => entry.rewritten.supported);
  if (supported.length === 0) {
    throw new Error(
      `Unsupported OpenClaw static model catalog layout across ${runtimeFiles.length} runtime file(s).`,
    );
  }
  if (supported.length !== 1) {
    throw new Error(`Expected one supported static model catalog layout, found ${supported.length}.`);
  }

  const [{ filePath, rewritten }] = supported;
  if (rewritten.replacements > 0) {
    await writeFile(filePath, rewritten.content, 'utf8');
  }

  return { filesPatched: rewritten.replacements > 0 ? 1 : 0, filesScanned: runtimeFiles.length };
}

async function main() {
  const openclawDir = join(process.cwd(), 'node_modules', 'openclaw');
  const result = await patchOpenClawModelCatalogCacheRuntime(openclawDir);
  console.log(
    `[patch-openclaw-model-catalog-cache] verified ${result.filesScanned} runtime file(s), patched ${result.filesPatched}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
