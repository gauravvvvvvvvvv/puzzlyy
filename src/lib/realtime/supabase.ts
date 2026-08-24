/**
 * Supabase Realtime transport — the production path.
 *
 * The browser holds a WebSocket to Supabase rather than to us, which is what
 * makes multiplayer correct on Vercel: no function has to stay open to stream,
 * so Vercel's 300-second ceiling stops being a factor and any instance can
 * publish to a room without knowing who is listening (architecture §1, §6).
 *
 * ## Why ephemeral traffic never reaches a function
 *
 * A drag produces roughly ten position updates a second. Sent through the
 * server each one would cost a function invocation *and* a read of the whole
 * room record out of Postgres — thousands of reads per puzzle, for information
 * that is stale 100ms later and that `drop` supersedes anyway. Since every
 * player is already on the same broadcast channel, cursors, drag frames,
 * reactions and pings go straight client-to-client with `seq: 0`
 * (architecture §4, spec §27).
 *
 * Those peer messages are batched into one channel message every
 * `PEER_FLUSH_MS`, because Supabase's free tier bills per message and a puzzle
 * should cost a handful of thousands of them, not a hundred thousand.
 *
 * ## What a forged peer event can do
 *
 * Nothing that lasts. Peer traffic carries no authority: a receiver applies a
 * `move` only for a group whose lock the sender actually holds, and the piece's
 * real position is whatever the server decides on `drop`. The blast radius of a
 * lie is a piece that jiggles until the next authoritative event corrects it.
 *
 * The anon key used here is public by design — it grants only what row-level
 * security allows, and the room code is the room's only credential anyway. The
 * service role key never leaves the server (spec §30).
 */

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

import { isReaction } from '@/lib/multiplayer/identity';
import { createId } from '@/lib/ids';
import type { ClientEvent, ServerEvent, TransportConfig } from '@/types/events';

import { BaseTransport } from './transport';

/** Must match `roomTopic` in `lib/server/broadcast.ts`. */
function roomTopic(code: string): string {
  return `puzzly:${code}`;
}

/** Must match `ROOM_EVENT` in `lib/server/broadcast.ts`. */
const ROOM_EVENT = 'evt';

/** One channel message per 100ms, matching Supabase's default client budget. */
const PEER_FLUSH_MS = 100;
/** A single message stays small; beyond this the oldest coalescibles go. */
const MAX_PEER_BATCH = 24;
const MAX_PING_TEXT = 80;

/** Events this transport can deliver without touching the server. */
const PEER_EVENTS = new Set<ClientEvent['t']>(['cursor', 'move', 'react', 'ping']);

/**
 * What arrives on the channel. The server publishes one event per message with a
 * real `seq`; peers publish a batch of `seq: 0` events. Both shapes are accepted
 * so there is only one subscription to reason about.
 */
interface ChannelPayload {
  to?: string | null;
  seq?: number;
  event?: ServerEvent;
  events?: ServerEvent[];
}

export function supabaseBrowserConfig(): { url: string; key: string } | null {
  // Referenced literally so Next can inline them at build time.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return { url, key };
}

/**
 * One client per page. `createClient` opens a socket lazily on first
 * `.channel()`, and the library is loaded on demand so deployments running the
 * SSE fallback never ship it.
 */
let clientPromise: Promise<SupabaseClient> | null = null;

function getClient(url: string, key: string): Promise<SupabaseClient> {
  clientPromise ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(url, key, {
      // No accounts exist, so there is no session to persist and no token to
      // refresh; skipping both avoids pointless storage writes and timers.
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 20 } },
      global: { headers: { 'X-Client-Info': 'puzzly' } },
    }),
  );
  return clientPromise;
}

export class SupabaseTransport extends BaseTransport {
  /** Supabase sends nothing on connect, so we have to ask for the snapshot. */
  protected readonly fetchesSnapshot = true;

  private channel: RealtimeChannel | null = null;
  private subscribed = false;
  /**
   * Bumped on every open and close. The client library loads asynchronously, so
   * a channel that finished arriving for an attempt we already abandoned has to
   * be recognisable and thrown away.
   */
  private generation = 0;

  private peerQueue: ServerEvent[] = [];
  private peerIndex = new Map<string, number>();
  private peerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: TransportConfig) {
    super(config);
  }

  /* ------------------------------------------------------------------ */
  /* Channel                                                            */
  /* ------------------------------------------------------------------ */

  protected openChannel(): void {
    this.closeChannel();
    const credentials = supabaseBrowserConfig();
    if (!credentials) {
      // `createTransport` checks this first, so reaching here means the env
      // changed under us. Reconnecting cannot help.
      this.setStatus('error', 'Realtime is not configured for this deployment.');
      return;
    }

    const generation = (this.generation += 1);
    void getClient(credentials.url, credentials.key)
      .then((client) => {
        if (generation !== this.generation) return;
        this.attach(client, generation);
      })
      .catch(() => {
        if (generation !== this.generation) return;
        this.channelDown('could not load realtime');
      });
  }

  private attach(client: SupabaseClient, generation: number): void {
    const channel = client.channel(roomTopic(this.config.roomCode), {
      // Our own peer messages are already applied locally; echoing them back
      // would double every cursor update.
      config: { broadcast: { self: false } },
    });
    this.channel = channel;
    this.subscribed = false;

    channel.on('broadcast', { event: ROOM_EVENT }, (message: { payload?: unknown }) => {
      if (generation !== this.generation) return;
      this.receive(message.payload);
    });

    channel.subscribe((status: string) => {
      if (generation !== this.generation) return;
      if (status === 'SUBSCRIBED') {
        this.subscribed = true;
        this.channelUp();
        return;
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        this.subscribed = false;
        this.channelDown(status === 'TIMED_OUT' ? 'channel timed out' : 'channel closed');
      }
    });
  }

  protected closeChannel(): void {
    this.generation += 1;
    this.clearPeerTimer();
    this.peerQueue = [];
    this.peerIndex.clear();
    const channel = this.channel;
    if (!channel) return;
    // Null it first: `unsubscribe` reports CLOSED, and the generation bump plus
    // this make sure that does not read as an unexpected drop.
    this.channel = null;
    this.subscribed = false;
    try {
      void channel.unsubscribe();
    } catch {
      // Already gone.
    }
  }

  private receive(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const payload = raw as ChannelPayload;

    // Broadcast reaches every subscriber, so an event meant for one player is
    // filtered here rather than at the sender. Nothing addressed is secret —
    // `to` exists so private snapshots and rejections do not confuse everybody
    // else's board.
    if (payload.to && payload.to !== this.config.playerId) return;

    if (Array.isArray(payload.events)) {
      for (const event of payload.events) {
        if (event && typeof event.t === 'string') this.channelEnvelope({ seq: 0, event });
      }
      return;
    }

    if (!payload.event || typeof payload.seq !== 'number') return;
    this.channelEnvelope({ seq: payload.seq, event: payload.event });
  }

  /* ------------------------------------------------------------------ */
  /* Peer-to-peer ephemeral traffic                                     */
  /* ------------------------------------------------------------------ */

  protected takeEphemeral(batch: ClientEvent[]): ClientEvent[] {
    const keep: ClientEvent[] = [];
    let urgent = false;

    for (const event of batch) {
      if (!PEER_EVENTS.has(event.t)) {
        keep.push(event);
        continue;
      }

      if (!this.subscribed) {
        // A cursor or a drag frame is worthless late, so it is dropped and the
        // next one supersedes it. A reaction or a ping is a deliberate act, so
        // it falls back to the server rather than vanishing.
        if (event.t === 'react' || event.t === 'ping') keep.push(event);
        continue;
      }

      const translated = this.translate(event);
      if (!translated) continue;
      this.enqueuePeer(translated);
      if (event.t === 'react' || event.t === 'ping') urgent = true;
    }

    if (urgent) this.flushPeer();
    else this.armPeerTimer();

    return keep;
  }

  /**
   * Turn a request into the fact the other clients expect to receive. The
   * server does exactly this in `session.ts`; doing it locally is what removes
   * the round trip. Validation is duplicated rather than trusted, so a bug here
   * cannot put a value on the wire the server would have refused.
   */
  private translate(event: ClientEvent): ServerEvent | null {
    const me = this.config.playerId;
    switch (event.t) {
      case 'cursor':
        if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return null;
        return { t: 'cursor', playerId: me, x: event.x, y: event.y, down: Boolean(event.down) };

      case 'move':
        if (!Number.isFinite(event.ox) || !Number.isFinite(event.oy)) return null;
        return { t: 'move', g: event.g, ox: event.ox, oy: event.oy, by: me };

      case 'react':
        if (!isReaction(event.emoji)) return null;
        if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return null;
        return {
          t: 'react',
          playerId: me,
          emoji: event.emoji,
          x: event.x,
          y: event.y,
          id: createId('r', 6),
        };

      case 'ping': {
        if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return null;
        const text =
          typeof event.text === 'string' && event.text.trim()
            ? event.text.replace(/\s+/g, ' ').trim().slice(0, MAX_PING_TEXT)
            : undefined;
        return { t: 'ping', playerId: me, x: event.x, y: event.y, text, id: createId('k', 6) };
      }

      default:
        return null;
    }
  }

  /** Coalesce into the pending message: one cursor, one position per group. */
  private enqueuePeer(event: ServerEvent): void {
    const key =
      event.t === 'cursor' ? 'cursor' : event.t === 'move' ? `move:${event.g}` : null;

    if (key) {
      const existing = this.peerIndex.get(key);
      if (existing !== undefined) {
        this.peerQueue[existing] = event;
        return;
      }
      this.peerIndex.set(key, this.peerQueue.length);
    }

    this.peerQueue.push(event);
    if (this.peerQueue.length > MAX_PEER_BATCH) this.flushPeer();
  }

  private armPeerTimer(): void {
    if (this.peerTimer || !this.peerQueue.length) return;
    this.peerTimer = setTimeout(() => {
      this.peerTimer = null;
      this.flushPeer();
    }, PEER_FLUSH_MS);
  }

  private clearPeerTimer(): void {
    if (!this.peerTimer) return;
    clearTimeout(this.peerTimer);
    this.peerTimer = null;
  }

  private flushPeer(): void {
    this.clearPeerTimer();
    const events = this.peerQueue;
    this.peerQueue = [];
    this.peerIndex.clear();
    const channel = this.channel;
    if (!events.length || !channel || !this.subscribed) return;

    try {
      void channel.send({
        type: 'broadcast',
        event: ROOM_EVENT,
        payload: { to: null, seq: 0, events },
      });
    } catch {
      // Losing ephemeral traffic is a cosmetic hiccup, and the authoritative
      // events that follow put every board back in agreement.
    }
  }
}
