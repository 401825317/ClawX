#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronExecutable = require('electron');
const electronVersion = require('electron/package.json').version;
const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), '..');
const sourceApp = dirname(dirname(dirname(electronExecutable)));
const outputDir = join(root, 'build', 'dev-electron');
const targetApp = join(outputDir, 'UClaw.app');
const targetExecutable = join(targetApp, 'Contents', 'MacOS', 'Electron');
const fingerprintPath = join(outputDir, 'fingerprint.txt');
const iconPath = join(root, 'resources', 'icons', 'icon.icns');
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

function setPlistString(plistPath, key, value) {
  const extracted = spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', plistPath], {
    encoding: 'utf8',
  });
  const operation = extracted.status === 0 ? '-replace' : '-insert';
  execFileSync('/usr/bin/plutil', [operation, key, '-string', value, plistPath]);
}

function buildFingerprint() {
  const hash = createHash('sha256');
  hash.update(readFileSync(scriptPath));
  hash.update(readFileSync(iconPath));
  hash.update(JSON.stringify({
    electronVersion,
    arch: process.arch,
    packageVersion,
    sourceExecutableMtimeMs: statSync(electronExecutable).mtimeMs,
  }));
  return hash.digest('hex');
}

function prepareDevElectron() {
  if (process.platform !== 'darwin') return;

  const fingerprint = buildFingerprint();
  if (
    existsSync(targetExecutable)
    && existsSync(fingerprintPath)
    && readFileSync(fingerprintPath, 'utf8').trim() === fingerprint
  ) {
    console.log(`[dev-electron] Reusing branded UClaw host: ${targetApp}`);
    return;
  }

  console.log(`[dev-electron] Preparing UClaw host from Electron ${electronVersion} (${process.arch})...`);
  mkdirSync(outputDir, { recursive: true });
  rmSync(targetApp, { recursive: true, force: true });
  execFileSync('/bin/cp', ['-cR', sourceApp, targetApp], { stdio: 'inherit' });

  const mainPlist = join(targetApp, 'Contents', 'Info.plist');
  setPlistString(mainPlist, 'CFBundleDisplayName', 'UClaw');
  // Keep the internal Electron executable/name so process.defaultApp remains
  // true and Electron continues to expose app.isPackaged=false in development.
  setPlistString(mainPlist, 'CFBundleName', 'Electron');
  setPlistString(mainPlist, 'CFBundleIdentifier', 'app.clawx.desktop.dev');
  setPlistString(mainPlist, 'CFBundleExecutable', 'Electron');
  setPlistString(mainPlist, 'CFBundleIconFile', 'icon.icns');
  setPlistString(mainPlist, 'CFBundleShortVersionString', packageVersion);
  setPlistString(mainPlist, 'CFBundleVersion', packageVersion);
  copyFileSync(iconPath, join(targetApp, 'Contents', 'Resources', 'icon.icns'));

  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', targetApp], { stdio: 'inherit' });
  // The npm Electron.framework is linker-signed without sealed resources, so
  // strict/deep verification fails even on the untouched source Electron.app.
  execFileSync('/usr/bin/codesign', ['--verify', '--ignore-resources', targetApp], { stdio: 'inherit' });
  writeFileSync(fingerprintPath, `${fingerprint}\n`, 'utf8');
  console.log(`[dev-electron] Ready: ${targetApp}`);
}

prepareDevElectron();
