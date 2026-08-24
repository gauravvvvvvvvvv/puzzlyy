/**
 * `GET /api/rooms/[code]/stream` — Server-Sent Events fallback transport.
 *
 * This is the zero-configuration path: it needs no accounts and no keys, so
 * `npm run dev` and a bare deploy both work. Its limitation is structural — the
 * stream is held open by *one* instance, so it is only correct when every
 * request for a room lands on that instance. When Supabase Realtime is
 * configured, `realtimeMode()` reports `supabase` and clients hold a socket to
 * Supabase instead; this route is then unused.
 *
 * Two platform constraints shape the implementation:
 *
 *  - Vercel functions are capped at 300s, so the stream closes itself a little
 *    early and tells the client (via `retry:`) to come straight back. A
 *    reconnect costs one snapshot, and the client reconciles from it.
 *  - Nothing reliably tells us the tab closed, so this route never writes.
 *    Presence is derived from `lastSeenAt` and expires on its own; a dropped
 *    stream therefore cannot corrupt the room.
 */

import { normalizeRoomCode, safeEqual } from '@/lib/ids';
import { subscribeLocal, type Delivery } from '@/lib/server/broadcast';
import { loadSnapshot } from '@/lib/server/session';
import { getRoomStore } from '@/lib/server/store';
import { fail } from '@/lib/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Comfortably inside the platform ceiling, with room for the final flush. */
const STREAM_BUDGET_MS = 270_000;
const HEARTBEAT_MS = 20_000;
/** Client reconnect delay after we hang up. Short: the room is live. */
const RETRY_MS = 1_500;

export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code: raw } = await context.params;
  const code = normalizeRoomCode(raw);
  if (!code) return fail('That room code does not look right.', 400);

  const url = new URL(request.url);
  const playerId = url.searchParams.get('playerId') ?? '';
  const token = url.searchParams.get('token') ?? '';
  if (!playerId || !token) return fail('Missing seat credentials.', 401);

  const record = await getRoomStore().getRoom(code);
  if (!record) return fail('That room is gone.', 404);
  const seat = record.players.find((p) => p.id === playerId);
  if (!seat || !safeEqual(seat.token, token)) return fail('Not your seat.', 401);

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      let open = true;

      const write = (chunk: string): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          open = false;
        }
      };

      const finish = (): void => {
        if (!open) return;
        open = false;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        if (deadline) clearTimeout(deadline);
        try {
          controller.close();
        } catch {
          /* already closed by the client */
        }
      };

      write(`retry: ${RETRY_MS}\n\n`);

      // Subscribe before sending the snapshot: anything decided while the
      // snapshot is in flight then arrives after it, and `seq` lets the client
      // discard what it already has.
      unsubscribe = subscribeLocal(code, {
        id: `${playerId}:${Date.now().toString(36)}`,
        playerId,
        send: (delivery: Delivery) => {
          write(`data: ${JSON.stringify(delivery.envelope)}\n\n`);
        },
      });

      const snapshot = await loadSnapshot(code);
      if (!snapshot.ok) {
        write(`data: ${JSON.stringify({ seq: 0, event: { t: 'reject', reason: snapshot.error } })}\n\n`);
        finish();
        return;
      }
      write(
        `data: ${JSON.stringify({
          seq: snapshot.value.seq,
          event: {
            t: 'snapshot',
            seq: snapshot.value.seq,
            view: snapshot.value.view,
            session: snapshot.value.session,
          },
        })}\n\n`,
      );

      heartbeat = setInterval(() => write(`: ping ${Date.now()}\n\n`), HEARTBEAT_MS);
      deadline = setTimeout(finish, STREAM_BUDGET_MS);
      request.signal.addEventListener('abort', finish);
    },
    cancel: () => {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
      if (deadline) clearTimeout(deadline);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx and some proxies buffer streamed responses without this.
      'X-Accel-Buffering': 'no',
    },
  });
}
