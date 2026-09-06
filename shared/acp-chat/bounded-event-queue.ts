/**
 * A small mutable FIFO used while an ACP session is loading.
 *
 * The old implementation rebuilt an array with `[old, ...new]` for every
 * notification.  Apart from retaining everything forever, that makes a busy
 * load quadratic in allocations.  This queue appends in place and only
 * compacts its backing array occasionally.
 */

export type BoundedEventQueueOptions<T> = {
  maxEntries: number;
  maxBytes: number;
  estimateBytes?: (value: T, budget: number) => number;
  /** Protected values are kept in preference to intermediate stream chunks. */
  isProtected?: (value: T) => boolean;
};

export type BoundedEventQueueStats = {
  size: number;
  bytes: number;
  dropped: number;
  droppedProtected: number;
};

type QueueEntry<T> = {
  value: T;
  bytes: number;
  protected: boolean;
  evicted?: boolean;
};

const DEFAULT_ESTIMATE_BUDGET = 64 * 1024;

/**
 * A bounded, allocation-friendly FIFO.
 *
 * Normal appends do not copy existing entries.  When the queue is full, the
 * oldest unprotected entry is evicted first.  If a stream consists entirely
 * of protected values, the oldest protected value is evicted as a last resort
 * so a malformed producer cannot grow memory without bound; the newest
 * terminal/error value therefore remains available to the consumer.
 */
export class BoundedEventQueue<T> {
  private entries: Array<QueueEntry<T> | undefined> = [];

  private head = 0;

  private entryCount = 0;

  private totalBytes = 0;

  private droppedCount = 0;

  private droppedProtectedCount = 0;

  private readonly maxEntries: number;

  private readonly maxBytes: number;

  private readonly estimate: (value: T, budget: number) => number;

  private readonly protectedPredicate: (value: T) => boolean;

  public constructor(options: BoundedEventQueueOptions<T>) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new Error('BoundedEventQueue maxEntries must be a positive integer');
    }
    if (!Number.isFinite(options.maxBytes) || options.maxBytes < 1) {
      throw new Error('BoundedEventQueue maxBytes must be positive');
    }
    this.maxEntries = options.maxEntries;
    this.maxBytes = options.maxBytes;
    this.estimate = options.estimateBytes ?? ((value, budget) => estimateValueBytes(value, budget));
    this.protectedPredicate = options.isProtected ?? (() => false);
  }

  public get size(): number {
    return this.entryCount;
  }

  public get bytes(): number {
    return this.totalBytes;
  }

  public get dropped(): number {
    return this.droppedCount;
  }

  public get droppedProtected(): number {
    return this.droppedProtectedCount;
  }

  public push(value: T): boolean {
    const budget = this.maxBytes + 1;
    const bytes = Math.max(1, Math.min(this.maxBytes + 1, this.estimate(value, budget)));
    const protectedValue = this.protectedPredicate(value);
    // Never retain one arbitrarily large object. Callers that need to keep a
    // terminal record should bound its fields before enqueueing it; allowing a
    // single protected record to exceed maxBytes would defeat this queue's
    // memory-safety contract.
    if (bytes > this.maxBytes) {
      this.droppedCount += 1;
      if (protectedValue) this.droppedProtectedCount += 1;
      return false;
    }
    const entry: QueueEntry<T> = { value, bytes, protected: protectedValue };
    this.entries.push(entry);
    this.entryCount += 1;
    this.totalBytes += bytes;
    this.enforceBounds();

    return !entry.evicted;
  }

  public pushMany(values: readonly T[]): number {
    let retained = 0;
    for (const value of values) {
      if (this.push(value)) retained += 1;
    }
    return retained;
  }

  public toArray(): T[] {
    this.compact(true);
    return this.entries.slice(this.head).flatMap((entry) => entry ? [entry.value] : []);
  }

  public clear(): void {
    this.entries = [];
    this.head = 0;
    this.entryCount = 0;
    this.totalBytes = 0;
    this.droppedCount = 0;
    this.droppedProtectedCount = 0;
  }

  public stats(): BoundedEventQueueStats {
    return {
      size: this.size,
      bytes: this.totalBytes,
      dropped: this.droppedCount,
      droppedProtected: this.droppedProtectedCount,
    };
  }

  private enforceBounds(): void {
    while (this.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const index = this.findEvictionIndex();
      if (index < 0) break;
      const entry = this.entries[index];
      if (!entry) break;
      entry.evicted = true;
      this.entries[index] = undefined;
      this.entryCount = Math.max(0, this.entryCount - 1);
      this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
      this.droppedCount += 1;
      if (entry.protected) this.droppedProtectedCount += 1;
      if (index === this.head) this.advanceHead();
    }
    this.compact(false);
  }

  private findEvictionIndex(): number {
    // Prefer dropping intermediate stream chunks.  A linear scan only occurs
    // when a bound is crossed; ordinary appends remain O(1).
    for (let index = this.head; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (entry && !entry.protected) return index;
    }
    // If all values are protected, drop the oldest one as a hard safety valve.
    if (this.size <= 1) return -1;
    for (let index = this.head; index < this.entries.length; index += 1) {
      if (this.entries[index]) return index;
    }
    return -1;
  }

  private advanceHead(): void {
    while (this.head < this.entries.length && !this.entries[this.head]) this.head += 1;
  }

  private compact(force: boolean): void {
    this.advanceHead();
    if (this.head === 0) return;
    if (!force && this.head < 64 && this.head * 2 < this.entries.length) return;
    this.entries = this.entries.slice(this.head).filter((entry): entry is QueueEntry<T> => Boolean(entry));
    this.head = 0;
  }
}

/**
 * A bounded, cycle-safe estimate.  It intentionally overestimates strings as
 * UTF-16 bytes, which is useful for backpressure and avoids JSON.stringify
 * allocating a second copy of a large ACP payload.
 */
export function estimateValueBytes(value: unknown, budget = DEFAULT_ESTIMATE_BUDGET): number {
  const seen = new Set<object>();
  return estimateValueBytesInternal(value, Math.max(1, budget), seen);
}

function estimateValueBytesInternal(value: unknown, budget: number, seen: Set<object>): number {
  if (budget <= 0) return 0;
  if (typeof value === 'string') return Math.min(budget, value.length * 2 + 8);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return Math.min(budget, 16);
  if (value == null) return 4;
  if (typeof value !== 'object') return 8;
  if (seen.has(value)) return 8;
  seen.add(value);

  let total = 16;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (total >= budget) break;
      total += estimateValueBytesInternal(item, budget - total, seen);
    }
  } else {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (total >= budget) break;
      total += Math.min(budget - total, key.length * 2 + 8);
      total += estimateValueBytesInternal(item, budget - total, seen);
    }
  }
  seen.delete(value);
  return Math.min(total, budget);
}
