import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { toast } from 'sonner';
import type {
  ClientAnnouncement,
  ClientAnnouncementConfig,
} from '@/lib/host-api';
import { hostApi } from '@/lib/host-api';

const MAX_PERSISTED_KEYS = 200;
const MAX_PERSISTED_ANNOUNCEMENTS = 100;
const LEGACY_ANNOUNCEMENT_STORAGE_KEY = 'clawx-client-config';

type PersistedAnnouncementKeys = {
  readKeys: string[];
  toastKeys: string[];
  urgentDismissedKeys: string[];
};

type PersistedAnnouncementState = PersistedAnnouncementKeys & {
  history: ClientAnnouncement[];
};

type AnnouncementState = {
  config: ClientAnnouncementConfig | null;
  announcements: ClientAnnouncement[];
  history: ClientAnnouncement[];
  initialized: boolean;
  loading: boolean;
  error: string | null;
  readKeys: string[];
  toastKeys: string[];
  urgentDismissedKeys: string[];
  urgentAnnouncement: ClientAnnouncement | null;
  fetchConfig: () => Promise<void>;
  markAllAnnouncementsRead: () => void;
  markAnnouncementRead: (announcement: ClientAnnouncement) => void;
  dismissUrgent: (announcement: ClientAnnouncement) => void;
};

let loadGeneration = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function extractPersistedAnnouncementKeys(value: unknown): PersistedAnnouncementKeys {
  const container = isRecord(value) && isRecord(value.state) ? value.state : value;
  return {
    readKeys: stringArray(isRecord(container) ? container.readKeys : undefined),
    toastKeys: stringArray(isRecord(container) ? container.toastKeys : undefined),
    urgentDismissedKeys: stringArray(isRecord(container) ? container.urgentDismissedKeys : undefined),
  };
}

function isPersistedAnnouncement(value: unknown): value is ClientAnnouncement {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string'
    || typeof value.title !== 'string'
    || typeof value.content !== 'string'
    || (value.level !== 'normal' && value.level !== 'important' && value.level !== 'urgent')
    || typeof value.publishedAt !== 'string'
    || Number.isNaN(Date.parse(value.publishedAt))
  ) {
    return false;
  }
  if (value.expiresAt !== undefined && value.expiresAt !== null) {
    if (typeof value.expiresAt !== 'string' || Number.isNaN(Date.parse(value.expiresAt))) return false;
  }
  if (value.link !== undefined) {
    if (typeof value.link !== 'string') return false;
    try {
      const link = new URL(value.link);
      if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function extractPersistedAnnouncementState(value: unknown): PersistedAnnouncementState {
  const container = isRecord(value) && isRecord(value.state) ? value.state : value;
  const historyValue = isRecord(container) ? container.history : undefined;
  return {
    ...extractPersistedAnnouncementKeys(value),
    history: Array.isArray(historyValue)
      ? historyValue.filter(isPersistedAnnouncement).slice(0, MAX_PERSISTED_ANNOUNCEMENTS)
      : [],
  };
}

function readPersistedAnnouncementKeys(storageKey: string): PersistedAnnouncementKeys {
  try {
    if (typeof globalThis.localStorage === 'undefined') {
      return { readKeys: [], toastKeys: [], urgentDismissedKeys: [] };
    }
    const raw = globalThis.localStorage.getItem(storageKey);
    return raw ? extractPersistedAnnouncementKeys(JSON.parse(raw) as unknown) : {
      readKeys: [],
      toastKeys: [],
      urgentDismissedKeys: [],
    };
  } catch {
    return { readKeys: [], toastKeys: [], urgentDismissedKeys: [] };
  }
}

export function getClientAnnouncementKey(announcement: ClientAnnouncement): string {
  // JSON avoids collisions when server-authored fields contain a separator.
  return JSON.stringify([
    announcement.id,
    announcement.publishedAt,
    announcement.title,
    announcement.content,
    announcement.level,
  ]);
}

function getClientAnnouncementIdentityKey(announcement: ClientAnnouncement): string {
  return JSON.stringify([announcement.id, announcement.publishedAt]);
}

function getLegacyClientAnnouncementKey(announcement: ClientAnnouncement): string {
  return [
    announcement.id,
    announcement.publishedAt,
    announcement.title,
    announcement.content,
    announcement.level,
  ].join('|');
}

function parseAnnouncementIdentityKey(key: string): string | null {
  if (key.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(key);
      if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
        return JSON.stringify([parsed[0], parsed[1]]);
      }
    } catch {
      return null;
    }
  }

  const firstSeparator = key.indexOf('|');
  const secondSeparator = key.indexOf('|', firstSeparator + 1);
  if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1) return null;
  return JSON.stringify([key.slice(0, firstSeparator), key.slice(firstSeparator + 1, secondSeparator)]);
}

export function isClientAnnouncementRead(announcement: ClientAnnouncement, keys: string[]): boolean {
  const identityKey = getClientAnnouncementIdentityKey(announcement);
  const currentKey = getClientAnnouncementKey(announcement);
  const legacyKey = getLegacyClientAnnouncementKey(announcement);
  return keys.some((key) => key === currentKey || key === legacyKey || parseAnnouncementIdentityKey(key) === identityKey);
}

function appendKeys(current: string[], additions: string[]): string[] {
  return Array.from(new Set([...current, ...additions])).slice(-MAX_PERSISTED_KEYS);
}

function mergeAnnouncementHistory(current: ClientAnnouncement[], incoming: ClientAnnouncement[]): ClientAnnouncement[] {
  const byIdentity = new Map<string, ClientAnnouncement>();
  for (const item of [...current, ...incoming]) {
    byIdentity.set(getClientAnnouncementIdentityKey(item), item);
  }
  return Array.from(byIdentity.values())
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    .slice(0, MAX_PERSISTED_ANNOUNCEMENTS);
}

function isUnread(announcement: ClientAnnouncement, keys: string[]): boolean {
  return !isClientAnnouncementRead(announcement, keys);
}

const initialLegacyKeys = readPersistedAnnouncementKeys(LEGACY_ANNOUNCEMENT_STORAGE_KEY);

export const useAnnouncementsStore = create<AnnouncementState>()(
  persist(
    (set, get) => ({
      config: null,
      announcements: [],
      history: [],
      initialized: false,
      loading: false,
      error: null,
      readKeys: initialLegacyKeys.readKeys,
      toastKeys: initialLegacyKeys.toastKeys,
      urgentDismissedKeys: initialLegacyKeys.urgentDismissedKeys,
      urgentAnnouncement: null,

      fetchConfig: async () => {
        const generation = ++loadGeneration;
        set({ loading: true, error: null });
        try {
          const config = await hostApi.announcements.config();
          if (generation !== loadGeneration) return;

          const current = get();
          const announcements = config?.enabled === true ? config.items : [];
          const history = mergeAnnouncementHistory(current.history, announcements);
          const important = announcements.find((item) => (
            item.level === 'important'
            && isUnread(item, current.readKeys)
            && isUnread(item, current.toastKeys)
          ));
          const urgent = announcements.find((item) => (
            item.level === 'urgent'
            && isUnread(item, current.readKeys)
            && isUnread(item, current.urgentDismissedKeys)
          ));
          const retainedUrgent = current.urgentAnnouncement
            && announcements.some((item) => getClientAnnouncementKey(item) === getClientAnnouncementKey(current.urgentAnnouncement!))
            ? current.urgentAnnouncement
            : null;

          if (important) {
            toast.info(important.title, { description: important.content });
          }

          set({
            config,
            announcements,
            history,
            initialized: true,
            loading: false,
            error: null,
            toastKeys: important
              ? appendKeys(current.toastKeys, [getClientAnnouncementKey(important)])
              : current.toastKeys,
            urgentAnnouncement: urgent ?? retainedUrgent,
          });
        } catch (error) {
          if (generation !== loadGeneration) return;
          set({
            loading: false,
            initialized: true,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },

      markAllAnnouncementsRead: () => {
        const keys = get().announcements.map(getClientAnnouncementKey);
        set((state) => ({ readKeys: appendKeys(state.readKeys, keys) }));
      },

      markAnnouncementRead: (announcement) => {
        const key = getClientAnnouncementKey(announcement);
        set((state) => ({ readKeys: appendKeys(state.readKeys, [key]) }));
      },

      dismissUrgent: (announcement) => {
        const key = getClientAnnouncementKey(announcement);
        set((state) => ({
          readKeys: appendKeys(state.readKeys, [key]),
          urgentDismissedKeys: appendKeys(state.urgentDismissedKeys, [key]),
          urgentAnnouncement: state.urgentAnnouncement
            && getClientAnnouncementKey(state.urgentAnnouncement) === key
            ? null
            : state.urgentAnnouncement,
        }));
      },
    }),
    {
      name: 'uclaw-announcements',
      partialize: (state) => ({
        readKeys: state.readKeys,
        toastKeys: state.toastKeys,
        urgentDismissedKeys: state.urgentDismissedKeys,
        history: state.history,
      }),
      merge: (persistedState, currentState) => {
        const persisted = extractPersistedAnnouncementState(persistedState);
        const legacy = readPersistedAnnouncementKeys(LEGACY_ANNOUNCEMENT_STORAGE_KEY);
        return {
          ...currentState,
          history: mergeAnnouncementHistory(currentState.history, persisted.history),
          readKeys: appendKeys(legacy.readKeys, persisted.readKeys),
          toastKeys: appendKeys(legacy.toastKeys, persisted.toastKeys),
          urgentDismissedKeys: appendKeys(legacy.urgentDismissedKeys, persisted.urgentDismissedKeys),
        };
      },
    },
  ),
);
