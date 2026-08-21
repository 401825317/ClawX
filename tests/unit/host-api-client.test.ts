import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostApiError, invokeHost } from '@/lib/host-api-client';

describe('host api client recoverable contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes only the allowlisted recoverable browser fields', async () => {
    const hostInvoke = vi.fn().mockResolvedValue({
      id: 'request-1',
      ok: false,
      error: {
        code: 'INTERNAL',
        message: 'Browser navigation timed out',
        details: {
          contract: 'recoverable-v1',
          code: 'web_browser_navigation_timeout',
          recoverable: true,
          restartGateway: false,
          recovery: 'Retry once.',
          stack: 'must not be exposed',
        },
      },
    });
    vi.stubGlobal('window', { clawx: { hostInvoke } });
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' });

    await expect(invokeHost('webBrowser', 'navigate', { url: 'https://example.com/' }))
      .rejects.toMatchObject({
        code: 'web_browser_navigation_timeout',
        hostCode: 'INTERNAL',
        recoverable: true,
        restartGateway: false,
        recovery: 'Retry once.',
      });
    try {
      await invokeHost('webBrowser', 'navigate', { url: 'https://example.com/' });
    } catch (error) {
      expect(error).toBeInstanceOf(HostApiError);
      expect((error as HostApiError).stack).not.toContain('must not be exposed');
    }
  });

  it('ignores unknown details instead of treating them as recoverable', async () => {
    const hostInvoke = vi.fn().mockResolvedValue({
      id: 'request-2',
      ok: false,
      error: {
        code: 'INTERNAL',
        message: 'Host request failed',
        details: {
          contract: 'recoverable-v1',
          code: 'arbitrary_error',
          recoverable: true,
          restartGateway: false,
          recovery: 'run something unsafe',
        },
      },
    });
    vi.stubGlobal('window', { clawx: { hostInvoke } });
    vi.stubGlobal('crypto', { randomUUID: () => 'request-2' });

    await expect(invokeHost('webBrowser', 'navigate', { url: 'https://example.com/' }))
      .rejects.toMatchObject({ hostCode: 'INTERNAL', recoverable: false });
  });
});
