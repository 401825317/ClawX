import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const PORTABLE_ID_FILE = '.uclaw-portable-id';
const RUNTIME_MARKER_FILE = '.uclaw-runtime-state.json';
const SNAPSHOT_MANIFEST_FILE = 'snapshot-complete.json';
const SNAPSHOT_SCHEMA = 'uclaw.portable-runtime-snapshot/v1';
const RUNTIME_MARKER_SCHEMA = 'uclaw.portable-runtime-state/v1';
const MAX_SNAPSHOTS = 3;

export type PortableRuntimeLayout = {
  rootDir: string;
  dataDir: string;
  legacyStateDir: string;
  runtimeRootDir: string;
  portableId: string;
  profileDir: string;
  stateDir: string;
  snapshotDir: string;
  markerPath: string;
  portableIdPath: string;
};

type SnapshotManifest = {
  schema: typeof SNAPSHOT_SCHEMA;
  portableId: string;
  createdAt: string;
  reason: string;
  fileCount: number;
};

type RuntimeMarker = {
  schema: typeof RUNTIME_MARKER_SCHEMA;
  portableId: string;
  preparedAt: string;
  lastSnapshotAt?: string;
};

function normalizedPath(value: string): string {
  return path.resolve(value);
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(normalizedPath(root), normalizedPath(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeSnapshotChild(layout: PortableRuntimeLayout, name: string): string {
  const candidate = path.join(layout.snapshotDir, name);
  if (!isPathInside(layout.snapshotDir, candidate) || normalizedPath(candidate) === normalizedPath(layout.snapshotDir)) {
    throw new Error(`Refusing unsafe portable snapshot path: ${candidate}`);
  }
  return candidate;
}

function normalizePortableId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^[A-Za-z0-9_-]{8,128}$/u.test(normalized) ? normalized : undefined;
}

function fallbackPortableId(rootDir: string): string {
  return createHash('sha256')
    .update(normalizedPath(rootDir).toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

function readPortableId(filePath: string): string | undefined {
  try {
    return normalizePortableId(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function ensurePortableId(rootDir: string, dataDir: string): { id: string; path: string } {
  const filePath = path.join(dataDir, PORTABLE_ID_FILE);
  const existing = readPortableId(filePath);
  if (existing) return { id: existing, path: filePath };

  const generated = randomUUID();
  try {
    mkdirSync(dataDir, { recursive: true });
    try {
      writeFileSync(filePath, `${generated}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return { id: readPortableId(filePath) ?? generated, path: filePath };
  } catch {
    // A read-only or temporarily disconnected portable volume must not stop
    // the already-running application. The path-derived id is only a local
    // fallback; a later writable start will create the durable id file.
    return { id: fallbackPortableId(rootDir), path: filePath };
  }
}

export function resolvePortableRuntimeLayout(params: {
  rootDir: string;
  dataDir: string;
  legacyStateDir: string;
  runtimeRootDir: string;
}): PortableRuntimeLayout {
  const rootDir = normalizedPath(params.rootDir);
  const dataDir = normalizedPath(params.dataDir);
  const runtimeRootDir = normalizedPath(params.runtimeRootDir);
  const identity = ensurePortableId(rootDir, dataDir);
  const profileDir = path.join(runtimeRootDir, 'profiles', identity.id);
  return {
    rootDir,
    dataDir,
    legacyStateDir: normalizedPath(params.legacyStateDir),
    runtimeRootDir,
    portableId: identity.id,
    profileDir,
    stateDir: path.join(profileDir, 'openclaw-state'),
    snapshotDir: path.join(dataDir, 'runtime-snapshots'),
    markerPath: path.join(profileDir, RUNTIME_MARKER_FILE),
    portableIdPath: identity.path,
  };
}

function shouldSkipRuntimeEntry(name: string, relativeRoot = ''): boolean {
  const isStateRoot = relativeRoot === '';
  return (isStateRoot && (
    name === 'plugin-skills'
    || name === 'logs'
    || name === 'tmp'
    || name === 'cache'
    || name === 'node-compile-cache'
  ))
    || name.endsWith('.lock')
    || name.endsWith('.tmp');
}

function isDirectoryEffectivelyEmpty(dir: string): boolean {
  if (!existsSync(dir)) return true;
  try {
    return readdirSync(dir).every((entry) => entry === RUNTIME_MARKER_FILE);
  } catch {
    return false;
  }
}

function copyTreeSync(source: string, target: string, relativeRoot = ''): void {
  if (!existsSync(source)) return;
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (shouldSkipRuntimeEntry(entry.name, relativeRoot)) continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    const sourceStat = lstatSync(sourcePath);
    if (sourceStat.isSymbolicLink()) continue;
    if (sourceStat.isDirectory()) {
      copyTreeSync(sourcePath, targetPath, path.join(relativeRoot, entry.name));
    } else if (sourceStat.isFile()) {
      mkdirSync(path.dirname(targetPath), { recursive: true });
      copyFileSync(sourcePath, targetPath);
    }
  }
}

function readSnapshotManifestSync(snapshotPath: string): SnapshotManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(snapshotPath, SNAPSHOT_MANIFEST_FILE), 'utf8')) as Partial<SnapshotManifest>;
    if (parsed.schema !== SNAPSHOT_SCHEMA || typeof parsed.portableId !== 'string') return undefined;
    if (typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt))) return undefined;
    if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) return undefined;
    if (!Number.isInteger(parsed.fileCount) || Number(parsed.fileCount) < 0) return undefined;
    return parsed as SnapshotManifest;
  } catch {
    return undefined;
  }
}

function findLatestSnapshotSync(layout: PortableRuntimeLayout): string | undefined {
  if (!existsSync(layout.snapshotDir)) return undefined;
  const candidates = readdirSync(layout.snapshotDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const snapshotPath = path.join(layout.snapshotDir, entry.name);
      const manifest = readSnapshotManifestSync(snapshotPath);
      if (!manifest || manifest.portableId !== layout.portableId || !existsSync(path.join(snapshotPath, 'state'))) return undefined;
      return { snapshotPath, createdAt: manifest.createdAt };
    })
    .filter((entry): entry is { snapshotPath: string; createdAt: string } => Boolean(entry))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return candidates[0]?.snapshotPath;
}

function writeRuntimeMarkerSync(layout: PortableRuntimeLayout, marker: RuntimeMarker): void {
  mkdirSync(path.dirname(layout.markerPath), { recursive: true });
  writeFileSync(layout.markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

/** Prepare a local state copy before OpenClaw reads any environment variables. */
export function preparePortableRuntimeState(layout: PortableRuntimeLayout): void {
  mkdirSync(layout.stateDir, { recursive: true });
  if (!isDirectoryEffectivelyEmpty(layout.stateDir)) return;

  const latestSnapshot = findLatestSnapshotSync(layout);
  if (latestSnapshot) {
    copyTreeSync(path.join(latestSnapshot, 'state'), layout.stateDir);
  } else if (existsSync(layout.legacyStateDir)) {
    copyTreeSync(layout.legacyStateDir, layout.stateDir);
  }

  writeRuntimeMarkerSync(layout, {
    schema: RUNTIME_MARKER_SCHEMA,
    portableId: layout.portableId,
    preparedAt: new Date().toISOString(),
  });
}

type CopyTreeCounters = {
  files: number;
  unstable: string[];
  readErrors: string[];
};

async function copyStableFile(sourcePath: string, targetPath: string): Promise<'copied' | 'missing' | 'unstable'> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const before = await stat(sourcePath);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      const after = await stat(sourcePath);
      if (before.size === after.size && before.mtimeMs === after.mtimeMs) return 'copied';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      // The source may be removed while a task is completing. The next
      // snapshot can pick it up; a changing file is never marked complete.
    }
  }
  return 'unstable';
}

async function copyTree(source: string, target: string, counters: CopyTreeCounters, relativeRoot = ''): Promise<void> {
  let entries;
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      counters.readErrors.push(relativeRoot || source);
    }
    return;
  }
  await mkdir(target, { recursive: true });
  for (const entry of entries) {
    if (shouldSkipRuntimeEntry(entry.name, relativeRoot)) continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    let sourceStat;
    try {
      sourceStat = await lstat(sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        counters.readErrors.push(path.join(relativeRoot, entry.name));
      }
      continue;
    }
    if (sourceStat.isSymbolicLink()) continue;
    if (sourceStat.isDirectory()) {
      await copyTree(sourcePath, targetPath, counters, path.join(relativeRoot, entry.name));
    } else if (sourceStat.isFile()) {
      const result = await copyStableFile(sourcePath, targetPath);
      if (result === 'copied') counters.files += 1;
      else if (result === 'unstable') counters.unstable.push(path.join(relativeRoot, entry.name));
    }
  }
}

async function readRuntimeMarker(layout: PortableRuntimeLayout): Promise<RuntimeMarker | undefined> {
  try {
    const parsed = JSON.parse(await readFile(layout.markerPath, 'utf8')) as RuntimeMarker;
    return parsed.schema === RUNTIME_MARKER_SCHEMA && parsed.portableId === layout.portableId ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeCompleteManifest(snapshotPath: string, manifest: SnapshotManifest): Promise<void> {
  const temporary = path.join(snapshotPath, `.snapshot-complete.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temporary, path.join(snapshotPath, SNAPSHOT_MANIFEST_FILE));
}

async function cleanupOldSnapshots(layout: PortableRuntimeLayout): Promise<void> {
  let entries;
  try {
    entries = await readdir(layout.snapshotDir, { withFileTypes: true });
  } catch {
    return;
  }
  const valid = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const snapshotPath = path.join(layout.snapshotDir, entry.name);
      const manifest = readSnapshotManifestSync(snapshotPath);
      return manifest?.portableId === layout.portableId ? { snapshotPath, createdAt: manifest.createdAt } : undefined;
    })
    .filter((entry): entry is { snapshotPath: string; createdAt: string } => Boolean(entry))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const stale of valid.slice(MAX_SNAPSHOTS)) {
    if (isPathInside(layout.snapshotDir, stale.snapshotPath)) {
      await rm(stale.snapshotPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Persist a complete, immutable snapshot without using links or inode checks. */
export async function syncPortableRuntimeSnapshot(
  layout: PortableRuntimeLayout,
  reason = 'periodic',
): Promise<{ snapshotPath: string; fileCount: number }> {
  await mkdir(layout.snapshotDir, { recursive: true });
  const snapshotName = `snapshot-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const snapshotPath = safeSnapshotChild(layout, snapshotName);
  try {
    const stateTarget = path.join(snapshotPath, 'state');
    await mkdir(stateTarget, { recursive: true });
    const counters: CopyTreeCounters = { files: 0, unstable: [], readErrors: [] };
    await copyTree(layout.stateDir, stateTarget, counters);
    if (counters.unstable.length > 0 || counters.readErrors.length > 0) {
      const details = [
        ...counters.unstable.slice(0, 5).map((entry) => 'unstable:' + entry),
        ...counters.readErrors.slice(0, 5).map((entry) => 'read:' + entry),
      ].join(', ');
      throw new Error(
        'Portable Runtime snapshot source changed during copy'
        + (details ? ' (' + details + ')' : ''),
      );
    }

    const manifest: SnapshotManifest = {
      schema: SNAPSHOT_SCHEMA,
      portableId: layout.portableId,
      createdAt: new Date().toISOString(),
      reason: reason.slice(0, 80),
      fileCount: counters.files,
    };
    await writeCompleteManifest(snapshotPath, manifest);

    const marker = await readRuntimeMarker(layout);
    await writeFile(layout.markerPath, `${JSON.stringify({
      schema: RUNTIME_MARKER_SCHEMA,
      portableId: layout.portableId,
      preparedAt: marker?.preparedAt ?? new Date().toISOString(),
      lastSnapshotAt: manifest.createdAt,
    }, null, 2)}\n`, 'utf8').catch(() => undefined);
    await cleanupOldSnapshots(layout);
    return { snapshotPath, fileCount: counters.files };
  } catch (error) {
    await rm(snapshotPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export class PortableRuntimeSnapshotService {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<unknown>;

  constructor(
    private readonly layout: PortableRuntimeLayout,
    private readonly log: (message: string, details?: unknown) => void = () => undefined,
    private readonly intervalMs = 5 * 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sync('periodic'); }, this.intervalMs);
    this.timer.unref?.();
    this.log('Portable Runtime snapshot service started', {
      stateDir: this.layout.stateDir,
      snapshotDir: this.layout.snapshotDir,
      portableId: this.layout.portableId,
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async sync(reason = 'manual'): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    this.inFlight = syncPortableRuntimeSnapshot(this.layout, reason)
      .then((result) => {
        this.log('Portable Runtime snapshot completed', {
          reason,
          fileCount: result.fileCount,
          snapshotPath: result.snapshotPath,
        });
      })
      .catch((error) => {
        this.log('Portable Runtime snapshot deferred', {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    await this.inFlight;
  }
}
