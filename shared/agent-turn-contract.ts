export const AGENT_TURN_CONTRACT_VERSION = 1 as const;

export type AgentTurnIntent = 'chat' | 'research' | 'artifact' | 'media' | 'desktop' | 'workflow';
export type AgentTurnToolRequirement = 'none' | 'optional' | 'required';
export type AgentTurnSideEffect = 'none' | 'local_artifact' | 'remote_generation' | 'external_action';

export type AgentTurnAcceptance = {
  requiresArtifact: boolean;
  requiresVerification: boolean;
  requiresApproval: boolean;
  requiresToolEvidence: boolean;
};

/** This declares delivery requirements; it is never completion evidence by itself. */
export type AgentTurnContract = {
  version: typeof AGENT_TURN_CONTRACT_VERSION;
  intent: AgentTurnIntent;
  toolRequirement: AgentTurnToolRequirement;
  sideEffect: AgentTurnSideEffect;
  sideEffectAuthorized: boolean;
  capabilityRefs: string[];
  acceptance: AgentTurnAcceptance;
};

export type AgentTurnContractInput = {
  intent?: unknown;
  toolRequirement?: unknown;
  sideEffect?: unknown;
  sideEffectAuthorized?: unknown;
  capabilityRefs?: unknown;
  acceptance?: unknown;
};

const INTENTS = new Set<AgentTurnIntent>(['chat', 'research', 'artifact', 'media', 'desktop', 'workflow']);
const TOOL_REQUIREMENTS = new Set<AgentTurnToolRequirement>(['none', 'optional', 'required']);
const SIDE_EFFECTS = new Set<AgentTurnSideEffect>(['none', 'local_artifact', 'remote_generation', 'external_action']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function enumValue<T extends string>(value: unknown, values: Set<T>, label: string): T {
  if (typeof value !== 'string' || !values.has(value as T)) throw new Error(`Invalid turn contract ${label}`);
  return value as T;
}

function optionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`Invalid turn contract ${label}`);
  return value;
}

function normalizeCapabilityRefs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid turn contract capabilityRefs');
  const refs: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('Invalid turn contract capabilityRefs');
    const normalized = entry.trim();
    if (!normalized || normalized.length > 240) throw new Error('Invalid turn contract capabilityRefs');
    if (!refs.includes(normalized)) refs.push(normalized);
  }
  return refs;
}

export function normalizeAgentTurnContract(input: AgentTurnContractInput): AgentTurnContract {
  const record = asRecord(input);
  if (!record) throw new Error('Turn contract must be an object');

  const intent = enumValue(record.intent, INTENTS, 'intent');
  const toolRequirement = enumValue(record.toolRequirement, TOOL_REQUIREMENTS, 'toolRequirement');
  const sideEffect = enumValue(record.sideEffect, SIDE_EFFECTS, 'sideEffect');
  const acceptanceInput = asRecord(record.acceptance) ?? {};
  const requiresArtifact = optionalBoolean(
    acceptanceInput.requiresArtifact,
    sideEffect === 'local_artifact' || sideEffect === 'remote_generation',
    'acceptance.requiresArtifact',
  );
  const requiresVerification = optionalBoolean(
    acceptanceInput.requiresVerification,
    requiresArtifact,
    'acceptance.requiresVerification',
  );
  const requiresApproval = optionalBoolean(
    acceptanceInput.requiresApproval,
    sideEffect === 'external_action',
    'acceptance.requiresApproval',
  );
  const requiresToolEvidence = optionalBoolean(
    acceptanceInput.requiresToolEvidence,
    toolRequirement === 'required',
    'acceptance.requiresToolEvidence',
  );
  const sideEffectAuthorized = optionalBoolean(
    record.sideEffectAuthorized,
    sideEffect === 'none',
    'sideEffectAuthorized',
  );

  if (sideEffect !== 'none' && toolRequirement === 'none') {
    throw new Error('A side-effecting turn contract cannot set toolRequirement to none');
  }
  if (requiresArtifact && sideEffect === 'none') {
    throw new Error('An artifact requirement needs a local_artifact or remote_generation side effect');
  }

  return {
    version: AGENT_TURN_CONTRACT_VERSION,
    intent,
    toolRequirement,
    sideEffect,
    sideEffectAuthorized,
    capabilityRefs: normalizeCapabilityRefs(record.capabilityRefs),
    acceptance: { requiresArtifact, requiresVerification, requiresApproval, requiresToolEvidence },
  };
}

export function turnContractRequiresArtifact(contract: AgentTurnContract | undefined): boolean {
  return contract?.acceptance.requiresArtifact === true;
}

export function turnContractRequiresVerification(contract: AgentTurnContract | undefined): boolean {
  return contract?.acceptance.requiresVerification === true;
}

export function turnContractRequiresToolEvidence(contract: AgentTurnContract | undefined): boolean {
  return contract?.acceptance.requiresToolEvidence === true;
}

export function turnContractRequiresApproval(contract: AgentTurnContract | undefined): boolean {
  return contract?.acceptance.requiresApproval === true;
}
