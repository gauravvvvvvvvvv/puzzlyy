/**
 * `POST /api/rooms` — create a room.
 *
 * The room is created empty and `hostId` is left blank: the first player to join
 * becomes host. That makes creation a single write and means an invite link still
 * works if the person who made it never opens it themselves.
 *
 * The client's image is never trusted as-is. `trustImageAsset` re-derives
 * Originals and uploads from authoritative data and holds stock URLs to the host
 * allowlist, so a caller cannot point a puzzle at an arbitrary URL or lie about
 * its dimensions.
 */

import { isPlayable } from '@/lib/games';
import { trustImageAsset } from '@/lib/images';
import { createPuzzle } from '@/lib/puzzle/create';
import { maybeSweep } from '@/lib/server/maintenance';
import { clientKey, rateLimit } from '@/lib/server/ratelimit';
import { createRoomSession, publicRoster } from '@/lib/server/session';
import { getRoomStore } from '@/lib/server/store';
import {
  asBool,
  asGameType,
  asImageAsset,
  asSettings,
  asString,
  fail,
  json,
  readJson,
} from '@/lib/server/validate';
import type { RoomSettings, RoomView } from '@/types/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const limit = rateLimit('create', clientKey(request));
  if (!limit.ok) {
    return fail('That is a lot of rooms. Give it a second.', 429, {
      'Retry-After': String(limit.retryAfter),
    });
  }

  const body = await readJson(request);
  if (!body) return fail('Expected a small JSON body.');

  const requested = asImageAsset(body.image);
  if (!requested) return fail('That image cannot be used for a puzzle.');

  const image = await trustImageAsset(requested);
  if (!image) {
    return fail(
      requested.source === 'upload'
        ? 'That upload could not be found. Try uploading the picture again.'
        : 'That image could not be verified.',
      400,
    );
  }

  const gameType = asGameType(body.gameType) ?? 'jigsaw';
  if (!isPlayable(gameType)) return fail('That game is not ready to play yet.', 400);

  const settings = asSettings(body.settings);
  const puzzle = createPuzzle({
    image,
    settings,
    gameType,
    title: asString(body.title, 80) ?? undefined,
  });

  const roomSettings: RoomSettings = {
    ...settings,
    visibility: 'private',
    hostCanForceStart: asBool(body.hostCanForceStart, true),
  };

  const record = await createRoomSession({ puzzle, settings: roomSettings });
  if (!record) return fail('Could not create a room just now. Please try again.', 503);

  // Best effort: keeps the puzzle resolvable on its own for challenge links and
  // rematches. A failure here does not affect the room, which owns its copy.
  await getRoomStore()
    .putPuzzle(puzzle)
    .catch((error: unknown) => {
      console.warn('[puzzly] putPuzzle failed', (error as Error).message);
    });

  const view: RoomView = {
    room: record.room,
    puzzle: record.puzzle,
    players: publicRoster(record, Date.now()),
    session: null,
  };

  // Making a room is the natural moment to notice that yesterday's rooms are
  // still lying around. Fire-and-forget: it never delays this response.
  maybeSweep();

  return json({ code: record.room.code, view }, { status: 201 });
}
