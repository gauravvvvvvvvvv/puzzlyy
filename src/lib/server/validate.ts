/**
 * Request validation and JSON helpers.
 *
 * Hand-written rather than pulled from a schema library, because the surface is
 * small and spec §31 asks for no unnecessary dependencies. Every route parses
 * untrusted input through these before it reaches the room or the engine.
 */

import type { ClientEvent } from '@/types/events';
import {
  DEFAULT_PUZZLE_SETTINGS,
  PIECE_COUNTS,
  type GameType,
  type ImageAsset,
  type PieceCount,
  type PuzzleSettings,
} from '@/types/models';

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(init?.headers ?? {}),
    },
  });
}

export function fail(message: string, status = 400, extra?: Record<string, string>): Response {
  return json({ error: message }, { status, headers: extra });
}

/** Parse a JSON body with a hard size cap, never throwing. */
export async function readJson(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) return null;
  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Scalars                                                                    */
/* -------------------------------------------------------------------------- */

export function asString(value: unknown, maxLength = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

export function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

export function asInt(value: unknown, min: number, max: number): number | null {
  const n = asFiniteNumber(value);
  if (n === null) return null;
  const i = Math.round(n);
  if (i < min || i > max) return null;
  return i;
}

export function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/* -------------------------------------------------------------------------- */
/* Domain                                                                     */
/* -------------------------------------------------------------------------- */

const GAME_TYPES: readonly GameType[] = [
  'jigsaw',
  'scramble',
  'find-difference',
  'memory',
  'hidden-object',
  'escape',
];

export function asGameType(value: unknown): GameType | null {
  return typeof value === 'string' && (GAME_TYPES as readonly string[]).includes(value)
    ? (value as GameType)
    : null;
}

export function asPieceCount(value: unknown): PieceCount {
  const n = asFiniteNumber(value);
  if (n === null) return DEFAULT_PUZZLE_SETTINGS.pieceCount;
  // Snap to the nearest supported count rather than rejecting the request.
  let best: PieceCount = PIECE_COUNTS[0];
  let bestDelta = Infinity;
  for (const count of PIECE_COUNTS) {
    const delta = Math.abs(count - n);
    if (delta < bestDelta) {
      best = count;
      bestDelta = delta;
    }
  }
  return best;
}

export function asSettings(value: unknown): PuzzleSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_PUZZLE_SETTINGS };
  const raw = value as Record<string, unknown>;
  return {
    pieceCount: asPieceCount(raw.pieceCount),
    rotation: asBool(raw.rotation, DEFAULT_PUZZLE_SETTINGS.rotation),
    blindMode: asBool(raw.blindMode, DEFAULT_PUZZLE_SETTINGS.blindMode),
  };
}

/**
 * Validate an image reference supplied by the client.
 *
 * The URL must be same-origin (`/api/blob/...`, `/api/proxy?...`) or an https
 * URL on an allowlisted provider host — otherwise a room could be pointed at an
 * arbitrary endpoint and every player's browser made to fetch it.
 */
export const ALLOWED_IMAGE_HOSTS = new Set([
  'images.unsplash.com',
  'images.pexels.com',
]);

export function isSafeImageUrl(url: string): boolean {
  if (url.startsWith('/api/blob/') || url.startsWith('/api/proxy?')) return true;
  if (url.startsWith('/api/originals/')) return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_IMAGE_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export function asImageAsset(value: unknown): ImageAsset | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = asString(raw.id, 80);
  const url = asString(raw.url, 2000);
  if (!id || !url) return null;
  if (!isSafeImageUrl(url)) return null;
  const thumbUrl = asString(raw.thumbUrl, 2000);
  const width = asInt(raw.width, 1, 20000) ?? 1600;
  const height = asInt(raw.height, 1, 20000) ?? 1200;
  const source =
    raw.source === 'upload' || raw.source === 'stock' || raw.source === 'original'
      ? raw.source
      : 'stock';

  let credit: ImageAsset['credit'];
  if (raw.credit && typeof raw.credit === 'object') {
    const c = raw.credit as Record<string, unknown>;
    const authorName = asString(c.authorName, 120);
    const providerName = asString(c.providerName, 60);
    if (authorName && providerName) {
      credit = {
        authorName,
        providerName,
        authorUrl: asString(c.authorUrl, 500) ?? undefined,
        providerUrl: asString(c.providerUrl, 500) ?? undefined,
      };
    }
  }

  return {
    id,
    source,
    url,
    thumbUrl: thumbUrl && isSafeImageUrl(thumbUrl) ? thumbUrl : url,
    width,
    height,
    title: asString(raw.title, 120) ?? 'Untitled',
    credit,
    color: /^#[0-9a-fA-F]{6}$/.test(String(raw.color ?? '')) ? String(raw.color) : undefined,
    createdAt: Date.now(),
  };
}

/* -------------------------------------------------------------------------- */
/* Realtime envelope                                                          */
/* -------------------------------------------------------------------------- */

const MAX_EVENTS_PER_BATCH = 120;

/**
 * Narrow an untrusted array into `ClientEvent`s, dropping anything malformed.
 * The hub validates authority and geometry; this only guarantees shape.
 */
export function parseClientEvents(value: unknown): ClientEvent[] {
  if (!Array.isArray(value)) return [];
  const out: ClientEvent[] = [];
  for (const item of value.slice(0, MAX_EVENTS_PER_BATCH)) {
    const event = parseClientEvent(item);
    if (event) out.push(event);
  }
  return out;
}

function parseClientEvent(value: unknown): ClientEvent | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const groupId = () => asInt(raw.g, 0, 100_000);

  switch (raw.t) {
    case 'cursor': {
      const x = asFiniteNumber(raw.x);
      const y = asFiniteNumber(raw.y);
      if (x === null || y === null) return null;
      return { t: 'cursor', x, y, down: asBool(raw.down) };
    }
    case 'ready':
      return { t: 'ready', ready: asBool(raw.ready) };
    case 'start':
      return { t: 'start' };
    case 'grab': {
      const g = groupId();
      return g === null ? null : { t: 'grab', g };
    }
    case 'move':
    case 'drop': {
      const g = groupId();
      const ox = asFiniteNumber(raw.ox);
      const oy = asFiniteNumber(raw.oy);
      if (g === null || ox === null || oy === null) return null;
      return { t: raw.t, g, ox, oy };
    }
    case 'rotate': {
      const g = groupId();
      if (g === null) return null;
      const dir = raw.dir === -1 ? -1 : raw.dir === 1 ? 1 : null;
      if (dir === null) return null;
      return { t: 'rotate', g, dir };
    }
    case 'react': {
      const emoji = asString(raw.emoji, 12);
      const x = asFiniteNumber(raw.x);
      const y = asFiniteNumber(raw.y);
      if (!emoji || x === null || y === null) return null;
      return { t: 'react', emoji, x, y };
    }
    case 'ping': {
      const x = asFiniteNumber(raw.x);
      const y = asFiniteNumber(raw.y);
      if (x === null || y === null) return null;
      const text = asString(raw.text, 200);
      return { t: 'ping', x, y, text: text ?? undefined };
    }
    case 'hint': {
      const level = asInt(raw.level, 1, 4);
      if (level === null) return null;
      return { t: 'hint', level: level as 1 | 2 | 3 | 4 };
    }
    case 'undo':
      return { t: 'undo' };
    case 'redo':
      return { t: 'redo' };
    case 'alive': {
      // Group ids this client believes it is still dragging, so their locks get
      // refreshed instead of expiring under a slow, careful move.
      const holding = Array.isArray(raw.holding)
        ? raw.holding
            .slice(0, 32)
            .map((v) => asInt(v, 0, 100_000))
            .filter((v): v is number => v !== null)
        : undefined;
      return { t: 'alive', holding };
    }
    case 'resync':
      return { t: 'resync' };
    case 'restart':
      return { t: 'restart' };
    case 'bye':
      return { t: 'bye' };
    default:
      return null;
  }
}
