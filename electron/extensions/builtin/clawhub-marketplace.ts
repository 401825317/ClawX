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
  slug?: unknown;
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
  downloads?: unknown;
  stars?: unknown;
  metaContent?: {
    DisplayDescription?: unknown;
    displayDescription?: unknown;
    summary?: unknown;
    Summary?: unknown;
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
  r?: SearchFn;
  t?: InstallFn;
  searchSkillsFromClawHub?: SearchFn;
  installSkillFromClawHub?: InstallFn;
};

type LoadedRuntime = {
  searchSkillsFromClawHub: SearchFn;
  installSkillFromClawHub: InstallFn;
};

const DEFAULT_MARKETPLACE_QUERY = 'skill';
const DEFAULT_SEARCH_LIMIT = 30;
const MAX_SEARCH_LIMIT = 100;
const OPENCLAW_SKILLS_CLAWHUB_MODULE_RE = /^skills-clawhub(?:-.+)?\.js$/;
const DEFAULT_CLAWHUB_MIRROR_URL = 'https://mirror-cn.clawhub.com';

let runtimeModulePromise: Promise<LoadedRuntime> | null = null;

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
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
    existing = {};
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

async function resolveSkillsClawHubModulePath(): Promise<string> {
  const distDir = join(getOpenClawResolvedDir(), 'dist');
  const entries = await readdir(distDir);
  const moduleFile = entries.find((entry) => OPENCLAW_SKILLS_CLAWHUB_MODULE_RE.test(entry));
  if (!moduleFile) {
    throw new Error(`OpenClaw ClawHub runtime module not found in ${distDir}`);
  }
  return join(distDir, moduleFile);
}

async function importRuntimeModule(): Promise<LoadedRuntime> {
  const modulePath = await resolveSkillsClawHubModulePath();
  const mod = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as RuntimeModule;
  const searchSkillsFromClawHub = mod.searchSkillsFromClawHub ?? mod.r;
  const installSkillFromClawHub = mod.installSkillFromClawHub ?? mod.t;

  if (typeof searchSkillsFromClawHub !== 'function' || typeof installSkillFromClawHub !== 'function') {
    throw new Error(`OpenClaw ClawHub runtime module has incompatible exports: ${modulePath}`);
  }

  return {
    searchSkillsFromClawHub,
    installSkillFromClawHub,
  };
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
  const slug = stringValue(entry.slug);
  if (!slug) return null;

  return {
    slug,
    name: stringValue(entry.displayName) ?? stringValue(entry.name) ?? slug,
    description: resolveLocalizedDescription(entry, language),
    version: stringValue(entry.version) ?? '',
    author: stringValue(entry.ownerHandle) ?? stringValue(entry.owner?.displayName) ?? stringValue(entry.owner?.handle),
    downloads: numberValue(entry.downloads),
    stars: numberValue(entry.stars),
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
