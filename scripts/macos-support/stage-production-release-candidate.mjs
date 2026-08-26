#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  assertFormalVersion,
  assertGitCommit,
  writeJsonAtomic,
} from '../windows-support/portable-release-utils.mjs';

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
    throw new Error(`macOS release artifact is missing or empty: ${path.basename(filePath)}`);
  }
  const hash = createHash('sha512');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return {
    size: details.size,
    sha512: hash.digest('base64'),
  };
}

function requireUniqueFeedEntry(feed, fileName) {
  const matches = feed.files.filter((entry) => entry?.url === fileName);
  if (matches.length === 0) {
    throw new Error(`latest-mac.yml is missing ${fileName}.`);
  }
  const [first] = matches;
  if (matches.some((entry) => entry.sha512 !== first.sha512 || Number(entry.size) !== Number(first.size))) {
    throw new Error(`latest-mac.yml contains conflicting ${fileName} entries.`);
  }
  return first;
}

export async function stageMacosProductionReleaseCandidate(options) {
  assertFormalVersion(options.version);
  assertGitCommit(options.commit);
  const releaseDir = path.resolve(options.releaseDir);
  const outputDir = path.resolve(options.output);
  const feedPath = path.join(releaseDir, 'latest-mac.yml');
  const feed = YAML.parse(await readFile(feedPath, 'utf8'));
  if (String(feed?.version ?? '') !== options.version || !Array.isArray(feed?.files)) {
    throw new Error('latest-mac.yml does not match the requested stable version.');
  }
  const normalizedEntries = [];
  const entriesByUrl = new Map();
  for (const entry of feed.files) {
    if (!entry?.url) throw new Error('latest-mac.yml contains an artifact without a URL.');
    const existing = entriesByUrl.get(entry.url);
    if (existing && (existing.sha512 !== entry.sha512 || Number(existing.size) !== Number(entry.size))) {
      throw new Error(`latest-mac.yml contains conflicting ${entry.url} entries.`);
    }
    if (!existing) {
      entriesByUrl.set(entry.url, entry);
      normalizedEntries.push(entry);
    }
  }
  feed.files = normalizedEntries;

  const artifacts = [];
  for (const arch of ARCHITECTURES) {
    const updateFileName = `UClaw-${options.version}-mac-${arch}.zip`;
    const updateBlockmapFileName = `${updateFileName}.blockmap`;
    const downloadFileName = `UClaw-${options.version}-mac-${arch}.dmg`;
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
    const update = await inspectFile(path.join(releaseDir, updateFileName));
    const updateBlockmap = await inspectFile(path.join(releaseDir, updateBlockmapFileName));
    const download = await inspectFile(path.join(releaseDir, downloadFileName));
    const feedEntry = requireUniqueFeedEntry(feed, updateFileName);
    if (Number(feedEntry.size) !== update.size || String(feedEntry.sha512 ?? '') !== update.sha512) {
      throw new Error(`latest-mac.yml integrity does not match ${updateFileName}.`);
    }
    artifacts.push({
      platform: 'mac',
      arch,
      packageType: 'installer',
      buildId: identity.buildId,
      updateFileName,
      updateSize: update.size,
      updateSha512: update.sha512,
      updateBlockmapFileName,
      updateBlockmapSize: updateBlockmap.size,
      updateBlockmapSha512: updateBlockmap.sha512,
      downloadFileName,
      downloadSize: download.size,
      downloadSha512: download.sha512,
    });
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  for (const artifact of artifacts) {
    await cp(path.join(releaseDir, artifact.updateFileName), path.join(outputDir, artifact.updateFileName));
    await cp(
      path.join(releaseDir, artifact.updateBlockmapFileName),
      path.join(outputDir, artifact.updateBlockmapFileName),
    );
    await cp(path.join(releaseDir, artifact.downloadFileName), path.join(outputDir, artifact.downloadFileName));
  }
  await writeFile(path.join(outputDir, 'latest-mac.yml'), YAML.stringify(feed), 'utf8');

  const candidate = {
    schemaVersion: 1,
    stagedAt: new Date().toISOString(),
    version: options.version,
    commit: options.commit,
    releaseDate: String(feed.releaseDate ?? new Date().toISOString()),
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
    console.log(`[macos-production-candidate] ${artifact.arch}: ${artifact.updateFileName}`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[macos-production-candidate] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
