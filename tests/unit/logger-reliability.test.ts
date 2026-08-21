// @vitest-environment node

import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appendFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getVersion: () => 'test',
    isPackaged: false,
  },
}));

vi.mock('fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs/promises')>(),
  appendFile: mocks.appendFile,
  readdir: mocks.readdir,
  stat: mocks.stat,
  unlink: mocks.unlink,
}));

import { __test, initLogger, logger } from '@electron/utils/logger';

describe('logger flush reliability', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.appendFile.mockReset().mockResolvedValue(undefined);
    mocks.readdir.mockReset().mockResolvedValue([]);
    mocks.stat.mockReset().mockResolvedValue({ size: 0 });
    mocks.unlink.mockReset().mockResolvedValue(undefined);
    initLogger();
  });

  afterEach(() => {
    __test.flushBufferSync();
    vi.useRealTimers();
  });

  it('retains a failed batch and retries it in FIFO order', async () => {
    mocks.appendFile.mockRejectedValueOnce(new Error('temporary disk failure'));
    logger.info('retryable log line');

    await __test.flushBuffer();

    expect(__test.getFlushState().bufferedLines).toHaveLength(1);
    expect(__test.getFlushState().bufferedLines[0]).toContain('retryable log line');
    expect(mocks.appendFile).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();

    expect(mocks.appendFile).toHaveBeenCalledTimes(2);
    expect(__test.getFlushState().bufferedLines).toEqual([]);
    expect(__test.getFlushState().retryCount).toBe(0);
  });

  it('stops automatic retries after the bounded retry limit without dropping the batch', async () => {
    mocks.appendFile.mockRejectedValue(new Error('persistent disk failure'));
    logger.info('retained after retries');

    await __test.flushBuffer();
    await vi.runAllTimersAsync();

    expect(mocks.appendFile).toHaveBeenCalledTimes(3);
    expect(__test.getFlushState().bufferedLines).toHaveLength(1);
    expect(__test.getFlushState().bufferedLines[0]).toContain('retained after retries');
    expect(__test.getFlushState().retryCount).toBe(3);
  });

  it('retries only the unwritten tail after a batch fails partway through', async () => {
    mocks.appendFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second append failed'))
      .mockResolvedValueOnce(undefined);
    logger.info('first batch line');
    logger.info('second batch line');

    await __test.flushBuffer();

    const retained = __test.getFlushState().bufferedLines;
    expect(retained).toHaveLength(1);
    expect(retained[0]).toContain('second batch line');
    expect(retained[0]).not.toContain('first batch line');

    await vi.runAllTimersAsync();

    const written = mocks.appendFile.mock.calls.map((call) => String(call[1]));
    expect(written.filter(line => line.includes('first batch line'))).toHaveLength(1);
    expect(written.filter(line => line.includes('second batch line'))).toHaveLength(2);
    expect(__test.getFlushState().bufferedLines).toEqual([]);
  });

  it('rotates before appending a line that would exceed the file limit', async () => {
    const initialPath = logger.getLogFilePath();
    expect(initialPath).not.toBeNull();
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    mocks.stat.mockImplementation(async (path) => (
      String(path) === initialPath
        ? { size: __test.maxLogFileBytes }
        : realFs.stat(path)
    ));
    logger.info('rotation boundary line');

    await __test.flushBuffer();

    const rotatedPath = logger.getLogFilePath();
    expect(rotatedPath).not.toBe(initialPath);
    expect(mocks.appendFile).toHaveBeenCalledWith(
      rotatedPath,
      expect.stringContaining('rotation boundary line'),
    );
  });

  it('keeps pending and recent log memory within hard byte limits with one aggregate summary', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const payload = 'x'.repeat(300 * 1024);

    for (let index = 0; index < 20; index += 1) logger.info(`bounded-${index}-${payload}`);

    const state = __test.getFlushState();
    expect(state.bufferedBytes + state.inFlightBytes).toBeLessThanOrEqual(__test.maxPendingLogBytes);
    expect(state.recentBytes).toBeLessThanOrEqual(__test.maxRecentLogBytes);
    expect(state.droppedCount).toBeGreaterThan(0);
    const summaries = logger.getRecentLogs().filter(line => line.includes('[log-buffer] dropped'));
    expect(summaries).toHaveLength(1);
    expect(logger.getRecentLogs().filter(line => line.includes('[log-buffer] dropped'))).toHaveLength(1);
  });

  it('does not subtract bytes when deleting an old log fails', async () => {
    const currentPath = logger.getLogFilePath();
    expect(currentPath).not.toBeNull();
    const currentName = basename(currentPath!);
    const oldNames = [1, 2, 3, 4].map(index => `clawx-2026-08-0${index}.log`);
    const currentSize = __test.maxLogFileBytes - 1024;
    const oldSize = (__test.maxLogDirectoryBytes - currentSize) / oldNames.length;
    mocks.readdir.mockResolvedValue([currentName, ...oldNames]);
    mocks.stat.mockImplementation(async path => ({
      size: String(path) === currentPath ? currentSize : oldSize,
      mtimeMs: String(path) === currentPath ? Date.now() : 0,
    }));
    mocks.unlink.mockRejectedValue(new Error('locked log file'));
    mocks.appendFile.mockClear();

    logger.info('must not exceed directory budget');
    await __test.flushBuffer();

    expect(mocks.unlink).toHaveBeenCalled();
    expect(mocks.appendFile).not.toHaveBeenCalled();
    expect(__test.getFlushState().bufferedLines.at(-1)).toContain('must not exceed directory budget');
  });

  it('flushes a pending duplicate summary during exit-time draining', () => {
    vi.useFakeTimers();
    logger.error('exit duplicate', { traceId: 'exit-trace', attempt: 1 });
    logger.error('exit duplicate', { traceId: 'exit-trace', attempt: 1 });

    __test.flushForExit();

    expect(logger.getRecentLogs().slice(-1)[0]).toMatch(/\[duplicate-error\].*count=2/u);
    vi.useRealTimers();
  });

  it('synchronously writes an in-flight batch during exit-time draining', async () => {
    let resolveAppend: (() => void) | undefined;
    mocks.appendFile.mockImplementation(() => new Promise<void>((resolve) => {
      resolveAppend = resolve;
    }));
    logger.info('in-flight exit recovery');

    const pendingFlush = __test.flushBuffer();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.appendFile).toHaveBeenCalledTimes(1);
    expect(__test.getFlushState().inFlightLines).toHaveLength(1);

    __test.flushBufferSync();
    const path = logger.getLogFilePath();
    expect(path).not.toBeNull();
    expect(await readFile(path!, 'utf8')).toContain('in-flight exit recovery');
    expect(__test.getFlushState().inFlightLines).toEqual([]);
    expect(__test.getFlushState().bufferedLines).toEqual([]);

    resolveAppend?.();
    await pendingFlush;
  });
});
