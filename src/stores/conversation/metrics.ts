export type ConversationDurationMetric = {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
};

export type ConversationPerformanceSnapshot = {
  ingressEvents: number;
  adapter: ConversationDurationMetric;
  reducer: ConversationDurationMetric;
  projection: ConversationDurationMetric;
  historyReplay: ConversationDurationMetric;
  storeCommits: number;
  maxStoreCommitsPerFrame: number;
  itemRenders: number;
  itemRendersByTurnId: Record<string, number>;
  itemRendersByItemId: Record<string, number>;
  mountedRows: number;
  maxMountedRows: number;
  scrollCorrections: number;
  maxScrollCorrectionPx: number;
  longTasks: ConversationDurationMetric;
  longTaskObserverSupported: boolean;
  sampledFrames: number;
  slowFrames: number;
  averageFps: number;
};

type DurationMetricName = 'adapter' | 'reducer' | 'projection' | 'historyReplay' | 'longTasks';

function emptyDurationMetric(): ConversationDurationMetric {
  return { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
}

const metrics = {
  ingressEvents: 0,
  adapter: emptyDurationMetric(),
  reducer: emptyDurationMetric(),
  projection: emptyDurationMetric(),
  historyReplay: emptyDurationMetric(),
  storeCommits: 0,
  maxStoreCommitsPerFrame: 0,
  itemRenders: 0,
  itemRendersByTurnId: {} as Record<string, number>,
  itemRendersByItemId: {} as Record<string, number>,
  mountedRows: 0,
  maxMountedRows: 0,
  scrollCorrections: 0,
  maxScrollCorrectionPx: 0,
  longTasks: emptyDurationMetric(),
  sampledFrames: 0,
  slowFrames: 0,
  totalFrameIntervalMs: 0,
};

let animationFrameSequence = 0;
let lastStoreCommitFrameSequence = -1;
let storeCommitsInCurrentFrame = 0;
let activeLongTaskObservers = 0;

export function conversationPerformanceNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function recordConversationDuration(name: DurationMetricName, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const metric = metrics[name];
  metric.count += 1;
  metric.totalMs += durationMs;
  metric.maxMs = Math.max(metric.maxMs, durationMs);
  metric.lastMs = durationMs;
}

export function recordConversationIngress(eventCount: number): void {
  metrics.ingressEvents += Math.max(0, eventCount);
}

export function recordConversationStoreCommit(): void {
  metrics.storeCommits += 1;
  if (lastStoreCommitFrameSequence === animationFrameSequence) {
    storeCommitsInCurrentFrame += 1;
  } else {
    lastStoreCommitFrameSequence = animationFrameSequence;
    storeCommitsInCurrentFrame = 1;
  }
  metrics.maxStoreCommitsPerFrame = Math.max(
    metrics.maxStoreCommitsPerFrame,
    storeCommitsInCurrentFrame,
  );
}

export function recordTimelineItemRender(turnId: string, itemId: string): void {
  metrics.itemRenders += 1;
  metrics.itemRendersByTurnId[turnId] = (metrics.itemRendersByTurnId[turnId] ?? 0) + 1;
  metrics.itemRendersByItemId[itemId] = (metrics.itemRendersByItemId[itemId] ?? 0) + 1;
}

export function recordTimelineMountedRows(count: number): void {
  metrics.mountedRows = Math.max(0, count);
  metrics.maxMountedRows = Math.max(metrics.maxMountedRows, metrics.mountedRows);
}

export function recordTimelineScrollCorrection(offsetPx: number): void {
  const absoluteOffset = Math.abs(offsetPx);
  if (!Number.isFinite(absoluteOffset) || absoluteOffset <= 0.5) return;
  metrics.scrollCorrections += 1;
  metrics.maxScrollCorrectionPx = Math.max(metrics.maxScrollCorrectionPx, absoluteOffset);
}

/** Monitor browser scheduling without retaining event payloads or DOM references. */
export function startConversationPerformanceObservers(): () => void {
  if (typeof window === 'undefined') return () => {};
  let disposed = false;
  let frameId: number | null = null;
  let previousFrameAt: number | null = null;
  const frame = (now: number) => {
    if (disposed) return;
    if (previousFrameAt != null) {
      const interval = now - previousFrameAt;
      if (Number.isFinite(interval) && interval > 0 && interval < 1_000) {
        metrics.sampledFrames += 1;
        metrics.totalFrameIntervalMs += interval;
        if (interval > 1000 / 30) metrics.slowFrames += 1;
      }
    }
    previousFrameAt = now;
    animationFrameSequence += 1;
    frameId = window.requestAnimationFrame(frame);
  };
  frameId = window.requestAnimationFrame(frame);

  let longTaskObserver: PerformanceObserver | null = null;
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => recordConversationDuration('longTasks', entry.duration));
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
      activeLongTaskObservers += 1;
    } catch {
      longTaskObserver = null;
    }
  }

  return () => {
    disposed = true;
    if (frameId != null) window.cancelAnimationFrame(frameId);
    if (longTaskObserver) {
      longTaskObserver.disconnect();
      activeLongTaskObservers = Math.max(0, activeLongTaskObservers - 1);
    }
  };
}

/** Reset the current measurement window without losing the mounted-row gauge. */
export function resetConversationPerformanceMetrics(): void {
  metrics.ingressEvents = 0;
  metrics.adapter = emptyDurationMetric();
  metrics.reducer = emptyDurationMetric();
  metrics.projection = emptyDurationMetric();
  metrics.historyReplay = emptyDurationMetric();
  metrics.storeCommits = 0;
  metrics.maxStoreCommitsPerFrame = 0;
  metrics.itemRenders = 0;
  metrics.itemRendersByTurnId = {};
  metrics.itemRendersByItemId = {};
  metrics.maxMountedRows = metrics.mountedRows;
  metrics.scrollCorrections = 0;
  metrics.maxScrollCorrectionPx = 0;
  metrics.longTasks = emptyDurationMetric();
  metrics.sampledFrames = 0;
  metrics.slowFrames = 0;
  metrics.totalFrameIntervalMs = 0;
  lastStoreCommitFrameSequence = animationFrameSequence;
  storeCommitsInCurrentFrame = 0;
}

export function getConversationPerformanceSnapshot(): ConversationPerformanceSnapshot {
  const averageFrameMs = metrics.sampledFrames > 0
    ? metrics.totalFrameIntervalMs / metrics.sampledFrames
    : 0;
  return {
    ingressEvents: metrics.ingressEvents,
    adapter: { ...metrics.adapter },
    reducer: { ...metrics.reducer },
    projection: { ...metrics.projection },
    historyReplay: { ...metrics.historyReplay },
    storeCommits: metrics.storeCommits,
    maxStoreCommitsPerFrame: metrics.maxStoreCommitsPerFrame,
    itemRenders: metrics.itemRenders,
    itemRendersByTurnId: { ...metrics.itemRendersByTurnId },
    itemRendersByItemId: { ...metrics.itemRendersByItemId },
    mountedRows: metrics.mountedRows,
    maxMountedRows: metrics.maxMountedRows,
    scrollCorrections: metrics.scrollCorrections,
    maxScrollCorrectionPx: metrics.maxScrollCorrectionPx,
    longTasks: { ...metrics.longTasks },
    longTaskObserverSupported: activeLongTaskObservers > 0,
    sampledFrames: metrics.sampledFrames,
    slowFrames: metrics.slowFrames,
    averageFps: averageFrameMs > 0 ? Math.min(60, 1_000 / averageFrameMs) : 0,
  };
}
