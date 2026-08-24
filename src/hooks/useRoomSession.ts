'use client';

/**
 * The room, as one hook.
 *
 * This is the seam the architecture directive asks for: **Realtime Adapter**. It
 * owns the seat (join, resume, credentials), the transport, and the client's copy
 * of the authoritative engine — and it deliberately owns *nothing* about drawing.
 *
 * Two rules shape everything below.
 *
 * 1. **The server is authoritative.** Every mutation is sent as a compact event
 *    and applied when it comes back. Local moves are optimistic only so the piece
 *    under your finger keeps up with your hand; if the server disagrees, its
 *    version wins and the piece corrects itself.
 * 2. **React is not in the hot path.** Cursor positions and piece transforms
 *    mutate refs and the engine, then notify subscribers so the canvas can
 *    repaint. React state is reserved for things a human reads in the chrome:
 *    progress, roster, toasts, results.
 *
 * Re-applying an event must always be safe, because the server echoes a player's
 * own events back to them. The engine's `apply*` methods are absolute rather
 * than relative for exactly this reason.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PuzzleEngine } from '@/lib/puzzle/engine';
import { chime, mergeKey, snap } from '@/lib/puzzle/sound';
import { ApiError, createTransport } from '@/lib/realtime';
import { joinRoom } from '@/lib/realtime/api';
import { loadIdentity } from '@/lib/storage/identity';
import { loadSeat, saveLastRoom, saveSeat } from '@/lib/storage/seats';
import type {
  ClientEvent,
  ConnectionStatus,
  RealtimeTransport,
  ServerEvent,
} from '@/types/events';
import type {
  Player,
  Puzzle,
  ResultPlayer,
  Room,
  SessionResult,
} from '@/types/models';

/* -------------------------------------------------------------------------- */
/* Shapes the UI consumes                                                     */
/* -------------------------------------------------------------------------- */

export type RoomPhase = 'joining' | 'lobby' | 'playing' | 'complete' | 'error';

export interface CursorMark {
  playerId: string;
  /** Board coordinates, not screen — the camera moves independently. */
  x: number;
  y: number;
  down: boolean;
  at: number;
}

export interface ReactionBurst {
  id: string;
  playerId: string;
  emoji: string;
  x: number;
  y: number;
}

export interface PingMark {
  id: string;
  playerId: string;
  x: number;
  y: number;
  text: string | null;
  at: number;
}

export interface HintNotice {
  level: number;
  /** Null at level 1 — words only, so the client cannot cheat past the level. */
  pieceId: number | null;
  region: string;
  playerId: string;
  at: number;
}

export interface BoardStats {
  /** 0..1 */
  progress: number;
  placed: number;
  total: number;
  sections: number;
  hintsUsed: number;
  complete: boolean;
}

export interface RoomSession {
  phase: RoomPhase;
  connection: ConnectionStatus;
  /** Set when the room cannot be entered at all. Terminal. */
  fatal: string | null;
  notice: string | null;
  dismissNotice: () => void;

  room: Room | null;
  puzzle: Puzzle | null;
  players: Player[];
  me: Player | null;
  myId: string;
  isHost: boolean;

  engine: PuzzleEngine | null;
  stats: BoardStats;
  result: SessionResult | null;

  /** Live cursor positions, mutated outside React. Read from an animation frame. */
  cursorsRef: React.RefObject<Map<string, CursorMark>>;
  reactions: ReactionBurst[];
  pings: PingMark[];
  hint: HintNotice | null;
  clearHint: () => void;

  send: (event: ClientEvent) => void;
  flush: () => void;
  /** Called whenever the engine changed and the canvas needs to repaint. */
  subscribe: (listener: () => void) => () => void;
  /** Recompute the numbers in the chrome. Coalesced. */
  refreshStats: () => void;
}

const EMPTY_STATS: BoardStats = {
  progress: 0,
  placed: 0,
  total: 0,
  sections: 0,
  hintsUsed: 0,
  complete: false,
};

/** Long enough to survive a stall, short enough that a ghost cursor fades. */
export const CURSOR_TTL_MS = 6000;
const STATS_THROTTLE_MS = 180;
const REACTION_MS = 1700;
const PING_MS = 2800;

/* -------------------------------------------------------------------------- */

export function useRoomSession(code: string): RoomSession {
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [room, setRoom] = useState<Room | null>(null);
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [myId, setMyId] = useState('');

  const [engine, setEngine] = useState<PuzzleEngine | null>(null);
  const [stats, setStats] = useState<BoardStats>(EMPTY_STATS);
  const [result, setResult] = useState<SessionResult | null>(null);

  const [reactions, setReactions] = useState<ReactionBurst[]>([]);
  const [pings, setPings] = useState<PingMark[]>([]);
  const [hint, setHint] = useState<HintNotice | null>(null);

  const cursorsRef = useRef<Map<string, CursorMark>>(new Map());
  const transportRef = useRef<RealtimeTransport | null>(null);
  const engineRef = useRef<PuzzleEngine | null>(null);
  /** Read inside event handlers, where React state would be a render behind. */
  const puzzleRef = useRef<Puzzle | null>(null);
  const myIdRef = useRef('');
  const listenersRef = useRef(new Set<() => void>());
  const statsTimerRef = useRef<number | null>(null);
  const timersRef = useRef(new Set<number>());
  /** Who was connected last time we looked, for "friend disconnected" toasts. */
  const connectedRef = useRef<Set<string>>(new Set());

  /* --- plumbing ----------------------------------------------------------- */

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const markDirty = useCallback(() => {
    for (const listener of listenersRef.current) listener();
  }, []);

  const refreshStats = useCallback(() => {
    if (statsTimerRef.current !== null) return;
    statsTimerRef.current = window.setTimeout(() => {
      statsTimerRef.current = null;
      const current = engineRef.current;
      if (!current) return;
      setStats({
        progress: current.calculateProgress(),
        placed: current.pieceCount - current.groupCount,
        total: current.pieceCount,
        sections: current.sectionCount(),
        hintsUsed: current.hintsUsed,
        complete: current.isComplete(),
      });
    }, STATS_THROTTLE_MS);
  }, []);

  /** A timeout that cannot outlive the room. */
  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timersRef.current.delete(id);
      fn();
    }, ms);
    timersRef.current.add(id);
  }, []);

  const holdPuzzle = useCallback((next: Puzzle) => {
    puzzleRef.current = next;
    setPuzzle(next);
  }, []);

  const installEngine = useCallback(
    (next: PuzzleEngine) => {
      engineRef.current = next;
      setEngine(next);
      refreshStats();
      markDirty();
    },
    [markDirty, refreshStats],
  );

  /* --- event application -------------------------------------------------- */

  const apply = useCallback(
    (event: ServerEvent) => {
      const current = engineRef.current;
      const mine = myIdRef.current;

      switch (event.t) {
        case 'snapshot': {
          setRoom(event.view.room);
          holdPuzzle(event.view.puzzle);
          setPlayers(event.view.players);
          if (event.session) {
            installEngine(PuzzleEngine.fromState(event.session, event.view.puzzle));
          } else {
            installEngine(PuzzleEngine.create(event.view.puzzle));
          }
          if (event.view.room.status !== 'complete') setResult(null);
          return;
        }

        case 'join': {
          setPlayers((list) =>
            list.some((p) => p.id === event.player.id)
              ? list.map((p) => (p.id === event.player.id ? event.player : p))
              : [...list, event.player],
          );
          if (event.player.id !== mine) setNotice(`${event.player.name} joined.`);
          return;
        }

        case 'leave': {
          setPlayers((list) => list.filter((p) => p.id !== event.playerId));
          cursorsRef.current.delete(event.playerId);
          return;
        }

        case 'presence': {
          setPlayers(event.players);
          return;
        }

        case 'ready': {
          setPlayers((list) =>
            list.map((p) => (p.id === event.playerId ? { ...p, ready: event.ready } : p)),
          );
          return;
        }

        case 'status': {
          setRoom((value) => (value ? { ...value, status: event.status } : value));
          return;
        }

        case 'start': {
          setRoom((value) => (value ? { ...value, status: 'playing' } : value));
          setResult(null);
          setPlayers((list) => list.map((p) => ({ ...p, ready: true })));
          // The server's scatter is the one everybody plays; ours was only ever a
          // prewarm so the sprite atlas could be cut during the lobby.
          if (puzzleRef.current) {
            installEngine(PuzzleEngine.fromState(event.session, puzzleRef.current));
          }
          return;
        }

        case 'cursor': {
          if (event.playerId === mine) return;
          cursorsRef.current.set(event.playerId, {
            playerId: event.playerId,
            x: event.x,
            y: event.y,
            down: event.down,
            at: Date.now(),
          });
          return;
        }

        case 'grab': {
          current?.applyLock(event.g, event.playerId, event.z);
          markDirty();
          return;
        }

        case 'release': {
          current?.applyLock(event.g, null);
          markDirty();
          return;
        }

        case 'move': {
          // Our own drag is already ahead of this echo; replaying it would drag
          // the piece backwards under the player's finger.
          if (event.by === mine) return;
          // A drag is a courtesy broadcast, never persisted server-side, so it is
          // only trustworthy while the sender still holds the lock.
          if (!current || current.lockHolder(event.g) !== event.by) return;
          current.applyTransform(event.g, event.ox, event.oy);
          markDirty();
          return;
        }

        case 'rot': {
          current?.applyTransform(event.g, event.ox, event.oy, event.rot);
          markDirty();
          return;
        }

        case 'merge': {
          current?.applyMerge(event.into, event.from, event.ox, event.oy, event.rot, event.z);
          if (current) {
            current.credit.set(
              event.by,
              (current.credit.get(event.by) ?? 0) + event.credit,
            );
          }
          // Every merge is audible from here, including a hint placing a piece
          // for you — that one has no local path at all. `mergeKey` is what stops
          // it doubling up with the optimistic sound on your own drops.
          snap(mergeKey(event.into, event.from), {
            connections: event.from.length,
            mine: event.by === mine,
          });
          if (current?.isComplete()) chime();
          markDirty();
          refreshStats();
          return;
        }

        case 'split': {
          current?.applySplit(event.into, event.groups);
          markDirty();
          refreshStats();
          return;
        }

        case 'react': {
          const burst: ReactionBurst = {
            id: event.id,
            playerId: event.playerId,
            emoji: event.emoji,
            x: event.x,
            y: event.y,
          };
          setReactions((list) => [...list.slice(-11), burst]);
          later(() => setReactions((list) => list.filter((r) => r.id !== burst.id)), REACTION_MS);
          return;
        }

        case 'ping': {
          const mark: PingMark = {
            id: event.id,
            playerId: event.playerId,
            x: event.x,
            y: event.y,
            text: event.text ?? null,
            at: Date.now(),
          };
          setPings((list) => [...list.slice(-3), mark]);
          later(() => setPings((list) => list.filter((p) => p.id !== mark.id)), PING_MS);
          return;
        }

        case 'hint': {
          if (current) current.hintsUsed = event.used;
          setHint({
            level: event.level,
            pieceId: event.pieceId,
            region: event.region,
            playerId: event.playerId,
            at: Date.now(),
          });
          refreshStats();
          markDirty();
          return;
        }

        case 'complete': {
          setRoom((value) => (value ? { ...value, status: 'complete' } : value));
          setResult(event.result);
          if (puzzleRef.current) {
            installEngine(PuzzleEngine.fromState(event.session, puzzleRef.current));
          }
          return;
        }

        case 'reject': {
          setNotice(event.reason);
          if (event.session && puzzleRef.current) {
            installEngine(PuzzleEngine.fromState(event.session, puzzleRef.current));
          }
          return;
        }

        case 'pong':
          return;
      }
    },
    [holdPuzzle, installEngine, later, markDirty, refreshStats],
  );

  /* --- join + connect ----------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    let transport: RealtimeTransport | null = null;

    async function open() {
      const identity = loadIdentity();
      const seat = loadSeat(code);

      try {
        const join = await joinRoom(code, {
          name: identity.name,
          avatar: identity.avatar,
          playerId: seat?.playerId,
          token: seat?.token,
        });
        if (cancelled) return;

        saveSeat(code, join.playerId, join.token);
        saveLastRoom(code, join.view.puzzle.title);

        myIdRef.current = join.playerId;
        setMyId(join.playerId);
        setRoom(join.view.room);
        holdPuzzle(join.view.puzzle);
        setPlayers(join.view.players);
        connectedRef.current = new Set(
          join.view.players.filter((p) => p.connected).map((p) => p.id),
        );

        // Seed the client engine. With no session yet this is a deterministic
        // prewarm from the puzzle seed, which is what lets the sprite atlas be
        // cut while everyone is still in the lobby.
        installEngine(
          join.session
            ? PuzzleEngine.fromState(join.session, join.view.puzzle)
            : PuzzleEngine.create(join.view.puzzle),
        );

        if (join.view.room.status === 'complete' && join.session) {
          setResult(
            localResult(
              join.view.room,
              join.view.puzzle,
              join.view.players,
              PuzzleEngine.fromState(join.session, join.view.puzzle),
            ),
          );
        }

        transport = createTransport(
          {
            roomCode: code,
            playerId: join.playerId,
            token: join.token,
            handlers: {
              onEvent: apply,
              onStatus: (status, detail) => {
                if (cancelled) return;
                setConnection(status);
                if (status === 'error' && detail) setFatal(detail);
              },
            },
          },
          join.realtime,
        );
        transportRef.current = transport;
        transport.connect();
      } catch (cause) {
        if (cancelled) return;
        setFatal(
          cause instanceof ApiError
            ? cause.message
            : 'We could not reach that room. Check your connection and try again.',
        );
        setConnection('error');
      }
    }

    void open();

    return () => {
      cancelled = true;
      transport?.close();
      transportRef.current = null;
      for (const id of timersRef.current) window.clearTimeout(id);
      timersRef.current.clear();
      if (statsTimerRef.current !== null) window.clearTimeout(statsTimerRef.current);
      statsTimerRef.current = null;
    };
    // `apply` and `installEngine` are stable; the room code is the only real input.
  }, [apply, code, holdPuzzle, installEngine]);

  /* --- "your friend dropped out" ------------------------------------------ */

  useEffect(() => {
    const before = connectedRef.current;
    const after = new Set(players.filter((p) => p.connected).map((p) => p.id));
    connectedRef.current = after;
    if (!myIdRef.current) return;

    for (const player of players) {
      if (player.id === myIdRef.current) continue;
      if (before.has(player.id) && !after.has(player.id)) {
        setNotice(`${player.name} lost connection. Their pieces are safe.`);
      } else if (!before.has(player.id) && after.has(player.id) && before.size > 0) {
        setNotice(`${player.name} is back.`);
      }
    }
  }, [players]);

  /* --- a notice is a toast, not a state ----------------------------------- */

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(id);
  }, [notice]);

  useEffect(() => {
    if (!hint) return;
    const id = window.setTimeout(() => setHint(null), 9000);
    return () => window.clearTimeout(id);
  }, [hint]);

  /* --- actions ------------------------------------------------------------ */

  const send = useCallback((event: ClientEvent) => {
    transportRef.current?.send(event);
  }, []);

  const flush = useCallback(() => {
    transportRef.current?.flush();
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);
  const clearHint = useCallback(() => setHint(null), []);

  /* --- derived ------------------------------------------------------------ */

  const me = useMemo(() => players.find((p) => p.id === myId) ?? null, [players, myId]);

  const phase: RoomPhase = fatal
    ? 'error'
    : !room || !puzzle
      ? 'joining'
      : room.status === 'playing'
        ? 'playing'
        : room.status === 'complete'
          ? 'complete'
          : 'lobby';

  return {
    phase,
    connection,
    fatal,
    notice,
    dismissNotice,
    room,
    puzzle,
    players,
    me,
    myId,
    isHost: me?.isHost ?? false,
    engine,
    stats,
    result,
    cursorsRef,
    reactions,
    pings,
    hint,
    clearHint,
    send,
    flush,
    subscribe,
    refreshStats,
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Rebuild the results screen from local state.
 *
 * Only used when someone opens a link to a room that finished while they were
 * away: the `complete` event is long gone, and the engine snapshot already
 * carries everything the server would have used. Mirrors `buildResult` on the
 * server deliberately — same numbers, no extra endpoint.
 */
function localResult(
  room: Room,
  puzzle: Puzzle,
  players: Player[],
  engine: PuzzleEngine,
): SessionResult {
  const total = [...engine.credit.values()].reduce((a, b) => a + b, 0) || 1;
  const resultPlayers: ResultPlayer[] = players.map((player) => {
    const credit = engine.credit.get(player.id) ?? 0;
    return {
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      colorId: player.colorId,
      connections: credit,
      share: credit / total,
    };
  });

  return {
    roomCode: room.code,
    puzzleId: puzzle.id,
    puzzleTitle: puzzle.title,
    imageUrl: puzzle.image.thumbUrl || puzzle.image.url,
    gameType: puzzle.gameType,
    pieceCount: engine.pieceCount,
    durationMs: engine.elapsedMs(engine.completedAt ?? Date.now()),
    completedAt: engine.completedAt ?? Date.now(),
    hintsUsed: engine.hintsUsed,
    players: resultPlayers,
  };
}
