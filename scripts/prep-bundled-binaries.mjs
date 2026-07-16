#!/usr/bin/env node

import { spawn } from 'node:child_process';

const PLATFORM_PREP_SCRIPTS = {
  darwin: 'prep:mac-binaries',
  win32: 'prep:win-binaries',
  linux: 'prep:linux-binaries',
};

const script = PLATFORM_PREP_SCRIPTS[process.platform];
if (!script) {
  throw new Error(`Unsupported platform for bundled binary preparation: ${process.platform}`);
}

const command = process.platform === 'win32' ? 'cmd.exe' : 'pnpm';
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', `pnpm run ${script}`]
  : ['run', script];
const child = spawn(command, args, {
  cwd: process.cwd(),
  stdio: 'inherit',
  windowsHide: true,
  shell: false,
});

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
