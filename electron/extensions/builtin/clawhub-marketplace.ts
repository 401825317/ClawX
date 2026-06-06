import { readdir } from 'node:fs/promises';
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
  version?: unknown;
  ownerHandle?: unknown;
  owner?: {
    handle?: unknown;
    displayName?: unknown;
  };
  downloads?: unknown;
  stars?: unknown;
};

type InstallResult = {
  ok?: boolean;
  error?: string;
};

type SearchFn = (params: { query?: string; limit?: number; baseUrl?: string }) => Promise<RawClawHubSkill[]>;

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

function mapSkillResult(entry: RawClawHubSkill): MarketplaceSkillResult | null {
  const slug = stringValue(entry.slug);
  if (!slug) return null;

  return {
    slug,
    name: stringValue(entry.displayName) ?? stringValue(entry.name) ?? slug,
    description: stringValue(entry.summary) ?? stringValue(entry.description) ?? '',
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
    const query = stringValue(params.query) ?? DEFAULT_MARKETPLACE_QUERY;
    const skills = await runtime.searchSkillsFromClawHub({
      query,
      limit: normalizeLimit(params.limit),
    });
    return skills
      .map(mapSkillResult)
      .filter((skill): skill is MarketplaceSkillResult => skill !== null);
  }

  async install(params: MarketplaceInstallParams): Promise<void> {
    const slug = stringValue(params.slug);
    if (!slug) {
      throw new Error('Marketplace install requires a skill slug');
    }

    const runtime = await loadRuntimeModule();
    const result = await runtime.installSkillFromClawHub({
      workspaceDir: getOpenClawConfigDir(),
      slug,
      version: stringValue(params.version),
      force: params.force,
      logger: {
        info: (message: string) => logger.info(`[clawhub] ${message}`),
      },
    });

    if (result && result.ok === false) {
      throw new Error(result.error || `Failed to install skill "${slug}"`);
    }
  }
}

export function createClawHubMarketplaceExtension(): Extension {
  return new ClawHubMarketplaceExtension();
}
