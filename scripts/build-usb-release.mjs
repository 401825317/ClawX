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
const RELEASE_DIR = path.join(ROOT, 'release');
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ARCH = readArg('--arch') || 'x64';
const FILE_NAME = `UClaw-${PACKAGE_JSON.version}-win-${ARCH}-usb.zip`;
const OUTPUT_PATH = path.join(RELEASE_DIR, FILE_NAME);
const METADATA_PATH = path.join(RELEASE_DIR, FILE_NAME.replace(/\.zip$/i, '.json'));
const PACKAGED_IDENTITY_FILE = 'resources/uclaw-build.json';
const USB_IDENTITY_FILE = 'uclaw-usb-build.json';
const SELF_CHECK_FILE = 'UClaw-SelfCheck.cmd';
const WINDOWS_PE_FILES = [
  'UClaw.exe',
  'resources/bin/node.exe',
  'resources/bin/uv.exe',
  'resources/bin/agent-browser.exe',
];
const REQUIRED_FILES = [
  ...WINDOWS_PE_FILES,
  'portable.flag',
  'resources/app.asar',
  'resources/cli/openclaw.cmd',
  'resources/openclaw/openclaw.mjs',
  'resources/openclaw/package.json',
  'resources/openclaw/node_modules/sharp/package.json',
  'resources/openclaw/node_modules/@img/sharp-win32-x64/package.json',
  'resources/openclaw/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
  'resources/openclaw/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll',
  'resources/app.asar.unpacked/node_modules/sharp/package.json',
  'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/package.json',
  'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
  'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll',
  ...BUNDLED_OPENCLAW_PLUGINS.flatMap(({ pluginId }) => [
    `resources/openclaw-plugins/${pluginId}/package.json`,
    `resources/openclaw-plugins/${pluginId}/openclaw.plugin.json`,
  ]),
  ...LOCAL_OPENCLAW_PLUGIN_IDS.flatMap((pluginId) => [
    `resources/openclaw-plugins/${pluginId}/package.json`,
    `resources/openclaw-plugins/${pluginId}/openclaw.plugin.json`,
  ]),
  'resources/openclaw-plugins/clawx-openai-image/index.mjs',
  'resources/openclaw-plugins/clawx-openai-image/node_modules/undici/package.json',
  'resources/openclaw-plugins/uclaw-video/index.mjs',
  'resources/resources/blender/runtime/uclaw_scene_runner.py',
  'resources/resources/blender/runtime/scene-spec.schema.json',
  'resources/resources/updater/win32-x64/uclaw-portable-updater.exe',
  PACKAGED_IDENTITY_FILE,
  USB_IDENTITY_FILE,
  SELF_CHECK_FILE,
];

const requireFromElectronBuilder = createRequire(
  path.join(ROOT, 'node_modules', 'electron-builder', 'package.json'),
);
const appBuilderPackagePath = requireFromElectronBuilder.resolve('app-builder-lib/package.json');
const requireFromAppBuilder = createRequire(appBuilderPackagePath);
const { extractFile: extractAsarFile } = requireFromAppBuilder('@electron/asar');

function readArg(name) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
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
  } catch { /* use CI fallback below */ }

  const fallback = String(process.env.UCLAW_BUILD_COMMIT || process.env.GITHUB_SHA || '').trim();
  if (/^[0-9a-f]{40}$/i.test(fallback)) return fallback.toLowerCase();
  throw new Error('Cannot resolve the source Git commit.');
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

function cleanExistingArtifacts({ includeUnpacked = false } = {}) {
  if (!fs.existsSync(RELEASE_DIR)) return [];
  const removed = [];
  for (const entry of fs.readdirSync(RELEASE_DIR, { withFileTypes: true })) {
    const usbArtifact = entry.isFile() && /^UClaw-.+-win-.+-usb\.(?:zip|json)$/i.test(entry.name);
    const unpacked = includeUnpacked && entry.isDirectory() && /^win(?:-.+)?-unpacked$/i.test(entry.name);
    if (!usbArtifact && !unpacked) continue;
    fs.rmSync(path.join(RELEASE_DIR, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
      maxRetries: 5,
      retryDelay: 500,
    });
    removed.push(entry.name);
  }
  return removed;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is missing or invalid: ${filePath} (${error instanceof Error ? error.message : String(error)})`);
  }
}

function readPeMachine(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
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

function ensurePortableMarkers(portableRoot) {
  const dataDir = path.join(portableRoot, 'UClawData');
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  fs.mkdirSync(path.join(dataDir, 'updates'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.keep'), '', 'utf8');
  fs.writeFileSync(path.join(portableRoot, 'portable.flag'), 'UClaw USB portable mode\n', 'utf8');
}

function assertPortableDataClean(portableRoot) {
  const dataDir = path.join(portableRoot, 'UClawData');
  const entries = fs.readdirSync(dataDir).sort();
  if (entries.join('\n') !== ['.keep', 'updates'].sort().join('\n')) {
    throw new Error(`UClawData contains unexpected files: ${entries.join(', ')}`);
  }
  const updates = fs.readdirSync(path.join(dataDir, 'updates'));
  if (updates.length > 0) throw new Error(`UClawData/updates is not empty: ${updates.join(', ')}`);
}

function getDeclaredPluginEntries(pkg, manifest) {
  return [...new Set([
    manifest.entry,
    pkg.main,
    pkg.module,
    ...(Array.isArray(pkg.openclaw?.runtimeExtensions) ? pkg.openclaw.runtimeExtensions : []),
    ...(Array.isArray(pkg.openclaw?.extensions) ? pkg.openclaw.extensions : []),
  ].filter((entry) => typeof entry === 'string' && entry.trim()))];
}

function assertPluginRuntimeDependencies(pluginDir, pkg, label) {
  const dependencies = Object.keys({
    ...(pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}),
    ...(pkg.optionalDependencies && typeof pkg.optionalDependencies === 'object' ? pkg.optionalDependencies : {}),
  });
  const missingDependencies = dependencies.filter((dependencyName) => (
    !fs.existsSync(path.join(pluginDir, 'node_modules', ...dependencyName.split('/'), 'package.json'))
  ));
  if (missingDependencies.length > 0) {
    throw new Error(`${label} is missing runtime dependencies: ${missingDependencies.join(', ')}`);
  }
}

function assertBundledPluginMetadata(pluginsRoot, plugin) {
  const pluginDir = path.join(pluginsRoot, plugin.pluginId);
  const pkg = readJson(path.join(pluginDir, 'package.json'), `Plugin ${plugin.pluginId} package.json`);
  const manifest = readJson(path.join(pluginDir, 'openclaw.plugin.json'), `Plugin ${plugin.pluginId} manifest`);
  if (pkg.name !== plugin.npmName) {
    throw new Error(`Plugin ${plugin.pluginId} package name mismatch: ${String(pkg.name)}`);
  }
  if (manifest.id !== plugin.manifestId) {
    throw new Error(`Plugin ${plugin.pluginId} manifest id mismatch: ${String(manifest.id)}`);
  }
  if (!pkg.version) throw new Error(`Plugin ${plugin.pluginId} package version is missing.`);
  if (manifest.version !== undefined && pkg.version !== manifest.version) {
    throw new Error(
      `Plugin ${plugin.pluginId} version mismatch: package=${String(pkg.version)} manifest=${String(manifest.version)}`,
    );
  }
  const declaredEntries = getDeclaredPluginEntries(pkg, manifest);
  if (declaredEntries.length === 0
    || !declaredEntries.some((entry) => fs.existsSync(path.join(pluginDir, entry)))) {
    throw new Error(`Plugin ${plugin.pluginId} has no existing declared entrypoint.`);
  }
  assertPluginRuntimeDependencies(pluginDir, pkg, `Plugin ${plugin.pluginId}`);
}

function assertLocalPluginMetadata(pluginsRoot, pluginId) {
  const pluginDir = path.join(pluginsRoot, pluginId);
  const pkg = readJson(path.join(pluginDir, 'package.json'), `Plugin ${pluginId} package.json`);
  const manifest = readJson(path.join(pluginDir, 'openclaw.plugin.json'), `Plugin ${pluginId} manifest`);
  if (manifest.id !== pluginId) {
    throw new Error(`Plugin directory/id mismatch: expected ${pluginId}, manifest has ${String(manifest.id)}`);
  }
  if (pkg.name !== pluginId && pkg.name !== `${pluginId}-plugin`) {
    throw new Error(`Plugin ${pluginId} package name mismatch: ${String(pkg.name)}`);
  }
  if (!pkg.version || pkg.version !== manifest.version) {
    throw new Error(
      `Plugin ${pluginId} version mismatch: package=${String(pkg.version)} manifest=${String(manifest.version)}`,
    );
  }
  if (!pkg.main || pkg.main !== manifest.entry || !fs.existsSync(path.join(pluginDir, manifest.entry))) {
    throw new Error(
      `Plugin ${pluginId} entry mismatch or missing: package.main=${String(pkg.main)} manifest.entry=${String(manifest.entry)}`,
    );
  }
  if (pkg.openclaw?.extensions !== undefined
    && (!Array.isArray(pkg.openclaw.extensions) || !pkg.openclaw.extensions.includes(`./${manifest.entry}`))) {
    throw new Error(`Plugin ${pluginId} package.json declares an inconsistent OpenClaw entry`);
  }
  assertPluginRuntimeDependencies(pluginDir, pkg, `Plugin ${pluginId}`);
}

function validatePackagedPlugins(portableRoot) {
  const pluginsRoot = path.join(portableRoot, 'resources', 'openclaw-plugins');
  if (!fs.existsSync(pluginsRoot)) throw new Error('Packaged OpenClaw plugins directory is missing.');

  for (const plugin of BUNDLED_OPENCLAW_PLUGINS) {
    assertBundledPluginMetadata(pluginsRoot, plugin);
  }
  for (const pluginId of LOCAL_OPENCLAW_PLUGIN_IDS) {
    assertLocalPluginMetadata(pluginsRoot, pluginId);
  }
}

function validateBuildIdentity(portableRoot) {
  const currentCommit = resolveSourceCommit();
  const currentTreeState = resolveSourceTreeState();
  const identity = readJson(path.join(portableRoot, PACKAGED_IDENTITY_FILE), 'Packaged build identity');
  const asarPackage = JSON.parse(
    extractAsarFile(path.join(portableRoot, 'resources', 'app.asar'), 'package.json').toString('utf8'),
  );
  if (asarPackage.version !== PACKAGE_JSON.version || identity.appVersion !== PACKAGE_JSON.version) {
    throw new Error(`Stale app payload: source=${PACKAGE_JSON.version}, asar=${String(asarPackage.version)}, identity=${String(identity.appVersion)}`);
  }
  if (String(identity.gitCommit).toLowerCase() !== currentCommit) {
    throw new Error(`Stale win-unpacked commit: source=${currentCommit}, package=${String(identity.gitCommit)}`);
  }
  if (identity.sourceTreeState !== 'clean' || currentTreeState !== 'clean') {
    throw new Error(`Windows USB builds require clean source: package=${String(identity.sourceTreeState)}, current=${currentTreeState}`);
  }
  if (identity.platform !== 'win32' || identity.arch !== 'x64' || ARCH !== 'x64') {
    throw new Error(`Windows USB identity must be win32/x64: package=${String(identity.platform)}/${String(identity.arch)}, requested=${ARCH}`);
  }

  const executableMachines = Object.fromEntries(WINDOWS_PE_FILES.map((relativePath) => {
    const machine = readPeMachine(path.join(portableRoot, relativePath));
    return [relativePath, `0x${machine.toString(16)}`];
  }));
  const wrongArchitecture = Object.entries(executableMachines)
    .filter(([, machine]) => machine !== '0x8664')
    .map(([file, machine]) => `${file}=${machine}`);
  if (wrongArchitecture.length > 0) {
    throw new Error(`Windows runtime contains non-x64 executables: ${wrongArchitecture.join(', ')}`);
  }

  return {
    ...identity,
    packageType: 'portable_zip',
    appAsarVersion: asarPackage.version,
    executableMachine: executableMachines['UClaw.exe'],
    executableMachines,
    finalizedAt: new Date().toISOString(),
  };
}

function writeUsbIdentity(portableRoot, identity) {
  fs.writeFileSync(
    path.join(portableRoot, USB_IDENTITY_FILE),
    `${JSON.stringify(identity, null, 2)}\n`,
    'utf8',
  );
}

function assertPortableContents(portableRoot) {
  const missing = REQUIRED_FILES.filter((relativePath) => !fs.existsSync(path.join(portableRoot, relativePath)));
  if (missing.length > 0) throw new Error(`Windows USB package is incomplete. Missing: ${missing.join(', ')}`);
  validatePackagedPlugins(portableRoot);
}

function addDirectoryToZip(zip, sourceDir, prefix = '') {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const zipPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (zipPath.endsWith('.download')) continue;
    if (entry.isSymbolicLink()) throw new Error(`Refusing to package symbolic link: ${zipPath}`);
    if (entry.isDirectory()) {
      addDirectoryToZip(zip, sourcePath, zipPath);
    } else if (entry.isFile()) {
      zip.file(zipPath, fs.readFileSync(sourcePath), { date: new Date('2026-01-01T00:00:00Z') });
    }
  }
}

async function writeZip(portableRoot) {
  const zip = new JSZip();
  addDirectoryToZip(zip, portableRoot);
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'DOS',
  });
  fs.writeFileSync(OUTPUT_PATH, buffer);
  return buffer;
}

function writeMetadata(buffer, identity) {
  const metadata = {
    version: PACKAGE_JSON.version,
    platform: 'win',
    arch: ARCH,
    packageType: 'portable_zip',
    package_type: 'portable_zip',
    fileName: FILE_NAME,
    file_name: FILE_NAME,
    size: buffer.length,
    sha512: createHash('sha512').update(buffer).digest('hex'),
    releaseDate: new Date().toISOString(),
    buildId: identity.buildId,
    gitCommit: identity.gitCommit,
    sourceCreatedAt: identity.createdAt,
    appAsarVersion: identity.appAsarVersion,
    executableMachine: identity.executableMachine,
    executableMachines: identity.executableMachines,
  };
  fs.writeFileSync(METADATA_PATH, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return metadata;
}

if (process.argv.includes('--clean-only')) {
  if (process.argv.includes('--require-clean-source') && resolveSourceTreeState() !== 'clean') {
    console.error('[build-usb-release] Windows USB builds require a committed, clean source tree.');
    process.exit(1);
  }
  const removed = cleanExistingArtifacts({ includeUnpacked: true });
  console.log(`[build-usb-release] Removed ${removed.length} stale USB artifacts/build directories.`);
  process.exit(0);
}

try {
  if (process.platform !== 'win32') {
    throw new Error('Windows USB packages must be built on a Windows host. Use the Package Windows workflow.');
  }
  if (ARCH !== 'x64') throw new Error(`Unsupported Windows USB architecture: ${ARCH}`);
  const portableRoot = path.join(RELEASE_DIR, 'win-unpacked');
  if (!fs.existsSync(portableRoot)) {
    throw new Error('release/win-unpacked does not exist. Run electron-builder --win dir --x64 first.');
  }

  cleanExistingArtifacts();
  ensurePortableMarkers(portableRoot);
  const identity = validateBuildIdentity(portableRoot);
  writeUsbIdentity(portableRoot, identity);
  buildWindowsSelfCheck(path.join(portableRoot, SELF_CHECK_FILE));
  assertPortableDataClean(portableRoot);
  assertPortableContents(portableRoot);
  const buffer = await writeZip(portableRoot);
  const metadata = writeMetadata(buffer, identity);
  console.log(`[build-usb-release] Created ${path.relative(ROOT, OUTPUT_PATH)} (${metadata.size} bytes).`);
  console.log(`[build-usb-release] Metadata: ${path.relative(ROOT, METADATA_PATH)}`);
  console.log(`[build-usb-release] sha512: ${metadata.sha512}`);
} catch (error) {
  console.error(`[build-usb-release] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
