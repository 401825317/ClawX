#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const require = createRequire(import.meta.url);
const { executeAppBuilderAsJson } = require('app-builder-lib/out/util/appBuilder');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_JSON = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

function parseArgs(argv) {
  const options = {
    releaseDir: path.join(ROOT, 'release'),
    installer: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inlineValue] = arg.split('=', 2);
    const readValue = () => inlineValue ?? argv[++index] ?? '';
    switch (name) {
      case '--':
        break;
      case '--release-dir':
        options.releaseDir = path.resolve(readValue());
        break;
      case '--installer':
        options.installer = path.resolve(readValue());
        break;
      case '--help':
      case '-h':
        console.log(`Refresh signed Windows update metadata

Usage:
  node scripts/refresh-signed-windows-update-metadata.mjs [options]

Options:
  --release-dir <path>  Release directory; defaults to ./release.
  --installer <path>    Signed NSIS installer; defaults to UClaw-<version>-win-x64.exe.
`);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function sha512(filePath) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('base64');
}

function artifactName(value) {
  if (!value) return '';
  try {
    return path.basename(new URL(String(value), 'https://update.invalid').pathname);
  } catch {
    return path.basename(String(value));
  }
}

async function replaceFileAtomically(filePath, content) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function assertBlockmap(blockmap, installerSize) {
  if (blockmap?.version !== '2' || !Array.isArray(blockmap.files) || blockmap.files.length === 0) {
    throw new Error('Generated blockmap has an unsupported structure');
  }
  let coveredBytes = 0;
  for (const file of blockmap.files) {
    if (!Array.isArray(file.sizes)
      || !Array.isArray(file.checksums)
      || file.sizes.length === 0
      || file.sizes.length !== file.checksums.length) {
      throw new Error('Generated blockmap has incomplete chunk metadata');
    }
    coveredBytes += Number(file.offset || 0);
    coveredBytes += file.sizes.reduce((total, size) => total + Number(size), 0);
  }
  if (coveredBytes !== installerSize) {
    throw new Error(`Generated blockmap covers ${coveredBytes} bytes, expected ${installerSize}`);
  }
}

export async function assertBlockmapMatchesInstaller(installerPath, blockmapPath) {
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'uclaw-blockmap-verify-'));
  const regeneratedPath = path.join(temporaryDir, path.basename(blockmapPath));
  try {
    await executeAppBuilderAsJson([
      'blockmap',
      '--input',
      installerPath,
      '--output',
      regeneratedPath,
    ]);
    const [published, regenerated] = await Promise.all([
      readFile(blockmapPath),
      readFile(regeneratedPath),
    ]);
    const publishedJson = gunzipSync(published).toString('utf8');
    const regeneratedJson = gunzipSync(regenerated).toString('utf8');
    if (publishedJson !== regeneratedJson) {
      throw new Error(`Installer blockmap does not match the installer: ${blockmapPath}`);
    }
  } catch (error) {
    if (error instanceof Error && /Installer blockmap does not match/u.test(error.message)) throw error;
    throw new Error(
      `Installer blockmap is invalid: ${blockmapPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function refreshManifest(manifestPath, installerName, installerSize, installerSha512) {
  const manifest = YAML.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false;
  const matchingFiles = Array.isArray(manifest.files)
    ? manifest.files.filter((entry) => artifactName(entry?.url) === installerName)
    : [];
  const matchesTopLevel = artifactName(manifest.path) === installerName;
  if (!matchesTopLevel && matchingFiles.length === 0) return false;
  if (!matchesTopLevel || matchingFiles.length !== 1) {
    throw new Error(`Manifest does not identify exactly one installer entry: ${manifestPath}`);
  }

  matchingFiles[0].sha512 = installerSha512;
  matchingFiles[0].size = installerSize;
  manifest.sha512 = installerSha512;
  await replaceFileAtomically(manifestPath, YAML.stringify(manifest));

  const verified = YAML.parse(await readFile(manifestPath, 'utf8'));
  const verifiedFile = verified.files?.find((entry) => artifactName(entry?.url) === installerName);
  if (verified.version !== PACKAGE_JSON.version
    || artifactName(verified.path) !== installerName
    || verified.sha512 !== installerSha512
    || verifiedFile?.sha512 !== installerSha512
    || Number(verifiedFile?.size) !== installerSize) {
    throw new Error(`Manifest verification failed after refresh: ${manifestPath}`);
  }
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const installerPath = options.installer || path.join(
    options.releaseDir,
    `UClaw-${PACKAGE_JSON.version}-win-x64.exe`,
  );
  const installerStat = await stat(installerPath);
  if (!installerStat.isFile() || installerStat.size <= 0) {
    throw new Error(`Signed Windows installer is missing or empty: ${installerPath}`);
  }

  const installerName = path.basename(installerPath);
  const installerSha512 = await sha512(installerPath);
  const blockmapPath = `${installerPath}.blockmap`;
  const updateInfo = await executeAppBuilderAsJson([
    'blockmap',
    '--input',
    installerPath,
    '--output',
    blockmapPath,
  ]);
  if (Number(updateInfo?.size) !== installerStat.size || updateInfo?.sha512 !== installerSha512) {
    throw new Error('app-builder returned metadata that does not match the signed installer');
  }

  const blockmap = JSON.parse(gunzipSync(await readFile(blockmapPath)).toString('utf8'));
  assertBlockmap(blockmap, installerStat.size);
  const blockmapStat = await stat(blockmapPath);

  const manifestNames = (await readdir(options.releaseDir))
    .filter((name) => name.endsWith('.yml') && name !== 'builder-debug.yml')
    .sort();
  const refreshedManifests = [];
  for (const manifestName of manifestNames) {
    const manifestPath = path.join(options.releaseDir, manifestName);
    if (await refreshManifest(
      manifestPath,
      installerName,
      installerStat.size,
      installerSha512,
    )) refreshedManifests.push(manifestName);
  }
  if (refreshedManifests.length !== 1) {
    throw new Error(
      `Expected exactly one Windows update manifest for ${installerName}, found ${refreshedManifests.length}`,
    );
  }

  console.log(JSON.stringify({
    status: 'passed',
    installer: installerName,
    version: PACKAGE_JSON.version,
    size: installerStat.size,
    sha512: installerSha512,
    blockmap: path.basename(blockmapPath),
    blockmapSize: blockmapStat.size,
    blockmapChunks: blockmap.files.reduce((total, file) => total + file.sizes.length, 0),
    manifests: refreshedManifests,
    host: `${os.platform()}/${os.arch()}`,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `[refresh-signed-windows-update-metadata] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
