#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

function parseArgs(argv) {
  const options = { zip: '', replacements: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--zip') options.zip = argv[++index] ?? '';
    else if (name === '--replace') options.replacements.push(argv[++index] ?? '');
    else throw new Error(`Unknown argument: ${name}`);
  }
  if (!options.zip || options.replacements.length === 0) {
    throw new Error('Usage: node repack-portable-release.mjs --zip <archive.zip> --replace <archive-path=local-path> [...]');
  }
  const replacements = new Map();
  for (const value of options.replacements) {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) throw new Error(`Invalid --replace value: ${value}`);
    const archivePath = value.slice(0, separator).replaceAll('\\', '/');
    if (archivePath.startsWith('/') || archivePath.includes('../') || replacements.has(archivePath)) {
      throw new Error(`Unsafe or duplicate archive replacement path: ${archivePath}`);
    }
    replacements.set(archivePath, value.slice(separator + 1));
  }
  return { zip: path.resolve(options.zip), replacements };
}

export async function repackPortableRelease({ zip, replacements }) {
  const source = await JSZip.loadAsync(await readFile(zip), { createFolders: true });
  const output = new JSZip();
  const replaced = new Set();
  for (const [name, entry] of Object.entries(source.files)) {
    const options = {
      date: entry.date,
      dir: entry.dir,
      unixPermissions: entry.unixPermissions,
      dosPermissions: entry.dosPermissions,
    };
    if (entry.dir) {
      output.file(name, Buffer.alloc(0), options);
      continue;
    }
    const replacement = replacements.get(name);
    output.file(name, replacement ? await readFile(replacement) : await entry.async('nodebuffer'), options);
    if (replacement) replaced.add(name);
  }
  if (replaced.size !== replacements.size) {
    const missing = [...replacements.keys()].filter((name) => !replaced.has(name));
    throw new Error(`Replacement targets are absent from ZIP: ${missing.join(', ')}`);
  }
  const temporary = `${zip}.repack-${process.pid}`;
  await writeFile(temporary, await output.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } }));
  await rename(temporary, zip);
}

async function main() {
  await repackPortableRelease(parseArgs(process.argv.slice(2)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[repack-portable-release] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
