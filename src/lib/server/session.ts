/**
 * Room session logic — stateless by construction.
 *
 * ## Why there is no `RoomHub` any more
 *
 * Vercel runs each request on whatever instance is warm, and instances do not
 * share memory. An authoritative object living in `globalThis` therefore forks:
 * two players hit two instances, each mutates its own copy of the puzzle, and
 * the two boards silently disagree. There is no way to make that correct.
 *
 * So nothing here holds state between requests. Every mutation is:
 *
 *   1. load the record *and its row version* from Postgres
 *   2. rehydrate a `PuzzleEngine` from the stored snapshot
 *   3. validate the request against that engine — the client is never trusted
 *   4. commit with `casRoom(version)`; on conflict, reload and re-apply
 *   5. broadcast what actually changed
 *
 * The engine is pure TypeScript, so step 2 is cheap and gives the server the
 * identical rules the client is running optimistically.
 *
 * ## What is *not* written to the database
 *
 * Cursors, in-flight drag positions, reactions and pings never mutate
 * authoritative state — they are relayed and forgotten. A piece being dragged
 * across the board produces zero writes; only the `grab` that claims it and the
 * `drop` that settles it do. That is the difference between ~2 writes per piece
 * placed and one write per mouse move.
 */

import type {
  Player,
  PlayerColorId,
  Puzzle,
  PuzzleSessionState,
  ResultPlayer,
  Room,
  RoomSettings,
  RoomView,
  SessionResult,
} from '@/types/models';
import type { ClientEvent, ServerEvent } from '@/types/events';
import { PuzzleEngine } from '@/lib/puzzle/engine';
import { isReaction, nextColorId, sanitizeAvatar, sanitizeName } from '@/lib/multiplayer/identity';
import { createId, createToken, generateRoomCode, safeEqual } from '@/lib/ids';
import { getRoomStore, type RoomRecord, type SeatState } from './store';
import { getBroadcaster, type Delivery } from './broadcast';

export const MAX_PLAYERS = 6;
const MAX_PING_TEXT = 90;
/**
 * How long a room survives without anyone touching it.
 *
 * Measured from the last activity, not from creation — every join, event batch
 * and hint pushes it out again (see `touch`), so a puzzle you come back to over
 * a long weekend is still there, and a link nobody used goes away. Three days is
 * the point where "we'll finish it tomorrow" is still honoured and abandoned
 * rooms stop accumulating.
 */
export const ROOM_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * A lock is released this long after it was taken unless refreshed. Nothing
 * tells the server that a player closed their laptop mid-drag, so locks cannot
 * wait for a disconnect notification. Clients refresh via `alive` while
 * dragging, which makes a long drag cost one write every few seconds.
 */
const LOCK_TTL_MS = 20_000;
/** A seat is shown as offline after this long without a heartbeat. */
const PRESENCE_TTL_MS = 45_000;
/** `alive` only writes when the stored timestamp is at least this stale. */
const PRESENCE_WRITE_MS = 12_000;
/** How many times to re-apply a batch after losing a compare-and-swap race. */
const CAS_ATTEMPTS = 6;

/* -------------------------------------------------------------------------- */
/* Projections                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Public view of a seat. `connected` is a best guess from the last heartbeat —
 * good enough for a freshly-loaded snapshot. Live presence comes from the
 * realtime channel and overrides this on the client.
 */
export function toPublicPlayer(seat: SeatState, now: number): Player {
  return {
    id: seat.id,
    name: seat.name,
    avatar: seat.avatar,
    colorId: seat.colorId,
    isHost: seat.isHost,
    ready: seat.ready,
    connected: now - seat.lastSeenAt < PRESENCE_TTL_MS,
    joinedAt: seat.joinedAt,
    lastSeenAt: seat.lastSeenAt,
    connections: seat.connections,
  };
}

export function publicRoster(record: RoomRecord, now: number): Player[] {
  return [...record.players]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((seat) => toPublicPlayer(seat, now));
}

function buildView(record: RoomRecord, engine: PuzzleEngine, now: number): RoomView {
  return {
    room: record.room,
    puzzle: record.puzzle,
    players: publicRoster(record, now),
    session: {
      status: engine.status,
      startedAt: engine.startedAt,
      completedAt: engine.completedAt,
      elapsedMs: engine.elapsedMs(now),
      connected: engine.pieceCount - engine.groupCount,
      total: engine.pieceCount,
      progress: engine.calculateProgress(),
      hintsUsed: engine.hintsUsed,
    },
  };
}

/** Rehydrate the authoritative engine. Deterministic when there is no snapshot. */
function engineFor(record: RoomRecord): PuzzleEngine {
  if (record.session) return PuzzleEngine.fromState(record.session, record.puzzle);
  // `create` scatters from the puzzle seed, so every caller derives the exact
  // same starting layout without anything being stored yet.
  const engine = PuzzleEngine.create(record.puzzle);
  engine.status = record.room.status;
  return engine;
}

/* -------------------------------------------------------------------------- */
/* Mutation harness                                                           */
/* -------------------------------------------------------------------------- */

type Attempt<T> =
  | { ok: true; value: T; deliveries: Delivery[]; dirty: boolean }
  | { ok: false; status: number; error: string };

export type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/**
 * Load → mutate → compare-and-swap → broadcast, retrying the whole thing if
 * another instance commits first. `run` must be a pure function of the record
 * it is handed, because it may be called several times.
 */
async function withRoom<T>(
  code: string,
  run: (record: RoomRecord, now: number) => Attempt<T>,
): Promise<Outcome<T>> {
  const store = getRoomStore();

  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const loaded = await store.getRoomVersioned(code);
    if (!loaded) {
      return { ok: false, status: 404, error: 'That room has ended or never existed.' };
    }
    const now = Date.now();
    if (loaded.record.room.expiresAt < now) {
      return { ok: false, status: 410, error: 'That room has expired.' };
    }

    const result = run(loaded.record, now);
    if (!result.ok) return result;

    if (!result.dirty) {
      await publish(code, result.deliveries);
      return { ok: true, value: result.value };
    }

    if (await store.casRoom(loaded.record, loaded.version)) {
      await publish(code, result.deliveries);
      return { ok: true, value: result.value };
    }
    // Lost the race. Loop: reload and re-apply against the winner's state.
  }

  return { ok: false, status: 503, error: 'The room is busy right now — try again.' };
}

async function publish(code: string, deliveries: Delivery[]): Promise<void> {
  if (!deliveries.length) return;
  await getBroadcaster().publish(code, deliveries);
}

/* -------------------------------------------------------------------------- */
/* Event context                                                              */
/* -------------------------------------------------------------------------- */

interface Ctx {
  record: RoomRecord;
  engine: PuzzleEngine;
  seat: SeatState;
  now: number;
  deliveries: Delivery[];
  seq: number;
  dirty: boolean;
}

/** An ordered, gap-checked fact. Only valid once the record commits. */
function emit(ctx: Ctx, event: ServerEvent): void {
  ctx.deliveries.push({ to: null, envelope: { seq: ++ctx.seq, event } });
}

/**
 * An unordered nicety — cursor, reaction, ping, in-flight drag. `seq: 0` marks
 * it as exempt from gap detection, because these are never persisted and
 * missing one has no consequence.
 */
function emitLoose(ctx: Ctx, event: ServerEvent): void {
  ctx.deliveries.push({ to: null, envelope: { seq: 0, event } });
}

function emitTo(ctx: Ctx, playerId: string, event: ServerEvent): void {
  ctx.deliveries.push({ to: playerId, envelope: { seq: 0, event } });
}

function touch(ctx: Ctx): void {
  ctx.record.room.updatedAt = ctx.now;
  ctx.record.room.expiresAt = ctx.now + ROOM_TTL_MS;
}

/** Persist whatever the engine currently believes. */
function save(ctx: Ctx): void {
  ctx.record.session = ctx.engine.toState();
  ctx.record.seq = ctx.seq;
  ctx.dirty = true;
}

function clampCoord(v: number, max: number): number {
  const slack = max * 0.5;
  return Math.round(Math.min(Math.max(v, -slack), max + slack) * 10) / 10;
}

/* -------------------------------------------------------------------------- */
/* Room creation                                                              */
/* -------------------------------------------------------------------------- */

export interface CreateRoomInput {
  puzzle: Puzzle;
  settings: RoomSettings;
}

/**
 * Create an empty room. The first player to join becomes host, which keeps
 * creation a single write and means a shared link works even if the creator
 * never opens it themselves.
 */
export async function createRoomSession(input: CreateRoomInput): Promise<RoomRecord | null> {
  const store = getRoomStore();
  const now = Date.now();

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = generateRoomCode();
    const room: Room = {
      id: createId('room', 10),
      code,
      hostId: '',
      gameType: input.puzzle.gameType,
      puzzleId: input.puzzle.id,
      status: 'lobby',
      settings: input.settings,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ROOM_TTL_MS,
    };
    const record: RoomRecord = {
      room,
      puzzle: input.puzzle,
      session: null,
      players: [],
      seq: 0,
      locksAt: {},
    };
    if (await store.createRoom(record)) return record;
    // Code collision (or a transient failure); try another code.
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Joining                                                                    */
/* -------------------------------------------------------------------------- */

export interface JoinInput {
  name: unknown;
  avatar: unknown;
  /** Present when resuming: a refresh mid-puzzle must not consume a new seat. */
  playerId?: string;
  token?: string;
}

export interface JoinPayload {
  playerId: string;
  token: string;
  player: Player;
  view: RoomView;
  session: PuzzleSessionState | null;
  seq: number;
  resumed: boolean;
}

export async function joinRoom(code: string, input: JoinInput): Promise<Outcome<JoinPayload>> {
  return withRoom<JoinPayload>(code, (record, now) => {
    const engine = engineFor(record);
    const deliveries: Delivery[] = [];
    let seq = record.seq;
    let dirty = false;

    // --- Resume an existing seat -------------------------------------------
    if (input.playerId && input.token) {
      const seat = record.players.find((p) => p.id === input.playerId);
      if (seat && safeEqual(seat.token, input.token)) {
        seat.name = sanitizeName(input.name ?? seat.name);
        seat.avatar = sanitizeAvatar(input.avatar ?? seat.avatar);
        seat.lastSeenAt = now;
        record.seq = seq;
        return {
          ok: true,
          dirty: true,
          deliveries: [
            { to: null, envelope: { seq: ++seq, event: { t: 'presence', players: publicRoster(record, now) } } },
          ],
          value: {
            playerId: seat.id,
            token: seat.token,
            player: toPublicPlayer(seat, now),
            view: buildView(record, engine, now),
            session: record.session,
            seq: record.seq,
            resumed: true,
          },
        };
      }
      // A stale id/token pair is not an error — fall through and hand out a
      // fresh seat, so a returning player is never stuck on a dead room.
    }

    // --- New seat -----------------------------------------------------------
    if (record.players.length >= MAX_PLAYERS) {
      return { ok: false, status: 409, error: 'This room is full.' };
    }
    if (record.room.status === 'complete' && record.players.length === 0) {
      return { ok: false, status: 410, error: 'This puzzle has already been finished.' };
    }

    const taken = record.players.map((p) => p.colorId);
    const isHost = record.players.length === 0;
    const seat: SeatState = {
      id: createId('p', 10),
      name: sanitizeName(input.name),
      avatar: sanitizeAvatar(input.avatar),
      colorId: nextColorId(taken) as PlayerColorId,
      isHost,
      ready: false,
      joinedAt: now,
      lastSeenAt: now,
      connections: 0,
      token: createToken(),
      budget: 0,
      budgetAt: now,
      hintPieceId: null,
      hintRegion: null,
      hintLevel: 0,
    };
    record.players.push(seat);
    if (isHost) record.room.hostId = seat.id;
    record.room.updatedAt = now;
    record.room.expiresAt = now + ROOM_TTL_MS;
    dirty = true;

    const publicSeat = toPublicPlayer(seat, now);
    deliveries.push({ to: null, envelope: { seq: ++seq, event: { t: 'join', player: publicSeat } } });
    deliveries.push({
      to: null,
      envelope: { seq: ++seq, event: { t: 'presence', players: publicRoster(record, now) } },
    });
    record.seq = seq;

    return {
      ok: true,
      dirty,
      deliveries,
      value: {
        playerId: seat.id,
        token: seat.token,
        player: publicSeat,
        view: buildView(record, engine, now),
        session: record.session,
        seq: record.seq,
        resumed: false,
      },
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Snapshots                                                                  */
/* -------------------------------------------------------------------------- */

export interface SnapshotPayload {
  view: RoomView;
  session: PuzzleSessionState | null;
  seq: number;
}

/** Read-only. Used by the lobby page and by clients recovering from a gap. */
export async function loadSnapshot(code: string): Promise<Outcome<SnapshotPayload>> {
  const record = await getRoomStore().getRoom(code);
  if (!record) return { ok: false, status: 404, error: 'That room has ended or never existed.' };
  const now = Date.now();
  if (record.room.expiresAt < now) {
    return { ok: false, status: 410, error: 'That room has expired.' };
  }
  const engine = engineFor(record);
  return {
    ok: true,
    value: { view: buildView(record, engine, now), session: record.session, seq: record.seq },
  };
}

/* -------------------------------------------------------------------------- */
/* Client events                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Apply a batch of client requests.
 *
 * Every branch validates before mutating. A client asserting that it holds a
 * piece, or that the puzzle is finished, changes nothing — the engine decides
 * (spec §30).
 */
export async function applyClientEvents(
  code: string,
  playerId: string,
  token: string,
  events: ClientEvent[],
): Promise<Outcome<{ seq: number }>> {
  return withRoom<{ seq: number }>(code, (record, now) => {
    const seat = record.players.find((p) => p.id === playerId);
    if (!seat) {
      return { ok: false, status: 401, error: 'You are not in this room any more.' };
    }
    if (!safeEqual(seat.token, token)) {
      return { ok: false, status: 401, error: 'Invalid room credentials.' };
    }

    const ctx: Ctx = {
      record,
      engine: engineFor(record),
      seat,
      now,
      deliveries: [],
      seq: record.seq,
      dirty: false,
    };

    // Exact per-player rate limiting, because the bucket rides along in the
    // record we were going to write anyway (~30 events/s sustained).
    if (!spend(ctx, events.length)) {
      return {
        ok: true,
        dirty: false,
        deliveries: [{ to: seat.id, envelope: { seq: 0, event: { t: 'reject', reason: 'Slow down a moment.' } } }],
        value: { seq: ctx.seq },
      };
    }

    expireLocks(ctx);

    for (const event of events) {
      switch (event.t) {
        case 'cursor':
          onCursor(ctx, event);
          break;
        case 'move':
          onMove(ctx, event);
          break;
        case 'react':
          onReact(ctx, event);
          break;
        case 'ping':
          onPing(ctx, event);
          break;
        case 'ready':
          onReady(ctx, event.ready);
          break;
        case 'start':
          onStart(ctx, false);
          break;
        case 'grab':
          onGrab(ctx, event.g);
          break;
        case 'drop':
          onDrop(ctx, event);
          break;
        case 'rotate':
          onRotate(ctx, event);
          break;
        case 'hint':
          onHint(ctx, event.level);
          break;
        case 'undo':
          onUndo(ctx, 'undo');
          break;
        case 'redo':
          onUndo(ctx, 'redo');
          break;
        case 'alive':
          onAlive(ctx, event);
          break;
        case 'resync':
          onResync(ctx);
          break;
        case 'restart':
          onRestart(ctx);
          break;
        case 'bye':
          onBye(ctx);
          break;
        default:
          // Unknown event types are dropped rather than trusted.
          break;
      }
    }

    if (ctx.dirty) record.seq = ctx.seq;
    return { ok: true, dirty: ctx.dirty, deliveries: ctx.deliveries, value: { seq: ctx.seq } };
  });
}

/** Token bucket: ~30 events/second sustained, with a burst allowance. */
function spend(ctx: Ctx, cost: number): boolean {
  const seat = ctx.seat;
  const elapsed = Math.max(0, ctx.now - seat.budgetAt);
  seat.budgetAt = ctx.now;
  seat.budget = Math.max(0, (seat.budget ?? 0) - elapsed * 0.03);
  if (seat.budget + cost > 240) return false;
  seat.budget += cost;
  return true;
}

/**
 * Release locks nobody is refreshing. Without this a player who closes their
 * laptop mid-drag would strand a piece for the rest of the session.
 */
function expireLocks(ctx: Ctx): void {
  for (const [groupId, holder] of ctx.engine.lockEntries) {
    const takenAt = ctx.record.locksAt[groupId] ?? 0;
    if (ctx.now - takenAt <= LOCK_TTL_MS) continue;
    ctx.engine.release(groupId, holder);
    delete ctx.record.locksAt[groupId];
    emit(ctx, { t: 'release', playerId: holder, g: groupId });
    save(ctx);
  }
}

/* --- ephemeral ------------------------------------------------------------ */

function onCursor(ctx: Ctx, event: Extract<ClientEvent, { t: 'cursor' }>): void {
  if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
  emitLoose(ctx, {
    t: 'cursor',
    playerId: ctx.seat.id,
    x: clampCoord(event.x, ctx.engine.geometry.boardW),
    y: clampCoord(event.y, ctx.engine.geometry.boardH),
    down: Boolean(event.down),
  });
}

/**
 * In-flight drag position.
 *
 * Deliberately does **not** touch the engine: a drag is a visual courtesy to
 * the other players, and the authoritative position is whatever `drop` settles
 * on. This is what keeps a piece moving across the board at zero database cost.
 */
function onMove(ctx: Ctx, event: Extract<ClientEvent, { t: 'move' }>): void {
  if (ctx.record.room.status !== 'playing') return;
  if (!Number.isFinite(event.ox) || !Number.isFinite(event.oy)) return;
  if (ctx.engine.lockHolder(event.g) !== ctx.seat.id) return;
  emitLoose(ctx, {
    t: 'move',
    g: event.g,
    ox: clampCoord(event.ox, ctx.engine.geometry.boardW),
    oy: clampCoord(event.oy, ctx.engine.geometry.boardH),
    by: ctx.seat.id,
  });
}

function onReact(ctx: Ctx, event: Extract<ClientEvent, { t: 'react' }>): void {
  if (!isReaction(event.emoji)) return;
  if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
  emitLoose(ctx, {
    t: 'react',
    playerId: ctx.seat.id,
    emoji: event.emoji,
    x: clampCoord(event.x, ctx.engine.geometry.boardW),
    y: clampCoord(event.y, ctx.engine.geometry.boardH),
    id: createId('r', 6),
  });
}

function onPing(ctx: Ctx, event: Extract<ClientEvent, { t: 'ping' }>): void {
  if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
  const text =
    typeof event.text === 'string' && event.text.trim()
      ? event.text.replace(/\s+/g, ' ').trim().slice(0, MAX_PING_TEXT)
      : undefined;
  emitLoose(ctx, {
    t: 'ping',
    playerId: ctx.seat.id,
    x: clampCoord(event.x, ctx.engine.geometry.boardW),
    y: clampCoord(event.y, ctx.engine.geometry.boardH),
    text,
    id: createId('k', 6),
  });
}

/* --- lobby ---------------------------------------------------------------- */

function onReady(ctx: Ctx, ready: boolean): void {
  if (ctx.record.room.status !== 'lobby') return;
  const next = Boolean(ready);
  if (ctx.seat.ready === next) return;
  ctx.seat.ready = next;
  ctx.seat.lastSeenAt = ctx.now;
  emit(ctx, { t: 'ready', playerId: ctx.seat.id, ready: next });
  ctx.dirty = true;

  // Everyone ready is the common case for two friends, so start without making
  // the host reach for a button. Uses stored `ready` flags only — the server
  // has no socket to derive presence from.
  const roster = ctx.record.players;
  if (roster.length >= 2 && roster.every((p) => p.ready)) onStart(ctx, true);
}

function onStart(ctx: Ctx, auto: boolean): void {
  if (ctx.record.room.status !== 'lobby') return;
  if (!auto) {
    // Only the host may start early, and only if the room allows it (spec §7).
    if (!ctx.seat.isHost) return;
    if (!ctx.record.room.settings.hostCanForceStart) return;
  }
  ctx.record.room.status = 'playing';
  ctx.engine.status = 'playing';
  ctx.engine.startedAt = ctx.now;
  touch(ctx);
  save(ctx);
  emit(ctx, { t: 'start', startedAt: ctx.now, session: ctx.record.session! });
}

/* --- play ----------------------------------------------------------------- */

function onGrab(ctx: Ctx, groupId: number): void {
  if (ctx.record.room.status !== 'playing') return;
  if (!Number.isInteger(groupId)) return;

  // Already ours: this is a lock refresh during a long drag.
  if (ctx.engine.lockHolder(groupId) === ctx.seat.id) {
    ctx.record.locksAt[groupId] = ctx.now;
    ctx.dirty = true;
    return;
  }

  const z = ctx.engine.grab(groupId, ctx.seat.id);
  if (z === null) {
    emitTo(ctx, ctx.seat.id, { t: 'reject', reason: 'Someone else has that piece.' });
    return;
  }
  ctx.record.locksAt[groupId] = ctx.now;
  ctx.seat.lastSeenAt = ctx.now;
  emit(ctx, { t: 'grab', playerId: ctx.seat.id, g: groupId, z });
  save(ctx);
}

function onDrop(ctx: Ctx, event: Extract<ClientEvent, { t: 'drop' }>): void {
  if (ctx.record.room.status !== 'playing') return;
  if (!Number.isFinite(event.ox) || !Number.isFinite(event.oy)) return;
  if (ctx.engine.lockHolder(event.g) !== ctx.seat.id) return;

  const result = ctx.engine.drop(event.g, event.ox, event.oy, ctx.seat.id, ctx.now);
  ctx.engine.release(event.g, ctx.seat.id);
  delete ctx.record.locksAt[event.g];
  ctx.seat.lastSeenAt = ctx.now;

  if (result.moved) {
    emit(ctx, {
      t: 'move',
      g: result.moved.g,
      ox: result.moved.ox,
      oy: result.moved.oy,
      by: ctx.seat.id,
    });
  }
  emit(ctx, { t: 'release', playerId: ctx.seat.id, g: event.g });

  for (const merge of result.merges) {
    ctx.seat.connections += merge.connections;
    // Absorbed groups no longer exist, so neither should their lock stamps.
    for (const gone of merge.from) delete ctx.record.locksAt[gone];
    emit(ctx, {
      t: 'merge',
      into: merge.into,
      from: merge.from,
      ox: merge.ox,
      oy: merge.oy,
      rot: merge.rot,
      z: merge.z,
      by: ctx.seat.id,
      credit: merge.connections,
    });
  }
  if (result.straightened) {
    const s = result.straightened;
    emit(ctx, { t: 'rot', g: s.g, rot: s.rot, ox: s.ox, oy: s.oy, by: ctx.seat.id });
  }

  save(ctx);
  if (result.completed) finish(ctx);
}

function onRotate(ctx: Ctx, event: Extract<ClientEvent, { t: 'rotate' }>): void {
  if (ctx.record.room.status !== 'playing') return;
  if (!ctx.record.puzzle.settings.rotation) return;
  if (event.dir !== 1 && event.dir !== -1) return;
  if (ctx.engine.lockHolder(event.g) !== ctx.seat.id) return;

  const result = ctx.engine.rotatePiece(event.g, event.dir, undefined, ctx.seat.id);
  if (!result) return;
  ctx.record.locksAt[event.g] = ctx.now;
  emit(ctx, {
    t: 'rot',
    g: result.g,
    rot: result.rot,
    ox: result.ox,
    oy: result.oy,
    by: ctx.seat.id,
  });
  save(ctx);
}

/**
 * Progressive hints (spec §16). Level 1 names a region, 2 highlights it,
 * 3 highlights the piece, 4 places it. Escalating levels keep pointing at the
 * same piece so the sequence tells one coherent story.
 */
function onHint(ctx: Ctx, level: 1 | 2 | 3 | 4): void {
  if (ctx.record.room.status !== 'playing') return;
  if (level !== 1 && level !== 2 && level !== 3 && level !== 4) return;

  const seat = ctx.seat;
  const keep =
    level > 1 &&
    seat.hintPieceId !== null &&
    seat.hintRegion !== null &&
    ctx.engine.isPlaceable(seat.hintPieceId);

  if (!keep) {
    const picked = ctx.engine.pickHintTarget();
    if (!picked) return;
    seat.hintPieceId = picked.pieceId;
    seat.hintRegion = picked.region;
  }
  const pieceId = seat.hintPieceId;
  const region = seat.hintRegion;
  if (pieceId === null || region === null) return;

  seat.hintLevel = level;
  ctx.engine.hintsUsed += 1;

  if (level === 4) {
    const result = ctx.engine.placeHint(pieceId, seat.id, ctx.now);
    emit(ctx, {
      t: 'hint',
      playerId: seat.id,
      level,
      pieceId,
      region,
      used: ctx.engine.hintsUsed,
    });
    if (result) {
      for (const merge of result.merges) {
        seat.connections += merge.connections;
        for (const gone of merge.from) delete ctx.record.locksAt[gone];
        emit(ctx, {
          t: 'merge',
          into: merge.into,
          from: merge.from,
          ox: merge.ox,
          oy: merge.oy,
          rot: merge.rot,
          z: merge.z,
          by: seat.id,
          credit: merge.connections,
        });
      }
    }
    seat.hintPieceId = null;
    seat.hintRegion = null;
    seat.hintLevel = 0;
    save(ctx);
    if (result?.completed) finish(ctx);
    return;
  }

  emit(ctx, {
    t: 'hint',
    playerId: seat.id,
    level,
    // Level 1 is words only; from level 2 the client may draw the location.
    pieceId: level >= 2 ? pieceId : null,
    region,
    used: ctx.engine.hintsUsed,
  });
  save(ctx);
}

function onUndo(ctx: Ctx, direction: 'undo' | 'redo'): void {
  if (ctx.record.room.status !== 'playing') return;
  const result =
    direction === 'undo' ? ctx.engine.undo(ctx.seat.id) : ctx.engine.redo(ctx.seat.id);
  if (!result) return;

  if (result.blocked) {
    emitTo(ctx, ctx.seat.id, {
      t: 'reject',
      reason: 'That move has moved on — nothing to undo.',
      session: ctx.engine.toState(),
    });
    return;
  }
  for (const transform of result.transforms) {
    emit(ctx, {
      t: 'rot',
      g: transform.g,
      rot: transform.rot,
      ox: transform.ox,
      oy: transform.oy,
      by: ctx.seat.id,
    });
  }
  for (const split of result.splits) {
    emit(ctx, { t: 'split', into: split.into, groups: split.groups, by: ctx.seat.id });
  }
  for (const merge of result.merges) {
    emit(ctx, {
      t: 'merge',
      into: merge.into,
      from: merge.from,
      ox: merge.ox,
      oy: merge.oy,
      rot: merge.rot,
      z: merge.z,
      by: ctx.seat.id,
      credit: merge.connections,
    });
  }
  save(ctx);
}

/* --- housekeeping --------------------------------------------------------- */

function onAlive(ctx: Ctx, event: Extract<ClientEvent, { t: 'alive' }>): void {
  // Refresh locks this player says they are still holding, so a slow, careful
  // drag is never stolen out from under them.
  if (Array.isArray(event.holding)) {
    for (const groupId of event.holding.slice(0, MAX_PLAYERS * 4)) {
      if (!Number.isInteger(groupId)) continue;
      if (ctx.engine.lockHolder(groupId) !== ctx.seat.id) continue;
      ctx.record.locksAt[groupId] = ctx.now;
      ctx.dirty = true;
    }
  }
  // Only write for the timestamp once it has actually gone stale.
  if (ctx.now - ctx.seat.lastSeenAt >= PRESENCE_WRITE_MS) {
    ctx.seat.lastSeenAt = ctx.now;
    ctx.record.room.expiresAt = ctx.now + ROOM_TTL_MS;
    ctx.dirty = true;
    emitLoose(ctx, { t: 'presence', players: publicRoster(ctx.record, ctx.now) });
  }
}

function onResync(ctx: Ctx): void {
  emitTo(ctx, ctx.seat.id, {
    t: 'snapshot',
    seq: ctx.record.seq,
    view: buildView(ctx.record, ctx.engine, ctx.now),
    session: ctx.engine.toState(),
  });
}

/** Re-cut the same picture for a rematch, keeping everyone in their seats. */
function onRestart(ctx: Ctx): void {
  if (!ctx.seat.isHost) return;
  if (ctx.record.room.status !== 'complete') return;

  const seed = (Math.floor(Math.random() * 0xffffffff) ^ ctx.now) >>> 0;
  ctx.record.puzzle = { ...ctx.record.puzzle, seed, createdAt: ctx.now };
  ctx.engine = PuzzleEngine.create(ctx.record.puzzle);
  ctx.record.room.status = 'lobby';
  ctx.record.locksAt = {};
  for (const seat of ctx.record.players) {
    seat.ready = false;
    seat.connections = 0;
    seat.hintPieceId = null;
    seat.hintRegion = null;
    seat.hintLevel = 0;
  }
  touch(ctx);
  save(ctx);
  emit(ctx, {
    t: 'snapshot',
    seq: ctx.seq,
    view: buildView(ctx.record, ctx.engine, ctx.now),
    session: ctx.record.session,
  });
}

/** Explicit leave. Frees the seat immediately rather than waiting for expiry. */
function onBye(ctx: Ctx): void {
  const seat = ctx.seat;
  for (const groupId of ctx.engine.releaseAll(seat.id)) {
    delete ctx.record.locksAt[groupId];
    emit(ctx, { t: 'release', playerId: seat.id, g: groupId });
  }
  ctx.record.players = ctx.record.players.filter((p) => p.id !== seat.id);

  // Hand the host badge to whoever has been here longest.
  if (ctx.record.room.hostId === seat.id) {
    const next = [...ctx.record.players].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next) {
      for (const p of ctx.record.players) p.isHost = p.id === next.id;
      ctx.record.room.hostId = next.id;
    }
  }
  emit(ctx, { t: 'leave', playerId: seat.id });
  emit(ctx, { t: 'presence', players: publicRoster(ctx.record, ctx.now) });
  save(ctx);
}

/* --- completion ----------------------------------------------------------- */

function finish(ctx: Ctx): void {
  ctx.record.room.status = 'complete';
  ctx.engine.status = 'complete';
  ctx.engine.completedAt ??= ctx.now;
  touch(ctx);
  save(ctx);
  emit(ctx, {
    t: 'complete',
    result: buildResult(ctx.record, ctx.engine, ctx.now),
    session: ctx.record.session!,
  });
}

export function buildResult(
  record: RoomRecord,
  engine: PuzzleEngine,
  now: number,
): SessionResult {
  const totalCredit = [...engine.credit.values()].reduce((a, b) => a + b, 0) || 1;
  const players: ResultPlayer[] = publicRoster(record, now).map((p) => {
    const credit = engine.credit.get(p.id) ?? 0;
    return {
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      colorId: p.colorId,
      connections: credit,
      share: credit / totalCredit,
    };
  });
  return {
    roomCode: record.room.code,
    puzzleId: record.puzzle.id,
    puzzleTitle: record.puzzle.title,
    imageUrl: record.puzzle.image.thumbUrl || record.puzzle.image.url,
    gameType: record.puzzle.gameType,
    pieceCount: engine.pieceCount,
    durationMs: engine.elapsedMs(now),
    completedAt: engine.completedAt ?? now,
    hintsUsed: engine.hintsUsed,
    players,
  };
}

/** Result for a finished room, for the results screen after a reload. */
export async function loadResult(code: string): Promise<SessionResult | null> {
  const record = await getRoomStore().getRoom(code);
  if (!record?.session) return null;
  const engine = engineFor(record);
  if (!engine.isComplete()) return null;
  return buildResult(record, engine, Date.now());
}
