import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { normalizeManagedTextModelRef } from '@/lib/managed-model-options';
import type { ChannelType } from '@/types/channel';
import type {
  AgentProfileDraft,
  AgentProfileGenerationInput,
  AgentSummary,
  AgentsSnapshot,
} from '@/types/agent';
import { useClientConfigStore } from './client-config';

interface AgentsState {
  agents: AgentSummary[];
  defaultAgentId: string;
  defaultModelRef: string | null;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
  channelAccountOwners: Record<string, string>;
  loading: boolean;
  error: string | null;
  fetchAgents: (options?: { force?: boolean; quiet?: boolean }) => Promise<void>;
  createAgent: (
    name: string,
    options?: { inheritWorkspace?: boolean; profile?: AgentProfileDraft },
  ) => Promise<AgentSummary | null>;
  generateAgentProfile: (input: AgentProfileGenerationInput) => Promise<AgentProfileDraft>;
  updateAgent: (agentId: string, name: string) => Promise<void>;
  updateAgentModel: (agentId: string, modelRef: string | null) => Promise<void>;
  healManagedTextModels: () => void;
  deleteAgent: (agentId: string) => Promise<void>;
  assignChannel: (agentId: string, channelType: ChannelType) => Promise<void>;
  removeChannel: (agentId: string, channelType: ChannelType) => Promise<void>;
  clearError: () => void;
}

function normalizeSnapshotModelRef(modelRef: string | null | undefined, fallbackEmpty = false): string | null {
  return normalizeManagedTextModelRef(
    modelRef,
    useClientConfigStore.getState().modelOptions,
    { fallbackEmpty },
  );
}

function normalizeSnapshotAgent(agent: AgentSummary): AgentSummary {
  return {
    ...agent,
    modelRef: normalizeSnapshotModelRef(agent.modelRef, true),
    overrideModelRef: normalizeSnapshotModelRef(agent.overrideModelRef),
  };
}

function applySnapshot(snapshot: AgentsSnapshot | undefined) {
  return snapshot ? {
    agents: (snapshot.agents ?? []).map(normalizeSnapshotAgent),
    defaultAgentId: snapshot.defaultAgentId ?? 'main',
    defaultModelRef: normalizeSnapshotModelRef(snapshot.defaultModelRef, true),
    configuredChannelTypes: snapshot.configuredChannelTypes ?? [],
    channelOwners: snapshot.channelOwners ?? {},
    channelAccountOwners: snapshot.channelAccountOwners ?? {},
  } : {};
}

const AGENTS_FETCH_TTL_MS = 10_000;
let agentsFetchInFlight: Promise<void> | null = null;
let lastAgentsFetchAt = 0;

export const useAgentsStore = create<AgentsState>((set) => ({
  agents: [],
  defaultAgentId: 'main',
  defaultModelRef: null,
  configuredChannelTypes: [],
  channelOwners: {},
  channelAccountOwners: {},
  loading: false,
  error: null,

  fetchAgents: async (options?: { force?: boolean; quiet?: boolean }) => {
    if (agentsFetchInFlight) {
      await agentsFetchInFlight;
      return;
    }
    const now = Date.now();
    if (!options?.force && now - lastAgentsFetchAt < AGENTS_FETCH_TTL_MS) {
      return;
    }

    if (!options?.quiet) {
      set({ loading: true, error: null });
    }

    agentsFetchInFlight = (async () => {
      try {
        const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>('/api/agents');
        set({
          ...applySnapshot(snapshot),
          loading: false,
          error: null,
        });
        lastAgentsFetchAt = Date.now();
      } catch (error) {
        set({ loading: false, error: String(error) });
      } finally {
        agentsFetchInFlight = null;
      }
    })();

    await agentsFetchInFlight;
  },

  createAgent: async (name: string, options?: { inheritWorkspace?: boolean; profile?: AgentProfileDraft }) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name,
          inheritWorkspace: options?.inheritWorkspace,
          profile: options?.profile,
        }),
      });
      set(applySnapshot(snapshot));
      return snapshot.createdAgentId
        ? snapshot.agents.find((agent) => agent.id === snapshot.createdAgentId) ?? null
        : null;
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  generateAgentProfile: async (input: AgentProfileGenerationInput) => {
    set({ error: null });
    try {
      const response = await hostApiFetch<{
        success?: boolean;
        profile?: AgentProfileDraft;
        error?: string;
      }>('/api/agents/generate-profile', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.profile) {
        throw new Error(response.error || 'Failed to generate agent profile');
      }
      return response.profile;
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgent: async (agentId: string, name: string) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ name }),
        }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgentModel: async (agentId: string, modelRef: string | null) => {
    const normalizedModelRef = normalizeSnapshotModelRef(modelRef);
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/model`,
        {
          method: 'PUT',
          body: JSON.stringify({ modelRef: normalizedModelRef }),
        }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  healManagedTextModels: () => {
    set((state) => ({
      agents: state.agents.map(normalizeSnapshotAgent),
      defaultModelRef: normalizeSnapshotModelRef(state.defaultModelRef, true),
    }));
  },

  deleteAgent: async (agentId: string) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}`,
        { method: 'DELETE' }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  assignChannel: async (agentId: string, channelType: ChannelType) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}`,
        { method: 'PUT' }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  removeChannel: async (agentId: string, channelType: ChannelType) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}`,
        { method: 'DELETE' }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));
