import { JUNFEIAI_VIDEO_GENERATION_TIMEOUT_MS } from '../../shared/junfeiai-endpoints';

export const CLAWX_OPENAI_VIDEO_PROVIDER_KEY = 'openai';
export const CLAWX_OPENAI_VIDEO_DEFAULT_MODEL = 'grok-image-video';
export const CLAWX_OPENAI_VIDEO_15_MODEL = 'grok-video-1.5';
export const CLAWX_OPENAI_VIDEO_DEFAULT_REF = `${CLAWX_OPENAI_VIDEO_PROVIDER_KEY}/${CLAWX_OPENAI_VIDEO_DEFAULT_MODEL}`;
export const CLAWX_OPENAI_VIDEO_DEFAULT_TIMEOUT_MS = JUNFEIAI_VIDEO_GENERATION_TIMEOUT_MS;
export const CLAWX_OPENAI_VIDEO_SUPPORTED_DURATION_SECONDS = [6, 10, 15] as const;
export const CLAWX_OPENAI_VIDEO_FALLBACK_DURATION_SECONDS = CLAWX_OPENAI_VIDEO_SUPPORTED_DURATION_SECONDS[0];

export type ClawXOpenAiVideoMode = 'text-to-video' | 'image-to-video';

export interface ClawXOpenAiVideoModelOption {
  id: string;
  label: string;
  description: string;
  verified: boolean;
  modes: ClawXOpenAiVideoMode[];
}

export const CLAWX_OPENAI_VIDEO_MODEL_OPTIONS: ClawXOpenAiVideoModelOption[] = [
  {
    id: CLAWX_OPENAI_VIDEO_DEFAULT_MODEL,
    label: 'Grok Imagine',
    description: 'General video generation model for text, image, or video to video.',
    verified: true,
    modes: ['text-to-video', 'image-to-video'],
  },
  {
    id: CLAWX_OPENAI_VIDEO_15_MODEL,
    label: 'Grok Imagine 1.5',
    description: 'Image-to-video model. Requires exactly one reference image.',
    verified: true,
    modes: ['image-to-video'],
  },
];

export const CLAWX_OPENAI_VIDEO_MODEL_IDS = CLAWX_OPENAI_VIDEO_MODEL_OPTIONS.map((model) => model.id);

export const CLAWX_OPENAI_VIDEO_MODEL_ALIASES: Record<string, string> = {
  'grok-imagine-video': CLAWX_OPENAI_VIDEO_DEFAULT_MODEL,
  'grok-imagine-video-1.5': CLAWX_OPENAI_VIDEO_15_MODEL,
  'grok-imagine-video-1.5-preview': CLAWX_OPENAI_VIDEO_15_MODEL,
};

export function normalizeClawXOpenAiVideoModelId(raw?: string | null): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  const modelId = trimmed.includes('/') ? trimmed.slice(trimmed.indexOf('/') + 1).trim() : trimmed;
  const normalizedAlias = CLAWX_OPENAI_VIDEO_MODEL_ALIASES[modelId] ?? modelId;
  return CLAWX_OPENAI_VIDEO_MODEL_IDS.includes(normalizedAlias)
    ? normalizedAlias
    : CLAWX_OPENAI_VIDEO_DEFAULT_MODEL;
}

export function isClawXOpenAiVideoModelId(raw?: string | null): boolean {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  const modelId = trimmed.includes('/') ? trimmed.slice(trimmed.indexOf('/') + 1).trim() : trimmed;
  const normalizedAlias = CLAWX_OPENAI_VIDEO_MODEL_ALIASES[modelId] ?? modelId;
  return CLAWX_OPENAI_VIDEO_MODEL_IDS.includes(normalizedAlias);
}

export function isClawXOpenAiVideoModelRef(raw?: string | null): boolean {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed.startsWith(`${CLAWX_OPENAI_VIDEO_PROVIDER_KEY}/`)) {
    return false;
  }
  return isClawXOpenAiVideoModelId(trimmed);
}

export function normalizeClawXOpenAiVideoDurationSeconds(raw?: number | null): number {
  const requested = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.max(CLAWX_OPENAI_VIDEO_FALLBACK_DURATION_SECONDS, Math.round(raw))
    : CLAWX_OPENAI_VIDEO_FALLBACK_DURATION_SECONDS;
  return CLAWX_OPENAI_VIDEO_SUPPORTED_DURATION_SECONDS.reduce((nearest, candidate) => (
    Math.abs(candidate - requested) < Math.abs(nearest - requested) ? candidate : nearest
  ));
}

export function orderedClawXOpenAiVideoModelIds(primary?: string | null): string[] {
  const normalizedPrimary = normalizeClawXOpenAiVideoModelId(primary);
  return [
    normalizedPrimary,
    ...CLAWX_OPENAI_VIDEO_MODEL_IDS.filter((modelId) => modelId !== normalizedPrimary),
  ];
}

export function selectClawXOpenAiVideoModelIdForInput(imageCount: number): string {
  return imageCount > 0 ? CLAWX_OPENAI_VIDEO_15_MODEL : CLAWX_OPENAI_VIDEO_DEFAULT_MODEL;
}
