import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKSPACE_CWD } from '@shared/workspace';

const settingsSetMany = vi.hoisted(() => vi.fn());
const settingsSet = vi.hoisted(() => vi.fn());
const settingsGetAll = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    settings: {
      getAll: settingsGetAll,
      set: settingsSet,
      setMany: settingsSetMany,
    },
  },
}));

import { useSettingsStore } from '@/stores/settings';

describe('settings workspace cleanup', () => {
  beforeEach(() => {
    settingsSetMany.mockReset();
    settingsSet.mockReset();
    settingsGetAll.mockReset();
    settingsSetMany.mockResolvedValue({ success: true });
    settingsSet.mockResolvedValue({ success: true });
    settingsGetAll.mockResolvedValue({ telemetryEnabled: true });
    useSettingsStore.setState({
      chatWorkspacePath: '/missing',
      recentWorkspacePaths: ['/missing', '/kept'],
      workspaceLabels: {
        '/missing': 'Missing project',
        '/kept': 'Kept project',
      },
    });
  });

  it('removes workspace metadata and resets a matching global workspace', async () => {
    await useSettingsStore.getState().removeWorkspace('/missing/');

    const state = useSettingsStore.getState();
    expect(state.chatWorkspacePath).toBe(DEFAULT_WORKSPACE_CWD);
    expect(state.recentWorkspacePaths).toEqual([DEFAULT_WORKSPACE_CWD, '/kept']);
    expect(state.workspaceLabels).toEqual({ '/kept': 'Kept project' });
    expect(settingsSetMany).toHaveBeenCalledWith({
      chatWorkspacePath: DEFAULT_WORKSPACE_CWD,
      recentWorkspacePaths: [DEFAULT_WORKSPACE_CWD, '/kept'],
      workspaceLabels: { '/kept': 'Kept project' },
    });
  });

  it('keeps the global workspace when removing a different recent path', async () => {
    useSettingsStore.setState({ chatWorkspacePath: '/kept' });

    await useSettingsStore.getState().removeWorkspace('/missing');

    expect(useSettingsStore.getState().chatWorkspacePath).toBe('/kept');
    expect(useSettingsStore.getState().recentWorkspacePaths).toEqual(['/kept']);
  });

  it('rolls telemetry UI back to Main truth when the Host API rejects', async () => {
    settingsSet.mockRejectedValueOnce(new Error('telemetry side effect failed'));
    settingsGetAll.mockResolvedValueOnce({ telemetryEnabled: true });

    await useSettingsStore.getState().setTelemetryEnabled(false);

    expect(useSettingsStore.getState().telemetryEnabled).toBe(true);
    expect(settingsGetAll).toHaveBeenCalledOnce();
  });

  it('does not let an older failed telemetry save overwrite a newer toggle', async () => {
    let rejectFirst!: (error: Error) => void;
    settingsSet.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectFirst = reject; }));
    settingsSet.mockResolvedValueOnce({ success: true });

    const first = useSettingsStore.getState().setTelemetryEnabled(false);
    await useSettingsStore.getState().setTelemetryEnabled(true);
    rejectFirst(new Error('stale failure'));
    await first;

    expect(useSettingsStore.getState().telemetryEnabled).toBe(true);
    expect(settingsGetAll).not.toHaveBeenCalled();
  });
});
