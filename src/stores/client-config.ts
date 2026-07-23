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

export interface ClientTextModelOption {
  id: string;
  label: string;
  description?: string;
  enabled?: boolean;
}

export interface ClientImageModelOption {
  id: string;
  label: string;
  description?: string;
  sizes: string[];
  qualities: string[];
  defaultSize?: string;
  defaultQuality?: string;
  supportsEditing?: boolean;
  enabled?: boolean;
}

export interface ClientVideoModelOption {
  id: string;
  label: string;
  description?: string;
  modes: string[];
  sizes: string[];
  durations: number[];
  defaultSize?: string;
  defaultDurationSeconds?: number;
  requiresImage?: boolean;
  enabled?: boolean;
}

export interface ClientModelOptionsConfig {
  text: {
    defaultModel: string;
    models: ClientTextModelOption[];
  };
  image: {
    defaultModel: string;
    defaultSize: string;
    defaultQuality: string;
    models: ClientImageModelOption[];
  };
  video: {
    defaultModel: string;
    defaultSize: string;
    defaultDurationSeconds: number;
    models: ClientVideoModelOption[];
  };
}

interface ClientConfigResponse {
  announcements?: {
    enabled?: boolean;
    items?: ClientAnnouncement[];
  };
  support?: SupportContactConfig;
  modelOptions?: Partial<ClientModelOptionsConfig>;
}

interface ClientConfigState {
  announcementsEnabled: boolean;
  announcements: ClientAnnouncement[];
  support: SupportContactConfig | null;
  modelOptions: ClientModelOptionsConfig;
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

export const DEFAULT_CLIENT_MODEL_OPTIONS: ClientModelOptionsConfig = {
  text: {
    defaultModel: 'smart-latest',
    models: [
      {
        id: 'smart-latest',
        label: '智能路由',
        description: '自动选择合适的文本模型。',
        enabled: true,
      },
    ],
  },
  image: {
    defaultModel: 'gpt-image-2',
    defaultSize: '2048x2048',
    defaultQuality: 'medium',
    models: [
      {
        id: 'gpt-image-2',
        label: 'Image 2',
        description: 'Image generation and editing.',
        sizes: [
          '1024x1024',
          '1536x1024',
          '1024x1536',
          '2048x2048',
          '2048x1152',
          '3840x2160',
          '2160x3840',
        ],
        qualities: ['low', 'medium', 'high'],
        defaultSize: '2048x2048',
        defaultQuality: 'medium',
        supportsEditing: true,
        enabled: true,
      },
    ],
  },
  video: {
    defaultModel: '',
    defaultSize: '',
    defaultDurationSeconds: 0,
    models: [],
  },
};

function cloneDefaultModelOptions(): ClientModelOptionsConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CLIENT_MODEL_OPTIONS)) as ClientModelOptionsConfig;
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

function normalizeStringList(values: unknown, fallback: string[]): string[] {
  if (!Array.isArray(values)) {
    return [...fallback];
  }
  const result = Array.from(new Set(
    values
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean),
  ));
  return result.length > 0 ? result : [...fallback];
}

function normalizeDurationList(values: unknown, fallback: number[]): number[] {
  if (!Array.isArray(values)) {
    return [...fallback];
  }
  const result = Array.from(new Set(
    values
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0 && value <= 600)
      .map((value) => Math.floor(value)),
  ));
  return result.length > 0 ? result : [...fallback];
}

function normalizeTextModels(
  models: unknown,
  fallback: ClientTextModelOption[],
): ClientTextModelOption[] {
  if (!Array.isArray(models)) {
    return [...fallback];
  }
  const seen = new Set<string>();
  const result = models
    .map((item): ClientTextModelOption | null => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Partial<ClientTextModelOption>;
      if (record.enabled === false) return null;
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      if (!id || seen.has(id)) return null;
      seen.add(id);
      const label = typeof record.label === 'string' && record.label.trim()
        ? record.label.trim()
        : id;
      return {
        id,
        label,
        description: typeof record.description === 'string' ? record.description.trim() : undefined,
        enabled: true,
      };
    })
    .filter((item): item is ClientTextModelOption => Boolean(item));
  return result.length > 0 ? result : [...fallback];
}

function normalizeImageModels(
  models: unknown,
  fallback: ClientImageModelOption[],
): ClientImageModelOption[] {
  if (!Array.isArray(models)) {
    return [...fallback];
  }
  const defaultFallback = fallback[0] ?? DEFAULT_CLIENT_MODEL_OPTIONS.image.models[0];
  const seen = new Set<string>();
  const result = models
    .map((item): ClientImageModelOption | null => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Partial<ClientImageModelOption>;
      if (record.enabled === false) return null;
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      if (!id || seen.has(id)) return null;
      seen.add(id);
      const sizes = normalizeStringList(record.sizes, defaultFallback.sizes);
      const qualities = normalizeStringList(record.qualities, defaultFallback.qualities);
      const defaultSize = typeof record.defaultSize === 'string' && sizes.includes(record.defaultSize.trim())
        ? record.defaultSize.trim()
        : (defaultFallback.defaultSize && sizes.includes(defaultFallback.defaultSize) ? defaultFallback.defaultSize : sizes[0]);
      const defaultQuality = typeof record.defaultQuality === 'string' && qualities.includes(record.defaultQuality.trim())
        ? record.defaultQuality.trim()
        : (defaultFallback.defaultQuality && qualities.includes(defaultFallback.defaultQuality) ? defaultFallback.defaultQuality : qualities[0]);
      return {
        id,
        label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : id,
        description: typeof record.description === 'string' ? record.description.trim() : undefined,
        sizes,
        qualities,
        defaultSize,
        defaultQuality,
        supportsEditing: record.supportsEditing === true,
        enabled: true,
      };
    })
    .filter((item): item is ClientImageModelOption => Boolean(item));
  return result.length > 0 ? result : [...fallback];
}

function normalizeVideoModels(
  models: unknown,
  fallback: ClientVideoModelOption[],
): ClientVideoModelOption[] {
  if (!Array.isArray(models)) {
    return [...fallback];
  }
  const defaultFallback = fallback[0];
  const seen = new Set<string>();
  const result = models
    .map((item): ClientVideoModelOption | null => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Partial<ClientVideoModelOption>;
      if (record.enabled === false) return null;
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      if (!id || seen.has(id)) return null;
      seen.add(id);
      const modes = normalizeStringList(record.modes, defaultFallback?.modes ?? []);
      const sizes = normalizeStringList(record.sizes, defaultFallback?.sizes ?? []);
      const durations = normalizeDurationList(record.durations, defaultFallback?.durations ?? []);
      const defaultSize = typeof record.defaultSize === 'string' && sizes.includes(record.defaultSize.trim())
        ? record.defaultSize.trim()
        : sizes[0];
      const rawDuration = Number(record.defaultDurationSeconds);
      const defaultDurationSeconds = Number.isFinite(rawDuration) && durations.includes(Math.floor(rawDuration))
        ? Math.floor(rawDuration)
        : durations[0];
      return {
        id,
        label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : id,
        description: typeof record.description === 'string' ? record.description.trim() : undefined,
        modes,
        sizes,
        durations,
        defaultSize,
        defaultDurationSeconds,
        requiresImage: record.requiresImage === true,
        enabled: true,
      };
    })
    .filter((item): item is ClientVideoModelOption => Boolean(item));
  return result.length > 0 ? result : [...fallback];
}

function normalizeModelOptions(payload?: Partial<ClientModelOptionsConfig>): ClientModelOptionsConfig {
  const defaults = cloneDefaultModelOptions();
  const textModels = normalizeTextModels(payload?.text?.models, defaults.text.models);
  const imageModels = normalizeImageModels(payload?.image?.models, defaults.image.models);
  const videoModels = normalizeVideoModels(payload?.video?.models, defaults.video.models);
  const textDefault = typeof payload?.text?.defaultModel === 'string'
    && textModels.some((model) => model.id === payload.text?.defaultModel)
    ? payload.text.defaultModel
    : (textModels[0]?.id ?? defaults.text.defaultModel);
  const imageDefault = typeof payload?.image?.defaultModel === 'string'
    && imageModels.some((model) => model.id === payload.image?.defaultModel)
    ? payload.image.defaultModel
    : (imageModels[0]?.id ?? defaults.image.defaultModel);
  const selectedImage = imageModels.find((model) => model.id === imageDefault) ?? imageModels[0];
  const videoDefault = typeof payload?.video?.defaultModel === 'string'
    && videoModels.some((model) => model.id === payload.video?.defaultModel)
    ? payload.video.defaultModel
    : (videoModels[0]?.id ?? defaults.video.defaultModel);
  const selectedVideo = videoModels.find((model) => model.id === videoDefault) ?? videoModels[0];

  return {
    text: {
      defaultModel: textDefault,
      models: textModels,
    },
    image: {
      defaultModel: imageDefault,
      defaultSize: selectedImage?.defaultSize ?? defaults.image.defaultSize,
      defaultQuality: selectedImage?.defaultQuality ?? defaults.image.defaultQuality,
      models: imageModels,
    },
    video: {
      defaultModel: videoDefault,
      defaultSize: selectedVideo?.defaultSize ?? defaults.video.defaultSize,
      defaultDurationSeconds: selectedVideo?.defaultDurationSeconds ?? defaults.video.defaultDurationSeconds,
      models: videoModels,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueAppend(current: string[], keys: string[]): string[] {
  return Array.from(new Set([...current, ...keys])).slice(-200);
}

function scheduleManagedTextModelSelfHeal(): void {
  void Promise.all([
    import('./agents').then(async ({ useAgentsStore }) => {
      useAgentsStore.getState().healManagedTextModels();
      await useAgentsStore.getState().fetchAgents({ force: true, quiet: true });
      useAgentsStore.getState().healManagedTextModels();
    }),
    import('./chat').then(async ({ useChatStore }) => {
      useChatStore.getState().healManagedTextModels();
      await useChatStore.getState().loadSessions();
      useChatStore.getState().healManagedTextModels();
    }),
  ]).catch((error) => {
    console.warn('[client-config] Failed to self-heal managed text models:', error);
  });
}

export const useClientConfigStore = create<ClientConfigState>()(
  persist(
    (set, get) => ({
      announcementsEnabled: false,
      announcements: [],
      support: null,
      modelOptions: cloneDefaultModelOptions(),
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
            modelOptions: normalizeModelOptions(payload.modelOptions),
            loading: false,
            error: null,
            initialized: true,
            toastKeys: unreadImportant
              ? uniqueAppend(current.toastKeys, [announcementKey(unreadImportant)])
              : current.toastKeys,
            urgentAnnouncement: unreadUrgent ?? retainedUrgent,
          });
          scheduleManagedTextModelSelfHeal();
        } catch (error) {
          set({
            loading: false,
            initialized: true,
            error: errorMessage(error),
            modelOptions: cloneDefaultModelOptions(),
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
