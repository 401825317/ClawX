/**
 * Per-million-token rates expected by `@mariozechner/pi-ai` `calculateCost`.
 * Custom / synced catalog rows often omit pricing; zeros keep accounting stable
 * and avoid `Cannot read properties of undefined (reading 'input')` when usage
 * chunks arrive during openai-completions streaming.
 */
export const PI_AI_MODEL_ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

export type PiAiModelCostRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export const PI_AI_PROMPT_CACHE_KEY_COMPAT = {
  supportsPromptCacheKey: true,
} as const;

export type PiAiPromptCacheKeyCompat = typeof PI_AI_PROMPT_CACHE_KEY_COMPAT;

export const PI_AI_OPENROUTER_REASONING_COMPAT = {
  ...PI_AI_PROMPT_CACHE_KEY_COMPAT,
  thinkingFormat: 'openrouter',
  supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
} as const;

export const PI_AI_OPENROUTER_THINKING_LEVEL_MAP = {
  off: 'none',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
} as const;

export type PiAiModelCompat = PiAiPromptCacheKeyCompat | typeof PI_AI_OPENROUTER_REASONING_COMPAT;

export type PiAiModelInputModality = 'text' | 'image';

export type PiAiModelCapabilityMetadata = {
  reasoning?: unknown;
  input?: unknown;
  compat?: unknown;
};

export type PiAiModelsJsonModelEntry = {
  id: string;
  name: string;
  cost: PiAiModelCostRates;
  contextWindow?: number;
  reasoning?: boolean;
  input?: PiAiModelInputModality[];
  compat?: PiAiModelCompat;
  thinkingLevelMap?: typeof PI_AI_OPENROUTER_THINKING_LEVEL_MAP;
};

export function normalizePiAiModelCost(existing: unknown): PiAiModelCostRates {
  if (!existing || typeof existing !== 'object') {
    return { ...PI_AI_MODEL_ZERO_COST };
  }
  const record = existing as Record<string, unknown>;
  const num = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;

  return {
    input: num(record.input),
    output: num(record.output),
    cacheRead: num(record.cacheRead),
    cacheWrite: num(record.cacheWrite),
  };
}

/** Entry shape suitable for OpenClaw agent `models.json` provider.models[]. */
export function piAiModelsJsonModelEntry(
  id: string,
  name: string = id,
): PiAiModelsJsonModelEntry {
  return { id, name, cost: normalizePiAiModelCost(undefined) };
}

function normalizePiAiModelCompat(compat: unknown): PiAiModelCompat | undefined {
  if (!compat || typeof compat !== 'object') {
    return undefined;
  }
  const record = compat as Record<string, unknown>;
  if (record.thinkingFormat === 'openrouter') {
    return PI_AI_OPENROUTER_REASONING_COMPAT;
  }
  if (record.supportsPromptCacheKey === true) {
    return PI_AI_PROMPT_CACHE_KEY_COMPAT;
  }
  return undefined;
}

function normalizePiAiModelCapabilities(
  metadata?: PiAiModelCapabilityMetadata,
): Pick<PiAiModelsJsonModelEntry, 'reasoning' | 'input' | 'compat' | 'thinkingLevelMap'> {
  const capabilities: Pick<PiAiModelsJsonModelEntry, 'reasoning' | 'input' | 'compat' | 'thinkingLevelMap'> = {};
  if (typeof metadata?.reasoning === 'boolean') {
    capabilities.reasoning = metadata.reasoning;
  }
  if (Array.isArray(metadata?.input)) {
    const input = Array.from(new Set(
      metadata.input.filter((item): item is PiAiModelInputModality =>
        item === 'text' || item === 'image'),
    ));
    if (input.length > 0) {
      capabilities.input = input;
    }
  }
  const compat = normalizePiAiModelCompat(metadata?.compat);
  if (compat) {
    capabilities.compat = compat;
    if (compat === PI_AI_OPENROUTER_REASONING_COMPAT) {
      capabilities.thinkingLevelMap = PI_AI_OPENROUTER_THINKING_LEVEL_MAP;
    }
  }
  return capabilities;
}

export function piAiPromptCacheModelEntry(
  id: string,
  name: string = id,
  contextWindow?: number,
  metadata?: PiAiModelCapabilityMetadata,
): PiAiModelsJsonModelEntry {
  return {
    ...piAiModelsJsonModelEntry(id, name),
    ...(contextWindow ? { contextWindow } : {}),
    compat: PI_AI_PROMPT_CACHE_KEY_COMPAT,
    ...normalizePiAiModelCapabilities(metadata),
  };
}
