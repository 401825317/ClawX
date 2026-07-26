#!/usr/bin/env node

/**
 * Rebuild NSIS block maps and synchronize latest*.yml after the final EXE has
 * been signed. Signing changes the installer bytes, so the original builder
 * metadata is no longer authoritative.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, readFileSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_RELEASE_DIR = path.join(ROOT, 'release');

function readProductName() {
  const text = readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  const match = text.match(/^productName:\s*([^\r\n#]+?)\s*$/mu);
  return match?.[1]?.trim() || 'UClaw';
}

function parseArgs(argv) {
  const options = { releaseDir: DEFAULT_RELEASE_DIR, exe: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inlineValue] = arg.split('=', 2);
    const readValue = () => inlineValue ?? argv[++index] ?? '';
    if (name === '--release-dir') options.releaseDir = path.resolve(readValue());
    else if (name === '--exe') options.exe = path.resolve(readValue());
    else if (name === '--help' || name === '-h') {
      console.log('Usage: node scripts/windows-support/refresh-nsis-release-metadata.mjs [--release-dir <dir>] [--exe <installer.exe>]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  return result;
}

async function sha512(filePath, encoding = 'base64') {
  const hash = createHash('sha512');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
  });
  return hash.digest(encoding);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function resolveAppBuilderBinary() {
  return path.join(ROOT, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe');
}

async function resolveInstallers(options, productName) {
  if (options.exe) return [options.exe];
  const productPattern = escapeRegExp(productName);
  const entries = await readdir(options.releaseDir, { withFileTypes: true });
  const pattern = new RegExp(`^${productPattern}-.+-win-(?:x64|arm64|ia32)\\.exe$`, 'u');
  const files = entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name) && !entry.name.includes('-portable'))
    .map((entry) => path.join(options.releaseDir, entry.name));
  if (files.length === 0) throw new Error(`No NSIS installer EXE found in ${options.releaseDir}.`);
  return files;
}

async function rebuildBlockmap(exePath) {
  const appBuilder = resolveAppBuilderBinary();
  const blockmapPath = `${exePath}.blockmap`;
  const result = runSync(appBuilder, ['blockmap', '--input', exePath, '--output', blockmapPath]);
  if (result.status !== 0) {
    throw new Error(`Failed to rebuild ${path.basename(blockmapPath)}: ${result.stderr || result.stdout || 'unknown error'}`);
  }
  const blockmapStat = await stat(blockmapPath);
  if (blockmapStat.size <= 0) throw new Error(`Generated empty block map: ${blockmapPath}`);
  return { blockmapPath, size: blockmapStat.size, sha512: await sha512(blockmapPath, 'hex') };
}

function patchMetadataForFile(content, fileName, sha512Value, size) {
  const escapedName = escapeRegExp(fileName);
  let modified = false;
  const filesPattern = new RegExp(
    `(url:\\s*${escapedName}\\s*\\r?\\n\\s*sha512:\\s*)\\S+(\\s*\\r?\\n\\s*size:\\s*)\\d+`,
    'gu',
  );
  content = content.replace(filesPattern, (_match, prefix, sizePrefix) => {
    modified = true;
    return `${prefix}${sha512Value}${sizePrefix}${size}`;
  });
  const topLevelPattern = new RegExp(
    `(path:\\s*${escapedName}\\s*\\r?\\n\\s*sha512:\\s*)\\S+`,
    'gu',
  );
  content = content.replace(topLevelPattern, (_match, prefix) => {
    modified = true;
    return `${prefix}${sha512Value}`;
  });
  return { content, modified };
}

async function refreshYamlFiles(releaseDir, files) {
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const yamlFiles = entries
    .filter((entry) => entry.isFile() && /^latest.*\.yml$/iu.test(entry.name))
    .map((entry) => path.join(releaseDir, entry.name));
  if (yamlFiles.length === 0) throw new Error(`No latest*.yml found in ${releaseDir}.`);
  let totalMatches = 0;
  for (const yamlPath of yamlFiles) {
    let content = await readFile(yamlPath, 'utf8');
    let modified = false;
    for (const file of files) {
      const installerName = path.basename(file.installerPath);
      const installerPatch = patchMetadataForFile(content, installerName, file.sha512, file.size);
      content = installerPatch.content;
      if (installerPatch.modified) {
        modified = true;
        totalMatches += 1;
      }
      const blockmapName = path.basename(file.blockmapPath);
      const blockmapPatch = patchMetadataForFile(content, blockmapName, file.blockmapSha512, file.blockmapSize);
      content = blockmapPatch.content;
      if (blockmapPatch.modified) modified = true;
    }
    if (modified) {
      await writeFile(yamlPath, content, 'utf8');
      console.log(`[nsis-metadata] Updated ${path.basename(yamlPath)}`);
    }
  }
  if (totalMatches === 0) throw new Error('latest*.yml did not contain an entry for any final NSIS installer.');
  return yamlFiles.map((file) => path.basename(file));
}

async function main() {
  if (process.platform !== 'win32') throw new Error('NSIS metadata refresh must run on Windows.');
  const options = parseArgs(process.argv.slice(2));
  const productName = readProductName();
  const installerPaths = await resolveInstallers(options, productName);
  const files = [];
  for (const installerPath of installerPaths) {
    const installerStat = await stat(installerPath);
    const blockmap = await rebuildBlockmap(installerPath);
    const installerSha512 = await sha512(installerPath);
    files.push({
      installerPath,
      size: installerStat.size,
      sha512: installerSha512,
      blockmapPath: blockmap.blockmapPath,
      blockmapSize: blockmap.size,
      blockmapSha512: await sha512(blockmap.blockmapPath),
    });
    console.log(`[nsis-metadata] Rebuilt ${path.basename(blockmap.blockmapPath)} (${blockmap.size} bytes)`);
  }
  const yamlFiles = await refreshYamlFiles(options.releaseDir, files);
  console.log(`[nsis-metadata] PASS: installers=${files.length}, metadata=${yamlFiles.join(', ')}`);
}

main().catch((error) => {
  console.error(`[nsis-metadata] FAIL: ${error instanceof Error ? error.stack || error.message : error}`);
  process.exit(1);
});
