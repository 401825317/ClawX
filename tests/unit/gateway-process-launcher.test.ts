// @vitest-environment node

import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { utilityProcess } from 'electron';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/clawx-test',
    isPackaged: true,
  },
  utilityProcess: {
    fork: vi.fn(),
  },
}));

import { buildGatewayRuntimeEnv } from '@electron/gateway/process-launcher';

describe('Gateway process wrapper', () => {
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

    vm.runInNewContext(buildGatewayEntryWrapperSource().split('(async function () {')[0], {
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
      '/tmp/clawx-test/gateway-entry-wrapper.cjs',
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
