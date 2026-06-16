import { getSetting } from '../../utils/store';
import { resolveSupportedLanguage, type LanguageCode } from '../../../shared/language';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Extension,
  ExtensionContext,
  MarketplaceProviderExtension,
  MarketplaceCapability,
} from '../types';
import type {
  MarketplaceSearchParams,
  MarketplaceInstallParams,
  MarketplaceSkillResult,
} from '../../gateway/clawhub';
import { logger } from '../../utils/logger';
import { getOpenClawConfigDir, getOpenClawResolvedDir } from '../../utils/paths';

type RawClawHubSkill = {
  id?: unknown;
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
  };
  latestVersion?: {
    version?: unknown;
  };
  skill?: {
    slug?: unknown;
    displayName?: unknown;
    name?: unknown;
    summary?: unknown;
    description?: unknown;
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
const DEFAULT_SEARCH_LIMIT = 30;
const MAX_SEARCH_LIMIT = 100;
const OPENCLAW_SKILLS_CLAWHUB_MODULE_RE = /^skills-clawhub(?:-.+)?\.js$/;
const OPENCLAW_SKILLS_STATUS_MODULE_RE = /^status(?:-.+)?\.js$/;
const OPENCLAW_SKILLS_STATUS_EXPORT_MARKERS = [
  'searchSkillsFromClawHub',
  'installSkillFromClawHub',
] as const;
const DEFAULT_CLAWHUB_MIRROR_URL = 'https://mirror-cn.clawhub.com';
const VALID_MARKETPLACE_SKILL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

let runtimeModulePromise: Promise<LoadedRuntime> | null = null;

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
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.max(Math.floor(value), 1), MAX_SEARCH_LIMIT);
}

function resolveMarketplaceBaseUrl(): string {
  return stringValue(process.env.OPENCLAW_CLAWHUB_URL)
    ?? stringValue(process.env.CLAWHUB_URL)
    ?? DEFAULT_CLAWHUB_MIRROR_URL;
}

async function fetchMarketplaceSkillDetail(
  slug: string,
  baseUrl: string,
  language: LanguageCode,
): Promise<{ displayDescription?: string; defaultDescription?: string; displayName?: string } | null> {
  try {
    const url = new URL(`/api/v1/skills/${encodeURIComponent(slug)}`, `${baseUrl.replace(/\/+$/, '')}/`);
    const response = await buildLocalizedFetch(language)(url.toString());
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
  return async (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has('Accept-Language')) {
      headers.set('Accept-Language', acceptLanguageFor(language));
    }
    return await fetch(input, {
      ...init,
      headers,
    });
  };
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
  const statusCandidates = (await Promise.all(entries.map(async (entry) => (
    await isSkillsStatusModule(distDir, entry)
      ? {
          path: join(distDir, entry),
          kind: 'skills-status' as const,
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
    author: stringValue(entry.ownerHandle) ?? stringValue(entry.owner?.displayName) ?? stringValue(entry.owner?.handle),
    downloads: numberValue(entry.downloads),
    stars: numberValue(entry.stars),
    keywords: stringArrayValue(entry.metaContent?.Keywords)
      ?? stringArrayValue(entry.metaContent?.keywords),
  };
}

class ClawHubMarketplaceExtension implements MarketplaceProviderExtension {
  readonly id = 'builtin/clawhub-marketplace';

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

  async search(params: MarketplaceSearchParams): Promise<MarketplaceSkillResult[]> {
    const runtime = await loadRuntimeModule();
    const language = await resolveMarketplaceLanguage(params.locale);
    const query = stringValue(params.query) ?? DEFAULT_MARKETPLACE_QUERY;
    const skills = await runtime.searchSkillsFromClawHub({
      query,
      limit: normalizeLimit(params.limit),
      baseUrl: resolveMarketplaceBaseUrl(),
      fetchImpl: buildLocalizedFetch(language),
    });
    return skills
      .map((skill) => mapSkillResult(skill, language))
      .filter((skill): skill is MarketplaceSkillResult => skill !== null);
  }

  async install(params: MarketplaceInstallParams): Promise<void> {
    const slug = stringValue(params.slug);
    if (!slug) {
      throw new Error('Marketplace install requires a skill slug');
    }

    const runtime = await loadRuntimeModule();
    const language = await resolveMarketplaceLanguage();
    const baseUrl = resolveMarketplaceBaseUrl();
    const result = await runtime.installSkillFromClawHub({
      workspaceDir: getOpenClawConfigDir(),
      slug,
      version: stringValue(params.version),
      force: params.force,
      baseUrl,
      logger: {
        info: (message: string) => logger.info(`[clawhub] ${message}`),
      },
    });

    if (result && result.ok === false) {
      throw new Error(result.error || `Failed to install skill "${slug}"`);
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
