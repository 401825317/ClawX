import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { repackPortableRelease } from './repack-portable-release.mjs';

async function writeFixture(directory) {
  const zip = new JSZip();
  zip.file('portable.flag', 'portable\n');
  zip.folder('UClawData/updates');
  zip.file('UClaw.exe', 'unsigned-main');
  zip.file('resources/resources/updater/win32-x64/uclaw-portable-updater.exe', 'unsigned-updater');
  const archive = path.join(directory, 'UClaw.zip');
  await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
  return archive;
}

test('repack preserves portable directories and replaces only approved entries', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uclaw-repack-'));
  const archive = await writeFixture(directory);
  const main = path.join(directory, 'main.exe');
  const updater = path.join(directory, 'updater.exe');
  await writeFile(main, 'signed-main');
  await writeFile(updater, 'signed-updater');
  await repackPortableRelease({
    zip: archive,
    replacements: new Map([
      ['UClaw.exe', main],
      ['resources/resources/updater/win32-x64/uclaw-portable-updater.exe', updater],
    ]),
  });
  const result = await JSZip.loadAsync(await readFile(archive));
  assert.ok(result.files['portable.flag']);
  assert.ok(result.files['UClawData/']);
  assert.ok(result.files['UClawData/updates/']);
  assert.equal(await result.file('UClaw.exe').async('text'), 'signed-main');
  assert.equal(await result.file('resources/resources/updater/win32-x64/uclaw-portable-updater.exe').async('text'), 'signed-updater');
});

test('repack rejects replacement paths absent from the portable archive', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uclaw-repack-'));
  const archive = await writeFixture(directory);
  const replacement = path.join(directory, 'missing.exe');
  await writeFile(replacement, 'signed');
  await assert.rejects(
    repackPortableRelease({ zip: archive, replacements: new Map([['missing.exe', replacement]]) }),
    /Replacement targets are absent/u,
  );
});
