/**
 * `GET /api/challenges/[id]` — what a challenge link resolves to.
 *
 * Returns the challenge and, when it is still available, the puzzle it was set
 * on, so the accepting player gets the *same* picture and cut rather than a
 * lookalike. `puzzle: null` means the puzzle has been swept; the UI can still
 * show the time to beat and offer a fresh puzzle instead of a dead end.
 */

import { getRoomStore } from '@/lib/server/store';
import { fail, json } from '@/lib/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID = /^ch_[A-Za-z0-9]{6,32}$/;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!ID.test(id)) return fail('That is not a valid challenge link.', 400);

  const store = getRoomStore();
  const challenge = await store.getChallenge(id);
  if (!challenge) return fail('That challenge has expired.', 404);
  if (challenge.expiresAt < Date.now()) return fail('That challenge has expired.', 410);

  const puzzle = await store.getPuzzle(challenge.puzzleId);
  return json({ challenge, puzzle });
}
