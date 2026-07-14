#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { buildWindowsSelfCheck } from './build-windows-self-check.mjs';
import { LOCAL_OPENCLAW_PLUGIN_IDS } from './openclaw-bundle-config.mjs';

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
  fs.mkdirSync(path.join(dataDir, 'updates'), { recursive: true });
  fs.writeFileSync(path.join(portableRoot, 'portable.flag'), 'UClaw USB portable mode\n', 'utf-8');
  fs.writeFileSync(path.join(dataDir, '.keep'), '', 'utf-8');
}

function cleanExistingArtifacts() {
  fs.rmSync(outputPath, { force: true });
  fs.rmSync(metadataPath, { force: true });
}

function installWindowsSelfCheck(portableRoot) {
  buildWindowsSelfCheck(path.join(portableRoot, WINDOWS_SELF_CHECK_FILE));
}

function assertWindowsPortableContents(portableRoot) {
  if (process.platform !== 'win32') {
    throw new Error('Windows USB packages must be built on a Windows host. Use the Package Windows (Manual) GitHub Actions workflow.');
  }

  const requiredFiles = [
    'UClaw.exe',
    'portable.flag',
    'resources/app.asar',
    'resources/bin/node.exe',
    'resources/bin/uv.exe',
    'resources/bin/agent-browser.exe',
    'resources/cli/openclaw.cmd',
    'resources/openclaw/openclaw.mjs',
    'resources/openclaw/package.json',
    'resources/openclaw/node_modules/sharp/package.json',
    'resources/openclaw/node_modules/@img/sharp-win32-x64/package.json',
    WINDOWS_SELF_CHECK_FILE,
  ];
  const typeboxPlugins = new Set();
  for (const pluginId of LOCAL_OPENCLAW_PLUGIN_IDS) {
    const packageJsonPath = path.join(portableRoot, 'resources', 'openclaw-plugins', pluginId, 'package.json');
    requiredFiles.push(
      `resources/openclaw-plugins/${pluginId}/index.mjs`,
      `resources/openclaw-plugins/${pluginId}/openclaw.plugin.json`,
      `resources/openclaw-plugins/${pluginId}/package.json`,
    );
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

function writeMetadata(fileName, buffer) {
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
  };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8');
  return { metadata, metadataPath };
}

if (process.argv.includes('--clean-only')) {
  cleanExistingArtifacts();
  console.log(`[build-usb-release] Removed stale ${path.relative(ROOT, outputPath)} and metadata.`);
  process.exit(0);
}

if (!fs.existsSync(releaseDir)) {
  console.error('[build-usb-release] release directory does not exist. Run electron-builder first.');
  process.exit(1);
}

try {
  cleanExistingArtifacts();
  const portableRoot = resolvePortableRoot();
  ensurePortableMarkers(portableRoot);
  if (platform === 'win') {
    installWindowsSelfCheck(portableRoot);
    assertWindowsPortableContents(portableRoot);
  }
  const buffer = await writeZip(portableRoot, outputPath);
  const { metadata, metadataPath } = writeMetadata(fileName, buffer);

  console.log(`[build-usb-release] Created ${path.relative(ROOT, outputPath)} (${metadata.size} bytes).`);
  console.log(`[build-usb-release] Metadata: ${path.relative(ROOT, metadataPath)}`);
  console.log(`[build-usb-release] sha512: ${metadata.sha512}`);
} catch (error) {
  console.error(`[build-usb-release] ${(error instanceof Error ? error.message : String(error))}`);
  process.exit(1);
}
