import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { utilityProcess } from 'electron';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/clawx-test',
    isPackaged: false,
  },
  utilityProcess: {
    fork: vi.fn(),
  },
}));

describe('Gateway process preload', () => {
  it('runs process.execPath children in Node mode inside Electron utility process', async () => {
    const { buildGatewayFetchPreloadSource } = await import('@electron/gateway/process-launcher');

    const spawn = vi.fn();
    const childProcess = {
      spawn,
      execFile: vi.fn(),
      fork: vi.fn(),
      spawnSync: vi.fn(),
      execFileSync: vi.fn(),
    };
    const processMock = {
      platform: 'darwin',
      execPath: '/Applications/UClaw.app/Contents/Frameworks/UClaw Helper.app/Contents/MacOS/UClaw Helper',
      env: { PATH: '/usr/bin' },
    };

    vm.runInNewContext(buildGatewayFetchPreloadSource(), {
      globalThis: { fetch: vi.fn() },
      process: processMock,
      require: (id: string) => {
        if (id === 'child_process' || id === 'node:child_process') return childProcess;
        if (id === 'node:module') return { syncBuiltinESMExports: vi.fn() };
        throw new Error(`Unexpected require: ${id}`);
      },
    });

    childProcess.spawn(processMock.execPath, ['--input-type=module', '--eval', 'console.log(1)'], {
      cwd: '/tmp',
      env: {},
      stdio: 'pipe',
    });

    expect(spawn).toHaveBeenCalledWith(
      processMock.execPath,
      ['--input-type=module', '--eval', 'console.log(1)'],
      {
        cwd: '/tmp',
        env: { ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'pipe',
      },
    );
  });

  it('does not alter non-Electron child commands on macOS', async () => {
    const { buildGatewayFetchPreloadSource } = await import('@electron/gateway/process-launcher');

    const execFile = vi.fn();
    const childProcess = {
      spawn: vi.fn(),
      execFile,
      fork: vi.fn(),
      spawnSync: vi.fn(),
      execFileSync: vi.fn(),
    };
    const processMock = {
      platform: 'darwin',
      execPath: '/Applications/UClaw.app/Contents/MacOS/UClaw',
      env: { PATH: '/usr/bin' },
    };

    vm.runInNewContext(buildGatewayFetchPreloadSource(), {
      globalThis: { fetch: vi.fn() },
      process: processMock,
      require: (id: string) => {
        if (id === 'child_process' || id === 'node:child_process') return childProcess;
        if (id === 'node:module') return { syncBuiltinESMExports: vi.fn() };
        throw new Error(`Unexpected require: ${id}`);
      },
    });

    childProcess.execFile('/usr/bin/git', ['status'], { cwd: '/repo' });

    expect(execFile).toHaveBeenCalledWith('/usr/bin/git', ['status'], { cwd: '/repo' });
  });

  it('passes Node mode to shell commands that invoke the Electron executable', async () => {
    const { buildGatewayFetchPreloadSource } = await import('@electron/gateway/process-launcher');

    const spawn = vi.fn();
    const childProcess = {
      spawn,
      exec: vi.fn(),
      execFile: vi.fn(),
      fork: vi.fn(),
      spawnSync: vi.fn(),
      execSync: vi.fn(),
      execFileSync: vi.fn(),
    };
    const processMock = {
      platform: 'darwin',
      execPath: '/Applications/UClaw.app/Contents/Frameworks/UClaw Helper.app/Contents/MacOS/UClaw Helper',
      env: { PATH: '/usr/bin' },
    };

    vm.runInNewContext(buildGatewayFetchPreloadSource(), {
      globalThis: { fetch: vi.fn() },
      process: processMock,
      require: (id: string) => {
        if (id === 'child_process' || id === 'node:child_process') return childProcess;
        if (id === 'node:module') return { syncBuiltinESMExports: vi.fn() };
        throw new Error(`Unexpected require: ${id}`);
      },
    });

    childProcess.spawn('/bin/zsh', [
      '-f',
      '-i',
      '-c',
      `'${processMock.execPath}' -e 'console.log(1)'`,
    ], {
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
      stdio: 'pipe',
    });

    expect(spawn).toHaveBeenCalledWith(
      '/bin/zsh',
      [
        '-f',
        '-i',
        '-c',
        `'${processMock.execPath}' -e 'console.log(1)'`,
      ],
      {
        cwd: '/tmp',
        env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'pipe',
      },
    );
  });
});

describe('Gateway process launcher', () => {
  it('launches OpenClaw through the wrapper entry', async () => {
    const { launchGatewayProcess } = await import('@electron/gateway/process-launcher');

    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stderr?: EventEmitter;
    };
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

    const [modulePath, args, options] = vi.mocked(utilityProcess.fork).mock.calls[0] ?? [];
    expect(modulePath).toBe('/tmp/clawx-test/gateway-entry-wrapper.cjs');
    expect(args).toEqual(['gateway', '--port', '18789']);
    expect(options).toMatchObject({
      cwd: '/tmp/openclaw',
      env: {
        CLAWX_OPENCLAW_ENTRY: '/tmp/openclaw/openclaw.mjs',
        OPENCLAW_DISABLE_BONJOUR: '1',
        PATH: '/usr/bin',
      },
    });
  });
});
