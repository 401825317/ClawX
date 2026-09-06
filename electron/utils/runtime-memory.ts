import { app } from 'electron';
import { freemem, totalmem } from 'node:os';
import { memoryUsage } from 'node:process';
import { getHeapStatistics } from 'node:v8';

/**
 * A deliberately small, secret-free memory snapshot.  The values are kept in
 * bytes (rather than formatted strings) so callers can apply consistent
 * thresholds and tests can compare them without parsing log output.
 *
 * `heapLimitBytes` is the V8 JavaScript heap limit.  It is not a process/RSS
 * limit: native allocations, Buffers, Electron/Chromium memory and IPC
 * serialization are outside that value.
 */
export type RuntimeMemorySnapshot = {
  capturedAtMs: number;
  process: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
  v8: {
    heapLimitBytes: number;
    heapAvailableBytes: number;
  };
  system: {
    totalBytes: number;
    freeBytes: number;
    freeRatio: number;
  };
  electronProcesses: Array<{
    pid: number;
    type?: string;
    name?: string;
    workingSetKb?: number;
    privateKb?: number;
  }>;
};

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Collects local process/system metrics without spawning a helper process. */
export function collectRuntimeMemorySnapshot(now = Date.now()): RuntimeMemorySnapshot {
  const usage = memoryUsage();
  const heap = getHeapStatistics();
  const systemTotal = totalmem();
  const systemFree = freemem();
  const electronProcesses: RuntimeMemorySnapshot['electronProcesses'] = [];

  // app.getAppMetrics() is only available after Electron is ready in some
  // test/runtime contexts.  A failed read must never affect the application.
  try {
    if (typeof app.getAppMetrics === 'function') {
      const metrics = app.getAppMetrics() as unknown as Array<Record<string, unknown>>;
      for (const metric of metrics) {
        const pid = finiteNonNegative(metric.pid);
        if (pid === undefined) continue;
        const memory = metric.memory && typeof metric.memory === 'object'
          ? metric.memory as Record<string, unknown>
          : undefined;
        electronProcesses.push({
          pid,
          ...(typeof metric.type === 'string' ? { type: metric.type } : {}),
          ...(typeof metric.name === 'string' ? { name: metric.name } : {}),
          ...(finiteNonNegative(memory?.workingSetSize) !== undefined
            ? { workingSetKb: finiteNonNegative(memory?.workingSetSize) } : {}),
          ...(finiteNonNegative(memory?.privateBytes) !== undefined
            ? { privateKb: finiteNonNegative(memory?.privateBytes) } : {}),
        });
      }
    }
  } catch {
    // Metrics are diagnostic only; do not let an unavailable Electron API
    // interfere with startup, recovery, or task execution.
  }

  return {
    capturedAtMs: now,
    process: {
      rssBytes: usage.rss,
      heapTotalBytes: usage.heapTotal,
      heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external,
      arrayBuffersBytes: usage.arrayBuffers ?? 0,
    },
    v8: {
      heapLimitBytes: heap.heap_size_limit,
      heapAvailableBytes: Math.max(0, heap.heap_size_limit - usage.heapUsed),
    },
    system: {
      totalBytes: systemTotal,
      freeBytes: systemFree,
      freeRatio: systemTotal > 0 ? systemFree / systemTotal : 0,
    },
    electronProcesses,
  };
}

/** Return only numeric, aggregate values suitable for a redacted diagnostic event. */
export function runtimeMemoryMetricProperties(snapshot: RuntimeMemorySnapshot): Record<string, number> {
  const aggregateWorkingSetKb = snapshot.electronProcesses.reduce(
    (total, process) => total + (process.workingSetKb ?? 0),
    0,
  );
  const aggregatePrivateKb = snapshot.electronProcesses.reduce(
    (total, process) => total + (process.privateKb ?? 0),
    0,
  );
  return {
    processRssBytes: snapshot.process.rssBytes,
    processHeapTotalBytes: snapshot.process.heapTotalBytes,
    processHeapUsedBytes: snapshot.process.heapUsedBytes,
    processExternalBytes: snapshot.process.externalBytes,
    processArrayBuffersBytes: snapshot.process.arrayBuffersBytes,
    v8HeapLimitBytes: snapshot.v8.heapLimitBytes,
    v8HeapAvailableBytes: snapshot.v8.heapAvailableBytes,
    systemTotalBytes: snapshot.system.totalBytes,
    systemFreeBytes: snapshot.system.freeBytes,
    systemFreeRatio: snapshot.system.freeRatio,
    electronProcessCount: snapshot.electronProcesses.length,
    electronWorkingSetKb: aggregateWorkingSetKb,
    electronPrivateKb: aggregatePrivateKb,
  };
}
