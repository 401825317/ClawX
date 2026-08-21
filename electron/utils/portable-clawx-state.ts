import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CLAWX_CORE_STATE_SCHEMA = 'uclaw.portable-clawx-core-state/v1';
const MANIFEST_FILE = '.uclaw-core-state-manifest.json';
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export type PortableClawXStateLayout = {
  sourceDir: string;
  backupDir: string;
};

type CoreStateEntry = {
  sha256: string;
  size: number;
};

type CoreStateManifest = {
  schema: typeof CLAWX_CORE_STATE_SCHEMA;
  createdAt: string;
  entries: Record<string, CoreStateEntry>;
};

export type PortableClawXStateSyncResult = {
  skipped: boolean;
  fileCount: number;
};

function isCoreStateFile(name: string): boolean {
  return name === path.basename(name)
    && !name.includes('\\')
    && name.toLowerCase().endsWith('.json')
    && name !== MANIFEST_FILE;
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readManifestSync(layout: PortableClawXStateLayout): CoreStateManifest | undefined {
  try {
    const raw = readFileSync(path.join(layout.backupDir, 'current', MANIFEST_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CoreStateManifest>;
    if (parsed.schema !== CLAWX_CORE_STATE_SCHEMA || !parsed.entries || typeof parsed.entries !== 'object') {
      return undefined;
    }
    if (typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt))) return undefined;
    for (const [name, entry] of Object.entries(parsed.entries)) {
      if (!isCoreStateFile(name) || !entry || typeof entry !== 'object') return undefined;
      if (!HASH_PATTERN.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) return undefined;
    }
    return parsed as CoreStateManifest;
  } catch {
    return undefined;
  }
}

function syncFile(filePath: string): void {
  // Windows rejects FlushFileBuffers for a read-only descriptor. Open the completed
  // temporary file read/write so fsync is durable before it is published by rename.
  const descriptor = openSync(filePath, 'r+');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function listSourceCoreFilesSync(sourceDir: string): string[] {
  try {
    return readdirSync(sourceDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isCoreStateFile(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Restore a fully verified local recovery generation into an empty core-state set. */
export function preparePortableClawXStateSync(layout: PortableClawXStateLayout): boolean {
  mkdirSync(layout.sourceDir, { recursive: true });
  if (listSourceCoreFilesSync(layout.sourceDir).length > 0) return false;
  const manifest = readManifestSync(layout);
  if (!manifest) return false;

  const verified = new Map<string, Buffer>();
  for (const [name, entry] of Object.entries(manifest.entries)) {
    try {
      const bytes = readFileSync(path.join(layout.backupDir, 'current', name));
      if (bytes.length !== entry.size || hashBytes(bytes) !== entry.sha256) return false;
      verified.set(name, bytes);
    } catch {
      return false;
    }
  }

  const temporaryFiles: string[] = [];
  const publishedFiles: string[] = [];
  try {
    // Validate every source before publishing any restored file.
    for (const [name, bytes] of verified) {
      const temporary = path.join(layout.sourceDir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
      writeFileSync(temporary, bytes, { flag: 'wx' });
      syncFile(temporary);
      temporaryFiles.push(temporary);
    }
    for (let index = 0; index < temporaryFiles.length; index += 1) {
      const target = path.join(layout.sourceDir, [...verified.keys()][index]);
      renameSync(temporaryFiles[index], target);
      publishedFiles.push(target);
    }
    return true;
  } catch {
    // The source started without core JSON; remove any partially published generation.
    for (const published of publishedFiles.reverse()) rmSync(published, { force: true });
    return false;
  } finally {
    for (const temporary of temporaryFiles) rmSync(temporary, { force: true });
  }
}

/** Snapshot all top-level persistent JSON files into one local atomic generation. */
export async function syncPortableClawXState(
  layout: PortableClawXStateLayout,
): Promise<PortableClawXStateSyncResult> {
  const names = (await readdir(layout.sourceDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && isCoreStateFile(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) return { skipped: true, fileCount: 0 };

  const files = new Map<string, Buffer>();
  const entries: Record<string, CoreStateEntry> = {};
  for (const name of names) {
    const sourcePath = path.join(layout.sourceDir, name);
    const before = await stat(sourcePath);
    const bytes = await readFile(sourcePath);
    const after = await stat(sourcePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      return { skipped: true, fileCount: 0 };
    }
    files.set(name, bytes);
    entries[name] = { sha256: hashBytes(bytes), size: bytes.length };
  }

  const previous = readManifestSync(layout);
  if (previous && JSON.stringify(previous.entries) === JSON.stringify(entries)) {
    return { skipped: true, fileCount: names.length };
  }

  await mkdir(layout.backupDir, { recursive: true });
  const staging = path.join(layout.backupDir, `.staging-${process.pid}-${randomUUID()}`);
  const current = path.join(layout.backupDir, 'current');
  const previousDir = path.join(layout.backupDir, `.previous-${process.pid}-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  let movedCurrent = false;
  try {
    for (const [name, bytes] of files) {
      const target = path.join(staging, name);
      await writeFile(target, bytes, { flag: 'wx' });
      syncFile(target);
    }
    const manifest: CoreStateManifest = {
      schema: CLAWX_CORE_STATE_SCHEMA,
      createdAt: new Date().toISOString(),
      entries,
    };
    const manifestPath = path.join(staging, MANIFEST_FILE);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    syncFile(manifestPath);

    if (existsSync(current)) {
      await rename(current, previousDir);
      movedCurrent = true;
    }
    await rename(staging, current);
    if (movedCurrent) await rm(previousDir, { recursive: true, force: true }).catch(() => undefined);
    return { skipped: false, fileCount: names.length };
  } catch (error) {
    if (movedCurrent && !existsSync(current) && existsSync(previousDir)) {
      try {
        await rename(previousDir, current);
        movedCurrent = false;
      } catch {
        // Preserve the previous generation in place when the filesystem rejects rollback.
      }
    }
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (!movedCurrent || existsSync(current)) {
      await rm(previousDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
