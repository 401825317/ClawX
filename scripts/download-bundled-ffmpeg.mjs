#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_ROOT = path.join(ROOT, 'resources', 'bin');
const VERSION = '7.1.4-3';
const RELEASE_TAG = `v${VERSION}`;
const REPOSITORY = 'jellyfin/jellyfin-ffmpeg';
const BASE_URL = `https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}`;
const SOURCE_URL = `https://github.com/${REPOSITORY}/tree/${RELEASE_TAG}`;
const SOURCE_ARCHIVE_URL = `https://api.github.com/repos/${REPOSITORY}/tarball/${RELEASE_TAG}`;
const MANIFEST_NAME = 'ffmpeg-runtime.json';
const LICENSE_ASSETS = {
  'ffmpeg-COPYING.GPLv3': ['COPYING.GPLv3', '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'],
  'ffmpeg-LICENSE.md': ['LICENSE.md', 'cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2'],
};

const TARGETS = {
  'darwin-arm64': ['jellyfin-ffmpeg_7.1.4-3_portable_macarm64-gpl.tar.xz', '99d689816a41075574928a0b3059101fd454fc58f465c99105a73b5c415ac86d'],
  'darwin-x64': ['jellyfin-ffmpeg_7.1.4-3_portable_mac64-gpl.tar.xz', '943f78e94d2760d3925fc0d9cc15f8329b11dbcdae7b0fd0d225b64e5a1aae29'],
  'win32-arm64': ['jellyfin-ffmpeg_7.1.4-3_portable_winarm64-clang-gpl.zip', 'fcab60b6892ffa10c09a87570e53b88d8eda2344d58bf32e89ee8b2c2ababbf1'],
  'win32-x64': ['jellyfin-ffmpeg_7.1.4-3_portable_win64-clang-gpl.zip', '113adeb702683c38be40a65d859f8ef7ffb07bae9df16dfb6c3df5ac3d95ef3c'],
  'linux-arm64': ['jellyfin-ffmpeg_7.1.4-3_portable_linuxarm64-gpl.tar.xz', '77e4b5d044ab73e1f26c9aadaa5d6014d1782500bf2c29afb3ab81f5bea98b1f'],
  'linux-x64': ['jellyfin-ffmpeg_7.1.4-3_portable_linux64-gpl.tar.xz', 'cab9ff40a47e4232d231e4eb7e4e85fabfeec56c6905266bc94291fc0881f83f'],
};

const PLATFORM_TARGETS = {
  mac: ['darwin-x64', 'darwin-arm64'],
  win: ['win32-x64', 'win32-arm64'],
  linux: ['linux-x64', 'linux-arm64'],
};

function readArg(name) {
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function binaryName(tool, target) {
  return target.startsWith('win32-') ? `${tool}.exe` : tool;
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

/** Download through a temporary file so body failures are retried without corrupting the target. */
export async function download(url, outputPath, attempts = 3) {
  let lastError;
  const partialPath = `${outputPath}.partial`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30 * 60_000);
    try {
      await rm(partialPath, { force: true });
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      if (!response.body) throw new Error('HTTP response has no body');
      await pipeline(response.body, createWriteStream(partialPath));
      await rm(outputPath, { force: true });
      await rename(partialPath, outputPath);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    } finally {
      clearTimeout(timer);
    }
  }
  await rm(partialPath, { force: true });
  throw lastError;
}

function assertBinaryArchitecture(buffer, target, filePath) {
  if (target.startsWith('win32-')) {
    if (buffer.readUInt16LE(0) !== 0x5a4d) throw new Error(`${filePath}: missing PE MZ header`);
    const peOffset = buffer.readUInt32LE(0x3c);
    const expectedMachine = target.endsWith('-arm64') ? 0xaa64 : 0x8664;
    if (buffer.readUInt32LE(peOffset) !== 0x00004550 || buffer.readUInt16LE(peOffset + 4) !== expectedMachine) {
      throw new Error(`${filePath}: unexpected Windows executable architecture`);
    }
    return;
  }
  if (target.startsWith('linux-')) {
    if (!buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error(`${filePath}: missing ELF header`);
    const expectedMachine = target.endsWith('-arm64') ? 0xb7 : 0x3e;
    if (buffer.readUInt16LE(18) !== expectedMachine) throw new Error(`${filePath}: unexpected ELF architecture`);
    return;
  }
  const magic = buffer.readUInt32BE(0);
  const littleEndian = magic === 0xcffaedfe || magic === 0xcefaedfe;
  const cpuType = littleEndian ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4);
  const expectedCpu = target.endsWith('-arm64') ? 0x0100000c : 0x01000007;
  if (cpuType !== expectedCpu) throw new Error(`${filePath}: expected Mach-O ${target}`);
}

async function findFile(root, expectedName) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === expectedName.toLowerCase()) return candidate;
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, expectedName);
      if (nested) return nested;
    }
  }
  return undefined;
}

function extractArchive(archivePath, extractDir) {
  const args = archivePath.endsWith('.zip')
    ? (process.platform === 'win32'
      ? ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extractDir.replaceAll("'", "''")}' -Force`]
      : ['-q', '-o', archivePath, '-d', extractDir])
    : ['-xJf', archivePath, '-C', extractDir];
  const executable = archivePath.endsWith('.zip') && process.platform === 'win32'
    ? 'powershell.exe'
    : archivePath.endsWith('.zip') ? 'unzip' : 'tar';
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `${executable} failed with exit code ${result.status}`);
}

async function installLicenseAssets(targetDir) {
  for (const [outputName, [sourceName, expectedSha]] of Object.entries(LICENSE_ASSETS)) {
    const outputPath = path.join(targetDir, outputName);
    await download(`https://raw.githubusercontent.com/${REPOSITORY}/${RELEASE_TAG}/${sourceName}`, outputPath);
    const digest = await sha256(outputPath);
    if (digest !== expectedSha) throw new Error(`${sourceName}: expected ${expectedSha}, received ${digest}`);
  }
  await writeFile(path.join(targetDir, 'ffmpeg-THIRD-PARTY-NOTICE.txt'), [
    `Jellyfin FFmpeg ${VERSION}`,
    '',
    'UClaw invokes the unmodified Jellyfin FFmpeg portable executables as separate processes.',
    'This bundled build is distributed under GNU GPL v3 or later and includes libx264.',
    `Project and exact source: ${SOURCE_URL}`,
    `Source archive: ${SOURCE_ARCHIVE_URL}`,
    '',
    'See ffmpeg-COPYING.GPLv3 and ffmpeg-LICENSE.md in this directory.',
  ].join('\n'), 'utf8');
}

async function verifyTarget(target) {
  if (!TARGETS[target]) throw new Error(`Unsupported FFmpeg target: ${target}`);
  const targetDir = path.join(OUTPUT_ROOT, target);
  const manifestPath = path.join(targetDir, MANIFEST_NAME);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== VERSION || manifest.target !== target || manifest.license !== 'GPL-3.0-or-later') {
    throw new Error(`${manifestPath}: expected Jellyfin FFmpeg ${VERSION} GPL runtime for ${target}`);
  }
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const filePath = path.join(targetDir, binaryName(tool, target));
    const fileStat = await stat(filePath);
    const digest = await sha256(filePath);
    if (!fileStat.isFile() || fileStat.size <= 0
      || manifest.binaries?.[tool]?.sha256 !== digest
      || manifest.binaries?.[tool]?.size !== fileStat.size) {
      throw new Error(`${filePath}: binary checksum or size does not match ${MANIFEST_NAME}`);
    }
    assertBinaryArchitecture(await readFile(filePath), target, filePath);
  }
  for (const name of [...Object.keys(LICENSE_ASSETS), 'ffmpeg-THIRD-PARTY-NOTICE.txt']) await stat(path.join(targetDir, name));
  console.log(`[ffmpeg] verified ${target} (${VERSION}, GPL)`);
}

async function installTarget(target, force) {
  const release = TARGETS[target];
  if (!release) throw new Error(`Unsupported FFmpeg target: ${target}`);
  const [asset, expectedSha] = release;
  const targetDir = path.join(OUTPUT_ROOT, target);
  const workDir = path.join(OUTPUT_ROOT, `.ffmpeg-${target}-${process.pid}`);
  const archivePath = path.join(workDir, asset);
  const extractDir = path.join(workDir, 'extract');
  if (!force) {
    try {
      await verifyTarget(target);
      return;
    } catch {
      // Install or repair below.
    }
  }
  console.log(`[ffmpeg] installing Jellyfin FFmpeg ${VERSION} for ${target}`);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  try {
    await download(`${BASE_URL}/${asset}`, archivePath);
    const archiveSha = await sha256(archivePath);
    if (archiveSha !== expectedSha) throw new Error(`${asset}: expected ${expectedSha}, received ${archiveSha}`);
    extractArchive(archivePath, extractDir);
    await mkdir(targetDir, { recursive: true });
    const binaries = {};
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const outputName = binaryName(tool, target);
      const sourcePath = await findFile(extractDir, outputName);
      if (!sourcePath) throw new Error(`${asset}: ${outputName} was not found after extraction`);
      const outputPath = path.join(targetDir, outputName);
      await rm(outputPath, { force: true });
      await rename(sourcePath, outputPath);
      if (!target.startsWith('win32-')) await chmod(outputPath, 0o755);
      const fileStat = await stat(outputPath);
      binaries[tool] = { file: outputName, size: fileStat.size, sha256: await sha256(outputPath) };
    }
    await installLicenseAssets(targetDir);
    await writeFile(path.join(targetDir, MANIFEST_NAME), `${JSON.stringify({
      version: VERSION,
      releaseTag: RELEASE_TAG,
      target,
      asset,
      assetSha256: expectedSha,
      source: SOURCE_URL,
      sourceArchive: SOURCE_ARCHIVE_URL,
      license: 'GPL-3.0-or-later',
      binaries,
    }, null, 2)}\n`, 'utf8');
    await verifyTarget(target);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function selectedTargets() {
  const explicitTarget = readArg('--target');
  if (explicitTarget) return [explicitTarget === 'current' ? `${os.platform()}-${os.arch()}` : explicitTarget];
  const platform = readArg('--platform');
  if (platform) {
    const targets = PLATFORM_TARGETS[platform];
    if (!targets) throw new Error(`Unknown platform group: ${platform}`);
    return targets;
  }
  if (process.argv.includes('--all')) return Object.keys(TARGETS);
  return [`${os.platform()}-${os.arch()}`];
}

/** Run the requested FFmpeg installation or verification targets. */
async function main() {
  const verifyOnly = process.argv.includes('--verify');
  const force = process.argv.includes('--force');
  for (const target of selectedTargets()) {
    if (verifyOnly) await verifyTarget(target);
    else await installTarget(target, force);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
