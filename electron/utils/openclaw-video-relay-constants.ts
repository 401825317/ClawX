import { JUNFEIAI_VIDEO_GENERATION_TIMEOUT_MS } from '../../shared/junfeiai-endpoints';
import {
  findManagedVideoModelCapability,
  MANAGED_VIDEO_CAPABILITY_PROVIDER_PARAM,
  normalizeManagedVideoCapabilityContract,
  resolveManagedVideoDurationSeconds,
  resolveManagedVideoModelCapability,
  type ManagedVideoCapabilityContract,
  type ManagedVideoMode,
  type ManagedVideoModelCapability,
} from '../../shared/managed-video-capabilities';

export const CLAWX_OPENAI_VIDEO_PROVIDER_KEY = 'openai';
export const CLAWX_OPENAI_VIDEO_DEFAULT_TIMEOUT_MS = JUNFEIAI_VIDEO_GENERATION_TIMEOUT_MS;

export type ClawXOpenAiVideoMode = ManagedVideoMode;

export interface ClawXOpenAiVideoModelOption extends ManagedVideoModelCapability {
  verified: true;
}

const LEGACY_MODEL_ALIASES: Record<string, string> = {
  'grok-imagine-video': 'grok-image-video',
  'grok-imagine-video-1.5': 'grok-video-1.5',
  'grok-imagine-video-1.5-preview': 'grok-video-1.5',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readManagedVideoCapabilityContractFromConfig(
  config: unknown,
): ManagedVideoCapabilityContract | null {
  if (!isRecord(config) || !isRecord(config.models) || !isRecord(config.models.providers)) return null;
  const provider = config.models.providers[CLAWX_OPENAI_VIDEO_PROVIDER_KEY];
  if (!isRecord(provider) || !isRecord(provider.params)) return null;
  return normalizeManagedVideoCapabilityContract(
    provider.params[MANAGED_VIDEO_CAPABILITY_PROVIDER_PARAM],
  );
}

function modelIdFromRef(raw?: string | null): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  const modelId = trimmed.includes('/') ? trimmed.slice(trimmed.indexOf('/') + 1).trim() : trimmed;
  return LEGACY_MODEL_ALIASES[modelId] ?? modelId;
}

export function managedVideoModelOptions(
  contract: ManagedVideoCapabilityContract | null | undefined,
): ClawXOpenAiVideoModelOption[] {
  return (contract?.models ?? []).map((model) => ({ ...model, verified: true }));
}

export function normalizeClawXOpenAiVideoModelId(
  raw: string | null | undefined,
  contract: ManagedVideoCapabilityContract,
): string {
  const modelId = modelIdFromRef(raw);
  return findManagedVideoModelCapability(contract, modelId)?.id ?? contract.defaultModel;
}

export function isClawXOpenAiVideoModelId(
  raw: string | null | undefined,
  contract: ManagedVideoCapabilityContract | null | undefined,
): boolean {
  return Boolean(findManagedVideoModelCapability(contract, modelIdFromRef(raw)));
}

export function isClawXOpenAiVideoModelRef(
  raw: string | null | undefined,
  contract: ManagedVideoCapabilityContract | null | undefined,
): boolean {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed.startsWith(`${CLAWX_OPENAI_VIDEO_PROVIDER_KEY}/`)
    && isClawXOpenAiVideoModelId(trimmed, contract);
}

export function orderedClawXOpenAiVideoModelIds(
  contract: ManagedVideoCapabilityContract,
  primary?: string | null,
): string[] {
  const normalizedPrimary = normalizeClawXOpenAiVideoModelId(primary, contract);
  return [
    normalizedPrimary,
    ...contract.models.map((model) => model.id).filter((modelId) => modelId !== normalizedPrimary),
  ];
}

export function selectClawXOpenAiVideoModelForInput(
  contract: ManagedVideoCapabilityContract,
  imageCount: number,
  requestedModel?: string | null,
): ManagedVideoModelCapability | null {
  return resolveManagedVideoModelCapability(contract, modelIdFromRef(requestedModel), imageCount);
}

export function normalizeClawXOpenAiVideoDurationSeconds(
  model: ManagedVideoModelCapability,
  raw?: number | null,
): number {
  return resolveManagedVideoDurationSeconds(model, raw);
}
