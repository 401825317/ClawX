import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostInvoke = vi.fn();

describe('hostApi application quit', () => {
  beforeEach(() => {
    hostInvoke.mockReset();
    vi.resetModules();
    vi.stubGlobal('window', {
      clawx: { hostInvoke },
    });
  });

  it('routes graceful application quit through hostInvoke', async () => {
    hostInvoke.mockResolvedValueOnce({ id: 'req', ok: true, data: undefined });
    const { hostApi } = await import('@/lib/host-api');

    await expect(hostApi.app.quit()).resolves.toBeUndefined();
    expect(hostInvoke).toHaveBeenCalledWith(expect.objectContaining({
      module: 'app',
      action: 'quit',
    }));
  });
});
