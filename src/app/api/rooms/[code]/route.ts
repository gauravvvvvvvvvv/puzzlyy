/**
 * `GET /api/rooms/[code]` — public room snapshot.
 *
 * Used by the lobby before anyone has a seat (so an invite link can render the
 * puzzle preview and the roster immediately) and by clients recovering after a
 * refresh. Returns only public data: seat tokens live in `SeatState` and never
 * appear in a `RoomView`.
 */

import { normalizeRoomCode } from '@/lib/ids';
import { realtimeMode } from '@/lib/server/broadcast';
import { loadSnapshot } from '@/lib/server/session';
import { fail, json } from '@/lib/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code: raw } = await context.params;
  const code = normalizeRoomCode(raw);
  if (!code) return fail('That room code does not look right.', 400);

  const result = await loadSnapshot(code);
  if (!result.ok) return fail(result.error, result.status);

  return json({
    view: result.value.view,
    session: result.value.session,
    seq: result.value.seq,
    realtime: realtimeMode(),
  });
}
