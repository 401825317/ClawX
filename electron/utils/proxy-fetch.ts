/**
 * Use Electron's network stack when available so requests honor
 * session.defaultSession.setProxy(...). Fall back to the Node global fetch
 * for non-Electron test environments.
 */

// The Electron main-process tsconfig intentionally omits the DOM library.
// Complete the fetch response surface used by Node/Electron network calls.
declare global {
  interface Response {
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly body: unknown;
    json: () => Promise<any>;
    text: () => Promise<string>;
  }
}

export async function proxyAwareFetch(
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
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
