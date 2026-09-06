import { describe, expect, it } from 'vitest';
import { BoundedEventQueue, estimateValueBytes } from '@shared/acp-chat/bounded-event-queue';

type TestEvent = {
  id: number;
  payload: string;
  terminal?: boolean;
};

describe('BoundedEventQueue', () => {
  it('appends in place and keeps only the configured number of intermediate events', () => {
    const queue = new BoundedEventQueue<TestEvent>({
      maxEntries: 3,
      maxBytes: 1_000,
      estimateBytes: () => 10,
    });

    queue.pushMany([
      { id: 1, payload: 'one' },
      { id: 2, payload: 'two' },
      { id: 3, payload: 'three' },
      { id: 4, payload: 'four' },
    ]);

    expect(queue.toArray().map((event) => event.id)).toEqual([2, 3, 4]);
    expect(queue.stats()).toEqual({ size: 3, bytes: 30, dropped: 1, droppedProtected: 0 });
  });

  it('evicts intermediate events before protected terminal events', () => {
    const queue = new BoundedEventQueue<TestEvent>({
      maxEntries: 3,
      maxBytes: 1_000,
      estimateBytes: () => 10,
      isProtected: (event) => event.terminal === true,
    });

    queue.push({ id: 1, payload: 'done', terminal: true });
    queue.push({ id: 2, payload: 'chunk' });
    queue.push({ id: 3, payload: 'done again', terminal: true });
    queue.push({ id: 4, payload: 'latest chunk' });

    expect(queue.toArray().map((event) => event.id)).toEqual([1, 3, 4]);
    expect(queue.stats()).toMatchObject({ dropped: 1, droppedProtected: 0 });
  });

  it('rejects a single oversized value even when it is protected', () => {
    const queue = new BoundedEventQueue<TestEvent>({
      maxEntries: 2,
      maxBytes: 8,
      estimateBytes: (event) => event.payload.length,
      isProtected: (event) => event.terminal === true,
    });

    expect(queue.push({ id: 1, payload: 'a very large failure', terminal: true })).toBe(false);
    expect(queue.toArray()).toEqual([]);
    expect(queue.stats()).toEqual({ size: 0, bytes: 0, dropped: 1, droppedProtected: 1 });
  });

  it('stays bounded across a large synthetic stream and remains cycle-safe', () => {
    const queue = new BoundedEventQueue<TestEvent>({
      maxEntries: 256,
      maxBytes: 8 * 1024,
      estimateBytes: (event, budget) => estimateValueBytes(event, budget),
      isProtected: (event) => event.terminal === true,
    });
    const cyclic: { self?: unknown; text: string } = { text: 'cycle' };
    cyclic.self = cyclic;
    expect(estimateValueBytes(cyclic)).toBeGreaterThan(0);

    for (let index = 0; index < 10_000; index += 1) {
      queue.push({ id: index, payload: 'x'.repeat(64) });
    }
    queue.push({ id: 10_000, payload: 'final', terminal: true });

    expect(queue.size).toBeLessThanOrEqual(256);
    expect(queue.bytes).toBeLessThanOrEqual(8 * 1024);
    expect(queue.toArray().at(-1)).toMatchObject({ id: 10_000, terminal: true });
    expect(queue.dropped).toBeGreaterThan(9_000);
  });
});
