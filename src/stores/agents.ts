import { create } from 'zustand';
import { hostApi } from '@/lib/host-api';
import type { ChannelType } from '@/types/channel';
import type {
  AgentProfileDraft,
  AgentProfileGenerationInput,
  AgentSummary,
  AgentsSnapshot,
} from '@/types/agent';

interface AgentsState {
  agents: AgentSummary[];
  defaultAgentId: string;
  defaultModelRef: string | null;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
  channelAccountOwners: Record<string, string>;
  loading: boolean;
  error: string | null;
  fetchAgents: () => Promise<void>;
  createAgent: (
    name: string,
    options?: { inheritWorkspace?: boolean; profile?: AgentProfileDraft },
  ) => Promise<AgentSummary | null>;
  generateAgentProfile: (input: AgentProfileGenerationInput) => Promise<AgentProfileDraft>;
  updateAgent: (agentId: string, name: string) => Promise<void>;
  updateAgentModel: (agentId: string, modelRef: string | null) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  assignChannel: (agentId: string, channelType: ChannelType) => Promise<void>;
  removeChannel: (agentId: string, channelType: ChannelType) => Promise<void>;
  clearError: () => void;
}

function applySnapshot(snapshot: AgentsSnapshot | undefined) {
  return snapshot ? {
    agents: snapshot.agents ?? [],
    defaultAgentId: snapshot.defaultAgentId ?? 'main',
    defaultModelRef: snapshot.defaultModelRef ?? null,
    configuredChannelTypes: snapshot.configuredChannelTypes ?? [],
    channelOwners: snapshot.channelOwners ?? {},
    channelAccountOwners: snapshot.channelAccountOwners ?? {},
  } : {};
}

export const useAgentsStore = create<AgentsState>((set) => ({
  agents: [],
  defaultAgentId: 'main',
  defaultModelRef: null,
  configuredChannelTypes: [],
  channelOwners: {},
  channelAccountOwners: {},
  loading: false,
  error: null,

  fetchAgents: async () => {
    set({ loading: true, error: null });
    try {
      const snapshot = await hostApi.agents.list();
      set({
        ...applySnapshot(snapshot),
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },

  createAgent: async (
    name: string,
    options?: { inheritWorkspace?: boolean; profile?: AgentProfileDraft },
  ) => {
    set({ error: null });
    try {
      const snapshot = await hostApi.agents.create({
        name,
        inheritWorkspace: options?.inheritWorkspace,
        profile: options?.profile,
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

  // Profile generation remains Main-owned so the renderer never talks to the Gateway directly.
  generateAgentProfile: async (input: AgentProfileGenerationInput) => {
    set({ error: null });
    try {
      const response = await hostApi.agents.generateProfile(input);
      return response.profile;
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgent: async (agentId: string, name: string) => {
    set({ error: null });
    try {
      const snapshot = await hostApi.agents.update(agentId, { name });
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgentModel: async (agentId: string, modelRef: string | null) => {
    set({ error: null });
    try {
      const snapshot = await hostApi.agents.updateModel(agentId, modelRef);
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  deleteAgent: async (agentId: string) => {
    set({ error: null });
    try {
      const snapshot = await hostApi.agents.delete(agentId);
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  assignChannel: async (agentId: string, channelType: ChannelType) => {
    set({ error: null });
    try {
      const snapshot = await hostApi.agents.assignChannel(agentId, channelType);
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  removeChannel: async (agentId: string, channelType: ChannelType) => {
    set({ error: null });
    try {
      const snapshot = await hostApi.agents.removeChannel(agentId, channelType);
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));
