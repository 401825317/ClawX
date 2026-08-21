import { readFileSync } from 'node:fs';
import type {
  PortableRuntimeHealthIssue,
  PortableRuntimeHealthSnapshot,
} from '@shared/portable-runtime-health';

const RUNTIME_MARKER_SCHEMA = 'uclaw.portable-runtime-state/v1';

export const PORTABLE_RUNTIME_FAILURE_WARNING_THRESHOLD = 3;
export const PORTABLE_RUNTIME_STALE_AFTER_MS = 24 * 60 * 60_000;

type RuntimeMarkerHealthFields = {
  schema?: unknown;
  preparedAt?: unknown;
  lastSnapshotAt?: unknown;
};

type PortableRuntimeHealthMonitorOptions = {
  markerPath: string;
  now?: () => number;
  failureWarningThreshold?: number;
  staleAfterMs?: number;
  checkIntervalMs?: number;
  onChange?: (snapshot: PortableRuntimeHealthSnapshot) => void;
};

function validIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function readMarkerHealthFields(markerPath: string): {
  preparedAt?: string;
  lastSuccessfulAt?: string;
} {
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as RuntimeMarkerHealthFields;
    if (parsed.schema !== RUNTIME_MARKER_SCHEMA) return {};
    return {
      preparedAt: validIsoTimestamp(parsed.preparedAt),
      lastSuccessfulAt: validIsoTimestamp(parsed.lastSnapshotAt),
    };
  } catch {
    return {};
  }
}

function ownValue(details: unknown, key: string): unknown {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(details, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function sameSnapshot(
  left: PortableRuntimeHealthSnapshot | undefined,
  right: PortableRuntimeHealthSnapshot,
): boolean {
  return left?.mode === right.mode
    && left.status === right.status
    && left.issue === right.issue
    && left.consecutiveFailures === right.consecutiveFailures
    && left.lastSuccessfulAt === right.lastSuccessfulAt;
}

export class PortableRuntimeHealthMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private initialized = false;
  private preparedAt?: string;
  private lastSuccessfulAt?: string;
  private consecutiveFailures = 0;
  private lastDeferredAttempt?: number;
  private snapshot?: PortableRuntimeHealthSnapshot;

  constructor(private readonly options: PortableRuntimeHealthMonitorOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    const marker = readMarkerHealthFields(this.options.markerPath);
    this.preparedAt = marker.preparedAt ?? new Date(this.now()).toISOString();
    this.lastSuccessfulAt = marker.lastSuccessfulAt;
  }

  private evaluate(): PortableRuntimeHealthSnapshot {
    this.initialize();
    const staleAfterMs = Math.max(1, this.options.staleAfterMs ?? PORTABLE_RUNTIME_STALE_AFTER_MS);
    const failureThreshold = Math.max(
      1,
      Math.floor(this.options.failureWarningThreshold ?? PORTABLE_RUNTIME_FAILURE_WARNING_THRESHOLD),
    );
    const baselineAt = this.lastSuccessfulAt ?? this.preparedAt;
    const overdue = baselineAt !== undefined && this.now() - Date.parse(baselineAt) >= staleAfterMs;
    let issue: PortableRuntimeHealthIssue | undefined;

    if (!this.lastSuccessfulAt && (overdue || this.consecutiveFailures >= failureThreshold)) {
      issue = 'snapshot-not-completed';
    } else if (overdue) {
      issue = 'snapshot-overdue';
    } else if (this.consecutiveFailures >= failureThreshold) {
      issue = 'snapshot-repeatedly-deferred';
    }

    return {
      mode: 'portable',
      status: issue ? 'warning' : this.lastSuccessfulAt ? 'healthy' : 'pending',
      consecutiveFailures: this.consecutiveFailures,
      ...(this.lastSuccessfulAt ? { lastSuccessfulAt: this.lastSuccessfulAt } : {}),
      ...(issue ? { issue } : {}),
    };
  }

  private publish(): PortableRuntimeHealthSnapshot {
    const next = this.evaluate();
    if (!sameSnapshot(this.snapshot, next)) {
      this.snapshot = next;
      try {
        this.options.onChange?.({ ...next });
      } catch {
        // Health delivery must not change the outcome of the snapshot operation.
      }
    }
    return { ...next };
  }

  start(): void {
    if (this.timer) return;
    this.publish();
    const checkIntervalMs = Math.max(1_000, this.options.checkIntervalMs ?? 5 * 60_000);
    this.timer = setInterval(() => this.publish(), checkIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  observeSnapshotEvent(details: unknown): void {
    const event = ownValue(details, 'event');
    if (event === 'portable-runtime-snapshot-deferred') {
      const reportedAttempt = ownValue(details, 'attempt');
      const nextAttempt = typeof reportedAttempt === 'number'
        && Number.isFinite(reportedAttempt)
        && reportedAttempt >= 1
        ? Math.floor(reportedAttempt)
        : undefined;
      if (nextAttempt !== undefined && nextAttempt === this.lastDeferredAttempt) return;
      this.lastDeferredAttempt = nextAttempt;
      this.consecutiveFailures = Math.min(
        30,
        Math.max(this.consecutiveFailures + 1, nextAttempt ?? this.consecutiveFailures + 1),
      );
      this.publish();
      return;
    }
    if (event === 'portable-runtime-snapshot-completed') {
      this.consecutiveFailures = 0;
      this.lastDeferredAttempt = undefined;
      this.lastSuccessfulAt = new Date(this.now()).toISOString();
      this.publish();
    }
  }

  getSnapshot(): PortableRuntimeHealthSnapshot {
    return this.publish();
  }
}

let activeMonitor: PortableRuntimeHealthMonitor | null = null;

export function setActivePortableRuntimeHealthMonitor(
  monitor: PortableRuntimeHealthMonitor | null,
): void {
  activeMonitor = monitor;
}

export function getPortableRuntimeHealthSnapshot(): PortableRuntimeHealthSnapshot | null {
  return activeMonitor?.getSnapshot() ?? null;
}
