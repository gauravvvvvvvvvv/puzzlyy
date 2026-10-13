import { createHmac } from 'node:crypto';
import { normalizeRoomCode, safeEqual } from '@/lib/ids';
import { getRoomStore } from '@/lib/server/store';
import { clientKey, rateLimit } from '@/lib/server/ratelimit';
import { asString, fail, json, readJson } from '@/lib/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * STUN is public; TURN credentials are short-lived and minted only for
 * authenticated room seats. The TURN shared secret never reaches the browser.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code: raw } = await context.params;
  const code = normalizeRoomCode(raw);
  if (!code) return fail('Invalid room code.');
  const body = await readJson(request);
  if (!body) return fail('Expected JSON.');
  const playerId = asString(body.playerId, 40);
  const token = asString(body.token, 80);
  if (!playerId || !token) return fail('Missing seat credentials.', 401);
  const rate = rateLimit('events', clientKey(request));
  if (!rate.ok) return fail('Too many requests.', 429);
  const room = await getRoomStore().getRoom(code);
  if (!room || room.room.expiresAt < Date.now()) return fail('Room expired.', 404);
  const seat = room.players.find(p => p.id === playerId);
  if (!seat || !safeEqual(seat.token, token)) return fail('Invalid seat credentials.', 401);

  const iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  const url = process.env.TURN_URL;
  const secret = process.env.TURN_SHARED_SECRET;
  if (url && secret) {
    const username = String(Math.floor(Date.now() / 1000) + 3600) + ':' + playerId;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    iceServers.push({ urls: url.split(',').map(s => s.trim()), username, credential });
  }
  return json({ iceServers });
}
