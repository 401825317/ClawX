import {
  dialog,
  session,
  type BrowserWindow,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type Session,
} from 'electron';
import { WEB_BROWSER_PERMISSION_LABELS } from '@shared/i18n/resources';
import { resolveSupportedLanguage } from '@shared/language';
import {
  WEB_BROWSER_PARTITION,
  WEB_BROWSER_USER_AGENT,
} from '@shared/web-browser';
import { logger } from '../utils/logger';
import { getSetting } from '../utils/store';
import {
  classifyWebBrowserNavigation,
  resolveWebBrowserNavigation,
  type WebBrowserNavigationDecision,
  type WebBrowserGuestRegistry,
} from './web-browser-policy';

const CLIPBOARD_PERMISSIONS = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'deprecated-sync-clipboard-read',
]);
const DOWNLOAD_OBSERVED_SESSIONS = new WeakSet<Session>();
const NETWORK_FILTERED_SESSIONS = new WeakSet<Session>();
const NETWORK_DECISION_CACHE_TTL_MS = 5_000;
const MAX_NETWORK_DECISION_CACHE_ENTRIES = 128;

export interface ConfigureWebBrowserSessionOptions {
  registry: WebBrowserGuestRegistry;
  getMainWindow: () => BrowserWindow | null;
  getLanguage?: () => Promise<string | undefined>;
  showMessageBox?: (
    window: BrowserWindow,
    options: MessageBoxOptions,
  ) => Promise<MessageBoxReturnValue>;
  resolveNavigation?: (url: string) => Promise<WebBrowserNavigationDecision>;
}

export function configureWebBrowserSession(
  options: ConfigureWebBrowserSessionOptions,
): Session {
  const browserSession = session.fromPartition(WEB_BROWSER_PARTITION, { cache: true });
  const getLanguage = options.getLanguage ?? (() => getSetting('language'));
  // Resolve the method at request time so Electron E2E tests can replace the native dialog after startup.
  const showMessageBox = options.showMessageBox
    ?? ((window, messageOptions) => dialog.showMessageBox(window, messageOptions));
  const resolveNavigation = options.resolveNavigation ?? resolveWebBrowserNavigation;

  // The macOS UA is fixed on every platform for stable website compatibility and deterministic requests.
  browserSession.setUserAgent(WEB_BROWSER_USER_AGENT);

  browserSession.setPermissionCheckHandler((contents, permission) => (
    options.registry.owns(contents)
    && !options.registry.isPreviewGuest(contents)
    && CLIPBOARD_PERMISSIONS.has(permission)
  ));

  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    let callbackCalled = false;
    const respond = (allowed: boolean): void => {
      if (callbackCalled) return;
      callbackCalled = true;
      callback(allowed);
    };

    if (options.registry.isPreviewGuest(contents)) {
      respond(false);
      return;
    }

    if (CLIPBOARD_PERMISSIONS.has(permission) && options.registry.owns(contents)) {
      respond(true);
      return;
    }

    if (permission === 'geolocation') {
      // ClawX has no location service, so websites cannot receive a meaningful location.
      respond(false);
      return;
    }

    if (permission !== 'media' || !options.registry.owns(contents)) {
      respond(false);
      return;
    }

    const mediaDetails = details as Electron.MediaAccessPermissionRequest;
    const mediaTypes = new Set(mediaDetails.mediaTypes ?? []);
    const requestsCamera = mediaTypes.has('video');
    const requestsMicrophone = mediaTypes.has('audio');
    if (!requestsCamera && !requestsMicrophone) {
      respond(false);
      return;
    }

    const mainWindow = options.getMainWindow();
    if (!mainWindow) {
      respond(false);
      return;
    }

    void (async () => {
      try {
        const language = resolveSupportedLanguage(await getLanguage());
        const labels = WEB_BROWSER_PERMISSION_LABELS[language];
        const capability = requestsCamera && requestsMicrophone
          ? labels.cameraAndMicrophone
          : requestsCamera
            ? labels.camera
            : labels.microphone;
        const origin = mediaDetails.securityOrigin || mediaDetails.requestingUrl;

        if (!options.registry.owns(contents)) {
          respond(false);
          return;
        }

        const result = await showMessageBox(mainWindow, {
          type: 'question',
          title: labels.title,
          message: labels.message
            .replace('{{origin}}', origin)
            .replace('{{capability}}', capability),
          buttons: [labels.allow, labels.deny],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        respond(result.response === 0 && options.registry.owns(contents));
      } catch (error) {
        logger.warn('[WebBrowser] Native media permission dialog failed:', error);
        respond(false);
      }
    })();
  });

  if (!DOWNLOAD_OBSERVED_SESSIONS.has(browserSession)) {
    DOWNLOAD_OBSERVED_SESSIONS.add(browserSession);
    // Preserve Electron's default save location and UI by observing without cancelling or setting a path.
    browserSession.on('will-download', (event, item, contents) => {
      if (options.registry.isPreviewGuest(contents)) {
        event.preventDefault();
        return;
      }
      item.once('done', (_doneEvent, state) => {
        if (state === 'interrupted') {
          logger.warn('[WebBrowser] Download interrupted');
        }
      });
    });
  }

  if (!NETWORK_FILTERED_SESSIONS.has(browserSession)) {
    NETWORK_FILTERED_SESSIONS.add(browserSession);
    const networkDecisionCache = new Map<string, {
      expiresAt: number;
      result: Promise<boolean>;
    }>();
    const isPublicNetworkTarget = (url: string): Promise<boolean> => {
      const hostname = new URL(url).hostname.toLowerCase();
      const now = Date.now();
      const cached = networkDecisionCache.get(hostname);
      if (cached && cached.expiresAt > now) return cached.result;
      if (cached) networkDecisionCache.delete(hostname);
      const result = resolveNavigation(url)
        .then(decision => decision.ok && decision.kind === 'public', () => false);
      networkDecisionCache.set(hostname, {
        expiresAt: now + NETWORK_DECISION_CACHE_TTL_MS,
        result,
      });
      while (networkDecisionCache.size > MAX_NETWORK_DECISION_CACHE_ENTRIES) {
        const oldest = networkDecisionCache.keys().next().value as string | undefined;
        if (!oldest) break;
        networkDecisionCache.delete(oldest);
      }
      return result;
    };
    browserSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(details.url);
      } catch {
        callback({ cancel: true });
        return;
      }
      const protocol = parsedUrl.protocol;
      if (protocol !== 'file:' && protocol !== 'http:' && protocol !== 'https:') {
        callback({ cancel: false });
        return;
      }

      const guest = options.registry.current();
      const belongsToLockedPreview = Boolean(
        guest
        && guest.id === details.webContentsId
        && options.registry.isPreviewGuest(guest)
        && options.registry.allowsTopLevelNavigation(guest, details.url),
      );
      // A same-document fragment navigation stays inside the already locked preview URL.
      // It must be accepted before generic localhost/private-network classification.
      if (belongsToLockedPreview) {
        callback({ cancel: false });
        return;
      }

      const decision = classifyWebBrowserNavigation(details.url);
      if (decision.ok && decision.kind === 'public') {
        void isPublicNetworkTarget(decision.url).then(
          allowed => callback({ cancel: !allowed }),
          () => callback({ cancel: true }),
        );
        return;
      }
      if (decision.ok && decision.kind === 'workspace-preview') {
        const belongsToPreviewGuest = Boolean(
          guest
          && guest.id === details.webContentsId
          && options.registry.isPreviewGuest(guest)
          && options.registry.allowsTopLevelNavigation(guest, decision.url),
        );
        callback({ cancel: !belongsToPreviewGuest });
        return;
      }
      callback({ cancel: true });
    });
  }

  // This isolated browser Session intentionally does not mirror client proxy settings or recycle connections.
  return browserSession;
}
