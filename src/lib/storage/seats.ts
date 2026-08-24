/**
 * Seat recovery.
 *
 * A refresh must not cost a player their place in the room. The server issues a
 * `playerId` and a bearer `token` at join time; both are kept here so a reload
 * rejoins the *same* seat — keeping the colour, the ready flag, the connection
 * credit and any groups still held — instead of appearing as a second person
 * who wandered in (spec §22).
 *
 * The token is a room credential, so it is stored per room and pruned once the
 * room could not possibly still exist.
 */

import { readJson, remove, writeJson } from './local';

/** Rooms live for a day; a seat that old cannot be rejoined. */
const SEAT_TTL_MS = 26 * 60 * 60 * 1000;
/** How long "resume your last room" stays on offer. */
const LAST_ROOM_TTL_MS = 12 * 60 * 60 * 1000;

export interface StoredSeat {
  playerId: string;
  token: string;
  savedAt: number;
}

export interface LastRoom {
  code: string;
  title: string;
  savedAt: number;
}

function seatKey(code: string): string {
  return `seat:${code}`;
}

export function loadSeat(code: string): StoredSeat | null {
  const seat = readJson<StoredSeat | null>(seatKey(code), null);
  if (!seat?.playerId || !seat.token) return null;
  if (Date.now() - (seat.savedAt ?? 0) > SEAT_TTL_MS) {
    remove(seatKey(code));
    return null;
  }
  return seat;
}

export function saveSeat(code: string, playerId: string, token: string): void {
  writeJson(seatKey(code), { playerId, token, savedAt: Date.now() } satisfies StoredSeat);
}

export function clearSeat(code: string): void {
  remove(seatKey(code));
}

export function saveLastRoom(code: string, title: string): void {
  writeJson('lastRoom', { code, title, savedAt: Date.now() } satisfies LastRoom);
}

export function loadLastRoom(): LastRoom | null {
  const last = readJson<LastRoom | null>('lastRoom', null);
  if (!last?.code) return null;
  if (Date.now() - (last.savedAt ?? 0) > LAST_ROOM_TTL_MS) {
    remove('lastRoom');
    return null;
  }
  return last;
}

export function clearLastRoom(): void {
  remove('lastRoom');
}
