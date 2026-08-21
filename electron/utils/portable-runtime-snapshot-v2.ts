import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { backup as backupSqlite, DatabaseSync } from 'node:sqlite';

export const PORTABLE_SNAPSHOT_V2_SCHEMA = 'uclaw.portable-runtime-snapshot/v2' as const;

const OBJECT_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SNAPSHOT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ROOT_SKIPPED_DIRECTORIES = new Set([
  'plugin-skills',
  'logs',
  'tmp',
  'cache',
  'node-compile-cache',
]);
const RUNTIME_MARKER_FILE = '.uclaw-runtime-state.json';

export type PortableSnapshotV2Layout = {
  stateDir: string;
  snapshotDir: string;
  portableId: string;
};

export type PortableSnapshotV2Entry = {
  object: string;
  size: number;
  mtimeMs: number;
  sourceFiles?: Record<string, { size: number; mtimeMs: number }>;
};

export type PortableSnapshotV2Manifest = {
  schema: typeof PORTABLE_SNAPSHOT_V2_SCHEMA;
  portableId: string;
  snapshotId?: string;
  generation?: number;
  parentSnapshotId?: string;
  createdAt: string;
  reason: string;
  entries: Record<string, PortableSnapshotV2Entry>;
};

export type PortableSnapshotV2SyncResult = {
  skipped: boolean;
  /** The source could not be captured consistently; no source data was modified. */
  deferred: boolean;
  deferredReason?: 'sqlite-unstable' | 'file-group-unstable';
  deferredPaths: string[];
  reusedPreviousSnapshot: boolean;
  snapshotPath?: string;
  snapshotId?: string;
  generation?: number;
  scannedFiles: number;
  changedFiles: number;
  reusedFiles: number;
  writtenObjects: number;
  writtenBytes: number;
  unstableFiles: number;
  scanDurationMs: number;
  writeDurationMs: number;
  totalDurationMs: number;
};

export type PortableSnapshotV2SyncOptions = {
  signal?: AbortSignal;
  minimumGeneration?: number;
  verifyExistingObjects?: boolean;
};

export type PortableSnapshotV2RestoreResult = {
  snapshotPath: string;
  manifest: PortableSnapshotV2Manifest;
};

type ScannedFile = {
  relativePath: string;
  sourcePath: string;
  size: number;
  mtimeMs: number;
};

type StableFile = {
  object: string;
  size: number;
  mtimeMs: number;
};

type PersistStableObjectResult = 'written' | 'reused' | 'unstable';

type SnapshotFileGroup = {
  files: ScannedFile[];
  previousPaths: string[];
};

function isSafeRelativePath(value: string): boolean {
  if (
    !value
    || value.includes('\\')
    || value.includes(':')
    || value.includes('\0')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function manifestObjectsAvailableSync(
  layout: PortableSnapshotV2Layout,
  manifest: PortableSnapshotV2Manifest,
  verifyHashes = false,
): boolean {
  return Object.values(manifest.entries).every((entry) => {
    try {
      const metadata = statSync(objectPath(layout, entry.object));
      return metadata.isFile()
        && metadata.size === entry.size
        && (!verifyHashes || hashFileSync(objectPath(layout, entry.object)) === entry.object);
    } catch {
      return false;
    }
  });
}

function parseManifest(
  raw: string,
  portableId: string,
): PortableSnapshotV2Manifest | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<PortableSnapshotV2Manifest>;
    if (parsed.schema !== PORTABLE_SNAPSHOT_V2_SCHEMA || parsed.portableId !== portableId) return undefined;
    if (typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt))) return undefined;
    if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) return undefined;
    if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) return undefined;
    if (parsed.snapshotId !== undefined && !SNAPSHOT_ID_PATTERN.test(parsed.snapshotId)) return undefined;
    if (parsed.generation !== undefined && (!Number.isSafeInteger(parsed.generation) || parsed.generation < 1)) return undefined;
    if (parsed.parentSnapshotId !== undefined && !SNAPSHOT_ID_PATTERN.test(parsed.parentSnapshotId)) return undefined;

    for (const [relativePath, entry] of Object.entries(parsed.entries)) {
      if (!isSafeRelativePath(relativePath)) return undefined;
      if (!entry || typeof entry !== 'object') return undefined;
      if (!OBJECT_HASH_PATTERN.test(entry.object)) return undefined;
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) return undefined;
      if (!Number.isFinite(entry.mtimeMs) || entry.mtimeMs < 0) return undefined;
      if (entry.sourceFiles !== undefined) {
        if (!entry.sourceFiles || typeof entry.sourceFiles !== 'object' || Array.isArray(entry.sourceFiles)) return undefined;
        for (const [sourcePath, version] of Object.entries(entry.sourceFiles)) {
          if (!isSafeRelativePath(sourcePath) || !version || typeof version !== 'object') return undefined;
          if (!Number.isSafeInteger(version.size) || version.size < 0) return undefined;
          if (!Number.isFinite(version.mtimeMs) || version.mtimeMs < 0) return undefined;
        }
      }
    }
    return parsed as PortableSnapshotV2Manifest;
  } catch {
    return undefined;
  }
}

export function readLatestPortableSnapshotV2Sync(
  layout: PortableSnapshotV2Layout,
): PortableSnapshotV2Manifest | undefined {
  return readValidManifestCandidatesSync(layout)[0]?.manifest;
}

function readValidManifestCandidatesSync(
  layout: PortableSnapshotV2Layout,
  verifyHashes = false,
): Array<{ path: string; manifest: PortableSnapshotV2Manifest }> {
  const manifestDir = path.join(layout.snapshotDir, 'manifests');
  if (!existsSync(manifestDir)) return [];
  let names: string[];
  try {
    names = readdirSync(manifestDir)
      .filter((name) => name.startsWith('snapshot-') && name.endsWith('.json'))
      .sort((left, right) => right.localeCompare(left));
  } catch {
    return [];
  }

  const candidates: Array<{ path: string; manifest: PortableSnapshotV2Manifest }> = [];
  for (const name of names) {
    try {
      const manifestPath = path.join(manifestDir, name);
      const manifest = parseManifest(readFileSync(manifestPath, 'utf8'), layout.portableId);
      if (manifest && manifestObjectsAvailableSync(layout, manifest, verifyHashes)) {
        candidates.push({ path: manifestPath, manifest });
      }
    } catch {
      // Ignore incomplete or unreadable snapshots.
    }
  }
  return candidates.sort((left, right) => {
    const generationOrder = (right.manifest.generation ?? 0) - (left.manifest.generation ?? 0);
    if (generationOrder !== 0) return generationOrder;
    return path.basename(right.path).localeCompare(path.basename(left.path));
  });
}

function readMaximumManifestGenerationSync(layout: PortableSnapshotV2Layout): number {
  const manifestDir = path.join(layout.snapshotDir, 'manifests');
  try {
    return readdirSync(manifestDir)
      .filter((name) => name.startsWith('snapshot-') && name.endsWith('.json'))
      .reduce((maximum, name) => {
        try {
          const manifest = parseManifest(readFileSync(path.join(manifestDir, name), 'utf8'), layout.portableId);
          return Math.max(maximum, manifest?.generation ?? 0);
        } catch {
          return maximum;
        }
      }, 0);
  } catch {
    return 0;
  }
}

function hashFileSync(filePath: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = openSync(filePath, 'r');
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

/** Restore the newest complete snapshot and report the exact generation applied. */
export function restorePortableRuntimeSnapshotV2WithResultSync(
  layout: PortableSnapshotV2Layout,
  targetDir: string,
): PortableSnapshotV2RestoreResult | undefined {
  const candidates = readValidManifestCandidatesSync(layout);
  for (const candidate of candidates) {
    const { manifest } = candidate;
    const stagingDir = `${targetDir}.restore.${process.pid}.${randomUUID()}.tmp`;
    const previousDir = `${targetDir}.previous.${process.pid}.${randomUUID()}.tmp`;
    let movedTarget = false;
    try {
      mkdirSync(stagingDir, { recursive: true });
      let complete = true;
      for (const [relativePath, entry] of Object.entries(manifest.entries)) {
        const sourcePath = objectPath(layout, entry.object);
        try {
          const metadata = statSync(sourcePath);
          if (!metadata.isFile() || metadata.size !== entry.size || hashFileSync(sourcePath) !== entry.object) {
            complete = false;
            break;
          }
          const targetPath = path.join(stagingDir, ...relativePath.split('/'));
          mkdirSync(path.dirname(targetPath), { recursive: true });
          copyFileSync(sourcePath, targetPath);
        } catch {
          complete = false;
          break;
        }
      }
      if (!complete) continue;

      // Publish by directory exchange so a failed rename cannot erase the old local state.
      if (existsSync(targetDir)) {
        renameSync(targetDir, previousDir);
        movedTarget = true;
      }
      renameSync(stagingDir, targetDir);
      if (movedTarget) {
        try {
          rmSync(previousDir, { recursive: true, force: true });
          movedTarget = false;
        } catch {
          // The restored target is complete; a locked stale directory can be cleaned later.
        }
      }
      return { snapshotPath: candidate.path, manifest };
    } catch {
      if (movedTarget && !existsSync(targetDir) && existsSync(previousDir)) {
        try {
          renameSync(previousDir, targetDir);
          movedTarget = false;
        } catch {
          // Keep the previous directory for manual recovery when the volume rejects rollback.
          return undefined;
        }
      }
      // Try an older complete manifest.
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
      if (!movedTarget) rmSync(previousDir, { recursive: true, force: true });
    }
  }
  return undefined;
}

export function restorePortableRuntimeSnapshotV2Sync(
  layout: PortableSnapshotV2Layout,
  targetDir: string,
): boolean {
  return Boolean(restorePortableRuntimeSnapshotV2WithResultSync(layout, targetDir));
}

function shouldSkipEntry(relativePath: string, isDirectory: boolean): boolean {
  const segments = relativePath.split('/');
  const name = segments.at(-1) ?? '';
  if (segments.length === 1 && isDirectory && ROOT_SKIPPED_DIRECTORIES.has(name)) return true;
  if (isDirectory) {
    const lowered = segments.map((segment) => segment.toLowerCase());
    const userDataIndex = lowered.findIndex((segment, index) => (
      segment === 'user-data'
      && lowered[index - 1] === 'openclaw'
      && lowered[index - 2] === 'browser'
    ));
    if (userDataIndex >= 0) {
      const userDataPath = lowered.slice(userDataIndex + 1);
      if (userDataPath.includes('crashpad')) return true;
      if (userDataPath.includes('cache') || userDataPath.includes('code cache') || userDataPath.includes('gpucache')) {
        return true;
      }
      const serviceWorkerIndex = userDataPath.indexOf('service worker');
      if (serviceWorkerIndex >= 0 && userDataPath[serviceWorkerIndex + 1] === 'cachestorage') return true;
    }
  }
  return name === RUNTIME_MARKER_FILE || name.endsWith('.lock') || name.endsWith('.tmp');
}

async function scanStateFiles(stateDir: string, signal?: AbortSignal): Promise<ScannedFile[]> {
  const candidates: Array<{ relativePath: string; sourcePath: string }> = [];
  const visit = async (directory: string, prefix = ''): Promise<void> => {
    signal?.throwIfAborted();
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (shouldSkipEntry(relativePath, entry.isDirectory())) continue;
      const sourcePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(sourcePath, relativePath);
      } else if (entry.isFile()) {
        candidates.push({ relativePath, sourcePath });
      }
    }
  };
  await visit(stateDir);

  const files: ScannedFile[] = [];
  for (let offset = 0; offset < candidates.length; offset += 32) {
    signal?.throwIfAborted();
    const batch = candidates.slice(offset, offset + 32);
    const scanned = await Promise.all(batch.map(async (candidate) => {
      try {
        const metadata = await stat(candidate.sourcePath);
        if (!metadata.isFile()) return undefined;
        return {
          ...candidate,
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    }));
    for (const file of scanned) {
      if (file) files.push(file);
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function hashStableFile(file: ScannedFile, signal?: AbortSignal): Promise<StableFile | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const before = await stat(file.sourcePath);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file.sourcePath)) {
        signal?.throwIfAborted();
        hash.update(chunk as Buffer);
      }
      const after = await stat(file.sourcePath);
      if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
        return {
          object: hash.digest('hex'),
          size: after.size,
          mtimeMs: after.mtimeMs,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    }
  }
  return undefined;
}

async function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    signal?.throwIfAborted();
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function objectPath(layout: PortableSnapshotV2Layout, object: string): string {
  return path.join(layout.snapshotDir, 'objects', object.slice(0, 2), object);
}

/** Flush file contents before publication; directory flush is best-effort on Windows filesystems. */
function syncPublishedPath(filePath: string): void {
  let descriptor: number | undefined;
  try {
    // Windows rejects FlushFileBuffers for a read-only Node handle. All callers
    // pass a temporary file we just created; r+ keeps the durable publish path
    // valid there while directory handles remain best-effort below.
    descriptor = openSync(filePath, 'r+');
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncDirectoryBestEffort(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, 'r');
    fsyncSync(descriptor);
  } catch {
    // Windows and some filesystems reject opening or syncing a directory.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function persistStableObject(
  layout: PortableSnapshotV2Layout,
  file: ScannedFile,
  stable: StableFile,
  signal?: AbortSignal,
): Promise<PersistStableObjectResult> {
  signal?.throwIfAborted();
  const destination = objectPath(layout, stable.object);
  if (existsSync(destination)) {
    try {
      const metadata = await stat(destination);
      if (metadata.isFile() && metadata.size === stable.size && await hashFile(destination, signal) === stable.object) {
        return 'reused';
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const before = await stat(file.sourcePath);
    if (before.size !== stable.size || before.mtimeMs !== stable.mtimeMs) return 'unstable';
    await copyFile(file.sourcePath, temporary);
    signal?.throwIfAborted();
    const after = await stat(file.sourcePath);
    if (after.size !== stable.size || after.mtimeMs !== stable.mtimeMs) return 'unstable';
    const copied = await stat(temporary);
    if (
      !copied.isFile()
      || copied.size !== stable.size
      || await hashFile(temporary, signal) !== stable.object
    ) {
      return 'unstable';
    }
    syncPublishedPath(temporary);
    if (existsSync(destination)) {
      try {
        const current = await stat(destination);
        if (
          current.isFile()
          && current.size === stable.size
          && await hashFile(destination, signal) === stable.object
        ) {
          return 'reused';
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rename(temporary, destination);
    syncDirectoryBestEffort(path.dirname(destination));
    return 'written';
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function sameEntries(
  left: Record<string, PortableSnapshotV2Entry>,
  right: Record<string, PortableSnapshotV2Entry>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function cleanupSnapshots(layout: PortableSnapshotV2Layout): Promise<void> {
  const manifestDir = path.join(layout.snapshotDir, 'manifests');
  let names: string[];
  try {
    names = (await readdir(manifestDir))
      .filter((name) => name.startsWith('snapshot-') && name.endsWith('.json'))
      .sort((left, right) => right.localeCompare(left));
  } catch {
    return;
  }

  const valid: Array<{ name: string; manifest: PortableSnapshotV2Manifest }> = [];
  let hasUnreadableManifest = false;
  for (const name of names) {
    try {
      const manifest = parseManifest(readFileSync(path.join(manifestDir, name), 'utf8'), layout.portableId);
      if (manifest && manifestObjectsAvailableSync(layout, manifest)) valid.push({ name, manifest });
      else hasUnreadableManifest = true;
    } catch {
      hasUnreadableManifest = true;
    }
  }

  valid.sort((left, right) => {
    const generationOrder = (right.manifest.generation ?? 0) - (left.manifest.generation ?? 0);
    return generationOrder !== 0 ? generationOrder : right.name.localeCompare(left.name);
  });

  for (const stale of valid.slice(3)) {
    await rm(path.join(manifestDir, stale.name), { force: true }).catch(() => undefined);
  }
  if (hasUnreadableManifest) return;

  const referenced = new Set(
    valid.slice(0, 3).flatMap(({ manifest }) => Object.values(manifest.entries).map((entry) => entry.object)),
  );
  const objectsDir = path.join(layout.snapshotDir, 'objects');
  let prefixes;
  try {
    prefixes = await readdir(objectsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const prefix of prefixes) {
    if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/u.test(prefix.name)) continue;
    const prefixDir = path.join(objectsDir, prefix.name);
    const objects = await readdir(prefixDir, { withFileTypes: true }).catch(() => []);
    for (const object of objects) {
      if (!object.isFile() || !OBJECT_HASH_PATTERN.test(object.name) || referenced.has(object.name)) continue;
      await rm(path.join(prefixDir, object.name), { force: true }).catch(() => undefined);
    }
  }
}

function databaseBasePath(relativePath: string): string | undefined {
  const match = relativePath.match(/^(.*)-(wal|shm|journal)$/u);
  return match?.[1];
}

function isSqliteDatabase(filePath: string): boolean {
  const header = Buffer.alloc(16);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, 'r');
    return readSync(descriptor, header, 0, header.length, 0) === header.length
      && header.toString('utf8') === 'SQLite format 3\0';
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sqliteDatabaseFile(group: SnapshotFileGroup): ScannedFile | undefined {
  const companionBases = new Set(
    group.files.map((file) => databaseBasePath(file.relativePath)).filter((value): value is string => Boolean(value)),
  );
  return group.files.find((file) => (
    (companionBases.has(file.relativePath) || /\.(?:db|sqlite|sqlite3)$/iu.test(file.relativePath))
    && isSqliteDatabase(file.sourcePath)
  ));
}

function sourceFileVersions(files: ScannedFile[]): Record<string, { size: number; mtimeMs: number }> {
  return Object.fromEntries(files.map((file) => [file.relativePath, {
    size: file.size,
    mtimeMs: file.mtimeMs,
  }]));
}

function sameSourceFileVersions(
  entry: PortableSnapshotV2Entry | undefined,
  files: ScannedFile[],
): boolean {
  return Boolean(entry?.sourceFiles)
    && JSON.stringify(entry?.sourceFiles) === JSON.stringify(sourceFileVersions(files));
}

const SQLITE_CAPTURE_ATTEMPTS = 4;
const SQLITE_CAPTURE_RETRY_BASE_MS = 25;

function firstPragmaValue(row: unknown): unknown {
  return row && typeof row === 'object' && !Array.isArray(row)
    ? Object.values(row as Record<string, unknown>)[0]
    : undefined;
}

function sqliteIntegrityOk(database: DatabaseSync): boolean {
  try {
    const integrity = firstPragmaValue(
      database.prepare('PRAGMA integrity_check').get(),
    );
    return integrity === 'ok';
  } catch {
    return false;
  }
}

async function readSourceFileVersions(
  files: ScannedFile[],
): Promise<Record<string, { size: number; mtimeMs: number }>> {
  const refreshed = await Promise.all(files.map(async (file) => {
    try {
      const metadata = await stat(file.sourcePath);
      return metadata.isFile()
        ? { ...file, size: metadata.size, mtimeMs: metadata.mtimeMs }
        : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }));
  return sourceFileVersions(refreshed.filter((file): file is ScannedFile => Boolean(file)));
}

async function waitForSqliteRetry(attempt: number, signal?: AbortSignal): Promise<void> {
  if (attempt + 1 >= SQLITE_CAPTURE_ATTEMPTS) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.min(250, SQLITE_CAPTURE_RETRY_BASE_MS * (2 ** attempt)));
  });
  signal?.throwIfAborted();
}

async function verifySqliteFile(
  databaseFile: ScannedFile,
  signal?: AbortSignal,
): Promise<boolean> {
  for (let attempt = 0; attempt < SQLITE_CAPTURE_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(databaseFile.sourcePath, { readOnly: true });
      if (sqliteIntegrityOk(database)) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).name === 'AbortError') throw error;
    } finally {
      database?.close();
    }
    await waitForSqliteRetry(attempt, signal);
  }
  return false;
}

async function captureSqliteDatabase(
  layout: PortableSnapshotV2Layout,
  databaseFile: ScannedFile,
  files: ScannedFile[],
  signal?: AbortSignal,
): Promise<{
  stable: StableFile;
  sourceFiles: Record<string, { size: number; mtimeMs: number }>;
  written: boolean;
} | undefined> {
  for (let attempt = 0; attempt < SQLITE_CAPTURE_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    // Keep the online-backup output outside the live OpenClaw state tree. A
    // failed backup must never create, delete, or rebuild files beside its DB.
    const temporary = path.join(
      layout.snapshotDir,
      'staging',
      `sqlite-backup.${process.pid}.${randomUUID()}.tmp`,
    );
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(databaseFile.sourcePath, { readOnly: true });
      const sourceBefore = await readSourceFileVersions(files);
      if (!sourceBefore[databaseFile.relativePath]) {
        await waitForSqliteRetry(attempt, signal);
        continue;
      }
      await mkdir(path.dirname(temporary), { recursive: true });
      await backupSqlite(database, temporary);
      database.close();
      database = undefined;
      const metadata = await stat(temporary);
      const backupFile: ScannedFile = {
        relativePath: databaseFile.relativePath,
        sourcePath: temporary,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
      };
      const stable = await hashStableFile(backupFile, signal);
      if (
        !stable
        || stable.size !== metadata.size
        || stable.mtimeMs !== metadata.mtimeMs
      ) {
        await waitForSqliteRetry(attempt, signal);
        continue;
      }
      let backupDatabase: DatabaseSync | undefined;
      try {
        backupDatabase = new DatabaseSync(temporary, { readOnly: true });
        if (!sqliteIntegrityOk(backupDatabase)) {
          await waitForSqliteRetry(attempt, signal);
          continue;
        }
      } finally {
        backupDatabase?.close();
      }
      const persisted = await persistStableObject(layout, backupFile, stable, signal);
      if (persisted === 'unstable') {
        await waitForSqliteRetry(attempt, signal);
        continue;
      }
      // SQLite backup is a consistent point-in-time copy even when the live
      // WAL advances. Pre-capture versions guarantee that any concurrent write
      // leaves this entry dirty for the next scan instead of being skipped.
      return { stable, sourceFiles: sourceBefore, written: persisted === 'written' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).name === 'AbortError') throw error;
      await waitForSqliteRetry(attempt, signal);
    } finally {
      database?.close();
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  return undefined;
}

function buildSnapshotFileGroups(
  files: ScannedFile[],
  previousEntries: Record<string, PortableSnapshotV2Entry>,
): SnapshotFileGroup[] {
  const allPaths = [...files.map((file) => file.relativePath), ...Object.keys(previousEntries)];
  const databaseBases = new Set(
    allPaths.map(databaseBasePath).filter((value): value is string => Boolean(value)),
  );
  const groupKey = (relativePath: string): string => {
    const base = databaseBasePath(relativePath);
    if (base) return `database:${base}`;
    if (databaseBases.has(relativePath)) return `database:${relativePath}`;
    return `file:${relativePath}`;
  };
  const groups = new Map<string, SnapshotFileGroup>();
  for (const file of files) {
    const key = groupKey(file.relativePath);
    const group = groups.get(key) ?? { files: [], previousPaths: [] };
    group.files.push(file);
    groups.set(key, group);
  }
  for (const relativePath of Object.keys(previousEntries)) {
    const key = groupKey(relativePath);
    const group = groups.get(key);
    if (group) group.previousPaths.push(relativePath);
  }
  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => ({
      files: group.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
      previousPaths: group.previousPaths.sort(),
    }));
}

export async function syncPortableRuntimeSnapshotV2(
  layout: PortableSnapshotV2Layout,
  reason = 'periodic',
  options: PortableSnapshotV2SyncOptions = {},
): Promise<PortableSnapshotV2SyncResult> {
  const { signal, minimumGeneration = 0, verifyExistingObjects = false } = options;
  signal?.throwIfAborted();
  const startedAt = Date.now();
  const previous = readValidManifestCandidatesSync(layout, verifyExistingObjects)[0]?.manifest;
  const maximumKnownGeneration = readMaximumManifestGenerationSync(layout);
  const scanStartedAt = Date.now();
  const files = await scanStateFiles(layout.stateDir, signal);
  const scanDurationMs = Date.now() - scanStartedAt;
  const entries: Record<string, PortableSnapshotV2Entry> = {};
  let changedFiles = 0;
  let reusedFiles = 0;
  let writtenObjects = 0;
  let writtenBytes = 0;
  let unstableFiles = 0;
  const writeStartedAt = Date.now();

  const deferredResult = (
    reasonCode: NonNullable<PortableSnapshotV2SyncResult['deferredReason']>,
    relativePath: string,
  ): PortableSnapshotV2SyncResult => ({
    skipped: true,
    deferred: true,
    deferredReason: reasonCode,
    deferredPaths: [relativePath],
    reusedPreviousSnapshot: Boolean(previous),
    ...(previous?.snapshotId ? { snapshotId: previous.snapshotId } : {}),
    ...(previous?.generation !== undefined ? { generation: previous.generation } : {}),
    scannedFiles: files.length,
    changedFiles,
    reusedFiles,
    writtenObjects,
    writtenBytes,
    unstableFiles,
    scanDurationMs,
    writeDurationMs: Date.now() - writeStartedAt,
    totalDurationMs: Date.now() - startedAt,
  });

  const previousEntries = previous?.entries ?? {};
  const groups = buildSnapshotFileGroups(files, previousEntries);
  for (const group of groups) {
    signal?.throwIfAborted();
    const sqliteFile = sqliteDatabaseFile(group);
    const unchanged = sqliteFile
      ? sameSourceFileVersions(previousEntries[sqliteFile.relativePath], group.files)
      : group.files.length === group.previousPaths.length
        && group.files.every((file) => {
          const existing = previousEntries[file.relativePath];
          return existing?.size === file.size && existing.mtimeMs === file.mtimeMs;
        });
    if (unchanged) {
      if (sqliteFile) {
        if (verifyExistingObjects && !await verifySqliteFile(sqliteFile, signal)) {
          unstableFiles += 1;
          return deferredResult('sqlite-unstable', sqliteFile.relativePath);
        }
        entries[sqliteFile.relativePath] = previousEntries[sqliteFile.relativePath];
      } else {
        for (const file of group.files) entries[file.relativePath] = previousEntries[file.relativePath];
      }
      reusedFiles += group.files.length;
      continue;
    }

    changedFiles += group.files.filter((file) => {
      const existing = previousEntries[file.relativePath];
      return !existing || existing.size !== file.size || existing.mtimeMs !== file.mtimeMs;
    }).length;

    if (sqliteFile) {
      const captured = await captureSqliteDatabase(layout, sqliteFile, group.files, signal);
      if (!captured) {
        unstableFiles += 1;
        return deferredResult('sqlite-unstable', sqliteFile.relativePath);
      }
      entries[sqliteFile.relativePath] = {
        ...captured.stable,
        sourceFiles: captured.sourceFiles,
      };
      if (captured.written) {
        writtenObjects += 1;
        writtenBytes += captured.stable.size;
      } else {
        reusedFiles += 1;
      }
      continue;
    }

    const captured = new Map<string, StableFile>();
    for (const file of group.files) {
      const stable = await hashStableFile(file, signal);
      if (!stable) {
        unstableFiles += 1;
        break;
      }
      captured.set(file.relativePath, stable);
    }

    let groupStable = captured.size === group.files.length;
    if (groupStable) {
      for (const file of group.files) {
        const stable = captured.get(file.relativePath)!;
        const persisted = await persistStableObject(layout, file, stable, signal);
        if (persisted === 'unstable') {
          unstableFiles += 1;
          groupStable = false;
          break;
        }
        if (persisted === 'written') {
          writtenObjects += 1;
          writtenBytes += stable.size;
        }
      }
    }

    if (!groupStable) {
      const relativePath = group.files[0]?.relativePath ?? 'unknown';
      return deferredResult('file-group-unstable', relativePath);
    }

    for (const file of group.files) {
      const stable = captured.get(file.relativePath)!;
      const existing = previousEntries[file.relativePath];
      if (existing?.object === stable.object && existing.size === stable.size) {
        entries[file.relativePath] = existing;
        reusedFiles += 1;
      } else {
        entries[file.relativePath] = stable;
      }
    }
  }

  const writeDurationMs = Date.now() - writeStartedAt;
  if (
    previous
    && previous.snapshotId
    && previous.generation !== undefined
    && (previous.generation ?? 0) >= minimumGeneration
    && sameEntries(previous.entries, entries)
  ) {
    return {
      skipped: true,
      deferred: false,
      deferredPaths: [],
      reusedPreviousSnapshot: Boolean(previous),
      snapshotId: previous.snapshotId,
      generation: previous.generation,
      scannedFiles: files.length,
      changedFiles: 0,
      reusedFiles: files.length,
      writtenObjects: 0,
      writtenBytes: 0,
      unstableFiles,
      scanDurationMs,
      writeDurationMs,
      totalDurationMs: Date.now() - startedAt,
    };
  }

  const manifest: PortableSnapshotV2Manifest = {
    schema: PORTABLE_SNAPSHOT_V2_SCHEMA,
    portableId: layout.portableId,
    snapshotId: randomUUID(),
    generation: Math.max(maximumKnownGeneration, previous?.generation ?? 0, minimumGeneration) + 1,
    ...(previous?.snapshotId ? { parentSnapshotId: previous.snapshotId } : {}),
    createdAt: new Date().toISOString(),
    reason: reason.slice(0, 80),
    entries,
  };
  const manifestDir = path.join(layout.snapshotDir, 'manifests');
  signal?.throwIfAborted();
  await mkdir(manifestDir, { recursive: true });
  const monotonic = process.hrtime.bigint().toString().padStart(20, '0');
  const name = `snapshot-${Date.now()}-${monotonic}-${randomUUID()}.json`;
  const snapshotPath = path.join(manifestDir, name);
  const temporary = path.join(manifestDir, `.${name}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    signal?.throwIfAborted();
    syncPublishedPath(temporary);
    await rename(temporary, snapshotPath);
    syncDirectoryBestEffort(manifestDir);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  await cleanupSnapshots(layout);

  return {
    skipped: false,
    deferred: false,
    deferredPaths: [],
    reusedPreviousSnapshot: Boolean(previous),
    snapshotPath,
    snapshotId: manifest.snapshotId,
    generation: manifest.generation,
    scannedFiles: files.length,
    changedFiles,
    reusedFiles,
    writtenObjects,
    writtenBytes,
    unstableFiles,
    scanDurationMs,
    writeDurationMs,
    totalDurationMs: Date.now() - startedAt,
  };
}
