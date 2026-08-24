/**
 * `POST /api/challenges` — turn a finished puzzle into a dare.
 *
 * The client sends only a room code. Everything on the challenge — the time to
 * beat, the piece count, the settings — is read off the server's own finished
 * session, because a "time to beat" supplied by the client is just a number the
 * client made up (§30: do not trust client-provided puzzle completion).
 *
 * Refusing to issue a challenge for an unfinished room is the whole point: it is
 * what makes the time on the card mean something.
 */

import { normalizeRoomCode } from '@/lib/ids';
import { createId } from '@/lib/ids';
import { clientKey, rateLimit } from '@/lib/server/ratelimit';
import { loadResult } from '@/lib/server/session';
import { getRoomStore } from '@/lib/server/store';
import { asString, fail, json, readJson } from '@/lib/server/validate';
import type { Challenge } from '@/types/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Long enough that a link in a chat thread still works next month. */
const CHALLENGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function POST(request: Request): Promise<Response> {
  const limit = rateLimit('create', clientKey(request));
  if (!limit.ok) {
    return fail('One moment.', 429, { 'Retry-After': String(limit.retryAfter) });
  }

  const body = await readJson(request);
  if (!body) return fail('That request did not make sense.', 400);

  const code = normalizeRoomCode(asString(body.code, 16) ?? '');
  if (!code) return fail('That room code is not valid.', 400);

  const result = await loadResult(code);
  if (!result) return fail('That puzzle has not been finished yet.', 409);

  const record = await getRoomStore().getRoom(code);
  if (!record) return fail('That room is gone.', 404);

  // Attribute it to whoever asked, falling back to whoever did the most work.
  const playerId = asString(body.playerId, 80);
  const byPlayer =
    (playerId ? result.players.find((p) => p.id === playerId) : undefined) ??
    [...result.players].sort((a, b) => b.share - a.share)[0];

  const now = Date.now();
  const challenge: Challenge = {
    id: createId('ch'),
    puzzleId: result.puzzleId,
    gameType: result.gameType,
    byName: byPlayer?.name ?? 'A friend',
    byAvatar: byPlayer?.avatar ?? '🙂',
    timeMs: result.durationMs,
    pieceCount: result.pieceCount,
    settings: record.puzzle.settings,
    createdAt: now,
    expiresAt: now + CHALLENGE_TTL_MS,
  };

  // The puzzle has to outlive the room for the challenge to be playable, so make
  // sure it is stored under its own id before handing out the link.
  try {
    await getRoomStore().putPuzzle(record.puzzle);
    await getRoomStore().putChallenge(challenge);
  } catch (error) {
    console.error('[puzzly] could not save challenge', error);
    return fail('We could not create that challenge. Try again.', 502);
  }

  return json({ challenge, path: `/c/${challenge.id}` }, { status: 201 });
}
