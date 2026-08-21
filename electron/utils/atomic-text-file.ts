import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
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

type TextFileGeneration = Readonly<
  | { exists: false }
  | { exists: true; contentHash: string }
>;

type TextFileState = {
  content: Buffer | null;
  generation: TextFileGeneration;
  mode: number | null;
};

type AtomicTextPathIdentity = {
  canonicalPath: string;
  lockKey: string;
  lockPath: string;
  pathHash: string;
};

type AtomicTextRuntime = {
  now: () => number;
  platform: NodeJS.Platform;
  processAlive: (pid: number) => Promise<boolean>;
  random: () => number;
  readBuffer: (path: string) => Promise<Buffer>;
  readUtf8: (path: string) => Promise<string>;
  realpath: (path: string) => Promise<string>;
  rename: (source: string, target: string) => Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
  stat: (path: string) => Promise<Stats>;
  unlink: (path: string) => Promise<void>;
};

type SiblingLock = {
  handle: Awaited<ReturnType<typeof open>>;
  lockPath: string;
  ownerToken: string;
};

type SiblingLockMetadata = {
  version: 1;
  ownerToken: string;
  pid: number;
  createdAtMs: number;
  state: 'held' | 'released';
};

export type AtomicTextFileUpdateResult = {
  changed: boolean;
  attempts: number;
};

export type AtomicTextFileUpdateOptions = {
  createParent?: boolean;
  maxTargetChangeRetries?: number;
};

const TARGET_CHANGED_CODE = 'ATOMIC_TEXT_TARGET_CHANGED';
const RETRY_EXHAUSTED_CODE = 'ATOMIC_TEXT_RETRY_EXHAUSTED';
const LOCK_TIMEOUT_CODE = 'ATOMIC_TEXT_LOCK_TIMEOUT';
const INVALID_ENCODING_CODE = 'ATOMIC_TEXT_INVALID_ENCODING';
const INVALID_OPTIONS_CODE = 'ATOMIC_TEXT_INVALID_OPTIONS';
const OPERATION_FAILED_CODE = 'ATOMIC_TEXT_OPERATION_FAILED';
const MAX_RENAME_RETRIES = 3;
const MAX_LOCK_RELEASE_RETRIES = 3;
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const MAX_LOCK_ACQUIRE_ATTEMPTS = 200;
const UNKNOWN_LOCK_STALE_MS = 5 * 60_000;
const SIBLING_LOCK_SUFFIX = '.uclaw-atomic-text.lock';

const systemRuntime: AtomicTextRuntime = {
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
  readBuffer: async (path) => readFile(path),
  readUtf8: async (path) => readFile(path, 'utf8'),
  realpath: async (path) => realpath(path),
  rename: async (source, target) => rename(source, target),
  sleep: async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  stat: async (path) => stat(path),
  unlink: async (path) => unlink(path),
};

let runtime: AtomicTextRuntime = { ...systemRuntime };
const writeQueues = new Map<string, Promise<void>>();

export class AtomicTextFileError extends Error {
  readonly code: string;
  readonly failureKind?: string;

  constructor(code: string, message: string, failureKind?: string) {
    super(message);
    this.name = 'AtomicTextFileError';
    this.code = code;
    this.failureKind = failureKind;
    this.stack = `${this.name}: ${message}`;
  }
}

function isErrno(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && codes.includes((error as NodeJS.ErrnoException).code ?? '');
}

function isMissing(error: unknown): boolean {
  return isErrno(error, 'ENOENT');
}

function safeFailureKind(error: unknown): string {
  if (error instanceof AtomicTextFileError) return error.code.toLowerCase();
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return code && /^(?:EACCES|EBUSY|EEXIST|EIO|EISDIR|EMFILE|ENFILE|ENOENT|ENOSPC|ENOTDIR|EPERM|EROFS)$/u.test(code)
    ? `fs_${code.toLowerCase()}`
    : 'operation_failed';
}

function sanitizeError(error: unknown): AtomicTextFileError {
  if (error instanceof AtomicTextFileError) return error;
  return new AtomicTextFileError(
    OPERATION_FAILED_CODE,
    'Atomic text update failed',
    safeFailureKind(error),
  );
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
  const withoutNamespace = platform === 'win32' ? stripWindowsNamespace(path) : path;
  return pathApi(platform).normalize(withoutNamespace);
}

function lockKeyFor(canonicalPath: string, platform = runtime.platform): string {
  const normalized = normalizeCanonicalPath(canonicalPath, platform);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function hashLockKey(lockKey: string): string {
  return createHash('sha256').update(lockKey, 'utf8').digest('hex');
}

async function resolveCanonicalDirectory(directoryPath: string): Promise<string> {
  const api = pathApi();
  const absolutePath = api.resolve(directoryPath);
  const missingSegments: string[] = [];
  let candidate = absolutePath;

  while (true) {
    try {
      const existingPath = normalizeCanonicalPath(await runtime.realpath(candidate));
      return normalizeCanonicalPath(api.join(existingPath, ...missingSegments));
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = api.dirname(candidate);
      if (parent === candidate) return normalizeCanonicalPath(absolutePath);
      missingSegments.unshift(api.basename(candidate));
      candidate = parent;
    }
  }
}

async function resolvePathIdentity(filePath: string): Promise<AtomicTextPathIdentity> {
  const api = pathApi();
  const absolutePath = api.resolve(filePath);
  const canonicalDirectory = await resolveCanonicalDirectory(api.dirname(absolutePath));
  const canonicalPath = normalizeCanonicalPath(api.join(canonicalDirectory, api.basename(absolutePath)));
  const lockKey = lockKeyFor(canonicalPath);
  return {
    canonicalPath,
    lockKey,
    lockPath: api.join(canonicalDirectory, `.${api.basename(canonicalPath)}${SIBLING_LOCK_SUFFIX}`),
    pathHash: hashLockKey(lockKey),
  };
}

function generationFor(content: Buffer | null): TextFileGeneration {
  return content === null
    ? { exists: false }
    : { exists: true, contentHash: createHash('sha256').update(content).digest('hex') };
}

function sameGeneration(left: TextFileGeneration, right: TextFileGeneration): boolean {
  return left.exists === right.exists
    && (!left.exists || (right.exists && left.contentHash === right.contentHash));
}

async function readState(filePath: string): Promise<TextFileState> {
  try {
    const content = await runtime.readBuffer(filePath);
    const mode = (await runtime.stat(filePath)).mode & 0o777;
    return { content, generation: generationFor(content), mode };
  } catch (error) {
    if (isMissing(error)) return { content: null, generation: generationFor(null), mode: null };
    throw error;
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

async function unlinkWithRetry(filePath: string): Promise<void> {
  for (let attempt = 0; attempt <= MAX_LOCK_RELEASE_RETRIES; attempt += 1) {
    try {
      await runtime.unlink(filePath);
      return;
    } catch (error) {
      if (isMissing(error)) return;
      if (isErrno(error, 'EPERM', 'EACCES', 'EBUSY') && attempt < MAX_LOCK_RELEASE_RETRIES) {
        await runtime.sleep(retryDelayMs(attempt + 1, 10, 80));
        continue;
      }
      throw error;
    }
  }
}

async function removeStaleSiblingLock(lockPath: string): Promise<boolean> {
  let raw: string;
  let modifiedAtMs: number;
  try {
    [raw, modifiedAtMs] = await Promise.all([
      runtime.readUtf8(lockPath),
      runtime.stat(lockPath).then((value) => value.mtimeMs),
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
    if (await runtime.readUtf8(lockPath) !== raw) return false;
    await unlinkWithRetry(lockPath);
    return true;
  } catch (error) {
    return isMissing(error);
  }
}

async function acquireSiblingLock(
  identity: AtomicTextPathIdentity,
  createParent: boolean,
): Promise<SiblingLock> {
  const api = pathApi();
  if (createParent) await mkdir(api.dirname(identity.canonicalPath), { recursive: true, mode: 0o700 });
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
      return { handle, lockPath: identity.lockPath, ownerToken };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (handle) await unlinkWithRetry(identity.lockPath).catch(() => undefined);
      if (!isErrno(error, 'EEXIST')) throw error;
      if (await removeStaleSiblingLock(identity.lockPath)) continue;
      if (runtime.now() - startedAt >= LOCK_ACQUIRE_TIMEOUT_MS || attempt === MAX_LOCK_ACQUIRE_ATTEMPTS) {
        throw new AtomicTextFileError(LOCK_TIMEOUT_CODE, 'Timed out waiting for atomic text write lock');
      }
      await runtime.sleep(retryDelayMs(attempt, 10, 100));
    }
  }

  throw new AtomicTextFileError(LOCK_TIMEOUT_CODE, 'Timed out waiting for atomic text write lock');
}

async function lockStillOwned(lock: SiblingLock): Promise<boolean> {
  try {
    const metadata = parseSiblingLockMetadata(await runtime.readUtf8(lock.lockPath));
    return metadata?.ownerToken === lock.ownerToken && metadata.pid === process.pid;
  } catch {
    return false;
  }
}

async function markSiblingLockReleased(lock: SiblingLock): Promise<void> {
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
}

async function releaseSiblingLock(lock: SiblingLock): Promise<void> {
  await markSiblingLockReleased(lock).catch(() => undefined);
  await lock.handle.close().catch(() => undefined);
  try {
    if (await lockStillOwned(lock)) await unlinkWithRetry(lock.lockPath);
  } catch {
    // A released marker lets the next writer safely recover a lock we could not remove.
  }
}

async function withResolvedWriteLock<T>(
  identity: AtomicTextPathIdentity,
  createParent: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = writeQueues.get(identity.lockKey) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const tail = previous.then(() => queueGate);
  writeQueues.set(identity.lockKey, tail);

  await previous;
  let siblingLock: SiblingLock | undefined;
  try {
    siblingLock = await acquireSiblingLock(identity, createParent);
    return await operation();
  } finally {
    try {
      if (siblingLock) await releaseSiblingLock(siblingLock);
    } finally {
      releaseQueue();
      if (writeQueues.get(identity.lockKey) === tail) writeQueues.delete(identity.lockKey);
    }
  }
}

async function renameWithRetry(
  tempPath: string,
  filePath: string,
  expectedGeneration: TextFileGeneration,
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RENAME_RETRIES; attempt += 1) {
    const current = await readState(filePath);
    if (!sameGeneration(current.generation, expectedGeneration)) {
      throw new AtomicTextFileError(TARGET_CHANGED_CODE, 'Atomic text target changed during write');
    }
    try {
      await runtime.rename(tempPath, filePath);
      return;
    } catch (error) {
      if (!isErrno(error, 'EPERM', 'EACCES', 'EBUSY') || attempt === MAX_RENAME_RETRIES) throw error;
      await runtime.sleep(retryDelayMs(attempt + 1, 15, 120));
    }
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // Windows and some filesystems do not support opening or syncing a directory.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function replaceAtomically(
  filePath: string,
  content: Buffer,
  expectedGeneration: TextFileGeneration,
  mode: number,
  createParent: boolean,
): Promise<void> {
  const api = pathApi();
  const directory = api.dirname(filePath);
  if (createParent) await mkdir(directory, { recursive: true, mode: 0o700 });
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
    await renameWithRetry(tempPath, filePath, expectedGeneration);
    committed = true;
    await syncDirectoryBestEffort(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    if (!committed) await unlinkWithRetry(tempPath).catch(() => undefined);
  }
}

export async function updateAtomicTextFile(
  filePath: string,
  transform: (current: string) => string,
  options: AtomicTextFileUpdateOptions = {},
): Promise<AtomicTextFileUpdateResult> {
  try {
    const maxTargetChangeRetries = options.maxTargetChangeRetries ?? 2;
    const createParent = options.createParent !== false;
    if (!Number.isSafeInteger(maxTargetChangeRetries) || maxTargetChangeRetries < 0) {
      throw new AtomicTextFileError(INVALID_OPTIONS_CODE, 'Invalid atomic text retry budget');
    }
    const maxAttempts = maxTargetChangeRetries + 1;
    const identity = await resolvePathIdentity(filePath);
    return await withResolvedWriteLock(identity, createParent, async () => {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const state = await readState(identity.canonicalPath);
        if (state.content && !isUtf8(state.content)) {
          throw new AtomicTextFileError(INVALID_ENCODING_CODE, 'Atomic text target is not valid UTF-8');
        }
        const current = state.content?.toString('utf8') ?? '';
        const next = transform(current);
        if (next === current) return { changed: false, attempts: attempt };

        try {
          await replaceAtomically(
            identity.canonicalPath,
            Buffer.from(next, 'utf8'),
            state.generation,
            state.mode ?? 0o600,
            createParent,
          );
          return { changed: true, attempts: attempt };
        } catch (error) {
          if (!(error instanceof AtomicTextFileError) || error.code !== TARGET_CHANGED_CODE) throw error;
          if (attempt === maxAttempts) {
            throw new AtomicTextFileError(
              RETRY_EXHAUSTED_CODE,
              'Atomic text update retry budget exhausted',
            );
          }
        }
      }

      throw new AtomicTextFileError(RETRY_EXHAUSTED_CODE, 'Atomic text update retry budget exhausted');
    });
  } catch (error) {
    throw sanitizeError(error);
  }
}

export function resetAtomicTextFileStateForTests(): void {
  writeQueues.clear();
  runtime = { ...systemRuntime };
}

export const atomicTextFileTestApi = {
  getWriteQueueCount(): number {
    return writeQueues.size;
  },
  async resolvePathIdentity(filePath: string): Promise<AtomicTextPathIdentity> {
    return resolvePathIdentity(filePath);
  },
  setRuntimeOverrides(overrides: Partial<AtomicTextRuntime>): void {
    runtime = { ...runtime, ...overrides };
  },
};
