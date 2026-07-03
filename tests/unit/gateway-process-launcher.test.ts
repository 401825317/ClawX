import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { app, utilityProcess } from 'electron';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/clawx-test',
    isPackaged: false,
  },
  utilityProcess: {
    fork: vi.fn(),
  },
}));

function runGatewayPreloadInVm(params: {
  preloadSource: string;
  childProcess: Record<string, unknown>;
  processMock: Record<string, unknown>;
}) {
  const patchSource = readFileSync(
    resolve(process.cwd(), 'electron/gateway/gateway-child-process-patch.cjs'),
    'utf-8',
  );
  vm.runInNewContext(params.preloadSource, {
    globalThis: { fetch: vi.fn() },
    process: params.processMock,
    require: (id: string) => {
      if (id === './gateway-child-process-patch.cjs') {
        vm.runInNewContext(patchSource, {
          process: params.processMock,
          require: (patchId: string) => {
            if (patchId === 'child_process' || patchId === 'node:child_process') return params.childProcess;
            if (patchId === 'node:module') return { syncBuiltinESMExports: vi.fn() };
            throw new Error(`Unexpected patch require: ${patchId}`);
          },
        });
        return {};
      }
      if (id === 'child_process' || id === 'node:child_process') return params.childProcess;
      if (id === 'node:module') return { syncBuiltinESMExports: vi.fn() };
      throw new Error(`Unexpected require: ${id}`);
    },
  });
}

describe('Gateway process preload', () => {
  it('runs process.execPath children in Node mode inside Electron utility process', async () => {
    const preloadSource = readFileSync(
      resolve(process.cwd(), 'electron/gateway/gateway-fetch-preload.cjs'),
      'utf-8',
    );

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

    runGatewayPreloadInVm({
      preloadSource,
      childProcess,
      processMock,
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
    const preloadSource = readFileSync(
      resolve(process.cwd(), 'electron/gateway/gateway-fetch-preload.cjs'),
      'utf-8',
    );

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

    runGatewayPreloadInVm({
      preloadSource,
      childProcess,
      processMock,
    });

    childProcess.execFile('/usr/bin/git', ['status'], { cwd: '/repo' });

    expect(execFile).toHaveBeenCalledWith('/usr/bin/git', ['status'], { cwd: '/repo' });
  });

  it('passes Node mode to shell commands that invoke the Electron executable', async () => {
    const preloadSource = readFileSync(
      resolve(process.cwd(), 'electron/gateway/gateway-fetch-preload.cjs'),
      'utf-8',
    );

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

    runGatewayPreloadInVm({
      preloadSource,
      childProcess,
      processMock,
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
  function makeUtilityProcessMock() {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stderr?: EventEmitter;
    };
    child.pid = 12345;
    child.stderr = new EventEmitter();
    vi.mocked(utilityProcess.fork).mockReturnValueOnce(child as never);
    return child;
  }

  function makeLaunchOptions(overrides: Partial<Parameters<typeof import('@electron/gateway/process-launcher')['launchGatewayProcess']>[0]> = {}) {
    return {
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
      sanitizeSpawnArgs: (args: string[]) => args,
      getCurrentState: () => 'starting' as const,
      getShouldReconnect: () => true,
      onStderrLine: vi.fn(),
      onSpawn: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
      ...overrides,
    };
  }

  it('launches OpenClaw through the wrapper entry', async () => {
    const { launchGatewayProcess } = await import('@electron/gateway/process-launcher');

    const child = makeUtilityProcessMock();

    const launchPromise = launchGatewayProcess(makeLaunchOptions());

    child.emit('spawn');
    await launchPromise;

    const [modulePath, args, options] = vi.mocked(utilityProcess.fork).mock.calls[0] ?? [];
    expect(modulePath).toBe(resolve(process.cwd(), 'electron/gateway/gateway-entry-wrapper.cjs'));
    expect(args).toEqual(['gateway', '--port', '18789']);
    expect(options).toMatchObject({
      cwd: '/tmp/openclaw',
      env: {
        CLAWX_OPENCLAW_ENTRY: '/tmp/openclaw/openclaw.mjs',
        OPENCLAW_DISABLE_BONJOUR: '1',
        OPENCLAW_DISABLE_UPDATE_CHECK: '1',
        OPENCLAW_SKIP_UPDATE_CHECK: '1',
        NO_UPDATE_NOTIFIER: '1',
        PATH: '/usr/bin',
      },
    });
  });

  it('uses the bundled app.asar wrapper and skips NODE_OPTIONS preload in packaged builds', async () => {
    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: '/Applications/UClaw.app/Contents/Resources',
    });
    (app as unknown as { isPackaged: boolean }).isPackaged = true;

    try {
      const { launchGatewayProcess } = await import('@electron/gateway/process-launcher');
      const child = makeUtilityProcessMock();

      const launchPromise = launchGatewayProcess(makeLaunchOptions({
        launchContext: {
          ...makeLaunchOptions().launchContext,
          forkEnv: {
            PATH: '/usr/bin',
            NODE_OPTIONS: '--trace-warnings',
          },
        },
      }));

      child.emit('spawn');
      await launchPromise;

      const [modulePath, , options] = vi.mocked(utilityProcess.fork).mock.calls[0] ?? [];
      expect(String(modulePath).replace(/\\/g, '/')).toBe('/Applications/UClaw.app/Contents/Resources/app.asar/dist-electron/main/gateway-entry-wrapper.cjs');
      expect(options).toMatchObject({
        env: {
          CLAWX_OPENCLAW_ENTRY: '/tmp/openclaw/openclaw.mjs',
          NODE_OPTIONS: '--trace-warnings',
          OPENCLAW_DISABLE_BONJOUR: '1',
          OPENCLAW_DISABLE_UPDATE_CHECK: '1',
          OPENCLAW_SKIP_UPDATE_CHECK: '1',
          NO_UPDATE_NOTIFIER: '1',
          PATH: '/usr/bin',
        },
      });
    } finally {
      (app as unknown as { isPackaged: boolean }).isPackaged = false;
      Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        value: originalResourcesPath,
      });
    }
  });
});
