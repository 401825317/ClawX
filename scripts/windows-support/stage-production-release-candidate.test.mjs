import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha512File } from './portable-release-utils.mjs';
import { stageProductionReleaseCandidate } from './stage-production-release-candidate.mjs';

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-production-candidate-'));
  const releaseDir = path.join(root, 'release');
  const output = path.join(root, 'candidate');
  const version = '1.2.3';
  const commit = 'a'.repeat(40);
  const buildId = 'test-build';
  const zipFileName = `UClaw-${version}-win-x64-usb.zip`;
  const zipPath = path.join(releaseDir, zipFileName);
  const metadataPath = zipPath.replace(/\.zip$/u, '.json');
  await mkdir(releaseDir, { recursive: true });
  await writeFile(zipPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]));
  const zipSize = (await readFile(zipPath)).length;
  const sha512 = await sha512File(zipPath);
  const identity = { version, buildId, gitCommit: commit, zipFileName, zipSize, sha512 };
  await writeFile(metadataPath, `${JSON.stringify({
    version,
    packageType: 'portable_zip',
    package_type: 'portable_zip',
    fileName: zipFileName,
    file_name: zipFileName,
    size: zipSize,
    sha512,
    buildId,
    gitCommit: commit,
  }, null, 2)}\n`);
  return { root, releaseDir, output, version, commit, identity };
}

test('stages the exact portable artifact without requiring regression evidence', async () => {
  const fixture = await createFixture();
  try {
    const result = await stageProductionReleaseCandidate(fixture);
    const candidate = JSON.parse(await readFile(path.join(fixture.output, 'candidate.json'), 'utf8'));
    assert.equal(result.candidate.sha512, fixture.identity.sha512);
    assert.equal(candidate.version, fixture.version);
    assert.equal(candidate.commit, fixture.commit);
    assert.equal(candidate.buildId, fixture.identity.buildId);
    assert.equal(candidate.size, fixture.identity.zipSize);
    assert.equal(candidate.sha512, fixture.identity.sha512);
    assert.equal('fullRunId' in candidate, false);
    assert.equal('sourceResults' in candidate, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects portable metadata from different ZIP bytes', async () => {
  const fixture = await createFixture();
  try {
    const metadataPath = path.join(
      fixture.releaseDir,
      `UClaw-${fixture.version}-win-x64-usb.json`,
    );
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    metadata.sha512 = '0'.repeat(128);
    await writeFile(metadataPath, JSON.stringify(metadata));
    await assert.rejects(
      stageProductionReleaseCandidate(fixture),
      /Portable JSON does not match the final ZIP/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
