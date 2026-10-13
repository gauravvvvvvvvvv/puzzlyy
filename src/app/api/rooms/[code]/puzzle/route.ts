import { normalizeRoomCode } from '@/lib/ids';
import { trustImageAsset } from '@/lib/images';
import { createPuzzle } from '@/lib/puzzle/create';
import { clientKey, rateLimit } from '@/lib/server/ratelimit';
import { changeRoomPuzzle } from '@/lib/server/session';
import { asImageAsset, asSettings, asString, fail, json, readJson } from '@/lib/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Change the puzzle, not the room. Authenticated host only. */
export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code: raw } = await context.params;
  const code = normalizeRoomCode(raw);
  if (!code) return fail('Invalid room code.');
  const limit = rateLimit('events', clientKey(request));
  if (!limit.ok) return fail('Please try again shortly.', 429);
  const body = await readJson(request);
  if (!body) return fail('Expected a JSON body.');
  const playerId = asString(body.playerId, 40);
  const token = asString(body.token, 80);
  if (!playerId || !token) return fail('Missing seat credentials.', 401);
  const requested = asImageAsset(body.image);
  if (!requested) return fail('Choose a valid picture.');
  const image = await trustImageAsset(requested);
  if (!image) return fail('Could not verify that picture.');
  const settings = asSettings(body.settings);
  const puzzle = createPuzzle({ image, settings, gameType: 'jigsaw', title: asString(body.title, 80) ?? image.title });
  const changed = await changeRoomPuzzle(code, playerId, token, puzzle);
  if (!changed.ok) return fail(changed.error, changed.status);
  return json(changed.value);
}
