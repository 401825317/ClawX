import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { patchOpenClawPreparationRuntime, rewriteBundleManifestScope, rewriteNativeRuntimeAlias } from '../../scripts/openclaw-preparation-patch.mjs';

const runtimeSource = `function resolveCliRuntimeExecutionProvider(params) {
  const runtime = params.runtime;
\tif (runtime === "openclaw") return;
  return lookup(params);
}`;
const bundleSource = `import { n as loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry-fixture.js";
function loadEnabledBundleConfig(params) {
  if (params.cfg?.plugins?.enabled === false) return [];
\tconst registry = params.manifestRegistry ?? loadPluginManifestRegistryForPluginRegistry({
\t\tworkspaceDir: params.workspaceDir,
\t\tconfig: params.cfg,
\t\tincludeDisabled: true
\t});
  return registry.plugins.filter(p => p.format === 'bundle');
}`;

describe('OpenClaw client preparation patch', () => {
  it('treats pi as the native alias without suppressing external CLI selection', () => {
    const calls: unknown[] = [];
    const resolve = runInNewContext(`${rewriteNativeRuntimeAlias(runtimeSource).content}; resolveCliRuntimeExecutionProvider`, {
      lookup: (params: unknown) => { calls.push(params); return 'external'; },
    });
    for (const runtime of ['pi', 'openclaw']) expect(resolve({ runtime })).toBeUndefined();
    for (const runtime of ['auto', 'claude-cli', 'custom-cli', undefined]) expect(resolve({ runtime })).toBe('external');
    expect(calls).toHaveLength(4);
  });

  it('scopes manifests using the current index on every call and preserves disabled bundle candidates', () => {
    let plugins = [{ pluginId: 'normal' }, { pluginId: 'b1', format: 'bundle', enabled: false }];
    const seen: Record<string, unknown>[] = [];
    const load = runInNewContext(`${rewriteBundleManifestScope(bundleSource).content.replace(/^import[^\n]+\n/u, '')}; loadEnabledBundleConfig`, {
      loadPluginRegistrySnapshot: () => ({ plugins }),
      loadPluginManifestRegistryForPluginRegistry: (params: Record<string, unknown>) => {
        seen.push(params);
        return { plugins: plugins.filter(p => (params.pluginIds as string[]).includes(p.pluginId)) };
      },
    });
    const cfg = { plugins: {} };
    expect(load({ cfg, workspaceDir: 'first' })).toHaveLength(1);
    expect(seen[0]).toMatchObject({ config: cfg, workspaceDir: 'first', includeDisabled: true, pluginIds: ['b1'] });
    plugins = [{ pluginId: 'normal' }, { pluginId: 'b2', format: 'bundle', enabled: true }];
    load({ cfg, workspaceDir: 'second' });
    expect(seen[1]).toMatchObject({ workspaceDir: 'second', pluginIds: ['b2'] });
    plugins = [{ pluginId: 'normal' }];
    expect(load({ cfg })).toHaveLength(0);
    expect(seen[2].pluginIds).toEqual([]);
    const supplied = { plugins: [{ pluginId: 'supplied', format: 'bundle' }] };
    expect(load({ cfg, manifestRegistry: supplied })).toHaveLength(1);
    expect(load({ cfg: { plugins: { enabled: false } } })).toHaveLength(0);
    expect(seen).toHaveLength(3);
  });

  it('is idempotent and rejects duplicate, partial, and unknown layouts', () => {
    const runtime = rewriteNativeRuntimeAlias(runtimeSource).content;
    const bundle = rewriteBundleManifestScope(bundleSource).content;
    expect(rewriteNativeRuntimeAlias(runtime).changed).toBe(false);
    expect(rewriteBundleManifestScope(bundle).changed).toBe(false);
    expect(() => rewriteNativeRuntimeAlias(runtimeSource + runtimeSource)).toThrow();
    expect(() => rewriteBundleManifestScope(bundleSource + bundleSource)).toThrow();
    expect(() => rewriteBundleManifestScope(bundle.replace(', p as loadPluginRegistrySnapshot', ''))).toThrow();
    expect(() => rewriteNativeRuntimeAlias('unknown')).toThrow();
    expect(() => rewriteBundleManifestScope('unknown')).toThrow();
  });

  it('validates version and all chunks before writing, then applies exactly once', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'uclaw-prep-test-'));
    try {
      await mkdir(path.join(root, 'dist'));
      const runtimeFile = path.join(root, 'dist/model-runtime-aliases-fixture.js');
      const bundleFile = path.join(root, 'dist/bundle-mcp-fixture.js');
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: 'bad' }));
      await writeFile(runtimeFile, runtimeSource);
      await writeFile(bundleFile, 'unknown');
      await expect(patchOpenClawPreparationRuntime(root)).rejects.toThrow('Expected OpenClaw');
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '2026.6.10' }));
      await expect(patchOpenClawPreparationRuntime(root)).rejects.toThrow();
      expect(await readFile(runtimeFile, 'utf8')).toBe(runtimeSource);
      await writeFile(bundleFile, bundleSource);
      expect(await patchOpenClawPreparationRuntime(root)).toEqual({ filesPatched: 2, filesScanned: 2 });
      expect(await patchOpenClawPreparationRuntime(root)).toEqual({ filesPatched: 0, filesScanned: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
