export interface AgentProfileDraft {
  roleName: string;
  personaName: string;
  responsibility: string;
  capabilities: string[];
  boundaries: string[];
  workspaceInstructions: string;
  welcomeMessage: string;
  avatarId: string;
}

export interface AgentProfile extends AgentProfileDraft {
  agentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileGenerationInput {
  roleName: string;
  responsibility: string;
  avatarId: string;
  locale?: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  isDefault: boolean;
  modelDisplay: string;
  modelRef?: string | null;
  overrideModelRef?: string | null;
  inheritedModel: boolean;
  workspace: string;
  agentDir: string;
  mainSessionKey: string;
  channelTypes: string[];
  profile?: AgentProfile | null;
}

export interface AgentsSnapshot {
  agents: AgentSummary[];
  defaultAgentId: string;
  defaultModelRef?: string | null;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
  channelAccountOwners: Record<string, string>;
  createdAgentId?: string;
}
