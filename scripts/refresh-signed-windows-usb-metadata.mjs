#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_JSON = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

function parseArgs(argv) {
  const options = {
    releaseDir: path.join(ROOT, 'release'),
    version: PACKAGE_JSON.version,
    zip: '',
    metadata: '',
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
      case '--version':
        options.version = readValue();
        break;
      case '--zip':
        options.zip = path.resolve(readValue());
        break;
      case '--metadata':
        options.metadata = path.resolve(readValue());
        break;
      case '--help':
      case '-h':
        console.log(`Refresh signed Windows USB metadata

Usage:
  node scripts/refresh-signed-windows-usb-metadata.mjs [options]

Options:
  --release-dir <path>  Release directory; defaults to ./release.
  --version <version>   Release version; defaults to package.json.
  --zip <path>          Signed USB ZIP; defaults to the x64 release ZIP.
  --metadata <path>     USB JSON; defaults beside the ZIP.
`);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function sha512Hex(filePath) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
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

function expectedZipName(version) {
  return `UClaw-${version}-win-x64-usb.zip`;
}

function assertMetadataShape(metadata, version, fileName) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Windows USB metadata must be a JSON object');
  }
  if (String(metadata.version) !== version) {
    throw new Error(`Windows USB metadata version mismatch: ${String(metadata.version)}`);
  }
  if (metadata.platform !== 'win' || metadata.arch !== 'x64') {
    throw new Error('Windows USB metadata must target win/x64');
  }
  if (metadata.packageType !== 'portable_zip' || metadata.package_type !== 'portable_zip') {
    throw new Error('Windows USB metadata must declare packageType=portable_zip');
  }
  if (metadata.fileName !== fileName || metadata.file_name !== fileName) {
    throw new Error(`Windows USB metadata filename mismatch: expected ${fileName}`);
  }
}

/** Rewrites only integrity fields after SignPath changes the ZIP bytes. */
export async function refreshSignedWindowsUsbMetadata({
  releaseDir = path.join(ROOT, 'release'),
  version = PACKAGE_JSON.version,
  zip = '',
  metadata = '',
} = {}) {
  const fileName = expectedZipName(version);
  const zipPath = path.resolve(zip || path.join(releaseDir, fileName));
  const metadataPath = path.resolve(metadata || zipPath.replace(/\.zip$/iu, '.json'));
  const zipStat = await stat(zipPath);
  if (!zipStat.isFile() || zipStat.size <= 0) {
    throw new Error(`Signed Windows USB ZIP is missing or empty: ${zipPath}`);
  }

  const currentMetadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  assertMetadataShape(currentMetadata, version, fileName);
  const digest = await sha512Hex(zipPath);
  const nextMetadata = {
    ...currentMetadata,
    size: zipStat.size,
    sha512: digest,
  };
  await replaceFileAtomically(metadataPath, `${JSON.stringify(nextMetadata, null, 2)}\n`);

  const verified = JSON.parse(await readFile(metadataPath, 'utf8'));
  assertMetadataShape(verified, version, fileName);
  if (Number(verified.size) !== zipStat.size || String(verified.sha512).toLowerCase() !== digest) {
    throw new Error(`Windows USB metadata verification failed: ${metadataPath}`);
  }
  return {
    status: 'passed',
    version,
    fileName,
    size: zipStat.size,
    sha512: digest,
    metadataPath,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  refreshSignedWindowsUsbMetadata(parseArgs(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(
        `[refresh-signed-windows-usb-metadata] ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    });
}
