// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UCLAW_SUPPORT_ROUTES } from '@shared/junfeiai-endpoints';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: (...args: unknown[]) => mocks.fetch(...args),
}));

vi.mock('@electron/utils/junfeiai-distribution', () => ({
  getUclawBackendOrigin: () => 'https://uclaw.example.test',
}));

import { fetchPublicClientConfigPayload } from '@electron/services/public-client-config-service';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function invalidJsonResponse(status = 200): Response {
  return new Response('{invalid', {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('public client-config service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('unwraps a successful data envelope without attaching credentials', async () => {
    const payload = { announcements: { enabled: true, items: [] } };
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ success: true, data: payload }));

    await expect(fetchPublicClientConfigPayload()).resolves.toEqual(payload);
    expect(mocks.fetch).toHaveBeenCalledWith(
      `https://uclaw.example.test${UCLAW_SUPPORT_ROUTES.clientConfig}`,
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
      }),
    );
  });

  it('rejects a non-zero response code even when data is present', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      code: 500,
      message: 'backend unavailable',
      data: { announcements: { enabled: true, items: [] } },
    }));

    await expect(fetchPublicClientConfigPayload()).rejects.toThrow('backend unavailable');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid JSON so callers can preserve their last valid feed', async () => {
    mocks.fetch.mockResolvedValueOnce(invalidJsonResponse());

    await expect(fetchPublicClientConfigPayload()).rejects.toThrow('Unable to reach UClaw client-config');
  });

  it('falls back to bootstrap only for a missing client-config route', async () => {
    const payload = { client: { announcements: { enabled: true, items: [] } } };
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ message: 'Not found' }, 404))
      .mockResolvedValueOnce(jsonResponse({ data: payload }));

    await expect(fetchPublicClientConfigPayload()).resolves.toEqual(payload);
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      2,
      `https://uclaw.example.test${UCLAW_SUPPORT_ROUTES.bootstrap}`,
      expect.any(Object),
    );
  });
});
