#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const releaseDir = path.join(ROOT, 'release');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const platform = process.argv.includes('--mac') ? 'mac'
  : process.argv.includes('--win') ? 'win'
    : process.platform === 'darwin' ? 'mac' : 'win';
const archArg = readArg('--arch');
const arch = archArg || process.arch;

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
  const metadataPath = path.join(releaseDir, fileName.replace(/\.zip$/i, '.json'));
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8');
  return { metadata, metadataPath };
}

if (!fs.existsSync(releaseDir)) {
  console.error('[build-usb-release] release directory does not exist. Run electron-builder first.');
  process.exit(1);
}

try {
  const portableRoot = resolvePortableRoot();
  ensurePortableMarkers(portableRoot);
  const fileName = `UClaw-${packageJson.version}-${platform}-${arch}-usb.zip`;
  const outputPath = path.join(releaseDir, fileName);
  const buffer = await writeZip(portableRoot, outputPath);
  const { metadata, metadataPath } = writeMetadata(fileName, buffer);

  console.log(`[build-usb-release] Created ${path.relative(ROOT, outputPath)} (${metadata.size} bytes).`);
  console.log(`[build-usb-release] Metadata: ${path.relative(ROOT, metadataPath)}`);
  console.log(`[build-usb-release] sha512: ${metadata.sha512}`);
} catch (error) {
  console.error(`[build-usb-release] ${(error instanceof Error ? error.message : String(error))}`);
  process.exit(1);
}
