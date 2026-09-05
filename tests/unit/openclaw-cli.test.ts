import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';

const originalPlatform = process.platform;
const originalResourcesPath = process.resourcesPath;
const originalExecPath = process.execPath;
const originalComSpec = process.env.ComSpec;
const originalPath = process.env.PATH;
const originalElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
const mockedEntryPath = 'C:\\Program Files\\ClawX\\resources\\openclaw\\openclaw.mjs';

type ProcessExitListener = (code: number) => void;
let processExitListenerBaseline: readonly ProcessExitListener[] = [];

function removeProcessExitListenersAddedSince(baseline: readonly ProcessExitListener[]): void {
  const remaining = new Map<ProcessExitListener, number>();
  for (const listener of baseline) {
    remaining.set(listener, (remaining.get(listener) ?? 0) + 1);
  }
  for (const listener of process.rawListeners('exit') as ProcessExitListener[]) {
    const count = remaining.get(listener) ?? 0;
    if (count > 0) {
      remaining.set(listener, count - 1);
    } else {
      process.removeListener('exit', listener);
    }
  }
}

const {
  mockChmodSync,
  mockExistsSync,
  mockMkdirSync,
  mockIsPackagedGetter,
  mockSymlinkSync,
  mockUnlinkSync,
  mockAppName,
} = vi.hoisted(() => ({
  mockChmodSync: vi.fn<(path: string, mode: number) => void>(),
  mockExistsSync: vi.fn<(path: string) => boolean>(),
  mockMkdirSync: vi.fn(),
  mockIsPackagedGetter: { value: false },
  mockSymlinkSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockAppName: { value: 'UClaw' },
}));

function setPlatform(platform: string) {
  Object.defineProperty(process, 'platform', { value: platform, writable: true });
}

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    chmodSync: mockChmodSync,
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    symlinkSync: mockSymlinkSync,
    unlinkSync: mockUnlinkSync,
    default: {
      ...actual,
      chmodSync: mockChmodSync,
      existsSync: mockExistsSync,
      mkdirSync: mockMkdirSync,
      symlinkSync: mockSymlinkSync,
      unlinkSync: mockUnlinkSync,
    },
  };
});

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mockIsPackagedGetter.value;
    },
    getName: () => mockAppName.value,
  },
}));

vi.mock('@electron/utils/paths', () => ({
  getOpenClawDir: () => '/tmp/openclaw',
  getOpenClawEntryPath: () => mockedEntryPath,
}));

function setResourcesPath(resourcesPath: string | undefined) {
  Object.defineProperty(process, 'resourcesPath', {
    value: resourcesPath,
    configurable: true,
    writable: true,
  });
}

function setExecPath(execPath: string) {
  Object.defineProperty(process, 'execPath', {
    value: execPath,
    configurable: true,
    writable: true,
  });
}

function resetOpenClawCliMocks() {
  vi.resetModules();
  mockChmodSync.mockReset();
  mockExistsSync.mockReset();
  mockMkdirSync.mockReset();
  mockSymlinkSync.mockReset();
  mockUnlinkSync.mockReset();
  mockAppName.value = 'UClaw';
  mockIsPackagedGetter.value = false;
  setPlatform(originalPlatform);
  setResourcesPath(originalResourcesPath);
  setExecPath(originalExecPath);
  if (originalComSpec === undefined) {
    delete process.env.ComSpec;
  } else {
    process.env.ComSpec = originalComSpec;
  }
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalElectronRunAsNode === undefined) {
    delete process.env.ELECTRON_RUN_AS_NODE;
  } else {
    process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode;
  }
}

beforeEach(() => {
  processExitListenerBaseline = [...process.rawListeners('exit')] as ProcessExitListener[];
});

afterEach(() => {
  removeProcessExitListenersAddedSince(processExitListenerBaseline);
});

describe('getOpenClawCliCommand (Windows packaged)', () => {
  beforeEach(() => {
    resetOpenClawCliMocks();
    setPlatform('win32');
    mockIsPackagedGetter.value = true;
    setResourcesPath('C:\\Program Files\\ClawX\\resources');
  });

  afterEach(() => {
    resetOpenClawCliMocks();
  });

  it('prefers bundled node.exe when present', async () => {
    mockExistsSync.mockImplementation((p: string) => /[\\/]cli[\\/]openclaw\.cmd$/i.test(p) || /[\\/]bin[\\/]node\.exe$/i.test(p));
    const { getOpenClawCliCommand } = await import('@electron/utils/openclaw-cli');
    expect(getOpenClawCliCommand()).toBe(
      `& '${join('C:\\Program Files\\ClawX\\resources', 'cli', 'openclaw.cmd')}'`,
    );
  });

  it('falls back to bundled node.exe when openclaw.cmd is missing', async () => {
    mockExistsSync.mockImplementation((p: string) => /[\\/]bin[\\/]node\.exe$/i.test(p));
    const { getOpenClawCliCommand } = await import('@electron/utils/openclaw-cli');
    expect(getOpenClawCliCommand()).toBe(
      `& '${join('C:\\Program Files\\ClawX\\resources', 'bin', 'node.exe')}' '${mockedEntryPath}'`,
    );
  });

  it('falls back to ELECTRON_RUN_AS_NODE command when wrappers are missing', async () => {
    mockExistsSync.mockReturnValue(false);
    const { getOpenClawCliCommand } = await import('@electron/utils/openclaw-cli');
    const command = getOpenClawCliCommand();
    expect(command.startsWith('$env:ELECTRON_RUN_AS_NODE=1; & ')).toBe(true);
    expect(command.endsWith("'C:\\Program Files\\ClawX\\resources\\openclaw\\openclaw.mjs'")).toBe(true);
  });
});

describe('getOpenClawCliSpawnSpec', () => {
  beforeEach(() => {
    resetOpenClawCliMocks();
  });

  afterEach(() => {
    resetOpenClawCliMocks();
  });

  it('returns the dev wrapper path as an unquoted spawn command', async () => {
    setPlatform('darwin');
    const wrapperPath = join(dirname('/tmp/openclaw'), '.bin', 'openclaw');
    mockExistsSync.mockImplementation((p: string) => p === wrapperPath);

    const { getOpenClawCliSpawnSpec } = await import('@electron/utils/openclaw-cli');
    const spec = getOpenClawCliSpawnSpec();

    expect(spec).toEqual({ command: wrapperPath, args: [], shell: false });
    expect(spec.command).not.toMatch(/^& |^['"]/);
  });

  it('uses cmd.exe for a Windows dev cmd wrapper', async () => {
    const comSpecPath = 'C:\\Windows\\System32\\cmd.exe';
    setPlatform('win32');
    process.env.ComSpec = comSpecPath;
    const wrapperPath = join(dirname('/tmp/openclaw'), '.bin', 'openclaw.cmd');
    mockExistsSync.mockImplementation((p: string) => p === wrapperPath);

    const { getOpenClawCliSpawnSpec } = await import('@electron/utils/openclaw-cli');
    const spec = getOpenClawCliSpawnSpec();

    expect(spec.command).toBe(comSpecPath);
    expect(spec.args).toEqual(['/d', '/s', '/c', `"${wrapperPath}"`]);
    expect(spec.shell).not.toBe(true);
  });

  it('returns the packaged POSIX wrapper path as the spawn command', async () => {
    setPlatform('linux');
    mockIsPackagedGetter.value = true;
    setResourcesPath('/opt/ClawX/resources');
    const wrapperPath = join('/opt/ClawX/resources', 'cli', 'openclaw');
    mockExistsSync.mockImplementation((p: string) => p === wrapperPath);

    const { getOpenClawCliSpawnSpec } = await import('@electron/utils/openclaw-cli');
    const spec = getOpenClawCliSpawnSpec();

    expect(spec.command).toBe(wrapperPath);
    expect(spec.args).toEqual([]);
    expect(spec.shell).toBe(false);
  });

  it('uses cmd.exe for a packaged Windows cmd wrapper', async () => {
    setPlatform('win32');
    mockIsPackagedGetter.value = true;
    setResourcesPath('C:\\Program Files\\ClawX\\resources');
    mockExistsSync.mockImplementation((p: string) => /[\\/]cli[\\/]openclaw\.cmd$/i.test(p));

    const { getOpenClawCliSpawnSpec } = await import('@electron/utils/openclaw-cli');
    const spec = getOpenClawCliSpawnSpec();

    expect(spec.command).toBe(process.env.ComSpec || 'cmd.exe');
    expect(spec.args).toEqual([
      '/d',
      '/s',
      '/c',
      `"${join('C:\\Program Files\\ClawX\\resources', 'cli', 'openclaw.cmd')}"`,
    ]);
    expect(spec.shell).not.toBe(true);
  });

  it('uses ELECTRON_RUN_AS_NODE with process.execPath when packaged wrappers are missing', async () => {
    const execPath = '/Applications/ClawX.app/Contents/MacOS/ClawX';
    setPlatform('darwin');
    mockIsPackagedGetter.value = true;
    setResourcesPath('/Applications/ClawX.app/Contents/Resources');
    setExecPath(execPath);
    mockExistsSync.mockReturnValue(false);

    const { getOpenClawCliSpawnSpec } = await import('@electron/utils/openclaw-cli');
    const spec = getOpenClawCliSpawnSpec();

    expect(spec.command).toBe(execPath);
    expect(spec.args).toEqual([mockedEntryPath]);
    expect(spec.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('uses bundled node.exe on packaged Windows when the cmd wrapper is missing', async () => {
    setPlatform('win32');
    mockIsPackagedGetter.value = true;
    setResourcesPath('C:\\Program Files\\ClawX\\resources');
    mockExistsSync.mockImplementation((p: string) => /[\\/]bin[\\/]node\.exe$/i.test(p));

    const { getOpenClawCliSpawnSpec } = await import('@electron/utils/openclaw-cli');
    const spec = getOpenClawCliSpawnSpec();

    expect(spec.command).toBe(join('C:\\Program Files\\ClawX\\resources', 'bin', 'node.exe'));
    expect(spec.args).toEqual([mockedEntryPath]);
    expect(spec.shell).toBeUndefined();
    expect(spec.env).toBeUndefined();
  });
});

describe('getOpenClawEmbeddedForkSpec', () => {
  beforeEach(() => {
    resetOpenClawCliMocks();
  });

  afterEach(() => {
    resetOpenClawCliMocks();
  });

  it('launches packaged macOS UClaw Helper with ACP args without chmod-ing the app bundle', async () => {
    // Electron can report the npm/package name (`clawx`) here.  The bundle
    // name is authoritative and must still resolve UClaw Helper.
    mockAppName.value = 'clawx';
    const execPath = '/Applications/UClaw.app/Contents/MacOS/UClaw';
    const helperPath = join(
      dirname(execPath),
      '../Frameworks',
      'UClaw Helper.app',
      'Contents/MacOS',
      'UClaw Helper',
    );
    setPlatform('darwin');
    mockIsPackagedGetter.value = true;
    setResourcesPath('/Applications/UClaw.app/Contents/Resources');
    setExecPath(execPath);
    mockExistsSync.mockImplementation((p: string) => p === helperPath);

    const { getOpenClawEmbeddedForkSpec } = await import('@electron/utils/openclaw-cli');
    const spec = getOpenClawEmbeddedForkSpec(['acp']);

    expect(mockExistsSync).toHaveBeenCalledWith(helperPath);
    expect(mockExistsSync).not.toHaveBeenCalledWith(expect.stringContaining('clawx Helper'));
    expect(mockChmodSync).not.toHaveBeenCalled();
    expect(spec.args).toEqual(['acp']);
    expect(spec).toMatchObject({
      modulePath: mockedEntryPath,
      args: ['acp'],
      options: {
        cwd: '/tmp/openclaw',
        execPath: helperPath,
        execArgv: [],
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: '1',
          OPENCLAW_NO_RESPAWN: '1',
          OPENCLAW_EMBEDDED_IN: 'UClaw',
          OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
        }),
      },
    });
  });

  it('keeps finding the legacy helper when an older ClawX bundle is still running', async () => {
    mockAppName.value = 'clawx';
    // A renamed UClaw.app can still contain the legacy helper framework when
    // it was copied from an older installation. The fallback must not depend
    // on the current app bundle being named ClawX.
    const execPath = '/Applications/UClaw.app/Contents/MacOS/UClaw';
    const helperPath = join(
      dirname(execPath),
      '../Frameworks',
      'ClawX Helper.app',
      'Contents/MacOS',
      'ClawX Helper',
    );
    setPlatform('darwin');
    mockIsPackagedGetter.value = true;
    setExecPath(execPath);
    mockExistsSync.mockImplementation((p: string) => p === helperPath);

    const { getOpenClawEmbeddedForkSpec } = await import('@electron/utils/openclaw-cli');
    expect(getOpenClawEmbeddedForkSpec(['acp']).options.execPath).toBe(helperPath);
  });

  it('uses Electron Node mode for dev embedded launches even when PATH contains an older Node', async () => {
    const execPath = 'C:\\workspace\\ClawX\\node_modules\\electron\\dist\\electron.exe';
    setPlatform('win32');
    setExecPath(execPath);
    process.env.PATH = '/old-node/bin:/usr/bin';
    delete process.env.ELECTRON_RUN_AS_NODE;
    mockExistsSync.mockImplementation((p: string) => p === '/old-node/bin/node.exe');

    const { getOpenClawEmbeddedForkSpec } = await import('@electron/utils/openclaw-cli');
    const spec = getOpenClawEmbeddedForkSpec(['acp']);

    expect(spec.options.execPath).toBe(execPath);
    expect(spec.options.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('fails packaged macOS embedded launch when the Helper executable is missing', async () => {
    const execPath = '/Applications/UClaw.app/Contents/MacOS/UClaw';
    setPlatform('darwin');
    mockIsPackagedGetter.value = true;
    setResourcesPath('/Applications/UClaw.app/Contents/Resources');
    setExecPath(execPath);
    mockExistsSync.mockReturnValue(false);

    const { getOpenClawEmbeddedForkSpec } = await import('@electron/utils/openclaw-cli');

    expect(() => getOpenClawEmbeddedForkSpec(['acp'])).toThrow('UClaw Helper executable not found');
    expect(mockExistsSync).not.toHaveBeenCalledWith(expect.stringContaining('clawx Helper'));
  });
});

describe('installOpenClawCli (macOS packaged)', () => {
  beforeEach(() => {
    resetOpenClawCliMocks();
    setPlatform('darwin');
    mockIsPackagedGetter.value = true;
    setResourcesPath('/Applications/UClaw.app/Contents/Resources');
  });

  afterEach(() => {
    resetOpenClawCliMocks();
  });

  it('does not chmod the bundled wrapper inside a read-only app bundle', async () => {
    const wrapperPath = join('/Applications/UClaw.app/Contents/Resources', 'cli', 'openclaw');
    mockExistsSync.mockImplementation((p: string) => p === wrapperPath);

    const { installOpenClawCli } = await import('@electron/utils/openclaw-cli');
    const result = await installOpenClawCli();

    expect(result.success).toBe(true);
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      wrapperPath,
      expect.stringMatching(/[\\/]\.local[\\/]bin[\\/]openclaw$/u),
    );
    expect(mockChmodSync).not.toHaveBeenCalled();
  });
});
