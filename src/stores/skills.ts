/**
 * Skills State Store
 * Manages skill/plugin state
 */
import { create } from 'zustand';
import { hostApi } from '@/lib/host-api';
import type { SkillsStatusResult } from '@/lib/host-api';
import { AppError, normalizeAppError } from '@/lib/error-model';
import i18n from '@/i18n';
import type { Skill, MarketplaceCatalogMeta, MarketplaceSkill } from '../types/skill';

type GatewaySkillStatus = NonNullable<SkillsStatusResult['skills']>[number];

const BUNDLED_OPENCLAW_SKILL_ALLOWLIST = new Set(['skill-creator']);
const GATEWAY_ONLY_APPENDABLE_SOURCES = new Set(['openclaw-plugin', 'openclaw-extra']);
const VALID_MARKETPLACE_SKILL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MARKETPLACE_HOME_SEARCH_LIMIT = 100;
const MARKETPLACE_QUERY_SEARCH_LIMIT = 80;
const MARKETPLACE_CATEGORY_QUERY_LIMIT = 24;
const MARKETPLACE_LOAD_MORE_LIMIT = 100;
const DEFAULT_MARKETPLACE_PROVIDER = 'skillhub';
const SKILLS_FETCH_TTL_MS = 15_000;
const MARKETPLACE_SEARCH_CACHE_TTL_MS = 60_000;
const MARKETPLACE_SEARCH_CACHE_MAX_ENTRIES = 30;

type MarketplaceSearchQuery = string | string[];
type MarketplaceSearchResponse = Awaited<ReturnType<typeof hostApi.skills.marketplaceSearch>>;
type FetchSkillsOptions = { includeGateway?: boolean; force?: boolean };
type MarketplaceSearchSnapshot = {
  searchResults: MarketplaceSkill[];
  marketplaceMeta: MarketplaceCatalogMeta;
};

let skillsFetchInFlight: Promise<boolean> | null = null;
let skillsGatewayMergeInFlight: Promise<SkillsStatusResult> | null = null;
let lastSkillsFetchAt = 0;
let lastSkillsGatewayMergeAt = 0;
let marketplaceSearchRequestId = 0;
const marketplaceSearchCache = new Map<string, { createdAt: number; snapshot: MarketplaceSearchSnapshot }>();
const marketplaceSearchInFlight = new Map<string, Promise<MarketplaceSearchSnapshot>>();

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(stringValue).filter((entry): entry is string => Boolean(entry));
  return values.length > 0 ? values : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function marketplaceSlugValue(value: unknown): string | undefined {
  const slug = stringValue(value);
  if (!slug || slug === 'undefined' || slug === 'null') return undefined;
  return VALID_MARKETPLACE_SKILL_SLUG_RE.test(slug) ? slug : undefined;
}

function normalizeMarketplaceSkillResult(value: unknown): MarketplaceSkill | null {
  const entry = recordValue(value);
  if (!entry) return null;

  const metaContent = recordValue(entry.metaContent);
  const owner = recordValue(entry.owner);
  const latest = recordValue(metaContent?.latest);
  const subCategories = Array.isArray(entry.subCategories)
    ? entry.subCategories.map(recordValue).filter((item): item is Record<string, unknown> => Boolean(item))
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
      ?? '',
    version: stringValue(entry.version) ?? stringValue(latest?.version) ?? '',
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
      ?? stringValue(owner?.handle),
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
      const key = `${skill.provider || DEFAULT_MARKETPLACE_PROVIDER}:${skill.slug}`;
      if (known.has(key)) continue;
      known.add(key);
      merged.push(skill);
    }
  }
  return merged;
}

function buildMarketplaceMeta(
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
    source: stringValue(result.source) ?? DEFAULT_MARKETPLACE_PROVIDER,
    query: stringValue(result.query) ?? query,
    sort: stringValue(result.sort),
    dir: stringValue(result.dir),
    hasMore: Boolean(result.hasMore),
    nextCursor: stringValue(result.nextCursor),
  };
}

function normalizedMarketplaceQueries(query: MarketplaceSearchQuery): string[] {
  return (Array.isArray(query) ? query : [query])
    .map((entry) => entry.trim())
    .filter((entry, index, entries) => entry.length > 0 || (entries.length === 1 && index === 0))
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
}

function marketplaceSearchCacheKey(query: MarketplaceSearchQuery): string {
  return JSON.stringify({
    provider: DEFAULT_MARKETPLACE_PROVIDER,
    locale: i18n.language,
    queries: normalizedMarketplaceQueries(query),
  });
}

function cachedMarketplaceSearch(query: MarketplaceSearchQuery): MarketplaceSearchSnapshot | null {
  const key = marketplaceSearchCacheKey(query);
  const cached = marketplaceSearchCache.get(key);
  if (!cached || Date.now() - cached.createdAt >= MARKETPLACE_SEARCH_CACHE_TTL_MS) {
    marketplaceSearchCache.delete(key);
    return null;
  }
  marketplaceSearchCache.delete(key);
  marketplaceSearchCache.set(key, cached);
  return cached.snapshot;
}

function cacheMarketplaceSearch(query: MarketplaceSearchQuery, snapshot: MarketplaceSearchSnapshot): void {
  const key = marketplaceSearchCacheKey(query);
  marketplaceSearchCache.delete(key);
  marketplaceSearchCache.set(key, { createdAt: Date.now(), snapshot });
  while (marketplaceSearchCache.size > MARKETPLACE_SEARCH_CACHE_MAX_ENTRIES) {
    const oldestKey = marketplaceSearchCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    marketplaceSearchCache.delete(oldestKey);
  }
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

function mapGatewaySkillToSkill(status: GatewaySkillStatus, existing?: Skill): Skill {
  const preserveLocalPresentation = existing?.source === 'openclaw-managed'
    && Boolean(existing.marketplace?.provider);
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
    uninstallable: existing?.uninstallable,
    marketplace: existing?.marketplace,
  };
}

function fetchGatewaySkillsStatus(): Promise<SkillsStatusResult> {
  if (!skillsGatewayMergeInFlight) {
    const promise = hostApi.skills.status();
    skillsGatewayMergeInFlight = promise;
    promise
      .finally(() => {
        if (skillsGatewayMergeInFlight === promise) skillsGatewayMergeInFlight = null;
      })
      .catch(() => {
        // The caller handles the failure; this prevents an unhandled cleanup chain.
      });
  }
  return skillsGatewayMergeInFlight;
}

async function fetchMarketplaceSearchSnapshot(query: MarketplaceSearchQuery): Promise<MarketplaceSearchSnapshot> {
  const queries = normalizedMarketplaceQueries(query);
  if (queries.length > 1) {
    const responses = await Promise.all(queries.map((entry) => hostApi.skills.marketplaceSearch({
      provider: DEFAULT_MARKETPLACE_PROVIDER,
      query: entry,
      limit: MARKETPLACE_CATEGORY_QUERY_LIMIT,
      locale: i18n.language,
    })));
    const failed = responses.find((result) => !result.success);
    if (failed) {
      throw new Error(failed.error || 'Search failed');
    }
    const searchResults = mergeMarketplaceSkillResults(
      responses.map((result) => normalizeMarketplaceSkillResults(result.results)),
    );
    return {
      searchResults,
      marketplaceMeta: {
        total: searchResults.length,
        loaded: searchResults.length,
        totalKnown: true,
        catalogTotal: responses.map((result) => numberValue(result.catalogTotal)).find((value) => value !== undefined),
        catalogTotalKnown: responses.some((result) => result.catalogTotalKnown === true),
        source: responses.map((result) => stringValue(result.source)).find((value) => value !== undefined)
          ?? DEFAULT_MARKETPLACE_PROVIDER,
        query: queries.join(' | '),
        sort: responses.map((result) => stringValue(result.sort)).find((value) => value !== undefined),
        dir: responses.map((result) => stringValue(result.dir)).find((value) => value !== undefined),
        hasMore: false,
        nextCursor: '',
      },
    };
  }

  const normalizedQuery = queries[0] ?? '';
  const result = await hostApi.skills.marketplaceSearch({
    provider: DEFAULT_MARKETPLACE_PROVIDER,
    query: normalizedQuery,
    limit: normalizedQuery ? MARKETPLACE_QUERY_SEARCH_LIMIT : MARKETPLACE_HOME_SEARCH_LIMIT,
    locale: i18n.language,
  });
  if (!result.success) throw new Error(result.error || 'Search failed');
  const searchResults = normalizeMarketplaceSkillResults(result.results);
  return {
    searchResults,
    marketplaceMeta: buildMarketplaceMeta(result, normalizedQuery, searchResults),
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

  fetchSkills: async (options) => {
    const includeGateway = options?.includeGateway !== false;
    const hasSkills = get().skills.length > 0;
    const now = Date.now();
    const useCachedLocal = !options?.force && hasSkills && now - lastSkillsFetchAt < SKILLS_FETCH_TTL_MS;
    const useCachedGateway = !includeGateway
      || (!options?.force && now - lastSkillsGatewayMergeAt < SKILLS_FETCH_TTL_MS);
    if (useCachedLocal && useCachedGateway) return true;
    if (skillsFetchInFlight) return await skillsFetchInFlight;

    set(hasSkills ? { error: null } : { loading: true, error: null });
    skillsFetchInFlight = (async () => {
      const gatewayPromise = includeGateway && !useCachedGateway
        ? fetchGatewaySkillsStatus()
        : null;
      try {
        if (!useCachedLocal) {
          const localResult = await hostApi.skills.local();
          if (!localResult.success) throw new Error(localResult.error || 'Failed to fetch local skills');
          lastSkillsFetchAt = Date.now();
          set({
            skills: Array.isArray(localResult.skills) ? localResult.skills : [],
            loading: false,
            error: null,
          });
        }

        if (gatewayPromise) {
          void gatewayPromise
            .then((gatewayData) => {
              lastSkillsGatewayMergeAt = Date.now();
              set((state) => ({
                skills: mergeGatewaySkills(state.skills, gatewayData.skills),
                loading: false,
              }));
            })
            .catch(() => {
              // Local skills remain usable while Gateway runtime state is unavailable.
            });
        } else {
          set({ loading: false, error: null });
        }
        return true;
      } catch (error) {
        console.error('Failed to fetch local skills:', error);
        if (gatewayPromise) {
          try {
            const gatewayData = await gatewayPromise;
            lastSkillsGatewayMergeAt = Date.now();
            set({ skills: mergeGatewaySkills([], gatewayData.skills), loading: false, error: null });
            return true;
          } catch (gatewayError) {
            console.error('Failed to fetch gateway skills fallback:', gatewayError);
          }
        }
        const appError = normalizeAppError(error, { module: 'skills', operation: 'fetch' });
        const errorKey = mapErrorCodeToSkillErrorKey(appError.code, 'fetch');
        set((state) => ({ loading: false, error: errorKey ?? appError.message, skills: state.skills }));
        return false;
      }
    })().finally(() => {
      skillsFetchInFlight = null;
    });
    return await skillsFetchInFlight;
  },

  searchSkills: async (query) => {
    const requestId = ++marketplaceSearchRequestId;
    const cached = cachedMarketplaceSearch(query);
    if (cached) {
      set({ ...cached, searching: false, searchError: null });
      return;
    }

    const cacheKey = marketplaceSearchCacheKey(query);
    set({ searching: true, searchError: null });
    try {
      let searchPromise = marketplaceSearchInFlight.get(cacheKey);
      if (!searchPromise) {
        searchPromise = fetchMarketplaceSearchSnapshot(query);
        marketplaceSearchInFlight.set(cacheKey, searchPromise);
      }
      const snapshot = await searchPromise;
      cacheMarketplaceSearch(query, snapshot);
      if (requestId === marketplaceSearchRequestId) set({ ...snapshot, searchError: null });
    } catch (error) {
      const appError = normalizeAppError(error, { module: 'skills', operation: 'search' });
      const errorKey = mapErrorCodeToSkillErrorKey(appError.code, 'search');
      if (requestId === marketplaceSearchRequestId) set({ searchError: errorKey ?? appError.message });
    } finally {
      marketplaceSearchInFlight.delete(cacheKey);
      if (requestId === marketplaceSearchRequestId) set({ searching: false });
    }
  },

  loadMoreMarketplaceSkills: async () => {
    const { marketplaceMeta } = get();
    if (!marketplaceMeta.hasMore || !marketplaceMeta.nextCursor || get().searching) return;
    const requestId = ++marketplaceSearchRequestId;
    set({ searching: true, searchError: null });
    try {
      const result = await hostApi.skills.marketplaceSearch({
        provider: marketplaceMeta.source || DEFAULT_MARKETPLACE_PROVIDER,
        query: marketplaceMeta.query || '',
        limit: MARKETPLACE_LOAD_MORE_LIMIT,
        locale: i18n.language,
        cursor: marketplaceMeta.nextCursor,
        sort: marketplaceMeta.sort,
        dir: marketplaceMeta.dir,
      });
      if (!result.success) throw new Error(result.error || 'Search failed');
      const nextResults = normalizeMarketplaceSkillResults(result.results);
      if (requestId !== marketplaceSearchRequestId) return;
      set((state) => {
        const merged = mergeMarketplaceSkillResults([state.searchResults, nextResults]);
        return {
          searchResults: merged,
          marketplaceMeta: {
            total: numberValue(result.total) ?? state.marketplaceMeta.total,
            loaded: merged.length,
            totalKnown: result.totalKnown ?? state.marketplaceMeta.totalKnown,
            catalogTotal: numberValue(result.catalogTotal) ?? state.marketplaceMeta.catalogTotal,
            catalogTotalKnown: result.catalogTotalKnown ?? state.marketplaceMeta.catalogTotalKnown,
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
      if (requestId === marketplaceSearchRequestId) set({ searchError: errorKey ?? appError.message });
    } finally {
      if (requestId === marketplaceSearchRequestId) set({ searching: false });
    }
  },

  installSkill: async (slug: string, version?: string) => {
    set((state) => ({ installing: { ...state.installing, [slug]: true } }));
    try {
      const marketplaceSkill = get().searchResults.find((skill) => skill.slug === slug);
      const result = await hostApi.skills.marketplaceInstall({
        slug,
        version,
        provider: marketplaceSkill?.provider || DEFAULT_MARKETPLACE_PROVIDER,
      });
      if (!result.success) {
        const appError = normalizeAppError(new Error(result.error || 'Install failed'), {
          module: 'skills',
          operation: 'install',
        });
        const errorKey = mapErrorCodeToSkillErrorKey(appError.code, 'install');
        throw new Error(errorKey ?? appError.message);
      }
      await get().fetchSkills({ includeGateway: false, force: true });
      const installedSkill = get().skills.find((skill) => (
        skill.slug === slug || skill.marketplace?.slug === slug
      ));
      if (installedSkill && !installedSkill.enabled) {
        await get().setSkillsEnabled([installedSkill.id], true);
      }
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
      const result = await hostApi.skills.marketplaceUninstall({ slug });
      if (!result.success) {
        throw new Error(result.error || 'Uninstall failed');
      }
      await get().fetchSkills({ includeGateway: false, force: true });
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

    const result = await hostApi.skills.updateConfigs(
      skillIds.map((skillKey) => ({ skillKey, enabled })),
    );
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
