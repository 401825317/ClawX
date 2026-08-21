import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Session, WebContents, WebPreferences } from 'electron';
import {
  WEB_BROWSER_INITIAL_URL,
  WEB_BROWSER_PARTITION,
  WEB_BROWSER_USER_AGENT,
  isAllowedWorkspaceHtmlPreviewNavigation,
  normalizeWebBrowserTopLevelUrl,
  normalizeWorkspaceHtmlPreviewUrl,
} from '../../shared/web-browser';
import { isActiveWorkspaceHtmlPreviewUrl } from '../services/workspace-html-preview';
import { logger } from '../utils/logger';

const DENY_WINDOW_OPEN = { action: 'deny' } as const;

export type WebBrowserNavigationFailureCode =
  | 'web_browser_url_not_allowed'
  | 'web_browser_file_requires_preview'
  | 'web_browser_private_network_blocked'
  | 'web_browser_dns_resolution_failed'
  | 'web_browser_preview_not_authorized';

export type WebBrowserNavigationDecision =
  | { ok: true; url: string; kind: 'public' | 'workspace-preview' }
  | { ok: false; code: WebBrowserNavigationFailureCode };

function normalizedHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.+$/gu, '');
}

function ipv4ToInteger(hostname: string): number | null {
  if (isIP(hostname) !== 4) return null;
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    return null;
  }
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function ipv4InCidr(address: number, base: string, prefixLength: number): boolean {
  const baseAddress = ipv4ToInteger(base);
  if (baseAddress === null) return false;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (address & mask) === (baseAddress & mask);
}

const PRIVATE_IPV4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const;

function isPrivateIpv4(hostname: string): boolean {
  const address = ipv4ToInteger(hostname);
  return address !== null
    && PRIVATE_IPV4_RANGES.some(([base, prefix]) => ipv4InCidr(address, base, prefix));
}

function ipv6ToInteger(hostname: string): bigint | null {
  if (isIP(hostname) !== 6 || hostname.includes('%')) return null;
  let normalized = hostname.toLowerCase();
  const ipv4Suffix = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (ipv4Suffix) {
    const ipv4 = ipv4ToInteger(ipv4Suffix);
    if (ipv4 === null) return null;
    normalized = `${normalized.slice(0, -ipv4Suffix.length)}${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 1 && halves.length === 2) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/u.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6InCidr(address: bigint, base: string, prefixLength: number): boolean {
  const baseAddress = ipv6ToInteger(base);
  if (baseAddress === null) return false;
  const shift = BigInt(128 - prefixLength);
  return (address >> shift) === (baseAddress >> shift);
}

const PRIVATE_IPV6_RANGES = [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const;

function isPrivateIpv6(hostname: string): boolean {
  const address = ipv6ToInteger(hostname);
  return address !== null
    && PRIVATE_IPV6_RANGES.some(([base, prefix]) => ipv6InCidr(address, base, prefix));
}

export function isWebBrowserPrivateNetworkHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  return !normalized
    || normalized === 'localhost'
    || normalized === 'localdomain'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.localdomain')
    || normalized.endsWith('.internal')
    || normalized.endsWith('.home.arpa')
    || isPrivateIpv4(normalized)
    || isPrivateIpv6(normalized);
}

export function classifyWebBrowserNavigation(input: string): WebBrowserNavigationDecision {
  const normalized = normalizeWebBrowserTopLevelUrl(input);
  if (!normalized) return { ok: false, code: 'web_browser_url_not_allowed' };
  const parsed = new URL(normalized);
  if (parsed.protocol === 'file:') {
    return { ok: false, code: 'web_browser_file_requires_preview' };
  }
  if (normalizeWorkspaceHtmlPreviewUrl(normalized)) {
    return { ok: true, url: normalized, kind: 'workspace-preview' };
  }
  if (isWebBrowserPrivateNetworkHostname(parsed.hostname)) {
    return { ok: false, code: 'web_browser_private_network_blocked' };
  }
  return { ok: true, url: normalized, kind: 'public' };
}

export interface WebBrowserDnsResolver {
  (hostname: string): Promise<readonly string[]>;
}

const WEB_BROWSER_DNS_TIMEOUT_MS = 2_000;

const defaultWebBrowserDnsResolver: WebBrowserDnsResolver = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map(entry => entry.address);
};

export async function resolveWebBrowserNavigation(
  input: string,
  resolveDns: WebBrowserDnsResolver = defaultWebBrowserDnsResolver,
): Promise<WebBrowserNavigationDecision> {
  const decision = classifyWebBrowserNavigation(input);
  if (!decision.ok || decision.kind === 'workspace-preview') return decision;
  const hostname = normalizedHostname(new URL(decision.url).hostname);
  if (isIP(hostname) !== 0) return decision;
  let timeout: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([
      resolveDns(hostname),
      new Promise<readonly string[]>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('DNS resolution timed out')), WEB_BROWSER_DNS_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
    if (addresses.length === 0) {
      return { ok: false, code: 'web_browser_dns_resolution_failed' };
    }
    if (addresses.some(address => isWebBrowserPrivateNetworkHostname(address))) {
      return { ok: false, code: 'web_browser_private_network_blocked' };
    }
    return decision;
  } catch {
    return { ok: false, code: 'web_browser_dns_resolution_failed' };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function blockedNavigationSummary(url: string): string {
  const decision = classifyWebBrowserNavigation(url);
  return decision.ok ? 'policy=locked-preview' : `policy=${decision.code}`;
}

function errorKind(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'unknown';
}

export class WebBrowserGuestRegistry {
  private guest: WebContents | null = null;
  private pendingAttachment = false;
  private lockedPreviewUrl: string | null = null;
  private navigationGeneration = 0;
  private pendingNavigation: {
    generation: number;
    url: string;
    previewUrl: string | null;
    previousPreviewUrl: string | null;
  } | null = null;

  beginAttachment(): boolean {
    this.dropDestroyedGuest();
    if (this.pendingAttachment || this.guest) {
      return false;
    }

    this.pendingAttachment = true;
    this.resetNavigationState();
    return true;
  }

  completeAttachment(guest: WebContents): void {
    if (!this.pendingAttachment || this.guest) {
      return;
    }

    this.pendingAttachment = false;
    this.guest = guest;
    this.resetNavigationState();
    guest.once('destroyed', () => {
      if (this.guest === guest) {
        this.guest = null;
        this.resetNavigationState();
      }
    });
  }

  cancelAttachment(): void {
    this.pendingAttachment = false;
  }

  current(): WebContents | null {
    this.dropDestroyedGuest();
    return this.guest;
  }

  owns(contents: WebContents | null): boolean {
    return contents !== null && this.current() === contents;
  }

  hasLiveGuest(): boolean {
    return this.current() !== null;
  }

  beginExplicitNavigation(contents: WebContents, url: string): {
    commit: () => void;
    rollback: () => void;
  } {
    if (!this.owns(contents)) {
      throw new Error('Web browser guest is unavailable');
    }
    const decision = classifyWebBrowserNavigation(url);
    if (!decision.ok) throw new Error(`Web browser navigation denied: ${decision.code}`);
    if (
      decision.kind === 'workspace-preview'
      && !isActiveWorkspaceHtmlPreviewUrl(decision.url)
    ) {
      throw new Error('Web browser navigation denied: web_browser_preview_not_authorized');
    }
    const previousPreviewUrl = this.lockedPreviewUrl;
    const previewUrl = decision.kind === 'workspace-preview' ? decision.url : null;
    const generation = ++this.navigationGeneration;
    this.pendingNavigation = { generation, url: decision.url, previewUrl, previousPreviewUrl };

    let settled = false;
    return {
      commit: () => {
        if (settled) return;
        settled = true;
        if (!this.owns(contents) || this.pendingNavigation?.generation !== generation) return;
        this.lockedPreviewUrl = previewUrl;
        this.pendingNavigation = null;
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        if (!this.owns(contents) || this.pendingNavigation?.generation !== generation) return;
        this.lockedPreviewUrl = previousPreviewUrl;
        this.pendingNavigation = null;
      },
    };
  }

  isPreviewGuest(contents: WebContents | null): boolean {
    return this.owns(contents)
      && (this.lockedPreviewUrl !== null || this.pendingNavigation?.previewUrl != null);
  }

  isActiveWorkspacePreviewUrl(url: string): boolean {
    return isActiveWorkspaceHtmlPreviewUrl(url);
  }

  allowsTopLevelNavigation(contents: WebContents, url: string): boolean {
    if (!this.owns(contents)) return false;
    const pending = this.pendingNavigation;
    if (
      pending?.previewUrl
      && isActiveWorkspaceHtmlPreviewUrl(pending.previewUrl)
      && isAllowedWorkspaceHtmlPreviewNavigation(pending.previewUrl, url)
    ) return true;
    if (
      this.lockedPreviewUrl !== null
      && isActiveWorkspaceHtmlPreviewUrl(this.lockedPreviewUrl)
      && isAllowedWorkspaceHtmlPreviewNavigation(this.lockedPreviewUrl, url)
    ) return true;
    const decision = classifyWebBrowserNavigation(url);
    if (!decision.ok) return false;
    if (decision.kind === 'workspace-preview') return false;
    if (pending) return decision.url === pending.url;
    return this.lockedPreviewUrl === null;
  }

  private dropDestroyedGuest(): void {
    if (this.guest?.isDestroyed()) {
      this.guest = null;
      this.resetNavigationState();
    }
  }

  private resetNavigationState(): void {
    this.navigationGeneration += 1;
    this.lockedPreviewUrl = null;
    this.pendingNavigation = null;
  }
}

export function isExpectedWebBrowserAttachment(
  params: Record<string, unknown>,
): boolean {
  return params.partition === WEB_BROWSER_PARTITION
    && params.src === WEB_BROWSER_INITIAL_URL
    && params.useragent === WEB_BROWSER_USER_AGENT
    && params.allowpopups === true
    && params.preload === '';
}

export function hardenWebBrowserPreferences(preferences: WebPreferences): void {
  delete preferences.preload;
  preferences.nodeIntegration = false;
  preferences.nodeIntegrationInSubFrames = false;
  preferences.nodeIntegrationInWorker = false;
  preferences.plugins = false;
  preferences.allowRunningInsecureContent = false;
  preferences.contextIsolation = true;
  preferences.sandbox = true;
  preferences.webSecurity = true;
}

export function installWebBrowserGuestPolicy(
  embedder: WebContents,
  options: {
    browserSession: Session;
    registry: WebBrowserGuestRegistry;
  },
): () => void {
  const { browserSession, registry } = options;
  let attachmentPending = false;
  let cleanupGuestPolicy: (() => void) | null = null;

  const handleWillAttach = (
    event: Electron.Event,
    preferences: WebPreferences,
    params: Record<string, unknown>,
  ): void => {
    if (!isExpectedWebBrowserAttachment(params)) {
      logger.warn('[WebBrowser] Rejected webview attachment with unexpected identity');
      event.preventDefault();
      return;
    }

    if (!registry.beginAttachment()) {
      logger.warn('[WebBrowser] Rejected additional webview attachment');
      event.preventDefault();
      return;
    }

    attachmentPending = true;
    hardenWebBrowserPreferences(preferences);
  };

  const handleDidAttach = (_event: Electron.Event, guest: WebContents): void => {
    if (!attachmentPending) {
      logger.warn('[WebBrowser] Ignored attached guest without a reserved slot');
      return;
    }
    attachmentPending = false;

    if (guest.getType() !== 'webview' || guest.session !== browserSession) {
      logger.warn('[WebBrowser] Rejected attached guest with unexpected type or session');
      registry.cancelAttachment();
      return;
    }

    registry.completeAttachment(guest);
    if (!registry.owns(guest)) {
      logger.warn('[WebBrowser] Failed to register reserved guest');
      return;
    }

    guest.setUserAgent(WEB_BROWSER_USER_AGENT);

    const rejectDisallowedNavigation = (
      details: Electron.Event<Electron.WebContentsWillNavigateEventParams>,
    ): void => {
      if (!details.isMainFrame || registry.allowsTopLevelNavigation(guest, details.url)) {
        return;
      }

      logger.warn(`[WebBrowser] Blocked top-level navigation (${blockedNavigationSummary(details.url)})`);
      details.preventDefault();
    };

    const rejectDisallowedRedirect = (
      details: Electron.Event<Electron.WebContentsWillRedirectEventParams>,
    ): void => {
      if (!details.isMainFrame || registry.allowsTopLevelNavigation(guest, details.url)) {
        return;
      }

      logger.warn(`[WebBrowser] Blocked top-level redirect (${blockedNavigationSummary(details.url)})`);
      details.preventDefault();
    };

    // Same-tab fallback cannot preserve window.opener, returned window handles, or full POST/referrer fidelity.
    guest.setWindowOpenHandler(({ url }) => {
      const target = normalizeWebBrowserTopLevelUrl(url);
      if (!target || !registry.allowsTopLevelNavigation(guest, target)) {
        logger.warn(`[WebBrowser] Blocked popup target (${blockedNavigationSummary(url)})`);
        return DENY_WINDOW_OPEN;
      }

      try {
        void guest.loadURL(target).catch((error) => {
          logger.warn(`[WebBrowser] Failed to load approved popup target (error=${errorKind(error)})`);
        });
      } catch (error) {
        logger.warn(`[WebBrowser] Failed to load approved popup target (error=${errorKind(error)})`);
      }

      return DENY_WINDOW_OPEN;
    });

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) {
        return;
      }
      cleaned = true;

      guest.off('will-navigate', rejectDisallowedNavigation);
      guest.off('will-redirect', rejectDisallowedRedirect);
      guest.off('destroyed', cleanup);
      if (!guest.isDestroyed()) {
        guest.setWindowOpenHandler(() => DENY_WINDOW_OPEN);
      }
      if (cleanupGuestPolicy === cleanup) {
        cleanupGuestPolicy = null;
      }
    };

    guest.on('will-navigate', rejectDisallowedNavigation);
    guest.on('will-redirect', rejectDisallowedRedirect);
    guest.once('destroyed', cleanup);
    cleanupGuestPolicy = cleanup;
  };

  embedder.on('will-attach-webview', handleWillAttach);
  embedder.on('did-attach-webview', handleDidAttach);

  return () => {
    embedder.off('will-attach-webview', handleWillAttach);
    embedder.off('did-attach-webview', handleDidAttach);
    attachmentPending = false;
    registry.cancelAttachment();
    cleanupGuestPolicy?.();
  };
}
