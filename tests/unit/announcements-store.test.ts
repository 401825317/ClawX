import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientAnnouncement } from '@/lib/host-api';

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    announcements: {
      config: (...args: unknown[]) => mocks.config(...args),
    },
  },
}));

vi.mock('sonner', () => ({
  toast: { info: (...args: unknown[]) => mocks.toastInfo(...args) },
}));

import {
  isClientAnnouncementRead,
  useAnnouncementsStore,
} from '@/stores/announcements';

const announcement: ClientAnnouncement = {
  id: 'maintenance-2026-09-05',
  title: 'UClaw maintenance',
  content: 'The service will be updated.',
  level: 'important',
  publishedAt: '2026-09-04T20:00:00.000Z',
};

function legacyAnnouncementKey(item: ClientAnnouncement): string {
  return [item.id, item.publishedAt, 'JunFeiAI maintenance', item.content, item.level].join('|');
}

describe('announcement store migration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.removeItem('uclaw-announcements');
    localStorage.removeItem('clawx-client-config');
    useAnnouncementsStore.setState({
      config: null,
      announcements: [],
      history: [],
      initialized: false,
      loading: false,
      error: null,
      readKeys: [],
      toastKeys: [],
      urgentDismissedKeys: [],
      urgentAnnouncement: null,
    });
    await useAnnouncementsStore.persist.rehydrate();
  });

  it('recognizes the historical pipe key even after UClaw branding normalization', () => {
    expect(isClientAnnouncementRead(announcement, [legacyAnnouncementKey(announcement)])).toBe(true);
  });

  it('hydrates the old ClawX store and suppresses a repeat important toast', async () => {
    const legacyKey = legacyAnnouncementKey(announcement);
    localStorage.setItem('clawx-client-config', JSON.stringify({
      state: {
        readKeys: [legacyKey],
        toastKeys: [],
        urgentDismissedKeys: [],
      },
      version: 0,
    }));

    await useAnnouncementsStore.persist.rehydrate();
    expect(useAnnouncementsStore.getState().readKeys).toContain(legacyKey);

    mocks.config.mockResolvedValueOnce({ enabled: true, items: [announcement] });
    await useAnnouncementsStore.getState().fetchConfig();

    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it('keeps fetched announcements in a local history archive', async () => {
    const olderAnnouncement: ClientAnnouncement = {
      id: 'release-2026-09-01',
      title: 'UClaw release',
      content: 'A previous client release is available in the archive.',
      level: 'normal',
      publishedAt: '2026-09-01T20:00:00.000Z',
    };
    mocks.config.mockResolvedValueOnce({
      enabled: true,
      items: [announcement, olderAnnouncement],
    });

    await useAnnouncementsStore.getState().fetchConfig();

    expect(useAnnouncementsStore.getState().history).toEqual([announcement, olderAnnouncement]);
    const persisted = JSON.parse(localStorage.getItem('uclaw-announcements') ?? '{}') as {
      state?: { history?: ClientAnnouncement[] };
    };
    expect(persisted.state?.history).toEqual([announcement, olderAnnouncement]);

    const persistedSnapshot = localStorage.getItem('uclaw-announcements');
    useAnnouncementsStore.setState({ history: [] });
    if (persistedSnapshot) localStorage.setItem('uclaw-announcements', persistedSnapshot);
    await useAnnouncementsStore.persist.rehydrate();
    expect(useAnnouncementsStore.getState().history).toEqual([announcement, olderAnnouncement]);
  });
});
