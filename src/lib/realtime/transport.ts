/**
 * Shared transport machinery.
 *
 * Both realtime backends differ only in how inbound events *arrive*: SSE holds a
 * stream open to our own function, Supabase Realtime holds a WebSocket to
 * Supabase. Everything else — batching, ordering, gap detection, reconnection,
 * keep-alive — is identical, so it lives here and each backend implements three
 * small methods.
 *
 * ## What this class guarantees to the app above it
 *
 *  - `send()` is safe at pointer-event rates. Events are coalesced and flushed
 *    on a timer, well inside the server's per-seat budget.
 *  - Events are delivered **in order, exactly once**. Duplicates are dropped by
 *    sequence number, brief out-of-order arrivals are buffered, and a real gap
 *    triggers a resync rather than silently diverging.
 *  - A dropped connection is transparent. It reconnects with backoff and the
 *    first thing to arrive is a snapshot, so state is rebuilt rather than
 *    guessed. Nothing the player did is lost — the outbox survives the outage.
 *
 * That last point is the one that matters most: the puzzle must never silently
 * lose progress (spec §22).
 */

import type {
  ClientEvent,
  ConnectionStatus,
  RealtimeTransport,
  ServerEnvelope,
  ServerEvent,
  TransportConfig,
} from '@/types/events';

import { ApiError, beaconEvents, postEvents } from './api';
import { Outbox } from './outbox';

/** ~12 batches/second. With coalescing that is the real event rate. */
const FLUSH_MS = 80;
const MAX_BATCH = 40;
/** Lock TTL is 20s server-side, so this gives two chances before expiry. */
const ALIVE_MS = 8_000;
/** How long to wait for a missing sequence number before giving up on it. */
const GAP_TIMEOUT_MS = 500;
const MAX_PENDING = 64;
const BACKOFF_BASE_MS = 600;
const BACKOFF_MAX_MS = 20_000;
/**
 * A connection that lasted this long was healthy, so its ending is routine (the
 * SSE route deliberately hangs up at 270s) and reconnection starts from zero
 * rather than escalating a backoff that has nothing to do with a real problem.
 */
const STABLE_MS = 25_000;
/** While dragging, the moving group already shows where the pointer is. */
const CURSOR_DURING_DRAG_MS = 220;

export abstract class BaseTransport implements RealtimeTransport {
  protected readonly config: TransportConfig;

  /** True when the backend does not send a snapshot on connect by itself. */
  protected abstract readonly fetchesSnapshot: boolean;

  private outbox = new Outbox();
  private state: ConnectionStatus = 'idle';
  private detail: string | undefined;

  private lastSeq = 0;
  private waiting = new Map<number, ServerEvent>();

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private aliveTimer: ReturnType<typeof setInterval> | null = null;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private attempts = 0;
  private openedAt = 0;
  private sending = false;
  private pausedUntil = 0;
  private disposed = false;

  /** Groups this client currently holds, so `alive` can refresh their locks. */
  private holding = new Set<number>();
  private lastCursorAt = 0;

  constructor(config: TransportConfig) {
    this.config = config;
  }

  get status(): ConnectionStatus {
    return this.state;
  }

  /** The last sequence number applied. Exposed for diagnostics. */
  get sequence(): number {
    return this.lastSeq;
  }

  /* ------------------------------------------------------------------ */
  /* Backend contract                                                   */
  /* ------------------------------------------------------------------ */

  /** Open the inbound channel. Call `channelUp` / `channelEnvelope` / `channelDown`. */
  protected abstract openChannel(): void;
  protected abstract closeChannel(): void;

  /** The channel is live. */
  protected channelUp(): void {
    if (this.disposed) return;
    this.attempts = 0;
    this.openedAt = Date.now();
    this.setStatus('connected');
    if (this.fetchesSnapshot) this.requestResync();
  }

  /** One envelope arrived. */
  protected channelEnvelope(envelope: ServerEnvelope): void {
    if (this.disposed) return;
    if (!envelope || typeof envelope.seq !== 'number' || !envelope.event) return;
    this.ingest(envelope);
  }

  /** The channel ended. Anything other than an explicit close reconnects. */
  protected channelDown(detail?: string): void {
    if (this.disposed) return;
    this.closeChannel();
    const wasStable = this.openedAt > 0 && Date.now() - this.openedAt >= STABLE_MS;
    if (wasStable) this.attempts = 0;
    this.openedAt = 0;
    this.setStatus('reconnecting', detail);
    this.scheduleRetry();
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  connect(): void {
    if (this.disposed) return;
    this.setStatus(this.state === 'idle' ? 'connecting' : this.state);
    this.startTimers();
    this.bindWindow();
    this.openChannel();
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Leave cleanly if we can: the queue plus a `bye` in one beacon, which
    // survives the page unloading. Without this the seat lingers until its
    // presence expires.
    const remaining = this.outbox.snapshot();
    this.outbox.clear();
    const farewell: ClientEvent[] = [...remaining.filter((e) => e.t !== 'cursor'), { t: 'bye' }];
    beaconEvents(this.config.roomCode, this.config.playerId, this.config.token, farewell);

    this.stopTimers();
    this.unbindWindow();
    this.closeChannel();
    this.setStatus('closed');
  }

  private startTimers(): void {
    this.flushTimer ??= setInterval(() => void this.pump(), FLUSH_MS);
    this.aliveTimer ??= setInterval(() => {
      if (this.state !== 'connected') return;
      this.send({ t: 'alive', holding: [...this.holding] });
    }, ALIVE_MS);
  }

  private stopTimers(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.aliveTimer) clearInterval(this.aliveTimer);
    if (this.gapTimer) clearTimeout(this.gapTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.flushTimer = this.aliveTimer = null;
    this.gapTimer = this.retryTimer = null;
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer) return;
    const step = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempts);
    // Jitter, so two players who dropped together do not retry in lockstep.
    const delay = Math.round(step * (0.7 + Math.random() * 0.6));
    this.attempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.disposed) return;
      this.openChannel();
    }, delay);
  }

  /** Reconnect now, ignoring the backoff — the network just came back. */
  private retryNow(): void {
    if (this.disposed || this.state === 'connected') return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.attempts = 0;
    this.setStatus('reconnecting');
    this.openChannel();
  }

  /* ------------------------------------------------------------------ */
  /* Browser lifecycle                                                  */
  /* ------------------------------------------------------------------ */

  private onOnline = (): void => this.retryNow();
  private onOffline = (): void => this.setStatus('reconnecting', 'offline');
  private onVisible = (): void => {
    if (document.visibilityState !== 'visible') return;
    // A backgrounded tab has its timers throttled and its stream often killed,
    // so coming back should feel instant rather than waiting out a backoff.
    if (this.state !== 'connected') this.retryNow();
    else this.requestResync();
  };
  private onPageHide = (): void => {
    const queued = this.outbox.snapshot();
    if (!queued.length) return;
    this.outbox.clear();
    beaconEvents(this.config.roomCode, this.config.playerId, this.config.token, queued);
  };

  private bindWindow(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  private unbindWindow(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  /* ------------------------------------------------------------------ */
  /* Outbound                                                           */
  /* ------------------------------------------------------------------ */

  send(event: ClientEvent): void {
    if (this.disposed) return;
    // Track holds here rather than making the caller tell us twice.
    if (event.t === 'grab') this.holding.add(event.g);
    if (event.t === 'drop') this.holding.delete(event.g);
    this.outbox.push(event);
    // Anything the player will notice immediately goes without waiting.
    if (URGENT.has(event.t)) void this.pump();
  }

  flush(): void {
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.disposed || this.sending || !this.outbox.pending) return;
    if (Date.now() < this.pausedUntil) return;

    const batch = this.decimate(this.outbox.drain(MAX_BATCH));
    if (!batch.length) return;

    // Backends that can reach the other players directly take the ephemeral
    // traffic here, so cursors and drag frames never cost a function
    // invocation or a database read (spec §27, architecture §4).
    const remaining = this.takeEphemeral(batch);
    if (!remaining.length) return;

    this.sending = true;
    try {
      await postEvents(this.config.roomCode, this.config.playerId, this.config.token, remaining);
      // A successful write means the round trip works even if the inbound
      // channel is still coming up.
      if (this.state === 'error') this.setStatus('reconnecting');
    } catch (error) {
      this.handleSendError(error, remaining);
    } finally {
      this.sending = false;
    }
  }

  /**
   * Deliver what this backend can send peer-to-peer and return everything that
   * still has to go through the server. The default keeps the whole batch: a
   * backend with no peer channel simply sends it all.
   */
  protected takeEphemeral(batch: ClientEvent[]): ClientEvent[] {
    return batch;
  }

  /**
   * Drop the cursor from a batch that already carries a drag update: the moving
   * group shows where the pointer is, so a separate cursor event is redundant
   * traffic. It still goes out a few times a second so the name label follows.
   */
  private decimate(batch: ClientEvent[]): ClientEvent[] {
    const now = Date.now();
    const hasMove = batch.some((event) => event.t === 'move');
    if (!hasMove) {
      if (batch.some((event) => event.t === 'cursor')) this.lastCursorAt = now;
      return batch;
    }
    if (now - this.lastCursorAt >= CURSOR_DURING_DRAG_MS) {
      this.lastCursorAt = now;
      return batch;
    }
    return batch.filter((event) => event.t !== 'cursor');
  }

  private handleSendError(error: unknown, batch: ClientEvent[]): void {
    this.outbox.requeue(batch);

    if (!(error instanceof ApiError)) {
      this.setStatus('reconnecting', 'network');
      return;
    }

    // The seat is gone — a rejoin is needed, and retrying cannot fix it.
    if (error.status === 401 || error.status === 404) {
      this.outbox.clear();
      this.setStatus('error', error.message);
      return;
    }

    if (error.status === 429) {
      this.pausedUntil = Date.now() + Math.max(1_000, (error.retryAfter ?? 1) * 1000);
      return;
    }

    if (error.status === 0) {
      this.setStatus('reconnecting', 'offline');
      return;
    }

    if (error.transient) {
      this.pausedUntil = Date.now() + 800;
      return;
    }

    // A 4xx we cannot retry: the batch would fail forever, so drop it and say so.
    this.outbox.clear();
    this.setStatus('error', error.message);
  }

  /* ------------------------------------------------------------------ */
  /* Inbound ordering                                                   */
  /* ------------------------------------------------------------------ */

  private ingest(envelope: ServerEnvelope): void {
    const { seq, event } = envelope;

    if (event.t === 'snapshot') {
      // A snapshot that predates what we have already applied is stale — it can
      // only arrive that way if it raced a live event.
      if (event.seq < this.lastSeq) return;
      this.lastSeq = event.seq;
      this.waiting.clear();
      this.clearGapTimer();
      this.deliver(event);
      return;
    }

    // seq 0 marks ephemeral traffic (cursors, drag frames, reactions, pings).
    // It is exempt from ordering on purpose: it carries no state to lose, and
    // gap-checking it would make every cursor jitter look like packet loss.
    if (seq === 0) {
      this.deliver(event);
      return;
    }

    if (seq <= this.lastSeq) return; // already applied
    if (seq === this.lastSeq + 1) {
      this.lastSeq = seq;
      this.deliver(event);
      this.drainWaiting();
      return;
    }

    // Out of order. Hold it briefly in case the missing one is right behind.
    this.waiting.set(seq, event);
    if (this.waiting.size > MAX_PENDING) {
      this.giveUpOnGap();
      return;
    }
    this.armGapTimer();
  }

  private drainWaiting(): void {
    for (;;) {
      const next = this.waiting.get(this.lastSeq + 1);
      if (!next) break;
      this.waiting.delete(this.lastSeq + 1);
      this.lastSeq += 1;
      this.deliver(next);
    }
    if (this.waiting.size === 0) this.clearGapTimer();
  }

  private armGapTimer(): void {
    this.gapTimer ??= setTimeout(() => {
      this.gapTimer = null;
      this.giveUpOnGap();
    }, GAP_TIMEOUT_MS);
  }

  private clearGapTimer(): void {
    if (!this.gapTimer) return;
    clearTimeout(this.gapTimer);
    this.gapTimer = null;
  }

  /**
   * An event really is missing. Applying what came after it would leave the board
   * subtly wrong — the worst possible outcome — so throw the buffer away and ask
   * for the truth instead.
   */
  private giveUpOnGap(): void {
    this.clearGapTimer();
    this.waiting.clear();
    this.requestResync();
  }

  private requestResync(): void {
    this.send({ t: 'resync' });
  }

  private deliver(event: ServerEvent): void {
    try {
      this.config.handlers.onEvent(event);
    } catch (error) {
      console.error('[puzzly] handler threw on', event.t, error);
    }
  }

  /* ------------------------------------------------------------------ */

  protected setStatus(status: ConnectionStatus, detail?: string): void {
    if (this.state === status && this.detail === detail) return;
    this.state = status;
    this.detail = detail;
    this.config.handlers.onStatus(status, detail);
  }
}

/** Events worth an immediate flush instead of waiting up to 80ms. */
const URGENT = new Set<ClientEvent['t']>([
  'grab',
  'drop',
  'rotate',
  'ready',
  'start',
  'restart',
  'undo',
  'redo',
  'hint',
  'react',
  'ping',
  'resync',
]);
