#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const pathDelimiter = process.platform === 'win32' ? ';' : ':';
const ELECTRON_BUILDER_CLI = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const ELECTRON_BUILDER_BIN = process.platform === 'win32'
  ? ELECTRON_BUILDER_CLI
  : path.join(ROOT, 'node_modules', '.bin', 'electron-builder');
const passthroughArgs = process.argv.slice(2);
const skipNsisPatch = passthroughArgs.includes('--skip-nsis-patch');
const args = passthroughArgs.filter((arg) => arg !== '--skip-nsis-patch');
const REQUIRED_WINDOWS_RUNTIME_BINARIES = [
  'node.exe',
  'uv.exe',
  'agent-browser.exe',
  'ffmpeg.exe',
  'ffprobe.exe',
  'ffmpeg-runtime.json',
];

function isWindowsBuild() {
  if (process.platform !== 'win32') return false;
  if (args.some((arg) => arg === '--help' || arg === '-h' || arg === '--version')) return false;
  return !args.some((arg) => arg === '--mac' || arg === '-m' || arg === '--linux' || arg === '-l');
}

function resolveWindowsTargetArch() {
  if (args.includes('--arm64')) return 'arm64';
  if (args.includes('--ia32')) return 'ia32';
  return 'x64';
}

function validateWindowsRuntimeBinaries() {
  if (!isWindowsBuild()) return;
  const arch = resolveWindowsTargetArch();
  const binDir = path.join(ROOT, 'resources', 'bin', `win32-${arch}`);
  const missing = REQUIRED_WINDOWS_RUNTIME_BINARIES.filter((name) => {
    const filePath = path.join(binDir, name);
    try {
      const stat = fs.statSync(filePath);
      return !stat.isFile() || stat.size <= 0;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    const prepCommand = arch === 'x64' ? 'pnpm run prep:win-binaries:x64' : 'pnpm run prep:win-binaries:all';
    throw new Error(
      [
        `[run-electron-builder] Missing required Windows runtime binaries for win32-${arch}: ${missing.join(', ')}`,
        `Expected directory: ${binDir}`,
        `Run: ${prepCommand}`,
      ].join('\n'),
    );
  }
}

function cleanWindowsBuildOutput() {
  if (!isWindowsBuild()) {
    return;
  }

  const winUnpacked = path.join(ROOT, 'release', 'win-unpacked');
  if (!fs.existsSync(winUnpacked)) {
    return;
  }

  fs.rmSync(winUnpacked, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 1000,
  });
  console.log('[run-electron-builder] Removed stale release/win-unpacked before Windows packaging.');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function spawnElectronBuilder() {
  if (process.platform === 'darwin') {
    const command = [
      'ulimit -n 65536 >/dev/null 2>&1 || ulimit -n 32768 >/dev/null 2>&1 || ulimit -n 16384 >/dev/null 2>&1 || true',
      `exec ${shellQuote(ELECTRON_BUILDER_BIN)}${args.length > 0 ? ` ${args.map(shellQuote).join(' ')}` : ''}`,
    ].join('; ');

    return spawn('/bin/bash', ['-lc', command], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
  }

  if (process.platform === 'win32') {
    return spawn(process.execPath, [ELECTRON_BUILDER_CLI, ...args], {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(skipNsisPatch ? { CLAWX_SKIP_NSIS_PATCH: '1' } : {}),
        PATH: `${__dirname}${pathDelimiter}${process.env.PATH ?? ''}`,
      },
      shell: false,
    });
  }

  return spawn(ELECTRON_BUILDER_BIN, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    shell: false,
  });
}

validateWindowsRuntimeBinaries();
cleanWindowsBuildOutput();

const child = spawnElectronBuilder();
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
