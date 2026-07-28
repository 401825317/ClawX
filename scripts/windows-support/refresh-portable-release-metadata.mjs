#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectPortableArtifact,
  writeJsonAtomic,
} from './portable-release-utils.mjs';

function parseArgs(argv) {
  const options = { zip: '', version: '', commit: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inlineValue] = argv[index].split('=', 2);
    const readValue = () => inlineValue ?? argv[++index] ?? '';
    switch (name) {
      case '--zip': options.zip = readValue(); break;
      case '--version': options.version = readValue(); break;
      case '--commit': options.commit = readValue(); break;
      case '--help':
      case '-h':
        console.log('Usage: node refresh-portable-release-metadata.mjs --zip <usb.zip> [--version X.Y.Z] [--commit SHA]');
        process.exit(0);
        break;
      default: throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (!options.zip) throw new Error('--zip is required.');
  return options;
}

export async function refreshPortableReleaseMetadata(options) {
  const artifact = await inspectPortableArtifact({
    zipPath: options.zip,
    expectedVersion: options.version,
    expectedCommit: options.commit,
  });
  const metadata = {
    ...artifact.metadata,
    size: artifact.identity.zipSize,
    sha512: artifact.identity.sha512,
  };
  await writeJsonAtomic(artifact.metadataPath, metadata);
  const verified = await inspectPortableArtifact({
    zipPath: artifact.zipPath,
    metadataPath: artifact.metadataPath,
    expectedVersion: options.version,
    expectedCommit: options.commit,
  });
  if (!verified.metadataMatches) {
    throw new Error('Portable metadata did not match the final ZIP after refresh.');
  }
  return verified;
}

async function main() {
  const result = await refreshPortableReleaseMetadata(parseArgs(process.argv.slice(2)));
  console.log(`[portable-metadata] ZIP: ${result.zipPath}`);
  console.log(`[portable-metadata] JSON: ${result.metadataPath}`);
  console.log(`[portable-metadata] Size: ${result.identity.zipSize}`);
  console.log(`[portable-metadata] SHA-512: ${result.identity.sha512}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[portable-metadata] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
