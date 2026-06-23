/**
 * Skills State Store
 * Manages skill/plugin state
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { AppError, normalizeAppError } from '@/lib/error-model';
import i18n from '@/i18n';
import { useGatewayStore } from './gateway';
import type { Skill, MarketplaceCatalogMeta, MarketplaceSkill } from '../types/skill';

type GatewaySkillStatus = {
  skillKey: string;
  slug?: string;
  name?: string;
  description?: string;
  disabled?: boolean;
  emoji?: string;
  version?: string;
  author?: string;
  config?: Record<string, unknown>;
  bundled?: boolean;
  always?: boolean;
  source?: string;
  baseDir?: string;
  filePath?: string;
};

type GatewaySkillsStatusResult = {
  skills?: GatewaySkillStatus[];
};

type LocalSkillsResult = {
  success: boolean;
  skills?: Skill[];
  error?: string;
};

const VALID_MARKETPLACE_SKILL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const BUNDLED_OPENCLAW_SKILL_ALLOWLIST = new Set([
  'diagram-maker',
  'healthcheck',
  'meme-maker',
  'session-logs',
  'skill-creator',
  'spike',
  'summarize',
  'taskflow',
  'taskflow-inbox-triage',
  'video-frames',
  'weather',
]);
const GATEWAY_ONLY_APPENDABLE_SOURCES = new Set(['openclaw-plugin', 'openclaw-extra']);
const MARKETPLACE_HOME_SEARCH_LIMIT = 100;
const MARKETPLACE_QUERY_SEARCH_LIMIT = 80;
const MARKETPLACE_CATEGORY_QUERY_LIMIT = 24;
const MARKETPLACE_LOAD_MORE_LIMIT = 100;
const DEFAULT_MARKETPLACE_PROVIDER = 'skillhub';
const SKILLS_FETCH_TTL_MS = 15_000;
const MARKETPLACE_SEARCH_CACHE_TTL_MS = 60_000;

type MarketplaceSearchQuery = string | string[];
type MarketplaceSearchResponse = {
  success: boolean;
  results?: unknown[];
  error?: string;
} & MarketplaceCatalogMeta;

type FetchSkillsOptions = { includeGateway?: boolean; force?: boolean };
type MarketplaceSearchSnapshot = {
  searchResults: MarketplaceSkill[];
  marketplaceMeta: MarketplaceCatalogMeta;
};

let skillsFetchInFlight: Promise<boolean> | null = null;
let skillsGatewayMergeInFlight: Promise<GatewaySkillsStatusResult> | null = null;
let lastSkillsFetchAt = 0;
let lastSkillsGatewayMergeAt = 0;
const marketplaceSearchCache = new Map<string, { createdAt: number; snapshot: MarketplaceSearchSnapshot }>();
const marketplaceSearchInFlight = new Map<string, Promise<MarketplaceSearchSnapshot>>();

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

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function marketplaceSlugValue(value: unknown): string | undefined {
  const slug = stringValue(value);
  if (!slug) return undefined;
  if (slug === 'undefined' || slug === 'null') return undefined;
  return VALID_MARKETPLACE_SKILL_SLUG_RE.test(slug) ? slug : undefined;
}

function normalizeMarketplaceSkillResult(value: unknown): MarketplaceSkill | null {
  const entry = recordValue(value);
  if (!entry) return null;

  const metaContent = recordValue(entry.metaContent);
  const owner = recordValue(entry.owner);
  const latest = recordValue(metaContent?.latest);
  const subCategories = Array.isArray(entry.subCategories)
    ? entry.subCategories
      .map((item) => recordValue(item))
      .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  const slug = marketplaceSlugValue(entry.slug)
    ?? marketplaceSlugValue(entry.skillSlug)
    ?? marketplaceSlugValue(entry.id)
    ?? marketplaceSlugValue(metaContent?.slug)
    ?? marketplaceSlugValue(metaContent?.Slug)
    ?? marketplaceSlugValue(entry.name);

  if (!slug) return null;

  return {
    slug,
    name: stringValue(entry.name)
      ?? stringValue(entry.displayName)
      ?? stringValue(metaContent?.displayName)
      ?? stringValue(metaContent?.DisplayName)
      ?? slug,
    description: stringValue(entry.description)
      ?? stringValue(entry.description_zh)
      ?? stringValue(entry.summary)
      ?? stringValue(metaContent?.DisplayDescription)
      ?? stringValue(metaContent?.displayDescription)
      ?? stringValue(metaContent?.summary)
      ?? stringValue(metaContent?.Summary)
      ?? '',
    version: stringValue(entry.version)
      ?? stringValue(latest?.version)
      ?? '',
    provider: stringValue(entry.provider),
    source: stringValue(entry.source),
    sourceUrl: stringValue(entry.sourceUrl)
      ?? stringValue(entry.homepage)
      ?? stringValue(entry.upstream_url),
    iconUrl: stringValue(entry.iconUrl),
    category: stringValue(entry.category),
    author: stringValue(entry.author)
      ?? stringValue(entry.ownerHandle)
      ?? stringValue(entry.ownerName)
      ?? stringValue(owner?.displayName)
      ?? stringValue(owner?.handle)
      ?? stringValue(metaContent?.owner),
    downloads: numberValue(entry.downloads),
    stars: numberValue(entry.stars),
    keywords: stringArrayValue(entry.keywords)
      ?? stringArrayValue(metaContent?.Keywords)
      ?? stringArrayValue(metaContent?.keywords)
      ?? [
        stringValue(entry.category),
        ...subCategories.flatMap((item) => [stringValue(item.key), stringValue(item.name)]),
      ].filter((item): item is string => Boolean(item)),
  };
}

function normalizeMarketplaceSkillResults(values?: unknown[]): MarketplaceSkill[] {
  if (!Array.isArray(values)) return [];
  return values
    .map(normalizeMarketplaceSkillResult)
    .filter((skill): skill is MarketplaceSkill => skill !== null);
}

function mergeMarketplaceSkillResults(groups: MarketplaceSkill[][]): MarketplaceSkill[] {
  const merged: MarketplaceSkill[] = [];
  const known = new Set<string>();
  for (const group of groups) {
    for (const skill of group) {
      if (known.has(skill.slug)) continue;
      known.add(skill.slug);
      merged.push(skill);
    }
  }
  return merged;
}

function firstNumberValue(values: Array<unknown>): number | undefined {
  for (const value of values) {
    const number = numberValue(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

function firstStringValue(values: Array<unknown>): string | undefined {
  for (const value of values) {
    const text = stringValue(value);
    if (text !== undefined) return text;
  }
  return undefined;
}

function buildMarketplaceMetaFromResult(
  result: MarketplaceSearchResponse,
  query: string,
  searchResults: MarketplaceSkill[],
): MarketplaceCatalogMeta {
  return {
    total: numberValue(result.total),
    loaded: numberValue(result.loaded) ?? searchResults.length,
    totalKnown: Boolean(result.totalKnown),
    catalogTotal: numberValue(result.catalogTotal),
    catalogTotalKnown: Boolean(result.catalogTotalKnown),
    source: stringValue(result.source),
    query: stringValue(result.query) ?? query,
    sort: stringValue(result.sort),
    dir: stringValue(result.dir),
    hasMore: Boolean(result.hasMore),
    nextCursor: stringValue(result.nextCursor),
  };
}

function buildMarketplaceMetaFromAggregatedResults(
  results: MarketplaceSearchResponse[],
  queries: string[],
  searchResults: MarketplaceSkill[],
): MarketplaceCatalogMeta {
  return {
    total: searchResults.length,
    loaded: searchResults.length,
    totalKnown: true,
    catalogTotal: firstNumberValue(results.map((result) => result.catalogTotal)),
    catalogTotalKnown: results.some((result) => result.catalogTotalKnown === true),
    source: firstStringValue(results.map((result) => result.source)),
    query: queries.join(' | '),
    sort: firstStringValue(results.map((result) => result.sort)),
    dir: firstStringValue(results.map((result) => result.dir)),
    hasMore: false,
    nextCursor: '',
  };
}

function mapErrorCodeToSkillErrorKey(
  code: AppError['code'],
  operation: 'fetch' | 'search' | 'install',
): string | null {
  if (code === 'TIMEOUT') {
    return operation === 'search'
      ? 'searchTimeoutError'
      : operation === 'install'
        ? 'installTimeoutError'
        : 'fetchTimeoutError';
  }
  if (code === 'RATE_LIMIT') {
    return operation === 'search'
      ? 'searchRateLimitError'
      : operation === 'install'
        ? 'installRateLimitError'
        : 'fetchRateLimitError';
  }
  return null;
}

function normalizeSkillKey(value?: string): string {
  return (value || '').trim().toLowerCase();
}

function normalizeSkillPath(value?: string): string {
  return (value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isAllowedBundledGatewaySkill(status: GatewaySkillStatus): boolean {
  if (!status.bundled) return true;

  const aliases = [status.skillKey, status.slug]
    .map((value) => normalizeSkillKey(value))
    .filter(Boolean);

  return aliases.some((alias) => BUNDLED_OPENCLAW_SKILL_ALLOWLIST.has(alias));
}

function shouldAppendGatewayOnlySkill(status: GatewaySkillStatus): boolean {
  return GATEWAY_ONLY_APPENDABLE_SOURCES.has((status.source || '').trim().toLowerCase());
}

function shouldPreserveLocalMarketplacePresentation(existing?: Skill): boolean {
  return existing?.source === 'openclaw-managed' && existing.marketplace?.provider === 'clawhub';
}

function mapGatewaySkillToSkill(status: GatewaySkillStatus, existing?: Skill): Skill {
  const preserveLocalPresentation = shouldPreserveLocalMarketplacePresentation(existing);
  return {
    id: status.skillKey,
    slug: status.slug || existing?.slug || status.skillKey,
    name: preserveLocalPresentation
      ? (existing?.name || status.name || status.skillKey)
      : (status.name || existing?.name || status.skillKey),
    description: preserveLocalPresentation
      ? (existing?.description || status.description || '')
      : (status.description || existing?.description || ''),
    enabled: !status.disabled,
    icon: status.emoji || existing?.icon || '📦',
    version: status.version || existing?.version,
    author: status.author || existing?.author,
    config: {
      ...(existing?.config || {}),
      ...(status.config || {}),
    },
    isCore: Boolean((status.bundled && status.always) || existing?.isCore),
    isBundled: status.bundled ?? existing?.isBundled,
    source: status.source || existing?.source,
    baseDir: status.baseDir || existing?.baseDir,
    filePath: status.filePath || existing?.filePath,
    marketplace: existing?.marketplace,
    uninstallable: existing?.uninstallable,
  };
}

function mergeGatewaySkills(localSkills: Skill[], gatewaySkills?: GatewaySkillStatus[]): Skill[] {
  if (!gatewaySkills || gatewaySkills.length === 0) {
    return localSkills;
  }

  const merged = [...localSkills];
  const index = new Map<string, number>();

  localSkills.forEach((skill, position) => {
    const aliases = new Set([
      normalizeSkillKey(skill.id),
      normalizeSkillKey(skill.slug),
      normalizeSkillKey(skill.name),
      normalizeSkillPath(skill.baseDir),
    ].filter(Boolean));
    aliases.forEach((alias) => index.set(alias, position));
  });

  for (const gatewaySkill of gatewaySkills) {
    if (!isAllowedBundledGatewaySkill(gatewaySkill)) {
      continue;
    }
    const aliases = [
      normalizeSkillKey(gatewaySkill.skillKey),
      normalizeSkillKey(gatewaySkill.slug),
      normalizeSkillKey(gatewaySkill.name),
      normalizeSkillPath(gatewaySkill.baseDir),
    ].filter(Boolean);
    const existingIndex = aliases.map((alias) => index.get(alias)).find((value): value is number => value !== undefined);

    if (existingIndex !== undefined) {
      const nextSkill = mapGatewaySkillToSkill(gatewaySkill, merged[existingIndex]);
      merged[existingIndex] = nextSkill;
      const nextAliases = new Set([
        ...aliases,
        normalizeSkillKey(nextSkill.id),
        normalizeSkillKey(nextSkill.slug),
        normalizeSkillKey(nextSkill.name),
        normalizeSkillPath(nextSkill.baseDir),
      ].filter(Boolean));
      nextAliases.forEach((alias) => index.set(alias, existingIndex));
      continue;
    }

    if (!shouldAppendGatewayOnlySkill(gatewaySkill)) {
      continue;
    }

    const nextSkill = mapGatewaySkillToSkill(gatewaySkill);
    const nextIndex = merged.push(nextSkill) - 1;
    [
      normalizeSkillKey(nextSkill.id),
      normalizeSkillKey(nextSkill.slug),
      normalizeSkillKey(nextSkill.name),
      normalizeSkillPath(nextSkill.baseDir),
    ].filter(Boolean).forEach((alias) => index.set(alias, nextIndex));
  }

  return merged.sort((a, b) => {
    if (a.enabled && !b.enabled) return -1;
    if (!a.enabled && b.enabled) return 1;
    if (a.isCore && !b.isCore) return -1;
    if (!a.isCore && b.isCore) return 1;
    return a.name.localeCompare(b.name);
  });
}

function getMarketplaceSearchCacheKey(query: MarketplaceSearchQuery): string {
  const entries = (Array.isArray(query) ? query : [query])
    .map((entry) => entry.trim())
    .filter((entry, index, all) => entry.length > 0 || (all.length === 1 && index === 0))
    .filter((entry, index, all) => all.indexOf(entry) === index);
  return JSON.stringify({ provider: DEFAULT_MARKETPLACE_PROVIDER, locale: i18n.language, queries: entries });
}

function getCachedMarketplaceSearch(query: MarketplaceSearchQuery): MarketplaceSearchSnapshot | null {
  const cached = marketplaceSearchCache.get(getMarketplaceSearchCacheKey(query));
  if (!cached) return null;
  if (Date.now() - cached.createdAt >= MARKETPLACE_SEARCH_CACHE_TTL_MS) {
    return null;
  }
  return cached.snapshot;
}

function cacheMarketplaceSearch(query: MarketplaceSearchQuery, snapshot: MarketplaceSearchSnapshot): void {
  marketplaceSearchCache.set(getMarketplaceSearchCacheKey(query), {
    createdAt: Date.now(),
    snapshot,
  });
}

function fetchGatewaySkillsStatus(): Promise<GatewaySkillsStatusResult> {
  if (!skillsGatewayMergeInFlight) {
    const promise = useGatewayStore.getState().rpc<GatewaySkillsStatusResult>('skills.status');
    skillsGatewayMergeInFlight = promise;
    promise
      .finally(() => {
        if (skillsGatewayMergeInFlight === promise) {
          skillsGatewayMergeInFlight = null;
        }
      })
      .catch(() => {
        // The caller handles the failure; this catch only prevents the cleanup
        // chain from surfacing as an unhandled rejection.
      });
  }
  return skillsGatewayMergeInFlight;
}

async function fetchMarketplaceSearchSnapshot(query: MarketplaceSearchQuery): Promise<MarketplaceSearchSnapshot> {
  const normalizedQueries = (Array.isArray(query) ? query : [query])
    .map((entry) => entry.trim())
    .filter((entry, index, entries) => entry.length > 0 || (entries.length === 1 && index === 0))
    .filter((entry, index, entries) => entries.indexOf(entry) === index);

  if (normalizedQueries.length > 1) {
    const results = await Promise.all(normalizedQueries.map((normalizedQuery) => (
      hostApiFetch<MarketplaceSearchResponse>('/api/skills/marketplace/search', {
        method: 'POST',
        body: JSON.stringify({
          provider: DEFAULT_MARKETPLACE_PROVIDER,
          query: normalizedQuery,
          limit: MARKETPLACE_CATEGORY_QUERY_LIMIT,
          locale: i18n.language,
        }),
      })
    )));
    const failed = results.find((result) => !result.success);
    if (failed) {
      throw normalizeAppError(new Error(failed.error || 'Search failed'), {
        module: 'skills',
        operation: 'search',
      });
    }
    const searchResults = mergeMarketplaceSkillResults(results.map((result) => normalizeMarketplaceSkillResults(result.results)));
    return {
      searchResults,
      marketplaceMeta: buildMarketplaceMetaFromAggregatedResults(results, normalizedQueries, searchResults),
    };
  }

  const normalizedQuery = normalizedQueries[0] ?? '';
  const result = await hostApiFetch<MarketplaceSearchResponse>('/api/skills/marketplace/search', {
    method: 'POST',
    body: JSON.stringify({
      provider: DEFAULT_MARKETPLACE_PROVIDER,
      query: normalizedQuery,
      limit: normalizedQuery.length === 0 ? MARKETPLACE_HOME_SEARCH_LIMIT : MARKETPLACE_QUERY_SEARCH_LIMIT,
      locale: i18n.language,
    }),
  });
  if (!result.success) {
    throw normalizeAppError(new Error(result.error || 'Search failed'), {
      module: 'skills',
      operation: 'search',
    });
  }
  const searchResults = normalizeMarketplaceSkillResults(result.results);
  return {
    searchResults,
    marketplaceMeta: buildMarketplaceMetaFromResult(result, normalizedQuery, searchResults),
  };
}

interface SkillsState {
  skills: Skill[];
  searchResults: MarketplaceSkill[];
  marketplaceMeta: MarketplaceCatalogMeta;
  loading: boolean;
  searching: boolean;
  searchError: string | null;
  installing: Record<string, boolean>;
  error: string | null;

  fetchSkills: (options?: FetchSkillsOptions) => Promise<boolean>;
  searchSkills: (query: MarketplaceSearchQuery) => Promise<void>;
  loadMoreMarketplaceSkills: () => Promise<void>;
  installSkill: (slug: string, version?: string) => Promise<void>;
  uninstallSkill: (slug: string) => Promise<void>;
  enableSkill: (skillId: string) => Promise<void>;
  disableSkill: (skillId: string) => Promise<void>;
  setSkillsEnabled: (skillIds: string[], enabled: boolean) => Promise<void>;
  setSkills: (skills: Skill[]) => void;
  updateSkill: (skillId: string, updates: Partial<Skill>) => void;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  searchResults: [],
  marketplaceMeta: {},
  loading: false,
  searching: false,
  searchError: null,
  installing: {},
  error: null,

  fetchSkills: async (options?: FetchSkillsOptions) => {
    const includeGateway = options?.includeGateway === true;
    const hasSkills = get().skills.length > 0;
    const now = Date.now();
    const canUseCachedLocal = !options?.force && hasSkills && now - lastSkillsFetchAt < SKILLS_FETCH_TTL_MS;
    const canUseCachedGateway = !includeGateway || (!options?.force && now - lastSkillsGatewayMergeAt < SKILLS_FETCH_TTL_MS);

    if (canUseCachedLocal && canUseCachedGateway) {
      return true;
    }

    if (skillsFetchInFlight) {
      return await skillsFetchInFlight;
    }

    if (!hasSkills) {
      set({ loading: true, error: null });
    } else {
      set({ error: null });
    }

    skillsFetchInFlight = (async () => {
      const gatewayDataPromise = includeGateway && !canUseCachedGateway
        ? fetchGatewaySkillsStatus()
        : null;

      try {
        let localSkills = get().skills;
        if (!canUseCachedLocal) {
          const localResult = await hostApiFetch<LocalSkillsResult>('/api/skills/local');
          if (!localResult.success) {
            throw new Error(localResult.error || 'Failed to fetch local skills');
          }

          localSkills = Array.isArray(localResult.skills) ? localResult.skills : [];
          lastSkillsFetchAt = Date.now();
          set({ skills: localSkills, loading: false, error: null });
        }

        if (gatewayDataPromise) {
          void gatewayDataPromise
            .then((gatewayData) => {
              lastSkillsGatewayMergeAt = Date.now();
              set((state) => ({
                skills: mergeGatewaySkills(state.skills, gatewayData.skills),
                loading: false,
              }));
            })
            .catch(() => {
              // Local data is already rendered; runtime merge is best-effort only.
            });
        } else {
          set({ loading: false, error: null });
        }

        return true;
      }
      catch (error) {
        console.error('Failed to fetch local skills:', error);
        if (!gatewayDataPromise) {
          const appError = normalizeAppError(error, { module: 'skills', operation: 'fetch' });
          const errorKey = mapErrorCodeToSkillErrorKey(appError.code, 'fetch');
          set((prev) => ({ loading: false, error: errorKey ?? appError.message, skills: prev.skills }));
          return false;
        }
        try {
          const gatewayData = await gatewayDataPromise;
          lastSkillsGatewayMergeAt = Date.now();
          const gatewaySkills = mergeGatewaySkills([], gatewayData.skills);
          set({ skills: gatewaySkills, loading: false, error: null });
          return true;
        } catch (gatewayError) {
          console.error('Failed to fetch gateway skills fallback:', gatewayError);
          const appError = normalizeAppError(error, { module: 'skills', operation: 'fetch' });
          const errorKey = mapErrorCodeToSkillErrorKey(appError.code, 'fetch');
          set((prev) => ({ loading: false, error: errorKey ?? appError.message, skills: prev.skills }));
          return false;
        }
      }
    })().finally(() => {
      skillsFetchInFlight = null;
    });

    return await skillsFetchInFlight;
  },

  searchSkills: async (query: MarketplaceSearchQuery) => {
    const cacheKey = getMarketplaceSearchCacheKey(query);
    const cached = getCachedMarketplaceSearch(query);
    if (cached) {
      set({ ...cached, searching: false, searchError: null });
      return;
    }

    set({ searching: true, searchError: null });
    try {
      let searchPromise = marketplaceSearchInFlight.get(cacheKey);
      if (!searchPromise) {
        searchPromise = fetchMarketplaceSearchSnapshot(query);
        marketplaceSearchInFlight.set(cacheKey, searchPromise);
      }
      const snapshot = await searchPromise;
      cacheMarketplaceSearch(query, snapshot);
      set({ ...snapshot, searchError: null });
    } catch (error) {
      const appError = normalizeAppError(error, { module: 'skills', operation: 'search' });
      const errorKey = mapErrorCodeToSkillErrorKey(appError.code, 'search');
      set({ searchError: errorKey ?? appError.message });
    } finally {
      marketplaceSearchInFlight.delete(cacheKey);
      set({ searching: false });
    }
  },

  loadMoreMarketplaceSkills: async () => {
    const { marketplaceMeta } = get();
    if (!marketplaceMeta.hasMore || !marketplaceMeta.nextCursor) return;
    set({ searching: true, searchError: null });
    try {
      const result = await hostApiFetch<{ success: boolean; results?: unknown[]; error?: string } & MarketplaceCatalogMeta>('/api/skills/marketplace/search', {
        method: 'POST',
        body: JSON.stringify({
          provider: marketplaceMeta.source ?? DEFAULT_MARKETPLACE_PROVIDER,
          query: marketplaceMeta.query ?? '',
          limit: MARKETPLACE_LOAD_MORE_LIMIT,
          locale: i18n.language,
          cursor: marketplaceMeta.nextCursor,
          sort: marketplaceMeta.sort,
          dir: marketplaceMeta.dir,
        }),
      });
      if (!result.success) {
        throw normalizeAppError(new Error(result.error || 'Search failed'), {
          module: 'skills',
          operation: 'search',
        });
      }

      const nextResults = normalizeMarketplaceSkillResults(result.results);
      set((state) => {
        const merged = [...state.searchResults];
        const known = new Set(merged.map((skill) => skill.slug));
        for (const skill of nextResults) {
          if (known.has(skill.slug)) continue;
          known.add(skill.slug);
          merged.push(skill);
        }
        return {
          searchResults: merged,
          marketplaceMeta: {
            total: numberValue(result.total) ?? state.marketplaceMeta.total,
            loaded: merged.length,
            totalKnown: result.totalKnown === undefined ? state.marketplaceMeta.totalKnown : Boolean(result.totalKnown),
            catalogTotal: numberValue(result.catalogTotal) ?? state.marketplaceMeta.catalogTotal,
            catalogTotalKnown: result.catalogTotalKnown === undefined ? state.marketplaceMeta.catalogTotalKnown : Boolean(result.catalogTotalKnown),
            source: stringValue(result.source) ?? state.marketplaceMeta.source,
            query: stringValue(result.query) ?? state.marketplaceMeta.query,
            sort: stringValue(result.sort) ?? state.marketplaceMeta.sort,
            dir: stringValue(result.dir) ?? state.marketplaceMeta.dir,
            hasMore: Boolean(result.hasMore),
            nextCursor: stringValue(result.nextCursor),
          },
        };
      });
    } catch (error) {
      const appError = normalizeAppError(error, { module: 'skills', operation: 'search' });
      const errorKey = mapErrorCodeToSkillErrorKey(appError.code, 'search');
      set({ searchError: errorKey ?? appError.message });
    } finally {
      set({ searching: false });
    }
  },

  installSkill: async (slug: string, version?: string) => {
    set((state) => ({ installing: { ...state.installing, [slug]: true } }));
    try {
      const marketplaceSkill = get().searchResults.find((skill) => skill.slug === slug);
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/skills/marketplace/install', {
        method: 'POST',
        body: JSON.stringify({
          slug,
          version,
          provider: marketplaceSkill?.provider,
        }),
      });
      if (!result.success) {
        const appError = normalizeAppError(new Error(result.error || 'Install failed'), {
          module: 'skills',
          operation: 'install',
        });
        const errorKey = mapErrorCodeToSkillErrorKey(appError.code, 'install');
        throw new Error(errorKey ?? appError.message);
      }
      await get().setSkillsEnabled([slug], true);
      await get().fetchSkills({ includeGateway: true, force: true });
    } catch (error) {
      console.error('Install error:', error);
      throw error;
    } finally {
      set((state) => {
        const newInstalling = { ...state.installing };
        delete newInstalling[slug];
        return { installing: newInstalling };
      });
    }
  },

  uninstallSkill: async (slug: string) => {
    set((state) => ({ installing: { ...state.installing, [slug]: true } }));
    try {
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/skills/marketplace/uninstall', {
        method: 'POST',
        body: JSON.stringify({ slug }),
      });
      if (!result.success) {
        throw new Error(result.error || 'Uninstall failed');
      }
      await get().fetchSkills({ includeGateway: true, force: true });
    } catch (error) {
      console.error('Uninstall error:', error);
      throw error;
    } finally {
      set((state) => {
        const newInstalling = { ...state.installing };
        delete newInstalling[slug];
        return { installing: newInstalling };
      });
    }
  },

  setSkillsEnabled: async (skillIds, enabled) => {
    if (skillIds.length === 0) return;

    const { skills, updateSkill } = get();
    if (!enabled) {
      const coreSkill = skills.find((skill) => skillIds.includes(skill.id) && skill.isCore);
      if (coreSkill) {
        throw new Error('Cannot disable core skill');
      }
    }

    const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/skills/configs', {
      method: 'PATCH',
      body: JSON.stringify({
        updates: skillIds.map((skillKey) => ({ skillKey, enabled })),
      }),
    });
    if (!result.success) {
      throw new Error(result.error || 'Failed to update skill config');
    }

    skillIds.forEach((skillId) => updateSkill(skillId, { enabled }));
  },

  enableSkill: async (skillId) => {
    try {
      await get().setSkillsEnabled([skillId], true);
    } catch (error) {
      console.error('Failed to enable skill:', error);
      throw error;
    }
  },

  disableSkill: async (skillId) => {
    try {
      await get().setSkillsEnabled([skillId], false);
    } catch (error) {
      console.error('Failed to disable skill:', error);
      throw error;
    }
  },

  setSkills: (skills) => set({ skills }),

  updateSkill: (skillId, updates) => {
    set((state) => ({
      skills: state.skills.map((skill) =>
        skill.id === skillId ? { ...skill, ...updates } : skill,
      ),
    }));
  },
}));
