import { shell, type Session, type WebContents } from 'electron';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import {
  classifyWebBrowserNavigation,
  resolveWebBrowserNavigation,
  type WebBrowserGuestRegistry,
  type WebBrowserNavigationDecision,
  type WebBrowserNavigationFailureCode,
} from '../main/web-browser-policy';

export interface WebBrowserApiDependencies {
  browserSession: Session;
  registry: WebBrowserGuestRegistry;
  openExternal?: (url: string) => Promise<void>;
  navigationTimeoutMs?: number;
  resolveNavigation?: (url: string) => Promise<WebBrowserNavigationDecision>;
}

export type WebBrowserRecoverableErrorCode = WebBrowserNavigationFailureCode
  | 'web_browser_target_stale'
  | 'web_browser_navigation_aborted'
  | 'web_browser_navigation_timeout'
  | 'web_browser_dns_resolution_failed'
  | 'web_browser_preview_not_authorized';

export const DEFAULT_WEB_BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;

export class WebBrowserRecoverableError extends Error {
  readonly recoverable = true;
  readonly restartGateway = false;

  constructor(
    readonly code: WebBrowserRecoverableErrorCode,
    message: string,
    readonly recovery: string,
  ) {
    super(message);
    this.name = 'WebBrowserRecoverableError';
  }
}

function recoverableError(
  code: WebBrowserRecoverableErrorCode,
  message: string,
  recovery: string,
): WebBrowserRecoverableError {
  return new WebBrowserRecoverableError(code, message, recovery);
}

function requireLiveGuest(registry: WebBrowserGuestRegistry): WebContents {
  const guest = registry.current();
  if (!guest) {
    throw recoverableError(
      'web_browser_target_stale',
      'The browser tab is no longer available',
      'Reopen the built-in browser tab and retry the action once.',
    );
  }
  return guest;
}

function recoverableNavigationDecisionError(
  decision: Extract<WebBrowserNavigationDecision, { ok: false }>,
): WebBrowserRecoverableError {
  if (decision.code === 'web_browser_file_requires_preview') {
    return recoverableError(
      decision.code,
      'Local file navigation requires the protected workspace preview',
      'Open the HTML artifact through its tokenized workspace preview URL.',
    );
  }
  if (decision.code === 'web_browser_private_network_blocked') {
    return recoverableError(
      decision.code,
      'Private-network browser navigation is blocked',
      'Use a public URL or the exact tokenized workspace preview URL.',
    );
  }
  if (decision.code === 'web_browser_dns_resolution_failed') {
    return recoverableError(
      decision.code,
      'The browser could not verify the destination network',
      'Check the address and network connection, then retry without restarting Gateway.',
    );
  }
  return recoverableError(
    decision.code,
    'The browser URL is not allowed',
    'Use an HTTP or HTTPS URL supported by the built-in browser.',
  );
}

function requireAllowedUrl(
  url: string,
  registry: WebBrowserGuestRegistry,
  allowWorkspacePreview: boolean,
): string {
  const decision = classifyWebBrowserNavigation(url);
  if (!decision.ok) throw recoverableNavigationDecisionError(decision);
  if (decision.kind === 'workspace-preview') {
    if (!allowWorkspacePreview || !registry.isActiveWorkspacePreviewUrl(decision.url)) {
      throw recoverableError(
        'web_browser_preview_not_authorized',
        'The workspace preview is no longer active',
        'Regenerate the HTML preview and retry the action.',
      );
    }
  }
  return decision.url;
}

function isAbortedLoad(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const loadError = error as { code?: unknown; errno?: unknown; name?: unknown; message?: unknown };
  const message = typeof loadError.message === 'string' ? loadError.message.toLowerCase() : '';
  return (loadError.code === 'ERR_ABORTED' && (loadError.errno === -3 || loadError.errno === undefined))
    || loadError.name === 'AbortError'
    || /\b(?:aborted|cancelled|canceled)\b/u.test(message);
}

function isTimedOutLoad(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const loadError = error as { code?: unknown; name?: unknown; message?: unknown };
  const message = typeof loadError.message === 'string' ? loadError.message.toLowerCase() : '';
  return loadError.code === 'ERR_TIMED_OUT'
    || loadError.name === 'TimeoutError'
    || /\b(?:timed?\s*out|timeout|deadline exceeded)\b/u.test(message);
}

function isStaleTargetLoad(error: unknown, guest: WebContents): boolean {
  if (guest.isDestroyed()) return true;
  if (typeof error !== 'object' || error === null) return false;
  const loadError = error as { code?: unknown; message?: unknown };
  const message = typeof loadError.message === 'string' ? loadError.message.toLowerCase() : '';
  return loadError.code === 'ERR_FAILED' && /\b(?:destroyed|closed|target|tab)\b/u.test(message)
    || /(?:target|tab|session)(?:id)?[^\n]{0,80}\b(?:mismatch|closed|destroyed|not found|unavailable)\b/u.test(message);
}

function classifyLoadError(error: unknown, guest: WebContents): WebBrowserRecoverableError | null {
  if (isStaleTargetLoad(error, guest)) {
    return recoverableError(
      'web_browser_target_stale',
      'The browser target changed or was closed',
      'Refresh the tab list or reopen the built-in browser, then retry once.',
    );
  }
  if (isTimedOutLoad(error)) {
    return recoverableError(
      'web_browser_navigation_timeout',
      'Browser navigation timed out',
      'Retry the navigation once or continue without restarting Gateway.',
    );
  }
  if (isAbortedLoad(error)) {
    return recoverableError(
      'web_browser_navigation_aborted',
      'Browser navigation was cancelled',
      'Retry only if the destination is still needed; Gateway restart is not required.',
    );
  }
  return null;
}

function loadUrlWithDeadline(
  guest: WebContents,
  url: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Math.max(1, Math.floor(timeoutMs));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };

    let loadPromise: Promise<void>;
    try {
      loadPromise = Promise.resolve(guest.loadURL(url));
    } catch (error) {
      settle(() => reject(error));
      return;
    }

    // Always attach both handlers. A timed-out Electron load may reject later;
    // consuming that late rejection keeps it from becoming an unhandled error.
    loadPromise.then(
      () => settle(() => resolve()),
      error => settle(() => reject(error)),
    );
    timer = setTimeout(() => {
      try {
        (guest as WebContents & { stop?: () => void }).stop?.();
      } catch {
        // The timeout result remains authoritative even if Electron rejects stop().
      }
      settle(() => reject(recoverableError(
        'web_browser_navigation_timeout',
        'Browser navigation timed out',
        'Retry the navigation once or continue without restarting Gateway.',
      )));
    }, deadline);
  });
}

export function createWebBrowserApi(
  dependencies: WebBrowserApiDependencies,
): CompleteHostServiceRegistry['webBrowser'] {
  const { browserSession, registry } = dependencies;
  const openExternal = dependencies.openExternal ?? ((url: string) => shell.openExternal(url));
  const navigationTimeoutMs = dependencies.navigationTimeoutMs ?? DEFAULT_WEB_BROWSER_NAVIGATION_TIMEOUT_MS;
  const resolveNavigation = dependencies.resolveNavigation ?? resolveWebBrowserNavigation;

  return {
    async navigate({ url }) {
      const guest = requireLiveGuest(registry);
      const allowedUrl = requireAllowedUrl(url, registry, true);
      const decision = await resolveNavigation(allowedUrl);
      if (!decision.ok) throw recoverableNavigationDecisionError(decision);
      let navigation: ReturnType<WebBrowserGuestRegistry['beginExplicitNavigation']>;
      try {
        navigation = registry.beginExplicitNavigation(guest, allowedUrl);
      } catch (error) {
        const navigationDecision = classifyWebBrowserNavigation(allowedUrl);
        if (navigationDecision.ok
          && navigationDecision.kind === 'workspace-preview'
          && !registry.isActiveWorkspacePreviewUrl(allowedUrl)) {
          throw recoverableError(
            'web_browser_preview_not_authorized',
            'The workspace preview is no longer active',
            'Regenerate the HTML preview and retry the action.',
          );
        }
        throw error;
      }
      try {
        await loadUrlWithDeadline(guest, allowedUrl, navigationTimeoutMs);
        navigation.commit();
      } catch (error) {
        navigation.rollback();
        throw classifyLoadError(error, guest) ?? error;
      }
    },

    async clearCookies() {
      await browserSession.clearStorageData({ storages: ['cookies'] });
    },

    async clearSiteData() {
      await Promise.all([
        browserSession.clearCache(),
        browserSession.clearStorageData({
          storages: ['cachestorage', 'localstorage', 'indexdb', 'serviceworkers'],
        }),
      ]);
    },

    async openExternal() {
      const guest = requireLiveGuest(registry);
      const allowedUrl = requireAllowedUrl(guest.getURL(), registry, false);
      const decision = await resolveNavigation(allowedUrl);
      if (!decision.ok) throw recoverableNavigationDecisionError(decision);
      await openExternal(decision.url);
    },
  };
}
