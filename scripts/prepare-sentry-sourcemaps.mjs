import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const defaultMapRoots = [join(root, 'dist'), join(root, 'dist-electron')];

export function countSourceMaps(directory) {
  let count = 0;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.map')) count++;
    }
  }
  return count;
}

export function prepareSentrySourceMaps(options = {}) {
  const projectRoot = options.root || root;
  const mapRoots = options.mapRoots || [
    join(projectRoot, 'dist'),
    join(projectRoot, 'dist-electron'),
  ];
  const log = options.log || console.log;
  const sourceMapCounts = mapRoots.map(countSourceMaps);
  const sourceMapCount = sourceMapCounts.reduce((count, current) => count + current, 0);
  if (sourceMapCounts.some((count) => count === 0)) {
    throw new Error('[sentry] Source map injection failed: an expected build output has no source maps.');
  }

  const cli = (options.resolveCli || (() => require.resolve('@sentry/cli/bin/sentry-cli')))();
  const execute = options.spawnSync || spawnSync;
  const result = execute(process.execPath, [
    cli,
    'sourcemaps',
    'inject',
    ...mapRoots,
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {},
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (result.error) {
    throw new Error('[sentry] Local source map injection could not start.');
  }
  if (result.status !== 0) {
    throw new Error(`Sentry source map injection failed with exit code ${String(result.status)}`);
  }
  log(`[sentry] Injected debug IDs into ${sourceMapCount} temporary build source map(s).`);
  return { status: 'injected', sourceMapCount };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  prepareSentrySourceMaps({ root, mapRoots: defaultMapRoots });
}
