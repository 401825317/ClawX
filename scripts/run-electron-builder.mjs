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
const electronBuilderEnv = {
  ...process.env,
  ...(skipNsisPatch ? { CLAWX_SKIP_NSIS_PATCH: '1' } : {}),
};

function isWindowsBuild() {
  return args.some((arg) => arg === '--win' || arg === 'portable');
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
      env: electronBuilderEnv,
    });
  }

  if (process.platform === 'win32') {
    return spawn(process.execPath, [ELECTRON_BUILDER_CLI, ...args], {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...electronBuilderEnv,
        PATH: `${__dirname}${pathDelimiter}${process.env.PATH ?? ''}`,
      },
      shell: false,
    });
  }

  return spawn(ELECTRON_BUILDER_BIN, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: electronBuilderEnv,
    shell: false,
  });
}

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
