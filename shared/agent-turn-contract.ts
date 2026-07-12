export const AGENT_TURN_CONTRACT_VERSION = 1 as const;

export type AgentTurnIntent = 'chat' | 'research' | 'artifact' | 'media' | 'desktop' | 'workflow';
export type AgentTurnToolRequirement = 'none' | 'optional' | 'required';
export type AgentTurnSideEffect = 'none' | 'local_artifact' | 'remote_generation' | 'external_action';
export type AgentTurnMediaKind = 'image' | 'video' | 'audio';

export type AgentTurnMediaAcceptance = {
  kind?: AgentTurnMediaKind;
  minDurationSeconds?: number;
  width?: number;
  height?: number;
  aspectRatio?: string;
  requiresAudio?: boolean;
  language?: string;
};

export type AgentTurnAcceptance = {
  requiresArtifact: boolean;
  requiresVerification: boolean;
  requiresApproval: boolean;
  requiresToolEvidence: boolean;
  media?: AgentTurnMediaAcceptance;
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
const MEDIA_KINDS = new Set<AgentTurnMediaKind>(['image', 'video', 'audio']);

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

function optionalPositiveNumber(value: unknown, label: string, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`Invalid turn contract ${label}`);
  }
  return value;
}

function optionalShortString(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Invalid turn contract ${label}`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`Invalid turn contract ${label}`);
  return normalized;
}

function normalizeMediaAcceptance(value: unknown): AgentTurnMediaAcceptance | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!record) throw new Error('Invalid turn contract acceptance.media');
  const kind = record.kind === undefined ? undefined : enumValue(record.kind, MEDIA_KINDS, 'acceptance.media.kind');
  const minDurationSeconds = optionalPositiveNumber(record.minDurationSeconds, 'acceptance.media.minDurationSeconds', 86_400);
  const width = optionalPositiveNumber(record.width, 'acceptance.media.width', 16_384);
  const height = optionalPositiveNumber(record.height, 'acceptance.media.height', 16_384);
  const aspectRatio = optionalShortString(record.aspectRatio, 'acceptance.media.aspectRatio', 32);
  const requiresAudio = record.requiresAudio === undefined
    ? undefined
    : optionalBoolean(record.requiresAudio, false, 'acceptance.media.requiresAudio');
  const language = optionalShortString(record.language, 'acceptance.media.language', 64);
  return {
    ...(kind ? { kind } : {}),
    ...(minDurationSeconds !== undefined ? { minDurationSeconds } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(requiresAudio !== undefined ? { requiresAudio } : {}),
    ...(language ? { language } : {}),
  };
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
  const media = normalizeMediaAcceptance(acceptanceInput.media);

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
    acceptance: {
      requiresArtifact,
      requiresVerification,
      requiresApproval,
      requiresToolEvidence,
      ...(media ? { media } : {}),
    },
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
