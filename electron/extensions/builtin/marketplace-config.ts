/**
 * Public skill marketplace transport limits.
 * This configuration is intentionally independent from managed-account auth.
 */
export const SKILL_MARKETPLACE_CONFIG = Object.freeze({
  skillHubApiOrigin: 'https://api.skillhub.cn',
  skillHubWebOrigin: 'https://skillhub.cn',
  clawHubConvexOrigin: 'https://wry-manatee-359.convex.cloud',
  requestTimeoutMs: 15_000,
  downloadTimeoutMs: 90_000,
  maxJsonBytes: 4 * 1024 * 1024,
  maxDownloadBytes: 32 * 1024 * 1024,
  maxArchiveFiles: 512,
  maxArchiveEntryBytes: 16 * 1024 * 1024,
  maxArchiveUncompressedBytes: 64 * 1024 * 1024,
});

export function validateMarketplaceOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }

  const isLoopback = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error(`${label} must use HTTPS`);
  }
  return url.origin;
}

export function marketplaceUrl(origin: string, pathname: string, search?: URLSearchParams): string {
  const url = new URL(pathname, `${origin.replace(/\/+$/, '')}/`);
  if (search) url.search = search.toString();
  return url.toString();
}
