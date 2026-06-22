import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeIpcMock = vi.fn();
const settingsState = {
  autoCheckUpdate: false,
};

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: {
    getState: () => settingsState,
  },
}));

describe('update store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    settingsState.autoCheckUpdate = false;
  });

  it('keeps portable update mode and downloaded package path from IPC status', async () => {
    invokeIpcMock.mockImplementation(async (channel: string) => {
      if (channel === 'update:version') return '0.4.8';
      if (channel === 'update:status') {
        return {
          status: 'downloaded',
          mode: 'portable',
          info: { version: '0.4.9' },
          downloadPath: 'C:/Users/tester/AppData/Local/UClawRuntime/updates/UClaw-0.4.9-win-x64.zip',
        };
      }
      return { success: true };
    });

    const { useUpdateStore } = await import('@/stores/update');
    await useUpdateStore.getState().init();

    expect(useUpdateStore.getState()).toMatchObject({
      status: 'downloaded',
      mode: 'portable',
      currentVersion: '0.4.8',
      updateInfo: { version: '0.4.9' },
      downloadPath: 'C:/Users/tester/AppData/Local/UClawRuntime/updates/UClaw-0.4.9-win-x64.zip',
    });
  });

  it('updates portable download state from update:download response', async () => {
    invokeIpcMock.mockImplementation(async (channel: string) => {
      if (channel === 'update:download') {
        return {
          success: true,
          status: {
            status: 'downloaded',
            mode: 'portable',
            info: { version: '0.5.0' },
            downloadPath: 'C:/Users/tester/AppData/Local/UClawRuntime/updates/UClaw-0.5.0-win-x64.zip',
          },
        };
      }
      return { success: true };
    });

    const { useUpdateStore } = await import('@/stores/update');
    useUpdateStore.setState({ status: 'available', mode: 'portable', updateInfo: { version: '0.5.0' } });

    await useUpdateStore.getState().downloadUpdate();

    expect(useUpdateStore.getState()).toMatchObject({
      status: 'downloaded',
      mode: 'portable',
      updateInfo: { version: '0.5.0' },
      downloadPath: 'C:/Users/tester/AppData/Local/UClawRuntime/updates/UClaw-0.5.0-win-x64.zip',
    });
  });
});
