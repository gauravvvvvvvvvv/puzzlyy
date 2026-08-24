/**
 * Outbound event queue.
 *
 * A pointer move fires 60+ times a second and a drag can involve hundreds of
 * them, but only the *latest* position of a group matters. So events are queued
 * rather than sent, coalesced on the way in, and flushed as one small batch on a
 * timer. That is what makes `transport.send()` safe to call from a pointermove
 * handler (spec §27: throttle cursors, batch updates).
 *
 * Coalescing has to respect ordering. `grab g1 → move g1 → drop g1 → grab g1 →
 * move g1` must not fold the last move into the first: the scan stops at the
 * first queued event that touches the same group, and only merges if that event
 * is itself a `move`.
 */

import type { ClientEvent } from '@/types/events';

/**
 * A queue this long means the connection has been down for a while. Rather than
 * grow without bound, the oldest droppable events go first.
 */
const MAX_QUEUE = 240;

/** Events that are worthless once superseded, so they can be dropped freely. */
function isDroppable(event: ClientEvent): boolean {
  return event.t === 'cursor' || event.t === 'move' || event.t === 'alive';
}

/** The group a queued event refers to, or null if it is not about one group. */
function groupOf(event: ClientEvent): number | null {
  switch (event.t) {
    case 'grab':
    case 'move':
    case 'drop':
    case 'rotate':
      return event.g;
    default:
      return null;
  }
}

export class Outbox {
  private queue: ClientEvent[] = [];

  get size(): number {
    return this.queue.length;
  }

  /** True when a flush would actually send something. */
  get pending(): boolean {
    return this.queue.length > 0;
  }

  push(event: ClientEvent): void {
    if (this.coalesce(event)) return;
    this.queue.push(event);
    if (this.queue.length > MAX_QUEUE) this.trim();
  }

  /**
   * Fold `event` into something already queued. Returns true when it was
   * absorbed and should not be appended.
   */
  private coalesce(event: ClientEvent): boolean {
    switch (event.t) {
      // Only the newest position matters, and nothing else in the queue depends
      // on a cursor, so it can be replaced wherever it sits.
      case 'cursor': {
        const index = this.lastIndexOfType('cursor');
        if (index < 0) return false;
        this.queue[index] = event;
        return true;
      }

      case 'move': {
        for (let i = this.queue.length - 1; i >= 0; i -= 1) {
          const queued = this.queue[i]!;
          if (groupOf(queued) !== event.g) continue;
          // A grab, drop or rotate in between is a barrier: this move belongs
          // after it.
          if (queued.t !== 'move') return false;
          this.queue[i] = event;
          return true;
        }
        return false;
      }

      // Latest wins; these carry no history worth keeping.
      case 'alive':
      case 'ready': {
        const index = this.lastIndexOfType(event.t);
        if (index < 0) return false;
        this.queue[index] = event;
        return true;
      }

      // Asking twice achieves nothing but a second snapshot.
      case 'resync':
        return this.lastIndexOfType('resync') >= 0;

      default:
        return false;
    }
  }

  private lastIndexOfType(type: ClientEvent['t']): number {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      if (this.queue[i]!.t === type) return i;
    }
    return -1;
  }

  /** Shed the oldest droppable events, then the oldest events at all. */
  private trim(): void {
    const kept = this.queue.filter((event) => !isDroppable(event));
    this.queue = kept.length > MAX_QUEUE ? kept.slice(kept.length - MAX_QUEUE) : kept;
  }

  /** Take up to `max` events off the front. */
  drain(max: number): ClientEvent[] {
    if (this.queue.length <= max) {
      const all = this.queue;
      this.queue = [];
      return all;
    }
    return this.queue.splice(0, max);
  }

  /**
   * Put a failed batch back at the front, minus anything that has since gone
   * stale — resending a two-second-old cursor position is worse than useless.
   */
  requeue(events: ClientEvent[]): void {
    const worthRetrying = events.filter((event) => !isDroppable(event));
    if (!worthRetrying.length) return;
    this.queue.unshift(...worthRetrying);
    if (this.queue.length > MAX_QUEUE) this.trim();
  }

  /** Peek without consuming, for the final beacon on page hide. */
  snapshot(): ClientEvent[] {
    return [...this.queue];
  }

  clear(): void {
    this.queue = [];
  }
}
