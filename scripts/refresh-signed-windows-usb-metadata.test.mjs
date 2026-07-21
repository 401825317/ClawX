import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { refreshSignedWindowsUsbMetadata } from './refresh-signed-windows-usb-metadata.mjs';

test('refreshes only the integrity fields after a signed USB ZIP changes', async () => {
  const releaseDir = await mkdtemp(path.join(tmpdir(), 'uclaw-signed-usb-metadata-'));
  try {
    const version = '9.9.9';
    const fileName = `UClaw-${version}-win-x64-usb.zip`;
    const zipPath = path.join(releaseDir, fileName);
    const metadataPath = zipPath.replace(/\.zip$/u, '.json');
    await writeFile(zipPath, Buffer.from('signed zip bytes'));
    await writeFile(metadataPath, JSON.stringify({
      version,
      platform: 'win',
      arch: 'x64',
      packageType: 'portable_zip',
      package_type: 'portable_zip',
      fileName,
      file_name: fileName,
      size: 1,
      sha512: 'stale',
      buildId: 'keep-me',
    }));

    const result = await refreshSignedWindowsUsbMetadata({ releaseDir, version });
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    assert.equal(result.status, 'passed');
    assert.equal(metadata.size, Buffer.byteLength('signed zip bytes'));
    assert.match(metadata.sha512, /^[a-f0-9]{128}$/u);
    assert.equal(metadata.buildId, 'keep-me');
    assert.equal(metadata.fileName, fileName);
    assert.equal(metadata.file_name, fileName);
  } finally {
    await rm(releaseDir, { recursive: true, force: true });
  }
});

test('fails closed when the companion metadata does not identify the target ZIP', async () => {
  const releaseDir = await mkdtemp(path.join(tmpdir(), 'uclaw-signed-usb-metadata-invalid-'));
  try {
    const version = '9.9.9';
    const fileName = `UClaw-${version}-win-x64-usb.zip`;
    const zipPath = path.join(releaseDir, fileName);
    await writeFile(zipPath, Buffer.from('signed zip bytes'));
    await writeFile(zipPath.replace(/\.zip$/u, '.json'), JSON.stringify({
      version,
      platform: 'win',
      arch: 'x64',
      packageType: 'portable_zip',
      package_type: 'portable_zip',
      fileName: 'wrong.zip',
      file_name: 'wrong.zip',
    }));
    await assert.rejects(
      refreshSignedWindowsUsbMetadata({ releaseDir, version }),
      /filename mismatch/u,
    );
  } finally {
    await rm(releaseDir, { recursive: true, force: true });
  }
});
