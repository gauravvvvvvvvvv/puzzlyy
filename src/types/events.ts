/**
 * Realtime protocol.
 *
 * Two rules shape every message here (spec §11, §27):
 *  1. No canvas snapshots and no image bytes ever travel over the wire — only
 *     compact deltas describing intent and authoritative results.
 *  2. The server owns the truth. Clients send *requests*; the server validates
 *     them against its own copy of the puzzle engine and broadcasts *facts*.
 */

import type {
  Player,
  PuzzleSessionState,
  RoomStatus,
  RoomView,
  SessionResult,
} from './models';

/* -------------------------------------------------------------------------- */
/* Client -> server                                                           */
/* -------------------------------------------------------------------------- */

export type ClientEvent =
  /** Continuous pointer position in board coordinates. Throttled client-side. */
  | { t: 'cursor'; x: number; y: number; down?: boolean }
  | { t: 'ready'; ready: boolean }
  | { t: 'start' }
  /** Claim exclusive control of a group before dragging it. */
  | { t: 'grab'; g: number }
  /** Drag update for a group this player holds. */
  | { t: 'move'; g: number; ox: number; oy: number }
  /** Release the group; the server runs snap detection and may merge. */
  | { t: 'drop'; g: number; ox: number; oy: number }
  | { t: 'rotate'; g: number; dir: 1 | -1 }
  | { t: 'react'; emoji: string; x: number; y: number }
  /** "Look here" ping, optionally with a short attached note. */
  | { t: 'ping'; x: number; y: number; text?: string }
  | { t: 'hint'; level: 1 | 2 | 3 | 4 }
  | { t: 'undo' }
  | { t: 'redo' }
  /**
   * Keep-alive. Refreshes `lastSeenAt` and re-asserts any locks this player
   * holds, so a drag that lasts longer than the lock TTL is not stolen. Only
   * writes when the stored timestamp has actually gone stale.
   */
  | { t: 'alive'; holding?: number[] }
  /** "I think I missed something" — asks for a fresh snapshot, privately. */
  | { t: 'resync' }
  /** Host re-cuts the same picture for a rematch. */
  | { t: 'restart' }
  /** Voluntary, explicit leave (closing a tab is handled by the SSE close). */
  | { t: 'bye' };

export interface ClientEnvelope {
  playerId: string;
  token: string;
  events: ClientEvent[];
}

/* -------------------------------------------------------------------------- */
/* Server -> client                                                           */
/* -------------------------------------------------------------------------- */

export type ServerEvent =
  /** Sent immediately on (re)connect. Fully restores a client from scratch. */
  | { t: 'snapshot'; seq: number; view: RoomView; session: PuzzleSessionState | null }
  | { t: 'join'; player: Player }
  | { t: 'leave'; playerId: string }
  | { t: 'presence'; players: Player[] }
  | { t: 'ready'; playerId: string; ready: boolean }
  | { t: 'status'; status: RoomStatus }
  | { t: 'start'; startedAt: number; session: PuzzleSessionState }
  | { t: 'cursor'; playerId: string; x: number; y: number; down: boolean }
  | { t: 'grab'; playerId: string; g: number; z: number }
  | { t: 'release'; playerId: string; g: number }
  | { t: 'move'; g: number; ox: number; oy: number; by: string }
  | { t: 'rot'; g: number; rot: number; ox: number; oy: number; by: string }
  /** `from` groups were absorbed into `into`, which lands at (ox, oy, rot). */
  | {
      t: 'merge';
      into: number;
      from: number[];
      ox: number;
      oy: number;
      rot: number;
      z: number;
      by: string;
      credit: number;
    }
  /** Undo of a merge: `groups` are re-created with the given membership. */
  | { t: 'split'; into: number; groups: SplitGroup[]; by: string }
  | { t: 'react'; playerId: string; emoji: string; x: number; y: number; id: string }
  | { t: 'ping'; playerId: string; x: number; y: number; text?: string; id: string }
  /**
   * Progressive hint (spec §16). Level 1 sends only `region` ("the top-right");
   * from level 2 `pieceId` is included so the board can show the location.
   */
  | {
      t: 'hint';
      playerId: string;
      level: 1 | 2 | 3 | 4;
      pieceId: number | null;
      region: string;
      used: number;
    }
  | { t: 'complete'; result: SessionResult; session: PuzzleSessionState }
  /** Server refused a request; client should reconcile from `session`. */
  | { t: 'reject'; reason: string; session?: PuzzleSessionState }
  | { t: 'pong'; now: number };

export interface SplitGroup {
  id: number;
  pieces: number[];
  ox: number;
  oy: number;
  rot: number;
  z: number;
}

export interface ServerEnvelope {
  seq: number;
  event: ServerEvent;
}

/* -------------------------------------------------------------------------- */
/* Transport abstraction                                                      */
/* -------------------------------------------------------------------------- */

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'error';

export interface TransportHandlers {
  onEvent: (event: ServerEvent) => void;
  onStatus: (status: ConnectionStatus, detail?: string) => void;
}

/**
 * Every realtime backend implements this. Swapping SSE for Supabase Realtime,
 * a Durable Object or a plain WebSocket means writing one of these and nothing
 * else in the app changes (spec §28).
 */
export interface RealtimeTransport {
  connect(): void;
  /** Queued and coalesced; safe to call at pointer-event rates. */
  send(event: ClientEvent): void;
  /** Flush the outbox immediately (used before navigating away). */
  flush(): void;
  close(): void;
  readonly status: ConnectionStatus;
}

export interface TransportConfig {
  roomCode: string;
  playerId: string;
  token: string;
  handlers: TransportHandlers;
}
