import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stageMacosProductionReleaseCandidate } from './stage-production-release-candidate.mjs';
import { LOCAL_OPENCLAW_PLUGIN_IDS } from '../openclaw-bundle-config.mjs';

const VERSION = '2.0.3';
const COMMIT = 'a'.repeat(40);

function sha512(bytes) {
  return createHash('sha512').update(bytes).digest('hex');
}

function portableEntries(arch) {
  return [
    'portable.flag',
    'UClawData/',
    'UClawData/updates/',
    'UClaw.app/Contents/Resources/uclaw-build.json',
    `UClaw.app/Contents/Resources/resources/updater/darwin-${arch}/uclaw-portable-updater`,
    ...LOCAL_OPENCLAW_PLUGIN_IDS.flatMap((pluginId) => [
      `UClaw.app/Contents/Resources/openclaw-plugins/${pluginId}/package.json`,
      `UClaw.app/Contents/Resources/openclaw-plugins/${pluginId}/openclaw.plugin.json`,
      `UClaw.app/Contents/Resources/openclaw-plugins/${pluginId}/index.mjs`,
    ]),
    'UClaw.app/Contents/Resources/openclaw-plugins/clawx-openai-image/node_modules/undici/package.json',
  ];
}

async function createFixture({ badHash = false, missingPortableFlag = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-macos-candidate-'));
  const releaseDir = path.join(root, 'release');
  const output = path.join(root, 'candidate');
  const entries = new Map();
  const archiveContents = new Map();
  await mkdir(releaseDir, { recursive: true });
  for (const arch of ['x64', 'arm64']) {
    const fileName = `UClaw-${VERSION}-mac-${arch}-usb.zip`;
    const zip = Buffer.from(`portable-zip-${arch}`);
    await writeFile(path.join(releaseDir, fileName), zip);
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
    await writeFile(path.join(releaseDir, fileName.replace(/\.zip$/u, '.json')), JSON.stringify({
      schemaVersion: 1,
      package_type: 'portable_zip',
      platform: 'mac',
      arch,
      version: VERSION,
      gitCommit: COMMIT,
      buildId: `${arch}-build`,
      file_name: fileName,
      size: zip.length,
      sha512: badHash && arch === 'x64' ? 'bad' : sha512(zip),
      releaseDate: '2026-08-27T00:00:00.000Z',
    }));
    const archiveEntries = portableEntries(arch);
    const contents = new Map();
    for (const pluginId of LOCAL_OPENCLAW_PLUGIN_IDS) {
      const prefix = `UClaw.app/Contents/Resources/openclaw-plugins/${pluginId}/`;
      contents.set(`${prefix}package.json`, JSON.stringify({
        name: `${pluginId}-plugin`,
        version: '0.1.0',
        main: 'index.mjs',
      }));
      contents.set(`${prefix}openclaw.plugin.json`, JSON.stringify({
        id: pluginId,
        version: '0.1.0',
        entry: 'index.mjs',
      }));
    }
    contents.set(
      'UClaw.app/Contents/Resources/openclaw-plugins/clawx-openai-image/node_modules/undici/package.json',
      JSON.stringify({ name: 'undici', version: '8.1.0' }),
    );
    entries.set(
      fileName,
      missingPortableFlag && arch === 'x64'
        ? archiveEntries.filter((entry) => entry !== 'portable.flag')
        : archiveEntries,
    );
    archiveContents.set(fileName, contents);
  }
  return {
    root,
    releaseDir,
    output,
    version: VERSION,
    commit: COMMIT,
    listArchiveEntries: async (filePath) => entries.get(path.basename(filePath)),
    readArchiveEntry: async (filePath, entry) => archiveContents.get(path.basename(filePath))?.get(entry) ?? '',
  };
}

test('stages exact x64 and arm64 macOS USB ZIPs', async () => {
  const fixture = await createFixture();
  try {
    await stageMacosProductionReleaseCandidate(fixture);
    const candidate = JSON.parse(await readFile(path.join(fixture.output, 'candidate.json'), 'utf8'));
    assert.equal(candidate.schemaVersion, 2);
    assert.equal(candidate.version, VERSION);
    assert.equal(candidate.commit, COMMIT);
    assert.deepEqual(candidate.artifacts.map(({ arch }) => arch), ['x64', 'arm64']);
    assert.ok(candidate.artifacts.every(({ packageType }) => packageType === 'portable_zip'));
    assert.ok(candidate.artifacts.every(({ fileName }) => fileName.endsWith('-usb.zip')));
    assert.ok(candidate.artifacts.every(({ sha512: digest }) => /^[a-f0-9]{128}$/u.test(digest)));
    const staged = await readdir(fixture.output);
    assert.deepEqual(
      candidate.artifacts.map(({ metadataFileName }) => metadataFileName),
      ['UClaw-2.0.3-mac-x64-usb.json', 'UClaw-2.0.3-mac-arm64-usb.json'],
    );
    assert.ok(staged.includes('UClaw-2.0.3-mac-x64-usb.json'));
    assert.ok(staged.includes('UClaw-2.0.3-mac-arm64-usb.json'));
    assert.equal(staged.some((name) => name.endsWith('.dmg') || name.endsWith('.blockmap')), false);
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

test('rejects USB metadata whose SHA-512 does not match the ZIP', async () => {
  const fixture = await createFixture({ badHash: true });
  try {
    await assert.rejects(stageMacosProductionReleaseCandidate(fixture), /integrity mismatch/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a macOS ZIP without the root portable marker', async () => {
  const fixture = await createFixture({ missingPortableFlag: true });
  try {
    await assert.rejects(stageMacosProductionReleaseCandidate(fixture), /portable\.flag/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a macOS ZIP with an enclosing portable directory', async () => {
  const fixture = await createFixture();
  const originalListArchiveEntries = fixture.listArchiveEntries;
  fixture.listArchiveEntries = async (filePath) => [
    ...(await originalListArchiveEntries(filePath)),
    ...(path.basename(filePath).includes('-arm64-') ? [] : ['UClaw-2.0.3/portable.flag']),
  ];
  try {
    await assert.rejects(
      stageMacosProductionReleaseCandidate(fixture),
      /unexpected enclosing directory/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a macOS ZIP with a nested enclosing portable directory', async () => {
  const fixture = await createFixture();
  const originalListArchiveEntries = fixture.listArchiveEntries;
  fixture.listArchiveEntries = async (filePath) => [
    ...(await originalListArchiveEntries(filePath)),
    ...(path.basename(filePath).includes('-arm64-') ? [] : ['nested/UClaw/portable.flag']),
  ];
  try {
    await assert.rejects(
      stageMacosProductionReleaseCandidate(fixture),
      /unexpected enclosing directory/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a macOS ZIP missing the bundled video plugin', async () => {
  const fixture = await createFixture();
  fixture.listArchiveEntries = async (filePath) => (
    portableEntries(path.basename(filePath).includes('-arm64-') ? 'arm64' : 'x64')
      .filter((entry) => !entry.includes('/openclaw-plugins/uclaw-video/index.mjs'))
  );
  try {
    await assert.rejects(
      stageMacosProductionReleaseCandidate(fixture),
      /uclaw-video\/index\.mjs/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a macOS ZIP without the bundled OpenAI image plugin', async () => {
  const fixture = await createFixture();
  fixture.listArchiveEntries = async (filePath) => (
    portableEntries(path.basename(filePath).includes('-arm64-') ? 'arm64' : 'x64')
      .filter((entry) => !entry.includes('/clawx-openai-image/index.mjs'))
  );
  try {
    await assert.rejects(
      stageMacosProductionReleaseCandidate(fixture),
      /clawx-openai-image\/index\.mjs/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a macOS ZIP with a local plugin version mismatch', async () => {
  const fixture = await createFixture();
  const originalReadArchiveEntry = fixture.readArchiveEntry;
  fixture.readArchiveEntry = async (filePath, entry) => {
    const value = await originalReadArchiveEntry(filePath, entry);
    if (entry.endsWith('/uclaw-video/openclaw.plugin.json')) {
      return JSON.stringify({ ...JSON.parse(value), version: '0.2.1' });
    }
    return value;
  };
  try {
    await assert.rejects(
      stageMacosProductionReleaseCandidate(fixture),
      /uclaw-video.*version mismatch/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a macOS ZIP with a missing local plugin runtime dependency', async () => {
  const fixture = await createFixture();
  const originalReadArchiveEntry = fixture.readArchiveEntry;
  fixture.readArchiveEntry = async (filePath, entry) => {
    const value = await originalReadArchiveEntry(filePath, entry);
    if (entry.endsWith('/uclaw-video/package.json')) {
      return JSON.stringify({ ...JSON.parse(value), dependencies: { undici: '8.1.0' } });
    }
    return value;
  };
  try {
    await assert.rejects(
      stageMacosProductionReleaseCandidate(fixture),
      /uclaw-video.*missing runtime dependency.*undici/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
