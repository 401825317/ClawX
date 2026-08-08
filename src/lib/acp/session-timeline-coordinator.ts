import type { AcpTimelineSnapshot } from './timeline-types';

export type SessionTimelineIdentity = {
  sessionKey: string;
  generation: number;
};

export type SessionTimelineRecord = SessionTimelineIdentity & {
  revision: number;
  timeline: AcpTimelineSnapshot;
  workspaceRoot: string | null;
  cwd: string | null;
  retained: boolean;
};

type SessionTimelineInput = SessionTimelineIdentity & {
  timeline: AcpTimelineSnapshot;
  workspaceRoot: string | null;
  cwd: string | null;
};

type CoordinatorOptions = {
  maxUnretainedRecords?: number;
};

type InternalRecord = {
  value: SessionTimelineRecord;
  retainOwners: Set<string>;
  touchedAt: number;
};

function identityKey(identity: SessionTimelineIdentity): string {
  return JSON.stringify([identity.sessionKey, identity.generation]);
}

/** Owns bounded Renderer timeline snapshots without creating a second persisted history. */
export class AcpSessionTimelineCoordinator {
  private readonly records = new Map<string, InternalRecord>();

  private readonly maxUnretainedRecords: number;

  private touchSequence = 0;

  constructor(options: CoordinatorOptions = {}) {
    this.maxUnretainedRecords = Math.max(1, options.maxUnretainedRecords ?? 3);
  }

  /** Returns the exact session generation and marks it as recently used. */
  read(identity: SessionTimelineIdentity): SessionTimelineRecord | undefined {
    const entry = this.records.get(identityKey(identity));
    if (!entry) return undefined;
    entry.touchedAt = this.nextTouch();
    return entry.value;
  }

  /** Replaces one canonical snapshot and advances only that session's revision. */
  replace(input: SessionTimelineInput): SessionTimelineRecord {
    const key = identityKey(input);
    const previous = this.records.get(key);
    const retainOwners = previous?.retainOwners ?? new Set<string>();
    const value: SessionTimelineRecord = {
      ...input,
      revision: (previous?.value.revision ?? 0) + 1,
      retained: retainOwners.size > 0,
    };
    this.records.set(key, { value, retainOwners, touchedAt: this.nextTouch() });
    this.prune();
    return value;
  }

  /** Applies one serialized timeline reduction if the exact generation still exists. */
  update(
    identity: SessionTimelineIdentity,
    reduce: (timeline: AcpTimelineSnapshot) => AcpTimelineSnapshot,
  ): SessionTimelineRecord | undefined {
    const key = identityKey(identity);
    const entry = this.records.get(key);
    if (!entry) return undefined;
    const timeline = reduce(entry.value.timeline);
    entry.touchedAt = this.nextTouch();
    if (timeline === entry.value.timeline) return entry.value;
    entry.value = {
      ...entry.value,
      revision: entry.value.revision + 1,
      timeline,
    };
    return entry.value;
  }

  /** Prevents an asynchronous Turn or attachment from being evicted before delivery settles. */
  retain(identity: SessionTimelineIdentity, owner: string): void {
    const entry = this.records.get(identityKey(identity));
    if (!entry || !owner) return;
    entry.retainOwners.add(owner);
    entry.touchedAt = this.nextTouch();
    if (!entry.value.retained) entry.value = { ...entry.value, retained: true };
  }

  /** Releases one owner while preserving records retained by other in-flight work. */
  release(identity: SessionTimelineIdentity, owner: string): void {
    const entry = this.records.get(identityKey(identity));
    if (!entry || !owner) return;
    entry.retainOwners.delete(owner);
    entry.touchedAt = this.nextTouch();
    const retained = entry.retainOwners.size > 0;
    if (entry.value.retained !== retained) entry.value = { ...entry.value, retained };
    this.prune();
  }

  /** Removes all in-memory generations for a deleted or explicitly reset session. */
  removeSession(sessionKey: string): void {
    for (const [key, entry] of this.records) {
      if (entry.value.sessionKey === sessionKey) this.records.delete(key);
    }
  }

  /** Clears process-local coordination state during Store teardown and isolated tests. */
  clear(): void {
    this.records.clear();
    this.touchSequence = 0;
  }

  private nextTouch(): number {
    this.touchSequence += 1;
    return this.touchSequence;
  }

  /** Bounds only settled records; in-flight retained work is never evicted. */
  private prune(): void {
    const unretained = [...this.records.entries()]
      .filter(([, entry]) => entry.retainOwners.size === 0)
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt);
    while (unretained.length > this.maxUnretainedRecords) {
      const oldest = unretained.shift();
      if (oldest) this.records.delete(oldest[0]);
    }
  }
}
