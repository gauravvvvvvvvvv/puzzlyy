/**
 * Realtime fan-out seam.
 *
 * Mutations are decided by `session.ts` against Postgres; this module is only
 * responsible for *telling everyone*. Separating the two is what removes server
 * memory from the correctness path — a delivery that gets lost costs a client
 * one round-trip to resync, not a corrupted puzzle.
 *
 * Two implementations:
 *
 *   - `MemoryBroadcaster` — hands events to SSE streams held open by this same
 *     process. Zero configuration, so `npm run dev` works with no accounts, but
 *     only correct when every request reaches one process.
 *   - `SupabaseBroadcaster` — POSTs to Supabase Realtime's broadcast endpoint.
 *     Clients hold a WebSocket to Supabase rather than to us, which is what
 *     makes this work across serverless instances *and* sidesteps Vercel's
 *     300-second function ceiling: no function stays open to stream.
 *
 * ## Ephemeral traffic does not come through here
 *
 * Cursors, in-flight drag positions, reactions and "look here" pings go
 * client-to-client on the same Realtime channel and never touch a function or
 * the database (spec §27). Only decided facts are published here.
 */

import type { ServerEnvelope, ServerEvent } from '@/types/events';
import {
  supabaseAnonKey,
  supabasePublicUrl,
  supabaseServiceKey,
  supabaseUrl,
} from './store';

/** One event, optionally addressed to a single player. */
export interface Delivery {
  /** null = everyone in the room. */
  to: string | null;
  envelope: ServerEnvelope;
}

export interface Broadcaster {
  readonly kind: string;
  publish(code: string, deliveries: Delivery[]): Promise<void>;
}

/** Realtime topic for a room. Also used by the browser client. */
export function roomTopic(code: string): string {
  return `puzzly:${code}`;
}

/** Broadcast event name inside the topic. One name keeps the client simple. */
export const ROOM_EVENT = 'evt';

/* -------------------------------------------------------------------------- */
/* Local bus (dev / single-process SSE)                                       */
/* -------------------------------------------------------------------------- */

export interface LocalSubscriber {
  id: string;
  playerId: string;
  send: (delivery: Delivery) => void;
}

interface LocalBus {
  rooms: Map<string, Set<LocalSubscriber>>;
}

declare global {
  // eslint-disable-next-line no-var
  var __puzzlyBus: LocalBus | undefined;
  // eslint-disable-next-line no-var
  var __puzzlyBroadcaster: Broadcaster | undefined;
}

function bus(): LocalBus {
  globalThis.__puzzlyBus ??= { rooms: new Map() };
  return globalThis.__puzzlyBus;
}

/** Attach an SSE stream. Returns an unsubscribe function. */
export function subscribeLocal(code: string, subscriber: LocalSubscriber): () => void {
  const b = bus();
  let set = b.rooms.get(code);
  if (!set) {
    set = new Set();
    b.rooms.set(code, set);
  }
  set.add(subscriber);
  return () => {
    const current = bus().rooms.get(code);
    if (!current) return;
    current.delete(subscriber);
    if (current.size === 0) bus().rooms.delete(code);
  };
}

export function localSubscriberCount(code: string): number {
  return bus().rooms.get(code)?.size ?? 0;
}

/**
 * Hand deliveries to any SSE stream this process is holding open.
 *
 * Costs nothing when nobody is listening, which is why *both* broadcasters call
 * it rather than only the memory one.
 */
function deliverLocal(code: string, deliveries: Delivery[]): void {
  const set = bus().rooms.get(code);
  if (!set?.size) return;
  for (const delivery of deliveries) {
    for (const subscriber of [...set]) {
      if (delivery.to && subscriber.playerId !== delivery.to) continue;
      try {
        subscriber.send(delivery);
      } catch {
        // The stream is gone; drop it rather than retrying forever.
        set.delete(subscriber);
      }
    }
  }
}

class MemoryBroadcaster implements Broadcaster {
  readonly kind = 'memory';

  async publish(code: string, deliveries: Delivery[]): Promise<void> {
    deliverLocal(code, deliveries);
  }
}

/* -------------------------------------------------------------------------- */
/* Supabase Realtime                                                          */
/* -------------------------------------------------------------------------- */

/** Supabase accepts a batch; keep requests comfortably small. */
const MAX_MESSAGES_PER_REQUEST = 50;

interface BroadcastMessage {
  topic: string;
  event: string;
  payload: { to: string | null; seq: number; event: ServerEvent };
  private: boolean;
}

class SupabaseBroadcaster implements Broadcaster {
  readonly kind = 'supabase';
  private endpoint: string;
  private key: string;

  constructor(url: string, key: string) {
    this.endpoint = `${url.replace(/\/$/, '')}/realtime/v1/api/broadcast`;
    this.key = key;
  }

  async publish(code: string, deliveries: Delivery[]): Promise<void> {
    if (!deliveries.length) return;

    // Also feed any SSE stream this instance is holding.
    //
    // Publishing to Supabase does not imply anyone is *listening* to Supabase.
    // `realtimeMode()` only tells the browser to use Realtime when the two
    // `NEXT_PUBLIC_` vars are set as well, so the ordinary half-configured
    // deployment — service key present, anon key forgotten — has clients on SSE
    // while this class handles the fan-out. Without this line those rooms open
    // their stream, receive the snapshot, and then never hear another word: the
    // puzzle silently stops being multiplayer. It is also correct in the fully
    // configured case, where it costs one empty Map lookup, and it makes the
    // transport switchover seamless for a client that is mid-migration.
    deliverLocal(code, deliveries);

    const topic = roomTopic(code);
    const messages: BroadcastMessage[] = deliveries.map((d) => ({
      topic,
      event: ROOM_EVENT,
      // `to` travels in the payload; clients ignore anything not addressed to
      // them. Nothing here is secret — the room code is the only credential
      // needed to join in the first place — so this is a routing hint, not a
      // security boundary.
      payload: { to: d.to, seq: d.envelope.seq, event: d.envelope.event },
      private: false,
    }));

    for (let i = 0; i < messages.length; i += MAX_MESSAGES_PER_REQUEST) {
      const batch = messages.slice(i, i + MAX_MESSAGES_PER_REQUEST);
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            apikey: this.key,
            Authorization: `Bearer ${this.key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ messages: batch }),
          cache: 'no-store',
        });
        if (!res.ok) {
          console.warn(
            `[puzzly] realtime broadcast -> ${res.status} ${(await res.text()).slice(0, 200)}`,
          );
        }
      } catch (error) {
        // A failed broadcast is recoverable: the database already has the
        // truth, and clients resync when they notice a gap in `seq`.
        console.warn('[puzzly] realtime broadcast failed', error);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */

export function getBroadcaster(): Broadcaster {
  if (globalThis.__puzzlyBroadcaster) return globalThis.__puzzlyBroadcaster;
  const url = supabaseUrl();
  const key = supabaseServiceKey();
  const broadcaster: Broadcaster =
    url && key ? new SupabaseBroadcaster(url, key) : new MemoryBroadcaster();
  globalThis.__puzzlyBroadcaster = broadcaster;
  return broadcaster;
}

/**
 * Which transport the browser should use for this deployment.
 *
 * Both halves have to be in place: we must be able to publish (service key) and
 * the browser must be able to subscribe (`NEXT_PUBLIC_` URL + anon key). If
 * either is missing, saying `supabase` would send clients to a socket they cannot
 * open, so the SSE fallback is the honest answer.
 */
export function realtimeMode(): 'supabase' | 'sse' {
  const canPublish = Boolean(supabaseUrl() && supabaseServiceKey());
  const canSubscribe = Boolean(supabasePublicUrl() && supabaseAnonKey());
  return canPublish && canSubscribe ? 'supabase' : 'sse';
}
