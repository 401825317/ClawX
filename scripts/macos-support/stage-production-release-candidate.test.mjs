import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { stageMacosProductionReleaseCandidate } from './stage-production-release-candidate.mjs';

const VERSION = '2.0.3';
const COMMIT = 'a'.repeat(40);

function sha512(bytes) {
  return createHash('sha512').update(bytes).digest('base64');
}

async function createFixture({ duplicate = false, conflictingDuplicate = false, badHash = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-macos-candidate-'));
  const releaseDir = path.join(root, 'release');
  const output = path.join(root, 'candidate');
  await mkdir(releaseDir, { recursive: true });
  const files = [];
  for (const arch of ['x64', 'arm64']) {
    const zipName = `UClaw-${VERSION}-mac-${arch}.zip`;
    const blockmapName = `${zipName}.blockmap`;
    const dmgName = `UClaw-${VERSION}-mac-${arch}.dmg`;
    const zip = Buffer.from(`zip-${arch}`);
    const blockmap = Buffer.from(`blockmap-${arch}`);
    const dmg = Buffer.from(`dmg-${arch}`);
    await writeFile(path.join(releaseDir, zipName), zip);
    await writeFile(path.join(releaseDir, blockmapName), blockmap);
    await writeFile(path.join(releaseDir, dmgName), dmg);
    const appDirectory = arch === 'x64' ? 'mac' : 'mac-arm64';
    const identityDirectory = path.join(
      releaseDir,
      appDirectory,
      'UClaw.app',
      'Contents',
      'Resources',
    );
    await mkdir(identityDirectory, { recursive: true });
    await writeFile(path.join(identityDirectory, 'uclaw-build.json'), JSON.stringify({
      appVersion: VERSION,
      gitCommit: COMMIT,
      sourceTreeState: 'clean',
      platform: 'darwin',
      arch,
      buildId: `${arch}-build`,
    }));
    files.push({ url: zipName, sha512: badHash && arch === 'x64' ? 'bad' : sha512(zip), size: zip.length });
    files.push({ url: dmgName, sha512: sha512(dmg), size: dmg.length });
  }
  if (duplicate || conflictingDuplicate) {
    files.push({ ...files[0], ...(conflictingDuplicate ? { sha512: 'conflict' } : {}) });
  }
  await writeFile(path.join(releaseDir, 'latest-mac.yml'), YAML.stringify({
    version: VERSION,
    files,
    path: `UClaw-${VERSION}-mac-x64.zip`,
    sha512: files[0].sha512,
    releaseDate: '2026-08-26T00:00:00.000Z',
  }));
  return { root, releaseDir, output, version: VERSION, commit: COMMIT };
}

test('stages exact x64 and arm64 macOS update and download artifacts', async () => {
  const fixture = await createFixture();
  try {
    await stageMacosProductionReleaseCandidate(fixture);
    const candidate = JSON.parse(await readFile(path.join(fixture.output, 'candidate.json'), 'utf8'));
    assert.equal(candidate.version, VERSION);
    assert.equal(candidate.commit, COMMIT);
    assert.deepEqual(candidate.artifacts.map(({ arch }) => arch), ['x64', 'arm64']);
    assert.ok(candidate.artifacts.every(({ packageType }) => packageType === 'installer'));
    assert.ok(candidate.artifacts.every(({ buildId }) => buildId.endsWith('-build')));
    assert.ok(candidate.artifacts.every(({ updateBlockmapFileName }) => updateBlockmapFileName.endsWith('.zip.blockmap')));
    assert.ok(candidate.artifacts.every(({ updateSha512 }) => /^[A-Za-z0-9+/]+={0,2}$/u.test(updateSha512)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a packaged build identity from another commit', async () => {
  const fixture = await createFixture();
  try {
    const identityPath = path.join(
      fixture.releaseDir,
      'mac',
      'UClaw.app',
      'Contents',
      'Resources',
      'uclaw-build.json',
    );
    const identity = JSON.parse(await readFile(identityPath, 'utf8'));
    identity.gitCommit = 'b'.repeat(40);
    await writeFile(identityPath, JSON.stringify(identity));
    await assert.rejects(stageMacosProductionReleaseCandidate(fixture), /packaged build identity/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('normalizes identical duplicate latest-mac.yml artifact entries', async () => {
  const fixture = await createFixture({ duplicate: true });
  try {
    await stageMacosProductionReleaseCandidate(fixture);
    const normalized = YAML.parse(await readFile(path.join(fixture.output, 'latest-mac.yml'), 'utf8'));
    assert.equal(normalized.files.filter(({ url }) => url.endsWith('-mac-x64.zip')).length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects conflicting duplicate latest-mac.yml artifact entries', async () => {
  const fixture = await createFixture({ conflictingDuplicate: true });
  try {
    await assert.rejects(stageMacosProductionReleaseCandidate(fixture), /conflicting/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a latest-mac.yml hash that does not match the ZIP', async () => {
  const fixture = await createFixture({ badHash: true });
  try {
    await assert.rejects(stageMacosProductionReleaseCandidate(fixture), /integrity does not match/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
