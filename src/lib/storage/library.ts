/**
 * "My Puzzles" — the local library (spec §10).
 *
 * Everything a player has cut or played, kept on their own device. This is
 * deliberately *not* server state: there are no accounts, so a server-side
 * library would have nothing to key on, and a list of thumbnails is exactly the
 * kind of thing that should cost nothing and disappear with the browser profile.
 *
 * Entries hold URLs, never image bytes, so the whole library stays a few KB.
 */

import type { GameType, ImageAsset, LibraryEntry, Puzzle, PuzzleSettings } from '@/types/models';

import { readJson, writeJson } from './local';

const KEY = 'library';
/** Enough to feel like a collection, small enough to never approach quota. */
const MAX_ENTRIES = 60;

function isEntry(value: unknown): value is LibraryEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<LibraryEntry>;
  return typeof v.puzzleId === 'string' && typeof v.imageUrl === 'string';
}

export function loadLibrary(): LibraryEntry[] {
  const raw = readJson<unknown>(KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isEntry)
    .sort((a, b) => (b.lastPlayedAt ?? b.createdAt) - (a.lastPlayedAt ?? a.createdAt));
}

function persist(entries: LibraryEntry[]): LibraryEntry[] {
  const trimmed = entries
    .sort((a, b) => (b.lastPlayedAt ?? b.createdAt) - (a.lastPlayedAt ?? a.createdAt))
    .slice(0, MAX_ENTRIES);
  writeJson(KEY, trimmed);
  return trimmed;
}

export interface RememberInput {
  puzzle: Pick<Puzzle, 'id' | 'title' | 'pieceCount' | 'gameType' | 'settings' | 'image'>;
  roomCode?: string;
}

/**
 * Record a puzzle the moment it is created, before anyone has played it. A room
 * that is abandoned in the lobby still leaves the picture in "My Puzzles", which
 * is what makes the section useful rather than a trophy cabinet.
 */
export function rememberPuzzle({ puzzle, roomCode }: RememberInput): LibraryEntry[] {
  const entries = loadLibrary();
  const existing = entries.find((entry) => entry.puzzleId === puzzle.id);
  const now = Date.now();

  if (existing) {
    existing.title = puzzle.title;
    existing.lastRoomCode = roomCode ?? existing.lastRoomCode;
    // Older entries have no `image`; a replay is the right moment to fill it in.
    existing.image = puzzle.image ?? existing.image;
    return persist(entries);
  }

  const entry: LibraryEntry = {
    puzzleId: puzzle.id,
    title: puzzle.title,
    thumbUrl: puzzle.image.thumbUrl || puzzle.image.url,
    imageUrl: puzzle.image.url,
    pieceCount: puzzle.pieceCount,
    gameType: puzzle.gameType,
    settings: puzzle.settings,
    createdAt: now,
    lastPlayedAt: null,
    bestTimeMs: null,
    timesPlayed: 0,
    lastRoomCode: roomCode,
    image: puzzle.image,
  };
  return persist([entry, ...entries]);
}

/** Called on completion. Keeps the best time, never overwrites it with a worse one. */
export function recordCompletion(puzzleId: string, durationMs: number): LibraryEntry[] {
  const entries = loadLibrary();
  const entry = entries.find((e) => e.puzzleId === puzzleId);
  if (!entry) return entries;
  entry.timesPlayed += 1;
  entry.lastPlayedAt = Date.now();
  if (entry.bestTimeMs === null || durationMs < entry.bestTimeMs) entry.bestTimeMs = durationMs;
  return persist(entries);
}

export function markPlayed(puzzleId: string, roomCode?: string): LibraryEntry[] {
  const entries = loadLibrary();
  const entry = entries.find((e) => e.puzzleId === puzzleId);
  if (!entry) return entries;
  entry.lastPlayedAt = Date.now();
  if (roomCode) entry.lastRoomCode = roomCode;
  return persist(entries);
}

export function forgetPuzzle(puzzleId: string): LibraryEntry[] {
  return persist(loadLibrary().filter((entry) => entry.puzzleId !== puzzleId));
}

export function clearLibrary(): void {
  writeJson(KEY, []);
}

/**
 * The image behind a library entry, ready to re-cut into a new room.
 *
 * Entries written by this build carry the whole asset. For anything older we
 * recover the id and source from the URL shape, because the server re-derives
 * uploads and Originals from their id — an asset with the wrong `source` would
 * be rejected outright.
 */
export function entryToImage(entry: LibraryEntry): ImageAsset {
  if (entry.image) return entry.image;

  const derived = identifyImageUrl(entry.imageUrl);
  return {
    id: derived.id,
    source: derived.source,
    url: entry.imageUrl,
    thumbUrl: entry.thumbUrl || entry.imageUrl,
    // Unknown for legacy entries. Stock assets need real numbers, so the picker
    // measures the image before handing it to the server.
    width: 0,
    height: 0,
    title: entry.title,
    createdAt: entry.createdAt,
  };
}

function identifyImageUrl(url: string): { id: string; source: ImageAsset['source'] } {
  const upload = /\/api\/blob\/(img_[A-Za-z0-9_-]+)/.exec(url);
  if (upload?.[1]) return { id: upload[1], source: 'upload' };

  const original = /\/api\/originals\/([A-Za-z0-9_-]+)/.exec(url);
  if (original?.[1]) return { id: original[1], source: 'original' };

  return { id: url, source: 'stock' };
}

export interface LibraryStats {
  total: number;
  played: number;
  bestTimeMs: number | null;
  favouriteCount: number;
}

export function libraryStats(entries: LibraryEntry[]): LibraryStats {
  const played = entries.filter((e) => e.timesPlayed > 0);
  const times = played.map((e) => e.bestTimeMs).filter((t): t is number => typeof t === 'number');
  const counts = new Map<number, number>();
  for (const entry of played) counts.set(entry.pieceCount, (counts.get(entry.pieceCount) ?? 0) + 1);
  const favourite = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    total: entries.length,
    played: played.length,
    bestTimeMs: times.length ? Math.min(...times) : null,
    favouriteCount: favourite ? favourite[0] : 0,
  };
}

export type { GameType, PuzzleSettings };
