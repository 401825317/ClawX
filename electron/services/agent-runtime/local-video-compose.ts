import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getGeneratedMediaOutputDir } from '../../utils/generated-media-store';
import type { HostCapabilityTaskContext } from './host-capability-registry';
import {
  assessLocalMediaRuntime,
  DEFAULT_NARRATION_VOICE,
  probeMediaFile,
  resolveManagedLocalMediaFile,
  resolveLocalMediaTools,
  synthesizeNarration,
  type ProbedMediaMetadata,
} from './local-media-runtime';

type ComposeInput = {
  segments: string[];
  filename: string;
  targetDurationSeconds?: number;
  width?: number;
  height?: number;
  narrationText?: string;
  voice: string;
  keepOriginalAudio: boolean;
};

const activeProcesses = new Map<string, ChildProcessWithoutNullStreams>();

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('local.video.compose input must be an object');
  return value as Record<string, unknown>;
}

function evenPositiveInteger(value: unknown, label: string, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum || (value as number) % 2 !== 0) {
    throw new Error(`${label} must be an even integer from 2 to ${maximum}`);
  }
  return value as number;
}

function normalizeInput(value: unknown): ComposeInput {
  const input = record(value);
  if (!Array.isArray(input.segments) || input.segments.length < 2 || input.segments.length > 120) {
    throw new Error('local.video.compose input.segments must contain 2 to 120 files');
  }
  const segments = input.segments.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) throw new Error('local.video.compose segment paths must be strings');
    return entry.trim();
  });
  const filename = typeof input.filename === 'string' && input.filename.trim()
    ? input.filename.trim().replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 180)
    : 'uclaw-composed-video.mp4';
  const targetDurationSeconds = typeof input.targetDurationSeconds === 'number' && Number.isFinite(input.targetDurationSeconds)
    ? input.targetDurationSeconds
    : undefined;
  if (targetDurationSeconds !== undefined && (targetDurationSeconds <= 0 || targetDurationSeconds > 7_200)) {
    throw new Error('local.video.compose targetDurationSeconds must be from 0 to 7200');
  }
  const narrationText = typeof input.narrationText === 'string' && input.narrationText.trim()
    ? input.narrationText.trim().slice(0, 16_000)
    : undefined;
  return {
    segments,
    filename: filename.toLowerCase().endsWith('.mp4') ? filename : `${filename}.mp4`,
    targetDurationSeconds,
    width: evenPositiveInteger(input.width, 'local.video.compose width', 7_680),
    height: evenPositiveInteger(input.height, 'local.video.compose height', 4_320),
    narrationText,
    voice: typeof input.voice === 'string' && input.voice.trim() ? input.voice.trim().slice(0, 80) : DEFAULT_NARRATION_VOICE,
    keepOriginalAudio: input.keepOriginalAudio !== false,
  };
}

async function managedSegmentPaths(segments: string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const segment of segments) {
    resolved.push(await resolveManagedLocalMediaFile(segment, 'Video segment'));
  }
  return resolved;
}

async function runProcess(taskId: string, executable: string, args: string[], stdin?: string): Promise<{ stdout: string; stderr: string }> {
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
      else reject(new Error(signal ? `Video composition stopped by ${signal}` : (stderr.trim() || `Video composition exited with code ${code}`)));
    });
    child.stdin.end(stdin);
  });
}

function concatFilter(params: {
  metadata: ProbedMediaMetadata[];
  width: number;
  height: number;
  durationSeconds: number;
  keepOriginalAudio: boolean;
  narrationInputIndex?: number;
}): { filter: string; videoLabel: string; audioLabel?: string } {
  const filters: string[] = [];
  const videoLabels: string[] = [];
  for (let index = 0; index < params.metadata.length; index += 1) {
    const label = `v${index}`;
    filters.push(`[${index}:v:0]scale=${params.width}:${params.height}:force_original_aspect_ratio=increase,crop=${params.width}:${params.height},setsar=1,fps=30,format=yuv420p[${label}]`);
    videoLabels.push(`[${label}]`);
  }
  const videoLabel = 'video';
  filters.push(`${videoLabels.join('')}concat=n=${videoLabels.length}:v=1:a=0[${videoLabel}]`);

  let originalAudioLabel: string | undefined;
  if (params.keepOriginalAudio) {
    const audioLabels: string[] = [];
    params.metadata.forEach((metadata, index) => {
      const label = `a${index}`;
      const duration = Math.max(0.001, metadata.durationSeconds ?? 0);
      filters.push(metadata.hasAudio
        ? `[${index}:a:0]aresample=48000,atrim=duration=${duration.toFixed(6)},asetpts=PTS-STARTPTS[${label}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${duration.toFixed(6)},asetpts=PTS-STARTPTS[${label}]`);
      audioLabels.push(`[${label}]`);
    });
    originalAudioLabel = 'originalAudio';
    filters.push(`${audioLabels.join('')}concat=n=${audioLabels.length}:v=0:a=1[${originalAudioLabel}]`);
  }

  let narrationLabel: string | undefined;
  if (params.narrationInputIndex !== undefined) {
    narrationLabel = 'narration';
    filters.push(`[${params.narrationInputIndex}:a:0]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=duration=${params.durationSeconds.toFixed(6)},asetpts=PTS-STARTPTS[${narrationLabel}]`);
  }

  let audioLabel = originalAudioLabel ?? narrationLabel;
  if (originalAudioLabel && narrationLabel) {
    audioLabel = 'mixedAudio';
    filters.push(`[${originalAudioLabel}]volume=0.35[originalQuiet];[originalQuiet][${narrationLabel}]amix=inputs=2:duration=longest:dropout_transition=0[${audioLabel}]`);
  }
  return { filter: filters.join(';'), videoLabel, audioLabel };
}

export async function assessLocalVideoComposeAvailability() {
  return await assessLocalMediaRuntime();
}

export async function runLocalVideoCompose(context: HostCapabilityTaskContext): Promise<void> {
  const input = normalizeInput(context.input);
  const segments = await managedSegmentPaths(input.segments);
  const tools = await resolveLocalMediaTools();
  if (!tools) throw new Error(`Packaged FFmpeg/ffprobe runtime is missing for ${process.platform}-${process.arch}.`);
  const metadata = await Promise.all(segments.map((segment) => probeMediaFile(tools.ffprobe, segment)));
  if (metadata.some((entry) => !entry.hasVideo || !entry.durationSeconds)) throw new Error('Every local.video.compose segment must contain a readable video track and duration.');
  const totalDurationSeconds = metadata.reduce((total, entry) => total + (entry.durationSeconds ?? 0), 0);
  const durationSeconds = input.targetDurationSeconds ?? totalDurationSeconds;
  if (durationSeconds > totalDurationSeconds + 0.05) {
    throw new Error(`Video segments total ${totalDurationSeconds.toFixed(3)}s, below target ${durationSeconds}s`);
  }
  const firstVideo = metadata[0]!;
  const width = input.width ?? Math.max(2, Math.floor((firstVideo.width ?? 1_280) / 2) * 2);
  const height = input.height ?? Math.max(2, Math.floor((firstVideo.height ?? 720) / 2) * 2);

  const outputDir = getGeneratedMediaOutputDir(path.join('composed-video', context.task.taskId));
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const finalPath = path.join(outputDir, input.filename);
  const temporaryPath = path.join(outputDir, `.${input.filename}.${process.pid}.tmp.mp4`);
  await context.update({
    status: 'running',
    checkpoint: { phase: 'validated', segments, finalPath, mediaRuntime: tools.source },
    progress: { completed: 1, total: 4, detail: `已验证 ${segments.length} 个视频片段，准备跨平台本地合成。` },
  });

  const narration = input.narrationText
    ? await synthesizeNarration({
        outputDir,
        text: input.narrationText,
        voice: input.voice,
        run: (executable, args, stdin) => runProcess(context.task.taskId, executable, args, stdin),
      })
    : undefined;
  const narrationPath = narration?.path;
  await context.update({
    checkpoint: {
      phase: narrationPath ? 'narration_ready' : 'rendering',
      segments,
      finalPath,
      narrationPath,
      narrationEngine: narration?.engine,
      narrationVoice: narration?.voice,
      mediaRuntime: tools.source,
    },
    progress: {
      completed: 2,
      total: 4,
      detail: narrationPath
        ? `${narration?.engine === 'microsoft-neural' ? '神经网络' : '系统回退'}旁白已生成，正在拼接画面和音频。`
        : '正在拼接画面和音频。',
    },
  });

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const segment of segments) args.push('-i', segment);
  const narrationInputIndex = narrationPath ? segments.length : undefined;
  if (narrationPath) args.push('-i', narrationPath);
  const hasOriginalAudio = input.keepOriginalAudio && metadata.some((entry) => entry.hasAudio);
  const graph = concatFilter({ metadata, width, height, durationSeconds, keepOriginalAudio: hasOriginalAudio, narrationInputIndex });
  args.push('-filter_complex', graph.filter, '-map', `[${graph.videoLabel}]`);
  if (graph.audioLabel) args.push('-map', `[${graph.audioLabel}]`, '-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push(
    '-t', durationSeconds.toFixed(6),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    temporaryPath,
  );
  await fs.rm(temporaryPath, { force: true });
  await runProcess(context.task.taskId, tools.ffmpeg, args);
  await fs.rm(finalPath, { force: true });
  await fs.rename(temporaryPath, finalPath);
  const [actual, fileStat] = await Promise.all([probeMediaFile(tools.ffprobe, finalPath), fs.stat(finalPath)]);
  const durationSatisfied = typeof actual.durationSeconds === 'number' && Math.abs(actual.durationSeconds - durationSeconds) <= 0.25;
  const audioRequired = Boolean(input.narrationText || hasOriginalAudio);
  if (!actual.hasVideo || !durationSatisfied || actual.width !== width || actual.height !== height || (audioRequired && !actual.hasAudio) || fileStat.size <= 0) {
    await context.update({
      status: 'blocked',
      checkpoint: { phase: 'verification_failed', finalPath, metadata: actual },
      error: 'Composed video did not satisfy its duration, dimensions, video-track, or requested audio-track acceptance requirements.',
      progress: { completed: 3, total: 4, detail: '本地合成已产出文件，但媒体验收未通过。' },
    });
    return;
  }

  const artifactId = `artifact:host-task:${context.task.taskId}:video`;
  await context.update({
    status: 'succeeded',
    checkpoint: { phase: 'completed', finalPath, metadata: actual, mediaRuntime: tools.source },
    progress: { completed: 4, total: 4, detail: `成片已验证：${actual.durationSeconds?.toFixed(1) ?? '?'}s，${actual.width}x${actual.height}，${actual.hasAudio ? '有音轨' : '无音轨'}。` },
    artifacts: [{
      id: artifactId,
      kind: 'video',
      title: input.filename,
      filePath: finalPath,
      mimeType: 'video/mp4',
      sizeBytes: fileStat.size,
      stepId: `host-task:${context.task.taskId}`,
      sourceToolCallId: context.task.toolCallId,
      source: 'local.video.compose',
    }],
    verifications: [{
      id: `verification:${artifactId}:media.metadata`,
      status: 'passed',
      kind: 'media.metadata',
      required: true,
      title: '验证最终视频时长、尺寸和音轨',
      detail: JSON.stringify(actual),
      artifactId,
      targetId: artifactId,
      evidence: JSON.stringify(actual),
      source: 'local.video.compose',
    }],
  });
}

export async function cancelLocalVideoCompose(context: HostCapabilityTaskContext & { reason: string }): Promise<void> {
  activeProcesses.get(context.task.taskId)?.kill('SIGTERM');
  await context.update({
    status: 'cancelled',
    checkpoint: { phase: 'cancelled' },
    error: context.reason,
    progress: { detail: '视频合成已取消。' },
  });
}
