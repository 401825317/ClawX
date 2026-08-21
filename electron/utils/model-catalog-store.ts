import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { logger } from './logger';

export type ModelCatalogGeneration = Readonly<
  | { exists: false }
  | { exists: true; contentHash: string }
>;

type ModelCatalogState = {
  content: Buffer | null;
  generation: ModelCatalogGeneration;
  mode: number | null;
};

type ModelCatalogPathIdentity = {
  canonicalPath: string;
  lockKey: string;
  lockPath: string;
  pathHash: string;
};

type ModelCatalogUpdateResult =
  | 'updated'
  | 'unchanged'
  | 'target_changed_retry'
  | 'retry_exhausted'
  | 'failed';

type ModelCatalogRuntime = {
  now: () => number;
  platform: NodeJS.Platform;
  processAlive: (pid: number) => Promise<boolean>;
  random: () => number;
  realpath: (path: string) => Promise<string>;
  rename: (source: string, target: string) => Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
  unlink: (path: string) => Promise<void>;
};

type SiblingLock = {
  handle: Awaited<ReturnType<typeof open>>;
  lockPath: string;
  ownerToken: string;
  pathHash: string;
};

type SiblingLockMetadata = {
  version: 1;
  ownerToken: string;
  pid: number;
  createdAtMs: number;
  state: 'held' | 'released';
};

const TARGET_CHANGED_CODE = 'MODEL_CATALOG_TARGET_CHANGED';
const RETRY_EXHAUSTED_CODE = 'MODEL_CATALOG_RETRY_EXHAUSTED';
const LOCK_TIMEOUT_CODE = 'MODEL_CATALOG_LOCK_TIMEOUT';
const INVALID_CATALOG_CODE = 'MODEL_CATALOG_INVALID_JSON';
const MAX_RENAME_RETRIES = 3;
const MAX_LOCK_RELEASE_RETRIES = 3;
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const MAX_LOCK_ACQUIRE_ATTEMPTS = 200;
const UNKNOWN_LOCK_STALE_MS = 5 * 60_000;
const SIBLING_LOCK_SUFFIX = '.uclaw-model-catalog.lock';

const systemRuntime: ModelCatalogRuntime = {
  now: () => Date.now(),
  platform: process.platform,
  processAlive: async (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  random: () => Math.random(),
  realpath: async (path) => realpath(path),
  rename: async (source, target) => rename(source, target),
  sleep: async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  unlink: async (path) => unlink(path),
};

let runtime: ModelCatalogRuntime = { ...systemRuntime };
const writeQueues = new Map<string, Promise<void>>();

class ModelCatalogStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ModelCatalogStoreError';
    this.code = code;
  }
}

function generationFor(content: Buffer | null): ModelCatalogGeneration {
  return content === null
    ? { exists: false }
    : { exists: true, contentHash: createHash('sha256').update(content).digest('hex') };
}

function sameGeneration(left: ModelCatalogGeneration, right: ModelCatalogGeneration): boolean {
  return left.exists === right.exists
    && (!left.exists || (right.exists && left.contentHash === right.contentHash));
}

function isErrno(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && codes.includes((error as NodeJS.ErrnoException).code ?? '');
}

function isMissing(error: unknown): boolean {
  return isErrno(error, 'ENOENT');
}

function pathApi(platform = runtime.platform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix;
}

function stripWindowsNamespace(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`;
  if (path.startsWith('\\\\?\\')) return path.slice(4);
  return path;
}

function normalizeCanonicalPath(path: string, platform = runtime.platform): string {
  const api = pathApi(platform);
  const withoutNamespace = platform === 'win32' ? stripWindowsNamespace(path) : path;
  return api.normalize(withoutNamespace);
}

function lockKeyFor(canonicalPath: string, platform = runtime.platform): string {
  const normalized = normalizeCanonicalPath(canonicalPath, platform);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function hashLockKey(lockKey: string): string {
  return createHash('sha256').update(lockKey, 'utf8').digest('hex');
}

function fallbackPathHash(filePath: string): string {
  const api = pathApi();
  return hashLockKey(lockKeyFor(api.resolve(filePath)));
}

async function resolveCanonicalPath(filePath: string): Promise<string> {
  const api = pathApi();
  const absolutePath = api.resolve(filePath);
  const missingSegments: string[] = [];
  let candidate = absolutePath;

  while (true) {
    try {
      const existingPath = normalizeCanonicalPath(await runtime.realpath(candidate));
      return normalizeCanonicalPath(api.join(existingPath, ...missingSegments));
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = api.dirname(candidate);
      if (parent === candidate) {
        return normalizeCanonicalPath(absolutePath);
      }
      missingSegments.unshift(api.basename(candidate));
      candidate = parent;
    }
  }
}

async function resolvePathIdentity(filePath: string): Promise<ModelCatalogPathIdentity> {
  const api = pathApi();
  const canonicalPath = await resolveCanonicalPath(filePath);
  const lockKey = lockKeyFor(canonicalPath);
  return {
    canonicalPath,
    lockKey,
    lockPath: api.join(api.dirname(canonicalPath), `.${api.basename(canonicalPath)}${SIBLING_LOCK_SUFFIX}`),
    pathHash: hashLockKey(lockKey),
  };
}

async function readState(filePath: string): Promise<ModelCatalogState> {
  try {
    const content = await readFile(filePath);
    const fileMode = (await stat(filePath)).mode & 0o777;
    return { content, generation: generationFor(content), mode: fileMode };
  } catch (error) {
    if (isMissing(error)) {
      return { content: null, generation: generationFor(null), mode: null };
    }
    throw error;
  }
}

function safeFailureKind(error: unknown): string {
  if (error instanceof ModelCatalogStoreError) return error.code.toLowerCase();
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return code && /^(?:EACCES|EBUSY|EEXIST|EIO|EISDIR|EMFILE|ENFILE|ENOENT|ENOSPC|ENOTDIR|EPERM|EROFS)$/u.test(code)
    ? `fs_${code.toLowerCase()}`
    : 'operation_failed';
}

function logUpdateEvent(
  result: ModelCatalogUpdateResult,
  pathHash: string,
  attempt: number,
  maxAttempts: number,
  failureKind?: string,
): void {
  const details = {
    event: 'model_catalog_update',
    result,
    attempt,
    maxAttempts,
    pathHash,
    ...(failureKind ? { failureKind } : {}),
  };
  if (result === 'retry_exhausted' || result === 'failed') {
    logger.error('Model catalog update failed', details);
  } else if (result === 'target_changed_retry') {
    logger.warn('Model catalog target changed; retrying', details);
  } else {
    logger.info('Model catalog update completed', details);
  }
}

function retryDelayMs(attempt: number, baseMs: number, capMs: number): number {
  const exponential = Math.min(capMs, baseMs * (2 ** Math.max(0, attempt - 1)));
  return exponential + Math.floor(runtime.random() * Math.max(1, exponential));
}

function parseSiblingLockMetadata(value: string): SiblingLockMetadata | null {
  try {
    const parsed = JSON.parse(value) as Partial<SiblingLockMetadata>;
    if (
      parsed.version !== 1
      || typeof parsed.ownerToken !== 'string'
      || parsed.ownerToken.length < 16
      || !Number.isSafeInteger(parsed.pid)
      || (parsed.pid ?? 0) <= 0
      || !Number.isFinite(parsed.createdAtMs)
      || (parsed.createdAtMs ?? -1) < 0
      || (parsed.state !== undefined && parsed.state !== 'held' && parsed.state !== 'released')
    ) {
      return null;
    }
    return { ...parsed, state: parsed.state ?? 'held' } as SiblingLockMetadata;
  } catch {
    return null;
  }
}

async function removeStaleSiblingLock(lockPath: string): Promise<boolean> {
  let raw: string;
  let modifiedAtMs: number;
  try {
    [raw, modifiedAtMs] = await Promise.all([
      readFile(lockPath, 'utf8'),
      stat(lockPath).then((value) => value.mtimeMs),
    ]);
  } catch (error) {
    return isMissing(error);
  }

  const metadata = parseSiblingLockMetadata(raw);
  const definitelyDead = metadata
    ? metadata.state === 'released' || !(await runtime.processAlive(metadata.pid))
    : false;
  const unknownAndExpired = !metadata && runtime.now() - modifiedAtMs >= UNKNOWN_LOCK_STALE_MS;
  if (!definitelyDead && !unknownAndExpired) return false;

  try {
    if (await readFile(lockPath, 'utf8') !== raw) return false;
    await runtime.unlink(lockPath);
    return true;
  } catch (error) {
    return isMissing(error);
  }
}

async function acquireSiblingLock(identity: ModelCatalogPathIdentity): Promise<SiblingLock> {
  const api = pathApi();
  await mkdir(api.dirname(identity.canonicalPath), { recursive: true, mode: 0o700 });
  const ownerToken = randomUUID();
  const startedAt = runtime.now();

  for (let attempt = 1; attempt <= MAX_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(identity.lockPath, 'wx', 0o600);
      const metadata: SiblingLockMetadata = {
        version: 1,
        ownerToken,
        pid: process.pid,
        createdAtMs: runtime.now(),
        state: 'held',
      };
      await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
      await handle.sync();
      return { handle, lockPath: identity.lockPath, ownerToken, pathHash: identity.pathHash };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (handle) await runtime.unlink(identity.lockPath).catch(() => undefined);
      if (!isErrno(error, 'EEXIST')) throw error;
      if (await removeStaleSiblingLock(identity.lockPath)) continue;
      if (runtime.now() - startedAt >= LOCK_ACQUIRE_TIMEOUT_MS || attempt === MAX_LOCK_ACQUIRE_ATTEMPTS) {
        throw new ModelCatalogStoreError(LOCK_TIMEOUT_CODE, 'Timed out waiting for model catalog write lock');
      }
      await runtime.sleep(retryDelayMs(attempt, 10, 100));
    }
  }

  throw new ModelCatalogStoreError(LOCK_TIMEOUT_CODE, 'Timed out waiting for model catalog write lock');
}

async function readOwnedSiblingLock(lock: SiblingLock): Promise<boolean> {
  try {
    const metadata = parseSiblingLockMetadata(await readFile(lock.lockPath, 'utf8'));
    if (metadata?.ownerToken !== lock.ownerToken || metadata.pid !== process.pid) {
      logger.warn('Model catalog sibling lock ownership changed before release', {
        event: 'model_catalog_lock',
        result: 'ownership_changed',
        pathHash: lock.pathHash,
      });
      return false;
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function markSiblingLockReleased(lock: SiblingLock): Promise<boolean> {
  try {
    const released = Buffer.from(`${JSON.stringify({
      version: 1,
      ownerToken: lock.ownerToken,
      pid: process.pid,
      createdAtMs: runtime.now(),
      state: 'released',
    } satisfies SiblingLockMetadata)}\n`, 'utf8');
    await lock.handle.write(released, 0, released.byteLength, 0);
    await lock.handle.truncate(released.byteLength);
    await lock.handle.sync();
    return true;
  } catch {
    return false;
  }
}

async function releaseSiblingLock(lock: SiblingLock): Promise<void> {
  let releaseFailure: unknown;
  for (let attempt = 0; attempt <= MAX_LOCK_RELEASE_RETRIES; attempt += 1) {
    try {
      if (!(await readOwnedSiblingLock(lock))) {
        await lock.handle.close().catch(() => undefined);
        return;
      }
      await runtime.unlink(lock.lockPath);
      await lock.handle.close().catch(() => undefined);
      return;
    } catch (error) {
      if (isMissing(error)) {
        await lock.handle.close().catch(() => undefined);
        return;
      }
      if (isErrno(error, 'EPERM', 'EACCES', 'EBUSY') && attempt < MAX_LOCK_RELEASE_RETRIES) {
        await runtime.sleep(retryDelayMs(attempt + 1, 10, 80));
        continue;
      }
      releaseFailure = error;
      break;
    }
  }

  // Keep the lock held while unlink is retryable. Only advertise a released
  // lock after retries are exhausted, so another writer cannot replace the
  // lock path between our ownership check and unlink.
  const releasedMarkerWritten = await markSiblingLockReleased(lock);
  await lock.handle.close().catch(() => undefined);
  logger.warn('Model catalog sibling lock release failed', {
    event: 'model_catalog_lock',
    result: 'release_failed',
    pathHash: lock.pathHash,
    failureKind: safeFailureKind(releaseFailure),
    releasedMarkerWritten,
  });
}

async function withResolvedWriteLock<T>(identity: ModelCatalogPathIdentity, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(identity.lockKey) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const tail = previous.then(() => queueGate);
  writeQueues.set(identity.lockKey, tail);

  await previous;
  let siblingLock: SiblingLock | undefined;
  try {
    siblingLock = await acquireSiblingLock(identity);
    return await operation();
  } finally {
    try {
      if (siblingLock) await releaseSiblingLock(siblingLock);
    } finally {
      releaseQueue();
      if (writeQueues.get(identity.lockKey) === tail) {
        writeQueues.delete(identity.lockKey);
      }
    }
  }
}

async function renameWithRetry(
  tempPath: string,
  filePath: string,
  expectedGeneration: ModelCatalogGeneration,
  publishedGeneration: ModelCatalogGeneration,
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RENAME_RETRIES; attempt += 1) {
    const current = await readState(filePath);
    if (!sameGeneration(current.generation, expectedGeneration)) {
      throw new ModelCatalogStoreError(TARGET_CHANGED_CODE, 'Model catalog target changed during write');
    }
    try {
      await runtime.rename(tempPath, filePath);
    } catch (error) {
      const afterFailure = await readState(filePath).catch(() => undefined);
      if (afterFailure && sameGeneration(afterFailure.generation, publishedGeneration)) {
        await runtime.unlink(tempPath).catch(() => undefined);
        return;
      }
      if (afterFailure && !sameGeneration(afterFailure.generation, expectedGeneration)) {
        throw new ModelCatalogStoreError(TARGET_CHANGED_CODE, 'Model catalog target changed during write');
      }
      if (!isErrno(error, 'EPERM', 'EACCES', 'EBUSY') || attempt === MAX_RENAME_RETRIES) throw error;
      await runtime.sleep(retryDelayMs(attempt + 1, 15, 120));
      continue;
    }

    const published = await readState(filePath);
    if (!sameGeneration(published.generation, publishedGeneration)) {
      throw new ModelCatalogStoreError(TARGET_CHANGED_CODE, 'Model catalog target changed after write');
    }
    return;
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // Windows and some filesystems do not support opening/fsyncing a directory.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function replaceAtomically(
  filePath: string,
  content: Buffer,
  expectedGeneration: ModelCatalogGeneration,
  mode: number,
): Promise<void> {
  const api = pathApi();
  const directory = api.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = api.join(directory, `.${api.basename(filePath)}.uclaw-${process.pid}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let committed = false;

  try {
    handle = await open(tempPath, 'wx', mode);
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;

    await renameWithRetry(tempPath, filePath, expectedGeneration, generationFor(content));
    committed = true;
    await syncDirectoryBestEffort(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    if (!committed) {
      await runtime.unlink(tempPath).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
  }
}

/**
 * Serialize writers of one Agent model catalog in this process and cooperate
 * with other UClaw processes through an adjacent atomic lock file.
 */
export async function withModelCatalogWriteLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  return withResolvedWriteLock(await resolvePathIdentity(filePath), operation);
}

/**
 * Read-modify-write a catalog without exposing partial JSON. If a
 * non-cooperating writer updates it between our read and atomic replacement,
 * retry against the newest generation instead of overwriting that write.
 */
export async function updateModelCatalog(
  filePath: string,
  transform: (document: Record<string, unknown>) => Record<string, unknown>,
  options: { maxTargetChangeRetries?: number } = {},
): Promise<{ changed: boolean; attempts: number }> {
  const pathHashFallback = fallbackPathHash(filePath);
  const maxTargetChangeRetries = options.maxTargetChangeRetries ?? 2;
  const maxAttempts = Number.isSafeInteger(maxTargetChangeRetries) && maxTargetChangeRetries >= 0
    ? maxTargetChangeRetries + 1
    : 1;
  let pathHash = pathHashFallback;
  let lastAttempt = 1;

  try {
    if (!Number.isSafeInteger(maxTargetChangeRetries) || maxTargetChangeRetries < 0) {
      throw new RangeError('maxTargetChangeRetries must be a non-negative safe integer');
    }
    const identity = await resolvePathIdentity(filePath);
    pathHash = identity.pathHash;
    return await withResolvedWriteLock(identity, async () => {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        lastAttempt = attempt;
        const state = await readState(identity.canonicalPath);
        let document: Record<string, unknown> = {};
        if (state.content) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(state.content.toString('utf8')) as unknown;
          } catch {
            throw new ModelCatalogStoreError(INVALID_CATALOG_CODE, 'Invalid model catalog JSON');
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new ModelCatalogStoreError(INVALID_CATALOG_CODE, 'Invalid model catalog JSON');
          }
          document = parsed as Record<string, unknown>;
        }

        const nextDocument = transform(structuredClone(document));
        const content = Buffer.from(`${JSON.stringify(nextDocument, null, 2)}\n`, 'utf8');
        if (state.content?.equals(content)) {
          logUpdateEvent('unchanged', pathHash, attempt, maxAttempts);
          return { changed: false, attempts: attempt };
        }

        try {
          await replaceAtomically(identity.canonicalPath, content, state.generation, state.mode ?? 0o600);
          logUpdateEvent('updated', pathHash, attempt, maxAttempts);
          return { changed: true, attempts: attempt };
        } catch (error) {
          if (!(error instanceof ModelCatalogStoreError) || error.code !== TARGET_CHANGED_CODE) throw error;
          if (attempt === maxAttempts) {
            logUpdateEvent('retry_exhausted', pathHash, attempt, maxAttempts, RETRY_EXHAUSTED_CODE.toLowerCase());
            throw new ModelCatalogStoreError(RETRY_EXHAUSTED_CODE, 'Model catalog update retry budget exhausted');
          }
          logUpdateEvent('target_changed_retry', pathHash, attempt, maxAttempts);
        }
      }

      throw new ModelCatalogStoreError(RETRY_EXHAUSTED_CODE, 'Model catalog update retry budget exhausted');
    });
  } catch (error) {
    if (!(error instanceof ModelCatalogStoreError) || error.code !== RETRY_EXHAUSTED_CODE) {
      logUpdateEvent('failed', pathHash, lastAttempt, maxAttempts, safeFailureKind(error));
    }
    throw error;
  }
}

export function resetModelCatalogWriteLocksForTests(): void {
  writeQueues.clear();
  runtime = { ...systemRuntime };
}

export const modelCatalogStoreTestApi = {
  getWriteQueueCount(): number {
    return writeQueues.size;
  },
  async resolvePathIdentity(filePath: string): Promise<ModelCatalogPathIdentity> {
    return resolvePathIdentity(filePath);
  },
  setRuntimeOverrides(overrides: Partial<ModelCatalogRuntime>): void {
    runtime = { ...runtime, ...overrides };
  },
};
