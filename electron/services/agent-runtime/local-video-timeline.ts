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

export type LocalVideoTimelineScene = {
  sourcePath: string;
  kind: 'image' | 'video';
  durationSeconds: number;
  motion: 'none' | 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right' | 'pan_up' | 'pan_down' | 'ken_burns';
  transition: 'cut' | 'crossfade' | 'fade';
  transitionDurationSeconds: number;
  caption?: string;
  captionPosition: 'top' | 'center' | 'bottom';
};

export type LocalVideoTimelineInput = {
  scenes: LocalVideoTimelineScene[];
  filename: string;
  targetDurationSeconds?: number;
  width: number;
  height: number;
  fps: number;
  narrationText?: string;
  voice: string;
  narrationVolume: number;
  keepOriginalAudio: boolean;
  backgroundMusicPath?: string;
  backgroundMusicVolume: number;
};

type TimelineMetadata = {
  durationSeconds?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  hasVideo?: boolean;
  sceneCount?: number;
  imageSceneCount?: number;
  videoSceneCount?: number;
  captionCount?: number;
  transitionCount?: number;
};

const activeProcesses = new Map<string, ChildProcessWithoutNullStreams>();
const IMAGE_INPUT_EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic|heif)$/iu;
const VIDEO_INPUT_EXT_RE = /\.(?:mp4|mov|m4v|webm|mkv|avi|mpeg|mpg)$/iu;
const MOTIONS = new Set<LocalVideoTimelineScene['motion']>(['none', 'zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'ken_burns']);
const TRANSITIONS = new Set<LocalVideoTimelineScene['transition']>(['cut', 'crossfade', 'fade']);
const CAPTION_POSITIONS = new Set<LocalVideoTimelineScene['captionPosition']>(['top', 'center', 'bottom']);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if ((!normalized && required) || normalized.length > maximum) throw new Error(`${label} must contain 1 to ${maximum} characters`);
  return normalized || undefined;
}

function numberInRange(value: unknown, label: string, minimum: number, maximum: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} must be from ${minimum} to ${maximum}`);
  return value;
}

function integerInRange(value: unknown, label: string, minimum: number, maximum: number, fallback: number): number {
  const normalized = value === undefined ? fallback : value;
  if (!Number.isInteger(normalized) || (normalized as number) < minimum || (normalized as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return normalized as number;
}

function evenIntegerInRange(value: unknown, label: string, minimum: number, maximum: number, fallback: number): number {
  const normalized = integerInRange(value, label, minimum, maximum, fallback);
  if (normalized % 2 !== 0) throw new Error(`${label} must be an even integer for H.264 output`);
  return normalized;
}

function enumValue<T extends string>(value: unknown, values: Set<T>, label: string, fallback: T): T {
  const normalized = value === undefined ? fallback : value;
  if (typeof normalized !== 'string' || !values.has(normalized as T)) throw new Error(`${label} is invalid`);
  return normalized as T;
}

function inferSceneKind(sourcePath: string): LocalVideoTimelineScene['kind'] | undefined {
  if (IMAGE_INPUT_EXT_RE.test(sourcePath)) return 'image';
  if (VIDEO_INPUT_EXT_RE.test(sourcePath)) return 'video';
  return undefined;
}

export function normalizeLocalVideoTimelineInput(value: unknown): LocalVideoTimelineInput {
  const input = record(value, 'local.video.timeline.render input');
  if (!Array.isArray(input.scenes) || input.scenes.length < 1 || input.scenes.length > 120) {
    throw new Error('local.video.timeline.render input.scenes must contain 1 to 120 scenes');
  }
  const scenes = input.scenes.map((candidate, index): LocalVideoTimelineScene => {
    const scene = record(candidate, `local.video.timeline.render scenes[${index}]`);
    const sourcePath = text(scene.sourcePath, `local.video.timeline.render scenes[${index}].sourcePath`, 4_096, true) as string;
    const inferredKind = inferSceneKind(sourcePath);
    const kind = scene.kind === undefined
      ? inferredKind
      : enumValue(scene.kind, new Set<LocalVideoTimelineScene['kind']>(['image', 'video']), `local.video.timeline.render scenes[${index}].kind`, 'image');
    if (!kind) throw new Error(`local.video.timeline.render scenes[${index}].kind is required for this file extension`);
    const durationSeconds = numberInRange(scene.durationSeconds, `local.video.timeline.render scenes[${index}].durationSeconds`, 0.25, 600);
    const transition = enumValue(scene.transition, TRANSITIONS, `local.video.timeline.render scenes[${index}].transition`, 'cut');
    const transitionDurationSeconds = numberInRange(
      scene.transitionDurationSeconds,
      `local.video.timeline.render scenes[${index}].transitionDurationSeconds`,
      0,
      5,
      transition === 'cut' ? 0 : 0.5,
    );
    return {
      sourcePath,
      kind,
      durationSeconds,
      motion: enumValue(scene.motion, MOTIONS, `local.video.timeline.render scenes[${index}].motion`, 'ken_burns'),
      transition,
      transitionDurationSeconds,
      caption: text(scene.caption, `local.video.timeline.render scenes[${index}].caption`, 500),
      captionPosition: enumValue(scene.captionPosition, CAPTION_POSITIONS, `local.video.timeline.render scenes[${index}].captionPosition`, 'bottom'),
    };
  });
  const plannedDurationSeconds = scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
  if (plannedDurationSeconds > 7_200) throw new Error('local.video.timeline.render scene duration total cannot exceed 7200 seconds');
  const targetDurationSeconds = input.targetDurationSeconds === undefined
    ? undefined
    : numberInRange(input.targetDurationSeconds, 'local.video.timeline.render targetDurationSeconds', 0.25, 7_200);
  if (targetDurationSeconds !== undefined && targetDurationSeconds > plannedDurationSeconds + 0.001) {
    throw new Error(`local.video.timeline.render scenes total ${plannedDurationSeconds}s is below target ${targetDurationSeconds}s`);
  }
  const filenameInput = text(input.filename, 'local.video.timeline.render filename', 180);
  const filename = (filenameInput ?? 'uclaw-timeline-video.mp4').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 180);
  return {
    scenes,
    filename: filename.toLowerCase().endsWith('.mp4') ? filename : `${filename}.mp4`,
    targetDurationSeconds,
    width: evenIntegerInRange(input.width, 'local.video.timeline.render width', 320, 7_680, 1_920),
    height: evenIntegerInRange(input.height, 'local.video.timeline.render height', 240, 4_320, 1_080),
    fps: integerInRange(input.fps, 'local.video.timeline.render fps', 12, 60, 30),
    narrationText: text(input.narrationText, 'local.video.timeline.render narrationText', 16_000),
    voice: text(input.voice, 'local.video.timeline.render voice', 80) ?? DEFAULT_NARRATION_VOICE,
    narrationVolume: numberInRange(input.narrationVolume, 'local.video.timeline.render narrationVolume', 0, 1, 1),
    keepOriginalAudio: input.keepOriginalAudio !== false,
    backgroundMusicPath: text(input.backgroundMusicPath, 'local.video.timeline.render backgroundMusicPath', 4_096),
    backgroundMusicVolume: numberInRange(input.backgroundMusicVolume, 'local.video.timeline.render backgroundMusicVolume', 0, 1, 0.18),
  };
}

async function managedTimelineInput(input: LocalVideoTimelineInput): Promise<LocalVideoTimelineInput> {
  const scenes = await Promise.all(input.scenes.map(async (scene, index) => ({
    ...scene,
    sourcePath: await resolveManagedLocalMediaFile(scene.sourcePath, `Timeline scene ${index + 1}`),
  })));
  const backgroundMusicPath = input.backgroundMusicPath
    ? await resolveManagedLocalMediaFile(input.backgroundMusicPath, 'Timeline background music')
    : undefined;
  return { ...input, scenes, backgroundMusicPath };
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
      else reject(new Error(signal ? `Timeline rendering stopped by ${signal}` : (stderr.trim() || `Timeline rendering exited with code ${code}`)));
    });
    child.stdin.end(stdin);
  });
}

async function resolveCaptionFont(): Promise<string | undefined> {
  const candidates = [
    process.env.UCLAW_VIDEO_FONT_PATH?.trim(),
    ...(process.platform === 'darwin' ? [
      '/System/Library/Fonts/PingFang.ttc',
      '/System/Library/Fonts/STHeiti Medium.ttc',
    ] : process.platform === 'win32' ? [
      path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'msyh.ttc'),
      path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'arial.ttf'),
    ] : [
      '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ]),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const fileStat = await fs.stat(candidate);
      if (fileStat.isFile() && fileStat.size > 0) return candidate;
    } catch {
      // Try the next platform font.
    }
  }
  return undefined;
}

function escapeFilterPath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "\\'");
}

function motionFilter(scene: LocalVideoTimelineScene, frameCount: number, width: number, height: number, fps: number): string | undefined {
  if (scene.motion === 'none') return undefined;
  const progress = `on/${Math.max(1, frameCount - 1)}`;
  const zoom = scene.motion === 'zoom_out'
    ? `1.12-0.12*${progress}`
    : scene.motion === 'pan_left' || scene.motion === 'pan_right' || scene.motion === 'pan_up' || scene.motion === 'pan_down'
      ? '1.08'
      : `1+0.12*${progress}`;
  const x = scene.motion === 'pan_left'
    ? `(iw-iw/zoom)*(1-${progress})`
    : scene.motion === 'pan_right' || scene.motion === 'ken_burns'
      ? `(iw-iw/zoom)*${progress}`
      : '(iw-iw/zoom)/2';
  const y = scene.motion === 'pan_up'
    ? `(ih-ih/zoom)*(1-${progress})`
    : scene.motion === 'pan_down' || scene.motion === 'ken_burns'
      ? `(ih-ih/zoom)*${progress}`
      : '(ih-ih/zoom)/2';
  return `zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps}`;
}

async function buildTimelineFilter(
  input: LocalVideoTimelineInput,
  outputDir: string,
  sceneMetadata: ProbedMediaMetadata[],
): Promise<{
  args: string[];
  filter: string;
  outputLabel: string;
  audioLabel?: string;
}> {
  const args: string[] = [];
  const filters: string[] = [];
  const labels: string[] = [];
  const audioLabels: string[] = [];
  const preserveOriginalAudio = input.keepOriginalAudio && sceneMetadata.some((metadata) => metadata.hasAudio);
  const captionsPresent = input.scenes.some((scene) => Boolean(scene.caption));
  const captionFont = captionsPresent ? await resolveCaptionFont() : undefined;
  if (captionsPresent && !captionFont) throw new Error(`Timeline captions were requested, but no usable font was found for ${process.platform}.`);

  for (let index = 0; index < input.scenes.length; index += 1) {
    const scene = input.scenes[index]!;
    const previous = input.scenes[index - 1];
    const previewSeconds = previous?.transition === 'crossfade'
      ? Math.min(previous.transitionDurationSeconds, previous.durationSeconds / 2, scene.durationSeconds / 2)
      : 0;
    const renderDuration = scene.durationSeconds + previewSeconds;
    if (scene.kind === 'image') args.push('-loop', '1', '-framerate', String(input.fps), '-t', renderDuration.toFixed(6), '-i', scene.sourcePath);
    else args.push('-stream_loop', '-1', '-t', renderDuration.toFixed(6), '-i', scene.sourcePath);

    const chain = [
      `scale=${input.width}:${input.height}:force_original_aspect_ratio=increase`,
      `crop=${input.width}:${input.height}`,
      'setsar=1',
      `fps=${input.fps}`,
      `trim=duration=${renderDuration.toFixed(6)}`,
      'setpts=PTS-STARTPTS',
    ];
    const motion = motionFilter(scene, Math.ceil(renderDuration * input.fps), input.width, input.height, input.fps);
    if (motion) chain.push(motion);
    if (previous?.transition === 'fade' && previewSeconds === 0) {
      const fadeIn = Math.min(previous.transitionDurationSeconds, scene.durationSeconds / 2);
      if (fadeIn > 0) chain.push(`fade=t=in:st=0:d=${fadeIn.toFixed(6)}`);
    }
    if (scene.transition === 'fade' && index < input.scenes.length - 1) {
      const fadeOut = Math.min(scene.transitionDurationSeconds, scene.durationSeconds / 2);
      if (fadeOut > 0) chain.push(`fade=t=out:st=${Math.max(0, renderDuration - fadeOut).toFixed(6)}:d=${fadeOut.toFixed(6)}`);
    }
    if (scene.caption && captionFont) {
      const textPath = path.join(outputDir, `caption-${index + 1}.txt`);
      await fs.writeFile(textPath, scene.caption, 'utf8');
      const y = scene.captionPosition === 'top' ? 'h*0.08' : scene.captionPosition === 'center' ? '(h-text_h)/2' : 'h-text_h-h*0.08';
      chain.push(`drawtext=fontfile='${escapeFilterPath(captionFont)}':textfile='${escapeFilterPath(textPath)}':fontcolor=white:fontsize=h*0.046:borderw=3:bordercolor=black@0.75:box=1:boxcolor=black@0.35:boxborderw=18:x=(w-text_w)/2:y=${y}`);
    }
    chain.push('format=yuv420p');
    const label = `scene${index}`;
    filters.push(`[${index}:v:0]${chain.join(',')}[${label}]`);
    labels.push(label);
    if (preserveOriginalAudio) {
      const audioLabel = `sceneAudio${index}`;
      filters.push(sceneMetadata[index]?.hasAudio
        ? `[${index}:a:0]aresample=48000,atrim=duration=${scene.durationSeconds.toFixed(6)},asetpts=PTS-STARTPTS[${audioLabel}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${scene.durationSeconds.toFixed(6)},asetpts=PTS-STARTPTS[${audioLabel}]`);
      audioLabels.push(audioLabel);
    }
  }

  let outputLabel = labels[0]!;
  let currentDuration = input.scenes[0]!.durationSeconds;
  for (let index = 1; index < labels.length; index += 1) {
    const previous = input.scenes[index - 1]!;
    const nextLabel = `timeline${index}`;
    if (previous.transition === 'crossfade') {
      const duration = Math.min(previous.transitionDurationSeconds, previous.durationSeconds / 2, input.scenes[index]!.durationSeconds / 2);
      if (duration > 0) {
        filters.push(`[${outputLabel}][${labels[index]}]xfade=transition=fade:duration=${duration.toFixed(6)}:offset=${Math.max(0, currentDuration - duration).toFixed(6)}[${nextLabel}]`);
      } else {
        filters.push(`[${outputLabel}][${labels[index]}]concat=n=2:v=1:a=0[${nextLabel}]`);
      }
    } else {
      filters.push(`[${outputLabel}][${labels[index]}]concat=n=2:v=1:a=0[${nextLabel}]`);
    }
    currentDuration += input.scenes[index]!.durationSeconds;
    outputLabel = nextLabel;
  }
  if (input.targetDurationSeconds !== undefined) {
    const trimmedLabel = 'timelineTrimmed';
    filters.push(`[${outputLabel}]trim=duration=${input.targetDurationSeconds.toFixed(6)},setpts=PTS-STARTPTS[${trimmedLabel}]`);
    outputLabel = trimmedLabel;
  }
  let audioLabel: string | undefined;
  if (audioLabels.length > 0) {
    audioLabel = 'timelineAudio';
    filters.push(`${audioLabels.map((label) => `[${label}]`).join('')}concat=n=${audioLabels.length}:v=0:a=1[${audioLabel}]`);
    if (input.targetDurationSeconds !== undefined) {
      const trimmedAudioLabel = 'timelineAudioTrimmed';
      filters.push(`[${audioLabel}]atrim=duration=${input.targetDurationSeconds.toFixed(6)},asetpts=PTS-STARTPTS[${trimmedAudioLabel}]`);
      audioLabel = trimmedAudioLabel;
    }
  }
  return { args, filter: filters.join(';'), outputLabel, audioLabel };
}

async function addOptionalAudio(params: {
  taskId: string;
  ffmpeg: string;
  visualPath: string;
  outputPath: string;
  durationSeconds: number;
  narrationPath?: string;
  narrationVolume: number;
  preserveOriginalAudio: boolean;
  backgroundMusicPath?: string;
  backgroundMusicVolume: number;
}): Promise<void> {
  if (!params.narrationPath && !params.backgroundMusicPath) {
    await fs.rename(params.visualPath, params.outputPath);
    return;
  }
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', params.visualPath];
  let narrationIndex: number | undefined;
  let musicIndex: number | undefined;
  if (params.narrationPath) {
    narrationIndex = 1;
    args.push('-i', params.narrationPath);
  }
  if (params.backgroundMusicPath) {
    musicIndex = narrationIndex === undefined ? 1 : 2;
    args.push('-stream_loop', '-1', '-i', params.backgroundMusicPath);
  }
  const filters: string[] = [];
  const labels: string[] = [];
  if (params.preserveOriginalAudio) {
    const originalVolume = params.narrationPath ? 0.28 : params.backgroundMusicPath ? 0.65 : 1;
    filters.push(`[0:a:0]aresample=48000,volume=${originalVolume},apad,atrim=duration=${params.durationSeconds.toFixed(6)}[original]`);
    labels.push('original');
  }
  if (narrationIndex !== undefined) {
    filters.push(`[${narrationIndex}:a:0]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11,volume=${params.narrationVolume},apad,atrim=duration=${params.durationSeconds.toFixed(6)}[narration]`);
    labels.push('narration');
  }
  if (musicIndex !== undefined) {
    filters.push(`[${musicIndex}:a:0]volume=${params.backgroundMusicVolume},atrim=duration=${params.durationSeconds.toFixed(6)}[music]`);
    labels.push('music');
  }
  const audioLabel = labels.length === 1 ? labels[0]! : 'mixedAudio';
  if (labels.length > 1) filters.push(`${labels.map((label) => `[${label}]`).join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0[${audioLabel}]`);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '0:v:0', '-map', `[${audioLabel}]`,
    '-t', params.durationSeconds.toFixed(6),
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
    params.outputPath,
  );
  await runProcess(params.taskId, params.ffmpeg, args);
  await fs.rm(params.visualPath, { force: true });
}

export async function assessLocalVideoTimelineAvailability() {
  return await assessLocalMediaRuntime();
}

export async function runLocalVideoTimelineRender(context: HostCapabilityTaskContext): Promise<void> {
  const normalizedInput = normalizeLocalVideoTimelineInput(context.input);
  const input = await managedTimelineInput(normalizedInput);
  const tools = await resolveLocalMediaTools();
  if (!tools) throw new Error(`Packaged FFmpeg/ffprobe runtime is missing for ${process.platform}-${process.arch}.`);
  const sceneMetadata = await Promise.all(input.scenes.map(async (scene): Promise<ProbedMediaMetadata> => {
    if (scene.kind === 'image') return { hasAudio: false, hasVideo: false };
    return await probeMediaFile(tools.ffprobe, scene.sourcePath);
  }));
  const preserveOriginalAudio = input.keepOriginalAudio && sceneMetadata.some((metadata) => metadata.hasAudio);
  const outputDir = getGeneratedMediaOutputDir(path.join('timeline-video', context.task.taskId));
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const finalPath = path.join(outputDir, input.filename);
  const temporaryPath = path.join(outputDir, `.${input.filename}.${process.pid}.tmp.mp4`);
  const visualPath = path.join(outputDir, `.${input.filename}.${process.pid}.visual.mp4`);
  const expectedDurationSeconds = input.targetDurationSeconds ?? input.scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
  await context.update({
    status: 'running',
    checkpoint: { phase: 'validated', finalPath, expectedDurationSeconds, sceneCount: input.scenes.length, mediaRuntime: tools.source },
    progress: { completed: 1, total: 4, detail: `已验证 ${input.scenes.length} 个时间线场景，准备跨平台本地渲染。` },
  });

  await Promise.all([fs.rm(temporaryPath, { force: true }), fs.rm(visualPath, { force: true })]);
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
      finalPath,
      narrationPath,
      narrationEngine: narration?.engine,
      narrationVoice: narration?.voice,
      expectedDurationSeconds,
      mediaRuntime: tools.source,
    },
    progress: {
      completed: 2,
      total: 4,
      detail: narrationPath
        ? `${narration?.engine === 'microsoft-neural' ? '神经网络' : '系统回退'}旁白已生成，正在渲染视频时间线。`
        : '正在渲染视频时间线。',
    },
  });

  const timeline = await buildTimelineFilter(input, outputDir, sceneMetadata);
  const renderArgs = [
    '-y', '-hide_banner', '-loglevel', 'error',
    ...timeline.args,
    '-filter_complex', timeline.filter,
    '-map', `[${timeline.outputLabel}]`,
  ];
  if (timeline.audioLabel) renderArgs.push('-map', `[${timeline.audioLabel}]`, '-c:a', 'aac', '-b:a', '192k');
  else renderArgs.push('-an');
  renderArgs.push(
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    visualPath,
  );
  await runProcess(context.task.taskId, tools.ffmpeg, renderArgs);
  await addOptionalAudio({
    taskId: context.task.taskId,
    ffmpeg: tools.ffmpeg,
    visualPath,
    outputPath: temporaryPath,
    durationSeconds: expectedDurationSeconds,
    narrationPath,
    narrationVolume: input.narrationVolume,
    preserveOriginalAudio,
    backgroundMusicPath: input.backgroundMusicPath,
    backgroundMusicVolume: input.backgroundMusicVolume,
  });
  await fs.rm(finalPath, { force: true });
  await fs.rename(temporaryPath, finalPath);
  const [probed, fileStat] = await Promise.all([probeMediaFile(tools.ffprobe, finalPath), fs.stat(finalPath)]);
  const metadata: TimelineMetadata = {
    ...probed,
    sceneCount: input.scenes.length,
    imageSceneCount: input.scenes.filter((scene) => scene.kind === 'image').length,
    videoSceneCount: input.scenes.filter((scene) => scene.kind === 'video').length,
    captionCount: input.scenes.filter((scene) => Boolean(scene.caption)).length,
    transitionCount: input.scenes.filter((scene) => scene.transition !== 'cut').length,
  };
  const durationTolerance = Math.max(0.25, 1 / input.fps + 0.15);
  const durationSatisfied = typeof metadata.durationSeconds === 'number' && Math.abs(metadata.durationSeconds - expectedDurationSeconds) <= durationTolerance;
  const dimensionsSatisfied = metadata.width === input.width && metadata.height === input.height;
  const audioRequired = Boolean(preserveOriginalAudio || input.narrationText || input.backgroundMusicPath);
  const audioSatisfied = !audioRequired || metadata.hasAudio === true;
  if (!metadata.hasVideo || !durationSatisfied || !dimensionsSatisfied || !audioSatisfied || fileStat.size <= 0) {
    await context.update({
      status: 'blocked',
      checkpoint: { phase: 'verification_failed', finalPath, metadata, expectedDurationSeconds },
      error: 'Rendered timeline did not satisfy its duration, dimensions, video-track, or explicitly requested audio-track acceptance requirements.',
      progress: { completed: 3, total: 4, detail: '时间线视频已产出，但媒体验收未通过。' },
    });
    return;
  }

  const artifactId = `artifact:host-task:${context.task.taskId}:video`;
  await context.update({
    status: 'succeeded',
    checkpoint: { phase: 'completed', finalPath, metadata, expectedDurationSeconds, mediaRuntime: tools.source },
    progress: { completed: 4, total: 4, detail: `时间线成片已验证：${metadata.durationSeconds?.toFixed(1) ?? '?'}s，${metadata.width}x${metadata.height}，${metadata.hasAudio ? '有音轨' : '无音轨'}。` },
    artifacts: [{
      id: artifactId,
      kind: 'video',
      title: input.filename,
      filePath: finalPath,
      mimeType: 'video/mp4',
      sizeBytes: fileStat.size,
      stepId: `host-task:${context.task.taskId}`,
      sourceToolCallId: context.task.toolCallId,
      source: 'local.video.timeline.render',
    }],
    verifications: [{
      id: `verification:${artifactId}:media.metadata`,
      status: 'passed',
      kind: 'media.metadata',
      required: true,
      title: '验证时间线视频时长、尺寸和音轨',
      detail: JSON.stringify(metadata),
      artifactId,
      targetId: artifactId,
      evidence: JSON.stringify({ ...metadata, expectedDurationSeconds }),
      source: 'local.video.timeline.render',
    }],
  });
}

export async function cancelLocalVideoTimelineRender(context: HostCapabilityTaskContext & { reason: string }): Promise<void> {
  activeProcesses.get(context.task.taskId)?.kill('SIGTERM');
  await context.update({
    status: 'cancelled',
    checkpoint: { phase: 'cancelled' },
    error: context.reason,
    progress: { detail: '视频时间线渲染已取消。' },
  });
}
