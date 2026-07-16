#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { buildWindowsSelfCheck } from './build-windows-self-check.mjs';
import { BUNDLED_OPENCLAW_PLUGINS, LOCAL_OPENCLAW_PLUGIN_IDS } from './openclaw-bundle-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const releaseDir = path.join(ROOT, 'release');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const platform = process.argv.includes('--mac') ? 'mac'
  : process.argv.includes('--win') ? 'win'
    : process.platform === 'darwin' ? 'mac' : 'win';
const archArg = readArg('--arch');
const arch = archArg || process.arch;
const WINDOWS_SELF_CHECK_FILE = 'UClaw-SelfCheck.cmd';
const fileName = `UClaw-${packageJson.version}-${platform}-${arch}-usb.zip`;
const outputPath = path.join(releaseDir, fileName);
const metadataPath = path.join(releaseDir, fileName.replace(/\.zip$/i, '.json'));
const BUILD_IDENTITY_FILE = 'uclaw-usb-build.json';
const PACKAGED_BUILD_IDENTITY_FILE = 'resources/uclaw-build.json';
const WINDOWS_PE_FILES = [
  'UClaw.exe',
  'resources/bin/node.exe',
  'resources/bin/uv.exe',
  'resources/bin/agent-browser.exe',
  'resources/bin/ffmpeg.exe',
  'resources/bin/ffprobe.exe',
];
const requireFromElectronBuilder = createRequire(path.join(ROOT, 'node_modules', 'electron-builder', 'package.json'));
const appBuilderPackagePath = requireFromElectronBuilder.resolve('app-builder-lib/package.json');
const requireFromAppBuilder = createRequire(appBuilderPackagePath);
const { extractFile: extractAsarFile } = requireFromAppBuilder('@electron/asar');

function readArg(name) {
  const prefixed = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefixed));
  if (match) return match.slice(prefixed.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function resolvePortableRoot() {
  if (platform === 'mac') {
    const appBundlePath = findAppBundle(releaseDir);
    if (!appBundlePath) {
      throw new Error('release/*.app does not exist. Run electron-builder --mac dir first.');
    }
    return path.dirname(appBundlePath);
  }

  const winUnpackedDir = path.join(releaseDir, 'win-unpacked');
  if (!fs.existsSync(winUnpackedDir)) {
    throw new Error('release/win-unpacked does not exist. Run electron-builder --win dir first.');
  }
  return winUnpackedDir;
}

function findAppBundle(dir, depth = 0) {
  if (!fs.existsSync(dir) || depth > 3) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(dir, entry.name);
    if (entry.name.endsWith('.app')) return entryPath;
    const found = findAppBundle(entryPath, depth + 1);
    if (found) return found;
  }
  return null;
}

function ensurePortableMarkers(portableRoot) {
  const dataDir = path.join(portableRoot, 'UClawData');
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  fs.mkdirSync(path.join(dataDir, 'updates'), { recursive: true });
  fs.writeFileSync(path.join(portableRoot, 'portable.flag'), 'UClaw USB portable mode\n', 'utf-8');
  fs.writeFileSync(path.join(dataDir, '.keep'), '', 'utf-8');
}

function cleanExistingArtifacts({ allWindows = platform === 'win', includeUnpacked = false } = {}) {
  if (!fs.existsSync(releaseDir)) return [];
  const removed = [];
  for (const entry of fs.readdirSync(releaseDir, { withFileTypes: true })) {
    const isUsbArtifact = entry.isFile() && (allWindows
      ? /^UClaw-.+-win-.+-usb\.(?:zip|json)$/i.test(entry.name)
      : entry.name === path.basename(outputPath) || entry.name === path.basename(metadataPath));
    const isWindowsUnpacked = includeUnpacked && entry.isDirectory() && /^win(?:-.+)?-unpacked$/i.test(entry.name);
    if (!isUsbArtifact && !isWindowsUnpacked) continue;
    fs.rmSync(path.join(releaseDir, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
      maxRetries: 5,
      retryDelay: 500,
    });
    removed.push(entry.name);
  }
  return removed;
}

function installWindowsSelfCheck(portableRoot) {
  buildWindowsSelfCheck(path.join(portableRoot, WINDOWS_SELF_CHECK_FILE));
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is missing or invalid: ${filePath} (${error instanceof Error ? error.message : String(error)})`);
  }
}

function assertLocalPluginMetadata(pluginDir, expectedId) {
  const pkg = readJsonFile(path.join(pluginDir, 'package.json'), `Plugin ${expectedId} package.json`);
  const manifest = readJsonFile(path.join(pluginDir, 'openclaw.plugin.json'), `Plugin ${expectedId} manifest`);
  if (manifest.id !== expectedId) {
    throw new Error(`Plugin directory/id mismatch: expected ${expectedId}, manifest has ${String(manifest.id)}`);
  }
  if (pkg.name !== expectedId && pkg.name !== `${expectedId}-plugin`) {
    throw new Error(`Plugin ${expectedId} package name mismatch: ${String(pkg.name)}`);
  }
  if (!pkg.version || pkg.version !== manifest.version) {
    throw new Error(`Plugin ${expectedId} version mismatch: package=${String(pkg.version)} manifest=${String(manifest.version)}`);
  }
  if (!pkg.main || pkg.main !== manifest.entry || !fs.existsSync(path.join(pluginDir, manifest.entry))) {
    throw new Error(
      `Plugin ${expectedId} entry mismatch or missing: package.main=${String(pkg.main)} manifest.entry=${String(manifest.entry)}`,
    );
  }
  if (pkg.openclaw?.extensions !== undefined
    && (!Array.isArray(pkg.openclaw.extensions) || !pkg.openclaw.extensions.includes(`./${manifest.entry}`))) {
    throw new Error(`Plugin ${expectedId} package.json declares an inconsistent OpenClaw entry`);
  }
  return { id: manifest.id, version: pkg.version, entry: manifest.entry };
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
  const pkg = readJsonFile(path.join(pluginDir, 'package.json'), `Plugin ${plugin.pluginId} package.json`);
  const manifest = readJsonFile(path.join(pluginDir, 'openclaw.plugin.json'), `Plugin ${plugin.pluginId} manifest`);
  if (pkg.name !== plugin.npmName) {
    throw new Error(`Plugin ${plugin.pluginId} package name mismatch: ${String(pkg.name)}`);
  }
  if (manifest.id !== plugin.manifestId) {
    throw new Error(`Plugin ${plugin.pluginId} manifest id mismatch: ${String(manifest.id)}`);
  }
  if (!pkg.version) throw new Error(`Plugin ${plugin.pluginId} package version is missing`);
  if (manifest.version !== undefined && manifest.version !== pkg.version) {
    throw new Error(
      `Plugin ${plugin.pluginId} version mismatch: package=${String(pkg.version)} manifest=${String(manifest.version)}`,
    );
  }
  const entries = getDeclaredPluginEntries(pkg, manifest);
  if (entries.length === 0 || !entries.some((entry) => fs.existsSync(path.join(pluginDir, entry)))) {
    throw new Error(`Plugin ${plugin.pluginId} has no existing declared entrypoint: ${entries.join(', ') || 'none'}`);
  }
  const dependencies = Object.keys({
    ...(pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}),
    ...(pkg.optionalDependencies && typeof pkg.optionalDependencies === 'object' ? pkg.optionalDependencies : {}),
  });
  const missingDependencies = dependencies.filter((dependencyName) => (
    !fs.existsSync(path.join(pluginDir, 'node_modules', ...dependencyName.split('/'), 'package.json'))
  ));
  if (missingDependencies.length > 0) {
    throw new Error(`Plugin ${plugin.pluginId} is missing runtime dependencies: ${missingDependencies.join(', ')}`);
  }
  return { id: manifest.id, version: pkg.version, entry: entries.find((entry) => fs.existsSync(path.join(pluginDir, entry))) };
}

function resolveSourceCommit() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^[0-9a-f]{40}$/i.test(commit)) return commit.toLowerCase();
  } catch { /* handled below */ }
  const fallback = String(process.env.UCLAW_BUILD_COMMIT || process.env.GITHUB_SHA || '').trim();
  if (/^[0-9a-f]{40}$/i.test(fallback)) return fallback.toLowerCase();
  throw new Error('Cannot resolve the current git commit; refusing to finalize an unidentifiable USB build.');
}

function resolveSourceTreeState() {
  try {
    const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return status ? 'dirty' : 'clean';
  } catch {
    return 'unknown';
  }
}

function readPeMachine(executablePath) {
  const descriptor = fs.openSync(executablePath, 'r');
  try {
    const dosHeader = Buffer.alloc(64);
    if (fs.readSync(descriptor, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) {
      throw new Error('truncated DOS header');
    }
    if (dosHeader.readUInt16LE(0) !== 0x5a4d) throw new Error('missing MZ header');
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    if (fs.readSync(descriptor, peHeader, 0, peHeader.length, peOffset) !== peHeader.length) {
      throw new Error('truncated PE header');
    }
    if (peHeader.readUInt32LE(0) !== 0x00004550) throw new Error('missing PE signature');
    return peHeader.readUInt16LE(4);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertPortableDataClean(portableRoot) {
  const dataDir = path.join(portableRoot, 'UClawData');
  const topLevel = fs.readdirSync(dataDir).sort();
  if (topLevel.join('\n') !== ['.keep', 'updates'].sort().join('\n')) {
    throw new Error(`UClawData contains unexpected files and may leak user data: ${topLevel.join(', ')}`);
  }
  const updateEntries = fs.readdirSync(path.join(dataDir, 'updates'));
  if (updateEntries.length > 0) {
    throw new Error(`UClawData/updates is not empty: ${updateEntries.join(', ')}`);
  }
}

function validateWindowsBuildIdentity(portableRoot) {
  const currentCommit = resolveSourceCommit();
  const currentSourceTreeState = resolveSourceTreeState();
  const packagedIdentity = readJsonFile(
    path.join(portableRoot, PACKAGED_BUILD_IDENTITY_FILE),
    'Packaged build identity',
  );
  const asarPackageBuffer = extractAsarFile(path.join(portableRoot, 'resources', 'app.asar'), 'package.json');
  const asarPackage = JSON.parse(asarPackageBuffer.toString('utf8'));
  const executableMachines = Object.fromEntries(WINDOWS_PE_FILES.map((relativePath) => [
    relativePath,
    `0x${readPeMachine(path.join(portableRoot, relativePath)).toString(16)}`,
  ]));

  if (asarPackage.version !== packageJson.version) {
    throw new Error(`Stale app.asar: source version=${packageJson.version}, packaged version=${String(asarPackage.version)}`);
  }
  if (packagedIdentity.appVersion !== packageJson.version) {
    throw new Error(
      `Stale build identity version: source=${packageJson.version}, packaged=${String(packagedIdentity.appVersion)}`,
    );
  }
  if (String(packagedIdentity.gitCommit).toLowerCase() !== currentCommit) {
    throw new Error(
      `Stale win-unpacked commit: source=${currentCommit}, packaged=${String(packagedIdentity.gitCommit)}`,
    );
  }
  if (packagedIdentity.sourceTreeState !== 'clean' || currentSourceTreeState !== 'clean') {
    throw new Error(
      `Windows USB builds require a clean source tree: packaged=${String(packagedIdentity.sourceTreeState)}, current=${currentSourceTreeState}. Commit or discard source changes before packaging.`,
    );
  }
  if (packagedIdentity.platform !== 'win32' || packagedIdentity.arch !== 'x64' || arch !== 'x64') {
    throw new Error(
      `Windows USB build identity must be win32/x64: packaged=${String(packagedIdentity.platform)}/${String(packagedIdentity.arch)}, requested=${arch}`,
    );
  }
  const wrongArchitectureFiles = Object.entries(executableMachines)
    .filter(([, machine]) => machine !== '0x8664')
    .map(([relativePath, machine]) => `${relativePath}=${machine}`);
  if (wrongArchitectureFiles.length > 0) {
    throw new Error(`Windows runtime contains non-x64 executables: ${wrongArchitectureFiles.join(', ')}`);
  }
  if (!packagedIdentity.buildId || !packagedIdentity.createdAt) {
    throw new Error('Packaged build identity is incomplete (buildId/createdAt missing).');
  }

  return {
    ...packagedIdentity,
    packageType: 'portable_zip',
    appAsarVersion: asarPackage.version,
    executableMachine: '0x8664',
    executableMachines,
    finalizedAt: new Date().toISOString(),
  };
}

function writePortableBuildIdentity(portableRoot, identity) {
  fs.writeFileSync(
    path.join(portableRoot, BUILD_IDENTITY_FILE),
    `${JSON.stringify(identity, null, 2)}\n`,
    'utf8',
  );
}

function assertWindowsPortableContents(portableRoot) {
  if (process.platform !== 'win32') {
    throw new Error('Windows USB packages must be built on a Windows host. Use the Package Windows (Manual) GitHub Actions workflow.');
  }

  const requiredFiles = [
    'UClaw.exe',
    'portable.flag',
    'resources/app.asar',
    'resources/app.asar.unpacked/node_modules/sharp/package.json',
    'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/package.json',
    'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
    'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll',
    'resources/bin/node.exe',
    'resources/bin/uv.exe',
    'resources/bin/agent-browser.exe',
    'resources/bin/ffmpeg.exe',
    'resources/bin/ffprobe.exe',
    'resources/bin/ffmpeg-runtime.json',
    'resources/cli/openclaw.cmd',
    'resources/openclaw/openclaw.mjs',
    'resources/openclaw/package.json',
    'resources/openclaw/node_modules/sharp/package.json',
    'resources/openclaw/node_modules/@img/sharp-win32-x64/package.json',
    PACKAGED_BUILD_IDENTITY_FILE,
    BUILD_IDENTITY_FILE,
    WINDOWS_SELF_CHECK_FILE,
  ];
  const typeboxPlugins = new Set();
  for (const plugin of BUNDLED_OPENCLAW_PLUGINS) {
    const pluginDir = path.join(portableRoot, 'resources', 'openclaw-plugins', plugin.pluginId);
    const pluginMetadata = assertBundledPluginMetadata(pluginDir, plugin);
    requiredFiles.push(
      `resources/openclaw-plugins/${plugin.pluginId}/package.json`,
      `resources/openclaw-plugins/${plugin.pluginId}/openclaw.plugin.json`,
    );
    const pluginPackage = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
    if (pluginPackage.dependencies?.['@sinclair/typebox']) typeboxPlugins.add(plugin.pluginId);
    if (!pluginMetadata.entry) throw new Error(`Plugin ${plugin.pluginId} has no usable runtime entry`);
  }
  for (const pluginId of LOCAL_OPENCLAW_PLUGIN_IDS) {
    const pluginDir = path.join(portableRoot, 'resources', 'openclaw-plugins', pluginId);
    const packageJsonPath = path.join(pluginDir, 'package.json');
    requiredFiles.push(
      `resources/openclaw-plugins/${pluginId}/index.mjs`,
      `resources/openclaw-plugins/${pluginId}/openclaw.plugin.json`,
      `resources/openclaw-plugins/${pluginId}/package.json`,
    );
    assertLocalPluginMetadata(pluginDir, pluginId);
    if (fs.existsSync(packageJsonPath)) {
      const pluginPackage = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      for (const dependencyName of Object.keys(pluginPackage.dependencies ?? {})) {
        requiredFiles.push(
          `resources/openclaw-plugins/${pluginId}/node_modules/${dependencyName}/package.json`,
        );
      }
      if (pluginPackage.dependencies?.['@sinclair/typebox']) typeboxPlugins.add(pluginId);
    }
  }

  const missing = requiredFiles.filter((relativePath) => !fs.existsSync(path.join(portableRoot, relativePath)));
  if (missing.length > 0) {
    throw new Error(`Windows USB package is incomplete. Missing: ${missing.join(', ')}`);
  }

  for (const pluginId of typeboxPlugins) {
    const packageJsonPath = path.join(portableRoot, 'resources', 'openclaw-plugins', pluginId, 'package.json');
    const requireFromPlugin = createRequire(packageJsonPath);
    const typebox = requireFromPlugin('@sinclair/typebox');
    if (typeof typebox?.Type?.Object !== 'function') {
      throw new Error(`Windows USB package plugin ${pluginId} cannot load @sinclair/typebox Type.Object.`);
    }
  }

  const openClawPackageJsonPath = path.join(portableRoot, 'resources', 'openclaw', 'package.json');
  const requireFromOpenClaw = createRequire(openClawPackageJsonPath);
  const sharp = requireFromOpenClaw('sharp');
  if (typeof sharp !== 'function' || !sharp.versions?.sharp || !sharp.versions?.vips) {
    throw new Error('Windows USB package cannot load the sharp win32-x64 runtime.');
  }
}

function shouldSkipEntry(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  return normalized === '' || normalized.endsWith('.download');
}

function addDirectoryToZip(zip, sourceDir, prefix = '') {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const zipPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (shouldSkipEntry(zipPath)) continue;
    if (entry.isSymbolicLink()) {
      zip.file(zipPath, fs.readlinkSync(sourcePath), {
        date: new Date('2026-01-01T00:00:00Z'),
        unixPermissions: 0o120777,
      });
    } else if (entry.isDirectory()) {
      addDirectoryToZip(zip, sourcePath, zipPath);
    } else if (entry.isFile()) {
      zip.file(zipPath, fs.readFileSync(sourcePath), {
        date: new Date('2026-01-01T00:00:00Z'),
      });
    }
  }
}

async function writeZip(portableRoot, outputPath) {
  const zip = new JSZip();
  addDirectoryToZip(zip, portableRoot);
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: platform === 'win' ? 'DOS' : 'UNIX',
  });
  fs.writeFileSync(outputPath, buffer);
  return buffer;
}

function sha512(buffer) {
  return createHash('sha512').update(buffer).digest('hex');
}

function writeMetadata(fileName, buffer, buildIdentity) {
  const metadata = {
    version: packageJson.version,
    platform,
    arch,
    packageType: 'portable_zip',
    package_type: 'portable_zip',
    fileName,
    file_name: fileName,
    size: buffer.length,
    sha512: sha512(buffer),
    releaseDate: new Date().toISOString(),
    buildId: buildIdentity.buildId,
    gitCommit: buildIdentity.gitCommit,
    sourceCreatedAt: buildIdentity.createdAt,
    appAsarVersion: buildIdentity.appAsarVersion,
    executableMachine: buildIdentity.executableMachine,
    executableMachines: buildIdentity.executableMachines ?? null,
  };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8');
  return { metadata, metadataPath };
}

if (process.argv.includes('--clean-only')) {
  if (process.argv.includes('--require-clean-source')) {
    const sourceTreeState = resolveSourceTreeState();
    if (sourceTreeState !== 'clean') {
      console.error(
        `[build-usb-release] Windows USB builds require a committed, clean source tree (current=${sourceTreeState}).`,
      );
      process.exit(1);
    }
  }
  const removed = cleanExistingArtifacts({ includeUnpacked: platform === 'win' });
  console.log(`[build-usb-release] Removed ${removed.length} stale Windows USB artifacts/build directories.`);
  for (const entry of removed) console.log(`[build-usb-release] Removed release/${entry}`);
  process.exit(0);
}

if (!fs.existsSync(releaseDir)) {
  console.error('[build-usb-release] release directory does not exist. Run electron-builder first.');
  process.exit(1);
}

try {
  if (platform === 'win' && process.platform !== 'win32') {
    throw new Error('Windows USB packages must be built on a Windows host. Use the Package Windows (Manual) GitHub Actions workflow.');
  }
  cleanExistingArtifacts();
  const portableRoot = resolvePortableRoot();
  ensurePortableMarkers(portableRoot);
  let buildIdentity = null;
  if (platform === 'win') {
    buildIdentity = validateWindowsBuildIdentity(portableRoot);
    writePortableBuildIdentity(portableRoot, buildIdentity);
    installWindowsSelfCheck(portableRoot);
    assertPortableDataClean(portableRoot);
    assertWindowsPortableContents(portableRoot);
  }
  const buffer = await writeZip(portableRoot, outputPath);
  const fallbackIdentity = buildIdentity || {
    buildId: null,
    gitCommit: resolveSourceCommit(),
    createdAt: new Date().toISOString(),
    appAsarVersion: packageJson.version,
    executableMachine: null,
  };
  const { metadata, metadataPath } = writeMetadata(fileName, buffer, fallbackIdentity);

  console.log(`[build-usb-release] Created ${path.relative(ROOT, outputPath)} (${metadata.size} bytes).`);
  console.log(`[build-usb-release] Metadata: ${path.relative(ROOT, metadataPath)}`);
  console.log(`[build-usb-release] sha512: ${metadata.sha512}`);
} catch (error) {
  console.error(`[build-usb-release] ${(error instanceof Error ? error.message : String(error))}`);
  process.exit(1);
}
