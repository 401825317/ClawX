import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { __test } = require('./after-pack.cjs');

async function createPackage(root, name) {
  const packageDir = path.join(root, ...name.split('/'));
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  return packageDir;
}

test('afterPack keeps only the target Sharp native runtime in app.asar.unpacked', async () => {
  const root = path.join(tmpdir(), `uclaw-after-pack-native-${process.pid}-${Date.now()}`);
  try {
    await createPackage(root, 'sharp');
    for (const name of [
      '@img/sharp-darwin-arm64',
      '@img/sharp-linux-x64',
      '@img/sharp-win32-arm64',
      '@img/sharp-win32-ia32',
      '@img/sharp-win32-x64',
      '@img/sharp-wasm32',
    ]) await createPackage(root, name);

    const removed = __test.cleanupNativePlatformPackages(root, 'win32', 'x64');
    assert.equal(removed, 4);
    await assert.doesNotReject(async () => {
      __test.assertNoNonTargetNativePlatformPackages(root, 'win32', 'x64', 'fixture');
      __test.assertTargetSharpRuntimePresent(root, 'win32', 'x64', 'fixture');
    });
    assert.equal(require('node:fs').existsSync(path.join(root, '@img', 'sharp-win32-x64')), true);
    assert.equal(require('node:fs').existsSync(path.join(root, '@img', 'sharp-wasm32')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('afterPack fails closed when Sharp has no native runtime for the target', async () => {
  const root = path.join(tmpdir(), `uclaw-after-pack-sharp-${process.pid}-${Date.now()}`);
  try {
    await createPackage(root, 'sharp');
    await createPackage(root, '@img/sharp-darwin-arm64');
    __test.cleanupNativePlatformPackages(root, 'win32', 'x64');
    assert.throws(
      () => __test.assertTargetSharpRuntimePresent(root, 'win32', 'x64', 'fixture'),
      /missing a Sharp runtime for win32\/x64/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
