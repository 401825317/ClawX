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
  const regressionDir = path.join(releaseDir, 'regression', 'full-run');
  const source = path.join(root, 'source-results.json');
  const version = '1.2.3';
  const commit = 'a'.repeat(40);
  const buildId = 'test-build';
  const zipFileName = `UClaw-${version}-win-x64-usb.zip`;
  const zipPath = path.join(releaseDir, zipFileName);
  const metadataPath = zipPath.replace(/\.zip$/u, '.json');
  await mkdir(regressionDir, { recursive: true });
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
  await writeFile(source, JSON.stringify({ suites: [{ specs: [{ tests: [{}] }] }] }));
  await writeFile(path.join(regressionDir, 'summary.json'), JSON.stringify({
    profile: 'full',
    status: 'passed',
    runId: 'full-test-run',
    finishedAt: '2026-07-29T00:00:00.000Z',
    package: identity,
  }));
  await writeFile(path.join(regressionDir, 'UClaw-complete-regression-report.zh-CN.md'), '# Full\n');
  await writeFile(path.join(regressionDir, 'capability-results.json'), '{}\n');
  return { root, releaseDir, output, source, version, commit, regressionDir, identity };
}

test('stages only a passing Full summary for the exact final ZIP identity', async () => {
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
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a passing Full summary from different ZIP bytes', async () => {
  const fixture = await createFixture();
  try {
    const summaryPath = path.join(fixture.regressionDir, 'summary.json');
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    summary.package.sha512 = '0'.repeat(128);
    await writeFile(summaryPath, JSON.stringify(summary));
    await assert.rejects(
      stageProductionReleaseCandidate(fixture),
      /No passing Full regression matches the final portable ZIP identity/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
