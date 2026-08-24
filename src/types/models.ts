/**
 * Puzzly domain model.
 *
 * These types are shared by the client, the puzzle engine and the server, so
 * they must stay free of any DOM/React/Node specifics.
 *
 * Design rule (spec §29): room records stay small. Anything heavy — piece
 * geometry, sprite bitmaps, the image itself — is derived from a compact,
 * deterministic seed or fetched from blob storage, never embedded in a room.
 */

/* -------------------------------------------------------------------------- */
/* Games                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every game mode the platform is architected for. Only `jigsaw` is playable
 * today; the others are declared so routing, room creation, results and the
 * registry can be extended without touching the realtime or room layers.
 */
export type GameType =
  | 'jigsaw'
  | 'scramble'
  | 'find-difference'
  | 'memory'
  | 'hidden-object'
  | 'escape';

export interface GameDefinition {
  type: GameType;
  name: string;
  tagline: string;
  /** Short verb phrase used on cards, e.g. "Cut it up and rebuild it". */
  blurb: string;
  icon: GameIcon;
  status: 'live' | 'soon';
  /** Minimum / maximum players the mode supports. */
  players: { min: number; max: number };
}

export type GameIcon = 'jigsaw' | 'scramble' | 'spot' | 'memory' | 'search' | 'key';

/* -------------------------------------------------------------------------- */
/* Images                                                                     */
/* -------------------------------------------------------------------------- */

export type ImageSource = 'upload' | 'stock' | 'original';

export interface ImageAsset {
  id: string;
  source: ImageSource;
  /** Full-size URL used to cut the puzzle. Same-origin for uploads. */
  url: string;
  /** Small URL for cards and previews. Falls back to `url`. */
  thumbUrl: string;
  width: number;
  height: number;
  title: string;
  /** Attribution, required by Unsplash/Pexels terms when those are used. */
  credit?: ImageCredit;
  /** Average colour as a hex string, used for progressive placeholders. */
  color?: string;
  createdAt: number;
}

export interface ImageCredit {
  authorName: string;
  authorUrl?: string;
  providerName: string;
  providerUrl?: string;
}

export interface StockCategory {
  id: string;
  label: string;
  /** Query sent to the provider when this category is selected. */
  query: string;
}

/* -------------------------------------------------------------------------- */
/* Puzzles                                                                    */
/* -------------------------------------------------------------------------- */

export type PieceCount = 25 | 50 | 100 | 250 | 500;

export const PIECE_COUNTS: readonly PieceCount[] = [25, 50, 100, 250, 500];

export interface PuzzleSettings {
  /** Requested piece count. The engine picks the closest grid and reports it. */
  pieceCount: PieceCount;
  /** Pieces start at random 90° rotations and must be turned upright. */
  rotation: boolean;
  /** Hide the reference image unless the player opens the preview. */
  blindMode: boolean;
}

export const DEFAULT_PUZZLE_SETTINGS: PuzzleSettings = {
  pieceCount: 100,
  rotation: false,
  blindMode: false,
};

/**
 * The compact, persisted description of a puzzle. Everything about piece
 * geometry is regenerated deterministically from `seed` + `cols`/`rows`, which
 * is what keeps room records tiny and clients perfectly in agreement.
 */
export interface Puzzle {
  id: string;
  imageId: string;
  image: ImageAsset;
  gameType: GameType;
  /** Actual piece count after fitting the grid to the image aspect ratio. */
  pieceCount: number;
  cols: number;
  rows: number;
  /** Deterministic seed for tab directions, jitter and the initial scatter. */
  seed: number;
  settings: PuzzleSettings;
  difficulty: Difficulty;
  createdAt: number;
  createdBy?: string;
  title: string;
}

export type Difficulty = 'relaxed' | 'easy' | 'medium' | 'hard' | 'brutal';

/* -------------------------------------------------------------------------- */
/* Players & rooms                                                            */
/* -------------------------------------------------------------------------- */

export type PlayerColorId = 1 | 2 | 3 | 4 | 5 | 6;

export interface Player {
  id: string;
  name: string;
  colorId: PlayerColorId;
  /** Emoji avatar, chosen at join time. Cheap identity with zero uploads. */
  avatar: string;
  isHost: boolean;
  ready: boolean;
  connected: boolean;
  joinedAt: number;
  lastSeenAt: number;
  /** Connections this player has completed in the current session. */
  connections: number;
}

export type RoomStatus = 'lobby' | 'playing' | 'complete' | 'abandoned';

export interface RoomSettings extends PuzzleSettings {
  /** Anyone with the code can join. Reserved for a future friends-only mode. */
  visibility: 'private';
  /** Host can start before everyone has pressed ready. */
  hostCanForceStart: boolean;
}

/** Small by design — see spec §29. */
export interface Room {
  id: string;
  code: string;
  hostId: string;
  gameType: GameType;
  puzzleId: string;
  status: RoomStatus;
  settings: RoomSettings;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

/** Room + the data a client needs to render the lobby, in one payload. */
export interface RoomView {
  room: Room;
  puzzle: Puzzle;
  players: Player[];
  session: SessionSummary | null;
}

/* -------------------------------------------------------------------------- */
/* Live puzzle session                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A piece never changes shape, so its record is static after generation. Live
 * position lives on the piece's group, which is what makes group moves O(1).
 */
export interface PuzzlePiece {
  id: number;
  col: number;
  row: number;
  /** Cell origin in solved (board) coordinates. */
  solvedX: number;
  solvedY: number;
  /** Edge specs, shared with neighbours so cuts always match exactly. */
  edges: PieceEdges;
  groupId: number;
}

export interface PieceEdges {
  top: EdgeSpec;
  right: EdgeSpec;
  bottom: EdgeSpec;
  left: EdgeSpec;
}

/**
 * One cut between two cells. `tab: 0` marks a flat outer border edge.
 * Both neighbours reference the identical spec, so the curves are exact
 * complements and there is never a visible seam or gap.
 */
export interface EdgeSpec {
  /** +1 = bulges along the canonical axis (right/down), -1 = the other way. */
  tab: -1 | 0 | 1;
  /** Seeded shape jitter so pieces look hand-cut rather than stamped. */
  j0: number;
  j1: number;
  j2: number;
}

/**
 * A rigid body of one or more connected pieces.
 *
 * World position of a piece = rotate(solvedPos, rot * 90°) + (ox, oy).
 * Rotation is about the solved-space origin, which makes both merging
 * ("do the offsets and rotations match?") and rotating about an arbitrary
 * pivot pure arithmetic — see lib/puzzle/engine.ts.
 */
export interface PuzzleGroup {
  id: number;
  pieces: number[];
  ox: number;
  oy: number;
  /** Quarter turns clockwise: 0 | 1 | 2 | 3. */
  rot: number;
  /** Paint order. Higher is on top. */
  z: number;
}

export interface SessionSummary {
  status: RoomStatus;
  startedAt: number | null;
  completedAt: number | null;
  /** Accumulated play time in ms, excluding pauses. */
  elapsedMs: number;
  connected: number;
  total: number;
  progress: number;
  hintsUsed: number;
}

/**
 * The authoritative live state of a puzzle in progress. Serialisable, and
 * compact enough to send as a single snapshot on join or reconnect.
 */
export interface PuzzleSessionState {
  puzzleId: string;
  seed: number;
  cols: number;
  rows: number;
  /** Solved-image pixel size; the board is larger to give room to scatter. */
  puzzleW: number;
  puzzleH: number;
  boardW: number;
  boardH: number;
  cellW: number;
  cellH: number;
  tab: number;
  groups: PuzzleGroup[];
  /** groupId -> playerId currently dragging it. */
  locks: Record<number, string>;
  nextZ: number;
  status: RoomStatus;
  startedAt: number | null;
  completedAt: number | null;
  hintsUsed: number;
  /** playerId -> connections made, for the (gentle) results split. */
  credit: Record<string, number>;
  /**
   * The undo journal, per player.
   *
   * It has to travel with the session rather than live in the engine: the server
   * rehydrates a fresh engine on every request, so anything held only in memory
   * is gone by the time the next click arrives — and an undo button that quietly
   * does nothing is worse than no undo button. Optional so older stored rooms
   * still load.
   */
  journal?: PuzzleJournalState;
}

/**
 * Serialised undo/redo stacks.
 *
 * `versions` is the group-version counter the engine uses to decide whether an
 * action is still safely reversible — an undo is refused once somebody else has
 * touched the same pieces — so it has to be stored alongside the stacks or every
 * restored action would look stale.
 */
export interface PuzzleJournalState {
  undo: Record<string, JournalActionState[]>;
  redo: Record<string, JournalActionState[]>;
  versions: Array<[number, number]>;
  nextActionId: number;
}

export interface JournalActionState {
  id: number;
  playerId: string;
  ops: JournalOpState[];
  versions: Array<[number, number]>;
}

export type JournalOpState =
  | { kind: 'transform'; g: number; before: JournalTransform; after: JournalTransform }
  | {
      kind: 'merge';
      into: number;
      keeperBefore: JournalTransform;
      keeperAfter: JournalTransform;
      absorbed: Array<{ id: number; pieces: number[]; ox: number; oy: number; rot: number; z: number }>;
    };

export interface JournalTransform {
  ox: number;
  oy: number;
  rot: number;
}

/* -------------------------------------------------------------------------- */
/* Results & challenges                                                       */
/* -------------------------------------------------------------------------- */

export interface SessionResult {
  roomCode: string;
  puzzleId: string;
  puzzleTitle: string;
  imageUrl: string;
  gameType: GameType;
  pieceCount: number;
  durationMs: number;
  completedAt: number;
  hintsUsed: number;
  players: ResultPlayer[];
}

export interface ResultPlayer {
  id: string;
  name: string;
  avatar: string;
  colorId: PlayerColorId;
  connections: number;
  share: number;
}

export interface Challenge {
  id: string;
  puzzleId: string;
  gameType: GameType;
  byName: string;
  byAvatar: string;
  timeMs: number;
  pieceCount: number;
  settings: PuzzleSettings;
  createdAt: number;
  expiresAt: number;
}

/* -------------------------------------------------------------------------- */
/* Local library ("My Puzzles")                                               */
/* -------------------------------------------------------------------------- */

export interface LibraryEntry {
  puzzleId: string;
  title: string;
  thumbUrl: string;
  imageUrl: string;
  pieceCount: number;
  gameType: GameType;
  settings: PuzzleSettings;
  createdAt: number;
  lastPlayedAt: number | null;
  bestTimeMs: number | null;
  timesPlayed: number;
  /** Last known room code, so "resume" can try to rejoin. */
  lastRoomCode?: string;
  /**
   * The asset the puzzle was cut from, kept whole so "play it again" can hand the
   * server back something it will accept. Optional because entries written by an
   * earlier build do not have it — `entryToImage` falls back to the flat fields.
   */
  image?: ImageAsset;
}

/** Anonymous local identity. No accounts required for the MVP. */
export interface LocalIdentity {
  id: string;
  name: string;
  avatar: string;
}
