import type { AcpVideoGenerationOptions } from './acp-chat/types';

export type VideoGenerationModelContract = {
  id: string;
  modes: readonly string[];
  sizes: readonly string[];
  aspectRatios: readonly string[];
  resolutions: readonly string[];
  durations: readonly number[];
  defaultSize?: string;
  defaultAspectRatio?: string;
  defaultResolution?: string;
  defaultDurationSeconds?: number;
};

export type VideoGenerationDefaults = {
  defaultSize?: string;
  defaultAspectRatio?: string;
  defaultResolution?: string;
  defaultDurationSeconds?: number;
};

export type ResolvedVideoGenerationOptions = Omit<AcpVideoGenerationOptions, 'resolution'> & {
  resolution: string;
};

export type ExactVideoSize = {
  size: string;
  width: number;
  height: number;
  aspectRatio: string;
  resolution: string;
};

export type VideoGenerationVariant = ExactVideoSize & {
  resolution: string;
};

export type VideoGenerationContractIssue =
  | 'model'
  | 'mode'
  | 'size'
  | 'aspectRatio'
  | 'resolution'
  | 'combination'
  | 'durationSeconds';

export type VideoGenerationValidationResult =
  | { ok: true; options: ResolvedVideoGenerationOptions }
  | { ok: false; issue: VideoGenerationContractIssue };

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1;
}

export function parseExactVideoSize(value: unknown): ExactVideoSize | null {
  const size = nonEmptyString(value);
  if (!size) return null;
  const match = /^(\d{1,5})x(\d{1,5})$/u.exec(size);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  const divisor = greatestCommonDivisor(width, height);
  return {
    size,
    width,
    height,
    aspectRatio: `${width / divisor}:${height / divisor}`,
    resolution: `${Math.min(width, height)}P`,
  };
}

export function aspectRatioForExactVideoSize(value: unknown): string | null {
  return parseExactVideoSize(value)?.aspectRatio ?? null;
}

export function resolutionForExactVideoSize(value: unknown): string | null {
  return parseExactVideoSize(value)?.resolution ?? null;
}

/** Opaque server labels are catalog-owned; numeric labels must match the exact short edge. */
export function videoResolutionMatchesExactSize(resolutionValue: unknown, sizeValue: unknown): boolean {
  const resolution = nonEmptyString(resolutionValue);
  const size = parseExactVideoSize(sizeValue);
  if (!resolution || !size) return false;
  if (!/^\d+P$/iu.test(resolution)) return true;
  return resolution.toUpperCase() === size.resolution.toUpperCase();
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.flatMap((value) => {
    const normalized = nonEmptyString(value);
    return normalized ? [normalized] : [];
  }))];
}

/** Enumerate only combinations the exact dynamic model entry can generate. */
export function listVideoGenerationVariants(
  model: VideoGenerationModelContract,
): VideoGenerationVariant[] {
  const declaredAspectRatios = new Set(uniqueStrings(model.aspectRatios));
  const declaredResolutions = uniqueStrings(model.resolutions);
  const seen = new Set<string>();
  const variants: VideoGenerationVariant[] = [];

  for (const rawSize of model.sizes) {
    const exactSize = parseExactVideoSize(rawSize);
    if (!exactSize || !declaredAspectRatios.has(exactSize.aspectRatio)) continue;
    for (const resolution of declaredResolutions) {
      if (!videoResolutionMatchesExactSize(resolution, exactSize.size)) continue;
      const key = `${exactSize.size}\u0000${exactSize.aspectRatio}\u0000${resolution}`;
      if (seen.has(key)) continue;
      seen.add(key);
      variants.push({ ...exactSize, resolution });
    }
  }

  return variants;
}

function normalizedDuration(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Strict validation for the Renderer-to-Main queue boundary. No field is repaired here. */
export function validateVideoGenerationOptions(
  value: unknown,
  model: VideoGenerationModelContract,
): VideoGenerationValidationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issue: 'combination' };
  }
  const input = value as Record<string, unknown>;
  const modelId = nonEmptyString(input.modelId);
  if (!modelId || modelId !== model.id) return { ok: false, issue: 'model' };
  const mode = nonEmptyString(input.mode);
  if (!mode || !model.modes.includes(mode)) return { ok: false, issue: 'mode' };
  const size = nonEmptyString(input.size);
  if (!size || !model.sizes.includes(size) || !parseExactVideoSize(size)) {
    return { ok: false, issue: 'size' };
  }
  const aspectRatio = nonEmptyString(input.aspectRatio);
  if (!aspectRatio || !model.aspectRatios.includes(aspectRatio)) {
    return { ok: false, issue: 'aspectRatio' };
  }
  const resolution = nonEmptyString(input.resolution);
  if (!resolution || !model.resolutions.includes(resolution)) {
    return { ok: false, issue: 'resolution' };
  }
  const variantSupported = listVideoGenerationVariants(model).some((variant) => (
    variant.size === size
    && variant.aspectRatio === aspectRatio
    && variant.resolution === resolution
  ));
  if (!variantSupported) return { ok: false, issue: 'combination' };
  const durationSeconds = normalizedDuration(input.durationSeconds);
  if (!durationSeconds || !model.durations.includes(durationSeconds)) {
    return { ok: false, issue: 'durationSeconds' };
  }
  return {
    ok: true,
    options: { modelId, size, mode, aspectRatio, resolution, durationSeconds },
  };
}

type VideoGenerationPreference = Partial<AcpVideoGenerationOptions>;

function variantMatches(
  variant: VideoGenerationVariant,
  preference: Pick<VideoGenerationPreference, 'size' | 'aspectRatio' | 'resolution'>,
): boolean {
  const size = nonEmptyString(preference.size);
  const aspectRatio = nonEmptyString(preference.aspectRatio);
  const resolution = nonEmptyString(preference.resolution);
  return (!size || variant.size === size)
    && (!aspectRatio || variant.aspectRatio === aspectRatio)
    && (!resolution || variant.resolution === resolution);
}

function hasVariantPreference(
  preference: Pick<VideoGenerationPreference, 'size' | 'aspectRatio' | 'resolution'>,
): boolean {
  return Boolean(
    nonEmptyString(preference.size)
    || nonEmptyString(preference.aspectRatio)
    || nonEmptyString(preference.resolution),
  );
}

function pickVariant(
  variants: readonly VideoGenerationVariant[],
  preferences: Array<Pick<VideoGenerationPreference, 'size' | 'aspectRatio' | 'resolution'>>,
): VideoGenerationVariant {
  for (const preference of preferences) {
    if (!hasVariantPreference(preference)) continue;
    const match = variants.find((variant) => variantMatches(variant, preference));
    if (match) return match;
  }
  return variants[0];
}

function pickDuration(
  model: VideoGenerationModelContract,
  preferred: unknown,
  defaults: VideoGenerationDefaults,
): number | null {
  for (const candidate of [preferred, model.defaultDurationSeconds, defaults.defaultDurationSeconds]) {
    const duration = normalizedDuration(candidate);
    if (duration && model.durations.includes(duration)) return duration;
  }
  return model.durations.find((duration) => normalizedDuration(duration) !== null) ?? null;
}

/** Resolve a complete composer selection from one dynamic model entry. */
export function resolveVideoGenerationOptions(
  model: VideoGenerationModelContract,
  mode: string,
  preferred: VideoGenerationPreference | null | undefined,
  defaults: VideoGenerationDefaults = {},
): ResolvedVideoGenerationOptions | null {
  if (!model.modes.includes(mode)) return null;
  const variants = listVideoGenerationVariants(model);
  if (variants.length === 0) return null;

  const preferredSize = nonEmptyString(preferred?.size) ?? undefined;
  const preferredAspectRatio = nonEmptyString(preferred?.aspectRatio) ?? undefined;
  const preferredResolution = nonEmptyString(preferred?.resolution) ?? undefined;
  const variant = pickVariant(variants, [
    { size: preferredSize, aspectRatio: preferredAspectRatio, resolution: preferredResolution },
    { size: preferredSize, aspectRatio: preferredAspectRatio },
    { size: preferredSize, resolution: preferredResolution },
    { size: preferredSize },
    { aspectRatio: preferredAspectRatio, resolution: preferredResolution },
    { aspectRatio: preferredAspectRatio },
    { resolution: preferredResolution },
    {
      size: model.defaultSize,
      aspectRatio: model.defaultAspectRatio,
      resolution: model.defaultResolution,
    },
    { size: model.defaultSize },
    { aspectRatio: model.defaultAspectRatio, resolution: model.defaultResolution },
    {
      size: defaults.defaultSize,
      aspectRatio: defaults.defaultAspectRatio,
      resolution: defaults.defaultResolution,
    },
    { size: defaults.defaultSize },
    { aspectRatio: defaults.defaultAspectRatio, resolution: defaults.defaultResolution },
  ]);
  const durationSeconds = pickDuration(model, preferred?.durationSeconds, defaults);
  if (!durationSeconds) return null;
  return {
    modelId: model.id,
    size: variant.size,
    mode,
    aspectRatio: variant.aspectRatio,
    resolution: variant.resolution,
    durationSeconds,
  };
}

export function videoAspectRatiosForModel(model: VideoGenerationModelContract): string[] {
  return [...new Set(listVideoGenerationVariants(model).map((variant) => variant.aspectRatio))];
}

export function videoResolutionsForAspectRatio(
  model: VideoGenerationModelContract,
  aspectRatio: string,
): string[] {
  return [...new Set(listVideoGenerationVariants(model)
    .filter((variant) => variant.aspectRatio === aspectRatio)
    .map((variant) => variant.resolution))];
}
