/**
 * SSE transport — the zero-configuration path.
 *
 * Inbound events arrive on an `EventSource` pointed at our own
 * `/api/rooms/[code]/stream`; outbound events go over the shared POST path in
 * `BaseTransport`. Credentials travel as query parameters because `EventSource`
 * cannot set headers — the same contract the route already enforces.
 *
 * `EventSource` reconnects by itself, which would race the backoff in
 * `BaseTransport` and reconnect silently without a resync. So each stream is
 * treated as one-shot: on any error it is closed and handed back to the base
 * class, which owns the retry schedule and the snapshot that follows.
 */

import type { ServerEnvelope, TransportConfig } from '@/types/events';

import { BaseTransport } from './transport';

export class SseTransport extends BaseTransport {
  /** The route sends a snapshot as its first message, so we need not ask. */
  protected readonly fetchesSnapshot = false;

  private source: EventSource | null = null;

  constructor(config: TransportConfig) {
    super(config);
  }

  protected openChannel(): void {
    this.closeChannel();
    const query = new URLSearchParams({
      playerId: this.config.playerId,
      token: this.config.token,
    });
    const url = `/api/rooms/${encodeURIComponent(this.config.roomCode)}/stream?${query.toString()}`;

    const source = new EventSource(url);
    this.source = source;

    source.onopen = () => {
      if (this.source !== source) return;
      this.channelUp();
    };

    source.onmessage = (message: MessageEvent<string>) => {
      if (this.source !== source) return;
      let envelope: ServerEnvelope;
      try {
        envelope = JSON.parse(message.data) as ServerEnvelope;
      } catch {
        return;
      }
      this.channelEnvelope(envelope);
    };

    source.onerror = () => {
      if (this.source !== source) return;
      // Indistinguishable from here: the 270s budget ran out, the network
      // blipped, or the room is gone. The base class reconnects and the
      // snapshot that follows settles which it was.
      this.channelDown('stream ended');
    };
  }

  protected closeChannel(): void {
    if (!this.source) return;
    const source = this.source;
    this.source = null;
    source.onopen = source.onmessage = source.onerror = null;
    source.close();
  }
}
