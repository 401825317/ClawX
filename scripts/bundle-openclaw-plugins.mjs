#!/usr/bin/env zx

/**
 * bundle-openclaw-plugins.mjs
 *
 * Build a self-contained mirror of OpenClaw third-party plugins for packaging.
 * Current plugins:
 *   - @soimy/dingtalk -> build/openclaw-plugins/dingtalk
 *   - @wecom/wecom-openclaw-plugin -> build/openclaw-plugins/wecom
 *   - @larksuite/openclaw-lark -> build/openclaw-plugins/feishu-openclaw-plugin
 *   - @openclaw/qqbot -> build/openclaw-plugins/qqbot
 *   - @tencent-weixin/openclaw-weixin -> build/openclaw-plugins/openclaw-weixin
 *   - @openclaw/parallel-plugin -> build/openclaw-plugins/parallel
 *
 * The output plugin directory contains:
 *   - plugin source files (index.ts, openclaw.plugin.json, package.json, ...)
 *   - plugin runtime node_modules/ (flattened direct + transitive deps)
 */

import 'zx/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_OPENCLAW_PLUGINS, LOCAL_OPENCLAW_PLUGIN_IDS } from './openclaw-bundle-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.join(ROOT, 'build', 'openclaw-plugins');
const NODE_MODULES = path.join(ROOT, 'node_modules');

// On Windows, pnpm virtual store paths can exceed MAX_PATH (260 chars).
// Adding \\?\ prefix bypasses the limit for Win32 fs calls.
// Node.js 18.17+ also handles this transparently when LongPathsEnabled=1,
// but this is an extra safety net for build machines where the registry key
// may not be set yet.
function normWin(p) {
  if (process.platform !== 'win32') return p;
  if (p.startsWith('\\\\?\\')) return p;
  return '\\\\?\\' + p.replace(/\//g, '\\');
}

function realpathSyncSafe(p) {
  if (process.platform === 'win32') {
    try {
      return fs.realpathSync.native(normWin(p));
    } catch {
      return fs.realpathSync(p);
    }
  }
  return fs.realpathSync(p);
}

const LOCAL_PLUGINS = LOCAL_OPENCLAW_PLUGIN_IDS.map((pluginId) => ({
  sourceDir: path.join(ROOT, 'resources', 'openclaw-plugins', pluginId),
  pluginId,
}));

function getVirtualStoreNodeModules(realPkgPath) {
  let dir = realPkgPath;
  while (dir !== path.dirname(dir)) {
    if (path.basename(dir) === 'node_modules') return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function listPackages(nodeModulesDir) {
  const result = [];
  const nDir = normWin(nodeModulesDir);
  if (!fs.existsSync(nDir)) return result;

  for (const entry of fs.readdirSync(nDir)) {
    if (entry === '.bin') continue;
    // Use original (non-normWin) path so callers can call
    // getVirtualStoreNodeModules() on fullPath correctly.
    const entryPath = path.join(nodeModulesDir, entry);

    if (entry.startsWith('@')) {
      let scopeEntries = [];
      try {
        scopeEntries = fs.readdirSync(normWin(entryPath));
      } catch {
        continue;
      }
      for (const sub of scopeEntries) {
        result.push({
          name: `${entry}/${sub}`,
          fullPath: path.join(entryPath, sub),
        });
      }
    } else {
      result.push({ name: entry, fullPath: entryPath });
    }
  }
  return result;
}

function readRuntimeDependencies(pluginDir) {
  const pkgJsonPath = path.join(pluginDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return [];
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  return Object.keys(pkg.dependencies || {}).sort();
}

function assertRuntimeDependencies(pluginDir, pluginId) {
  const missing = readRuntimeDependencies(pluginDir).filter((depName) => {
    const depDir = path.join(pluginDir, 'node_modules', ...depName.split('/'));
    return !fs.existsSync(path.join(depDir, 'package.json'));
  });

  if (missing.length > 0) {
    throw new Error(`Bundled plugin "${pluginId}" is missing runtime dependencies: ${missing.join(', ')}`);
  }
}

function getDeclaredPluginEntries(pkg, manifest) {
  return [...new Set([
    manifest.entry,
    pkg.main,
    pkg.module,
    ...(Array.isArray(pkg.openclaw?.extensions) ? pkg.openclaw.extensions : []),
    ...(Array.isArray(pkg.openclaw?.runtimeExtensions) ? pkg.openclaw.runtimeExtensions : []),
  ].filter((entry) => typeof entry === 'string' && entry.trim()))];
}

function assertBundledPluginMetadata(pluginDir, plugin) {
  const pkg = readJson(path.join(pluginDir, 'package.json'), `Bundled plugin ${plugin.pluginId} package.json`);
  const manifest = readJson(path.join(pluginDir, 'openclaw.plugin.json'), `Bundled plugin ${plugin.pluginId} manifest`);
  if (pkg.name !== plugin.npmName) {
    throw new Error(`Bundled plugin ${plugin.pluginId} package name mismatch: ${String(pkg.name)}`);
  }
  if (manifest.id !== plugin.manifestId) {
    throw new Error(`Bundled plugin ${plugin.pluginId} manifest id mismatch: ${String(manifest.id)}`);
  }
  if (!pkg.version) throw new Error(`Bundled plugin ${plugin.pluginId} package version is missing`);
  if (manifest.version !== undefined && manifest.version !== pkg.version) {
    throw new Error(
      `Bundled plugin ${plugin.pluginId} version mismatch: package=${String(pkg.version)} manifest=${String(manifest.version)}`,
    );
  }
  const entries = getDeclaredPluginEntries(pkg, manifest);
  if (entries.length === 0 || !entries.some((entry) => fs.existsSync(path.join(pluginDir, entry)))) {
    throw new Error(`Bundled plugin ${plugin.pluginId} has no existing declared entrypoint: ${entries.join(', ') || 'none'}`);
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is missing or invalid: ${filePath} (${error instanceof Error ? error.message : String(error)})`);
  }
}

function assertLocalPluginMetadata(pluginDir, expectedId) {
  const pkg = readJson(path.join(pluginDir, 'package.json'), `Local plugin ${expectedId} package.json`);
  const manifest = readJson(path.join(pluginDir, 'openclaw.plugin.json'), `Local plugin ${expectedId} manifest`);
  if (manifest.id !== expectedId) {
    throw new Error(`Local plugin directory/id mismatch: expected "${expectedId}", manifest has "${String(manifest.id)}"`);
  }
  if (pkg.name !== expectedId && pkg.name !== `${expectedId}-plugin`) {
    throw new Error(`Local plugin ${expectedId} package name mismatch: "${String(pkg.name)}"`);
  }
  if (!pkg.version || pkg.version !== manifest.version) {
    throw new Error(
      `Local plugin ${expectedId} version mismatch: package=${String(pkg.version)} manifest=${String(manifest.version)}`,
    );
  }
  if (!pkg.main || pkg.main !== manifest.entry) {
    throw new Error(
      `Local plugin ${expectedId} entry mismatch: package.main=${String(pkg.main)} manifest.entry=${String(manifest.entry)}`,
    );
  }
  if (!fs.existsSync(path.join(pluginDir, manifest.entry))) {
    throw new Error(`Local plugin ${expectedId} entry file is missing: ${String(manifest.entry)}`);
  }
  if (pkg.openclaw?.extensions !== undefined
    && (!Array.isArray(pkg.openclaw.extensions) || !pkg.openclaw.extensions.includes(`./${manifest.entry}`))) {
    throw new Error(`Local plugin ${expectedId} package.json declares an inconsistent OpenClaw entry`);
  }
  return { packageName: pkg.name, id: manifest.id, version: pkg.version, entry: manifest.entry };
}

function bundleOnePlugin(plugin) {
  const { npmName, pluginId } = plugin;
  const pkgPath = path.join(NODE_MODULES, ...npmName.split('/'));
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`Missing dependency "${npmName}". Run pnpm install first.`);
  }

  const realPluginPath = realpathSyncSafe(pkgPath);
  const outputDir = path.join(OUTPUT_ROOT, pluginId);

  echo`📦 Bundling plugin ${npmName} -> ${outputDir}`;

  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });

  // 1) Copy plugin package itself
  fs.cpSync(realPluginPath, outputDir, { recursive: true, dereference: true });

  // 2) Collect transitive deps from pnpm virtual store
  const collected = new Map();
  const queue = [];
  const rootVirtualNM = getVirtualStoreNodeModules(realPluginPath);
  if (!rootVirtualNM) {
    throw new Error(`Cannot resolve virtual store node_modules for ${npmName}`);
  }
  queue.push({ nodeModulesDir: rootVirtualNM, skipPkg: npmName });

  // Skip peerDependencies — they're provided by the host openclaw gateway.
  const SKIP_PACKAGES = new Set(['typescript', '@playwright/test']);
  const SKIP_SCOPES = ['@types/'];
  try {
    const pluginPkg = JSON.parse(fs.readFileSync(path.join(outputDir, 'package.json'), 'utf8'));
    for (const peer of Object.keys(pluginPkg.peerDependencies || {})) {
      SKIP_PACKAGES.add(peer);
    }
  } catch { /* ignore */ }

  while (queue.length > 0) {
    const { nodeModulesDir, skipPkg } = queue.shift();
    for (const { name, fullPath } of listPackages(nodeModulesDir)) {
      if (name === skipPkg) continue;
      if (SKIP_PACKAGES.has(name) || SKIP_SCOPES.some((s) => name.startsWith(s))) continue;

      let realPath;
      try {
        realPath = realpathSyncSafe(fullPath);
      } catch {
        continue;
      }
      if (collected.has(realPath)) continue;
      collected.set(realPath, name);

      const depVirtualNM = getVirtualStoreNodeModules(realPath);
      if (depVirtualNM && depVirtualNM !== nodeModulesDir) {
        queue.push({ nodeModulesDir: depVirtualNM, skipPkg: name });
      }
    }
  }

  // 3) Copy flattened deps into plugin/node_modules
  const outputNodeModules = path.join(outputDir, 'node_modules');
  fs.mkdirSync(outputNodeModules, { recursive: true });

  let copiedCount = 0;
  let skippedDupes = 0;
  const copiedNames = new Set();

  for (const [realPath, pkgName] of collected) {
    if (copiedNames.has(pkgName)) {
      skippedDupes++;
      continue;
    }
    copiedNames.add(pkgName);

    const dest = path.join(outputNodeModules, pkgName);
    try {
      fs.mkdirSync(normWin(path.dirname(dest)), { recursive: true });
      fs.cpSync(normWin(realPath), normWin(dest), { recursive: true, dereference: true });
      copiedCount++;
    } catch (err) {
      echo`   ⚠️  Skipped ${pkgName}: ${err.message}`;
    }
  }

  const manifestPath = path.join(outputDir, 'openclaw.plugin.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing openclaw.plugin.json in bundled plugin output: ${pluginId}`);
  }

  // 4) Patch plugin ID mismatch: some npm packages hardcode a different ID in
  //    their JS output than what openclaw.plugin.json declares.  The Gateway
  //    validates that these match, so we fix it post-copy.
  patchPluginId(outputDir, pluginId);

  assertRuntimeDependencies(outputDir, pluginId);
  assertBundledPluginMetadata(outputDir, plugin);

  echo`   ✅ ${pluginId}: copied ${copiedCount} deps (skipped dupes: ${skippedDupes})`;
}

function bundleLocalPlugin({ sourceDir, pluginId }) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Missing local plugin source: ${sourceDir}`);
  }
  assertLocalPluginMetadata(sourceDir, pluginId);

  const outputDir = path.join(OUTPUT_ROOT, pluginId);
  echo`Bundling local plugin ${pluginId} -> ${outputDir}`;

  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });
  fs.cpSync(normWin(sourceDir), normWin(outputDir), { recursive: true, dereference: true });

  const pkgJsonPath = path.join(outputDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const dependencies = Object.keys(pkg.dependencies || {});

  const SKIP_PACKAGES = new Set(['typescript', '@playwright/test']);
  const SKIP_SCOPES = ['@types/'];
  for (const peer of Object.keys(pkg.peerDependencies || {})) {
    SKIP_PACKAGES.add(peer);
  }

  const collected = new Map();
  const queue = [];
  for (const depName of dependencies) {
    const depPath = path.join(NODE_MODULES, ...depName.split('/'));
    if (!fs.existsSync(depPath)) {
      throw new Error(`Missing dependency "${depName}" for local plugin "${pluginId}". Run pnpm install first.`);
    }
    const realDepPath = realpathSyncSafe(depPath);
    collected.set(realDepPath, depName);
    const rootVirtualNM = getVirtualStoreNodeModules(realDepPath);
    if (rootVirtualNM) {
      queue.push({ nodeModulesDir: rootVirtualNM, skipPkg: depName });
    }
  }

  while (queue.length > 0) {
    const { nodeModulesDir, skipPkg } = queue.shift();
    for (const { name, fullPath } of listPackages(nodeModulesDir)) {
      if (name === skipPkg) continue;
      if (SKIP_PACKAGES.has(name) || SKIP_SCOPES.some((s) => name.startsWith(s))) continue;

      let realPath;
      try {
        realPath = realpathSyncSafe(fullPath);
      } catch {
        continue;
      }
      if (collected.has(realPath)) continue;
      collected.set(realPath, name);

      const depVirtualNM = getVirtualStoreNodeModules(realPath);
      if (depVirtualNM && depVirtualNM !== nodeModulesDir) {
        queue.push({ nodeModulesDir: depVirtualNM, skipPkg: name });
      }
    }
  }

  const outputNodeModules = path.join(outputDir, 'node_modules');
  fs.mkdirSync(outputNodeModules, { recursive: true });
  const copiedNames = new Set();
  let copiedCount = 0;
  let skippedDupes = 0;
  for (const [realDepPath, depName] of collected) {
    if (copiedNames.has(depName)) {
      skippedDupes++;
      continue;
    }
    copiedNames.add(depName);
    const depOutputPath = path.join(outputNodeModules, depName);
    fs.mkdirSync(normWin(path.dirname(depOutputPath)), { recursive: true });
    fs.cpSync(normWin(realDepPath), normWin(depOutputPath), { recursive: true, dereference: true });
    copiedCount++;
  }

  assertRuntimeDependencies(outputDir, pluginId);
  assertLocalPluginMetadata(outputDir, pluginId);

  echo`   ✅ ${pluginId}: copied ${copiedCount} local deps (skipped dupes: ${skippedDupes})`;
}

/**
 * Patch plugin entry JS files so the exported `id` matches openclaw.plugin.json.
 * Some plugins (e.g. wecom) ship with a hardcoded ID in their compiled output
 * that differs from the manifest, causing a Gateway "plugin id mismatch" error.
 */
function patchPluginId(pluginDir, expectedId) {
  const manifestPath = path.join(pluginDir, 'openclaw.plugin.json');
  if (!fs.existsSync(manifestPath)) return;

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const manifestId = manifest.id;
  if (manifestId !== expectedId) {
    echo`   ⚠️  Manifest ID "${manifestId}" doesn't match expected "${expectedId}", skipping patch`;
    return;
  }

  // Read the package.json to find the main entry point
  const pkgJsonPath = path.join(pluginDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return;

  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const entryFiles = [pkg.main, pkg.module].filter(Boolean);

  // Known ID mismatches to patch.  Keys are the wrong ID found in compiled JS,
  // values are the correct ID (must match openclaw.plugin.json).
  const ID_FIXES = {
    'wecom-openclaw-plugin': 'wecom',
  };

  for (const entry of entryFiles) {
    const entryPath = path.join(pluginDir, entry);
    if (!fs.existsSync(entryPath)) continue;

    let content = fs.readFileSync(entryPath, 'utf8');
    let patched = false;

    for (const [wrongId, correctId] of Object.entries(ID_FIXES)) {
      if (correctId !== expectedId) continue;
      // Replace  id: "wecom-openclaw-plugin"  or  id: 'wecom-openclaw-plugin'
      const pattern = new RegExp(`(\\bid\\s*:\\s*)(["'])${wrongId.replace(/-/g, '\\-')}\\2`, 'g');
      const replaced = content.replace(pattern, `$1$2${correctId}$2`);
      if (replaced !== content) {
        content = replaced;
        patched = true;
        echo`   🩹 Patching plugin ID in ${entry}: "${wrongId}" → "${correctId}"`;
      }
    }

    if (patched) {
      fs.writeFileSync(entryPath, content, 'utf8');
    }
  }
}

echo`📦 Bundling OpenClaw plugin mirrors...`;
if (fs.existsSync(OUTPUT_ROOT)) {
  fs.rmSync(OUTPUT_ROOT, { recursive: true, force: true });
}
fs.mkdirSync(OUTPUT_ROOT, { recursive: true });

for (const plugin of BUNDLED_OPENCLAW_PLUGINS) {
  bundleOnePlugin(plugin);
}

for (const plugin of LOCAL_PLUGINS) {
  bundleLocalPlugin(plugin);
}

echo`✅ Plugin mirrors ready: ${OUTPUT_ROOT}`;
