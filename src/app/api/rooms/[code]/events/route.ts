/**
 * `POST /api/rooms/[code]/events` — the single write path.
 *
 * Everything a player does arrives here as a small batch of `ClientEvent`s. The
 * route itself decides nothing: it checks shape, then hands the batch to
 * `applyClientEvents`, which reloads the room at a known version, rehydrates the
 * authoritative engine, validates each event against it, and compare-and-swaps
 * the result. Broadcasting happens there too, so no state lives in this process.
 *
 * Rate limiting is deliberately two-layered: a coarse per-IP bucket here to keep
 * junk off the database at all, and an exact per-seat token bucket stored inside
 * the room record so the real limit is consistent across instances.
 */

import { normalizeRoomCode } from '@/lib/ids';
import { clientKey, rateLimit } from '@/lib/server/ratelimit';
import { applyClientEvents } from '@/lib/server/session';
import { asString, fail, json, parseClientEvents, readJson } from '@/lib/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code: raw } = await context.params;
  const code = normalizeRoomCode(raw);
  if (!code) return fail('That room code does not look right.', 400);

  const body = await readJson(request);
  if (!body) return fail('Expected a small JSON body.');

  const playerId = asString(body.playerId, 40);
  const token = asString(body.token, 80);
  if (!playerId || !token) return fail('Missing seat credentials.', 401);

  const events = parseClientEvents(body.events);
  if (!events.length) return json({ seq: null, applied: 0 });

  // Coarse guard before touching the database. The authoritative per-seat
  // budget lives in the room record and is charged by `applyClientEvents`.
  const limit = rateLimit('events', `${clientKey(request)}:${playerId}`, events.length);
  if (!limit.ok) {
    return fail('Slow down.', 429, { 'Retry-After': String(limit.retryAfter) });
  }

  const result = await applyClientEvents(code, playerId, token, events);
  if (!result.ok) return fail(result.error, result.status);

  return json({ seq: result.value.seq, applied: events.length });
}
