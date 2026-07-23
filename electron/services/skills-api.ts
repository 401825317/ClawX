import type { GatewayManager } from '../gateway/manager';
import type { ClawHubService, ClawHubInstallParams, ClawHubSearchParams, ClawHubUninstallParams } from '../gateway/clawhub';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import { getAllSkillConfigs, getSkillConfig, updateSkillConfig, updateSkillConfigs } from '../utils/skill-config';
import {
  collectQuickAccessSkills,
  filterEnabledQuickAccessSkills,
  type QuickAccessRuntimeSkillStatus,
} from '../utils/skill-quick-access';
import { listLocalSkills } from './skills/local-skill-service';
import { isRecord } from './payload-utils';

type SkillConfigPayload = {
  skillKey?: unknown;
  enabled?: unknown;
  apiKey?: unknown;
  env?: unknown;
};

type SkillConfigsPayload = {
  updates?: unknown;
};

type NormalizedSkillConfigUpdate = {
  skillKey: string;
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
};

type QuickAccessPayload = {
  workspace?: unknown;
};

type SkillOpenPayload = {
  slug?: unknown;
  skillKey?: unknown;
  baseDir?: unknown;
};

function getMarketplaceSearchParams(payload: unknown): ClawHubSearchParams {
  const body = isRecord(payload) ? payload : {};
  return {
    query: typeof body.query === 'string' ? body.query.trim() : '',
    limit: typeof body.limit === 'number' ? body.limit : undefined,
    locale: typeof body.locale === 'string' ? body.locale : undefined,
    cursor: typeof body.cursor === 'string' ? body.cursor : undefined,
    sort: typeof body.sort === 'string' ? body.sort : undefined,
    dir: typeof body.dir === 'string' ? body.dir : undefined,
    force: typeof body.force === 'boolean' ? body.force : undefined,
    provider: typeof body.provider === 'string' ? body.provider : undefined,
  };
}

function getMarketplaceInstallParams(payload: unknown): ClawHubInstallParams {
  const body = isRecord(payload) ? payload : {};
  return {
    slug: typeof body.slug === 'string' ? body.slug.trim() : '',
    version: typeof body.version === 'string' ? body.version : undefined,
    force: typeof body.force === 'boolean' ? body.force : undefined,
    provider: typeof body.provider === 'string' ? body.provider : undefined,
  };
}

function getMarketplaceUninstallParams(payload: unknown): ClawHubUninstallParams {
  const body = isRecord(payload) ? payload : {};
  return { slug: typeof body.slug === 'string' ? body.slug.trim() : '' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getSkillKey(payload: unknown): string {
  const body = isRecord(payload) ? payload as SkillConfigPayload : {};
  if (typeof body.skillKey !== 'string' || !body.skillKey.trim()) {
    throw new Error('skillKey is required');
  }
  return body.skillKey.trim();
}

function getEnv(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function getConfigUpdate(payload: unknown): NormalizedSkillConfigUpdate {
  const body = isRecord(payload) ? payload as SkillConfigPayload : {};
  return {
    skillKey: getSkillKey(payload),
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
    env: getEnv(body.env),
  };
}

function getConfigUpdates(payload: unknown): NormalizedSkillConfigUpdate[] {
  const body = isRecord(payload) ? payload as SkillConfigsPayload : {};
  if (!Array.isArray(body.updates)) return [];
  return body.updates.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const skillKey = typeof entry.skillKey === 'string' ? entry.skillKey.trim() : '';
    if (!skillKey) return [];
    return [{
      skillKey,
      enabled: typeof entry.enabled === 'boolean' ? entry.enabled : undefined,
      apiKey: typeof entry.apiKey === 'string' ? entry.apiKey : undefined,
      env: getEnv(entry.env),
    }];
  });
}

export function createSkillsApi({
  clawHubService,
  gatewayManager,
}: {
  clawHubService: ClawHubService;
  gatewayManager: GatewayManager;
}): CompleteHostServiceRegistry['skills'] {
  const marketplaceCapability = async () => {
    try {
      return { success: true, capability: await clawHubService.getMarketplaceCapability() };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  };
  const marketplaceList = async () => {
    try {
      return { success: true, results: await clawHubService.listInstalled() };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  };
  const marketplaceSearch = async (payload: unknown) => {
    try {
      const result = await clawHubService.search(getMarketplaceSearchParams(payload));
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  };
  const marketplaceInstall = async (payload: unknown) => {
    try {
      await clawHubService.install(getMarketplaceInstallParams(payload));
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  };
  const marketplaceUninstall = async (payload: unknown) => {
    try {
      await clawHubService.uninstall(getMarketplaceUninstallParams(payload));
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  };

  return {
    local: async () => ({ success: true, skills: await listLocalSkills() }),
    configs: async () => getAllSkillConfigs(),
    allConfigs: async () => getAllSkillConfigs(),
    getConfig: async (payload) => {
      const config = await getSkillConfig(getSkillKey(payload));
      return config ? { ...config } : undefined;
    },
    updateConfig: async (payload) => {
      const { skillKey, ...updates } = getConfigUpdate(payload);
      return updateSkillConfig(skillKey, updates);
    },
    updateConfigs: async (payload) => updateSkillConfigs(getConfigUpdates(payload)),
    status: async () => gatewayManager.rpc('skills.status'),
    update: async (payload) => gatewayManager.rpc('skills.update', isRecord(payload) ? payload : {}),
    quickAccess: async (payload) => {
      const body = isRecord(payload) ? payload as QuickAccessPayload : {};
      const [scannedSkills, configs] = await Promise.all([
        collectQuickAccessSkills({
          workspace: typeof body.workspace === 'string' ? body.workspace : undefined,
        }),
        getAllSkillConfigs(),
      ]);
      let runtimeSkills: QuickAccessRuntimeSkillStatus[] | undefined;
      if (gatewayManager.getStatus().state === 'running') {
        try {
          const runtimeStatus = await gatewayManager.rpc<{ skills?: QuickAccessRuntimeSkillStatus[] }>('skills.status');
          runtimeSkills = runtimeStatus.skills || [];
        } catch {
          runtimeSkills = undefined;
        }
      }
      return {
        success: true,
        skills: filterEnabledQuickAccessSkills(scannedSkills, runtimeSkills, configs),
      };
    },
    marketplaceCapability,
    marketplaceList,
    marketplaceSearch,
    marketplaceInstall,
    marketplaceUninstall,
    clawhubCapability: marketplaceCapability,
    clawhubList: marketplaceList,
    clawhubSearch: marketplaceSearch,
    clawhubInstall: marketplaceInstall,
    clawhubUninstall: marketplaceUninstall,
    clawhubOpenSkillReadme: async (payload) => {
      try {
        const body = isRecord(payload) ? payload as SkillOpenPayload : {};
        const skillKey = typeof body.skillKey === 'string' ? body.skillKey : '';
        const slug = typeof body.slug === 'string' ? body.slug : undefined;
        const baseDir = typeof body.baseDir === 'string' ? body.baseDir : undefined;
        await clawHubService.openSkillReadme(skillKey || slug || '', slug, baseDir);
        return { success: true };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
    clawhubOpenSkillPath: async (payload) => {
      try {
        const body = isRecord(payload) ? payload as SkillOpenPayload : {};
        const skillKey = typeof body.skillKey === 'string' ? body.skillKey : '';
        const slug = typeof body.slug === 'string' ? body.slug : undefined;
        const baseDir = typeof body.baseDir === 'string' ? body.baseDir : undefined;
        await clawHubService.openSkillPath(skillKey || slug || '', slug, baseDir);
        return { success: true };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
  };
}
