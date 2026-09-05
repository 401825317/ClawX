// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchConfig: vi.fn(),
  isManaged: vi.fn(() => true),
}));

vi.mock('@electron/services/public-client-config-service', () => ({
  fetchPublicClientConfigPayload: (...args: unknown[]) => mocks.fetchConfig(...args),
}));

vi.mock('@electron/utils/junfeiai-distribution', () => ({
  isUclawManagedDistribution: () => mocks.isManaged(),
}));

import { getClientAnnouncementConfig } from '@electron/services/announcements-service';

const past = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const future = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

describe('announcements service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isManaged.mockReturnValue(true);
  });

  it('normalizes, filters, sorts, and sanitizes public announcements', async () => {
    mocks.fetchConfig.mockResolvedValueOnce({
      announcements: {
        enabled: true,
        items: [
          {
            id: 'older',
            title: 'JunFeiAI release',
            content: 'Contact 君飞 AI support.',
            level: 'normal',
            publishedAt: past(20),
            link: 'javascript:alert(1)',
          },
          {
            id: 'newer',
            title: 'Maintenance',
            content: 'The service is being updated.',
            level: 'important',
            publishedAt: past(5),
            link: 'https://example.test/maintenance',
          },
          {
            id: 'future',
            title: 'Future',
            content: 'Not visible yet.',
            publishedAt: future(5),
          },
          {
            id: 'expired',
            title: 'Expired',
            content: 'No longer visible.',
            publishedAt: past(30),
            expiresAt: past(1),
          },
          {
            id: 'disabled',
            title: 'Disabled',
            content: 'Hidden by the server.',
            publishedAt: past(1),
            enabled: false,
          },
        ],
      },
    });

    await expect(getClientAnnouncementConfig()).resolves.toEqual({
      enabled: true,
      items: [
        {
          id: 'newer',
          title: 'Maintenance',
          content: 'The service is being updated.',
          level: 'important',
          publishedAt: expect.any(String),
          link: 'https://example.test/maintenance',
        },
        {
          id: 'older',
          title: 'UClaw release',
          content: 'Contact UClaw support.',
          level: 'normal',
          publishedAt: expect.any(String),
        },
      ],
    });
  });

  it('keeps the legacy default-on behavior when the feed omits its enabled flag', async () => {
    mocks.fetchConfig.mockResolvedValueOnce({
      announcements: {
        items: [{
          id: 'default-on',
          title: 'Default on',
          content: 'Visible without an explicit feed flag.',
          publishedAt: past(1),
        }],
      },
    });

    await expect(getClientAnnouncementConfig()).resolves.toEqual({
      enabled: true,
      items: [{
        id: 'default-on',
        title: 'Default on',
        content: 'Visible without an explicit feed flag.',
        level: 'normal',
        publishedAt: expect.any(String),
      }],
    });
  });

  it('accepts the bootstrap client envelope and rejects malformed or unsafe fields', async () => {
    mocks.fetchConfig.mockResolvedValueOnce({
      client: {
        announcements: {
          enabled: true,
          items: [
            { title: '', content: 'missing title', publishedAt: past(1) },
            { title: 'Bad date', content: 'bad', publishedAt: 'not-a-date' },
            {
              id: 'bad-expiry',
              title: 'Bad expiry',
              content: 'This item must be discarded.',
              publishedAt: past(1),
              expiresAt: 'not-a-date',
            },
            {
              id: 'safe',
              title: 'Safe',
              content: 'Read this update.',
              publishedAt: past(1),
              link: 'https://user:password@example.test/private',
            },
          ],
        },
      },
    });

    await expect(getClientAnnouncementConfig()).resolves.toEqual({
      enabled: true,
      items: [{
        id: 'safe',
        title: 'Safe',
        content: 'Read this update.',
        level: 'normal',
        publishedAt: expect.any(String),
      }],
    });
  });

  it('returns null for disabled announcements and unmanaged distributions', async () => {
    mocks.fetchConfig.mockResolvedValueOnce({ announcements: { enabled: false, items: [] } });
    await expect(getClientAnnouncementConfig()).resolves.toBeNull();

    mocks.isManaged.mockReturnValue(false);
    await expect(getClientAnnouncementConfig()).resolves.toBeNull();
    expect(mocks.fetchConfig).toHaveBeenCalledTimes(1);
  });

  it('fails closed for malformed enabled flags', async () => {
    mocks.fetchConfig.mockResolvedValueOnce({
      announcements: {
        enabled: 'false',
        items: [{
          id: 'malformed-feed',
          title: 'Should stay hidden',
          content: 'The feed flag is not boolean.',
          publishedAt: past(1),
        }],
      },
    });
    await expect(getClientAnnouncementConfig()).resolves.toBeNull();

    mocks.fetchConfig.mockResolvedValueOnce({
      announcements: {
        enabled: true,
        items: [{
          id: 'malformed-item',
          title: 'Should stay hidden',
          content: 'The item flag is not boolean.',
          publishedAt: past(1),
          enabled: 1,
        }],
      },
    });
    await expect(getClientAnnouncementConfig()).resolves.toEqual({ enabled: true, items: [] });
  });

});
