#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
    version: '',
    commit: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inlineValue] = argv[index].split('=', 2);
    const readValue = () => inlineValue ?? argv[++index] ?? '';
    switch (name) {
      case '--release-dir': options.releaseDir = readValue(); break;
      case '--version': options.version = readValue(); break;
      case '--commit': options.commit = readValue(); break;
      default: throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return options;
}

async function sha512Hex(filePath) {
  const hash = createHash('sha512');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function resolveIdentity(options, appPath, arch) {
  const identityPath = path.join(appPath, 'Contents', 'Resources', 'uclaw-build.json');
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  const version = options.version || String(identity.appVersion ?? '');
  const commit = options.commit || String(identity.gitCommit ?? '');
  assertFormalVersion(version);
  assertGitCommit(commit);
  if (identity.appVersion !== version || identity.gitCommit !== commit
    || identity.sourceTreeState !== 'clean' || identity.platform !== 'darwin'
    || identity.arch !== arch || !String(identity.buildId ?? '').trim()) {
    throw new Error(`macOS ${arch} packaged build identity does not match the USB release.`);
  }
  return { identity, version, commit };
}

function assertPortableEntries(entries, arch) {
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
  if (entries.some((entry) => /^[^/]+\/portable\.flag$/u.test(entry))) {
    throw new Error(`macOS ${arch} USB ZIP has an unexpected enclosing directory.`);
  }
}

export async function buildMacosUsbRelease(options = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS USB ZIPs must be built on macOS.');
  const releaseDir = path.resolve(options.releaseDir || path.join(ROOT, 'release'));
  const artifacts = [];
  for (const arch of ARCHITECTURES) {
    const appDirectory = arch === 'x64' ? 'mac' : 'mac-arm64';
    const appPath = path.join(releaseDir, appDirectory, 'UClaw.app');
    const { identity, version, commit } = await resolveIdentity(options, appPath, arch);
    const helperPath = path.join(
      appPath,
      'Contents',
      'Resources',
      'resources',
      'updater',
      `darwin-${arch}`,
      'uclaw-portable-updater',
    );
    const helper = await stat(helperPath);
    if (!helper.isFile() || helper.size <= 0) throw new Error(`macOS ${arch} portable updater is missing.`);

    const stagingDir = path.join(releaseDir, `mac-usb-${arch}`);
    const zipName = `UClaw-${version}-mac-${arch}-usb.zip`;
    const metadataName = zipName.replace(/\.zip$/u, '.json');
    const zipPath = path.join(releaseDir, zipName);
    await rm(stagingDir, { recursive: true, force: true });
    await rm(zipPath, { force: true });
    await mkdir(path.join(stagingDir, 'UClawData', 'updates'), { recursive: true });
    await writeFile(path.join(stagingDir, 'portable.flag'), 'UClaw USB portable mode\n', 'utf8');
    await execFileAsync('/usr/bin/ditto', [appPath, path.join(stagingDir, 'UClaw.app')]);
    await execFileAsync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '.', zipPath], {
      cwd: stagingDir,
      maxBuffer: 16 * 1024 * 1024,
    });
    const { stdout } = await execFileAsync('/usr/bin/unzip', ['-Z1', zipPath], {
      maxBuffer: 64 * 1024 * 1024,
    });
    assertPortableEntries(stdout.split(/\r?\n/u).filter(Boolean), arch);
    const zip = await stat(zipPath);
    const sha512 = await sha512Hex(zipPath);
    const metadata = {
      schemaVersion: 1,
      package_type: 'portable_zip',
      platform: 'mac',
      arch,
      version,
      gitCommit: commit,
      buildId: identity.buildId,
      file_name: zipName,
      size: zip.size,
      sha512,
      releaseDate: new Date().toISOString(),
    };
    await writeJsonAtomic(path.join(releaseDir, metadataName), metadata);
    artifacts.push({ ...metadata, zipPath, metadataName });
  }
  return artifacts;
}

async function main() {
  const artifacts = await buildMacosUsbRelease(parseArgs(process.argv.slice(2)));
  for (const artifact of artifacts) {
    console.log(`[macos-usb] ${artifact.arch}: ${artifact.zipPath}`);
    console.log(`[macos-usb] SHA-512: ${artifact.sha512}`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[macos-usb] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
