import { UCLAW_MARKETPLACE_CONFIG } from '../../../shared/junfeiai-endpoints';

/** Public marketplace settings are centralized without depending on managed-account state. */
export const SKILL_MARKETPLACE_CONFIG = Object.freeze({ ...UCLAW_MARKETPLACE_CONFIG });

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
