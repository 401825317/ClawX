import type { SupportContact, SupportContactConfig } from '../../shared/support';
import {
  isUclawManagedDistribution,
} from '../utils/junfeiai-distribution';
import { isRecord } from './payload-utils';
import { fetchPublicClientConfigPayload } from './public-client-config-service';

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

function normalizeContact(value: unknown, index: number): SupportContact | null {
  if (!isRecord(value) || value.enabled === false) return null;
  const qrCodeUrl = safeHttpUrl(value.qrCodeUrl);
  if (!qrCodeUrl) return null;
  return {
    id: stringValue(value.id) || `support-${index + 1}`,
    label: visibleText(value.label),
    description: visibleText(value.description),
    qrCodeUrl,
    workHours: visibleText(value.workHours),
    wechatId: stringValue(value.wechatId) || undefined,
    extraNote: visibleText(value.extraNote),
  };
}

function normalizeSupport(value: unknown): SupportContactConfig | null {
  if (!isRecord(value) || value.enabled !== true) return null;
  const contacts = Array.isArray(value.contacts)
    ? value.contacts
      .map(normalizeContact)
      .filter((contact): contact is SupportContact => contact !== null)
    : [];

  // Preserve compatibility with the original single-contact configuration.
  if (contacts.length === 0 && safeHttpUrl(value.qrCodeUrl)) {
    const legacyContact = normalizeContact({
      id: 'support-default',
      label: value.title,
      description: value.description,
      qrCodeUrl: value.qrCodeUrl,
      workHours: value.workHours,
      wechatId: value.wechatId,
      extraNote: value.extraNote,
      enabled: true,
    }, 0);
    if (legacyContact) contacts.push(legacyContact);
  }

  if (contacts.length === 0) return null;
  return {
    enabled: true,
    title: visibleText(value.title),
    description: visibleText(value.description),
    contacts,
  };
}

function supportFromClientPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return undefined;
  if (Object.hasOwn(payload, 'support')) return payload.support;
  return isRecord(payload.client) ? payload.client.support : undefined;
}

/** Read and normalize the current Help & Support configuration. */
export async function getSupportContactConfig(): Promise<SupportContactConfig | null> {
  if (!isUclawManagedDistribution()) return null;
  return normalizeSupport(supportFromClientPayload(await fetchPublicClientConfigPayload()));
}
