import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { toast } from 'sonner';
import { hostApiFetch } from '@/lib/host-api';

export type ClientAnnouncementLevel = 'normal' | 'important' | 'urgent';

export interface ClientAnnouncement {
  id: string;
  title: string;
  content: string;
  level: ClientAnnouncementLevel;
  publishedAt: string;
  expiresAt?: string;
  link?: string;
  enabled?: boolean;
}

export interface SupportContactConfig {
  enabled: boolean;
  title?: string;
  description?: string;
  contacts?: SupportContactItem[];
  qrCodeUrl?: string;
  workHours?: string;
  wechatId?: string;
  extraNote?: string;
}

export interface SupportContactItem {
  id: string;
  label: string;
  description?: string;
  qrCodeUrl: string;
  workHours?: string;
  wechatId?: string;
  extraNote?: string;
  enabled?: boolean;
}

interface ClientConfigResponse {
  announcements?: {
    enabled?: boolean;
    items?: ClientAnnouncement[];
  };
  support?: SupportContactConfig;
}

interface ClientConfigState {
  announcementsEnabled: boolean;
  announcements: ClientAnnouncement[];
  support: SupportContactConfig | null;
  loading: boolean;
  error: string | null;
  initialized: boolean;
  readKeys: string[];
  toastKeys: string[];
  urgentDismissedKeys: string[];
  urgentAnnouncement: ClientAnnouncement | null;
  fetchConfig: () => Promise<void>;
  markAllAnnouncementsRead: () => void;
  markAnnouncementRead: (announcement: ClientAnnouncement) => void;
  dismissUrgent: (announcement: ClientAnnouncement) => void;
}

function normalizeLevel(value: unknown): ClientAnnouncementLevel {
  if (value === 'important' || value === 'urgent') {
    return value;
  }
  return 'normal';
}

function normalizeAnnouncement(item: Partial<ClientAnnouncement>, index: number): ClientAnnouncement | null {
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const content = typeof item.content === 'string' ? item.content.trim() : '';
  const publishedAt = typeof item.publishedAt === 'string' ? item.publishedAt.trim() : '';
  if (!title || !content || !publishedAt) {
    return null;
  }
  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `client-${index + 1}`,
    title,
    content,
    level: normalizeLevel(item.level),
    publishedAt,
    expiresAt: typeof item.expiresAt === 'string' ? item.expiresAt.trim() : undefined,
    link: typeof item.link === 'string' ? item.link.trim() : undefined,
    enabled: item.enabled !== false,
  };
}

function announcementKey(announcement: ClientAnnouncement): string {
  return [
    announcement.id,
    announcement.publishedAt,
    announcement.title,
    announcement.content,
    announcement.level,
  ].join('|');
}

function isVisibleAnnouncement(announcement: ClientAnnouncement, now = Date.now()): boolean {
  if (announcement.enabled === false) return false;
  const publishedAt = Date.parse(announcement.publishedAt);
  if (Number.isNaN(publishedAt) || publishedAt > now) return false;
  if (announcement.expiresAt) {
    const expiresAt = Date.parse(announcement.expiresAt);
    if (!Number.isNaN(expiresAt) && expiresAt < now) return false;
  }
  return true;
}

function normalizeSupportContact(item: Partial<SupportContactItem>, index: number): SupportContactItem | null {
  const qrCodeUrl = typeof item.qrCodeUrl === 'string' ? item.qrCodeUrl.trim() : '';
  if (!qrCodeUrl || item.enabled === false) {
    return null;
  }
  const label = typeof item.label === 'string' && item.label.trim()
    ? item.label.trim()
    : `Support ${index + 1}`;
  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `support-${index + 1}`,
    label,
    description: typeof item.description === 'string' ? item.description.trim() : undefined,
    qrCodeUrl,
    workHours: typeof item.workHours === 'string' ? item.workHours.trim() : undefined,
    wechatId: typeof item.wechatId === 'string' ? item.wechatId.trim() : undefined,
    extraNote: typeof item.extraNote === 'string' ? item.extraNote.trim() : undefined,
    enabled: true,
  };
}

function normalizeSupport(support?: SupportContactConfig): SupportContactConfig | null {
  if (!support?.enabled) {
    return null;
  }
  const contacts = Array.isArray(support.contacts)
    ? support.contacts
      .map((item, index) => normalizeSupportContact(item, index))
      .filter((item): item is SupportContactItem => Boolean(item))
    : [];
  if (contacts.length === 0 && support.qrCodeUrl?.trim()) {
    const legacyContact = normalizeSupportContact({
      id: 'support-default',
      label: support.title?.trim() || 'Official Support',
      description: support.description,
      qrCodeUrl: support.qrCodeUrl,
      workHours: support.workHours,
      wechatId: support.wechatId,
      extraNote: support.extraNote,
      enabled: true,
    }, 0);
    if (legacyContact) {
      contacts.push(legacyContact);
    }
  }
  if (contacts.length === 0) {
    return null;
  }
  return {
    enabled: true,
    title: support.title?.trim(),
    description: support.description?.trim(),
    contacts,
    qrCodeUrl: contacts[0]?.qrCodeUrl,
    workHours: contacts[0]?.workHours,
    wechatId: contacts[0]?.wechatId,
    extraNote: contacts[0]?.extraNote,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueAppend(current: string[], keys: string[]): string[] {
  return Array.from(new Set([...current, ...keys])).slice(-200);
}

export const useClientConfigStore = create<ClientConfigState>()(
  persist(
    (set, get) => ({
      announcementsEnabled: false,
      announcements: [],
      support: null,
      loading: false,
      error: null,
      initialized: false,
      readKeys: [],
      toastKeys: [],
      urgentDismissedKeys: [],
      urgentAnnouncement: null,

      fetchConfig: async () => {
        set({ loading: true, error: null });
        try {
          const payload = await hostApiFetch<ClientConfigResponse>('/api/junfeiai/client-config');
          const rawItems = Array.isArray(payload.announcements?.items)
            ? payload.announcements.items
            : [];
          const announcements = rawItems
            .map((item, index) => normalizeAnnouncement(item, index))
            .filter((item): item is ClientAnnouncement => Boolean(item))
            .filter((item) => isVisibleAnnouncement(item))
            .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
          const support = normalizeSupport(payload.support);
          const current = get();
          const unreadImportant = announcements.find((item) => {
            const key = announcementKey(item);
            return item.level === 'important'
              && !current.readKeys.includes(key)
              && !current.toastKeys.includes(key);
          });
          const unreadUrgent = announcements.find((item) => {
            const key = announcementKey(item);
            return item.level === 'urgent'
              && !current.readKeys.includes(key)
              && !current.urgentDismissedKeys.includes(key);
          });
          const currentUrgent = current.urgentAnnouncement;
          const retainedUrgent = currentUrgent
            && announcements.some((item) => announcementKey(item) === announcementKey(currentUrgent))
            ? currentUrgent
            : null;

          if (unreadImportant) {
            toast.info(unreadImportant.title, {
              description: unreadImportant.content,
            });
          }

          set({
            announcementsEnabled: Boolean(payload.announcements?.enabled),
            announcements: payload.announcements?.enabled === false ? [] : announcements,
            support,
            loading: false,
            error: null,
            initialized: true,
            toastKeys: unreadImportant
              ? uniqueAppend(current.toastKeys, [announcementKey(unreadImportant)])
              : current.toastKeys,
            urgentAnnouncement: unreadUrgent ?? retainedUrgent,
          });
        } catch (error) {
          set({
            loading: false,
            initialized: true,
            error: errorMessage(error),
          });
        }
      },

      markAllAnnouncementsRead: () => {
        const keys = get().announcements.map(announcementKey);
        set((state) => ({ readKeys: uniqueAppend(state.readKeys, keys) }));
      },

      markAnnouncementRead: (announcement) => {
        const key = announcementKey(announcement);
        set((state) => ({ readKeys: uniqueAppend(state.readKeys, [key]) }));
      },

      dismissUrgent: (announcement) => {
        const key = announcementKey(announcement);
        set((state) => ({
          readKeys: uniqueAppend(state.readKeys, [key]),
          urgentDismissedKeys: uniqueAppend(state.urgentDismissedKeys, [key]),
          urgentAnnouncement: state.urgentAnnouncement?.id === announcement.id ? null : state.urgentAnnouncement,
        }));
      },
    }),
    {
      name: 'clawx-client-config',
      partialize: (state) => ({
        readKeys: state.readKeys,
        toastKeys: state.toastKeys,
        urgentDismissedKeys: state.urgentDismissedKeys,
      }),
    },
  ),
);

export function getClientAnnouncementKey(announcement: ClientAnnouncement): string {
  return announcementKey(announcement);
}
