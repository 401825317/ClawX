import type { SupportContact, SupportContactConfig } from '../../shared/support';
import {
  UCLAW_SUPPORT_REQUEST_TIMEOUT_MS,
  UCLAW_SUPPORT_ROUTES,
} from '../../shared/junfeiai-endpoints';
import {
  getUclawBackendOrigin,
  isUclawManagedDistribution,
} from '../utils/junfeiai-distribution';
import { proxyAwareFetch } from '../utils/proxy-fetch';
import { isRecord } from './payload-utils';

type FetchJsonResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
};

class SupportHttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'SupportHttpError';
  }
}

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

function payloadMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  return visibleText(payload.message)
    ?? visibleText(payload.msg)
    ?? (typeof payload.error === 'string' ? visibleText(payload.error) : undefined)
    ?? fallback;
}

function unwrapPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  if (payload.success === false) {
    throw new SupportHttpError(payloadMessage(payload, 'UClaw support request failed'), 400);
  }
  if (!Object.hasOwn(payload, 'data')) return payload;
  if (typeof payload.code === 'number' && payload.code !== 0) {
    throw new SupportHttpError(payloadMessage(payload, 'UClaw support request failed'), 400);
  }
  return payload.data;
}

/** Request one public UClaw JSON document without attaching user credentials. */
async function requestPublicJson(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UCLAW_SUPPORT_REQUEST_TIMEOUT_MS);
  try {
    const response = await proxyAwareFetch(`${getUclawBackendOrigin()}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    }) as unknown as FetchJsonResponse;
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new SupportHttpError(
        payloadMessage(payload, `${response.status} ${response.statusText}`),
        response.status,
      );
    }
    return unwrapPayload(payload);
  } catch (error) {
    if (error instanceof SupportHttpError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('UClaw support request timed out', { cause: error });
    }
    throw new Error('Unable to reach UClaw support', { cause: error });
  } finally {
    clearTimeout(timer);
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
  return isRecord(payload) ? payload.support : undefined;
}

function supportFromBootstrapPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return undefined;
  return isRecord(payload.client) ? payload.client.support : undefined;
}

/** Read and normalize the current Help & Support configuration. */
export async function getSupportContactConfig(): Promise<SupportContactConfig | null> {
  if (!isUclawManagedDistribution()) return null;

  try {
    const payload = await requestPublicJson(UCLAW_SUPPORT_ROUTES.clientConfig);
    return normalizeSupport(supportFromClientPayload(payload));
  } catch (error) {
    if (!(error instanceof SupportHttpError) || error.status !== 404) throw error;
    const bootstrap = await requestPublicJson(UCLAW_SUPPORT_ROUTES.bootstrap);
    return normalizeSupport(supportFromBootstrapPayload(bootstrap));
  }
}
