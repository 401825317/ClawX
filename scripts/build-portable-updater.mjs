#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'tools', 'portable-updater');
const OUTPUT_ROOT = path.join(ROOT, 'resources', 'updater');

const TARGETS = {
  'win32-x64': { goos: 'windows', goarch: 'amd64', fileName: 'uclaw-portable-updater.exe' },
  'darwin-arm64': { goos: 'darwin', goarch: 'arm64', fileName: 'uclaw-portable-updater' },
  'darwin-x64': { goos: 'darwin', goarch: 'amd64', fileName: 'uclaw-portable-updater' },
};

function readArgs(name) {
  const values = [];
  const prefixed = `${name}=`;
  for (let index = 0; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument.startsWith(prefixed)) {
      values.push(argument.slice(prefixed.length));
      continue;
    }
    if (argument === name && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
      index++;
    }
  }
  return values;
}

function currentTarget() {
  const platform = process.platform;
  const arch = process.arch === 'x64' ? 'x64' : process.arch;
  return `${platform}-${arch}`;
}

function selectedTargets() {
  if (process.argv.includes('--all')) {
    return Object.keys(TARGETS);
  }
  const requestedTargets = readArgs('--target');
  const targets = requestedTargets.length > 0 ? requestedTargets : [currentTarget()];
  for (const target of targets) {
    if (!TARGETS[target]) {
      throw new Error(`Unsupported portable updater target: ${target}`);
    }
  }
  return [...new Set(targets)];
}

function buildTarget(target) {
  const spec = TARGETS[target];
  const outputDir = path.join(OUTPUT_ROOT, target);
  const outputPath = path.join(outputDir, spec.fileName);
  fs.mkdirSync(outputDir, { recursive: true });

  const ldflags = target.startsWith('win32-')
    ? '-s -w -H=windowsgui'
    : '-s -w';
  const result = spawnSync('go', ['build', '-trimpath', '-ldflags', ldflags, '-o', outputPath, '.'], {
    cwd: SOURCE_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      CGO_ENABLED: '0',
      GOOS: spec.goos,
      GOARCH: spec.goarch,
    },
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`go build failed for ${target} with exit code ${result.status}`);
  }
  fs.chmodSync(outputPath, 0o755);
  console.log(`[build-portable-updater] Built ${path.relative(ROOT, outputPath)}`);
}

try {
  for (const target of selectedTargets()) {
    buildTarget(target);
  }
} catch (error) {
  console.error(`[build-portable-updater] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
