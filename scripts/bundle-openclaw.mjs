#!/usr/bin/env zx

/**
 * bundle-openclaw.mjs
 *
 * Bundles the openclaw npm package with ALL its dependencies (including
 * transitive ones) into a self-contained directory (build/openclaw/) for
 * electron-builder to pick up.
 *
 * pnpm uses a content-addressable virtual store with symlinks. A naive copy
 * of node_modules/openclaw/ will miss runtime dependencies entirely. Even
 * copying only direct siblings misses transitive deps (e.g. @clack/prompts
 * depends on @clack/core which lives in a separate virtual store entry).
 *
 * This script performs a recursive BFS through pnpm's virtual store to
 * collect every transitive dependency into a flat node_modules structure.
 */

import 'zx/globals';
import { ELECTRON_MAIN_RUNTIME_PACKAGES, EXTRA_BUNDLED_PACKAGES } from './openclaw-bundle-config.mjs';
import { UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILL_SET } from './openclaw-bundled-skill-allowlist.mjs';
import { patchOpenClawBrowserRuntime } from './openclaw-browser-runtime-patch.mjs';
import { cleanupOpenClawRequiredContractToolRuntime } from './openclaw-contract-tool-cleanup.mjs';
import { patchOpenClawFinalizeLocalActionRuntime } from './openclaw-finalize-local-action-patch.mjs';
import { patchOpenClawModelRequestContractRuntime } from './openclaw-model-request-contract-patch.mjs';
import { patchOpenClawNativeImageDeliveryRuntime } from './openclaw-native-image-delivery-patch.mjs';
import { patchOpenClawNativeMediaCancellationRuntime } from './openclaw-native-media-cancellation-patch.mjs';
import { patchOpenClawManagedMediaTimeoutRuntime } from './openclaw-managed-media-timeout-patch.mjs';
import { cleanupOpenClawNativeMediaAcceptanceRuntime } from './openclaw-native-media-acceptance-cleanup.mjs';
import { patchOpenClawVideoActualSpecRuntime } from './openclaw-video-actual-spec-patch.mjs';
import { patchOpenClawVideoCapabilityContractRuntime } from './openclaw-video-capability-contract-patch.mjs';
import { patchOpenClawVideoProviderCatalogRuntime } from './openclaw-video-provider-catalog-patch.mjs';
import { patchOpenClawVideoSegmentDedupeRuntime } from './openclaw-video-segment-dedupe-patch.mjs';
import { patchOpenClawPluginToolRunContextRuntime } from './openclaw-plugin-tool-run-context-patch.mjs';
import { patchOpenClawPromptCacheKeyRuntime } from './openclaw-prompt-cache-key-patch.mjs';
import { patchOpenClawRawToolSignalRuntime } from './openclaw-raw-tool-signal-patch.mjs';
import { patchOpenClawReplySessionInitConflictRuntime } from './openclaw-reply-session-init-conflict-patch.mjs';
import { patchOpenClawTextProviderFailoverRuntime } from './openclaw-text-provider-failover-patch.mjs';
import { patchOpenClawCompactionSessionStateRuntime } from './openclaw-compaction-session-state-patch.mjs';
import { patchOpenClawSessionCwdRuntime } from './openclaw-session-cwd-runtime-patch.mjs';
import { patchOpenClawStreamingRuntime } from './openclaw-streaming-runtime-patch.mjs';
import { patchOpenClawSystemPromptReasoningLabelRuntime } from './openclaw-system-prompt-reasoning-label-patch.mjs';
import { patchOpenClawTaskSummaryDeliveryRuntime } from './openclaw-task-summary-delivery-patch.mjs';
import { patchOpenClawToolDirectoryI18nRuntime } from './openclaw-tool-directory-i18n-patch.mjs';
import { patchExtensionOpenClawSelfImports } from './openclaw-self-import-patch.mjs';

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'build', 'openclaw');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const OPENCLAW_SKILL_SHIMS = path.join(ROOT, 'resources', 'openclaw-skill-shims');
const ENABLE_OPENCLAW_BROWSER_RUNTIME_PATCH = process.env.CLAWX_ENABLE_OPENCLAW_BROWSER_PATCH === '1';

function isJunFeiAIManagedDistribution() {
  return process.env.CLAWX_MANAGED_PROVIDER !== '0';
}

// On Windows, pnpm virtual store paths can exceed MAX_PATH (260 chars).
function normWin(p) {
  if (process.platform !== 'win32') return p;
  if (p.startsWith('\\\\?\\')) return p;
  return '\\\\?\\' + p.replace(/\//g, '\\');
}

echo`📦 Bundling openclaw for electron-builder...`;

// 1. Resolve the real path of node_modules/openclaw (follows pnpm symlink)
const openclawLink = path.join(NODE_MODULES, 'openclaw');
if (!fs.existsSync(openclawLink)) {
  echo`❌ node_modules/openclaw not found. Run pnpm install first.`;
  process.exit(1);
}

const openclawReal = fs.realpathSync(openclawLink);
echo`   openclaw resolved: ${openclawReal}`;

function shouldCopyOpenClawPackageEntry(src) {
  const rel = path.relative(openclawReal, src);
  if (!rel || rel.startsWith('..')) return true;
  const parts = rel.split(path.sep);

  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] === 'node_modules' && parts[i + 1] === '.bin') {
      return false;
    }
  }

  return true;
}

function trimBundledOpenClawSkills(skillsRoot) {
  if (isJunFeiAIManagedDistribution()) {
    return { removed: 0, kept: ['*'] };
  }
  if (!fs.existsSync(skillsRoot)) return { removed: 0, kept: [...UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILL_SET] };

  let removed = 0;
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILL_SET.has(entry.name)) continue;

    const skillDir = path.join(skillsRoot, entry.name);
    if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) continue;
    fs.rmSync(skillDir, { recursive: true, force: true });
    removed += 1;
  }

  return { removed, kept: [...UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILL_SET] };
}

function installMissingOpenClawSkillShims(skillsRoot) {
  if (!fs.existsSync(OPENCLAW_SKILL_SHIMS)) return [];
  fs.mkdirSync(skillsRoot, { recursive: true });

  const installed = [];
  for (const entry of fs.readdirSync(OPENCLAW_SKILL_SHIMS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceDir = path.join(OPENCLAW_SKILL_SHIMS, entry.name);
    const sourceManifest = path.join(sourceDir, 'SKILL.md');
    if (!fs.existsSync(sourceManifest)) continue;

    const targetDir = path.join(skillsRoot, entry.name);
    const targetManifest = path.join(targetDir, 'SKILL.md');
    if (fs.existsSync(targetManifest)) continue;

    fs.cpSync(sourceDir, targetDir, { recursive: true, dereference: true });
    installed.push(entry.name);
  }
  return installed;
}

function removeDirRobust(targetDir) {
  if (!fs.existsSync(targetDir)) return;

  try {
    fs.rmSync(targetDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (fs.existsSync(targetDir) && (code === 'EACCES' || code === 'ENOTEMPTY' || code === 'EPERM')) {
      try {
        fs.removeSync(targetDir);
      } catch {
        // fall through to final existence check below
      }
    } else {
      throw error;
    }
  }

  if (fs.existsSync(targetDir)) {
    throw new Error(`Failed to remove directory: ${targetDir}`);
  }
}

// 2. Clean and create output directory
removeDirRobust(OUTPUT);
fs.mkdirSync(OUTPUT, { recursive: true });

// 3. Copy openclaw package itself to OUTPUT root
echo`   Copying openclaw package...`;
fs.cpSync(openclawReal, OUTPUT, {
  recursive: true,
  dereference: true,
  filter: shouldCopyOpenClawPackageEntry,
});

const installedSkillShims = installMissingOpenClawSkillShims(path.join(OUTPUT, 'skills'));
if (installedSkillShims.length > 0) {
  echo`   Installed OpenClaw skill compatibility shims: ${installedSkillShims.join(', ')}`;
}

const bundledSkillsTrim = trimBundledOpenClawSkills(path.join(OUTPUT, 'skills'));
if (bundledSkillsTrim.removed > 0) {
  echo`   Trimmed bundled OpenClaw skills: removed ${bundledSkillsTrim.removed}, kept ${bundledSkillsTrim.kept.join(', ')}`;
}

// 4. Recursively collect ALL transitive dependencies via pnpm virtual store BFS
//
// pnpm structure example:
//   .pnpm/openclaw@ver/node_modules/
//     openclaw/          <- real files
//     chalk/             <- symlink -> .pnpm/chalk@ver/node_modules/chalk
//     @clack/prompts/    <- symlink -> .pnpm/@clack+prompts@ver/node_modules/@clack/prompts
//
//   .pnpm/@clack+prompts@ver/node_modules/
//     @clack/prompts/    <- real files
//     @clack/core/       <- symlink (transitive dep, NOT in openclaw's siblings!)
//
// We BFS from openclaw's virtual store node_modules, following each symlink
// to discover the target's own virtual store node_modules and its deps.

const collected = new Map(); // realPath -> packageName (for deduplication)
const queue = []; // BFS queue of virtual-store node_modules dirs to visit

/**
 * Given a real path of a package, find the containing virtual-store node_modules.
 * e.g. .pnpm/chalk@5.4.1/node_modules/chalk -> .pnpm/chalk@5.4.1/node_modules
 * e.g. .pnpm/@clack+core@0.4.1/node_modules/@clack/core -> .pnpm/@clack+core@0.4.1/node_modules
 */
function getVirtualStoreNodeModules(realPkgPath) {
  let dir = realPkgPath;
  while (dir !== path.dirname(dir)) {
    if (path.basename(dir) === 'node_modules') {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * List all package entries in a virtual-store node_modules directory.
 * Handles both regular packages (chalk) and scoped packages (@clack/prompts).
 * Returns array of { name, fullPath }.
 */
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
      try {
        const scopeEntries = fs.readdirSync(normWin(entryPath));
        for (const sub of scopeEntries) {
          result.push({
            name: `${entry}/${sub}`,
            fullPath: path.join(entryPath, sub),
          });
        }
      } catch {
        // Not a directory, skip
      }
    } else {
      result.push({ name: entry, fullPath: entryPath });
    }
  }
  return result;
}

// Start BFS from openclaw's virtual store node_modules
const openclawVirtualNM = getVirtualStoreNodeModules(openclawReal);
if (!openclawVirtualNM) {
  echo`❌ Could not determine pnpm virtual store for openclaw`;
  process.exit(1);
}

echo`   Virtual store root: ${openclawVirtualNM}`;
queue.push({ nodeModulesDir: openclawVirtualNM, skipPkg: 'openclaw' });

const SKIP_PACKAGES = new Set([
  // Extra bundled extensions can declare openclaw as a peer/optional dependency.
  // The bundle already copies openclaw to OUTPUT root,
  // so do not also copy a duplicate into OUTPUT/node_modules/openclaw.
  'openclaw',
  'typescript',
  '@playwright/test',
]);
const SKIP_SCOPES = ['@cloudflare/', '@types/'];
let skippedDevCount = 0;

while (queue.length > 0) {
  const { nodeModulesDir, skipPkg } = queue.shift();
  const packages = listPackages(nodeModulesDir);

  for (const { name, fullPath } of packages) {
    // Skip the package that owns this virtual store entry (it's the package itself, not a dep)
    if (name === skipPkg) continue;

    if (SKIP_PACKAGES.has(name) || SKIP_SCOPES.some(s => name.startsWith(s))) {
      skippedDevCount++;
      continue;
    }

    let realPath;
    try {
      realPath = fs.realpathSync(fullPath);
    } catch {
      continue; // broken symlink, skip
    }

    if (collected.has(realPath)) continue; // already visited
    collected.set(realPath, name);

    // Find this package's own virtual store node_modules to discover ITS deps
    const depVirtualNM = getVirtualStoreNodeModules(realPath);
    if (depVirtualNM && depVirtualNM !== nodeModulesDir) {
      // Determine the package's "self name" in its own virtual store
      // For scoped: @clack/core -> skip "@clack/core" when scanning
      queue.push({ nodeModulesDir: depVirtualNM, skipPkg: name });
    }
  }
}

echo`   Found ${collected.size} total packages (direct + transitive)`;
echo`   Skipped ${skippedDevCount} dev-only package references`;

// 4b. Collect extra packages required by ClawX's Electron main process that are
//     NOT deps of openclaw.  These are resolved from openclaw's context at runtime
//     (via createRequire from the openclaw directory) so they must live in the
//     bundled openclaw/node_modules/.
//
//     For each package we resolve it from the workspace's own node_modules,
//     then BFS its transitive deps exactly like we did for openclaw above.
let extraCount = 0;
for (const pkgName of EXTRA_BUNDLED_PACKAGES) {
  const pkgLink = path.join(NODE_MODULES, ...pkgName.split('/'));
  if (!fs.existsSync(pkgLink)) {
    echo`   ⚠️  Extra package ${pkgName} not found in workspace node_modules, skipping.`;
    continue;
  }

  let pkgReal;
  try { pkgReal = fs.realpathSync(pkgLink); } catch { continue; }

  if (!collected.has(pkgReal)) {
    collected.set(pkgReal, pkgName);
    extraCount++;

    // BFS this package's own transitive deps
    const depVirtualNM = getVirtualStoreNodeModules(pkgReal);
    if (depVirtualNM) {
      const extraQueue = [{ nodeModulesDir: depVirtualNM, skipPkg: pkgName }];
      while (extraQueue.length > 0) {
        const { nodeModulesDir, skipPkg } = extraQueue.shift();
        const packages = listPackages(nodeModulesDir);
        for (const { name, fullPath } of packages) {
          if (name === skipPkg) continue;
          if (SKIP_PACKAGES.has(name) || SKIP_SCOPES.some(s => name.startsWith(s))) continue;
          let realPath;
          try { realPath = fs.realpathSync(fullPath); } catch { continue; }
          if (collected.has(realPath)) continue;
          collected.set(realPath, name);
          extraCount++;
          const innerVirtualNM = getVirtualStoreNodeModules(realPath);
          if (innerVirtualNM && innerVirtualNM !== nodeModulesDir) {
            extraQueue.push({ nodeModulesDir: innerVirtualNM, skipPkg: name });
          }
        }
      }
    }
  }
}

if (extraCount > 0) {
  echo`   Added ${extraCount} extra packages (+ transitive deps) for Electron main process`;
}

// 5. Copy all collected packages into OUTPUT/node_modules/ (flat structure)
//
// IMPORTANT: BFS guarantees direct deps are encountered before transitive deps.
// When the same package name appears at different versions (e.g. chalk@5 from
// openclaw directly, chalk@4 from a transitive dep), we keep the FIRST one
// (direct dep version) and skip later duplicates. This prevents version
// conflicts like CJS chalk@4 overwriting ESM chalk@5.
const outputNodeModules = path.join(OUTPUT, 'node_modules');
fs.mkdirSync(outputNodeModules, { recursive: true });

const copiedNames = new Set(); // Track package names already copied
let copiedCount = 0;
let skippedDupes = 0;

const preferredBundledPackages = new Set(EXTRA_BUNDLED_PACKAGES);
const preferredBundledPackageRealPaths = new Set();
for (const pkgName of EXTRA_BUNDLED_PACKAGES) {
  const pkgLink = path.join(NODE_MODULES, ...pkgName.split('/'));
  if (!fs.existsSync(pkgLink)) continue;
  try {
    preferredBundledPackageRealPaths.add(fs.realpathSync(pkgLink));
  } catch {
    // ignore
  }
}

const collectedEntries = [...collected].sort(([leftRealPath, leftName], [rightRealPath, rightName]) => {
  const leftPreferredRealPath = preferredBundledPackageRealPaths.has(leftRealPath);
  const rightPreferredRealPath = preferredBundledPackageRealPaths.has(rightRealPath);
  if (leftPreferredRealPath !== rightPreferredRealPath) return leftPreferredRealPath ? -1 : 1;

  const leftPreferred = preferredBundledPackages.has(leftName);
  const rightPreferred = preferredBundledPackages.has(rightName);
  if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;

  return 0;
});

for (const [realPath, pkgName] of collectedEntries) {
  if (copiedNames.has(pkgName)) {
    skippedDupes++;
    continue; // Keep the first version (closer to openclaw in dep tree)
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

// 5b. Merge built-in extension node_modules into top-level node_modules
//
// OpenClaw 3.31+ ships built-in extensions (telegram, discord, etc.) under
// dist/extensions/<ext>/node_modules/.  The Rollup bundler creates shared
// chunks at dist/ root (e.g. sticker-cache-*.js) that eagerly import
// extension-specific packages like "grammy".  Node.js resolves bare
// specifiers from the importing file's directory upward:
//   dist/ → openclaw/ → openclaw/node_modules/
// It does NOT search dist/extensions/telegram/node_modules/.
//
// Fix: copy extension deps into the top-level node_modules/ so they are
// resolvable from shared chunks.  Skip-if-exists preserves version priority
// (openclaw's own deps take precedence over extension deps).
const extensionsDir = path.join(OUTPUT, 'dist', 'extensions');
function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function listPackageDeps(pkgJson) {
  return Object.keys({
    ...(pkgJson?.dependencies && typeof pkgJson.dependencies === 'object' ? pkgJson.dependencies : {}),
    ...(pkgJson?.optionalDependencies && typeof pkgJson.optionalDependencies === 'object' ? pkgJson.optionalDependencies : {}),
  }).sort((a, b) => a.localeCompare(b));
}

let mergedExtCount = 0;
let mirroredExtRuntimeDeps = 0;
if (fs.existsSync(extensionsDir)) {
  for (const extEntry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!extEntry.isDirectory()) continue;
    const extRoot = path.join(extensionsDir, extEntry.name);
    const extNM = path.join(extRoot, 'node_modules');

    if (fs.existsSync(extNM)) {
      for (const pkgEntry of fs.readdirSync(extNM, { withFileTypes: true })) {
        if (!pkgEntry.isDirectory() || pkgEntry.name === '.bin') continue;
        const srcPkg = path.join(extNM, pkgEntry.name);

        if (pkgEntry.name.startsWith('@')) {
          // Scoped package — iterate sub-entries
          let scopeEntries;
          try { scopeEntries = fs.readdirSync(srcPkg, { withFileTypes: true }); } catch { continue; }
          for (const scopeEntry of scopeEntries) {
            if (!scopeEntry.isDirectory()) continue;
            const scopedName = `${pkgEntry.name}/${scopeEntry.name}`;
            if (copiedNames.has(scopedName)) continue;
            const srcScoped = path.join(srcPkg, scopeEntry.name);
            const destScoped = path.join(outputNodeModules, pkgEntry.name, scopeEntry.name);
            try {
              fs.mkdirSync(normWin(path.dirname(destScoped)), { recursive: true });
              fs.cpSync(normWin(srcScoped), normWin(destScoped), { recursive: true, dereference: true });
              copiedNames.add(scopedName);
              mergedExtCount++;
            } catch { /* skip on copy error */ }
          }
        } else {
          if (copiedNames.has(pkgEntry.name)) continue;
          const destPkg = path.join(outputNodeModules, pkgEntry.name);
          try {
            fs.cpSync(normWin(srcPkg), normWin(destPkg), { recursive: true, dereference: true });
            copiedNames.add(pkgEntry.name);
            mergedExtCount++;
          } catch { /* skip on copy error */ }
        }
      }
    }

    const extPkg = readJsonSafe(path.join(extRoot, 'package.json'));
    for (const depName of listPackageDeps(extPkg)) {
      const srcPkg = path.join(outputNodeModules, ...depName.split('/'));
      const destPkg = path.join(extNM, ...depName.split('/'));
      if (!fs.existsSync(srcPkg) || fs.existsSync(destPkg)) continue;
      try {
        fs.mkdirSync(normWin(path.dirname(destPkg)), { recursive: true });
        fs.cpSync(normWin(srcPkg), normWin(destPkg), { recursive: true, dereference: true });
        mirroredExtRuntimeDeps++;
      } catch { /* skip on copy error */ }
    }
  }
}

if (mergedExtCount > 0) {
  echo`   Merged ${mergedExtCount} extension packages into top-level node_modules`;
}
if (mirroredExtRuntimeDeps > 0) {
  echo`   Mirrored ${mirroredExtRuntimeDeps} extension runtime deps into dist/extensions/*/node_modules`;
}

function patchBundledExtensionPackageJsons(_extensionsRoot) {
  return 0;
}

patchBundledExtensionPackageJsons(extensionsDir);

// 6. Clean up the bundle to reduce package size
//
// This removes platform-agnostic waste: dev artifacts, docs, source maps,
// type definitions, test directories, and known large unused subdirectories.
// Platform-specific cleanup (e.g. koffi binaries) is handled in after-pack.cjs
// which has access to the target platform/arch context.

function getDirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += getDirSize(p);
      else if (entry.isFile()) total += fs.statSync(p).size;
    }
  } catch { /* ignore */ }
  return total;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

function rmSafe(target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    else fs.rmSync(target, { force: true });
    return true;
  } catch { return false; }
}

function cleanupNodeModulesRuntimeJunk(nodeModulesDir) {
  let removedCount = 0;

  const nodeWavDir = path.join(nodeModulesDir, 'node-wav');
  for (const name of ['x.json', 'x.js', 'x.js~', 'file.wav']) {
    if (rmSafe(path.join(nodeWavDir, name))) removedCount++;
  }

  // tree-sitter-bash ships C sources for rebuilding its native addon. Packaged
  // builds use the prebuilt addon/wasm; keep node-types.json because the CJS
  // entry exposes it as optional runtime metadata.
  const treeSitterSrc = path.join(nodeModulesDir, 'tree-sitter-bash', 'src');
  for (const name of ['parser.c', 'scanner.c', 'grammar.json', 'tree_sitter']) {
    if (rmSafe(path.join(treeSitterSrc, name))) removedCount++;
  }

  return removedCount;
}

function cleanupKnownRuntimeJunk(rootDir) {
  let removedCount = 0;
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }

    if (path.basename(dir) === 'node_modules') {
      removedCount += cleanupNodeModulesRuntimeJunk(dir);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      stack.push(path.join(dir, entry.name));
    }
  }

  return removedCount;
}

function cleanupBundle(outputDir) {
  let removedCount = 0;
  const nm = path.join(outputDir, 'node_modules');
  // OpenClaw 3.x ships built-in extensions under dist/extensions/<ext>/, not
  // extensions/. The previous `path.join(outputDir, 'extensions')` silently
  // resolved to a non-existent directory so the entire walkExt() pass below
  // (which is what cleans .d.ts / .d.mts / source maps inside per-extension
  // node_modules) was a no-op. That left ~28k .d.mts files in the bundle and
  // contributed to the macOS codesign EMFILE blow-up.
  const ext = path.join(outputDir, 'dist', 'extensions');

  // --- openclaw root junk ---
  for (const name of ['CHANGELOG.md', 'README.md']) {
    if (rmSafe(path.join(outputDir, name))) removedCount++;
  }

  // docs/ is kept — contains prompt templates and other runtime-used prompts

  // --- extensions: clean junk from source, aggressively clean nested node_modules ---
  // Extension source (.ts files) are runtime entry points — must be preserved.
  // Only nested node_modules/ inside extensions get the aggressive cleanup.
  if (fs.existsSync(ext)) {
    const JUNK_EXTS = new Set(['.prose', '.ignored_openclaw', '.keep']);
    const NM_REMOVE_DIRS = new Set([
      'test', 'tests', '__tests__', '.github', 'docs', 'examples', 'example',
    ]);
    // .d.mts / .d.cts are TypeScript declaration files for ESM/CJS dual-package
    // builds. They are useless at runtime but show up in huge volumes from
    // typed packages (e.g. typebox), and inflate the per-process file count
    // that codesign opens during macOS signing → EMFILE.
    const NM_REMOVE_FILE_EXTS = [
      '.d.ts', '.d.ts.map',
      '.d.mts', '.d.mts.map',
      '.d.cts', '.d.cts.map',
      '.js.map', '.mjs.map', '.cjs.map', '.ts.map',
      '.markdown',
    ];
    const NM_REMOVE_FILE_NAMES = new Set([
      '.DS_Store', 'README.md', 'CHANGELOG.md', 'LICENSE.md', 'CONTRIBUTING.md',
      'tsconfig.json', '.npmignore', '.eslintrc', '.prettierrc', '.editorconfig',
    ]);

    // .md files inside skills/ directories are runtime content (SKILL.md,
    // block-types.md, etc.) and must NOT be removed.
    const JUNK_MD_NAMES = new Set([
      'README.md', 'CHANGELOG.md', 'LICENSE.md', 'CONTRIBUTING.md',
    ]);

    function walkExt(dir, insideNodeModules, insideSkills) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (insideNodeModules && NM_REMOVE_DIRS.has(entry.name)) {
            if (rmSafe(full)) removedCount++;
          } else {
            walkExt(
              full,
              insideNodeModules || entry.name === 'node_modules',
              insideSkills || entry.name === 'skills',
            );
          }
        } else if (entry.isFile()) {
          if (insideNodeModules) {
            const name = entry.name;
            if (NM_REMOVE_FILE_NAMES.has(name) || NM_REMOVE_FILE_EXTS.some(e => name.endsWith(e))) {
              if (rmSafe(full)) removedCount++;
            }
          } else {
            // Inside skills/ directories, .md files are skill content — keep them.
            // Outside skills/, remove known junk .md files only.
            const isMd = entry.name.endsWith('.md');
            const isJunkMd = isMd && JUNK_MD_NAMES.has(entry.name);
            const isJunkExt = JUNK_EXTS.has(path.extname(entry.name));
            if (isJunkExt || (isMd && !insideSkills && isJunkMd)) {
              if (rmSafe(full)) removedCount++;
            }
          }
        }
      }
    }
    walkExt(ext, false, false);
  }

  // --- node_modules: remove unnecessary file types and directories ---
  if (fs.existsSync(nm)) {
    const REMOVE_DIRS = new Set([
      'test', 'tests', '__tests__', '.github', 'docs', 'examples', 'example',
    ]);
    const REMOVE_FILE_EXTS = [
      '.d.ts', '.d.ts.map',
      '.d.mts', '.d.mts.map',
      '.d.cts', '.d.cts.map',
      '.js.map', '.mjs.map', '.cjs.map', '.ts.map',
      '.markdown',
    ];
    const REMOVE_FILE_NAMES = new Set([
      '.DS_Store', 'README.md', 'CHANGELOG.md', 'LICENSE.md', 'CONTRIBUTING.md',
      'tsconfig.json', '.npmignore', '.eslintrc', '.prettierrc', '.editorconfig',
    ]);

    function walkClean(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (REMOVE_DIRS.has(entry.name)) {
            if (rmSafe(full)) removedCount++;
          } else {
            walkClean(full);
          }
        } else if (entry.isFile()) {
          const name = entry.name;
          if (REMOVE_FILE_NAMES.has(name) || REMOVE_FILE_EXTS.some(e => name.endsWith(e))) {
            if (rmSafe(full)) removedCount++;
          }
        }
      }
    }
    walkClean(nm);
  }

  // --- known large unused subdirectories ---
  const LARGE_REMOVALS = [
    'node_modules/pdfjs-dist/legacy',
    'node_modules/pdfjs-dist/types',
    'node_modules/node-llama-cpp/llama',
    'node_modules/koffi/src',
    'node_modules/koffi/vendor',
    'node_modules/koffi/doc',
    'dist/extensions/feishu', // Removed in favor of official @larksuite/openclaw-lark plugin
  ];
  for (const rel of LARGE_REMOVALS) {
    if (rmSafe(path.join(outputDir, rel))) removedCount++;
  }

  removedCount += cleanupKnownRuntimeJunk(outputDir);

  return removedCount;
}

echo``;
echo`🧹 Cleaning up bundle (removing dev artifacts, docs, source maps, type defs)...`;
const sizeBefore = getDirSize(OUTPUT);
const cleanedCount = cleanupBundle(OUTPUT);
const sizeAfter = getDirSize(OUTPUT);
echo`   Removed ${cleanedCount} files/directories`;
echo`   Size: ${formatSize(sizeBefore)} → ${formatSize(sizeAfter)} (saved ${formatSize(sizeBefore - sizeAfter)})`;

// 7. Patch known broken packages
//
// Some packages in the ecosystem have transpiled CJS output that sets
// `module.exports = exports.default` without ever assigning `exports.default`,
// resulting in `module.exports = undefined`.  This causes a TypeError in
// Node.js 22+ ESM interop when the translators try to call hasOwnProperty on
// the undefined exports object.
//
// We also patch Windows child_process spawn sites in the bundled agent runtime
// so shell/tool execution does not flash a console window for each tool call.
// We patch these files in-place after the copy so the bundle is safe to run.
function patchBrokenModules(nodeModulesDir) {
  const rewritePatches = {
    // node-domexception@1.0.0: transpiled index.js leaves module.exports = undefined.
    // Node.js 18+ ships DOMException as a built-in global, so a simple shim works.
    'node-domexception/index.js': [
      `'use strict';`,
      `// Shim: the original transpiled file sets module.exports = exports.default`,
      `// (which is undefined), causing TypeError in Node.js 22+ ESM interop.`,
      `// Node.js 18+ has DOMException as a built-in global.`,
      `const dom = globalThis.DOMException ||`,
      `  class DOMException extends Error {`,
      `    constructor(msg, name) { super(msg); this.name = name || 'Error'; }`,
      `  };`,
      `module.exports = dom;`,
      `module.exports.DOMException = dom;`,
      `module.exports.default = dom;`,
    ].join('\n'),
  };
  const replacePatches = [
    // Note: @mariozechner/pi-coding-agent is no longer a dep of openclaw 3.31.
  ];

  let count = 0;
  for (const [rel, content] of Object.entries(rewritePatches)) {
    const target = path.join(nodeModulesDir, rel);
    if (fs.existsSync(target)) {
      fs.writeFileSync(target, content + '\n', 'utf8');
      count++;
    }
  }
  for (const { rel, search, replace } of replacePatches) {
    const target = path.join(nodeModulesDir, rel);
    if (!fs.existsSync(target)) continue;

    const current = fs.readFileSync(target, 'utf8');
    if (!current.includes(search)) {
      echo`   ⚠️  Skipped patch for ${rel}: expected source snippet not found`;
      continue;
    }

    const next = current.replace(search, replace);
    if (next !== current) {
      fs.writeFileSync(target, next, 'utf8');
      count++;
    }
  }
  // lru-cache CJS/ESM interop fix (recursive):
  // Multiple versions of lru-cache may exist in the output tree — not just
  // at node_modules/lru-cache/ but also nested inside other packages.
  // Older CJS versions (v5, v6) export the class via `module.exports = LRUCache`
  // without a named `LRUCache` property, so `import { LRUCache } from 'lru-cache'`
  // fails in Node.js 22+ ESM interop (used by Electron 40+).
  // We recursively scan the entire output for ALL lru-cache installations and
  // patch each CJS entry to ensure `exports.LRUCache` always exists.
  function patchAllLruCacheInstances(rootDir) {
    let lruCount = 0;
    const stack = [rootDir];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(normWin(dir), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        let isDirectory = entry.isDirectory();
        if (!isDirectory) {
          // pnpm layout may contain symlink/junction directories on Windows.
          try { isDirectory = fs.statSync(normWin(fullPath)).isDirectory(); } catch { isDirectory = false; }
        }
        if (!isDirectory) continue;
        if (entry.name === 'lru-cache') {
          const pkgPath = path.join(fullPath, 'package.json');
          if (!fs.existsSync(normWin(pkgPath))) { stack.push(fullPath); continue; }
          try {
            const pkg = JSON.parse(fs.readFileSync(normWin(pkgPath), 'utf8'));
            if (pkg.type === 'module') continue; // ESM version — already has named exports
            const mainFile = pkg.main || 'index.js';
            const entryFile = path.join(fullPath, mainFile);
            if (!fs.existsSync(normWin(entryFile))) continue;
            const original = fs.readFileSync(normWin(entryFile), 'utf8');
            if (!original.includes('exports.LRUCache')) {
              const patched = [
                original,
                '',
                '// ClawX patch: add LRUCache named export for Node.js 22+ ESM interop',
                'if (typeof module.exports === "function" && !module.exports.LRUCache) {',
                '  module.exports.LRUCache = module.exports;',
                '}',
                '',
              ].join('\n');
              fs.writeFileSync(normWin(entryFile), patched, 'utf8');
              lruCount++;
              echo`   🩹 Patched lru-cache CJS (v${pkg.version}) at ${path.relative(rootDir, fullPath)}`;
            }

            // lru-cache v7 ESM entry exports default only; add named export.
            const moduleFile = typeof pkg.module === 'string' ? pkg.module : null;
            if (moduleFile) {
              const esmEntry = path.join(fullPath, moduleFile);
              if (fs.existsSync(normWin(esmEntry))) {
                const esmOriginal = fs.readFileSync(normWin(esmEntry), 'utf8');
                if (
                  esmOriginal.includes('export default LRUCache') &&
                  !esmOriginal.includes('export { LRUCache')
                ) {
                  const esmPatched = [esmOriginal, '', 'export { LRUCache }', ''].join('\n');
                  fs.writeFileSync(normWin(esmEntry), esmPatched, 'utf8');
                  lruCount++;
                  echo`   🩹 Patched lru-cache ESM (v${pkg.version}) at ${path.relative(rootDir, fullPath)}`;
                }
              }
            }
          } catch (err) {
            echo`   ⚠️  Failed to patch lru-cache at ${fullPath}: ${err.message}`;
          }
        } else {
          stack.push(fullPath);
        }
      }
    }
    return lruCount;
  }
  const lruPatched = patchAllLruCacheInstances(nodeModulesDir);
  count += lruPatched;

  if (count > 0) {
    echo`   🩹 Patched ${count} broken module(s) in node_modules`;
  }
}

function findFirstFileByName(rootDir, matcher) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && matcher.test(entry.name)) {
        return fullPath;
      }
    }
  }
  return null;
}

function findFilesByName(rootDir, matcher) {
  const matches = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && matcher.test(entry.name)) {
        matches.push(fullPath);
      }
    }
  }
  return matches;
}

function patchBundledRuntime(outputDir) {
  const replacePatches = [
    {
      label: 'workspace command runner',
      optional: true,
      target: () => findFirstFileByName(path.join(outputDir, 'dist'), /^workspace-.*\.js$/),
      search: `\tconst child = spawn(resolvedCommand, finalArgv.slice(1), {
\t\tstdio,
\t\tcwd,
\t\tenv: resolvedEnv,
\t\twindowsVerbatimArguments,
\t\t...shouldSpawnWithShell({
\t\t\tresolvedCommand,
\t\t\tplatform: process$1.platform
\t\t}) ? { shell: true } : {}
\t});`,
      replace: `\tconst child = spawn(resolvedCommand, finalArgv.slice(1), {
\t\tstdio,
\t\tcwd,
\t\tenv: resolvedEnv,
\t\twindowsVerbatimArguments,
\t\twindowsHide: true,
\t\t...shouldSpawnWithShell({
\t\t\tresolvedCommand,
\t\t\tplatform: process$1.platform
\t\t}) ? { shell: true } : {}
\t});`,
    },
    // Note: OpenClaw 3.31 removed the hash-suffixed agent-scope-*.js, chrome-*.js,
    // and qmd-manager-*.js files from dist/plugin-sdk/. Patches for those spawn
    // sites are no longer needed — the runtime now uses windowsHide natively.
  ];

  let count = 0;
  for (const patch of replacePatches) {
    const target = patch.target();
    if (!target || !fs.existsSync(target)) {
      if (!patch.optional) {
        echo`   ⚠️  Skipped patch for ${patch.label}: target file not found`;
      }
      continue;
    }

    const current = fs.readFileSync(target, 'utf8');
    if (!current.includes(patch.search)) {
      if (!patch.optional) {
        echo`   ⚠️  Skipped patch for ${patch.label}: expected source snippet not found`;
      }
      continue;
    }

    const next = current.replace(patch.search, patch.replace);
    if (next !== current) {
      fs.writeFileSync(target, next, 'utf8');
      count++;
    }
  }

  if (count > 0) {
    echo`   🩹 Patched ${count} bundled runtime spawn site(s)`;
  }

  const ptyTargets = findFilesByName(path.join(outputDir, 'dist'), /\.js$/);
  const ptyPatches = [
    {
      label: 'pty launcher windowsHide',
      optional: true,
      search: `\tconst pty = spawn(params.shell, params.args, {
\t\tcwd: params.cwd,
\t\tenv: params.env ? toStringEnv(params.env) : void 0,
\t\tname: params.name ?? process.env.TERM ?? "xterm-256color",
\t\tcols: params.cols ?? 120,
\t\trows: params.rows ?? 30
\t});`,
      replace: `\tconst pty = spawn(params.shell, params.args, {
\t\tcwd: params.cwd,
\t\tenv: params.env ? toStringEnv(params.env) : void 0,
\t\tname: params.name ?? process.env.TERM ?? "xterm-256color",
\t\tcols: params.cols ?? 120,
\t\trows: params.rows ?? 30,
\t\twindowsHide: true
\t});`,
    },
    {
      label: 'prepared pty launcher windowsHide',
      search: `\tconst pty = spawn(preparedSpawn.command, preparedSpawn.args, {
\t\tcwd: params.cwd,
\t\tenv: preparedSpawn.env ? toStringEnv(preparedSpawn.env) : void 0,
\t\tname: params.name ?? process.env.TERM ?? "xterm-256color",
\t\tcols: params.cols ?? 120,
\t\trows: params.rows ?? 30
\t});`,
      replace: `\tconst pty = spawn(preparedSpawn.command, preparedSpawn.args, {
\t\tcwd: params.cwd,
\t\tenv: preparedSpawn.env ? toStringEnv(preparedSpawn.env) : void 0,
\t\tname: params.name ?? process.env.TERM ?? "xterm-256color",
\t\tcols: params.cols ?? 120,
\t\trows: params.rows ?? 30,
\t\twindowsHide: true
\t});`,
    },
    {
      label: 'disable pty on windows',
      search: `\t\t\tconst usePty = params.pty === true && !sandbox;`,
      replace: `\t\t\tconst usePty = params.pty === true && !sandbox && process.platform !== "win32";`,
    },
    {
      label: 'disable approval pty on windows',
      search: `\t\t\t\t\tpty: params.pty === true && !sandbox,`,
      replace: `\t\t\t\t\tpty: params.pty === true && !sandbox && process.platform !== "win32",`,
    },
  ];

  let ptyCount = 0;
  for (const patch of ptyPatches) {
    let matchedAny = false;
    for (const target of ptyTargets) {
      const current = fs.readFileSync(target, 'utf8');
      if (!current.includes(patch.search)) continue;
      matchedAny = true;
      const next = current.replaceAll(patch.search, patch.replace);
      if (next !== current) {
        fs.writeFileSync(target, next, 'utf8');
        ptyCount++;
      }
    }
    if (!matchedAny && !patch.optional) {
      echo`   ⚠️  Skipped patch for ${patch.label}: expected source snippet not found`;
    }
  }

  if (ptyCount > 0) {
    echo`   🩹 Patched ${ptyCount} bundled PTY site(s)`;
  }

  // --- Browser runtime patch ---
  // Keep UClaw's packaged browser tool resilient across transient errors,
  // stale target IDs, stale refs, and lightweight observation summaries.
  const distDir = path.join(outputDir, 'dist');
  if (ENABLE_OPENCLAW_BROWSER_RUNTIME_PATCH) {
    const browserPatch = patchOpenClawBrowserRuntime(distDir, {
      logger: { log: (message) => echo`   ${message}` },
    });
    if (browserPatch.patchedFiles > 0) {
      echo`   🩹 Patched ${browserPatch.patchedFiles} browser runtime file(s)`;
    }
  }

  // --- Local action finalization cleanup ---
  // Remove UClaw's former semantic-finalization and forced-tool-choice
  // overrides so packaged runtimes keep OpenClaw's native agent loop.
  const localActionFinalizePatch = patchOpenClawFinalizeLocalActionRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (localActionFinalizePatch.patchedFiles > 0) {
    echo`   🧹 Cleaned ${localActionFinalizePatch.patchedFiles} artifact finalize runtime file(s)`;
  }

  // --- Reply session initialization conflict patch ---
  // OpenClaw's chat.send RPC can ack before the async dispatch/reply resolver
  // initializes the reply session. If the previous run is still committing a
  // terminal lifecycle update, the reply resolver can see a stale session
  // entry revision and fail after the ack. Retry at the reply-session init
  // layer so the next snapshot is taken after the prior turn settles.
  const replySessionInitConflictPatch = patchOpenClawReplySessionInitConflictRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (replySessionInitConflictPatch.patchedFiles > 0) {
    echo`   🩹 Patched ${replySessionInitConflictPatch.patchedFiles} reply-session init runtime file(s)`;
  }

  // --- Compaction session-state refresh patch ---
  // When OpenClaw compacts and exits a run before a fresh deliverable usage
  // snapshot is persisted, keep the session metadata aligned with the post-
  // compaction state instead of leaving the pre-compaction token count stale.
  const compactionSessionStatePatch = patchOpenClawCompactionSessionStateRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (compactionSessionStatePatch.patchedFiles > 0) {
    echo`   🩹 Patched ${compactionSessionStatePatch.patchedFiles} compaction session-state runtime file(s)`;
  }

  // --- Ordinary session cwd patch ---
  // Keep mutable cwd separate from immutable subagent spawn lineage, while
  // making agent/tool execution prefer the session cwd when one is configured.
  const sessionCwdPatch = patchOpenClawSessionCwdRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (sessionCwdPatch.patchedFiles > 0) {
    echo`   🩹 Patched ${sessionCwdPatch.patchedFiles} session cwd runtime file(s)`;
  }

  // --- Prompt cache key patch ---
  // OpenClaw's operator UI cache key includes the per-session run scope, which
  // prevents ClawX-managed providers from reusing the same provider/model/agent
  // prompt prefix across fresh conversations.
  const promptCacheKeyPatch = patchOpenClawPromptCacheKeyRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (promptCacheKeyPatch.patchedFiles > 0) {
    echo`   🩹 Patched ${promptCacheKeyPatch.patchedFiles} prompt cache key runtime file(s)`;
  }

  // --- Request-scoped text Provider failover ---
  // Reuse OpenClaw's native failover safety while keeping the configured
  // fallback ephemeral so every new model call starts from the primary.
  const textProviderFailoverPatch = patchOpenClawTextProviderFailoverRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (textProviderFailoverPatch.patchedFiles > 0) {
    echo`   🩹 Patched ${textProviderFailoverPatch.patchedFiles} text Provider failover runtime file(s)`;
  }

  // --- Thinking effort vs reasoning visibility prompt patch ---
  // OpenClaw exposes both values to the model. Label them unambiguously so
  // reasoning visibility=off cannot be misreported as model thinking=off.
  const reasoningLabelPatch = patchOpenClawSystemPromptReasoningLabelRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (reasoningLabelPatch.patchedFiles > 0) {
    echo`   🩹 Patched ${reasoningLabelPatch.patchedFiles} reasoning status prompt file(s)`;
  }

  // --- Tool directory CJK intent scoring patch ---
  // Keep Chinese engineering/read-only/media requests on the same structured
  // tool discovery path as equivalent English requests.
  const toolDirectoryI18nPatch = patchOpenClawToolDirectoryI18nRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (toolDirectoryI18nPatch.patchedFiles > 0) {
    echo`   🩹 Patched ${toolDirectoryI18nPatch.patchedFiles} tool directory intent runtime file(s)`;
  }

  // Remove the retired UClaw contract-tool patch from previously patched
  // node_modules before packaging. Clean installs are already unchanged.
  const contractToolCleanup = cleanupOpenClawRequiredContractToolRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (contractToolCleanup.cleanedFiles > 0) {
    echo`   🧹 Removed the retired required-contract tool runtime patch`;
  }

  // --- Visible stream smoothing and chat delta cadence patch ---
  // Preserve true provider streaming while avoiding large burst-only text
  // updates and the old 150 ms UI throttle.
  const streamingRuntimePatch = patchOpenClawStreamingRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (streamingRuntimePatch.patchedFiles > 0) {
    echo`   🩹 Patched ${streamingRuntimePatch.patchedFiles} streaming runtime file(s)`;
  }

  // --- Final model request contract diagnostics patch ---
  // Log only non-sensitive request shape metadata at the guarded fetch entry
  // so packaged diagnostics can confirm the contract that actually left the SDK.
  const modelRequestContractPatch = patchOpenClawModelRequestContractRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (modelRequestContractPatch.patchedFiles > 0) {
    echo`   🩹 Patched ${modelRequestContractPatch.patchedFiles} final model request contract runtime file(s)`;
  }

  // --- Raw tool signal diagnostics patch ---
  // UClaw needs to distinguish "provider returned no raw tool_calls" from
  // "OpenClaw parsed/dropped them" and "UClaw failed to execute them".
  const rawToolSignalPatch = patchOpenClawRawToolSignalRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (rawToolSignalPatch.patchedFiles > 0) {
    echo`   🩹 Patched ${rawToolSignalPatch.patchedFiles} raw tool signal runtime file(s)`;
  }

  // --- Plugin tool run correlation patch ---
  // OpenClaw already owns the authoritative agent run id while creating tools.
  // Expose it only through the trusted plugin factory context so UClaw Host
  // contracts and tasks can correlate work without model-supplied identities.
  const pluginToolRunContextPatch = patchOpenClawPluginToolRunContextRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (pluginToolRunContextPatch.patchedFiles > 0) {
    echo`   🩹 Patched ${pluginToolRunContextPatch.patchedFiles} plugin tool run context file(s)`;
  }

  // --- Native detached media task cancellation patch ---
  // Tie tasks.cancel to the exact image/video provider request and suppress
  // completion wake/delivery after cancellation instead of only changing the ledger.
  const nativeMediaCancellationPatch = patchOpenClawNativeMediaCancellationRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (nativeMediaCancellationPatch.patchedFiles > 0) {
    echo`   🩹 Patched ${nativeMediaCancellationPatch.patchedFiles} native media cancellation runtime file(s)`;
  }

  const managedMediaTimeoutPatch = patchOpenClawManagedMediaTimeoutRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (managedMediaTimeoutPatch.patchedFiles > 0) {
    echo`   🩹 Patched ${managedMediaTimeoutPatch.patchedFiles} managed media timeout runtime file(s)`;
  }

  const nativeImageDeliveryPatch = patchOpenClawNativeImageDeliveryRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (nativeImageDeliveryPatch.patchedFiles > 0) {
    echo`   🩹 Patched ${nativeImageDeliveryPatch.patchedFiles} native image delivery runtime file(s)`;
  }

  const nativeMediaAcceptanceCleanup = cleanupOpenClawNativeMediaAcceptanceRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (nativeMediaAcceptanceCleanup.cleanedFiles > 0) {
    echo`   🧹 Removed the retired native media acceptance override`;
  }

  // --- Segment-scoped native video idempotency patch ---
  // Keep legacy single-flight behavior for old calls while allowing an
  // explicit long-form plan to generate distinct segment ids safely.
  const videoSegmentDedupePatch = patchOpenClawVideoSegmentDedupeRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (videoSegmentDedupePatch.patchedFiles > 0) {
    echo`   🩹 Patched ${videoSegmentDedupePatch.patchedFiles} video segment dedupe runtime file(s)`;
  }

  const videoProviderCatalogPatch = patchOpenClawVideoProviderCatalogRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (videoProviderCatalogPatch.patchedFiles > 0) {
    echo`   🩹 Patched ${videoProviderCatalogPatch.patchedFiles} video provider catalog runtime file(s)`;
  }

  // --- Provider/model-aware native video contract ---
  // Keep the Agent-facing schema and wire normalization aligned with the
  // selected model instead of exposing a provider-wide union of controls.
  const videoCapabilityContractPatch = patchOpenClawVideoCapabilityContractRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (videoCapabilityContractPatch.patchedFiles > 0) {
    echo`   🩹 Patched ${videoCapabilityContractPatch.patchedFiles} video capability contract runtime file(s)`;
  }

  // --- Requested/applied/actual native video specification ---
  // Probe the delivered file without turning metadata drift into a delivery
  // failure, and retain the result in the task summary and structured details.
  const videoActualSpecPatch = patchOpenClawVideoActualSpecRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (videoActualSpecPatch.patchedFiles > 0) {
    echo`   🩹 Patched ${videoActualSpecPatch.patchedFiles} video actual specification runtime file(s)`;
  }

  // --- Public task delivery outcome patch ---
  // Keep the gateway TaskSummary response backward compatible while exposing
  // enough terminal delivery state for UClaw to avoid false completion.
  const taskSummaryDeliveryPatch = patchOpenClawTaskSummaryDeliveryRuntime(distDir, {
    logger: { log: (message) => echo`   ${message}` },
  });
  if (taskSummaryDeliveryPatch.patchedFiles > 0) {
    echo`   🩹 Patched ${taskSummaryDeliveryPatch.patchedFiles} task summary delivery file(s)`;
  }

}

patchBrokenModules(outputNodeModules);
patchBundledRuntime(OUTPUT);

const openclawSelfImportPatch = patchExtensionOpenClawSelfImports(OUTPUT);
if (openclawSelfImportPatch.specifiersPatched > 0) {
  echo`   🩹 Rewrote ${openclawSelfImportPatch.specifiersPatched} OpenClaw plugin-sdk self-import(s) in ${openclawSelfImportPatch.filesPatched} extension file(s)`;
}

// 8. Verify the bundle
const entryExists = fs.existsSync(path.join(OUTPUT, 'openclaw.mjs'));
const distExists = fs.existsSync(path.join(OUTPUT, 'dist', 'entry.js'));

echo``;
echo`✅ Bundle complete: ${OUTPUT}`;
echo`   Unique packages copied: ${copiedCount}`;
echo`   Dev-only packages skipped: ${skippedDevCount}`;
echo`   Duplicate versions skipped: ${skippedDupes}`;
echo`   Total discovered: ${collected.size}`;
echo`   openclaw.mjs: ${entryExists ? '✓' : '✗'}`;
echo`   dist/entry.js: ${distExists ? '✓' : '✗'}`;

if (!entryExists || !distExists) {
  echo`❌ Bundle verification failed!`;
  process.exit(1);
}

const missingRuntimePackages = ELECTRON_MAIN_RUNTIME_PACKAGES.filter((pkgName) => {
  const pkgJson = path.join(outputNodeModules, ...pkgName.split('/'), 'package.json');
  return !fs.existsSync(pkgJson);
});

if (missingRuntimePackages.length > 0) {
  echo`❌ Bundle verification failed: missing Electron main runtime packages:`;
  for (const pkgName of missingRuntimePackages) {
    echo`   - ${pkgName}`;
  }
  process.exit(1);
}
