// @vitest-environment node

import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import vm from 'node:vm';
import { utilityProcess } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { captureGatewayProcessException } from '@electron/utils/telemetry';

const {
  mockClearGatewayOwnershipRecordIfMatches,
  mockCreateGatewayOwnershipRecord,
  mockInspectWindowsGatewayProcess,
  mockMarkOwnedGatewayChildExited,
  mockRegisterOwnedGatewayChildMetadata,
  mockTrackOwnedGatewayChild,
  mockWriteGatewayOwnershipRecord,
} = vi.hoisted(() => ({
  mockClearGatewayOwnershipRecordIfMatches: vi.fn(),
  mockCreateGatewayOwnershipRecord: vi.fn(),
  mockInspectWindowsGatewayProcess: vi.fn(),
  mockMarkOwnedGatewayChildExited: vi.fn(),
  mockRegisterOwnedGatewayChildMetadata: vi.fn(),
  mockTrackOwnedGatewayChild: vi.fn(),
  mockWriteGatewayOwnershipRecord: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/clawx-test',
    isPackaged: true,
  },
  utilityProcess: {
    fork: vi.fn(),
  },
}));

vi.mock('@electron/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@electron/utils/telemetry', () => ({
  captureHandledException: vi.fn(),
  captureGatewayProcessException: vi.fn(),
}));

vi.mock('@electron/utils/paths', () => ({
  appendNodeRequireToNodeOptions: (value: string | undefined, requiredPath: string) => (
    `${value ? `${value} ` : ''}--require=${requiredPath}`
  ),
}));

vi.mock('@electron/gateway/gateway-ownership', () => ({
  clearGatewayOwnershipRecordIfMatches: mockClearGatewayOwnershipRecordIfMatches,
  createGatewayOwnershipRecord: mockCreateGatewayOwnershipRecord,
  inspectWindowsGatewayProcess: mockInspectWindowsGatewayProcess,
  markOwnedGatewayChildExited: mockMarkOwnedGatewayChildExited,
  registerOwnedGatewayChildMetadata: mockRegisterOwnedGatewayChildMetadata,
  trackOwnedGatewayChild: mockTrackOwnedGatewayChild,
  writeGatewayOwnershipRecord: mockWriteGatewayOwnershipRecord,
}));

import { buildGatewayRuntimeEnv } from '@electron/gateway/process-launcher';

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return match ? headers[match] : undefined;
}

function createGatewayFetchContext(fetch: ReturnType<typeof vi.fn>) {
  return {
    fetch,
    URL,
    process: {
      platform: 'win32',
      execPath: 'C:\\Program Files\\ClawX\\ClawX.exe',
      env: {
        CLAWX_UCLAW_ORIGIN: 'https://zz-cn.example.com',
        CLAWX_UCLAW_DIAGNOSTIC_HEADERS: JSON.stringify({ 'X-UClaw-Version': '2.0.3' }),
      },
    },
    require: (id: string) => {
      if (id === 'node:crypto') return { randomUUID: () => 'request-id' };
      if (id === 'node:child_process') return {
        spawn: vi.fn(), exec: vi.fn(), execFile: vi.fn(), fork: vi.fn(),
        spawnSync: vi.fn(), execSync: vi.fn(), execFileSync: vi.fn(),
      };
      if (id === 'node:module') return { syncBuiltinESMExports: vi.fn() };
      throw new Error(`Unexpected require: ${id}`);
    },
  };
}

describe('Gateway process wrapper', () => {
  it('writes an opaque ownership record after spawn and clears only that record on exit', async () => {
    const { launchGatewayProcess } = await import('@electron/gateway/process-launcher');
    const child = new EventEmitter() as EventEmitter & { pid: number; stderr: EventEmitter };
    child.pid = 34567;
    child.stderr = new EventEmitter();
    vi.mocked(utilityProcess.fork).mockReturnValueOnce(child as never);
    mockInspectWindowsGatewayProcess.mockResolvedValue({
      processId: 34567,
      creationIdentity: 'created-34567',
      commandIdentityHash: 'b'.repeat(64),
    });
    const record = {
      version: 1,
      pid: 34567,
      processCreationIdentity: 'created-34567',
      runtimeRoot: '/tmp/openclaw',
      launchNonce: 'nonce-test-1234',
      tokenHash: 'a'.repeat(64),
      createdAt: 1,
    };
    mockCreateGatewayOwnershipRecord.mockResolvedValue(record);
    mockWriteGatewayOwnershipRecord.mockResolvedValue(undefined);
    mockClearGatewayOwnershipRecordIfMatches.mockResolvedValue(true);

    const launch = launchGatewayProcess({
      port: 18789,
      launchContext: {
        appSettings: {} as never,
        openclawDir: '/tmp/openclaw',
        entryScript: '/tmp/openclaw/openclaw.mjs',
        gatewayArgs: ['gateway', '--port', '18789'],
        forkEnv: { PATH: '/usr/bin', OPENCLAW_GATEWAY_TOKEN: 'test-token-never-persisted' },
        mode: 'packaged',
        binPathExists: true,
        loadedProviderKeyCount: 1,
        proxySummary: 'disabled',
        channelStartupSummary: 'skipped',
      },
      sanitizeSpawnArgs: (args) => args,
      getCurrentState: () => 'starting',
      getShouldReconnect: () => false,
      onStderrLine: vi.fn(),
      onSpawn: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    child.emit('spawn');
    await launch;

    await vi.waitFor(() => {
      expect(mockCreateGatewayOwnershipRecord).toHaveBeenCalledWith(expect.objectContaining({
        pid: 34567,
        processCreationIdentity: 'created-34567',
        runtimeRoot: '/tmp/openclaw',
      }));
      expect(mockWriteGatewayOwnershipRecord).toHaveBeenCalledWith(record);
    });
    expect(mockTrackOwnedGatewayChild).toHaveBeenCalledWith(child);
    expect(mockRegisterOwnedGatewayChildMetadata).toHaveBeenCalledWith(child, {
      record,
      processIdentity: expect.objectContaining({
        processId: 34567,
        creationIdentity: 'created-34567',
      }),
      port: 18789,
    });
    expect(JSON.stringify(record)).not.toContain('test-token-never-persisted');

    child.emit('exit', 0);
    expect(mockMarkOwnedGatewayChildExited).toHaveBeenCalledWith(child);
    await vi.waitFor(() => expect(mockClearGatewayOwnershipRecordIfMatches).toHaveBeenCalledWith(record));
  });

  it('does not hold launch behind optional Windows ownership inspection', async () => {
    const { launchGatewayProcess } = await import('@electron/gateway/process-launcher');
    const child = new EventEmitter() as EventEmitter & { pid: number; stderr: EventEmitter };
    child.pid = 45678;
    child.stderr = new EventEmitter();
    vi.mocked(utilityProcess.fork).mockReturnValueOnce(child as never);
    let finishInspection!: (value: null) => void;
    mockInspectWindowsGatewayProcess.mockImplementationOnce(async () => (
      await new Promise<null>((resolve) => { finishInspection = resolve; })
    ));
    const onSpawn = vi.fn();
    const onExit = vi.fn();

    const launch = launchGatewayProcess({
      port: 18789,
      launchContext: {
        appSettings: {} as never,
        openclawDir: '/tmp/openclaw',
        entryScript: '/tmp/openclaw/openclaw.mjs',
        gatewayArgs: ['gateway', '--port', '18789'],
        forkEnv: { PATH: '/usr/bin', OPENCLAW_GATEWAY_TOKEN: 'test-token' },
        mode: 'packaged',
        binPathExists: true,
        loadedProviderKeyCount: 1,
        proxySummary: 'disabled',
        channelStartupSummary: 'skipped',
      },
      sanitizeSpawnArgs: (args) => args,
      getCurrentState: () => 'starting',
      getShouldReconnect: () => true,
      onStderrLine: vi.fn(),
      onSpawn,
      onExit,
      onError: vi.fn(),
    });

    child.emit('spawn');
    await expect(launch).resolves.toMatchObject({ child });
    expect(onSpawn).toHaveBeenCalledWith(45678);

    child.emit('exit', 1);
    child.stderr.emit('end');
    expect(onExit).toHaveBeenCalledWith(child, 1);
    finishInspection(null);
  });

  it('buffers split stderr chunks into complete lines', async () => {
    const { launchGatewayProcess } = await import('@electron/gateway/process-launcher');
    const child = new EventEmitter() as EventEmitter & { pid: number; stderr: EventEmitter };
    child.pid = 56789;
    child.stderr = new EventEmitter();
    vi.mocked(utilityProcess.fork).mockReturnValueOnce(child as never);
    const onStderrLine = vi.fn();

    const launch = launchGatewayProcess({
      port: 18789,
      launchContext: {
        appSettings: {} as never,
        openclawDir: '/tmp/openclaw',
        entryScript: '/tmp/openclaw/openclaw.mjs',
        gatewayArgs: ['gateway', '--port', '18789'],
        forkEnv: { PATH: '/usr/bin' },
        mode: 'packaged',
        binPathExists: true,
        loadedProviderKeyCount: 1,
        proxySummary: 'disabled',
        channelStartupSummary: 'skipped',
      },
      sanitizeSpawnArgs: (args) => args,
      getCurrentState: () => 'starting',
      getShouldReconnect: () => true,
      onStderrLine,
      onSpawn: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    child.emit('spawn');
    await launch;
    child.stderr.emit('data', 'Error [ERR_PACKAGE_IMPORT_');
    child.stderr.emit('data', 'NOT_DEFINED]: package import failed\nnext line');

    expect(onStderrLine).toHaveBeenCalledTimes(1);
    expect(onStderrLine).toHaveBeenCalledWith(
      'Error [ERR_PACKAGE_IMPORT_NOT_DEFINED]: package import failed',
    );

    child.stderr.emit('end');
    expect(onStderrLine).toHaveBeenNthCalledWith(2, 'next line');
  });

  it('flushes stderr before notifying exit and ignores duplicate exit events', async () => {
    const { launchGatewayProcess } = await import('@electron/gateway/process-launcher');
    const child = new EventEmitter() as EventEmitter & { pid: number; stderr: EventEmitter };
    child.pid = 67890;
    child.stderr = new EventEmitter();
    vi.mocked(utilityProcess.fork).mockReturnValueOnce(child as never);
    const events: string[] = [];
    const onStderrLine = vi.fn((line: string) => events.push(`stderr:${line}`));
    const onExit = vi.fn(() => events.push('exit'));

    const launch = launchGatewayProcess({
      port: 18789,
      launchContext: {
        appSettings: {} as never,
        openclawDir: '/tmp/openclaw',
        entryScript: '/tmp/openclaw/openclaw.mjs',
        gatewayArgs: ['gateway', '--port', '18789'],
        forkEnv: { PATH: '/usr/bin' },
        mode: 'packaged',
        binPathExists: true,
        loadedProviderKeyCount: 1,
        proxySummary: 'disabled',
        channelStartupSummary: 'skipped',
      },
      sanitizeSpawnArgs: (args) => args,
      getCurrentState: () => 'starting',
      getShouldReconnect: () => true,
      onStderrLine,
      onSpawn: vi.fn(),
      onExit,
      onError: vi.fn(),
    });

    child.emit('spawn');
    await launch;
    child.stderr.emit('data', 'tail emitted before stream close');
    child.emit('exit', 1);

    expect(onExit).not.toHaveBeenCalled();
    child.stderr.emit('close');
    child.emit('exit', 1);

    expect(events).toEqual(['stderr:tail emitted before stream close', 'exit']);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('uses a bounded stderr drain timeout when the stream never closes', async () => {
    vi.useFakeTimers();
    try {
      const { launchGatewayProcess } = await import('@electron/gateway/process-launcher');
      const child = new EventEmitter() as EventEmitter & { pid: number; stderr: EventEmitter };
      child.pid = 67891;
      child.stderr = new EventEmitter();
      vi.mocked(utilityProcess.fork).mockReturnValueOnce(child as never);
      const onStderrLine = vi.fn();
      const onExit = vi.fn();

      const launch = launchGatewayProcess({
        port: 18789,
        launchContext: {
          appSettings: {} as never,
          openclawDir: '/tmp/openclaw',
          entryScript: '/tmp/openclaw/openclaw.mjs',
          gatewayArgs: ['gateway', '--port', '18789'],
          forkEnv: { PATH: '/usr/bin' },
          mode: 'packaged',
          binPathExists: true,
          loadedProviderKeyCount: 1,
          proxySummary: 'disabled',
          channelStartupSummary: 'skipped',
        },
        sanitizeSpawnArgs: (args) => args,
        getCurrentState: () => 'starting',
        getShouldReconnect: () => true,
        onStderrLine,
        onSpawn: vi.fn(),
        onExit,
        onError: vi.fn(),
      });

      child.emit('spawn');
      await launch;
      child.stderr.emit('data', 'stderr tail without close');
      child.emit('exit', 1);

      expect(onExit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(99);
      expect(onExit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(onStderrLine).toHaveBeenCalledWith('stderr tail without close');
      expect(onExit).toHaveBeenCalledTimes(1);
      child.stderr.emit('end');
      child.stderr.emit('close');
      expect(onExit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the original pre-spawn error with its concrete child and only reports it once', async () => {
    const { launchGatewayProcess } = await import('@electron/gateway/process-launcher');
    const child = new EventEmitter() as EventEmitter & { pid: number; stderr: EventEmitter };
    child.pid = 78901;
    child.stderr = new EventEmitter();
    vi.mocked(utilityProcess.fork).mockReturnValueOnce(child as never);
    const onError = vi.fn();
    const originalError = new Error('spawn failed before spawn event');

    const launch = launchGatewayProcess({
      port: 18789,
      launchContext: {
        appSettings: {} as never,
        openclawDir: '/tmp/openclaw',
        entryScript: '/tmp/openclaw/openclaw.mjs',
        gatewayArgs: ['gateway', '--port', '18789'],
        forkEnv: { PATH: '/usr/bin' },
        mode: 'packaged',
        binPathExists: true,
        loadedProviderKeyCount: 1,
        proxySummary: 'disabled',
        channelStartupSummary: 'skipped',
      },
      sanitizeSpawnArgs: (args) => args,
      getCurrentState: () => 'starting',
      getShouldReconnect: () => true,
      onStderrLine: vi.fn(),
      onSpawn: vi.fn(),
      onExit: vi.fn(),
      onError,
    });

    child.emit('error', originalError);
    child.emit('error', new Error('duplicate spawn error'));

    await expect(launch).rejects.toBe(originalError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(child, originalError);
  });

  it('injects trusted diagnostics only for the exact UClaw origin and rotates request ids', async () => {
    const { buildGatewayFetchPreloadSource } = await import('@electron/gateway/process-launcher');
    const fetch = vi.fn((_input: unknown, init: unknown) => Promise.resolve(init));
    const randomUUID = vi.fn()
      .mockReturnValueOnce('request-id-1')
      .mockReturnValueOnce('request-id-2');
    const childProcess = {
      spawn: vi.fn(),
      exec: vi.fn(),
      execFile: vi.fn(),
      fork: vi.fn(),
      spawnSync: vi.fn(),
      execSync: vi.fn(),
      execFileSync: vi.fn(),
    };
    const context = {
      fetch,
      URL,
      process: {
        platform: 'win32',
        execPath: 'C:\\Program Files\\ClawX\\ClawX.exe',
        env: {
          CLAWX_UCLAW_ORIGIN: 'https://zz-cn.example.com',
          CLAWX_UCLAW_DIAGNOSTIC_HEADERS: JSON.stringify({
            'X-UClaw-Version': '2.0.3',
            'X-UClaw-Build-Id': 'trusted-build',
          }),
        },
      },
      require: (id: string) => {
        if (id === 'node:crypto') return { randomUUID };
        if (id === 'node:child_process') return childProcess;
        if (id === 'node:module') return { syncBuiltinESMExports: vi.fn() };
        throw new Error(`Unexpected require: ${id}`);
      },
    };
    vm.runInNewContext(buildGatewayFetchPreloadSource(), context);

    await context.fetch('https://zz-cn.example.com/v1/responses', {
      headers: {
        'x-uclaw-version': 'spoofed',
        'X-Request-Id': 'reused',
      },
    });
    await context.fetch('https://zz-cn.example.com/v1/videos', {});
    await context.fetch('https://zz-cn.example.com.evil.test/v1/responses', {});

    const firstHeaders = fetch.mock.calls[0]?.[1] as { headers: Record<string, string> };
    const secondHeaders = fetch.mock.calls[1]?.[1] as { headers: Record<string, string> };
    expect(firstHeaders.headers).toMatchObject({
      'X-UClaw-Version': '2.0.3',
      'X-UClaw-Build-Id': 'trusted-build',
      'X-Request-Id': 'request-id-1',
    });
    expect(Object.keys(firstHeaders.headers)).not.toContain('x-uclaw-version');
    expect(secondHeaders.headers['X-Request-Id']).toBe('request-id-2');
    expect(fetch.mock.calls[2]?.[1]).toEqual({});
  });

  it('follows only same-origin redirects without leaking managed diagnostics', async () => {
    const { buildGatewayFetchPreloadSource } = await import('@electron/gateway/process-launcher');
    const headers = (location?: string) => ({ get: (name: string) => name.toLowerCase() === 'location' ? location ?? null : null });
    const fetch = vi.fn()
      .mockResolvedValueOnce({ status: 302, headers: headers('/v1/next') })
      .mockResolvedValueOnce({ status: 200, headers: headers() })
      .mockResolvedValueOnce({ status: 302, headers: headers('https://evil.example/v1/leak') });
    const context = {
      fetch,
      URL,
      process: {
        platform: 'win32',
        execPath: 'C:\\Program Files\\ClawX\\ClawX.exe',
        env: {
          CLAWX_UCLAW_ORIGIN: 'https://zz-cn.example.com',
          CLAWX_UCLAW_DIAGNOSTIC_HEADERS: JSON.stringify({ 'X-UClaw-Version': '2.0.3' }),
        },
      },
      require: (id: string) => {
        if (id === 'node:crypto') return { randomUUID: () => 'request-id' };
        if (id === 'node:child_process') return {
          spawn: vi.fn(), exec: vi.fn(), execFile: vi.fn(), fork: vi.fn(),
          spawnSync: vi.fn(), execSync: vi.fn(), execFileSync: vi.fn(),
        };
        if (id === 'node:module') return { syncBuiltinESMExports: vi.fn() };
        throw new Error(`Unexpected require: ${id}`);
      },
    };
    vm.runInNewContext(buildGatewayFetchPreloadSource(), context);

    await context.fetch('https://zz-cn.example.com/v1/responses', {});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe('https://zz-cn.example.com/v1/next');
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      redirect: 'manual',
      headers: expect.objectContaining({ 'X-UClaw-Version': '2.0.3' }),
    });

    const blocked = await context.fetch('https://zz-cn.example.com/v1/cross-origin', {});
    expect(blocked.status).toBe(302);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.some(([input]) => String(input).startsWith('https://evil.example'))).toBe(false);
  });

  it.each([301, 302, 303])(
    'converts Gateway POST to GET and removes entity headers after a %i redirect',
    async (status) => {
      const { buildGatewayFetchPreloadSource } = await import('@electron/gateway/process-launcher');
      const headers = (location?: string) => ({
        get: (name: string) => name.toLowerCase() === 'location' ? location ?? null : null,
      });
      const fetch = vi.fn()
        .mockResolvedValueOnce({ status, headers: headers('/v1/next') })
        .mockResolvedValueOnce({ status: 200, headers: headers() });
      const context = createGatewayFetchContext(fetch);
      vm.runInNewContext(buildGatewayFetchPreloadSource(), context);

      await context.fetch('https://zz-cn.example.com/v1/responses', {
        method: 'POST',
        body: 'request-body',
        headers: {
          Authorization: 'Bearer managed-secret',
          'Content-Length': '12',
          'Content-Type': 'application/json',
          'X-Correlation': 'preserved',
        },
      });

      const redirectedInit = fetch.mock.calls[1]?.[1] as {
        method?: string;
        body?: unknown;
        headers: Record<string, string>;
      };
      expect(redirectedInit.method).toBe('GET');
      expect(redirectedInit.body).toBeUndefined();
      expect(headerValue(redirectedInit.headers, 'content-length')).toBeUndefined();
      expect(headerValue(redirectedInit.headers, 'content-type')).toBeUndefined();
      expect(headerValue(redirectedInit.headers, 'authorization')).toBe('Bearer managed-secret');
      expect(headerValue(redirectedInit.headers, 'x-correlation')).toBe('preserved');
    },
  );

  it.each([307, 308])('preserves Gateway POST method and body after a %i redirect', async (status) => {
    const { buildGatewayFetchPreloadSource } = await import('@electron/gateway/process-launcher');
    const headers = (location?: string) => ({
      get: (name: string) => name.toLowerCase() === 'location' ? location ?? null : null,
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce({ status, headers: headers('/v1/next') })
      .mockResolvedValueOnce({ status: 200, headers: headers() });
    const context = createGatewayFetchContext(fetch);
    vm.runInNewContext(buildGatewayFetchPreloadSource(), context);

    await context.fetch('https://zz-cn.example.com/v1/responses', {
      method: 'POST',
      body: 'request-body',
      headers: {
        'Content-Length': '12',
        'Content-Type': 'application/json',
      },
    });

    const redirectedInit = fetch.mock.calls[1]?.[1] as {
      method?: string;
      body?: unknown;
      headers: Record<string, string>;
    };
    expect(redirectedInit.method).toBe('POST');
    expect(redirectedInit.body).toBe('request-body');
    expect(headerValue(redirectedInit.headers, 'content-length')).toBe('12');
    expect(headerValue(redirectedInit.headers, 'content-type')).toBe('application/json');
  });

  it('returns Gateway redirect responses for invalid or cross-origin Location values', async () => {
    const { buildGatewayFetchPreloadSource } = await import('@electron/gateway/process-launcher');
    const headers = (location?: string) => ({
      get: (name: string) => name.toLowerCase() === 'location' ? location ?? null : null,
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce({ status: 302, headers: headers('http://[invalid') })
      .mockResolvedValueOnce({ status: 302, headers: headers('https://evil.example/v1/leak') });
    const context = createGatewayFetchContext(fetch);
    vm.runInNewContext(buildGatewayFetchPreloadSource(), context);

    const invalid = await context.fetch('https://zz-cn.example.com/v1/invalid', {
      headers: { Authorization: 'Bearer managed-secret' },
    });
    const crossOrigin = await context.fetch('https://zz-cn.example.com/v1/cross-origin', {
      headers: { Authorization: 'Bearer managed-secret' },
    });

    expect(invalid.status).toBe(302);
    expect(crossOrigin.status).toBe(302);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.some(([input]) => String(input).startsWith('https://evil.example'))).toBe(false);
  });

  it('stops Gateway redirect loops after five redirects', async () => {
    const { buildGatewayFetchPreloadSource } = await import('@electron/gateway/process-launcher');
    const headers = (location?: string) => ({
      get: (name: string) => name.toLowerCase() === 'location' ? location ?? null : null,
    });
    const fetch = vi.fn();
    for (let index = 0; index < 6; index += 1) {
      fetch.mockResolvedValueOnce({ status: 302, headers: headers('/v1/loop') });
    }
    const context = createGatewayFetchContext(fetch);
    vm.runInNewContext(buildGatewayFetchPreloadSource(), context);

    const response = await context.fetch('https://zz-cn.example.com/v1/loop', {});

    expect(response.status).toBe(302);
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(fetch.mock.calls.every(([input]) => String(input) === 'https://zz-cn.example.com/v1/loop')).toBe(true);
  });

  it('stops Gateway redirect chains after five redirects', async () => {
    const { buildGatewayFetchPreloadSource } = await import('@electron/gateway/process-launcher');
    const headers = (location?: string) => ({
      get: (name: string) => name.toLowerCase() === 'location' ? location ?? null : null,
    });
    const fetch = vi.fn();
    for (let index = 1; index <= 6; index += 1) {
      fetch.mockResolvedValueOnce({ status: 302, headers: headers(`/v1/step-${index}`) });
    }
    const context = createGatewayFetchContext(fetch);
    vm.runInNewContext(buildGatewayFetchPreloadSource(), context);

    const response = await context.fetch('https://zz-cn.example.com/v1/start', {});

    expect(response.status).toBe(302);
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(fetch.mock.calls[5]?.[0]).toBe('https://zz-cn.example.com/v1/step-5');
  });

  it('runs forked children in Node mode before loading OpenClaw', async () => {
    const { buildGatewayEntryWrapperSource } = await import('@electron/gateway/process-launcher');
    const fork = vi.fn();
    const childProcess = {
      spawn: vi.fn(),
      exec: vi.fn(),
      execFile: vi.fn(),
      fork,
      spawnSync: vi.fn(),
      execSync: vi.fn(),
      execFileSync: vi.fn(),
    };
    const processMock = {
      platform: 'win32',
      execPath: 'C:\\Program Files\\ClawX\\ClawX.exe',
      env: { PATH: 'C:\\Windows\\System32' },
      argv: ['ClawX.exe'],
      stderr: { write: vi.fn() },
      exit: vi.fn(),
    };

    const wrapperSource = buildGatewayEntryWrapperSource();
    vm.runInNewContext(wrapperSource.slice(0, wrapperSource.lastIndexOf('(async function () {')), {
      process: processMock,
      require: (id: string) => {
        if (id === 'node:child_process') return childProcess;
        if (id === 'node:module') return { syncBuiltinESMExports: vi.fn() };
        throw new Error(`Unexpected require: ${id}`);
      },
    });

    childProcess.fork('worker.mjs', [], { env: { PATH: 'C:\\Windows\\System32' } });

    expect(fork).toHaveBeenCalledWith('worker.mjs', [], {
      env: {
        PATH: 'C:\\Windows\\System32',
        ELECTRON_RUN_AS_NODE: '1',
      },
      windowsHide: true,
    });
  });

  it('launches the real OpenClaw entry through the wrapper', async () => {
    const { launchGatewayProcess } = await import('@electron/gateway/process-launcher');
    const child = new EventEmitter() as EventEmitter & { pid: number; stderr: EventEmitter };
    child.pid = 12345;
    child.stderr = new EventEmitter();
    vi.mocked(utilityProcess.fork).mockReturnValueOnce(child as never);

    const launchPromise = launchGatewayProcess({
      port: 18789,
      launchContext: {
        appSettings: {} as never,
        openclawDir: '/tmp/openclaw',
        entryScript: '/tmp/openclaw/openclaw.mjs',
        gatewayArgs: ['gateway', '--port', '18789'],
        forkEnv: { PATH: '/usr/bin' },
        mode: 'packaged',
        binPathExists: true,
        loadedProviderKeyCount: 1,
        proxySummary: 'disabled',
        channelStartupSummary: 'skipped',
      },
      sanitizeSpawnArgs: (args) => args,
      getCurrentState: () => 'starting',
      getShouldReconnect: () => true,
      onStderrLine: vi.fn(),
      onSpawn: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    child.emit('spawn');
    await launchPromise;

    expect(vi.mocked(utilityProcess.fork)).toHaveBeenCalledWith(
      join('/tmp/clawx-test', 'gateway-entry-wrapper.cjs'),
      ['gateway', '--port', '18789'],
      expect.objectContaining({
        cwd: '/tmp/openclaw',
        env: expect.objectContaining({
          CLAWX_OPENCLAW_ENTRY: '/tmp/openclaw/openclaw.mjs',
          OPENCLAW_DISABLE_BONJOUR: '1',
          PATH: '/usr/bin',
        }),
      }),
    );

    child.emit('exit', 7);
    expect(vi.mocked(captureGatewayProcessException)).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Gateway process exited unexpectedly with code 7' }),
      { phase: 'exit', exitCode: 7 },
    );
  });
});

describe('Gateway process launcher environment', () => {
  it('enables safe startup tracing and preserves the source environment', () => {
    const source = {
      PATH: '/usr/bin',
      OPENCLAW_DISABLE_BONJOUR: '0',
      OPENCLAW_GATEWAY_STARTUP_TRACE: '0',
    };

    expect(buildGatewayRuntimeEnv(source)).toEqual({
      PATH: '/usr/bin',
      OPENCLAW_DISABLE_BONJOUR: '1',
      OPENCLAW_GATEWAY_STARTUP_TRACE: '1',
      UCLAW_SYNC_MEDIA_GENERATION: '1',
    });
    expect(source).toEqual({
      PATH: '/usr/bin',
      OPENCLAW_DISABLE_BONJOUR: '0',
      OPENCLAW_GATEWAY_STARTUP_TRACE: '0',
    });
  });

  it('removes inherited downgrade permission unless this child is explicitly authorized', () => {
    const source = {
      PATH: '/usr/bin',
      OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: '1',
      OpenClaw_Allow_Older_Binary_Destructive_Actions: '1',
    };

    const normalEnv = buildGatewayRuntimeEnv(source);
    expect(Object.keys(normalEnv).some(
      (key) => key.toUpperCase() === 'OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS',
    )).toBe(false);

    const authorizedEnv = buildGatewayRuntimeEnv(source, true);
    expect(authorizedEnv).toMatchObject({
      OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: '1',
    });
    expect(Object.keys(authorizedEnv).filter(
      (key) => key.toUpperCase() === 'OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS',
    )).toEqual(['OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS']);
    expect(source.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBe('1');
    expect(source.OpenClaw_Allow_Older_Binary_Destructive_Actions).toBe('1');
  });
});
