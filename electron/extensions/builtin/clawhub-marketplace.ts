import { getSetting } from '../../utils/store';
import { resolveSupportedLanguage, type LanguageCode } from '../../../shared/language';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetch as requestFetch, Headers as RequestHeaders } from 'undici';
import type {
  Extension,
  ExtensionContext,
  MarketplaceProviderExtension,
  MarketplaceCapability,
} from '../types';
import type {
  MarketplaceSearchParams,
  MarketplaceSearchResult,
  MarketplaceInstallParams,
  MarketplaceSkillResult,
} from '../../gateway/clawhub';
import { logger } from '../../utils/logger';
import { getOpenClawConfigDir, getOpenClawResolvedDir } from '../../utils/paths';
import {
  marketplaceUrl,
  SKILL_MARKETPLACE_CONFIG,
  validateMarketplaceOrigin,
} from './marketplace-config';

type RawClawHubSkill = {
  _creationTime?: unknown;
  id?: unknown;
  _id?: unknown;
  slug?: unknown;
  skillSlug?: unknown;
  displayName?: unknown;
  name?: unknown;
  summary?: unknown;
  description?: unknown;
  summaryZh?: unknown;
  descriptionZh?: unknown;
  summary_zh?: unknown;
  description_zh?: unknown;
  version?: unknown;
  ownerHandle?: unknown;
  owner?: {
    handle?: unknown;
    displayName?: unknown;
    image?: unknown;
  };
  latestVersion?: {
    version?: unknown;
  };
  skill?: {
    _creationTime?: unknown;
    _id?: unknown;
    slug?: unknown;
    displayName?: unknown;
    name?: unknown;
    summary?: unknown;
    description?: unknown;
    tags?: unknown;
    topics?: unknown;
    categories?: unknown;
    capabilityTags?: unknown;
    stats?: {
      downloads?: unknown;
      stars?: unknown;
      comments?: unknown;
      installsAllTime?: unknown;
      installsCurrent?: unknown;
    };
    badges?: {
      highlighted?: unknown;
      official?: unknown;
    };
    createdAt?: unknown;
    updatedAt?: unknown;
  };
  downloads?: unknown;
  stars?: unknown;
  metaContent?: {
    DisplayName?: unknown;
    displayName?: unknown;
    DisplayDescription?: unknown;
    displayDescription?: unknown;
    summary?: unknown;
    Summary?: unknown;
    slug?: unknown;
    Slug?: unknown;
    Keywords?: unknown;
    keywords?: unknown;
    latest?: {
      version?: unknown;
    };
  };
  score?: unknown;
};

type RawClawHubSkillDetail = {
  skill?: {
    displayName?: unknown;
    summary?: unknown;
  };
  metaContent?: {
    DisplayDescription?: unknown;
    displayDescription?: unknown;
  };
};

type InstallResult = {
  ok?: boolean;
  error?: string;
};

type SearchFn = (params: {
  query?: string;
  limit?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}) => Promise<RawClawHubSkill[]>;

type InstallFn = (params: {
  workspaceDir: string;
  slug: string;
  version?: string;
  force?: boolean;
  baseUrl?: string;
  logger?: { info?: (message: string) => void };
}) => Promise<InstallResult>;

type RuntimeModule = {
  r?: SearchFn | InstallFn;
  s?: SearchFn;
  t?: InstallFn;
  searchSkillsFromClawHub?: SearchFn;
  installSkillFromClawHub?: InstallFn;
};

type LoadedRuntime = {
  searchSkillsFromClawHub: SearchFn;
  installSkillFromClawHub: InstallFn;
};

type RuntimeModuleCandidate = {
  path: string;
  kind: 'legacy-skills-clawhub' | 'skills-status';
};

const DEFAULT_MARKETPLACE_QUERY = 'skill';
const DEFAULT_BROWSE_LIMIT = 100;
const MAX_SEARCH_LIMIT = 100;
const MAX_BROWSE_LIMIT = 500;
const CLAWHUB_CONVEX_BASE = validateMarketplaceOrigin(
  SKILL_MARKETPLACE_CONFIG.clawHubConvexOrigin,
  'ClawHub Convex origin',
);
const CLAWHUB_CACHE_TTL_MS = 10 * 60 * 1000;
const CLAWHUB_CACHE_MAX_ENTRIES = 50;
const CLAWHUB_MAX_PAGE_SIZE = 50;
const OPENCLAW_SKILLS_CLAWHUB_MODULE_RE = /^skills-clawhub(?:-.+)?\.js$/;
const OPENCLAW_SKILLS_STATUS_MODULE_RE = /^status(?:-.+)?\.js$/;
const OPENCLAW_SKILLS_STATUS_EXPORT_MARKERS = [
  'searchSkillsFromClawHub',
  'installSkillFromClawHub',
] as const;
const DEFAULT_CLAWHUB_MIRROR_URL = validateMarketplaceOrigin('https://mirror-cn.clawhub.com', 'ClawHub mirror origin');
const DEFAULT_CLAWHUB_INSTALL_URL = validateMarketplaceOrigin('https://clawhub.ai', 'ClawHub install origin');
const VALID_MARKETPLACE_SKILL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

let runtimeModulePromise: Promise<LoadedRuntime> | null = null;
let clawhubCountCache: { total: number; timestamp: number } | null = null;
const clawhubCatalogCache = new Map<string, { timestamp: number; catalog: MarketplaceSearchResult }>();

function cachedClawHubCatalog(cacheKey: string): MarketplaceSearchResult | null {
  const cached = clawhubCatalogCache.get(cacheKey);
  if (!cached || !isCacheFresh(cached.timestamp)) {
    clawhubCatalogCache.delete(cacheKey);
    return null;
  }
  clawhubCatalogCache.delete(cacheKey);
  clawhubCatalogCache.set(cacheKey, cached);
  return cached.catalog;
}

function cacheClawHubCatalog(cacheKey: string, catalog: MarketplaceSearchResult): void {
  clawhubCatalogCache.delete(cacheKey);
  clawhubCatalogCache.set(cacheKey, { timestamp: Date.now(), catalog });
  while (clawhubCatalogCache.size > CLAWHUB_CACHE_MAX_ENTRIES) {
    const oldestKey = clawhubCatalogCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    clawhubCatalogCache.delete(oldestKey);
  }
}

type ClawHubConvexResponse<T> = {
  status?: string;
  value?: T;
  errorMessage?: string;
  errorData?: unknown;
};

type ClawHubListPage = {
  page?: RawClawHubSkill[];
  hasMore?: boolean;
  nextCursor?: string;
};

type MarketplaceResponse = Awaited<ReturnType<typeof requestFetch>>;

async function fetchWithTimeout(
  input: Parameters<typeof requestFetch>[0],
  init: Parameters<typeof requestFetch>[1] = {},
  timeoutMs: number = SKILL_MARKETPLACE_CONFIG.requestTimeoutMs,
): Promise<MarketplaceResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await requestFetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`ClawHub request timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBuffer(response: MarketplaceResponse, maxBytes: number): Promise<Buffer> {
  const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`ClawHub response exceeds the ${maxBytes}-byte limit`);
  }

  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      await response.body.cancel();
      throw new Error(`ClawHub response exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function marketplaceSlugValue(value: unknown): string | undefined {
  const slug = stringValue(value);
  if (!slug) return undefined;
  if (slug === 'undefined' || slug === 'null') return undefined;
  return VALID_MARKETPLACE_SKILL_SLUG_RE.test(slug) ? slug : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .map((entry) => stringValue(entry))
    .filter((entry): entry is string => Boolean(entry));
  return values.length > 0 ? values : undefined;
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MAX_SEARCH_LIMIT;
  return Math.min(Math.max(Math.floor(value), 1), MAX_SEARCH_LIMIT);
}

function normalizeBrowseLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BROWSE_LIMIT;
  return Math.min(Math.max(Math.floor(value), 1), MAX_BROWSE_LIMIT);
}

function normalizeSort(value: unknown, searching: boolean): string {
  const sort = stringValue(value)?.toLowerCase();
  if (searching && sort === 'relevance') return 'relevance';
  if (sort === 'newest' || sort === 'updated' || sort === 'installs' || sort === 'stars' || sort === 'name') {
    return sort;
  }
  return 'downloads';
}

function normalizeDir(value: unknown, sort: string): string {
  const dir = stringValue(value)?.toLowerCase();
  if (dir === 'asc' || dir === 'desc') return dir;
  return sort === 'name' ? 'asc' : 'desc';
}

function resolveConfiguredMarketplaceBaseUrl(): string | undefined {
  const configured = stringValue(process.env.OPENCLAW_CLAWHUB_URL)
    ?? stringValue(process.env.CLAWHUB_URL);
  return configured ? validateMarketplaceOrigin(configured, 'ClawHub configured origin') : undefined;
}

function resolveMarketplaceSearchBaseUrl(): string {
  return resolveConfiguredMarketplaceBaseUrl() ?? DEFAULT_CLAWHUB_MIRROR_URL;
}

function resolveMarketplaceInstallBaseUrl(version?: string): string {
  const configuredUrl = resolveConfiguredMarketplaceBaseUrl();
  if (configuredUrl) return configuredUrl;
  return version ? DEFAULT_CLAWHUB_MIRROR_URL : DEFAULT_CLAWHUB_INSTALL_URL;
}

function isIncompatibleInstallResolutionError(error: string): boolean {
  return /\bSkill\s+"(?:undefined|null)"\s+is not installable\b/i.test(error);
}

function normalizeInstallError(error: string, baseUrl: string): string {
  if (isIncompatibleInstallResolutionError(error)) {
    return `Marketplace install source returned an incompatible install response for "${baseUrl}"`;
  }
  return error;
}

function isCacheFresh(timestamp: number): boolean {
  return Date.now() - timestamp < CLAWHUB_CACHE_TTL_MS;
}

function clawhubCatalogCacheKey(params: {
  query: string;
  sort: string;
  dir: string;
  cursor?: string;
  limit: number;
}): string {
  return [
    params.query,
    params.sort,
    params.dir,
    params.cursor ?? '',
    String(params.limit),
  ].join('\u001f');
}

async function runClawHubConvexRequest<T>(
  endpoint: 'query' | 'action',
  path: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await fetchWithTimeout(marketplaceUrl(CLAWHUB_CONVEX_BASE, `/api/${endpoint}`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Encoding': 'identity',
    },
    body: JSON.stringify({
      path,
      format: 'convex_encoded_json',
      args: [args],
    }),
  });
  if (!response.ok) {
    throw new Error(`ClawHub ${path} failed with HTTP ${response.status}`);
  }

  const body = await readResponseBuffer(response, SKILL_MARKETPLACE_CONFIG.maxJsonBytes);
  let payload: ClawHubConvexResponse<T>;
  try {
    payload = JSON.parse(body.toString('utf-8')) as ClawHubConvexResponse<T>;
  } catch (error) {
    throw new Error(`ClawHub ${path} returned invalid JSON`, { cause: error });
  }
  if (payload.status === 'success' && payload.value !== undefined) {
    return payload.value;
  }

  const detail = stringValue(payload.errorMessage);
  const errorData = payload.errorData === undefined ? '' : JSON.stringify(payload.errorData);
  throw new Error(`ClawHub ${path} failed${detail ? `: ${detail}` : ''}${errorData ? ` (${errorData})` : ''}`);
}

async function loadClawHubTotalCount(force?: boolean): Promise<{ total: number; totalKnown: boolean }> {
  if (!force && clawhubCountCache && isCacheFresh(clawhubCountCache.timestamp)) {
    return { total: clawhubCountCache.total, totalKnown: true };
  }

  try {
    const rawTotal = await runClawHubConvexRequest<number>('query', 'skills:countPublicSkills', {});
    const total = Math.max(0, Math.round(numberValue(rawTotal) ?? 0));
    clawhubCountCache = { total, timestamp: Date.now() };
    return { total, totalKnown: true };
  } catch (error) {
    logger.warn('[clawhub] Failed to load marketplace total count:', error);
    if (clawhubCountCache) {
      return { total: clawhubCountCache.total, totalKnown: true };
    }
    return { total: 0, totalKnown: false };
  }
}

async function loadClawHubListPage(params: {
  sort: string;
  dir: string;
  cursor?: string;
  limit: number;
}): Promise<ClawHubListPage> {
  const args: Record<string, unknown> = {
    numItems: Math.min(params.limit, CLAWHUB_MAX_PAGE_SIZE),
    sort: params.sort,
    dir: params.dir,
  };
  if (params.cursor) {
    args.cursor = params.cursor;
  }
  return await runClawHubConvexRequest<ClawHubListPage>('query', 'skills:listPublicPageV4', args);
}

function collectClawHubKeywords(entry: RawClawHubSkill): string[] | undefined {
  const values = new Set<string>();
  const add = (value: unknown) => {
    const cleaned = stringValue(value);
    if (!cleaned || cleaned.toLowerCase() === 'latest') return;
    values.add(cleaned);
  };

  stringArrayValue(entry.metaContent?.Keywords)?.forEach(add);
  stringArrayValue(entry.metaContent?.keywords)?.forEach(add);
  stringArrayValue(entry.skill?.topics)?.forEach(add);
  stringArrayValue(entry.skill?.categories)?.forEach(add);
  stringArrayValue(entry.skill?.capabilityTags)?.forEach(add);
  const tags = entry.skill?.tags;
  if (tags && typeof tags === 'object' && !Array.isArray(tags)) {
    Object.keys(tags).forEach(add);
  }

  return values.size > 0 ? [...values] : undefined;
}

function resolveClawHubOwner(entry: RawClawHubSkill): string | undefined {
  return stringValue(entry.ownerHandle)
    ?? stringValue(entry.owner?.displayName)
    ?? stringValue(entry.owner?.handle);
}

async function fetchMarketplaceSkillDetail(
  slug: string,
  baseUrl: string,
  language: LanguageCode,
): Promise<{ displayDescription?: string; defaultDescription?: string; displayName?: string } | null> {
  try {
    const url = new URL(`/api/v1/skills/${encodeURIComponent(slug)}`, `${baseUrl.replace(/\/+$/, '')}/`);
    const response = await buildLocalizedFetch(language)(url.toString()) as unknown as MarketplaceResponse;
    if (!response.ok) return null;
    const payload = await response.json() as RawClawHubSkillDetail;
    return {
      displayDescription: stringValue(payload.metaContent?.DisplayDescription)
        ?? stringValue(payload.metaContent?.displayDescription),
      defaultDescription: stringValue(payload.skill?.summary),
      displayName: stringValue(payload.skill?.displayName),
    };
  } catch {
    return null;
  }
}

async function persistInstalledMarketplaceMetadata(params: {
  workspaceDir: string;
  slug: string;
  baseUrl: string;
  language: LanguageCode;
}): Promise<void> {
  const detail = await fetchMarketplaceSkillDetail(params.slug, params.baseUrl, params.language);
  if (!detail) return;

  const originDir = join(params.workspaceDir, 'skills', params.slug, '.clawhub');
  const originPath = join(originDir, 'origin.json');
  await mkdir(originDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(originPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // Metadata is optional; a missing or malformed origin file starts fresh.
  }

  const next = {
    ...existing,
    ...(detail.displayDescription ? { displayDescription: detail.displayDescription } : {}),
    ...(detail.defaultDescription ? { defaultDescription: detail.defaultDescription } : {}),
    ...(detail.displayName ? { displayName: detail.displayName } : {}),
  };
  await writeFile(originPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
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

async function resolveMarketplaceLanguage(localeHint?: string): Promise<LanguageCode> {
  const hintedLanguage = resolveSupportedLanguage(localeHint);
  if (localeHint && hintedLanguage) {
    return hintedLanguage;
  }
  try {
    return resolveSupportedLanguage(await getSetting('language'));
  } catch {
    return 'en';
  }
}

function buildLocalizedFetch(language: LanguageCode): typeof fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ) => {
    const headers = new RequestHeaders(
      init?.headers as ConstructorParameters<typeof RequestHeaders>[0],
    );
    if (!headers.has('Accept-Language')) {
      headers.set('Accept-Language', acceptLanguageFor(language));
    }
    return await fetchWithTimeout(input as Parameters<typeof requestFetch>[0], {
      ...init,
      headers,
    } as Parameters<typeof requestFetch>[1]);
  }) as unknown as typeof fetch;
}

function hasRuntimeFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

function resolveRuntimeExports(
  mod: RuntimeModule,
  candidate: RuntimeModuleCandidate,
): LoadedRuntime | null {
  const explicitSearch = mod.searchSkillsFromClawHub;
  const explicitInstall = mod.installSkillFromClawHub;
  if (hasRuntimeFunction(explicitSearch) && hasRuntimeFunction(explicitInstall)) {
    return {
      searchSkillsFromClawHub: explicitSearch as SearchFn,
      installSkillFromClawHub: explicitInstall as InstallFn,
    };
  }

  const searchSkillsFromClawHub = candidate.kind === 'skills-status'
    ? mod.s
    : mod.r;
  const installSkillFromClawHub = candidate.kind === 'skills-status'
    ? mod.r
    : mod.t;

  if (hasRuntimeFunction(searchSkillsFromClawHub) && hasRuntimeFunction(installSkillFromClawHub)) {
    return {
      searchSkillsFromClawHub: searchSkillsFromClawHub as SearchFn,
      installSkillFromClawHub: installSkillFromClawHub as InstallFn,
    };
  }

  return null;
}

async function isSkillsStatusModule(distDir: string, entry: string): Promise<boolean> {
  if (!OPENCLAW_SKILLS_STATUS_MODULE_RE.test(entry)) return false;

  try {
    const content = await readFile(join(distDir, entry), 'utf-8');
    return OPENCLAW_SKILLS_STATUS_EXPORT_MARKERS.every((marker) => content.includes(marker));
  } catch {
    return false;
  }
}

async function resolveRuntimeModuleCandidates(): Promise<RuntimeModuleCandidate[]> {
  const distDir = join(getOpenClawResolvedDir(), 'dist');
  const entries = await readdir(distDir);
  const legacyCandidates = entries
    .filter((entry) => OPENCLAW_SKILLS_CLAWHUB_MODULE_RE.test(entry))
    .map((entry): RuntimeModuleCandidate => ({
      path: join(distDir, entry),
      kind: 'legacy-skills-clawhub',
    }));
  const statusCandidates = (await Promise.all(entries.map(async (entry): Promise<RuntimeModuleCandidate | null> => (
    await isSkillsStatusModule(distDir, entry)
      ? {
          path: join(distDir, entry),
          kind: 'skills-status',
        }
      : null
  )))).filter((candidate): candidate is RuntimeModuleCandidate => candidate !== null);
  const candidates = [...legacyCandidates, ...statusCandidates];

  if (candidates.length === 0) {
    throw new Error(`OpenClaw ClawHub runtime module not found in ${distDir}`);
  }

  return candidates;
}

async function importRuntimeModule(): Promise<LoadedRuntime> {
  const candidates = await resolveRuntimeModuleCandidates();
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const mod = await import(/* @vite-ignore */ pathToFileURL(candidate.path).href) as RuntimeModule;
      const runtime = resolveRuntimeExports(mod, candidate);
      if (runtime) return runtime;
      errors.push(`${candidate.path}: incompatible exports`);
    } catch (error) {
      errors.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`OpenClaw ClawHub runtime module has incompatible exports: ${errors.join('; ')}`);
}

async function loadRuntimeModule(): Promise<LoadedRuntime> {
  runtimeModulePromise ??= importRuntimeModule();
  try {
    return await runtimeModulePromise;
  } catch (error) {
    runtimeModulePromise = null;
    throw error;
  }
}

function resolveLocalizedDescription(entry: RawClawHubSkill, language: LanguageCode): string {
  const defaultDescription = stringValue(entry.summary)
    ?? stringValue(entry.description)
    ?? stringValue(entry.skill?.summary)
    ?? stringValue(entry.skill?.description)
    ?? '';
  const chineseDescription = stringValue(entry.summaryZh)
    ?? stringValue(entry.descriptionZh)
    ?? stringValue(entry.summary_zh)
    ?? stringValue(entry.description_zh)
    ?? stringValue(entry.metaContent?.DisplayDescription)
    ?? stringValue(entry.metaContent?.displayDescription);

  if (language === 'zh') {
    return chineseDescription ?? defaultDescription;
  }

  return defaultDescription || chineseDescription || stringValue(entry.metaContent?.summary) || stringValue(entry.metaContent?.Summary) || '';
}

function mapSkillResult(entry: RawClawHubSkill, language: LanguageCode): MarketplaceSkillResult | null {
  const slug = marketplaceSlugValue(entry.slug)
    ?? marketplaceSlugValue(entry.skillSlug)
    ?? marketplaceSlugValue(entry.skill?.slug)
    ?? marketplaceSlugValue(entry.id)
    ?? marketplaceSlugValue(entry.metaContent?.slug)
    ?? marketplaceSlugValue(entry.metaContent?.Slug)
    ?? marketplaceSlugValue(entry.name)
    ?? marketplaceSlugValue(entry.skill?.name);
  if (!slug) return null;

  return {
    slug,
    name: stringValue(entry.displayName)
      ?? stringValue(entry.skill?.displayName)
      ?? stringValue(entry.metaContent?.displayName)
      ?? stringValue(entry.metaContent?.DisplayName)
      ?? stringValue(entry.name)
      ?? stringValue(entry.skill?.name)
      ?? slug,
    description: resolveLocalizedDescription(entry, language),
    version: stringValue(entry.version)
      ?? stringValue(entry.latestVersion?.version)
      ?? stringValue(entry.metaContent?.latest?.version)
      ?? '',
    provider: 'clawhub',
    source: 'clawhub',
    sourceUrl: `https://mirror-cn.clawhub.com/s/${slug}`,
    author: resolveClawHubOwner(entry),
    downloads: numberValue(entry.downloads) ?? numberValue(entry.skill?.stats?.downloads),
    stars: numberValue(entry.stars) ?? numberValue(entry.skill?.stats?.stars),
    keywords: collectClawHubKeywords(entry),
  };
}

function mapConvexSkillResult(entry: RawClawHubSkill, language: LanguageCode): MarketplaceSkillResult | null {
  const skill = mapSkillResult(entry, language);
  if (!skill) return null;
  return {
    ...skill,
    keywords: collectClawHubKeywords(entry) ?? skill.keywords,
  };
}

async function loadClawHubCatalog(params: {
  query: string;
  sort: string;
  dir: string;
  cursor?: string;
  limit: number;
  force?: boolean;
  language: LanguageCode;
}): Promise<MarketplaceSearchResult> {
  const cacheKey = clawhubCatalogCacheKey(params);
  if (!params.force) {
    const cached = cachedClawHubCatalog(cacheKey);
    if (cached) return cached;
  }

  let catalog: MarketplaceSearchResult;
  if (params.query.length === 0) {
    const loadedEntries: RawClawHubSkill[] = [];
    let nextCursor = params.cursor;
    let hasMore = false;

    while (loadedEntries.length < params.limit) {
      const remaining = params.limit - loadedEntries.length;
      const page = await loadClawHubListPage({
        sort: params.sort,
        dir: params.dir,
        cursor: nextCursor,
        limit: remaining,
      });
      const batch = Array.isArray(page.page) ? page.page : [];
      loadedEntries.push(...batch);
      hasMore = Boolean(page.hasMore && stringValue(page.nextCursor));
      nextCursor = hasMore ? stringValue(page.nextCursor) : undefined;
      if (batch.length === 0 || !hasMore) break;
    }

    const { total, totalKnown } = await loadClawHubTotalCount(params.force);
    const results = loadedEntries
      .map((entry) => mapConvexSkillResult(entry, params.language))
      .filter((skill): skill is MarketplaceSkillResult => skill !== null);

    catalog = {
      results,
      total,
      loaded: results.length,
      totalKnown,
      catalogTotal: total,
      catalogTotalKnown: totalKnown,
      source: 'clawhub',
      query: '',
      sort: params.sort,
      dir: params.dir,
      hasMore,
      nextCursor: nextCursor ?? '',
    };
  } else {
    const effectiveLimit = Math.min(params.limit, MAX_SEARCH_LIMIT);
    const [entries, catalogCount] = await Promise.all([
      runClawHubConvexRequest<RawClawHubSkill[]>('action', 'search:searchSkills', {
        query: params.query,
        limit: effectiveLimit,
      }),
      loadClawHubTotalCount(params.force),
    ]);
    const results = (Array.isArray(entries) ? entries : [])
      .map((entry) => mapConvexSkillResult(entry, params.language))
      .filter((skill): skill is MarketplaceSkillResult => skill !== null);

    catalog = {
      results,
      total: results.length,
      loaded: results.length,
      totalKnown: true,
      catalogTotal: catalogCount.total,
      catalogTotalKnown: catalogCount.totalKnown,
      source: 'clawhub',
      query: params.query,
      sort: params.sort,
      dir: params.dir,
      hasMore: false,
      nextCursor: '',
    };
  }

  cacheClawHubCatalog(cacheKey, catalog);
  return catalog;
}

class ClawHubMarketplaceExtension implements MarketplaceProviderExtension {
  readonly id = 'clawhub';

  setup(_ctx: ExtensionContext): void {
    // Runtime is loaded lazily so startup still works if OpenClaw is being prepared.
  }

  async getCapability(): Promise<MarketplaceCapability> {
    try {
      await loadRuntimeModule();
      return {
        mode: 'public-clawhub',
        canSearch: true,
        canInstall: true,
      };
    } catch (error) {
      logger.warn('[clawhub] Public marketplace runtime is unavailable:', error);
      return {
        mode: 'local-only',
        canSearch: false,
        canInstall: false,
        reason: 'marketplace-runtime-missing',
      };
    }
  }

  async search(params: MarketplaceSearchParams): Promise<MarketplaceSearchResult> {
    const runtime = await loadRuntimeModule();
    const language = await resolveMarketplaceLanguage(params.locale);
    const query = stringValue(params.query) ?? '';
    const sort = normalizeSort(params.sort, query.length > 0);
    const dir = normalizeDir(params.dir, sort);

    if (!resolveConfiguredMarketplaceBaseUrl()) {
      return await loadClawHubCatalog({
        query,
        sort,
        dir,
        cursor: stringValue(params.cursor),
        limit: query.length === 0 ? normalizeBrowseLimit(params.limit) : normalizeLimit(params.limit),
        force: params.force,
        language,
      });
    }

    const effectiveQuery = query || DEFAULT_MARKETPLACE_QUERY;
    const skills = await runtime.searchSkillsFromClawHub({
      query: effectiveQuery,
      limit: normalizeLimit(params.limit),
      baseUrl: resolveMarketplaceSearchBaseUrl(),
      fetchImpl: buildLocalizedFetch(language),
    });
    const results = skills
      .map((skill) => mapSkillResult(skill, language))
      .filter((skill): skill is MarketplaceSkillResult => skill !== null);
    return {
      results,
      total: results.length,
      loaded: results.length,
      totalKnown: true,
      source: 'clawhub',
      query,
      sort,
      dir,
      hasMore: false,
      nextCursor: '',
    };
  }

  async install(params: MarketplaceInstallParams): Promise<void> {
    const slug = stringValue(params.slug);
    if (!slug) {
      throw new Error('Marketplace install requires a skill slug');
    }

    const runtime = await loadRuntimeModule();
    const language = await resolveMarketplaceLanguage();
    const version = stringValue(params.version);
    const baseUrl = resolveMarketplaceInstallBaseUrl(version);
    logger.info(`[clawhub] Installing marketplace skill "${slug}" from ${baseUrl}`);
    const result = await runtime.installSkillFromClawHub({
      workspaceDir: getOpenClawConfigDir(),
      slug,
      version,
      force: params.force,
      baseUrl,
      logger: {
        info: (message: string) => logger.info(`[clawhub] ${message}`),
      },
    });

    if (result && result.ok === false) {
      throw new Error(normalizeInstallError(result.error || `Failed to install skill "${slug}"`, baseUrl));
    }

    await persistInstalledMarketplaceMetadata({
      workspaceDir: getOpenClawConfigDir(),
      slug,
      baseUrl,
      language,
    }).catch((error) => {
      logger.warn(`[clawhub] Failed to persist localized metadata for "${slug}":`, error);
    });
  }
}

export function createClawHubMarketplaceExtension(): Extension {
  return new ClawHubMarketplaceExtension();
}
