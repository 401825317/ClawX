#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const releaseDir = path.join(ROOT, 'release');
const platform = process.argv.includes('--mac') ? 'mac'
  : process.argv.includes('--win') ? 'win'
    : process.platform === 'darwin' ? 'mac' : 'win';

function resolvePortableRoot() {
  if (platform === 'mac') {
    const appBundlePath = findAppBundle(releaseDir);
    if (!appBundlePath) {
      console.error('[prepare-usb-portable] release/*.app does not exist. Run electron-builder --mac dir first.');
      process.exit(1);
    }
    return path.dirname(appBundlePath);
  }

  const winUnpackedDir = path.join(releaseDir, 'win-unpacked');
  if (!fs.existsSync(winUnpackedDir)) {
    console.error('[prepare-usb-portable] release/win-unpacked does not exist. Run electron-builder --win dir first.');
    process.exit(1);
  }
  return winUnpackedDir;
}

function findAppBundle(dir, depth = 0) {
  if (depth > 3) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(dir, entry.name);
    if (entry.name.endsWith('.app')) return entryPath;
    const found = findAppBundle(entryPath, depth + 1);
    if (found) return found;
  }
  return null;
}

if (!fs.existsSync(releaseDir)) {
  console.error('[prepare-usb-portable] release directory does not exist. Run electron-builder first.');
  process.exit(1);
}

const portableRoot = resolvePortableRoot();
const dataDir = path.join(portableRoot, 'UClawData');
fs.mkdirSync(path.join(dataDir, 'updates'), { recursive: true });
fs.writeFileSync(path.join(portableRoot, 'portable.flag'), 'UClaw USB portable mode\n', 'utf-8');
fs.writeFileSync(path.join(dataDir, '.keep'), '', 'utf-8');

console.log(`[prepare-usb-portable] Added portable.flag and UClawData to ${path.relative(ROOT, portableRoot)}.`);
console.log('[prepare-usb-portable] Runtime caches are created on the host machine as UClawRuntime.');
