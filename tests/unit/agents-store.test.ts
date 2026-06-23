import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

describe('useAgentsStore fetchAgents backpressure', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    hostApiFetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses in-flight requests and skips duplicate background refreshes inside the TTL', async () => {
    let resolveFetch: ((value: unknown) => void) | null = null;
    hostApiFetchMock.mockImplementationOnce(async () => new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const { useAgentsStore } = await import('@/stores/agents');
    const first = useAgentsStore.getState().fetchAgents();
    const second = useAgentsStore.getState().fetchAgents({ quiet: true });

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    resolveFetch?.({
      agents: [{ id: 'main', name: 'Main' }],
      defaultAgentId: 'main',
    });
    await first;
    await second;

    await useAgentsStore.getState().fetchAgents({ quiet: true });
    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_001);
    hostApiFetchMock.mockResolvedValueOnce({
      agents: [{ id: 'main', name: 'Main' }],
      defaultAgentId: 'main',
    });
    await useAgentsStore.getState().fetchAgents({ quiet: true });
    expect(hostApiFetchMock).toHaveBeenCalledTimes(2);
  });
});
