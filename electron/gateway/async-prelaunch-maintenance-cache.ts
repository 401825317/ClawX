import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readlink, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import {
  stableJson,
  type PrelaunchMaintenanceRunResult,
  type PrelaunchMaintenanceTaskName,
} from './prelaunch-maintenance-cache';

const CACHE_SCHEMA_VERSION = 1;
const CACHE_FILE_NAME = 'gateway-prelaunch-maintenance-cache.json';
const SIGNATURE_SCHEMA_VERSION = 2;
const SIGNATURE_YIELD_INTERVAL = 64;
const MAX_CACHE_KEY_CHARS = 64 * 1024;
const taskQueues = new Map<string, Promise<void>>();
const cacheWriteQueues = new Map<string, Promise<void>>();
const scheduledTasks = new Map<string, Promise<PrelaunchMaintenanceRunResult>>();

export type AsyncPrelaunchMaintenanceTaskName =
  | PrelaunchMaintenanceTaskName
  | 'plugin-install-artifact-cleanup'
  | 'runtime-deps-deep-audit';

export interface ScheduledPrelaunchMaintenanceTask {
  scheduled: boolean;
  completion: Promise<PrelaunchMaintenanceRunResult>;
}

interface CacheEntry {
  key: string;
  updatedAt: string;
}

interface CacheFile {
  schemaVersion: number;
  tasks: Partial<Record<AsyncPrelaunchMaintenanceTaskName, CacheEntry>>;
}

function emptyCache(): CacheFile {
  return { schemaVersion: CACHE_SCHEMA_VERSION, tasks: {} };
}

function normalizeCachePath(cachePath: string): string {
  const resolvedPath = resolve(cachePath);
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

async function withQueue<T>(
  queues: Map<string, Promise<void>>,
  queueKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(queueKey);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  queues.set(queueKey, current);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(queueKey) === current) {
      queues.delete(queueKey);
    }
  }
}

function taskQueueKey(cachePath: string, taskName: AsyncPrelaunchMaintenanceTaskName): string {
  return `${normalizeCachePath(cachePath)}\0${taskName}`;
}

async function readCache(cachePath: string): Promise<CacheFile | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(cachePath, 'r');
    const info = await handle.stat();
    // Bound the read itself, not only JSON.parse after the allocation.
    if (info.size > MAX_CACHE_KEY_CHARS * 4) return null;
    const contents = await handle.readFile({ encoding: 'utf-8' });
    await yieldToEventLoop();
    const parsed = JSON.parse(contents) as CacheFile;
    if (
      parsed.schemaVersion !== CACHE_SCHEMA_VERSION
      || !parsed.tasks
      || typeof parsed.tasks !== 'object'
      || Array.isArray(parsed.tasks)
    ) return emptyCache();
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyCache();
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeCache(cachePath: string, cache: CacheFile): Promise<boolean> {
  const temporaryPath = join(
    dirname(cachePath),
    `.${CACHE_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let published = false;
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    handle = await open(temporaryPath, 'wx');
    await yieldToEventLoop();
    const serialized = `${JSON.stringify(cache, null, 2)}\n`;
    await handle.writeFile(serialized, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, cachePath);
    published = true;
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published) await unlink(temporaryPath).catch(() => undefined);
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function normalizeCacheKey(key: string): string {
  if (key.length <= MAX_CACHE_KEY_CHARS) return key;
  return `sha256:${createHash('sha256').update(key).digest('hex')}`;
}

async function readPathSignature(filePath: string): Promise<string> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) {
    const target = await readlink(filePath, { encoding: 'utf8' });
    return `symlink:${Math.round(info.mtimeMs)}:${info.size}:${target}`;
  }
  return `${info.isDirectory() ? 'dir' : 'file'}:${Math.round(info.mtimeMs)}:${info.size}`;
}

export async function pathSignatureAsync(filePath: string): Promise<string> {
  try {
    return await readPathSignature(filePath);
  } catch {
    return 'missing';
  }
}

function addOrderIndependentDigest(accumulator: Buffer, value: string): void {
  const digest = createHash('sha256').update(value).digest();
  for (let index = 0; index < accumulator.length; index += 1) {
    accumulator[index] ^= digest[index]!;
  }
}

async function directorySignatureAsync(
  directoryPath: string,
  recursive: boolean,
): Promise<string> {
  const root = resolve(directoryPath);
  const stack = [root];
  const digest = Buffer.alloc(32);
  let entryCount = 0;
  let symlinkCount = 0;

  while (stack.length > 0) {
    const currentDirectory = stack.pop()!;
    let entries;
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
      if (currentDirectory === root && isMissingPathError(error)) return 'missing';
      if (isMissingPathError(error)) continue;
      throw error;
    }

    for (const entry of entries) {
      entryCount += 1;
      if (entryCount % SIGNATURE_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }

      const entryPath = join(currentDirectory, entry.name);
      let info;
      try {
        info = await lstat(entryPath);
      } catch (error) {
        if (isMissingPathError(error)) continue;
        throw error;
      }

      const relativePath = relative(root, entryPath).replace(/\\/g, '/');
      let target = '';
      if (info.isSymbolicLink()) {
        symlinkCount += 1;
        try {
          target = await readlink(entryPath, { encoding: 'utf8' });
        } catch (error) {
          if (isMissingPathError(error)) continue;
          throw error;
        }
      }
      addOrderIndependentDigest(
        digest,
        stableJson({
          path: relativePath,
          type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'dir' : 'file',
          mtimeMs: Math.round(info.mtimeMs),
          size: info.size,
          target,
        }),
      );

      if (recursive && info.isDirectory() && !info.isSymbolicLink()) {
        stack.push(entryPath);
      }
    }
  }

  return stableJson({
    schemaVersion: SIGNATURE_SCHEMA_VERSION,
    recursive,
    entryCount,
    symlinkCount,
    digest: digest.toString('hex'),
  });
}

export function directoryChildrenSignatureAsync(directoryPath: string): Promise<string> {
  return directorySignatureAsync(directoryPath, false);
}

export function directoryTreeSignatureAsync(directoryPath: string): Promise<string> {
  return directorySignatureAsync(directoryPath, true);
}

export async function runCachedPrelaunchMaintenanceTaskAsync(
  taskName: AsyncPrelaunchMaintenanceTaskName,
  cacheKey: () => Promise<string>,
  task: () => Promise<void | boolean>,
  options: { cachePath?: string } = {},
): Promise<PrelaunchMaintenanceRunResult> {
  const cachePath = options.cachePath ?? join(app.getPath('userData'), CACHE_FILE_NAME);
  return withQueue(taskQueues, taskQueueKey(cachePath, taskName), async () => {
    const cache = await readCache(cachePath);
    if (!cache) {
      const taskResult = await task();
      return {
        executed: true,
        reason: taskResult === false ? 'task-failed' : 'cache-unavailable',
      };
    }

    let initialCacheKey: string;
    try {
      initialCacheKey = await cacheKey();
    } catch {
      const taskResult = await task();
      return {
        executed: true,
        reason: taskResult === false ? 'task-failed' : 'cache-unavailable',
      };
    }
    const normalizedInitialCacheKey = normalizeCacheKey(initialCacheKey);
    if (cache.tasks[taskName]?.key === normalizedInitialCacheKey) {
      return { executed: false, reason: 'cache-hit' };
    }

    const taskResult = await task();
    if (taskResult === false) return { executed: true, reason: 'task-failed' };

    let finalCacheKey: string;
    try {
      finalCacheKey = await cacheKey();
    } catch {
      return { executed: true, reason: 'cache-unavailable' };
    }
    const cachePublished = await withQueue(
      cacheWriteQueues,
      normalizeCachePath(cachePath),
      async () => {
        // Different maintenance tasks may scan concurrently. Re-read under the
        // narrow publish lock so the final writer merges, rather than erases,
        // entries produced by another task.
        const latestCache = await readCache(cachePath);
        if (!latestCache) return false;
        latestCache.tasks[taskName] = {
          key: normalizeCacheKey(finalCacheKey),
          updatedAt: new Date().toISOString(),
        };
        return writeCache(cachePath, latestCache);
      },
    );
    return {
      executed: true,
      reason: cachePublished ? 'cache-miss' : 'cache-unavailable',
    };
  });
}

/**
 * Defer best-effort maintenance until after launch-context preparation has
 * yielded back to its caller. The timer is unref'd, same-task schedules are
 * coalesced, and failures resolve to task-failed so ignored completions never
 * create an unhandled rejection.
 */
export function scheduleCachedPrelaunchMaintenanceTaskAsync(
  taskName: AsyncPrelaunchMaintenanceTaskName,
  cacheKey: () => Promise<string>,
  task: () => Promise<void | boolean>,
  options: {
    cachePath?: string;
    delayMs?: number;
    onComplete?: (result: PrelaunchMaintenanceRunResult) => void;
    onError?: (error: unknown) => void;
  } = {},
): ScheduledPrelaunchMaintenanceTask {
  const cachePath = options.cachePath ?? join(app.getPath('userData'), CACHE_FILE_NAME);
  const scheduleKey = taskQueueKey(cachePath, taskName);
  const existing = scheduledTasks.get(scheduleKey);
  if (existing) return { scheduled: false, completion: existing };

  let resolveCompletion: (result: PrelaunchMaintenanceRunResult) => void = () => undefined;
  const completion = new Promise<PrelaunchMaintenanceRunResult>((resolve) => {
    resolveCompletion = resolve;
  });
  scheduledTasks.set(scheduleKey, completion);

  const requestedDelayMs = options.delayMs ?? 0;
  const delayMs = Number.isFinite(requestedDelayMs) && requestedDelayMs > 0
    ? requestedDelayMs
    : 0;
  const timer = setTimeout(() => {
    void runCachedPrelaunchMaintenanceTaskAsync(taskName, cacheKey, task, { cachePath })
      .then((result) => {
        try {
          options.onComplete?.(result);
        } catch {
          // A diagnostic callback cannot change maintenance completion.
        }
        resolveCompletion(result);
      })
      .catch((error) => {
        try {
          options.onError?.(error);
        } catch {
          // A diagnostic callback cannot create an unhandled rejection.
        }
        resolveCompletion({ executed: true, reason: 'task-failed' });
      })
      .finally(() => {
        if (scheduledTasks.get(scheduleKey) === completion) {
          scheduledTasks.delete(scheduleKey);
        }
      });
  }, delayMs);
  timer.unref?.();

  return { scheduled: true, completion };
}
