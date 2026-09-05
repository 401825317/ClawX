import type {
  ClientAnnouncement,
  ClientAnnouncementConfig,
  ClientAnnouncementLevel,
} from '../../shared/announcements';
import { isUclawManagedDistribution } from '../utils/junfeiai-distribution';
import { isRecord } from './payload-utils';
import { fetchPublicClientConfigPayload } from './public-client-config-service';

const MAX_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 512;
const MAX_CONTENT_LENGTH = 20_000;

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function visibleText(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  return text.replace(/jun\s*fei\s*ai|junfei(?:ai)?|君飞(?:\s*AI)?/gi, 'UClaw');
}

function safeHttpUrl(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizeLevel(value: unknown): ClientAnnouncementLevel {
  return value === 'important' || value === 'urgent' ? value : 'normal';
}

function normalizeAnnouncement(value: unknown, index: number): ClientAnnouncement | null {
  if (!isRecord(value) || value.enabled === false) return null;
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return null;
  const title = visibleText(value.title) ?? '';
  const content = visibleText(value.content) ?? '';
  const publishedAt = stringValue(value.publishedAt);
  if (
    !title
    || !content
    || !publishedAt
    || title.length > MAX_TITLE_LENGTH
    || content.length > MAX_CONTENT_LENGTH
    || Number.isNaN(Date.parse(publishedAt))
  ) {
    return null;
  }
  const id = stringValue(value.id).slice(0, MAX_ID_LENGTH) || `client-${index + 1}`;
  const rawExpiresAt = value.expiresAt;
  const expiresAt = stringValue(rawExpiresAt);
  if (
    rawExpiresAt !== undefined
    && rawExpiresAt !== null
    && (
      typeof rawExpiresAt !== 'string'
      || (expiresAt.length > 0 && Number.isNaN(Date.parse(expiresAt)))
    )
  ) {
    return null;
  }
  const link = safeHttpUrl(value.link);
  return {
    id,
    title,
    content,
    level: normalizeLevel(value.level),
    publishedAt,
    ...(expiresAt ? { expiresAt } : {}),
    ...(link ? { link } : {}),
  };
}

function announcementKey(item: ClientAnnouncement): string {
  return JSON.stringify([item.id, item.publishedAt, item.title, item.content, item.level]);
}

function isVisible(item: ClientAnnouncement, now = Date.now()): boolean {
  const publishedAt = Date.parse(item.publishedAt);
  if (publishedAt > now) return false;
  if (item.expiresAt && Date.parse(item.expiresAt) < now) return false;
  return true;
}

function announcementsFromPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.announcements)) return payload.announcements;
  if (isRecord(payload.client) && isRecord(payload.client.announcements)) {
    return payload.client.announcements;
  }
  return undefined;
}

/** Read the enabled, visible announcement feed for the managed UClaw client. */
export async function getClientAnnouncementConfig(): Promise<ClientAnnouncementConfig | null> {
  if (!isUclawManagedDistribution()) return null;
  const rawConfig = announcementsFromPayload(await fetchPublicClientConfigPayload());
  if (!isRecord(rawConfig)) return null;
  if (rawConfig.enabled !== undefined && typeof rawConfig.enabled !== 'boolean') return null;
  if (rawConfig.enabled === false) return null;

  const seen = new Set<string>();
  const items = (Array.isArray(rawConfig.items) ? rawConfig.items : [])
    .map(normalizeAnnouncement)
    .filter((item): item is ClientAnnouncement => Boolean(item))
    .filter((item) => isVisible(item))
    .filter((item) => {
      const key = announcementKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));

  return { enabled: true, items };
}
