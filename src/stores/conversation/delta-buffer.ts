import type { ConversationEvent } from '../../../shared/conversation-events';

type Flush = (events: ConversationEvent[]) => void;

const queuedEvents: ConversationEvent[] = [];
let scheduled = false;

function schedule(callback: () => void): void {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(callback);
    return;
  }
  queueMicrotask(callback);
}

export function enqueueConversationEvents(events: ConversationEvent[], flush: Flush): void {
  queuedEvents.push(...events);
  if (scheduled) return;
  scheduled = true;
  schedule(() => {
    scheduled = false;
    const batch = queuedEvents.splice(0, queuedEvents.length);
    if (batch.length > 0) flush(batch);
  });
}

export function flushConversationEvents(flush: Flush): void {
  if (queuedEvents.length === 0) return;
  scheduled = false;
  flush(queuedEvents.splice(0, queuedEvents.length));
}

export function resetConversationDeltaBuffer(): void {
  queuedEvents.length = 0;
  scheduled = false;
}
