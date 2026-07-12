import { promises as fs } from 'node:fs';
import type { DesktopObservationRequest } from '../computer';
import { desktopRunCoordinator } from '../computer';
import type { HostCapabilityTaskContext } from './host-capability-registry';
import { hostCapabilityRegistry } from './host-capability-registry';
import { cancelLocalVideoCompose, runLocalVideoCompose } from './local-video-compose';
import {
  assessLocalVideoTimelineAvailability,
  cancelLocalVideoTimelineRender,
  runLocalVideoTimelineRender,
} from './local-video-timeline';

function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function desktopObservationInput(value: unknown): DesktopObservationRequest {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('desktop.observe input must be an object');
  const record = value as Record<string, unknown>;
  const targetInput = record.target;
  const target = targetInput && typeof targetInput === 'object' && !Array.isArray(targetInput)
    ? targetInput as Record<string, unknown>
    : undefined;
  if (targetInput !== undefined && !target) throw new Error('desktop.observe input.target must be an object');
  const maxScreenshotSide = record.maxScreenshotSide;
  if (maxScreenshotSide !== undefined && (!Number.isInteger(maxScreenshotSide) || maxScreenshotSide < 640 || maxScreenshotSide > 2560)) {
    throw new Error('desktop.observe maxScreenshotSide must be an integer from 640 to 2560');
  }
  return {
    ...(target ? {
      target: {
        ...(text(target.appId, 256) ? { appId: text(target.appId, 256) } : {}),
        ...(text(target.sourceId, 256) ? { sourceId: text(target.sourceId, 256) } : {}),
        ...(text(target.titleIncludes, 256) ? { titleIncludes: text(target.titleIncludes, 256) } : {}),
      },
    } : {}),
    ...(typeof maxScreenshotSide === 'number' ? { maxScreenshotSide } : {}),
  };
}

async function runDesktopObservation(context: HostCapabilityTaskContext): Promise<void> {
  const request = desktopObservationInput(context.input);
  const operation = context.task.lifecycle.operations.at(-1);
  await context.update({
    status: 'running',
    checkpoint: {
      phase: 'observing',
      operation: operation?.kind ?? 'start',
      attempt: operation?.attempt ?? 1,
    },
    progress: { detail: '正在获取新的桌面观察快照。' },
  });
  const state = await desktopRunCoordinator.observe({
    sessionKey: context.task.sessionKey,
    runId: context.task.runId,
  }, request);
  if (state.error || !state.screenshot) {
    await context.update({
      status: 'blocked',
      checkpoint: {
        phase: 'blocked',
        retryable: state.error?.retryable === true,
      },
      error: state.error?.message ?? 'Desktop observation did not return a screenshot.',
      progress: { detail: '桌面观察不可用，未执行任何桌面操作。' },
    });
    return;
  }

  const artifactId = `artifact:host-task:${context.task.taskId}:desktop-screenshot`;
  const artifact = {
    id: artifactId,
    kind: 'image',
    title: state.screenshot.fileName,
    filePath: state.screenshot.filePath,
    mimeType: state.screenshot.mimeType,
    sizeBytes: state.screenshot.fileSize,
    stepId: `host-task:${context.task.taskId}`,
    sourceToolCallId: context.task.toolCallId,
    source: 'desktop.observe',
  };
  const verification = {
    id: `verification:${artifactId}:availability`,
    status: 'passed' as const,
    kind: 'artifact.availability',
    required: true,
    title: `验证 ${state.screenshot.fileName}`,
    detail: '新的受管桌面截图已落盘。',
    artifactId,
    targetId: artifactId,
    evidence: state.screenshot.filePath,
    source: 'desktop.observe',
  };
  await context.update({
    status: 'succeeded',
    checkpoint: {
      phase: 'completed',
      artifactId,
      filePath: state.screenshot.filePath,
    },
    progress: { completed: 1, total: 1, detail: '桌面观察已完成并验证截图产物。' },
    artifacts: [artifact],
    verifications: [verification],
  });
}

export function ensureDefaultHostCapabilities(): void {
  if (!hostCapabilityRegistry.has('desktop.observe')) hostCapabilityRegistry.register({
    descriptor: {
      kind: 'desktop.observe',
      label: 'Desktop observation',
      description: 'Capture a fresh managed desktop screenshot for the current run. It does not click, type, send, or change anything.',
      sideEffect: 'none',
      requiresApproval: false,
    },
    async assess() {
      const capabilities = await desktopRunCoordinator.getCapabilities();
      const capture = capabilities.capabilities.find((capability) => capability.name === 'desktop.capture');
      return {
        availability: capture?.status === 'available' ? 'available' : 'unavailable',
        reason: capture?.reason ?? 'Desktop capture is unavailable.',
      };
    },
    start: runDesktopObservation,
    // Observation has no external side effect, so an interrupted capture can
    // safely obtain a fresh snapshot instead of replaying an action.
    resume: runDesktopObservation,
  });
  if (!hostCapabilityRegistry.has('local.video.compose')) hostCapabilityRegistry.register({
    descriptor: {
      kind: 'local.video.compose',
      label: 'Compose video segments with narration',
      description: 'Concatenate 2-120 existing managed video segments in order, optionally synthesize Chinese narration, export one MP4, and verify actual duration, dimensions, and audio. Use after remote video generation has produced all required segments.',
      sideEffect: 'local_artifact',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        required: ['segments'],
        properties: {
          segments: { type: 'array', minItems: 2, maxItems: 120, items: { type: 'string' }, description: 'Ordered absolute video paths under the managed OpenClaw directory.' },
          filename: { type: 'string', description: 'Final MP4 filename.' },
          targetDurationSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 7200 },
          width: { type: 'integer', minimum: 1, maximum: 7680 },
          height: { type: 'integer', minimum: 1, maximum: 4320 },
          narrationText: { type: 'string', maxLength: 16000 },
          voice: { type: 'string', default: 'Tingting' },
          keepOriginalAudio: { type: 'boolean', default: false },
        },
      },
      outputDescription: 'A verified MP4 artifact with measured duration, width, height, and audio-track evidence.',
    },
    async assess() {
      if (process.platform !== 'darwin') {
        return { availability: 'not_implemented', reason: 'local.video.compose currently requires the macOS AVFoundation executor.' };
      }
      try {
        await Promise.all([fs.access('/usr/bin/swift'), fs.access('/usr/bin/say')]);
        return { availability: 'available' };
      } catch {
        return { availability: 'unavailable', reason: 'The macOS Swift or speech runtime is unavailable.' };
      }
    },
    start: runLocalVideoCompose,
    resume: runLocalVideoCompose,
    cancel: cancelLocalVideoCompose,
  });
  if (!hostCapabilityRegistry.has('local.video.timeline.render')) hostCapabilityRegistry.register({
    descriptor: {
      kind: 'local.video.timeline.render',
      label: 'Render an image/video timeline with narration',
      description: 'Render 1-120 managed image or video scenes into one MP4 with per-scene duration, basic pan/zoom motion, cut/crossfade/fade transitions, captions, optional Chinese narration, and optional background music. Use this local fallback when remote video generation cannot supply motion clips.',
      sideEffect: 'local_artifact',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        required: ['scenes'],
        properties: {
          scenes: {
            type: 'array',
            minItems: 1,
            maxItems: 120,
            items: {
              type: 'object',
              required: ['sourcePath', 'durationSeconds'],
              properties: {
                sourcePath: { type: 'string', description: 'Absolute managed OpenClaw image or video path.' },
                kind: { type: 'string', enum: ['image', 'video'], description: 'Optional when the file extension is recognizable.' },
                durationSeconds: { type: 'number', minimum: 0.25, maximum: 600 },
                motion: { type: 'string', enum: ['none', 'zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'ken_burns'], default: 'ken_burns' },
                transition: { type: 'string', enum: ['cut', 'crossfade', 'fade'], default: 'cut' },
                transitionDurationSeconds: { type: 'number', minimum: 0, maximum: 5 },
                caption: { type: 'string', maxLength: 500 },
                captionPosition: { type: 'string', enum: ['top', 'center', 'bottom'], default: 'bottom' },
              },
            },
          },
          filename: { type: 'string', description: 'Final MP4 filename.' },
          targetDurationSeconds: { type: 'number', minimum: 0.25, maximum: 7200, description: 'Must not exceed the sum of scene durations.' },
          width: { type: 'integer', minimum: 320, maximum: 7680, multipleOf: 2, default: 1920 },
          height: { type: 'integer', minimum: 240, maximum: 4320, multipleOf: 2, default: 1080 },
          fps: { type: 'integer', minimum: 12, maximum: 60, default: 30 },
          narrationText: { type: 'string', maxLength: 16000 },
          voice: { type: 'string', default: 'Tingting' },
          narrationVolume: { type: 'number', minimum: 0, maximum: 1, default: 1 },
          backgroundMusicPath: { type: 'string', description: 'Optional absolute managed audio or video path with an audio track.' },
          backgroundMusicVolume: { type: 'number', minimum: 0, maximum: 1, default: 0.18 },
        },
      },
      outputDescription: 'A verified MP4 artifact with measured duration, dimensions, audio presence, scene counts, caption counts, and transition counts.',
    },
    assess: assessLocalVideoTimelineAvailability,
    start: runLocalVideoTimelineRender,
    resume: runLocalVideoTimelineRender,
    cancel: cancelLocalVideoTimelineRender,
  });
}
