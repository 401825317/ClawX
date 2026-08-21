import type { GatewayManager } from '../gateway/manager';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import type { AgentProfileDraft } from '@shared/types/agent';
import {
  assignChannelToAgent,
  clearChannelBinding,
  createAgent,
  deleteAgentConfig,
  listAgentsSnapshot,
  removeAgentWorkspaceDirectory,
  resolveAccountIdForAgent,
  updateAgentModel,
  updateAgentName,
} from '../utils/agent-config';
import { deleteChannelAccountConfig } from '../utils/channel-config';
import { ensureClawXContext } from '../utils/openclaw-workspace';
import { generateAgentProfileViaGateway } from './agent-profile-generation-service';
import { isRecord } from './payload-utils';
import { syncAgentModelOverrideToRuntime, syncAllProviderAuthToRuntime } from './providers/provider-runtime-sync';
import { longTermRuleService } from './long-term-rule-service';

type AgentsApiContext = {
  gatewayManager: GatewayManager;
};

function requireString(payload: unknown, key: string): string {
  if (!isRecord(payload) || typeof payload[key] !== 'string' || !payload[key].trim()) {
    throw new Error(`${key} is required`);
  }
  return payload[key].trim();
}

function readOptionalProfile(payload: unknown): AgentProfileDraft | undefined {
  if (!isRecord(payload) || payload.profile == null) return undefined;
  if (!isRecord(payload.profile)) throw new Error('profile must be an object');
  const profile = payload.profile;
  const requiredStrings = [
    'roleName',
    'personaName',
    'responsibility',
    'workspaceInstructions',
    'welcomeMessage',
    'avatarId',
  ] as const;
  for (const key of requiredStrings) {
    if (typeof profile[key] !== 'string') throw new Error(`profile.${key} is required`);
  }
  if (!Array.isArray(profile.capabilities) || !profile.capabilities.every((item) => typeof item === 'string')) {
    throw new Error('profile.capabilities must be a string array');
  }
  if (!Array.isArray(profile.boundaries) || !profile.boundaries.every((item) => typeof item === 'string')) {
    throw new Error('profile.boundaries must be a string array');
  }
  return profile as unknown as AgentProfileDraft;
}

function scheduleGatewayReload(ctx: AgentsApiContext, reason: string): void {
  if (ctx.gatewayManager.getStatus().state !== 'stopped') {
    ctx.gatewayManager.debouncedReload();
    return;
  }
  void reason;
}

async function restartGatewayForAgentDeletion(ctx: AgentsApiContext): Promise<void> {
  try {
    await ctx.gatewayManager.restart();
    console.log('[agents] Gateway restart completed after agent deletion');
  } catch (err) {
    console.warn('[agents] Gateway restart after agent deletion failed:', err);
  }
}

export function createAgentsApi(ctx: AgentsApiContext): CompleteHostServiceRegistry['agents'] {
  return {
    list: async () => ({ success: true, ...(await listAgentsSnapshot()) }),
    generateProfile: async (payload) => {
      const roleName = requireString(payload, 'roleName');
      const responsibility = requireString(payload, 'responsibility');
      const avatarId = requireString(payload, 'avatarId');
      const locale = isRecord(payload) && typeof payload.locale === 'string'
        ? payload.locale.trim() || undefined
        : undefined;
      const profile = await generateAgentProfileViaGateway(
        { gatewayManager: ctx.gatewayManager },
        { roleName, responsibility, avatarId, locale },
      );
      return { success: true, profile };
    },
    create: async (payload) => {
      const name = requireString(payload, 'name');
      const inheritWorkspace = isRecord(payload) ? payload.inheritWorkspace === true : undefined;
      const profile = readOptionalProfile(payload);
      const snapshot = await createAgent(name, {
        inheritWorkspace,
        ...(profile ? { profile } : {}),
      });
      // Do not reload a newly created Agent while managed credential cleanup is incomplete.
      try {
        await syncAllProviderAuthToRuntime({ reconcileManagedRuntime: true });
        scheduleGatewayReload(ctx, 'create-agent');
      } catch (syncError) {
        console.warn('[agents] Failed to sync provider auth after agent creation:', syncError);
      }
      void ensureClawXContext({ waitForAllConfiguredWorkspaces: true }).catch((err) => {
        console.warn('[agents] Failed to ensure ClawX context after agent creation:', err);
      });
      const createdAgent = snapshot.agents.find((agent) => agent.id === snapshot.createdAgentId);
      if (createdAgent) {
        await longTermRuleService.repair({
          agentId: createdAgent.id,
          workspaceRoot: createdAgent.workspace,
        });
      }
      return { success: true, ...snapshot };
    },
    update: async (payload) => {
      const agentId = requireString(payload, 'id');
      const name = requireString(payload, 'name');
      const snapshot = await updateAgentName(agentId, name);
      const updatedAgent = snapshot.agents.find((agent) => agent.id === agentId);
      if (updatedAgent) {
        await longTermRuleService.repair({ agentId, workspaceRoot: updatedAgent.workspace });
      }
      scheduleGatewayReload(ctx, 'update-agent');
      return { success: true, ...snapshot };
    },
    updateModel: async (payload) => {
      const agentId = requireString(payload, 'id');
      const modelRef = isRecord(payload) && typeof payload.modelRef === 'string' ? payload.modelRef : null;
      const snapshot = await updateAgentModel(agentId, modelRef);
      // Runtime synchronization is a prerequisite for reload; a sync error
      // keeps a stale managed credential from becoming active again.
      let runtimeSynchronized = false;
      try {
        await syncAllProviderAuthToRuntime();
        await syncAgentModelOverrideToRuntime(agentId);
        runtimeSynchronized = true;
      } catch (syncError) {
        console.warn('[agents] Failed to sync runtime after updating agent model:', syncError);
      }
      // Agent model changes must be picked up by the running Gateway before
      // the next send; otherwise the UI can show the new selection while the
      // active runtime still answers with the previous model.
      if (runtimeSynchronized) {
        scheduleGatewayReload(ctx, 'update-agent-model');
      }
      return { success: true, ...snapshot };
    },
    delete: async (payload) => {
      const agentId = requireString(payload, 'id');
      const { snapshot, removedEntry } = await deleteAgentConfig(agentId);
      await restartGatewayForAgentDeletion(ctx);
      await removeAgentWorkspaceDirectory(removedEntry).catch((err) => {
        console.warn('[agents] Failed to remove workspace after agent deletion:', err);
      });
      await longTermRuleService.unregisterAgent(agentId);
      return { success: true, ...snapshot };
    },
    assignChannel: async (payload) => {
      const agentId = requireString(payload, 'id');
      const channelType = requireString(payload, 'channelType');
      const snapshot = await assignChannelToAgent(agentId, channelType);
      scheduleGatewayReload(ctx, 'assign-channel');
      return { success: true, ...snapshot };
    },
    removeChannel: async (payload) => {
      const agentId = requireString(payload, 'id');
      const channelType = requireString(payload, 'channelType');
      const ownerId = agentId.trim().toLowerCase();
      const snapshotBefore = await listAgentsSnapshot();
      const ownedAccountIds = Object.entries(snapshotBefore.channelAccountOwners)
        .filter(([channelAccountKey, owner]) => {
          if (owner !== ownerId) return false;
          return channelAccountKey.startsWith(`${channelType}:`);
        })
        .map(([channelAccountKey]) => channelAccountKey.slice(channelAccountKey.indexOf(':') + 1));
      if (ownedAccountIds.length === 0) {
        const legacyAccountId = resolveAccountIdForAgent(agentId);
        if (snapshotBefore.channelAccountOwners[`${channelType}:${legacyAccountId}`] === ownerId) {
          ownedAccountIds.push(legacyAccountId);
        }
      }

      for (const accountId of ownedAccountIds) {
        await deleteChannelAccountConfig(channelType, accountId);
        await clearChannelBinding(channelType, accountId);
      }
      const snapshot = await listAgentsSnapshot();
      scheduleGatewayReload(ctx, 'remove-agent-channel');
      return { success: true, ...snapshot };
    },
  };
}
