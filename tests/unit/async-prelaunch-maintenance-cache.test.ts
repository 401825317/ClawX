import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  directoryChildrenSignatureAsync,
  directoryTreeSignatureAsync,
  runCachedPrelaunchMaintenanceTaskAsync,
  scheduleCachedPrelaunchMaintenanceTaskAsync,
} from '@electron/gateway/async-prelaunch-maintenance-cache';

describe('async prelaunch maintenance cache', () => {
  let tempDir: string;
  let cachePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'uclaw-async-prelaunch-cache-'));
    cachePath = join(tempDir, 'gateway-prelaunch-maintenance-cache.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolvePromise: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
  }

  function temporaryCacheFiles(): string[] {
    return readdirSync(tempDir).filter((entry) => entry.endsWith('.tmp'));
  }

  it('awaits a successful task and skips it on the next matching key', async () => {
    const task = vi.fn(async () => true);
    const key = vi.fn(async () => 'plugin-key-v1');

    await expect(runCachedPrelaunchMaintenanceTaskAsync(
      'plugin-maintenance',
      key,
      task,
      { cachePath },
    )).resolves.toEqual({ executed: true, reason: 'cache-miss' });
    await expect(runCachedPrelaunchMaintenanceTaskAsync(
      'plugin-maintenance',
      key,
      task,
      { cachePath },
    )).resolves.toEqual({ executed: false, reason: 'cache-hit' });

    expect(task).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(cachePath, 'utf-8')).tasks['plugin-maintenance'].key)
      .toBe('plugin-key-v1');
    expect(temporaryCacheFiles()).toEqual([]);
  });

  it('does not publish a cache entry when the async task reports failure', async () => {
    const task = vi.fn(async () => false);

    await expect(runCachedPrelaunchMaintenanceTaskAsync(
      'plugin-maintenance',
      async () => 'plugin-key-v1',
      task,
      { cachePath },
    )).resolves.toEqual({ executed: true, reason: 'task-failed' });
    await expect(runCachedPrelaunchMaintenanceTaskAsync(
      'plugin-maintenance',
      async () => 'plugin-key-v1',
      task,
      { cachePath },
    )).resolves.toEqual({ executed: true, reason: 'task-failed' });

    expect(task).toHaveBeenCalledTimes(2);
    expect(existsSync(cachePath)).toBe(false);
    expect(temporaryCacheFiles()).toEqual([]);
  });

  it('runs different tasks concurrently and merges cache writes', async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const secondStarted = deferred();
    const firstTask = vi.fn(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return true;
    });
    const secondTask = vi.fn(async () => {
      secondStarted.resolve();
      return true;
    });
    const equivalentCachePath = join(tempDir, 'nested', '..', 'gateway-prelaunch-maintenance-cache.json');

    const firstRun = runCachedPrelaunchMaintenanceTaskAsync(
      'skills-symlink-cleanup',
      async () => 'skills-v1',
      firstTask,
      { cachePath },
    );
    await firstStarted.promise;
    const secondRun = runCachedPrelaunchMaintenanceTaskAsync(
      'runtime-deps-cleanup',
      async () => 'runtime-v1',
      secondTask,
      { cachePath: equivalentCachePath },
    );
    await secondStarted.promise;
    expect(secondTask).toHaveBeenCalledTimes(1);
    releaseFirst.resolve();
    await expect(Promise.all([firstRun, secondRun])).resolves.toEqual([
      { executed: true, reason: 'cache-miss' },
      { executed: true, reason: 'cache-miss' },
    ]);

    const writtenCache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    expect(writtenCache.tasks['skills-symlink-cleanup'].key).toBe('skills-v1');
    expect(writtenCache.tasks['runtime-deps-cleanup'].key).toBe('runtime-v1');
    expect(temporaryCacheFiles()).toEqual([]);
  });

  it('defers and coalesces a scheduled maintenance task', async () => {
    const task = vi.fn(async () => true);
    const first = scheduleCachedPrelaunchMaintenanceTaskAsync(
      'plugin-install-artifact-cleanup',
      async () => 'artifacts-v1',
      task,
      { cachePath, delayMs: 20 },
    );
    const duplicate = scheduleCachedPrelaunchMaintenanceTaskAsync(
      'plugin-install-artifact-cleanup',
      async () => 'artifacts-v1',
      task,
      { cachePath, delayMs: 20 },
    );

    expect(first.scheduled).toBe(true);
    expect(duplicate.scheduled).toBe(false);
    expect(duplicate.completion).toBe(first.completion);
    expect(task).not.toHaveBeenCalled();
    await expect(first.completion).resolves.toEqual({ executed: true, reason: 'cache-miss' });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent runs of the same task after the first run populates the cache', async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const task = vi.fn(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return true;
    });

    const firstRun = runCachedPrelaunchMaintenanceTaskAsync(
      'plugin-maintenance',
      async () => 'plugin-v1',
      task,
      { cachePath },
    );
    await firstStarted.promise;
    const secondRun = runCachedPrelaunchMaintenanceTaskAsync(
      'plugin-maintenance',
      async () => 'plugin-v1',
      task,
      { cachePath },
    );
    releaseFirst.resolve();

    await expect(Promise.all([firstRun, secondRun])).resolves.toEqual([
      { executed: true, reason: 'cache-miss' },
      { executed: false, reason: 'cache-hit' },
    ]);
    expect(task).toHaveBeenCalledTimes(1);
    expect(temporaryCacheFiles()).toEqual([]);
  });

  it('awaits the fallback task when the initial async key is unavailable', async () => {
    const taskFinished = deferred();
    const task = vi.fn(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      taskFinished.resolve();
      return true;
    });

    await expect(runCachedPrelaunchMaintenanceTaskAsync(
      'plugin-maintenance',
      async () => {
        throw new Error('key unavailable');
      },
      task,
      { cachePath },
    )).resolves.toEqual({ executed: true, reason: 'cache-unavailable' });

    await expect(taskFinished.promise).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(1);
    expect(existsSync(cachePath)).toBe(false);
    expect(temporaryCacheFiles()).toEqual([]);
  });

  it('awaits the fallback task when the cache file is unreadable', async () => {
    writeFileSync(cachePath, '{not-json', 'utf-8');
    const taskFinished = deferred();
    const task = vi.fn(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      taskFinished.resolve();
      return false;
    });

    await expect(runCachedPrelaunchMaintenanceTaskAsync(
      'skills-symlink-cleanup',
      async () => 'skills-v1',
      task,
      { cachePath },
    )).resolves.toEqual({ executed: true, reason: 'task-failed' });

    await expect(taskFinished.promise).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(1);
    expect(readFileSync(cachePath, 'utf-8')).toBe('{not-json');
    expect(temporaryCacheFiles()).toEqual([]);
  });

  it('returns cache-unavailable when the post-task async key fails', async () => {
    const key = vi.fn()
      .mockResolvedValueOnce('before')
      .mockRejectedValueOnce(new Error('post-task key unavailable'));

    await expect(runCachedPrelaunchMaintenanceTaskAsync(
      'runtime-deps-cleanup',
      key,
      async () => true,
      { cachePath },
    )).resolves.toEqual({ executed: true, reason: 'cache-unavailable' });

    expect(key).toHaveBeenCalledTimes(2);
    expect(existsSync(cachePath)).toBe(false);
    expect(temporaryCacheFiles()).toEqual([]);
  });

  it('stores a digest instead of serializing an oversized cache key', async () => {
    const oversizedKey = 'x'.repeat(70 * 1024);
    const task = vi.fn(async () => true);

    await expect(runCachedPrelaunchMaintenanceTaskAsync(
      'plugin-maintenance',
      async () => oversizedKey,
      task,
      { cachePath },
    )).resolves.toEqual({ executed: true, reason: 'cache-miss' });

    const storedKey = JSON.parse(readFileSync(cachePath, 'utf-8')).tasks['plugin-maintenance'].key;
    expect(storedKey).toMatch(/^sha256:[a-f0-9]{64}$/);

    await expect(runCachedPrelaunchMaintenanceTaskAsync(
      'plugin-maintenance',
      async () => oversizedKey,
      task,
      { cachePath },
    )).resolves.toEqual({ executed: false, reason: 'cache-hit' });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('fails open for an oversized cache file before parsing it', async () => {
    writeFileSync(cachePath, 'x'.repeat(300 * 1024), 'utf-8');
    const task = vi.fn(async () => true);

    await expect(runCachedPrelaunchMaintenanceTaskAsync(
      'skills-symlink-cleanup',
      async () => 'skills-v1',
      task,
      { cachePath },
    )).resolves.toEqual({ executed: true, reason: 'cache-unavailable' });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('releases the cache-path queue after a rejected task', async () => {
    await expect(runCachedPrelaunchMaintenanceTaskAsync(
      'plugin-maintenance',
      async () => 'plugin-v1',
      async () => {
        throw new Error('maintenance failed');
      },
      { cachePath },
    )).rejects.toThrow('maintenance failed');

    await expect(runCachedPrelaunchMaintenanceTaskAsync(
      'runtime-deps-cleanup',
      async () => 'runtime-v1',
      async () => true,
      { cachePath },
    )).resolves.toEqual({ executed: true, reason: 'cache-miss' });
    expect(JSON.parse(readFileSync(cachePath, 'utf-8')).tasks['runtime-deps-cleanup'].key)
      .toBe('runtime-v1');
    expect(temporaryCacheFiles()).toEqual([]);
  });

  it('removes its temporary file when the atomic publish fails', async () => {
    const task = vi.fn(async () => {
      mkdirSync(cachePath);
      return true;
    });

    await expect(runCachedPrelaunchMaintenanceTaskAsync(
      'plugin-maintenance',
      async () => 'plugin-v1',
      task,
      { cachePath },
    )).resolves.toEqual({ executed: true, reason: 'cache-unavailable' });

    expect(task).toHaveBeenCalledTimes(1);
    expect(temporaryCacheFiles()).toEqual([]);
  });

  it('yields the event loop while signing a large directory', async () => {
    const pluginsDir = join(tempDir, 'plugins');
    mkdirSync(pluginsDir);
    for (let index = 0; index < 512; index += 1) {
      writeFileSync(join(pluginsDir, `entry-${index}.mjs`), `export default ${index};\n`, 'utf-8');
    }

    const immediateSpy = vi.spyOn(globalThis, 'setImmediate');

    const signature = await directoryChildrenSignatureAsync(pluginsDir);

    expect(immediateSpy.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(signature).not.toBe('missing');
    immediateSpy.mockRestore();
  });

  it('includes children beyond the former 200-entry cutoff', async () => {
    const pluginsDir = join(tempDir, 'many-plugins');
    mkdirSync(pluginsDir);
    for (let index = 0; index < 256; index += 1) {
      writeFileSync(join(pluginsDir, `entry-${index}.mjs`), 'x', 'utf-8');
    }
    const before = await directoryChildrenSignatureAsync(pluginsDir);

    writeFileSync(join(pluginsDir, 'entry-255.mjs'), 'changed-size', 'utf-8');
    const after = await directoryChildrenSignatureAsync(pluginsDir);

    expect(after).not.toBe(before);
  });

  it('invalidates a recursive signature when a deep symlink target changes', async () => {
    const runtimeRoot = join(tempDir, 'runtime-deps');
    const cacheRoot = join(runtimeRoot, 'openclaw-current', 'dist', 'nested');
    const oldTarget = join(tempDir, 'old', 'node_modules', 'openclaw', 'dist', 'runtime.js');
    const newTarget = join(tempDir, 'new', 'node_modules', 'openclaw', 'dist', 'runtime.js');
    mkdirSync(cacheRoot, { recursive: true });
    mkdirSync(join(oldTarget, '..'), { recursive: true });
    mkdirSync(join(newTarget, '..'), { recursive: true });
    writeFileSync(oldTarget, 'old', 'utf-8');
    writeFileSync(newTarget, 'new', 'utf-8');
    const link = join(cacheRoot, 'runtime.js');
    symlinkSync(oldTarget, link, 'file');
    const before = await directoryTreeSignatureAsync(runtimeRoot);

    rmSync(link, { force: true });
    symlinkSync(newTarget, link, 'file');
    const after = await directoryTreeSignatureAsync(runtimeRoot);

    expect(after).not.toBe(before);
  });
});
