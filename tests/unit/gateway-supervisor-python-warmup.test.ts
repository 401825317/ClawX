import { beforeEach, describe, expect, it, vi } from 'vitest';

const isPythonReady = vi.fn();
const setupManagedPython = vi.fn();

vi.mock('@electron/utils/uv-setup', () => ({
  isPythonReady,
  setupManagedPython,
}));

describe('Gateway Python startup warmup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    delete process.env.CLAWX_DISABLE_PYTHON_STARTUP_WARMUP;
    delete process.env.CLAWX_ENABLE_STARTUP_PYTHON_REPAIR;
    isPythonReady.mockReset();
    setupManagedPython.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not probe Python immediately during Gateway startup', async () => {
    isPythonReady.mockResolvedValue(true);
    const { warmupManagedPythonReadiness } = await import('@electron/gateway/supervisor');

    warmupManagedPythonReadiness();

    expect(isPythonReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(44_999);
    expect(isPythonReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(isPythonReady).toHaveBeenCalledTimes(1);
  });

  it('does not install Python from the startup warmup by default', async () => {
    isPythonReady.mockResolvedValue(false);
    const { warmupManagedPythonReadiness } = await import('@electron/gateway/supervisor');

    warmupManagedPythonReadiness();
    await vi.advanceTimersByTimeAsync(45_000);

    expect(isPythonReady).toHaveBeenCalledTimes(1);
    expect(setupManagedPython).not.toHaveBeenCalled();
  });

  it('allows explicit delayed startup repair behind an opt-in env flag', async () => {
    process.env.CLAWX_ENABLE_STARTUP_PYTHON_REPAIR = '1';
    isPythonReady.mockResolvedValue(false);
    setupManagedPython.mockResolvedValue(undefined);
    const { warmupManagedPythonReadiness } = await import('@electron/gateway/supervisor');

    warmupManagedPythonReadiness();
    await vi.advanceTimersByTimeAsync(45_000);

    expect(setupManagedPython).toHaveBeenCalledTimes(1);
  });
});
