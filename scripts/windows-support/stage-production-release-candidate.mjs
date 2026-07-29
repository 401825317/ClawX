#!/usr/bin/env node

import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFormalVersion,
  assertGitCommit,
  comparePackageIdentity,
  inspectPortableArtifact,
  readJson,
  writeJsonAtomic,
} from './portable-release-utils.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..', '..');

function parseArgs(argv) {
  const options = {
    releaseDir: path.join(ROOT, 'release'),
    source: path.join(ROOT, 'test-results', 'results.json'),
    output: path.join(ROOT, 'release', 'production-candidate'),
    version: '',
    commit: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inlineValue] = argv[index].split('=', 2);
    const readValue = () => inlineValue ?? argv[++index] ?? '';
    switch (name) {
      case '--release-dir': options.releaseDir = readValue(); break;
      case '--source': options.source = readValue(); break;
      case '--output': options.output = readValue(); break;
      case '--version': options.version = readValue(); break;
      case '--commit': options.commit = readValue(); break;
      case '--help':
      case '-h':
        console.log('Usage: node stage-production-release-candidate.mjs --version X.Y.Z --commit SHA [--release-dir dir] [--source results.json] [--output dir]');
        process.exit(0);
        break;
      default: throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  assertFormalVersion(options.version);
  assertGitCommit(options.commit);
  return options;
}

async function walkFiles(root) {
  const files = [];
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  await visit(root);
  return files;
}

function countSourceTests(source) {
  const stack = [...(source?.suites ?? [])];
  let testCount = 0;
  while (stack.length > 0) {
    const suite = stack.pop();
    stack.push(...(suite?.suites ?? []));
    for (const spec of suite?.specs ?? []) {
      for (const test of spec.tests ?? []) {
        testCount += 1;
      }
    }
  }
  return testCount;
}

export async function stageProductionReleaseCandidate(options) {
  const releaseDir = path.resolve(options.releaseDir);
  const outputDir = path.resolve(options.output);
  const zipName = `UClaw-${options.version}-win-x64-usb.zip`;
  const artifact = await inspectPortableArtifact({
    zipPath: path.join(releaseDir, zipName),
    expectedVersion: options.version,
    expectedCommit: options.commit,
  });
  if (!artifact.metadataMatches) {
    throw new Error('Portable JSON does not match the final ZIP. Refresh metadata after signing first.');
  }

  const source = await readJson(options.source);
  const sourceTestCount = countSourceTests(source);
  if (sourceTestCount === 0) throw new Error('Source E2E results contain no executed tests.');

  const regressionDir = path.join(releaseDir, 'regression');
  const summaryPaths = (await walkFiles(regressionDir)).filter((filePath) => path.basename(filePath) === 'summary.json');
  const matching = [];
  for (const summaryPath of summaryPaths) {
    const summary = await readJson(summaryPath);
    if (summary.profile !== 'full' || summary.status !== 'passed') continue;
    const mismatches = comparePackageIdentity(artifact.identity, summary.package, 'full');
    if (mismatches.length === 0) matching.push({ summaryPath, summary });
  }
  matching.sort((left, right) => String(right.summary.finishedAt).localeCompare(String(left.summary.finishedAt)));
  if (matching.length === 0) {
    throw new Error('No passing Full regression matches the final portable ZIP identity.');
  }

  const selected = matching[0];
  const fullReportPath = path.join(path.dirname(selected.summaryPath), 'UClaw-complete-regression-report.zh-CN.md');
  const capabilityResultsPath = path.join(path.dirname(selected.summaryPath), 'capability-results.json');

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await cp(artifact.zipPath, path.join(outputDir, zipName));
  await cp(artifact.metadataPath, path.join(outputDir, zipName.replace(/\.zip$/u, '.json')));
  await cp(path.resolve(options.source), path.join(outputDir, 'source-results.json'));
  await cp(selected.summaryPath, path.join(outputDir, 'full-summary.json'));
  await cp(fullReportPath, path.join(outputDir, 'full-report.zh-CN.md'));
  await cp(capabilityResultsPath, path.join(outputDir, 'full-capability-results.json'));

  const candidate = {
    schemaVersion: 1,
    stagedAt: new Date().toISOString(),
    version: options.version,
    commit: options.commit,
    buildId: artifact.identity.buildId,
    zipFileName: artifact.identity.zipFileName,
    metadataFileName: path.basename(artifact.metadataPath),
    size: artifact.identity.zipSize,
    sha512: artifact.identity.sha512,
    fullRunId: selected.summary.runId,
    fullFinishedAt: selected.summary.finishedAt,
    sourceTestCount,
    sourceResults: 'source-results.json',
    fullSummary: 'full-summary.json',
  };
  await writeJsonAtomic(path.join(outputDir, 'candidate.json'), candidate);
  return { outputDir, candidate };
}

async function main() {
  const result = await stageProductionReleaseCandidate(parseArgs(process.argv.slice(2)));
  console.log(`[production-candidate] Directory: ${result.outputDir}`);
  console.log(`[production-candidate] Version: ${result.candidate.version}`);
  console.log(`[production-candidate] Commit: ${result.candidate.commit}`);
  console.log(`[production-candidate] Build ID: ${result.candidate.buildId}`);
  console.log(`[production-candidate] Size: ${result.candidate.size}`);
  console.log(`[production-candidate] SHA-512: ${result.candidate.sha512}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[production-candidate] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
