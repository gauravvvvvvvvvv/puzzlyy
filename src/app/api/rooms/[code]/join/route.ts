/**
 * `POST /api/rooms/[code]/join` — take a seat.
 *
 * Returns a `playerId` and a bearer `token`. Every later mutation carries that
 * pair and the server checks it with a constant-time compare, so the room code
 * alone is not enough to act as another player.
 *
 * Passing a previous `playerId` + `token` resumes the same seat. That is the
 * whole refresh-recovery story: the browser keeps the pair in local storage and
 * replays it, and a stale pair quietly becomes a fresh seat instead of an error.
 */

import { normalizeRoomCode } from '@/lib/ids';
import { realtimeMode } from '@/lib/server/broadcast';
import { clientKey, rateLimit } from '@/lib/server/ratelimit';
import { joinRoom } from '@/lib/server/session';
import { asString, fail, json, readJson } from '@/lib/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code: raw } = await context.params;
  const code = normalizeRoomCode(raw);
  if (!code) return fail('That room code does not look right.', 400);

  const limit = rateLimit('join', clientKey(request));
  if (!limit.ok) {
    return fail('Too many join attempts. Wait a moment.', 429, {
      'Retry-After': String(limit.retryAfter),
    });
  }

  const body = await readJson(request);
  if (!body) return fail('Expected a small JSON body.');

  const result = await joinRoom(code, {
    name: body.name,
    avatar: body.avatar,
    playerId: asString(body.playerId, 40) ?? undefined,
    token: asString(body.token, 80) ?? undefined,
  });
  if (!result.ok) return fail(result.error, result.status);

  const payload = result.value;
  return json({
    playerId: payload.playerId,
    token: payload.token,
    player: payload.player,
    view: payload.view,
    session: payload.session,
    seq: payload.seq,
    resumed: payload.resumed,
    realtime: realtimeMode(),
  });
}
