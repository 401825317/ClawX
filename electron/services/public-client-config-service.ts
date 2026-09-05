import {
  UCLAW_SUPPORT_REQUEST_TIMEOUT_MS,
  UCLAW_SUPPORT_ROUTES,
} from '../../shared/junfeiai-endpoints';
import { getUclawBackendOrigin } from '../utils/junfeiai-distribution';
import { proxyAwareFetch } from '../utils/proxy-fetch';
import { isRecord } from './payload-utils';

type FetchJsonResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
};

export class ClientConfigHttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ClientConfigHttpError';
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function payloadMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  return stringValue(payload.message)
    || stringValue(payload.msg)
    || (typeof payload.error === 'string' ? stringValue(payload.error) : '')
    || fallback;
}

function unwrapPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  if (payload.success === false) {
    throw new ClientConfigHttpError(payloadMessage(payload, 'UClaw client-config request failed'), 400);
  }
  if (typeof payload.code === 'number' && payload.code !== 0) {
    throw new ClientConfigHttpError(payloadMessage(payload, 'UClaw client-config request failed'), 400);
  }
  if (!Object.hasOwn(payload, 'data')) return payload;
  return payload.data;
}

/** Request one public UClaw client-config document without attaching credentials. */
async function requestPublicJson(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UCLAW_SUPPORT_REQUEST_TIMEOUT_MS);
  try {
    const response = await proxyAwareFetch(`${getUclawBackendOrigin()}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      signal: controller.signal,
    }) as unknown as FetchJsonResponse;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (!response.ok) {
        throw new ClientConfigHttpError(
          `${response.status} ${response.statusText}`,
          response.status,
        );
      }
      throw new Error('UClaw client-config returned invalid JSON', { cause: error });
    }
    if (!response.ok) {
      throw new ClientConfigHttpError(
        payloadMessage(payload, `${response.status} ${response.statusText}`),
        response.status,
      );
    }
    return unwrapPayload(payload);
  } catch (error) {
    if (error instanceof ClientConfigHttpError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('UClaw client-config request timed out', { cause: error });
    }
    throw new Error('Unable to reach UClaw client-config', { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** Read the current public client-config, falling back only for a missing route. */
export async function fetchPublicClientConfigPayload(): Promise<unknown> {
  try {
    return await requestPublicJson(UCLAW_SUPPORT_ROUTES.clientConfig);
  } catch (error) {
    if (!(error instanceof ClientConfigHttpError) || error.status !== 404) throw error;
    return requestPublicJson(UCLAW_SUPPORT_ROUTES.bootstrap);
  }
}
