import type { DesktopObservationRequest } from '../computer';
import { desktopRunCoordinator } from '../computer';
import type { HostCapabilityTaskContext } from './host-capability-registry';
import { hostCapabilityRegistry } from './host-capability-registry';

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
  if (hostCapabilityRegistry.has('desktop.observe')) return;
  hostCapabilityRegistry.register({
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
}
