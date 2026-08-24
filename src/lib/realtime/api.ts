/**
 * Typed wrappers around the HTTP API.
 *
 * Every network call the browser makes goes through here, for two reasons: the
 * response shapes stay in one place next to the routes that produce them, and
 * failures arrive as an `ApiError` carrying the server's own sentence. Those
 * sentences are written to be shown to a person ("That upload could not be
 * found. Try uploading the picture again."), so the UI can surface them directly
 * instead of inventing "Something went wrong".
 */

import type { ClientEvent } from '@/types/events';
import type {
  Challenge,
  GameType,
  ImageAsset,
  Player,
  Puzzle,
  PuzzleSessionState,
  PuzzleSettings,
  RoomView,
  StockCategory,
} from '@/types/models';

export type RealtimeMode = 'supabase' | 'sse';

export class ApiError extends Error {
  readonly status: number;
  /** Seconds to wait, when the server sent a `Retry-After`. */
  readonly retryAfter: number | null;

  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfter = retryAfter;
  }

  /** True when retrying the same request later could plausibly work. */
  get transient(): boolean {
    return this.status === 429 || this.status === 503 || this.status >= 500;
  }
}

const OFFLINE = 'You appear to be offline.';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    // fetch only rejects on a network-level failure, so this really is "no
    // connection", not "the server said no".
    throw new ApiError(OFFLINE, 0);
  }

  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after') ?? '') || null;
    let message = `Request failed (${response.status}).`;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
        message = (body as { error: string }).error;
      }
    } catch {
      /* not JSON; keep the generic message */
    }
    throw new ApiError(message, response.status, retryAfter);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
}

/* -------------------------------------------------------------------------- */
/* Rooms                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateRoomInput {
  image: ImageAsset;
  settings: PuzzleSettings;
  gameType?: GameType;
  title?: string;
  hostCanForceStart?: boolean;
}

export interface CreateRoomResponse {
  code: string;
  view: RoomView;
}

export function createRoom(input: CreateRoomInput): Promise<CreateRoomResponse> {
  return postJson<CreateRoomResponse>('/api/rooms', input);
}

export interface RoomSnapshot {
  view: RoomView;
  session: PuzzleSessionState | null;
  seq: number;
  realtime: RealtimeMode;
}

export function fetchRoom(code: string): Promise<RoomSnapshot> {
  return request<RoomSnapshot>(`/api/rooms/${encodeURIComponent(code)}`, { cache: 'no-store' });
}

export interface JoinInput {
  name: string;
  avatar: string;
  /** Previous credentials, to resume the same seat after a refresh. */
  playerId?: string;
  token?: string;
}

export interface JoinResponse extends RoomSnapshot {
  playerId: string;
  token: string;
  player: Player;
  /** True when the seat was reclaimed rather than newly created. */
  resumed: boolean;
}

export function joinRoom(code: string, input: JoinInput): Promise<JoinResponse> {
  return postJson<JoinResponse>(`/api/rooms/${encodeURIComponent(code)}/join`, input);
}

export interface EventsResponse {
  seq: number | null;
  applied: number;
}

export function postEvents(
  code: string,
  playerId: string,
  token: string,
  events: ClientEvent[],
): Promise<EventsResponse> {
  return postJson<EventsResponse>(`/api/rooms/${encodeURIComponent(code)}/events`, {
    playerId,
    token,
    events,
  });
}

/**
 * Best-effort final flush during `pagehide`, where an ordinary fetch is likely to
 * be cancelled. `sendBeacon` survives the page going away; if it is unavailable
 * or refuses (the queue is full), fall back to a keepalive fetch.
 */
export function beaconEvents(
  code: string,
  playerId: string,
  token: string,
  events: ClientEvent[],
): void {
  const url = `/api/rooms/${encodeURIComponent(code)}/events`;
  const body = JSON.stringify({ playerId, token, events });
  const sent =
    typeof navigator !== 'undefined' &&
    typeof navigator.sendBeacon === 'function' &&
    navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
  if (sent) return;
  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* Images                                                                     */
/* -------------------------------------------------------------------------- */

export interface ImageSearchResponse {
  items: ImageAsset[];
  page: number;
  hasMore: boolean;
  provider: string;
  /** True when a stock search was answered with Originals instead. */
  fallback: boolean;
  source: string;
  categories: StockCategory[];
  /** Which stock provider is configured, or null when none is. */
  stock: string | null;
}

export interface ImageSearchParams {
  source?: 'original' | 'stock' | 'upload';
  category?: string | null;
  q?: string | null;
  page?: number;
  perPage?: number;
}

export function searchImages(
  params: ImageSearchParams = {},
  signal?: AbortSignal,
): Promise<ImageSearchResponse> {
  const query = new URLSearchParams();
  if (params.source) query.set('source', params.source);
  if (params.category) query.set('category', params.category);
  if (params.q) query.set('q', params.q);
  if (params.page) query.set('page', String(params.page));
  if (params.perPage) query.set('perPage', String(params.perPage));
  return request<ImageSearchResponse>(`/api/images?${query.toString()}`, {
    signal,
    cache: 'no-store',
  });
}

export interface UploadResponse {
  asset: ImageAsset;
  /** False when the deployment has no durable blob store configured. */
  durable: boolean;
}

/**
 * The body is the raw encoded image, not multipart — the browser has already
 * decoded and downscaled it, so the dimensions are known and travel as query
 * parameters. See `app/api/upload/route.ts`.
 */
export function uploadImage(
  blob: Blob,
  meta: { width: number; height: number; title?: string; color?: string },
): Promise<UploadResponse> {
  const query = new URLSearchParams({
    w: String(Math.round(meta.width)),
    h: String(Math.round(meta.height)),
  });
  if (meta.title) query.set('title', meta.title);
  if (meta.color) query.set('color', meta.color);
  return request<UploadResponse>(`/api/upload?${query.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type },
    body: blob,
  });
}

/* -------------------------------------------------------------------------- */
/* Challenges                                                                 */
/* -------------------------------------------------------------------------- */

export interface CreateChallengeResponse {
  challenge: Challenge;
  path: string;
}

export function createChallenge(code: string, playerId?: string): Promise<CreateChallengeResponse> {
  return postJson<CreateChallengeResponse>('/api/challenges', { code, playerId });
}

export interface ChallengeResponse {
  challenge: Challenge;
  /** Null when the original puzzle has been swept; offer a fresh cut instead. */
  puzzle: Puzzle | null;
}

export function fetchChallenge(id: string): Promise<ChallengeResponse> {
  return request<ChallengeResponse>(`/api/challenges/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
}

/* -------------------------------------------------------------------------- */
/* Health                                                                     */
/* -------------------------------------------------------------------------- */

export interface HealthResponse {
  ok: boolean;
  ready: boolean;
  storage: { rooms: string; images: string };
  realtime: RealtimeMode;
  images: { originals: number; stock: string | null };
  warnings: string[];
}

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/api/health', { cache: 'no-store' });
}
