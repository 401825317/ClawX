// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UCLAW_SUPPORT_ROUTES } from '@shared/junfeiai-endpoints';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  isManaged: vi.fn(() => true),
}));

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: (...args: unknown[]) => mocks.fetch(...args),
}));

vi.mock('@electron/utils/junfeiai-distribution', () => ({
  getUclawBackendOrigin: () => 'https://uclaw.example.test',
  isUclawManagedDistribution: () => mocks.isManaged(),
}));

import { getSupportContactConfig } from '@electron/services/support-service';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('support service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isManaged.mockReturnValue(true);
  });

  it('normalizes enabled contacts and removes unsafe or disabled entries', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      data: {
        support: {
          enabled: true,
          title: 'JunFeiAI official support',
          description: 'Contact Junfei AI for account help.',
          contacts: [
            {
              id: 'account',
              label: 'JunFeiAI account support',
              description: 'Account and billing',
              qrCodeUrl: 'https://cdn.example.test/account.png',
              workHours: '09:00-18:00',
              wechatId: 'uclaw-account',
              extraNote: 'Official JunFeiAI channel',
            },
            {
              id: 'disabled',
              label: 'Disabled',
              qrCodeUrl: 'https://cdn.example.test/disabled.png',
              enabled: false,
            },
            {
              id: 'unsafe',
              label: 'Unsafe',
              qrCodeUrl: 'javascript:alert(1)',
            },
          ],
        },
      },
    }));

    await expect(getSupportContactConfig()).resolves.toEqual({
      enabled: true,
      title: 'UClaw official support',
      description: 'Contact UClaw for account help.',
      contacts: [{
        id: 'account',
        label: 'UClaw account support',
        description: 'Account and billing',
        qrCodeUrl: 'https://cdn.example.test/account.png',
        workHours: '09:00-18:00',
        wechatId: 'uclaw-account',
        extraNote: 'Official UClaw channel',
      }],
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      `https://uclaw.example.test${UCLAW_SUPPORT_ROUTES.clientConfig}`,
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
      }),
    );
    expect(JSON.stringify(mocks.fetch.mock.calls)).not.toMatch(/authorization|token/i);
  });

  it('falls back to bootstrap on a missing client-config route and accepts legacy contact fields', async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ message: 'Not found' }, 404))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          client: {
            support: {
              enabled: true,
              title: 'Official support',
              qrCodeUrl: 'http://127.0.0.1:8083/support.png',
              wechatId: 'uclaw-help',
            },
          },
        },
      }));

    await expect(getSupportContactConfig()).resolves.toEqual({
      enabled: true,
      title: 'Official support',
      description: undefined,
      contacts: [{
        id: 'support-default',
        label: 'Official support',
        description: undefined,
        qrCodeUrl: 'http://127.0.0.1:8083/support.png',
        workHours: undefined,
        wechatId: 'uclaw-help',
        extraNote: undefined,
      }],
    });
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      2,
      `https://uclaw.example.test${UCLAW_SUPPORT_ROUTES.bootstrap}`,
      expect.any(Object),
    );
  });

  it('returns null for disabled support and skips public requests outside managed distributions', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ support: { enabled: false } }));
    await expect(getSupportContactConfig()).resolves.toBeNull();

    mocks.isManaged.mockReturnValue(false);
    await expect(getSupportContactConfig()).resolves.toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not hide non-404 transport failures behind the bootstrap fallback', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ message: 'Unavailable' }, 503));

    await expect(getSupportContactConfig()).rejects.toThrow('Unavailable');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
