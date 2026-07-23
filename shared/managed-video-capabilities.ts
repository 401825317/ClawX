export const MANAGED_VIDEO_CAPABILITY_CONTRACT_VERSION = 1;
export const MANAGED_VIDEO_CAPABILITY_PROVIDER_PARAM = 'uclawManagedVideoCapabilityContract';

export type ManagedVideoMode = 'text-to-video' | 'image-to-video' | 'video-to-video';

export interface ManagedVideoModelCapability {
  id: string;
  label: string;
  description?: string;
  modes: ManagedVideoMode[];
  sizes: string[];
  durations: number[];
  defaultSize: string;
  defaultDurationSeconds: number;
  requiresImage: boolean;
  enabled: true;
}

export interface ManagedVideoCapabilityContract {
  contractVersion: typeof MANAGED_VIDEO_CAPABILITY_CONTRACT_VERSION;
  defaultModel: string;
  defaultSize: string;
  defaultDurationSeconds: number;
  models: ManagedVideoModelCapability[];
}

const VIDEO_MODES = new Set<ManagedVideoMode>([
  'text-to-video',
  'image-to-video',
  'video-to-video',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(value: unknown, predicate?: (entry: string) => boolean): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((entry) => cleanString(entry))
    .filter((entry) => entry && (!predicate || predicate(entry))))];
}

function uniqueDurations(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry) && entry > 0 && entry <= 3600)
    .map((entry) => Math.floor(entry)))]
    .sort((left, right) => left - right);
}

function isVideoSize(value: string): boolean {
  const match = value.match(/^(\d{2,5})x(\d{2,5})$/u);
  if (!match) return false;
  const width = Number.parseInt(match[1]!, 10);
  const height = Number.parseInt(match[2]!, 10);
  return width > 0 && height > 0 && width <= 16384 && height <= 16384;
}

function normalizeModes(value: unknown): ManagedVideoMode[] {
  return uniqueStrings(value, (entry) => VIDEO_MODES.has(entry as ManagedVideoMode)) as ManagedVideoMode[];
}

function normalizeModel(
  value: unknown,
  globalDefaultSize: string,
  globalDefaultDurationSeconds: number | undefined,
): ManagedVideoModelCapability | null {
  if (!isRecord(value) || value.enabled === false) return null;
  const id = cleanString(value.id);
  const modes = normalizeModes(value.modes);
  const sizes = uniqueStrings(value.sizes, isVideoSize);
  const durations = uniqueDurations(value.durations);
  if (!id || modes.length === 0 || sizes.length === 0 || durations.length === 0) return null;

  const requestedDefaultSize = cleanString(value.defaultSize);
  const defaultSize = sizes.includes(requestedDefaultSize)
    ? requestedDefaultSize
    : sizes.includes(globalDefaultSize)
      ? globalDefaultSize
      : sizes[0]!;
  const requestedDefaultDuration = Number(value.defaultDurationSeconds);
  const defaultDurationSeconds = Number.isFinite(requestedDefaultDuration)
    && durations.includes(Math.floor(requestedDefaultDuration))
    ? Math.floor(requestedDefaultDuration)
    : globalDefaultDurationSeconds !== undefined && durations.includes(globalDefaultDurationSeconds)
      ? globalDefaultDurationSeconds
      : durations[0]!;
  const description = cleanString(value.description);

  return {
    id,
    label: cleanString(value.label) || id,
    ...(description ? { description } : {}),
    modes,
    sizes,
    durations,
    defaultSize,
    defaultDurationSeconds,
    requiresImage: value.requiresImage === true
      || (modes.includes('image-to-video') && !modes.includes('text-to-video')),
    enabled: true,
  };
}

export function normalizeManagedVideoCapabilityContract(
  value: unknown,
): ManagedVideoCapabilityContract | null {
  if (!isRecord(value) || !Array.isArray(value.models)) return null;
  const globalDefaultSize = cleanString(value.defaultSize);
  const rawGlobalDuration = Number(value.defaultDurationSeconds);
  const globalDefaultDurationSeconds = Number.isFinite(rawGlobalDuration) && rawGlobalDuration > 0
    ? Math.floor(rawGlobalDuration)
    : undefined;
  const seen = new Set<string>();
  const models = value.models
    .map((entry) => normalizeModel(entry, globalDefaultSize, globalDefaultDurationSeconds))
    .filter((entry): entry is ManagedVideoModelCapability => {
      if (!entry || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  if (models.length === 0) return null;

  const requestedDefaultModel = cleanString(value.defaultModel);
  const selectedModel = models.find((model) => model.id === requestedDefaultModel) ?? models[0]!;
  return {
    contractVersion: MANAGED_VIDEO_CAPABILITY_CONTRACT_VERSION,
    defaultModel: selectedModel.id,
    defaultSize: selectedModel.defaultSize,
    defaultDurationSeconds: selectedModel.defaultDurationSeconds,
    models,
  };
}

export function findManagedVideoModelCapability(
  contract: ManagedVideoCapabilityContract | null | undefined,
  modelId: string | null | undefined,
): ManagedVideoModelCapability | null {
  const normalizedModelId = cleanString(modelId);
  if (!contract || !normalizedModelId) return null;
  return contract.models.find((model) => model.id === normalizedModelId) ?? null;
}

export function resolveManagedVideoModelCapability(
  contract: ManagedVideoCapabilityContract,
  requestedModelId: string | null | undefined,
  inputImageCount = 0,
): ManagedVideoModelCapability | null {
  const requiredMode: ManagedVideoMode = inputImageCount > 0 ? 'image-to-video' : 'text-to-video';
  const supportsInput = (model: ManagedVideoModelCapability) => model.modes.includes(requiredMode);
  const requested = findManagedVideoModelCapability(contract, requestedModelId);
  if (requested && supportsInput(requested)) return requested;
  const configuredDefault = findManagedVideoModelCapability(contract, contract.defaultModel);
  if (configuredDefault && supportsInput(configuredDefault)) return configuredDefault;
  return contract.models.find(supportsInput) ?? null;
}

export function resolveManagedVideoDurationSeconds(
  model: ManagedVideoModelCapability,
  requested: number | null | undefined,
): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return model.defaultDurationSeconds;
  }
  const rounded = Math.max(1, Math.round(requested));
  return model.durations.reduce((nearest, candidate) => (
    Math.abs(candidate - rounded) < Math.abs(nearest - rounded) ? candidate : nearest
  ), model.defaultDurationSeconds);
}
