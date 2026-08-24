/**
 * Persistence seam.
 *
 * The app talks to `RoomStore` and never to a database directly, so the
 * deployment target is a configuration choice:
 *
 *   - no env vars  -> in-memory. Zero setup, a single server instance. Correct
 *                     for `npm run dev` and any single-process host.
 *   - SUPABASE_*   -> Postgres via the REST API. Durable, survives restarts,
 *                     and — critically — shared across serverless instances.
 *
 * ## Why there is a compare-and-swap here
 *
 * Puzzly runs on Vercel, where every request may land on a different instance
 * with its own memory. So no instance is allowed to *hold* the puzzle: the
 * authoritative state lives in `rooms.data`, and a mutation is
 *
 *     load (record, version) -> rehydrate engine -> validate -> casRoom(version)
 *
 * `casRoom` writes only if the stored version still matches the one we read.
 * If two players drop a piece at the same moment, one write wins and the loser
 * reloads and re-applies against the winner's state. That is what makes
 * multiplayer correct with zero server memory, and it is the reason
 * `putRoom` (a blind upsert) must never be used on the live-session path.
 *
 * Adding Cloudflare R2, Vercel Blob, Redis or a Durable Object means writing
 * one more adapter here and touching nothing else.
 */

import type {
  Challenge,
  ImageAsset,
  Player,
  Puzzle,
  PuzzleSessionState,
  Room,
} from '@/types/models';

/* -------------------------------------------------------------------------- */
/* Records                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A player's seat, as persisted.
 *
 * Two fields deliberately do *not* appear here:
 *
 *   - `connected` — liveness is ephemeral. It comes from the realtime channel's
 *     presence set, not from Postgres, so nobody writes a row when a socket
 *     opens or closes. `toPublicPlayer` derives a best-guess value from
 *     `lastSeenAt` for the initial snapshot; live presence overrides it.
 *   - anything large. Seats are tiny by design (spec §29).
 */
export interface SeatState {
  id: string;
  name: string;
  avatar: string;
  colorId: Player['colorId'];
  isHost: boolean;
  ready: boolean;
  joinedAt: number;
  lastSeenAt: number;
  /** Piece connections this player has made, for the results split. */
  connections: number;
  /** Secret bearer token. Never broadcast, never sent to another player. */
  token: string;
  /** Token-bucket state, so rate limiting is exact rather than per-instance. */
  budget: number;
  budgetAt: number;
  /** Current hint sequence, so escalating levels keep naming the same piece. */
  hintPieceId: number | null;
  hintRegion: string | null;
  hintLevel: number;
}

export interface RoomRecord {
  room: Room;
  puzzle: Puzzle;
  /** Authoritative puzzle state. Null while the room is still in the lobby. */
  session: PuzzleSessionState | null;
  /** The roster. Present on every record written by the current code. */
  players: SeatState[];
  /** Monotonic broadcast counter, so clients can detect a dropped event. */
  seq: number;
  /**
   * groupId -> when the lock was taken.
   *
   * Nothing tells the server that a player closed their laptop mid-drag, so a
   * lock cannot wait for a disconnect event to be released — it expires. Kept
   * alongside the engine's own lock map rather than inside it so the puzzle
   * engine stays free of wall-clock concerns and usable for solo play.
   */
  locksAt: Record<number, number>;
}

/** A record plus the row version it was read at, for compare-and-swap. */
export interface VersionedRoom {
  record: RoomRecord;
  version: number;
}

export interface RoomStore {
  readonly kind: string;
  /** Plain read. Use `getRoomVersioned` on any path that also writes. */
  getRoom(code: string): Promise<RoomRecord | null>;
  /** Read together with the row version required by `casRoom`. */
  getRoomVersioned(code: string): Promise<VersionedRoom | null>;
  /**
   * Insert a brand-new room. Returns false if the code is already taken, so
   * the caller can generate another one instead of clobbering a live game.
   */
  createRoom(record: RoomRecord): Promise<boolean>;
  /**
   * Write iff the stored version is still `expectedVersion`. False means
   * another instance committed first; reload and re-apply.
   */
  casRoom(record: RoomRecord, expectedVersion: number): Promise<boolean>;
  /**
   * Unconditional write. Only for non-contended paths (creation, admin).
   *
   * Throws if the write is refused. Never use this on the live-session path —
   * it would clobber a concurrent instance's commit; that is what `casRoom` is
   * for.
   */
  putRoom(record: RoomRecord): Promise<void>;
  deleteRoom(code: string): Promise<void>;
  getPuzzle(id: string): Promise<Puzzle | null>;
  putPuzzle(puzzle: Puzzle): Promise<void>;
  getImage(id: string): Promise<ImageAsset | null>;
  /**
   * Store an upload, or push its expiry back out.
   *
   * The expiry slides on every write, which is what makes an upload's lifetime
   * "three days since anyone used it" rather than "three days since it was
   * uploaded" — see `touchImage`.
   */
  putImage(image: ImageAsset, expiresAt: number): Promise<void>;
  /** Uploads whose expiry has passed, oldest first. At most `limit` of them. */
  staleImages(now: number, limit: number): Promise<string[]>;
  /**
   * True when some room's puzzle was cut from this image.
   *
   * The sweep asks before deleting, because a room can outlive its picture's
   * expiry — the two are refreshed by different things — and a puzzle whose
   * image has been deleted is unplayable. Errs towards `true`: a storage hiccup
   * must not turn into a deletion.
   */
  imageInUse(id: string): Promise<boolean>;
  deleteImage(id: string): Promise<void>;
  getChallenge(id: string): Promise<Challenge | null>;
  putChallenge(challenge: Challenge): Promise<void>;
  /** Best-effort cleanup of expired rooms/challenges. */
  sweep(now: number): Promise<void>;
}

/**
 * How long an uploaded picture survives without being used.
 *
 * Matched to `ROOM_TTL_MS` deliberately: the two things a person creates — a
 * room and the picture in it — go away on the same schedule, so there is one
 * rule to explain rather than two.
 */
export const IMAGE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Memory adapter                                                             */
/* -------------------------------------------------------------------------- */

interface MemoryRow {
  record: RoomRecord;
  version: number;
}

class MemoryRoomStore implements RoomStore {
  readonly kind = 'memory';
  private rooms = new Map<string, MemoryRow>();
  private puzzles = new Map<string, Puzzle>();
  private images = new Map<string, { asset: ImageAsset; expiresAt: number }>();
  private challenges = new Map<string, Challenge>();

  async getRoom(code: string): Promise<RoomRecord | null> {
    return this.rooms.get(code)?.record ?? null;
  }

  async getRoomVersioned(code: string): Promise<VersionedRoom | null> {
    const row = this.rooms.get(code);
    if (!row) return null;
    // Hand out a copy: callers mutate freely and only `casRoom` commits.
    return { record: structuredClone(row.record), version: row.version };
  }

  async createRoom(record: RoomRecord): Promise<boolean> {
    if (this.rooms.has(record.room.code)) return false;
    this.rooms.set(record.room.code, { record: structuredClone(record), version: 1 });
    this.puzzles.set(record.puzzle.id, record.puzzle);
    return true;
  }

  async casRoom(record: RoomRecord, expectedVersion: number): Promise<boolean> {
    const row = this.rooms.get(record.room.code);
    if (!row || row.version !== expectedVersion) return false;
    row.record = structuredClone(record);
    row.version = expectedVersion + 1;
    return true;
  }

  async putRoom(record: RoomRecord): Promise<void> {
    const row = this.rooms.get(record.room.code);
    this.rooms.set(record.room.code, {
      record: structuredClone(record),
      version: (row?.version ?? 0) + 1,
    });
    this.puzzles.set(record.puzzle.id, record.puzzle);
  }

  async deleteRoom(code: string): Promise<void> {
    this.rooms.delete(code);
  }
  async getPuzzle(id: string): Promise<Puzzle | null> {
    return this.puzzles.get(id) ?? null;
  }
  async putPuzzle(puzzle: Puzzle): Promise<void> {
    this.puzzles.set(puzzle.id, puzzle);
  }
  async getImage(id: string): Promise<ImageAsset | null> {
    return this.images.get(id)?.asset ?? null;
  }
  async putImage(image: ImageAsset, expiresAt: number): Promise<void> {
    this.images.set(image.id, { asset: image, expiresAt });
  }
  async staleImages(now: number, limit: number): Promise<string[]> {
    const stale: string[] = [];
    for (const [id, row] of this.images) {
      if (row.expiresAt >= now) continue;
      stale.push(id);
      if (stale.length >= limit) break;
    }
    return stale;
  }
  async imageInUse(id: string): Promise<boolean> {
    for (const row of this.rooms.values()) {
      if (row.record.puzzle.imageId === id) return true;
    }
    return false;
  }
  async deleteImage(id: string): Promise<void> {
    this.images.delete(id);
  }
  async getChallenge(id: string): Promise<Challenge | null> {
    return this.challenges.get(id) ?? null;
  }
  async putChallenge(challenge: Challenge): Promise<void> {
    this.challenges.set(challenge.id, challenge);
  }

  async sweep(now: number): Promise<void> {
    for (const [code, row] of this.rooms) {
      if (row.record.room.expiresAt < now) this.rooms.delete(code);
    }
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt < now) this.challenges.delete(id);
    }
    // Keep memory bounded on long-lived instances. Expired *images* are not
    // dropped here: their bytes live in blob storage, and only the maintenance
    // sweep knows how to delete both halves in the right order.
    if (this.puzzles.size > 2000) {
      this.puzzles = new Map([...this.puzzles.entries()].slice(-1000));
    }
    if (this.images.size > 4000) {
      this.images = new Map([...this.images.entries()].slice(-2000));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Supabase adapter (REST — no client library needed on the server)           */
/* -------------------------------------------------------------------------- */

interface SupabaseConfig {
  url: string;
  serviceKey: string;
}

interface RoomRow {
  data: RoomRecord;
  version: number;
}

/**
 * Set once if this database predates `images.expires_at`. Module-level rather
 * than per-instance so a warm lambda only ever discovers it once.
 */
let imageExpiryMissing = false;

class SupabaseRoomStore implements RoomStore {
  readonly kind = 'supabase';
  private base: string;
  private headers: Record<string, string>;

  constructor(config: SupabaseConfig) {
    this.base = `${config.url.replace(/\/$/, '')}/rest/v1`;
    this.headers = {
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    path: string,
    init: RequestInit & { prefer?: string } = {},
  ): Promise<{ status: number; body: T | null }> {
    try {
      const headers: Record<string, string> = { ...this.headers };
      if (init.prefer) headers.Prefer = init.prefer;
      const res = await fetch(`${this.base}${path}`, { ...init, headers, cache: 'no-store' });
      const text = await res.text();
      if (!res.ok) {
        // 409 is an expected outcome (duplicate room code), not a fault.
        if (res.status !== 409) {
          console.warn(
            `[puzzly] supabase ${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`,
          );
        }
        return { status: res.status, body: null };
      }
      return { status: res.status, body: text ? (JSON.parse(text) as T) : null };
    } catch (error) {
      console.warn('[puzzly] supabase request failed', error);
      return { status: 0, body: null };
    }
  }

  /**
   * Insert-or-update one row, and *throw* if the database refused it.
   *
   * Throwing rather than returning a status is deliberate. Every caller of this
   * already sits inside a `try`/`catch` that turns a failure into an honest 502,
   * or an explicit `.catch()` that documents the write as best-effort. Silently
   * discarding the status made those handlers unreachable: a row rejected by a
   * NOT NULL constraint looked exactly like a row that was written, so the API
   * answered `201` and handed out a link to something that did not exist.
   */
  private async upsert(table: string, row: unknown): Promise<void> {
    const { status } = await this.request(`/${table}`, {
      method: 'POST',
      body: JSON.stringify(row),
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    if (status < 200 || status >= 300) {
      throw new Error(`supabase upsert ${table} failed with status ${status}`);
    }
  }

  /** Column projection for a room. `data` carries the whole record. */
  private rowFor(record: RoomRecord): Record<string, unknown> {
    return {
      code: record.room.code,
      status: record.room.status,
      expires_at: new Date(record.room.expiresAt).toISOString(),
      updated_at: new Date(record.room.updatedAt).toISOString(),
      data: record,
    };
  }

  async getRoom(code: string): Promise<RoomRecord | null> {
    const versioned = await this.getRoomVersioned(code);
    return versioned?.record ?? null;
  }

  async getRoomVersioned(code: string): Promise<VersionedRoom | null> {
    const { body } = await this.request<RoomRow[]>(
      `/rooms?code=eq.${encodeURIComponent(code)}&select=data,version&limit=1`,
    );
    if (!body?.length) return null;
    const row = body[0];
    if (!row.data?.room) return null;
    return { record: migrate(row.data), version: Number(row.version) };
  }

  async createRoom(record: RoomRecord): Promise<boolean> {
    const { status } = await this.request(`/rooms`, {
      method: 'POST',
      body: JSON.stringify({ ...this.rowFor(record), version: 1 }),
      prefer: 'return=minimal',
    });
    // 409 = the primary key is taken, i.e. this code collided.
    if (status === 409) return false;
    if (status >= 200 && status < 300) {
      // Best-effort, and it must stay that way: the room row is already
      // committed by this point, so letting a puzzle-write hiccup throw would
      // report failure for a room that exists and is about to be played in. The
      // record carries its own copy of the puzzle; this side table only exists so
      // challenge links and rematches can resolve it after the room is gone.
      try {
        await this.putPuzzle(record.puzzle);
      } catch (error) {
        console.warn('[puzzly] room created but putPuzzle failed', error);
      }
      return true;
    }
    return false;
  }

  /**
   * `PATCH ?code=eq.X&version=eq.N` is the whole concurrency story: Postgres
   * matches zero rows if somebody else already bumped the version, and
   * `return=representation` lets us tell "no match" from "matched and written".
   */
  async casRoom(record: RoomRecord, expectedVersion: number): Promise<boolean> {
    const { body } = await this.request<Array<{ code: string }>>(
      `/rooms?code=eq.${encodeURIComponent(record.room.code)}&version=eq.${expectedVersion}&select=code`,
      {
        method: 'PATCH',
        body: JSON.stringify({ ...this.rowFor(record), version: expectedVersion + 1 }),
        prefer: 'return=representation',
      },
    );
    return Boolean(body?.length);
  }

  async putRoom(record: RoomRecord): Promise<void> {
    await this.upsert('rooms', this.rowFor(record));
  }

  async deleteRoom(code: string): Promise<void> {
    await this.request(`/rooms?code=eq.${encodeURIComponent(code)}`, { method: 'DELETE' });
  }

  async getPuzzle(id: string): Promise<Puzzle | null> {
    const { body } = await this.request<Array<{ data: Puzzle }>>(
      `/puzzles?id=eq.${encodeURIComponent(id)}&select=data&limit=1`,
    );
    return body?.length ? body[0].data : null;
  }

  async putPuzzle(puzzle: Puzzle): Promise<void> {
    await this.upsert('puzzles', { id: puzzle.id, data: puzzle });
  }

  async getImage(id: string): Promise<ImageAsset | null> {
    const { body } = await this.request<Array<{ data: ImageAsset }>>(
      `/images?id=eq.${encodeURIComponent(id)}&select=data&limit=1`,
    );
    return body?.length ? body[0].data : null;
  }

  /**
   * Write the image row, sliding its expiry out.
   *
   * `images.expires_at` was added after the first deployments, and a database
   * that has not had `sql/schema.sql` re-run does not have the column — so a
   * rejected write is retried without it rather than failing the upload. Losing
   * expiry on an old database is a housekeeping problem; refusing the upload
   * would be the person's problem.
   */
  async putImage(image: ImageAsset, expiresAt: number): Promise<void> {
    if (!imageExpiryMissing) {
      const { status } = await this.request(`/images`, {
        method: 'POST',
        body: JSON.stringify({
          id: image.id,
          data: image,
          expires_at: new Date(expiresAt).toISOString(),
        }),
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
      if (status >= 200 && status < 300) return;
      // 400 = "column images.expires_at does not exist". Say so once, then stop
      // trying, so an un-migrated database costs one wasted request per instance.
      // Anything else — 500, a network fault — is a real failure, and the upload
      // route is waiting to turn it into an honest "try again" rather than
      // returning a picture whose metadata was never recorded.
      if (status !== 400) {
        throw new Error(`supabase upsert images failed with status ${status}`);
      }
      imageExpiryMissing = true;
      console.warn(
        '[puzzly] images.expires_at is missing — uploads will not expire. ' +
          'Re-run sql/schema.sql to enable cleanup.',
      );
    }
    await this.upsert('images', { id: image.id, data: image });
  }

  async staleImages(now: number, limit: number): Promise<string[]> {
    if (imageExpiryMissing) return [];
    const { body } = await this.request<Array<{ id: string }>>(
      `/images?expires_at=lt.${new Date(now).toISOString()}&select=id&order=expires_at.asc&limit=${limit}`,
    );
    return body?.map((row) => row.id) ?? [];
  }

  async imageInUse(id: string): Promise<boolean> {
    const { status, body } = await this.request<Array<{ code: string }>>(
      `/rooms?data->puzzle->>imageId=eq.${encodeURIComponent(id)}&select=code&limit=1`,
    );
    // A failed lookup must not read as "nobody wants this".
    if (status < 200 || status >= 300) return true;
    return Boolean(body?.length);
  }

  async deleteImage(id: string): Promise<void> {
    await this.request(`/images?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async getChallenge(id: string): Promise<Challenge | null> {
    const { body } = await this.request<Array<{ data: Challenge }>>(
      `/challenges?id=eq.${encodeURIComponent(id)}&select=data&limit=1`,
    );
    return body?.length ? body[0].data : null;
  }

  /**
   * `challenges.expires_at` is NOT NULL, so it has to be written explicitly —
   * the column is what the sweep deletes on, and a challenge is the one record
   * here that deliberately outlives its room (30 days, so a link pasted into a
   * chat thread still works next month).
   */
  async putChallenge(challenge: Challenge): Promise<void> {
    await this.upsert('challenges', {
      id: challenge.id,
      data: challenge,
      expires_at: new Date(challenge.expiresAt).toISOString(),
    });
  }

  async sweep(now: number): Promise<void> {
    const stamp = new Date(now).toISOString();
    await this.request(`/rooms?expires_at=lt.${stamp}`, { method: 'DELETE' });
    await this.request(`/challenges?expires_at=lt.${stamp}`, { method: 'DELETE' });
  }
}

/**
 * Tolerate rows written before `players`/`seq` existed. A room that predates
 * them still has a valid puzzle and session, so the game continues rather than
 * throwing on a shape mismatch.
 */
function migrate(record: RoomRecord): RoomRecord {
  return {
    ...record,
    players: Array.isArray(record.players) ? record.players : [],
    seq: typeof record.seq === 'number' ? record.seq : 0,
    locksAt: record.locksAt && typeof record.locksAt === 'object' ? record.locksAt : {},
  };
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

declare global {
  // Reused across hot reloads and warm lambda invocations.
  // eslint-disable-next-line no-var
  var __puzzlyStore: RoomStore | undefined;
}

/**
 * Server-side Supabase URL.
 *
 * `SUPABASE_URL` is optional and only needed to point the server at a
 * different host than the browser uses, so it falls back to the public var —
 * which is the one that actually gets set in practice. Reading only
 * `SUPABASE_URL` would silently downgrade production to in-memory rooms.
 */
export function supabaseUrl(): string | undefined {
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || undefined;
}

export function supabaseServiceKey(): string | undefined {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || undefined;
}

/**
 * The URL and key the *browser* needs to subscribe to Realtime. Both must be
 * `NEXT_PUBLIC_` — a server-only `SUPABASE_URL` is invisible to the bundle, so a
 * deployment can be perfectly able to publish events and still leave every
 * client unable to hear them.
 *
 * The anon key is designed to be public (it grants only what row-level security
 * allows); the service role key is the secret and never leaves the server.
 */
export function supabasePublicUrl(): string | undefined {
  return process.env.NEXT_PUBLIC_SUPABASE_URL || undefined;
}

export function supabaseAnonKey(): string | undefined {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || undefined;
}

/** True when durable, cross-instance storage is configured. */
export function hasDurableStore(): boolean {
  return Boolean(supabaseUrl() && supabaseServiceKey());
}

export function getRoomStore(): RoomStore {
  if (globalThis.__puzzlyStore) return globalThis.__puzzlyStore;
  const url = supabaseUrl();
  const key = supabaseServiceKey();
  const store: RoomStore =
    url && key ? new SupabaseRoomStore({ url, serviceKey: key }) : new MemoryRoomStore();
  if (!url || !key) {
    console.warn(
      '[puzzly] No Supabase credentials found — using in-memory rooms. ' +
        'Multiplayer will only work if every request reaches the same process.',
    );
  }
  globalThis.__puzzlyStore = store;
  return store;
}

/* -------------------------------------------------------------------------- */
/* Keeping an upload alive                                                    */
/* -------------------------------------------------------------------------- */

/** Don't write the same image's expiry more than once per hour per instance. */
const TOUCH_THROTTLE_MS = 60 * 60 * 1000;
const touchedAt = new Map<string, number>();

/**
 * Mark an upload as still wanted.
 *
 * Called from the two places that prove a picture is in use — the board fetching
 * its bytes, and a room being cut from it — so the three-day clock is measured
 * from the last time somebody played with it, not from the upload.
 *
 * Deliberately fire-and-forget, and deliberately throttled: this sits on paths
 * that must stay fast, and being an hour late writing a three-day expiry costs
 * nothing. Uploads only; stock and original assets are not ours to delete.
 */
export function touchImage(id: string): void {
  if (!id.startsWith('img_')) return;

  const now = Date.now();
  const last = touchedAt.get(id);
  if (last !== undefined && now - last < TOUCH_THROTTLE_MS) return;
  touchedAt.set(id, now);
  if (touchedAt.size > 512) {
    for (const [key, at] of touchedAt) if (now - at > TOUCH_THROTTLE_MS) touchedAt.delete(key);
  }

  void (async () => {
    try {
      const store = getRoomStore();
      const asset = await store.getImage(id);
      if (asset) await store.putImage(asset, now + IMAGE_TTL_MS);
    } catch (error) {
      console.warn('[puzzly] could not refresh image expiry', error);
    }
  })();
}
