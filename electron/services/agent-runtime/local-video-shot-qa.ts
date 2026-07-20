import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { getGeneratedMediaOutputDir } from '../../utils/generated-media-store';
import type { HostCapabilityTaskContext } from './host-capability-registry';
import { assessLocalMediaRuntime, resolveLocalMediaTools, resolveManagedLocalMediaFile } from './local-media-runtime';

export type LocalVideoShotQaInput = {
  sourcePath: string;
  expectedDurationSeconds?: number;
  durationToleranceSeconds: number;
  expectedWidth?: number;
  expectedHeight?: number;
  requireAudio: boolean;
  includeSourceArtifact: boolean;
  sampleFrameCount: number;
  blackFrameLumaThreshold: number;
  freezeFrameDifferenceThreshold: number;
};

type DetailedMediaMetadata = {
  durationSeconds?: number;
  sizeBytes?: number;
  bitRate?: number;
  containerFormat?: string;
  hasVideo: boolean;
  hasAudio: boolean;
  video?: {
    codec?: string;
    width?: number;
    height?: number;
    frameRate?: string;
    pixelFormat?: string;
    frameCount?: number;
  };
  audio?: {
    codec?: string;
    sampleRate?: number;
    channels?: number;
    bitRate?: number;
  };
};

type SampleFrame = {
  index: number;
  timestampSeconds: number;
  filePath: string;
  averageLuma: number;
  signature: Uint8Array;
};

const activeProcesses = new Map<string, ChildProcessWithoutNullStreams>();

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 4_096) throw new Error(`${label} must be a non-empty path`);
  return value.trim();
}

function optionalNumber(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be from ${minimum} to ${maximum}`);
  }
  return value;
}

function optionalEvenInteger(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum || (value as number) % 2 !== 0) {
    throw new Error(`${label} must be an even integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function integer(value: unknown, label: string, minimum: number, maximum: number, fallback: number): number {
  const normalized = value === undefined ? fallback : value;
  if (!Number.isInteger(normalized) || (normalized as number) < minimum || (normalized as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return normalized as number;
}

function number(value: unknown, label: string, minimum: number, maximum: number, fallback: number): number {
  const normalized = value === undefined ? fallback : value;
  if (typeof normalized !== 'number' || !Number.isFinite(normalized) || normalized < minimum || normalized > maximum) {
    throw new Error(`${label} must be from ${minimum} to ${maximum}`);
  }
  return normalized;
}

export function normalizeLocalVideoShotQaInput(value: unknown): LocalVideoShotQaInput {
  const input = record(value, 'local.video.shot.qa input');
  return {
    sourcePath: requiredPath(input.sourcePath, 'local.video.shot.qa sourcePath'),
    expectedDurationSeconds: optionalNumber(input.expectedDurationSeconds, 'local.video.shot.qa expectedDurationSeconds', 0.05, 7_200),
    durationToleranceSeconds: number(input.durationToleranceSeconds, 'local.video.shot.qa durationToleranceSeconds', 0.05, 30, 0.35),
    expectedWidth: optionalEvenInteger(input.expectedWidth, 'local.video.shot.qa expectedWidth', 2, 7_680),
    expectedHeight: optionalEvenInteger(input.expectedHeight, 'local.video.shot.qa expectedHeight', 2, 4_320),
    requireAudio: input.requireAudio === true,
    includeSourceArtifact: input.includeSourceArtifact === true,
    sampleFrameCount: integer(input.sampleFrameCount, 'local.video.shot.qa sampleFrameCount', 3, 12, 6),
    blackFrameLumaThreshold: number(input.blackFrameLumaThreshold, 'local.video.shot.qa blackFrameLumaThreshold', 0, 80, 16),
    freezeFrameDifferenceThreshold: number(input.freezeFrameDifferenceThreshold, 'local.video.shot.qa freezeFrameDifferenceThreshold', 0, 32, 2),
  };
}

async function managedVideoPath(sourcePath: string): Promise<string> {
  return await resolveManagedLocalMediaFile(sourcePath, 'Shot video');
}

async function runProcess(taskId: string, executable: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'pipe', windowsHide: true });
    activeProcesses.set(taskId, child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      activeProcesses.delete(taskId);
      reject(error);
    });
    child.once('close', (code, signal) => {
      activeProcesses.delete(taskId);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(signal ? `Video shot QA stopped by ${signal}` : (stderr.trim() || `Video shot QA exited with code ${code}`)));
    });
  });
}

async function probeDetailedMedia(ffprobe: string, sourcePath: string): Promise<DetailedMediaMetadata> {
  const { stdout } = await runProcess('local-video-shot-qa-probe', ffprobe, [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', sourcePath,
  ]);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; size?: string; bit_rate?: string; format_name?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      pix_fmt?: string;
      nb_frames?: string;
      sample_rate?: string;
      channels?: number;
      bit_rate?: string;
    }>;
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  const numeric = (value: string | undefined): number | undefined => {
    const result = Number(value);
    return Number.isFinite(result) ? result : undefined;
  };
  return {
    durationSeconds: numeric(parsed.format?.duration),
    sizeBytes: numeric(parsed.format?.size),
    bitRate: numeric(parsed.format?.bit_rate),
    containerFormat: parsed.format?.format_name,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    ...(video ? {
      video: {
        codec: video.codec_name,
        width: video.width,
        height: video.height,
        frameRate: video.avg_frame_rate,
        pixelFormat: video.pix_fmt,
        frameCount: numeric(video.nb_frames),
      },
    } : {}),
    ...(audio ? {
      audio: {
        codec: audio.codec_name,
        sampleRate: numeric(audio.sample_rate),
        channels: audio.channels,
        bitRate: numeric(audio.bit_rate),
      },
    } : {}),
  };
}

async function sampleFrameStats(filePath: string): Promise<{ averageLuma: number; signature: Uint8Array }> {
  const { data, info } = await sharp(filePath)
    .resize(64, 64, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let lumaTotal = 0;
  const signature = new Uint8Array(64 * 64 * 3);
  for (let index = 0; index < 64 * 64; index += 1) {
    const offset = index * info.channels;
    const signatureOffset = index * 3;
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? red;
    const blue = data[offset + 2] ?? red;
    signature[signatureOffset] = red;
    signature[signatureOffset + 1] = green;
    signature[signatureOffset + 2] = blue;
    lumaTotal += red * 0.2126 + green * 0.7152 + blue * 0.0722;
  }
  return { averageLuma: lumaTotal / (64 * 64), signature };
}

function meanSignatureDifference(left: Uint8Array, right: Uint8Array): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index]! - right[index]!);
  return total / left.length;
}

function sampleTimestamps(durationSeconds: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => Number((((index + 1) * durationSeconds) / (count + 1)).toFixed(4)));
}

async function createContactSheet(frames: SampleFrame[], outputPath: string): Promise<void> {
  const thumbWidth = 320;
  const thumbHeight = 180;
  const columns = Math.min(3, frames.length);
  const rows = Math.ceil(frames.length / columns);
  const thumbnails = await Promise.all(frames.map(async (frame) => await sharp(frame.filePath)
    .resize(thumbWidth, thumbHeight, { fit: 'contain', background: { r: 20, g: 24, b: 32, alpha: 1 } })
    .png()
    .toBuffer()));
  await sharp({
    create: {
      width: columns * thumbWidth,
      height: rows * thumbHeight,
      channels: 4,
      background: { r: 20, g: 24, b: 32, alpha: 1 },
    },
  }).composite(thumbnails.map((input, index) => ({
    input,
    left: (index % columns) * thumbWidth,
    top: Math.floor(index / columns) * thumbHeight,
  }))).png().toFile(outputPath);
}

function metadataExpectationFailures(input: LocalVideoShotQaInput, metadata: DetailedMediaMetadata): string[] {
  const failures: string[] = [];
  if (!metadata.hasVideo) failures.push('Video track is missing.');
  if (!metadata.durationSeconds) failures.push('Readable video duration is missing.');
  if (input.expectedDurationSeconds !== undefined && metadata.durationSeconds !== undefined
    && Math.abs(metadata.durationSeconds - input.expectedDurationSeconds) > input.durationToleranceSeconds) {
    failures.push(`Duration is ${metadata.durationSeconds.toFixed(3)}s; expected ${input.expectedDurationSeconds.toFixed(3)}s within ${input.durationToleranceSeconds.toFixed(3)}s.`);
  }
  if (input.expectedWidth !== undefined && metadata.video?.width !== input.expectedWidth) failures.push(`Width is ${metadata.video?.width ?? '?'}; expected ${input.expectedWidth}.`);
  if (input.expectedHeight !== undefined && metadata.video?.height !== input.expectedHeight) failures.push(`Height is ${metadata.video?.height ?? '?'}; expected ${input.expectedHeight}.`);
  if (input.requireAudio && !metadata.hasAudio) failures.push('Audio track is required but missing.');
  return failures;
}

export async function assessLocalVideoShotQaAvailability() {
  return await assessLocalMediaRuntime();
}

export async function runLocalVideoShotQa(context: HostCapabilityTaskContext): Promise<void> {
  const input = normalizeLocalVideoShotQaInput(context.input);
  const sourcePath = await managedVideoPath(input.sourcePath);
  const tools = await resolveLocalMediaTools();
  if (!tools) throw new Error(`Packaged FFmpeg/ffprobe runtime is missing for ${process.platform}-${process.arch}.`);
  const metadata = await probeDetailedMedia(tools.ffprobe, sourcePath);
  const expectationFailures = metadataExpectationFailures(input, metadata);
  if (expectationFailures.length > 0) {
    await context.update({
      status: 'blocked',
      checkpoint: { phase: 'metadata_rejected', sourcePath, metadata, expectationFailures, mediaRuntime: tools.source },
      error: `Shot media requirements were not met: ${expectationFailures.join(' ')}`,
      progress: { completed: 1, total: 3, detail: '镜头媒体规格未通过，等待重新生成。' },
      verifications: [{
        id: `verification:host-task:${context.task.taskId}:media.metadata`,
        status: 'failed',
        kind: 'media.metadata',
        required: true,
        severity: 'blocking',
        title: '验证镜头媒体规格',
        detail: expectationFailures.join(' '),
        source: 'local.video.shot.qa',
        evidence: JSON.stringify(metadata),
      }],
    });
    return;
  }

  const outputDir = getGeneratedMediaOutputDir(path.join('video-shot-qa', context.task.taskId));
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const timestamps = sampleTimestamps(metadata.durationSeconds!, input.sampleFrameCount);
  await context.update({
    status: 'running',
    checkpoint: { phase: 'sampling', sourcePath, metadata, timestamps, mediaRuntime: tools.source },
    progress: { completed: 1, total: 3, detail: `正在抽取 ${timestamps.length} 个镜头样本帧。` },
  });
  const frames: SampleFrame[] = [];
  for (const [index, timestampSeconds] of timestamps.entries()) {
    const filePath = path.join(outputDir, `sample-${String(index + 1).padStart(2, '0')}-${timestampSeconds.toFixed(2)}s.jpg`);
    await runProcess(context.task.taskId, tools.ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error', '-ss', timestampSeconds.toFixed(4), '-i', sourcePath,
      '-frames:v', '1', '-vf', "scale='min(960,iw)':-2", '-q:v', '3', filePath,
    ]);
    const stats = await sampleFrameStats(filePath);
    frames.push({ index: index + 1, timestampSeconds, filePath, ...stats });
  }
  const contactSheetPath = path.join(outputDir, 'contact-sheet.png');
  await createContactSheet(frames, contactSheetPath);
  const blackFrames = frames.filter((frame) => frame.averageLuma <= input.blackFrameLumaThreshold);
  const repeatedPairs = frames.slice(1).flatMap((frame, index) => {
    const previous = frames[index]!;
    const meanRgbDifference = meanSignatureDifference(previous.signature, frame.signature);
    return meanRgbDifference <= input.freezeFrameDifferenceThreshold ? [{
      fromFrame: previous.index,
      toFrame: frame.index,
      fromTimestampSeconds: previous.timestampSeconds,
      toTimestampSeconds: frame.timestampSeconds,
      meanRgbDifference,
    }] : [];
  });
  const possibleFreeze = repeatedPairs.length >= Math.max(2, Math.ceil((frames.length - 1) / 2));
  const qualitySignals = {
    blackFrameCount: blackFrames.length,
    blackFrameRatio: blackFrames.length / frames.length,
    blackFrameLumaThreshold: input.blackFrameLumaThreshold,
    possibleFreeze,
    repeatedPairCount: repeatedPairs.length,
    freezeFrameDifferenceThreshold: input.freezeFrameDifferenceThreshold,
    repeatedPairs,
    samples: frames.map((frame) => ({
      index: frame.index,
      timestampSeconds: frame.timestampSeconds,
      averageLuma: Number(frame.averageLuma.toFixed(2)),
      filePath: frame.filePath,
    })),
  };
  const contactSheetStat = await fs.stat(contactSheetPath);
  const contactArtifactId = `artifact:host-task:${context.task.taskId}:contact-sheet`;
  const sourceArtifactId = `artifact:host-task:${context.task.taskId}:source-video`;
  const verificationArtifactId = input.includeSourceArtifact ? sourceArtifactId : contactArtifactId;
  const sourceArtifact = input.includeSourceArtifact ? [{
    id: sourceArtifactId,
    kind: 'video',
    title: path.basename(sourcePath),
    filePath: sourcePath,
    mimeType: 'video/mp4',
    sizeBytes: metadata.sizeBytes,
    stepId: `host-task:${context.task.taskId}`,
    sourceToolCallId: context.task.toolCallId,
    source: 'local.video.shot.qa',
  }] : [];
  const frameArtifacts = await Promise.all(frames.map(async (frame) => {
    const fileStat = await fs.stat(frame.filePath);
    return {
      id: `artifact:host-task:${context.task.taskId}:sample:${frame.index}`,
      kind: 'image',
      title: path.basename(frame.filePath),
      filePath: frame.filePath,
      mimeType: 'image/jpeg',
      sizeBytes: fileStat.size,
      stepId: `host-task:${context.task.taskId}`,
      sourceToolCallId: context.task.toolCallId,
      source: 'local.video.shot.qa',
    };
  }));
  const hasQualityWarning = blackFrames.length > 0 || possibleFreeze;
  const qaDetail = JSON.stringify({ metadata, qualitySignals });
  await context.update({
    status: 'succeeded',
    checkpoint: {
      phase: 'completed',
      sourcePath,
      metadata,
      qualitySignals,
      contactSheetPath,
      mediaRuntime: tools.source,
    },
    progress: {
      completed: 3,
      total: 3,
      detail: hasQualityWarning
        ? '镜头规格已通过；已标记黑帧或静帧信号，等待语义画面复核。'
        : '镜头规格、样本帧与确定性质量检查已完成。',
    },
    artifacts: [...sourceArtifact, {
      id: contactArtifactId,
      kind: 'image',
      title: 'Shot QA contact sheet',
      filePath: contactSheetPath,
      mimeType: 'image/png',
      sizeBytes: contactSheetStat.size,
      stepId: `host-task:${context.task.taskId}`,
      sourceToolCallId: context.task.toolCallId,
      source: 'local.video.shot.qa',
    }, ...frameArtifacts],
    verifications: [{
      id: `verification:${verificationArtifactId}:media.metadata`,
      status: 'passed',
      kind: 'media.metadata',
      required: true,
      severity: 'info',
      title: '验证镜头媒体规格',
      detail: JSON.stringify(metadata),
      artifactId: verificationArtifactId,
      targetId: verificationArtifactId,
      evidence: JSON.stringify({ expectedDurationSeconds: input.expectedDurationSeconds, expectedWidth: input.expectedWidth, expectedHeight: input.expectedHeight, requireAudio: input.requireAudio }),
      source: 'local.video.shot.qa',
    }, {
      id: `verification:${verificationArtifactId}:shot-qa`,
      status: 'passed',
      kind: 'media.shot.qa',
      required: true,
      severity: hasQualityWarning ? 'warning' : 'info',
      title: '抽帧检查黑帧与静帧信号',
      detail: qaDetail,
      artifactId: verificationArtifactId,
      targetId: verificationArtifactId,
      evidence: contactSheetPath,
      source: 'local.video.shot.qa',
    }],
  });
}

export async function cancelLocalVideoShotQa(context: HostCapabilityTaskContext & { reason: string }): Promise<void> {
  activeProcesses.get(context.task.taskId)?.kill('SIGTERM');
  await context.update({
    status: 'cancelled',
    checkpoint: { phase: 'cancelled' },
    error: context.reason,
    progress: { detail: '镜头质量检查已取消。' },
  });
}
