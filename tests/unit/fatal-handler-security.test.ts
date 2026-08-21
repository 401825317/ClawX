// @vitest-environment node

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __test, createFatalHandler } from '@electron/main/fatal-handler';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('fatal emergency logging', () => {
  it('writes and captures only allowlisted diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-fatal-security-'));
    temporaryDirectories.push(root);
    const emergencyLog = join(root, 'fatal.log');
    const markers = [
      'UNKEYED_PROMPT_51c9', 'sk-unkeyed-token-8b72', 'session-cookie-unkeyed-34dd',
      'PRIVATE_FILE_BODY_90aa', 'Q:\\workspaces\\private-user\\secret.txt', '\\\\private-server\\users\\secret.txt',
    ];
    const error = Object.assign(new TypeError(markers.join(' ')), { code: 'EPIPE' });
    error.stack = `${markers.join(' ')}\n at fn (${markers[4]}:41:7)\n at fn (${markers[5]}:9:3)`;
    const captureFatal = vi.fn();
    const stopGateway = vi.fn();
    const forceTerminateGateway = vi.fn();
    const stopBlender = vi.fn();
    const handler = createFatalHandler({
      getEmergencyLogPath: () => emergencyLog,
      stopGateway,
      forceTerminateGateway,
      stopBlender,
      captureFatal,
      exit: vi.fn(),
      scheduleExit: vi.fn(),
    });

    expect(handler(`unknown ${markers[0]}`, error)).toBe(true);
    const written = await readFile(emergencyLog, 'utf8');
    const captured = JSON.stringify(captureFatal.mock.calls);
    for (const marker of markers) {
      expect(written).not.toContain(marker);
      expect(captured).not.toContain(marker);
    }
    expect(JSON.parse(written)).toMatchObject({
      level: 'fatal', reason: 'fatal_error', errorName: 'TypeError', errorCode: 'EPIPE',
    });
    expect(Object.keys(JSON.parse(written)).sort()).toEqual([
      'errorCode', 'errorName', 'eventId', 'fingerprint', 'level', 'occurredAt', 'reason',
    ]);
    expect(captureFatal.mock.calls[0][0]).not.toBe(error);
    expect(stopGateway).toHaveBeenCalledTimes(1);
    expect(stopBlender).toHaveBeenCalledTimes(1);
  });

  it('keeps UTF-8 truncation on a complete byte boundary', () => {
    const output = __test.utf8PrefixAtMost(`prefix-${'界🔒'.repeat(20_000)}`, 16 * 1024);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(output).not.toContain('\uFFFD');
  });

  it('handles fatal cleanup, capture, and exit scheduling once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-fatal-once-'));
    temporaryDirectories.push(root);
    const emergencyLog = join(root, 'fatal.log');
    const stopGateway = vi.fn();
    const forceTerminateGateway = vi.fn();
    const stopBlender = vi.fn();
    const captureFatal = vi.fn();
    const exit = vi.fn();
    let scheduled: (() => void) | undefined;
    const handler = createFatalHandler({
      getEmergencyLogPath: () => emergencyLog,
      stopGateway,
      forceTerminateGateway,
      stopBlender,
      captureFatal,
      exit,
      scheduleExit: callback => { scheduled = callback; },
    });
    expect(handler('Uncaught exception in main process', new Error('PRIMARY_MARKER'))).toBe(true);
    expect(handler('Unhandled promise rejection in main process', new Error('SECONDARY_MARKER'))).toBe(false);
    expect(stopGateway).toHaveBeenCalledTimes(1);
    expect(stopBlender).toHaveBeenCalledTimes(1);
    expect(captureFatal).toHaveBeenCalledTimes(1);
    const written = await readFile(emergencyLog, 'utf8');
    expect(written).not.toContain('PRIMARY_MARKER');
    expect(written).not.toContain('SECONDARY_MARKER');
    expect(written).toContain('uncaught_exception');
    scheduled?.();
    expect(forceTerminateGateway).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('contains dependency failures and executes a faulty exit callback only once', async () => {
    vi.useFakeTimers();
    const stopGateway = vi.fn(() => Promise.reject(new Error('stop rejected')));
    const forceTerminateGateway = vi.fn(() => Promise.reject(new Error('force rejected')));
    const stopBlender = vi.fn(() => { throw new Error('blender threw'); });
    const captureFatal = vi.fn(() => Promise.reject(new Error('capture rejected')));
    const exit = vi.fn(() => { throw new Error('exit threw'); });
    const scheduleExit = vi.fn((callback: () => void) => {
      callback();
      callback();
      throw new Error('scheduler threw after invoking callback');
    });
    try {
      const handler = createFatalHandler({
        getEmergencyLogPath: () => { throw new Error('path lookup threw'); },
        stopGateway,
        forceTerminateGateway,
        stopBlender,
        captureFatal,
        exit,
        scheduleExit,
      });

      expect(handler('fatal error', new Error('PRIMARY_MARKER'))).toBe(true);
      expect(handler('fatal error', new Error('SECONDARY_MARKER'))).toBe(false);
      await Promise.resolve();
      await vi.runAllTimersAsync();

      expect(scheduleExit).toHaveBeenCalledTimes(1);
      expect(stopGateway).toHaveBeenCalledTimes(1);
      expect(stopBlender).toHaveBeenCalledTimes(1);
      expect(captureFatal).toHaveBeenCalledTimes(1);
      expect(forceTerminateGateway).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the native timer when an async scheduler rejects', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const handler = createFatalHandler({
      getEmergencyLogPath: () => null,
      stopGateway: vi.fn(),
      stopBlender: vi.fn(),
      exit,
      scheduleExit: vi.fn(() => Promise.reject(new Error('scheduler rejected'))),
    });
    try {
      expect(handler('fatal error', new Error('failure'))).toBe(true);
      await Promise.resolve();
      await vi.runAllTimersAsync();
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
