/**
 * Use Electron's network stack when available so requests honor
 * session.defaultSession.setProxy(...). Fall back to the Node global fetch
 * for non-Electron test environments.
 */

import { getUclawBackendOrigin } from './junfeiai-distribution';
import { getUclawDiagnosticHeaders } from './uclaw-request-diagnostics';

// The Electron main-process tsconfig intentionally omits the DOM library.
// Complete the fetch response surface used by Node/Electron network calls.
declare global {
  interface Response {
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly body: unknown;
    readonly headers: Headers;
    json: () => Promise<any>;
    text: () => Promise<string>;
  }
}

const MAX_MANAGED_REDIRECTS = 5;

function isExactUclawOrigin(input: string | URL): boolean {
  try {
    return new URL(input instanceof URL ? input.toString() : input).origin
      === new URL(getUclawBackendOrigin()).origin;
  } catch {
    return false;
  }
}

async function withUclawDiagnostics(
  input: string | URL,
  init?: RequestInit,
): Promise<RequestInit | undefined> {
  if (!isExactUclawOrigin(input)) return init;

  const headers = new Headers(init?.headers);
  const diagnostics = await getUclawDiagnosticHeaders();
  for (const [key, value] of Object.entries(diagnostics)) {
    headers.set(key, value);
  }
  return { ...init, headers };
}

async function performFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  if (process.versions.electron) {
    try {
      const { net } = await import('electron');
      return await net.fetch(input instanceof URL ? input.toString() : input, init);
    } catch {
      // Fall through to the global fetch.
    }
  }
  return await fetch(input, init);
}

function redirectedRequestInit(init: RequestInit, status: number): RequestInit {
  const method = (init.method ?? 'GET').toUpperCase();
  if (status !== 303 && !((status === 301 || status === 302) && method === 'POST')) {
    return init;
  }
  const headers = new Headers(init.headers);
  headers.delete('content-length');
  headers.delete('content-type');
  return { ...init, method: 'GET', body: undefined, headers };
}

export async function proxyAwareFetch(
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
  if (!isExactUclawOrigin(input)) {
    return await performFetch(input, init);
  }

  const managedOrigin = new URL(getUclawBackendOrigin()).origin;
  let currentUrl = input instanceof URL ? input : new URL(input);
  let currentInit: RequestInit = {
    ...(await withUclawDiagnostics(currentUrl, init)),
    redirect: 'manual' as const,
  };

  for (let redirects = 0; ; redirects += 1) {
    const response = await performFetch(currentUrl, currentInit);
    if (response.status < 300 || response.status >= 400 || redirects >= MAX_MANAGED_REDIRECTS) {
      return response;
    }
    const location = response.headers.get('location');
    if (!location) return response;
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      return response;
    }
    if (nextUrl.origin !== managedOrigin) {
      return response;
    }
    currentUrl = nextUrl;
    currentInit = redirectedRequestInit(currentInit, response.status);
  }
}
