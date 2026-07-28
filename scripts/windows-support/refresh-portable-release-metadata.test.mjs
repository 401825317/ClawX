import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { refreshPortableReleaseMetadata } from './refresh-portable-release-metadata.mjs';

test('refreshes metadata from the exact final portable ZIP bytes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uclaw-portable-metadata-'));
  try {
    const version = '1.2.3';
    const commit = 'a'.repeat(40);
    const zipName = `UClaw-${version}-win-x64-usb.zip`;
    const zipPath = path.join(directory, zipName);
    const metadataPath = zipPath.replace(/\.zip$/u, '.json');
    await writeFile(zipPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]));
    await writeFile(metadataPath, `${JSON.stringify({
      version,
      packageType: 'portable_zip',
      package_type: 'portable_zip',
      fileName: zipName,
      file_name: zipName,
      size: 1,
      sha512: '0'.repeat(128),
      buildId: 'test-build',
      gitCommit: commit,
    }, null, 2)}\n`);

    const result = await refreshPortableReleaseMetadata({ zip: zipPath, version, commit });
    const refreshed = JSON.parse(await readFile(metadataPath, 'utf8'));
    assert.equal(result.metadataMatches, true);
    assert.equal(refreshed.size, 6);
    assert.equal(refreshed.sha512, result.identity.sha512);
    assert.notEqual(refreshed.sha512, '0'.repeat(128));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
