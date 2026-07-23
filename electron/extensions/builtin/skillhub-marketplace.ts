import JSZip from 'jszip';
import * as fsp from 'node:fs/promises';
import { basename, dirname, join, normalize, relative, resolve } from 'node:path';
import { fetch as requestFetch } from 'undici';
import type {
  Extension,
  ExtensionContext,
  MarketplaceCapability,
  MarketplaceProviderExtension,
} from '../types';
import type {
  MarketplaceInstallParams,
  MarketplaceSearchParams,
  MarketplaceSearchResult,
  MarketplaceSkillResult,
} from '../../gateway/clawhub';
import { logger } from '../../utils/logger';
import { getOpenClawConfigDir } from '../../utils/paths';
import { resolveSupportedLanguage, type LanguageCode } from '../../../shared/language';
import {
  marketplaceUrl,
  SKILL_MARKETPLACE_CONFIG,
  validateMarketplaceOrigin,
} from './marketplace-config';

type SkillHubFs = Pick<typeof fsp, 'cp' | 'mkdir' | 'mkdtemp' | 'rename' | 'rm' | 'writeFile'>;

type RawSkillHubSkill = {
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  description_zh?: unknown;
  version?: unknown;
  ownerName?: unknown;
  downloads?: unknown;
  installs?: unknown;
  stars?: unknown;
  source?: unknown;
  homepage?: unknown;
  upstream_url?: unknown;
  iconUrl?: unknown;
  category?: unknown;
  tags?: unknown;
  subCategories?: Array<{
    key?: unknown;
    name?: unknown;
  }>;
};

type SkillHubListResponse = {
  code?: unknown;
  message?: unknown;
  data?: {
    skills?: RawSkillHubSkill[];
    total?: unknown;
  };
};

type SkillHubDetailResponse = {
  latestVersion?: {
    version?: unknown;
  };
  owner?: {
    displayName?: unknown;
    handle?: unknown;
  };
  skill?: {
    slug?: unknown;
    displayName?: unknown;
    summary?: unknown;
    summary_zh?: unknown;
    source?: unknown;
    sourceUrl?: unknown;
    iconUrl?: unknown;
    category?: unknown;
    stats?: {
      downloads?: unknown;
      installs?: unknown;
      stars?: unknown;
    };
    subCategories?: Array<{
      key?: unknown;
      name?: unknown;
    }>;
    tags?: unknown;
  };
};

const SKILLHUB_PROVIDER_ID = 'skillhub';
const SKILLHUB_API_BASE_URL = validateMarketplaceOrigin(
  SKILL_MARKETPLACE_CONFIG.skillHubApiOrigin,
  'SkillHub API origin',
);
const SKILLHUB_WEB_BASE_URL = validateMarketplaceOrigin(
  SKILL_MARKETPLACE_CONFIG.skillHubWebOrigin,
  'SkillHub web origin',
);
const SKILLHUB_CACHE_TTL_MS = 5 * 60 * 1000;
const SKILLHUB_CACHE_MAX_ENTRIES = 50;
const SKILLHUB_DEFAULT_LIMIT = 100;
const SKILLHUB_MAX_LIMIT = 100;
const VALID_SKILLHUB_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const SKILLHUB_COPY_RETRY_DELAYS_MS = [200, 750, 1500];
let skillHubFs: SkillHubFs = fsp;

let skillHubCountCache: { total: number; timestamp: number } | null = null;
const skillHubSearchCache = new Map<string, { timestamp: number; catalog: MarketplaceSearchResult }>();

function cachedSkillHubCatalog(cacheKey: string): MarketplaceSearchResult | null {
  const cached = skillHubSearchCache.get(cacheKey);
  if (!cached || !isCacheFresh(cached.timestamp)) {
    skillHubSearchCache.delete(cacheKey);
    return null;
  }
  skillHubSearchCache.delete(cacheKey);
  skillHubSearchCache.set(cacheKey, cached);
  return cached.catalog;
}

function cacheSkillHubCatalog(cacheKey: string, catalog: MarketplaceSearchResult): void {
  skillHubSearchCache.delete(cacheKey);
  skillHubSearchCache.set(cacheKey, { timestamp: Date.now(), catalog });
  while (skillHubSearchCache.size > SKILLHUB_CACHE_MAX_ENTRIES) {
    const oldestKey = skillHubSearchCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    skillHubSearchCache.delete(oldestKey);
  }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .map((entry) => stringValue(entry))
    .filter((entry): entry is string => Boolean(entry));
  return values.length > 0 ? values : undefined;
}

function skillHubSlugValue(value: unknown): string | undefined {
  const slug = stringValue(value);
  if (!slug || slug === 'undefined' || slug === 'null') return undefined;
  return VALID_SKILLHUB_SLUG_RE.test(slug) ? slug : undefined;
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SKILLHUB_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(value), 1), SKILLHUB_MAX_LIMIT);
}

function normalizePageFromCursor(cursor?: string): number {
  const value = Number.parseInt(cursor || '', 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function nextCursorFor(page: number, limit: number, total: number, loaded: number): string {
  return page * limit < total && loaded > 0 ? String(page + 1) : '';
}

function isCacheFresh(timestamp: number): boolean {
  return Date.now() - timestamp < SKILLHUB_CACHE_TTL_MS;
}

function skillHubCacheKey(params: {
  query: string;
  page: number;
  limit: number;
  sortBy: string;
  order: string;
  locale?: string;
}): string {
  return [
    params.query,
    params.page,
    params.limit,
    params.sortBy,
    params.order,
    params.locale ?? '',
  ].join('\u001f');
}

function acceptLanguageFor(language: LanguageCode): string {
  switch (language) {
    case 'zh':
      return 'zh-CN,zh;q=0.9,en;q=0.6';
    case 'ja':
      return 'ja-JP,ja;q=0.9,en;q=0.6';
    case 'ru':
      return 'ru-RU,ru;q=0.9,en;q=0.6';
    default:
      return 'en-US,en;q=0.9';
  }
}

function resolveMarketplaceLanguage(localeHint?: string): LanguageCode {
  return resolveSupportedLanguage(localeHint) || 'zh';
}

type MarketplaceResponse = Awaited<ReturnType<typeof requestFetch>>;

async function fetchWithTimeout(
  url: string,
  init: Parameters<typeof requestFetch>[1] = {},
  timeoutMs: number = SKILL_MARKETPLACE_CONFIG.requestTimeoutMs,
): Promise<MarketplaceResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await requestFetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`SkillHub request timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBuffer(response: MarketplaceResponse, maxBytes: number): Promise<Buffer> {
  const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`SkillHub response exceeds the ${maxBytes}-byte limit`);
  }

  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      await response.body.cancel();
      throw new Error(`SkillHub response exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function fetchJson<T>(url: string, language: LanguageCode): Promise<T> {
  const response = await fetchWithTimeout(url, {
    headers: {
      'Accept-Language': acceptLanguageFor(language),
      'User-Agent': 'UClaw-SkillHub/1.0',
    },
  });
  if (!response.ok) {
    throw new Error(`SkillHub request failed with HTTP ${response.status}`);
  }
  const body = await readResponseBuffer(response, SKILL_MARKETPLACE_CONFIG.maxJsonBytes);
  try {
    return JSON.parse(body.toString('utf-8')) as T;
  } catch {
    throw new Error('SkillHub returned invalid JSON');
  }
}

function collectKeywords(entry: RawSkillHubSkill | NonNullable<SkillHubDetailResponse['skill']>): string[] | undefined {
  const values = new Set<string>();
  const add = (value: unknown) => {
    const cleaned = stringValue(value);
    if (cleaned) values.add(cleaned);
  };

  stringArrayValue(entry.tags)?.forEach(add);
  add(entry.category);
  if (Array.isArray(entry.subCategories)) {
    for (const subCategory of entry.subCategories) {
      add(subCategory.key);
      add(subCategory.name);
    }
  }

  return values.size > 0 ? [...values] : undefined;
}

function resolveDescription(entry: RawSkillHubSkill, language: LanguageCode): string {
  const chineseDescription = stringValue(entry.description_zh);
  const defaultDescription = stringValue(entry.description);
  if (language === 'zh') {
    return chineseDescription || defaultDescription || '';
  }
  return defaultDescription || chineseDescription || '';
}

function mapSkillHubSkill(entry: RawSkillHubSkill, language: LanguageCode): MarketplaceSkillResult | null {
  const slug = skillHubSlugValue(entry.slug);
  if (!slug) return null;

  return {
    slug,
    name: stringValue(entry.name) ?? slug,
    description: resolveDescription(entry, language),
    version: stringValue(entry.version) ?? '',
    provider: SKILLHUB_PROVIDER_ID,
    source: stringValue(entry.source) ?? SKILLHUB_PROVIDER_ID,
    sourceUrl: marketplaceUrl(SKILLHUB_WEB_BASE_URL, `/skills/${encodeURIComponent(slug)}`),
    iconUrl: stringValue(entry.iconUrl),
    category: stringValue(entry.category),
    author: stringValue(entry.ownerName),
    downloads: numberValue(entry.downloads) ?? numberValue(entry.installs),
    stars: numberValue(entry.stars),
    keywords: collectKeywords(entry),
  };
}

function mapSkillHubDetail(detail: SkillHubDetailResponse, slug: string, language: LanguageCode): MarketplaceSkillResult | null {
  const skill = detail.skill;
  if (!skill) return null;
  const resolvedSlug = skillHubSlugValue(skill.slug) ?? slug;
  const chineseDescription = stringValue(skill.summary_zh);
  const defaultDescription = stringValue(skill.summary);
  return {
    slug: resolvedSlug,
    name: stringValue(skill.displayName) ?? resolvedSlug,
    description: language === 'zh'
      ? (chineseDescription || defaultDescription || '')
      : (defaultDescription || chineseDescription || ''),
    version: stringValue(detail.latestVersion?.version) ?? '',
    provider: SKILLHUB_PROVIDER_ID,
    source: stringValue(skill.source) ?? SKILLHUB_PROVIDER_ID,
    sourceUrl: marketplaceUrl(SKILLHUB_WEB_BASE_URL, `/skills/${encodeURIComponent(resolvedSlug)}`),
    iconUrl: stringValue(skill.iconUrl),
    category: stringValue(skill.category),
    author: stringValue(detail.owner?.displayName) ?? stringValue(detail.owner?.handle),
    downloads: numberValue(skill.stats?.downloads) ?? numberValue(skill.stats?.installs),
    stars: numberValue(skill.stats?.stars),
    keywords: collectKeywords(skill),
  };
}

async function loadSkillHubTotalCount(language: LanguageCode, force?: boolean): Promise<{ total: number; totalKnown: boolean }> {
  if (!force && skillHubCountCache && isCacheFresh(skillHubCountCache.timestamp)) {
    return { total: skillHubCountCache.total, totalKnown: true };
  }

  try {
    const payload = await fetchJson<SkillHubListResponse>(
      marketplaceUrl(SKILLHUB_API_BASE_URL, '/api/skills', new URLSearchParams({ page: '1', pageSize: '1' })),
      language,
    );
    if (payload.code !== 0) {
      throw new Error(stringValue(payload.message) || 'SkillHub count failed');
    }
    const total = Math.max(0, Math.round(numberValue(payload.data?.total) ?? 0));
    skillHubCountCache = { total, timestamp: Date.now() };
    return { total, totalKnown: true };
  } catch (error) {
    logger.warn('[skillhub] Failed to load marketplace total count:', error);
    if (skillHubCountCache) {
      return { total: skillHubCountCache.total, totalKnown: true };
    }
    return { total: 0, totalKnown: false };
  }
}

async function searchSkillHub(params: {
  query: string;
  page: number;
  limit: number;
  sortBy: string;
  order: string;
  force?: boolean;
  language: LanguageCode;
  locale?: string;
}): Promise<MarketplaceSearchResult> {
  const cacheKey = skillHubCacheKey(params);
  if (!params.force) {
    const cached = cachedSkillHubCatalog(cacheKey);
    if (cached) return cached;
  }

  const searchParams = new URLSearchParams();
  searchParams.set('page', String(params.page));
  searchParams.set('pageSize', String(params.limit));
  searchParams.set('sortBy', params.sortBy);
  searchParams.set('order', params.order);
  if (params.query.trim()) {
    searchParams.set('keyword', params.query.trim());
  }

  const payload = await fetchJson<SkillHubListResponse>(
    marketplaceUrl(SKILLHUB_API_BASE_URL, '/api/skills', searchParams),
    params.language,
  );
  if (payload.code !== 0) {
    throw new Error(stringValue(payload.message) || 'SkillHub search failed');
  }

  const total = Math.max(0, Math.round(numberValue(payload.data?.total) ?? 0));
  const results = (Array.isArray(payload.data?.skills) ? payload.data.skills : [])
    .map((entry) => mapSkillHubSkill(entry, params.language))
    .filter((skill): skill is MarketplaceSkillResult => skill !== null);
  const catalogCount = await loadSkillHubTotalCount(params.language, params.force);
  const catalog = {
    results,
    total,
    loaded: results.length,
    totalKnown: true,
    catalogTotal: catalogCount.total,
    catalogTotalKnown: catalogCount.totalKnown,
    source: SKILLHUB_PROVIDER_ID,
    query: params.query,
    sort: params.sortBy,
    dir: params.order,
    hasMore: Boolean(nextCursorFor(params.page, params.limit, total, results.length)),
    nextCursor: nextCursorFor(params.page, params.limit, total, results.length),
  };

  cacheSkillHubCatalog(cacheKey, catalog);
  return catalog;
}

function isInsideRoot(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && rel !== '..');
}

async function downloadSkillZip(slug: string): Promise<Buffer> {
  const response = await fetchWithTimeout(
    marketplaceUrl(SKILLHUB_API_BASE_URL, '/api/v1/download', new URLSearchParams({ slug })),
    {
      headers: {
        'User-Agent': 'UClaw-SkillHub/1.0',
      },
    },
    SKILL_MARKETPLACE_CONFIG.downloadTimeoutMs,
  );
  if (!response.ok) {
    throw new Error(`SkillHub download failed with HTTP ${response.status}`);
  }
  return await readResponseBuffer(response, SKILL_MARKETPLACE_CONFIG.maxDownloadBytes);
}

async function fetchSkillHubDetail(slug: string, language: LanguageCode): Promise<MarketplaceSkillResult | null> {
  try {
    const detail = await fetchJson<SkillHubDetailResponse>(
      marketplaceUrl(SKILLHUB_API_BASE_URL, `/api/v1/skills/${encodeURIComponent(slug)}`),
      language,
    );
    return mapSkillHubDetail(detail, slug, language);
  } catch (error) {
    logger.warn(`[skillhub] Failed to load skill detail for "${slug}":`, error);
    return null;
  }
}

async function extractSkillZip(params: {
  zipBuffer: Buffer;
  targetDir: string;
  slug: string;
  version?: string;
  detail?: MarketplaceSkillResult | null;
}): Promise<void> {
  const { zipBuffer, targetDir } = params;
  const zip = await JSZip.loadAsync(zipBuffer);
  const archiveEntries = Object.values(zip.files);
  if (archiveEntries.length > SKILL_MARKETPLACE_CONFIG.maxArchiveFiles) {
    throw new Error('SkillHub archive contains too many files');
  }
  const targetParent = dirname(targetDir);
  await skillHubFs.mkdir(targetParent, { recursive: true });
  const tempDir = await skillHubFs.mkdtemp(join(targetParent, `.${basename(targetDir)}-skillhub-`));

  const targetRoot = resolve(tempDir);
  let hasSkillManifest = false;
  let extractedBytes = 0;
  let extractedFiles = 0;

  try {
    for (const entry of archiveEntries) {
      if (entry.dir) continue;
      extractedFiles += 1;
      if (extractedFiles > SKILL_MARKETPLACE_CONFIG.maxArchiveFiles) {
        throw new Error('SkillHub archive contains too many files');
      }

      const archiveEntry = entry as typeof entry & {
        unsafeOriginalName?: string;
        _data?: { uncompressedSize?: number };
      };
      const originalName = archiveEntry.unsafeOriginalName || entry.name;
      const declaredSize = archiveEntry._data?.uncompressedSize;
      if (typeof declaredSize === 'number' && declaredSize > SKILL_MARKETPLACE_CONFIG.maxArchiveEntryBytes) {
        throw new Error(`SkillHub archive entry exceeds the size limit: ${originalName}`);
      }
      if (typeof declaredSize === 'number' && extractedBytes + declaredSize > SKILL_MARKETPLACE_CONFIG.maxArchiveUncompressedBytes) {
        throw new Error('SkillHub archive exceeds the uncompressed size limit');
      }

      const normalizedName = normalize(originalName.replace(/\\/g, '/')).replace(/\\/g, '/');
      if (!normalizedName || normalizedName.startsWith('..') || normalizedName.startsWith('/') || /^[a-zA-Z]:/.test(normalizedName)) {
        throw new Error(`SkillHub archive contains an unsafe file path: ${originalName}`);
      }
      if (normalizedName.includes('\0')) {
        throw new Error(`SkillHub archive contains an unsafe file path: ${originalName}`);
      }
      const destinationPath = resolve(tempDir, normalizedName);
      if (!isInsideRoot(targetRoot, destinationPath)) {
        throw new Error(`SkillHub archive contains a file outside the skill directory: ${entry.name}`);
      }
      if (normalizedName === 'SKILL.md') {
        hasSkillManifest = true;
      }

      const content = await entry.async('nodebuffer');
      if (content.byteLength > SKILL_MARKETPLACE_CONFIG.maxArchiveEntryBytes) {
        throw new Error(`SkillHub archive entry exceeds the size limit: ${entry.name}`);
      }
      extractedBytes += content.byteLength;
      if (extractedBytes > SKILL_MARKETPLACE_CONFIG.maxArchiveUncompressedBytes) {
        throw new Error('SkillHub archive exceeds the uncompressed size limit');
      }
      await skillHubFs.mkdir(dirname(destinationPath), { recursive: true });
      await skillHubFs.writeFile(destinationPath, content);
    }

    if (!hasSkillManifest) {
      throw new Error('SkillHub archive does not contain SKILL.md');
    }

    await persistOriginMetadata({
      targetDir: tempDir,
      slug: params.slug,
      version: params.version,
      detail: params.detail,
    });
    await commitExtractedSkillDir(tempDir, targetDir);
  } catch (error) {
    await skillHubFs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function isRetriableWindowsFsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function removeDirectoryBestEffort(dir: string): Promise<void> {
  try {
    await skillHubFs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    logger.warn(`[skillhub] Failed to remove stale skill directory "${dir}":`, error);
  }
}

async function moveExistingTargetAside(targetDir: string): Promise<{ oldDir: string | null; targetExisted: boolean }> {
  const oldDir = join(dirname(targetDir), `.${basename(targetDir)}-delete-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await skillHubFs.rename(targetDir, oldDir);
      return { oldDir, targetExisted: true };
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code;
      if (code === 'ENOENT') {
        return { oldDir: null, targetExisted: false };
      }
      if (!isRetriableWindowsFsError(error) || attempt >= SKILLHUB_COPY_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await delay(SKILLHUB_COPY_RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function copyExtractedSkillDirWithRetries(tempDir: string, targetDir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await skillHubFs.cp(tempDir, targetDir, { recursive: true, force: true, errorOnExist: false });
      return;
    } catch (error) {
      if (!isRetriableWindowsFsError(error) || attempt >= SKILLHUB_COPY_RETRY_DELAYS_MS.length) {
        throw error;
      }
      const waitMs = SKILLHUB_COPY_RETRY_DELAYS_MS[attempt];
      logger.warn(
        `[skillhub] Copy install failed for "${targetDir}", retrying in ${waitMs}ms:`,
        error,
      );
      await delay(waitMs);
    }
  }
}

async function commitExtractedSkillDir(tempDir: string, targetDir: string): Promise<void> {
  const { oldDir, targetExisted } = await moveExistingTargetAside(targetDir);
  let committed = false;
  let restored = false;
  try {
    try {
      await skillHubFs.rename(tempDir, targetDir);
    } catch (error) {
      if (!isRetriableWindowsFsError(error)) {
        throw error;
      }
      logger.warn(`[skillhub] Rename install failed for "${targetDir}", falling back to copy:`, error);
      await copyExtractedSkillDirWithRetries(tempDir, targetDir);
      await skillHubFs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    committed = true;
  } catch (error) {
    if (oldDir) {
      await removeDirectoryBestEffort(targetDir);
      try {
        await skillHubFs.rename(oldDir, targetDir);
        restored = true;
      } catch (restoreError) {
        logger.warn(`[skillhub] Failed to restore previous skill directory "${targetDir}":`, restoreError);
      }
    } else if (!targetExisted) {
      await removeDirectoryBestEffort(targetDir);
    }
    throw error;
  } finally {
    if (oldDir && (committed || restored)) {
      await removeDirectoryBestEffort(oldDir);
    }
  }
}

async function persistOriginMetadata(params: {
  targetDir: string;
  slug: string;
  version?: string;
  detail?: MarketplaceSkillResult | null;
}): Promise<void> {
  const originDir = join(params.targetDir, '.clawhub');
  await skillHubFs.mkdir(originDir, { recursive: true });
  await skillHubFs.writeFile(join(originDir, 'origin.json'), `${JSON.stringify({
    provider: SKILLHUB_PROVIDER_ID,
    slug: params.slug,
    installedVersion: params.version || params.detail?.version,
    registry: SKILLHUB_API_BASE_URL,
    source: params.detail?.source,
    sourceUrl: params.detail?.sourceUrl,
    displayName: params.detail?.name,
    displayDescription: params.detail?.description,
    downloads: params.detail?.downloads,
    stars: params.detail?.stars,
  }, null, 2)}\n`, 'utf-8');
}

class SkillHubMarketplaceExtension implements MarketplaceProviderExtension {
  readonly id = SKILLHUB_PROVIDER_ID;

  setup(_ctx: ExtensionContext): void {
    // SkillHub is HTTP-backed and does not need startup work.
  }

  async getCapability(): Promise<MarketplaceCapability> {
    return {
      mode: 'public-skillhub',
      canSearch: true,
      canInstall: true,
    };
  }

  async search(params: MarketplaceSearchParams): Promise<MarketplaceSearchResult> {
    const language = resolveMarketplaceLanguage(params.locale);
    const query = stringValue(params.query) ?? '';
    return await searchSkillHub({
      query,
      page: normalizePageFromCursor(params.cursor),
      limit: normalizeLimit(params.limit),
      sortBy: stringValue(params.sort) ?? 'score',
      order: stringValue(params.dir) ?? 'desc',
      force: params.force,
      language,
      locale: params.locale,
    });
  }

  async install(params: MarketplaceInstallParams): Promise<void> {
    const slug = skillHubSlugValue(params.slug);
    if (!slug) {
      throw new Error('Marketplace install requires a valid skill slug');
    }

    logger.info(`[skillhub] Installing marketplace skill "${slug}"`);
    const language = resolveMarketplaceLanguage();
    const detail = await fetchSkillHubDetail(slug, language);
    const zipBuffer = await downloadSkillZip(slug);
    const targetDir = join(getOpenClawConfigDir(), 'skills', slug);
    await extractSkillZip({
      zipBuffer,
      targetDir,
      slug,
      version: stringValue(params.version),
      detail,
    });
  }
}

export function createSkillHubMarketplaceExtension(): Extension {
  return new SkillHubMarketplaceExtension();
}

export function __setSkillHubFsForTests(nextFs: SkillHubFs | null): void {
  skillHubFs = nextFs ?? fsp;
}

export async function __extractSkillHubZipForTests(zipBuffer: Buffer, targetDir: string): Promise<void> {
  await extractSkillZip({ zipBuffer, targetDir, slug: basename(targetDir) });
}
