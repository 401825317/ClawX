#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  assertFormalVersion,
  assertGitCommit,
  writeJsonAtomic,
} from '../windows-support/portable-release-utils.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const ARCHITECTURES = ['x64', 'arm64'];

function parseArgs(argv) {
  const options = {
    releaseDir: path.join(ROOT, 'release'),
    output: path.join(ROOT, 'release', 'macos-production-candidate'),
    version: '',
    commit: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inlineValue] = argv[index].split('=', 2);
    const readValue = () => inlineValue ?? argv[++index] ?? '';
    switch (name) {
      case '--release-dir': options.releaseDir = readValue(); break;
      case '--output': options.output = readValue(); break;
      case '--version': options.version = readValue(); break;
      case '--commit': options.commit = readValue(); break;
      case '--help':
      case '-h':
        console.log('Usage: node stage-production-release-candidate.mjs --version X.Y.Z --commit SHA [--release-dir dir] [--output dir]');
        process.exit(0);
        break;
      default: throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  assertFormalVersion(options.version);
  assertGitCommit(options.commit);
  return options;
}

async function inspectFile(filePath) {
  const details = await stat(filePath);
  if (!details.isFile() || details.size <= 0) {
    throw new Error(`macOS USB artifact is missing or empty: ${path.basename(filePath)}`);
  }
  const hash = createHash('sha512');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { size: details.size, sha512: hash.digest('hex') };
}

async function defaultListArchiveEntries(filePath) {
  const { stdout } = await execFileAsync('/usr/bin/unzip', ['-Z1', filePath], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split(/\r?\n/u).filter(Boolean);
}

function assertPortableArchiveEntries(entries, arch) {
  const required = [
    'portable.flag',
    'UClawData/',
    'UClawData/updates/',
    'UClaw.app/Contents/Resources/uclaw-build.json',
    'UClaw.app/Contents/Resources/openclaw-plugins/clawx-openai-image/index.mjs',
    'UClaw.app/Contents/Resources/openclaw-plugins/clawx-openai-image/node_modules/undici/package.json',
    `UClaw.app/Contents/Resources/resources/updater/darwin-${arch}/uclaw-portable-updater`,
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) throw new Error(`macOS ${arch} USB ZIP is missing ${entry}.`);
  }
}

export async function stageMacosProductionReleaseCandidate(options) {
  assertFormalVersion(options.version);
  assertGitCommit(options.commit);
  const releaseDir = path.resolve(options.releaseDir);
  const outputDir = path.resolve(options.output);
  const listArchiveEntries = options.listArchiveEntries ?? defaultListArchiveEntries;
  const artifacts = [];
  let releaseDate = '';

  for (const arch of ARCHITECTURES) {
    const fileName = `UClaw-${options.version}-mac-${arch}-usb.zip`;
    const metadataFileName = fileName.replace(/\.zip$/u, '.json');
    const filePath = path.join(releaseDir, fileName);
    const metadataPath = path.join(releaseDir, metadataFileName);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const appDirectory = arch === 'x64' ? 'mac' : 'mac-arm64';
    const identityPath = path.join(
      releaseDir,
      appDirectory,
      'UClaw.app',
      'Contents',
      'Resources',
      'uclaw-build.json',
    );
    const identity = JSON.parse(await readFile(identityPath, 'utf8'));
    if (identity.appVersion !== options.version || identity.gitCommit !== options.commit
      || identity.sourceTreeState !== 'clean' || identity.platform !== 'darwin'
      || identity.arch !== arch || !String(identity.buildId ?? '').trim()) {
      throw new Error(`macOS ${arch} packaged build identity does not match the locked release.`);
    }
    if (metadata.package_type !== 'portable_zip' || metadata.platform !== 'mac'
      || metadata.arch !== arch || metadata.version !== options.version
      || metadata.gitCommit !== options.commit || metadata.buildId !== identity.buildId
      || metadata.file_name !== fileName) {
      throw new Error(`macOS ${arch} USB metadata does not match the locked release.`);
    }
    const file = await inspectFile(filePath);
    if (Number(metadata.size) !== file.size || String(metadata.sha512 ?? '') !== file.sha512) {
      throw new Error(`macOS ${arch} USB ZIP integrity mismatch.`);
    }
    assertPortableArchiveEntries(await listArchiveEntries(filePath), arch);
    releaseDate = releaseDate || String(metadata.releaseDate ?? '');
    artifacts.push({
      platform: 'mac',
      arch,
      packageType: 'portable_zip',
      buildId: identity.buildId,
      fileName,
      size: file.size,
      sha512: file.sha512,
      metadataFileName,
    });
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  for (const artifact of artifacts) {
    await cp(path.join(releaseDir, artifact.fileName), path.join(outputDir, artifact.fileName));
    await cp(
      path.join(releaseDir, artifact.metadataFileName),
      path.join(outputDir, artifact.metadataFileName),
    );
  }
  const candidate = {
    schemaVersion: 2,
    stagedAt: new Date().toISOString(),
    version: options.version,
    commit: options.commit,
    releaseDate: releaseDate || new Date().toISOString(),
    artifacts,
  };
  await writeJsonAtomic(path.join(outputDir, 'candidate.json'), candidate);
  return { outputDir, candidate };
}

async function main() {
  const result = await stageMacosProductionReleaseCandidate(parseArgs(process.argv.slice(2)));
  console.log(`[macos-production-candidate] Directory: ${result.outputDir}`);
  console.log(`[macos-production-candidate] Version: ${result.candidate.version}`);
  console.log(`[macos-production-candidate] Commit: ${result.candidate.commit}`);
  for (const artifact of result.candidate.artifacts) {
    console.log(`[macos-production-candidate] ${artifact.arch}: ${artifact.fileName}`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[macos-production-candidate] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
