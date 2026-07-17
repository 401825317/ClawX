import { useClientConfigStore } from '../client-config';
import type {
  ChatImageSendOptions,
  ChatSendAttachment,
  ChatSendMode,
  ChatVideoSendOptions,
  GatewayTurnPreferences,
} from './types';

/** Restrict implicit media reuse to clear requests that edit an existing image. */
export function isImageEditRequest(prompt: string): boolean {
  const normalized = prompt.trim();
  if (!normalized) return false;
  const editAction = /(?:修改|编辑|修图|美化|重绘|去掉|删除|移除|替换|改成|调整|换成|变成|edit|modify|retouch|remove|replace|change|adjust)/i;
  const addAction = /(?:添加|加上|add)/i;
  const imageTarget = /(?:图片|图像|照片|画面|这张图|这幅图|上一张图|刚才的图|这张照片|上一张照片|image|picture|photo|this image|this picture|this photo|previous image|last image)/i;
  const chinesePriorReference = /(?:这张|这幅|上一张|刚才那张|它)/;
  const englishPriorReference = /\b(?:this|that|previous|last|it)\b/i;
  const refersToExistingImage = chinesePriorReference.test(normalized) || englishPriorReference.test(normalized);
  return (editAction.test(normalized) && (imageTarget.test(normalized) || refersToExistingImage))
    || (addAction.test(normalized) && imageTarget.test(normalized) && refersToExistingImage);
}

function dimensionArea(value: string): number {
  const match = value.match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!match) return 0;
  return Number(match[1]) * Number(match[2]);
}

function strongestSize(sizes: string[] | undefined, fallback: string): string {
  const candidates = (sizes ?? []).filter(Boolean);
  if (candidates.length === 0) return fallback;
  return candidates.reduce((best, current) => (
    dimensionArea(current) > dimensionArea(best) ? current : best
  ), candidates[0]!);
}

function strongestDuration(durations: number[] | undefined, fallback: number): number {
  const candidates = (durations ?? []).filter((value) => Number.isFinite(value) && value > 0);
  if (candidates.length === 0) return fallback;
  return Math.max(...candidates);
}

function normalizeOptionValue<T extends string | number>(
  requested: T | undefined,
  allowed: T[] | undefined,
  fallback: T,
): T {
  return requested !== undefined && (allowed ?? []).includes(requested) ? requested : fallback;
}

function preferredOptionValue<T extends string | number>(
  requested: T | undefined,
  allowed: T[] | undefined,
  fallback: T,
): T {
  const options = allowed ?? [];
  if (requested !== undefined && options.includes(requested)) return requested;
  if (options.includes(fallback)) return fallback;
  return options[0] ?? fallback;
}

function parseExplicitDimension(prompt: string): string | undefined {
  const match = prompt.match(/(\d{3,4})\s*[xX×]\s*(\d{3,4})/);
  return match ? `${match[1]}x${match[2]}` : undefined;
}

function parseImageSizeHint(prompt: string, allowedSizes: string[], fallback: string): string | undefined {
  const explicit = parseExplicitDimension(prompt);
  if (explicit && allowedSizes.includes(explicit)) return explicit;
  if (/(?:4k|超清|最高|最大|最强)/i.test(prompt)) return strongestSize(allowedSizes, fallback);
  if (/(?:2k|高清)/i.test(prompt)) return allowedSizes.includes('2048x2048') ? '2048x2048' : undefined;
  if (/(?:1k|普通)/i.test(prompt)) return allowedSizes.includes('1024x1024') ? '1024x1024' : undefined;
  return undefined;
}

function parseImageQualityHint(prompt: string, allowedQualities: string[], fallback: string): string | undefined {
  if (/(?:high|高清|高质量|最高|最强|精细)/i.test(prompt)) return normalizeOptionValue('high', allowedQualities, fallback);
  if (/(?:medium|标准|中等)/i.test(prompt)) return normalizeOptionValue('medium', allowedQualities, fallback);
  if (/(?:low|草稿|低)/i.test(prompt)) return normalizeOptionValue('low', allowedQualities, fallback);
  return undefined;
}

function parseVideoSizeHint(prompt: string, allowedSizes: string[], fallback: string): string | undefined {
  const explicit = parseExplicitDimension(prompt);
  if (explicit && allowedSizes.includes(explicit)) return explicit;
  if (/(?:9\s*:\s*16|竖屏|竖版|portrait|vertical)/i.test(prompt)) {
    return allowedSizes.find((size) => {
      const match = size.match(/^(\d+)x(\d+)$/);
      return match ? Number(match[2]) > Number(match[1]) : false;
    });
  }
  if (/(?:16\s*:\s*9|横屏|横版|landscape|wide)/i.test(prompt)) {
    return allowedSizes.find((size) => {
      const match = size.match(/^(\d+)x(\d+)$/);
      return match ? Number(match[1]) > Number(match[2]) : false;
    });
  }
  if (/(?:1\s*:\s*1|方形|正方形|square)/i.test(prompt)) {
    return allowedSizes.find((size) => {
      const match = size.match(/^(\d+)x(\d+)$/);
      return match ? Number(match[1]) === Number(match[2]) : false;
    });
  }
  if (/(?:最高|最大|最强)/i.test(prompt)) return strongestSize(allowedSizes, fallback);
  return undefined;
}

function parseVideoDurationHint(prompt: string, allowedDurations: number[], fallback: number): number | undefined {
  const match = prompt.match(/(\d{1,2})\s*(?:秒|s|sec|secs|second|seconds)/i);
  if (!match) return undefined;
  return normalizeOptionValue(Number(match[1]), allowedDurations, fallback);
}

function resolveDefaultChatImageOptions(): ChatImageSendOptions {
  const options = useClientConfigStore.getState().modelOptions.image;
  const model = options.models.find((entry) => entry.id === options.defaultModel) ?? options.models[0];
  return {
    model: model?.id ?? options.defaultModel,
    size: preferredOptionValue(model?.defaultSize ?? options.defaultSize, model?.sizes, options.defaultSize),
    quality: preferredOptionValue(
      model?.defaultQuality ?? options.defaultQuality,
      model?.qualities,
      options.defaultQuality,
    ),
  };
}

function resolveDefaultChatVideoOptions(hasSourceImage = false): ChatVideoSendOptions {
  const options = useClientConfigStore.getState().modelOptions.video;
  const model = hasSourceImage
    ? options.models.find((entry) => entry.requiresImage) ?? options.models.find((entry) => entry.id === options.defaultModel) ?? options.models[0]
    : options.models.find((entry) => entry.id === options.defaultModel) ?? options.models[0];
  const size = strongestSize(model?.sizes, model?.defaultSize ?? options.defaultSize);
  const durationSeconds = strongestDuration(model?.durations, model?.defaultDurationSeconds ?? options.defaultDurationSeconds);
  return {
    model: model?.id ?? options.defaultModel,
    size: model?.sizes.includes(size) ? size : options.defaultSize,
    durationSeconds: model?.durations.includes(durationSeconds) ? durationSeconds : options.defaultDurationSeconds,
  };
}

/** Resolve image defaults, explicit overrides, and supported prompt hints. */
export function resolveChatImageOptions(
  prompt: string,
  overrides?: ChatImageSendOptions,
): ChatImageSendOptions {
  const base = { ...resolveDefaultChatImageOptions(), ...overrides };
  const options = useClientConfigStore.getState().modelOptions.image;
  const model = options.models.find((entry) => entry.id === base.model)
    ?? options.models.find((entry) => entry.id === options.defaultModel)
    ?? options.models[0];
  const sizes = model?.sizes ?? [];
  const qualities = model?.qualities ?? [];
  const strongest = resolveDefaultChatImageOptions();
  return {
    model: model?.id ?? base.model,
    size: normalizeOptionValue(parseImageSizeHint(prompt, sizes, strongest.size), sizes, base.size),
    quality: normalizeOptionValue(
      parseImageQualityHint(prompt, qualities, strongest.quality),
      qualities,
      base.quality,
    ) as ChatImageSendOptions['quality'],
  };
}

/** Resolve video defaults, source-image routing, overrides, and prompt hints. */
export function resolveChatVideoOptions(
  prompt: string,
  hasSourceImage: boolean,
  overrides?: ChatVideoSendOptions,
): ChatVideoSendOptions {
  const base = { ...resolveDefaultChatVideoOptions(hasSourceImage), ...overrides };
  const options = useClientConfigStore.getState().modelOptions.video;
  const model = options.models.find((entry) => entry.id === base.model)
    ?? options.models.find((entry) => entry.id === options.defaultModel)
    ?? options.models[0];
  const sizes = model?.sizes ?? [];
  const durations = model?.durations ?? [];
  const strongest = resolveDefaultChatVideoOptions(hasSourceImage);
  return {
    model: model?.id ?? base.model,
    size: normalizeOptionValue(parseVideoSizeHint(prompt, sizes, strongest.size), sizes, base.size),
    durationSeconds: normalizeOptionValue(
      parseVideoDurationHint(prompt, durations, strongest.durationSeconds),
      durations,
      base.durationSeconds,
    ),
  };
}

/** Build the one-turn media preference envelope consumed by the Gateway. */
export function buildGatewayTurnPreferences(params: {
  mode: ChatSendMode;
  prompt: string;
  hasSourceImage: boolean;
  imageOptions?: ChatImageSendOptions;
  videoOptions?: ChatVideoSendOptions;
  selectedArtifacts?: ChatSendAttachment[];
}): GatewayTurnPreferences {
  const selectedArtifacts = (params.selectedArtifacts ?? []).map((artifact) => ({
    filePath: artifact.stagedPath,
    mimeType: artifact.mimeType,
    title: artifact.fileName,
  }));
  if (params.mode === 'image') {
    const image = params.imageOptions ?? resolveChatImageOptions(params.prompt);
    return {
      mode: 'image',
      image: {
        model: image.model,
        size: image.size,
        quality: image.quality === 'low' || image.quality === 'medium' || image.quality === 'high'
          ? image.quality
          : undefined,
      },
      ...(selectedArtifacts.length > 0 ? { selectedArtifacts } : {}),
    };
  }
  if (params.mode === 'video') {
    return {
      mode: 'video',
      video: params.videoOptions ?? resolveChatVideoOptions(params.prompt, params.hasSourceImage),
      ...(selectedArtifacts.length > 0 ? { selectedArtifacts } : {}),
    };
  }
  return selectedArtifacts.length > 0
    ? { mode: 'chat', selectedArtifacts }
    : { mode: 'chat' };
}
