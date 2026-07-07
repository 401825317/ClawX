// @vitest-environment node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempHome: string;

beforeEach(() => {
  tempHome = path.join(tmpdir(), `uclaw-office-python-${Math.random().toString(36).slice(2)}`);
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('HOME', tempHome);

  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    return {
      ...actual,
      homedir: () => tempHome,
    };
  });

  vi.doMock('electron', () => ({
    app: {
      getPath: vi.fn().mockReturnValue(path.join(tempHome, '.clawx')),
      getAppPath: vi.fn().mockReturnValue(process.cwd()),
      isPackaged: false,
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

describe('UClaw Office Python environment', () => {
  it('pins cross-platform office packages and keeps pywin32 Windows-only', async () => {
    const { getOfficePythonPackages } = await import('@electron/utils/uv-setup');

    expect(getOfficePythonPackages('darwin')).toEqual([
      'python-pptx==1.0.2',
      'openpyxl==3.1.5',
      'python-docx==1.2.0',
    ]);
    expect(getOfficePythonPackages('win32')).toEqual([
      'python-pptx==1.0.2',
      'openpyxl==3.1.5',
      'python-docx==1.2.0',
      'pywin32==312',
    ]);
  });

  it('patches gateway env only after the Office venv exists', async () => {
    const { getOfficePythonEnvPatch, getOfficePythonVenvPath } = await import('@electron/utils/uv-setup');
    const baseEnv = { PATH: '/usr/bin:/bin' };
    const venvPath = getOfficePythonVenvPath();

    expect(venvPath).toBe(path.join(tempHome, '.openclaw', 'runtime', 'office-python'));
    expect(getOfficePythonEnvPatch(baseEnv)).toMatchObject({
      present: false,
      venvPath,
      env: baseEnv,
    });

    const binDir = process.platform === 'win32' ? path.join(venvPath, 'Scripts') : path.join(venvPath, 'bin');
    const pythonPath = process.platform === 'win32' ? path.join(binDir, 'python.exe') : path.join(binDir, 'python');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(venvPath, 'pyvenv.cfg'), 'home = test\n');
    writeFileSync(pythonPath, '');

    const patched = getOfficePythonEnvPatch(baseEnv);

    expect(patched.present).toBe(true);
    expect(patched.venvPath).toBe(venvPath);
    expect(patched.env.VIRTUAL_ENV).toBe(venvPath);
    expect(patched.env.PATH).toContain(binDir);
    expect(patched.env.PATH).toContain('/usr/bin:/bin');
  });

  it('does not inject the Office Python env into gateway unless explicitly enabled', async () => {
    const { getGatewayOfficePythonEnvPatch, getOfficePythonVenvPath } = await import('@electron/utils/uv-setup');
    const baseEnv = { PATH: '/usr/bin:/bin' };
    const venvPath = getOfficePythonVenvPath();
    const binDir = process.platform === 'win32' ? path.join(venvPath, 'Scripts') : path.join(venvPath, 'bin');
    const pythonPath = process.platform === 'win32' ? path.join(binDir, 'python.exe') : path.join(binDir, 'python');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(venvPath, 'pyvenv.cfg'), 'home = test\n');
    writeFileSync(pythonPath, '');

    const disabled = getGatewayOfficePythonEnvPatch(baseEnv);
    expect(disabled).toMatchObject({
      enabled: false,
      present: false,
      venvPath,
      env: baseEnv,
    });

    vi.stubEnv('CLAWX_ENABLE_OFFICE_PYTHON_ENV', '1');
    const enabled = getGatewayOfficePythonEnvPatch(baseEnv);
    expect(enabled.enabled).toBe(true);
    expect(enabled.present).toBe(true);
    expect(enabled.venvPath).toBe(venvPath);
    expect(enabled.env.VIRTUAL_ENV).toBe(venvPath);
    expect(enabled.env.PATH).toContain(binDir);
    expect(enabled.env.PATH).toContain('/usr/bin:/bin');
  });
});
