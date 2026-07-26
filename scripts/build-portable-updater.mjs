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
};

function readArg(name) {
  const prefixed = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefixed));
  if (match) return match.slice(prefixed.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
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
  const target = readArg('--target') || currentTarget();
  if (!TARGETS[target]) {
    throw new Error(`Unsupported portable updater target: ${target}`);
  }
  return [target];
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
