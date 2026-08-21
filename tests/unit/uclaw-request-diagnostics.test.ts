// @vitest-environment node

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  netFetch: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '2.0.3',
    isPackaged: true,
  },
  net: {
    fetch: mocks.netFetch,
  },
}));

vi.mock('@electron/utils/junfeiai-distribution', () => ({
  getUclawBackendOrigin: () => 'https://zz-cn.example.com',
}));

vi.mock('@electron/utils/store', () => ({
  getSetting: mocks.getSetting,
}));

vi.mock('@electron/utils/installation-id', () => ({
  getOrCreateInstallationId: async () => 'installation-secret',
}));

vi.mock('@electron/utils/build-identity', () => ({
  getUclawBuildIdentity: () => ({
    appVersion: '2.0.3',
    gitCommit: '0123456789abcdef0123456789abcdef01234567',
    buildId: 'build-identity-test',
    platform: 'win32',
    arch: 'x64',
  }),
}));

import {
  getUclawDiagnosticHeaders,
  mergeUclawDiagnosticHeaders,
} from '@electron/utils/uclaw-request-diagnostics';
import { proxyAwareFetch } from '@electron/utils/proxy-fetch';

function redirectResponse(status: number, location?: string): Response {
  const headers = new Headers();
  if (location) headers.set('location', location);
  return { status, headers } as Response;
}

describe('UClaw request diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CLAWX_PORTABLE', '1');
    mocks.getSetting.mockImplementation(async (key: string) => (
      key === 'updateChannel' ? 'stable' : 'installation-secret'
    ));
    mocks.netFetch.mockReset();
    vi.stubGlobal('fetch', mocks.netFetch);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('builds a portable release identity without exposing the installation id', async () => {
    const headers = await getUclawDiagnosticHeaders({ includeRequestId: false });
    expect(headers).toEqual({
      'X-UClaw-Client': 'desktop',
      'X-UClaw-Version': '2.0.3',
      'X-UClaw-Commit': '0123456789abcdef0123456789abcdef01234567',
      'X-UClaw-Build-Id': 'build-identity-test',
      'X-UClaw-Platform': 'win32',
      'X-UClaw-Arch': 'x64',
      'X-UClaw-Channel': 'stable',
      'X-UClaw-Mode': 'portable',
      'X-UClaw-Install-Id': createHash('sha256').update('installation-secret').digest('hex'),
    });
    expect(JSON.stringify(headers)).not.toContain('installation-secret');
  });

  it('overrides spoofed diagnostic headers case-insensitively while preserving unrelated headers', () => {
    expect(mergeUclawDiagnosticHeaders({
      Authorization: 'Bearer relay-token',
      'x-uclaw-version': 'spoofed',
      'X-Request-ID': 'reused',
    }, {
      'X-UClaw-Version': '2.0.3',
      'X-Request-Id': 'fresh-request',
    })).toEqual({
      Authorization: 'Bearer relay-token',
      'X-UClaw-Version': '2.0.3',
      'X-Request-Id': 'fresh-request',
    });
  });

  it('follows managed redirects only while they remain on the exact UClaw origin', async () => {
    mocks.netFetch
      .mockResolvedValueOnce(redirectResponse(302, '/v1/responses-next'))
      .mockResolvedValueOnce(redirectResponse(200));

    const response = await proxyAwareFetch('https://zz-cn.example.com/v1/responses');

    expect(response.status).toBe(200);
    expect(mocks.netFetch).toHaveBeenCalledTimes(2);
    expect(String(mocks.netFetch.mock.calls[1]?.[0])).toBe('https://zz-cn.example.com/v1/responses-next');
    for (const [, init] of mocks.netFetch.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual' });
      expect(new Headers(init?.headers).get('X-UClaw-Version')).toBe('2.0.3');
    }
  });

  it('does not follow a managed redirect to another origin', async () => {
    mocks.netFetch.mockResolvedValueOnce(redirectResponse(302, 'https://evil.example/v1/responses'));

    const response = await proxyAwareFetch('https://zz-cn.example.com/v1/responses', {
      headers: { Authorization: 'Bearer managed-secret' },
    });

    expect(response.status).toBe(302);
    expect(mocks.netFetch).toHaveBeenCalledTimes(1);
    expect(mocks.netFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(mocks.netFetch.mock.calls.some(([url]) => String(url).startsWith('https://evil.example'))).toBe(false);
  });

  it.each([301, 302, 303])(
    'converts POST to GET and removes entity headers after a %i redirect',
    async (status) => {
      mocks.netFetch
        .mockResolvedValueOnce(redirectResponse(status, '/v1/redirected'))
        .mockResolvedValueOnce(redirectResponse(200));

      await proxyAwareFetch('https://zz-cn.example.com/v1/responses', {
        method: 'POST',
        body: 'request-body',
        headers: {
          Authorization: 'Bearer managed-secret',
          'Content-Length': '12',
          'Content-Type': 'application/json',
          'X-Correlation': 'preserved',
        },
      });

      const redirectedInit = mocks.netFetch.mock.calls[1]?.[1];
      const redirectedHeaders = new Headers(redirectedInit?.headers);
      expect(redirectedInit).toMatchObject({ method: 'GET', redirect: 'manual' });
      expect(redirectedInit?.body).toBeUndefined();
      expect(redirectedHeaders.get('content-length')).toBeNull();
      expect(redirectedHeaders.get('content-type')).toBeNull();
      expect(redirectedHeaders.get('authorization')).toBe('Bearer managed-secret');
      expect(redirectedHeaders.get('x-correlation')).toBe('preserved');
    },
  );

  it.each([307, 308])('preserves POST method and body after a %i redirect', async (status) => {
    mocks.netFetch
      .mockResolvedValueOnce(redirectResponse(status, '/v1/redirected'))
      .mockResolvedValueOnce(redirectResponse(200));

    await proxyAwareFetch('https://zz-cn.example.com/v1/responses', {
      method: 'POST',
      body: 'request-body',
      headers: {
        'Content-Length': '12',
        'Content-Type': 'application/json',
      },
    });

    const redirectedInit = mocks.netFetch.mock.calls[1]?.[1];
    const redirectedHeaders = new Headers(redirectedInit?.headers);
    expect(redirectedInit).toMatchObject({ method: 'POST', body: 'request-body', redirect: 'manual' });
    expect(redirectedHeaders.get('content-length')).toBe('12');
    expect(redirectedHeaders.get('content-type')).toBe('application/json');
  });

  it('returns the original redirect response when Location is invalid', async () => {
    mocks.netFetch.mockResolvedValueOnce(redirectResponse(302, 'http://[invalid'));

    const response = await proxyAwareFetch('https://zz-cn.example.com/v1/responses');

    expect(response.status).toBe(302);
    expect(mocks.netFetch).toHaveBeenCalledTimes(1);
  });

  it('stops after five managed redirects in a redirect chain', async () => {
    for (let index = 1; index <= 6; index += 1) {
      mocks.netFetch.mockResolvedValueOnce(redirectResponse(302, `/v1/step-${index}`));
    }

    const response = await proxyAwareFetch('https://zz-cn.example.com/v1/start');

    expect(response.status).toBe(302);
    expect(mocks.netFetch).toHaveBeenCalledTimes(6);
    expect(String(mocks.netFetch.mock.calls[5]?.[0])).toBe('https://zz-cn.example.com/v1/step-5');
  });

  it('stops a managed redirect loop after five redirects', async () => {
    for (let index = 0; index < 6; index += 1) {
      mocks.netFetch.mockResolvedValueOnce(redirectResponse(302, '/v1/loop'));
    }

    const response = await proxyAwareFetch('https://zz-cn.example.com/v1/loop');

    expect(response.status).toBe(302);
    expect(mocks.netFetch).toHaveBeenCalledTimes(6);
    expect(mocks.netFetch.mock.calls.every(([url]) => String(url) === 'https://zz-cn.example.com/v1/loop')).toBe(true);
  });
});
