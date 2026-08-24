/**
 * PuzzleEngine — the authoritative jigsaw state machine.
 *
 * Pure TypeScript: no DOM, no React, no Node. The exact same class runs in the
 * browser (as an optimistic local copy) and on the server (as the source of
 * truth), which is what lets the server validate every move, merge and
 * completion claim instead of believing the client (spec §30).
 *
 * The coordinate trick that makes all of this cheap:
 *
 *   world(piece) = rotate(piece.solvedPos, group.rot) + (group.ox, group.oy)
 *
 * Rotation is always about the board origin, so a group is fully described by
 * three numbers. Two groups interlock **iff** their rot matches and their
 * offsets coincide — which turns snap detection, merging and completion into
 * arithmetic rather than geometry.
 */

import type {
  JournalActionState,
  Puzzle,
  PuzzleGroup,
  PuzzlePiece,
  PuzzleSessionState,
  RoomStatus,
} from '@/types/models';
import type { SplitGroup } from '@/types/events';
import {
  BOARD_SCALE,
  buildGeometry,
  neighborIds,
  rotateQuarter,
  type PieceGeometry,
} from './geometry';
import { createRng } from './rng';

/* -------------------------------------------------------------------------- */
/* Results returned by mutations, so callers can broadcast exactly what changed */
/* -------------------------------------------------------------------------- */

export interface MergeResult {
  into: number;
  from: number[];
  ox: number;
  oy: number;
  rot: number;
  z: number;
  /** Number of new piece-to-piece connections this merge created. */
  connections: number;
}

export interface DropResult {
  moved: { g: number; ox: number; oy: number } | null;
  merges: MergeResult[];
  completed: boolean;
  /** Set when the finished puzzle had to be straightened (rotation mode). */
  straightened: { g: number; ox: number; oy: number; rot: number } | null;
}

export interface RotateResult {
  g: number;
  ox: number;
  oy: number;
  rot: number;
}

export interface HintTarget {
  pieceId: number;
  /** Human-readable region, e.g. "the top-right". */
  region: string;
  col: number;
  row: number;
}

/* -------------------------------------------------------------------------- */
/* Undo journal                                                               */
/* -------------------------------------------------------------------------- */

type JournalOp =
  | { kind: 'transform'; g: number; before: Transform; after: Transform }
  | {
      kind: 'merge';
      into: number;
      keeperBefore: Transform;
      keeperAfter: Transform;
      absorbed: SplitGroup[];
    };

interface Transform {
  ox: number;
  oy: number;
  rot: number;
}

export interface JournalAction {
  id: number;
  playerId: string;
  ops: JournalOp[];
  /** Group versions at commit time; an undo is refused if any has moved on. */
  versions: Array<[number, number]>;
}

/**
 * How many of a player's actions are kept.
 *
 * The journal is persisted with the room, so depth costs bytes — a merge op
 * carries the piece list of everything it absorbed, which on a 500-piece puzzle
 * is not small. Ten is far more than anyone reaches for in practice: undo here
 * means "no, put that back", not an edit history.
 */
const JOURNAL_DEPTH = 10;

/** Stacks → plain objects. Structural copies; `SplitGroup` is already JSON. */
function mapStacks(
  stacks: Map<string, JournalAction[]>,
): Record<string, JournalActionState[]> {
  const out: Record<string, JournalActionState[]> = {};
  for (const [playerId, actions] of stacks) {
    if (actions.length) out[playerId] = actions.slice(-JOURNAL_DEPTH) as JournalActionState[];
  }
  return out;
}

/** Plain object → stack entry, deep enough that nothing aliases the snapshot. */
function reviveAction(action: JournalActionState): JournalAction {
  return {
    id: action.id,
    playerId: action.playerId,
    versions: action.versions.map(([id, v]) => [id, v] as [number, number]),
    ops: action.ops.map((op) =>
      op.kind === 'transform'
        ? { kind: 'transform', g: op.g, before: { ...op.before }, after: { ...op.after } }
        : {
            kind: 'merge',
            into: op.into,
            keeperBefore: { ...op.keeperBefore },
            keeperAfter: { ...op.keeperAfter },
            absorbed: op.absorbed.map((a) => ({ ...a, pieces: [...a.pieces] })),
          },
    ),
  };
}

/* -------------------------------------------------------------------------- */

const REGION_ROW = ['top', 'middle', 'bottom'] as const;
const REGION_COL = ['left', 'centre', 'right'] as const;

export class PuzzleEngine {
  readonly puzzle: Puzzle;
  readonly geometry: PieceGeometry;
  readonly pieces: PuzzlePiece[];

  private groups = new Map<number, PuzzleGroup>();
  /** pieceId -> groupId. Dense array; hot path in snap detection. */
  private owner: number[];
  private version = new Map<number, number>();
  private locks = new Map<number, string>();
  private nextZ = 1;
  private nextGroupId: number;
  private nextActionId = 1;

  status: RoomStatus = 'lobby';
  startedAt: number | null = null;
  completedAt: number | null = null;
  hintsUsed = 0;
  credit = new Map<string, number>();

  private undoStacks = new Map<string, JournalAction[]>();
  private redoStacks = new Map<string, JournalAction[]>();

  private constructor(puzzle: Puzzle, geometry: PieceGeometry) {
    this.puzzle = puzzle;
    this.geometry = geometry;
    this.pieces = geometry.pieces;
    this.owner = new Array(this.pieces.length).fill(0);
    this.nextGroupId = this.pieces.length;
  }

  /* ---------------------------------------------------------------------- */
  /* Construction                                                          */
  /* ---------------------------------------------------------------------- */

  /** Fresh session: generate pieces, then scatter them around the board. */
  static create(puzzle: Puzzle): PuzzleEngine {
    const geometry = geometryFor(puzzle);
    const engine = new PuzzleEngine(puzzle, geometry);
    engine.generatePieces();
    engine.scatter();
    return engine;
  }

  /** Rehydrate from a snapshot — used on join, reconnect and server restart. */
  static fromState(state: PuzzleSessionState, puzzle: Puzzle): PuzzleEngine {
    const geometry = geometryFor(puzzle);
    const engine = new PuzzleEngine(puzzle, geometry);
    engine.groups.clear();
    let maxId = 0;
    for (const g of state.groups) {
      engine.groups.set(g.id, { ...g, pieces: [...g.pieces] });
      for (const p of g.pieces) engine.owner[p] = g.id;
      maxId = Math.max(maxId, g.id);
    }
    for (const piece of engine.pieces) piece.groupId = engine.owner[piece.id];
    engine.nextGroupId = maxId + 1;
    engine.nextZ = state.nextZ;
    engine.locks = new Map(Object.entries(state.locks).map(([k, v]) => [Number(k), v]));
    engine.status = state.status;
    engine.startedAt = state.startedAt;
    engine.completedAt = state.completedAt;
    engine.hintsUsed = state.hintsUsed;
    engine.credit = new Map(Object.entries(state.credit ?? {}));

    const journal = state.journal;
    if (journal) {
      engine.version = new Map(journal.versions);
      engine.nextActionId = journal.nextActionId;
      for (const [playerId, actions] of Object.entries(journal.undo ?? {})) {
        engine.undoStacks.set(playerId, actions.map(reviveAction));
      }
      for (const [playerId, actions] of Object.entries(journal.redo ?? {})) {
        engine.redoStacks.set(playerId, actions.map(reviveAction));
      }
    }
    return engine;
  }

  /** One single-piece group per piece, all at the solved offset. */
  generatePieces(): void {
    this.groups.clear();
    for (const piece of this.pieces) {
      piece.groupId = piece.id;
      this.owner[piece.id] = piece.id;
      this.groups.set(piece.id, {
        id: piece.id,
        pieces: [piece.id],
        ox: 0,
        oy: 0,
        rot: 0,
        z: 0,
      });
    }
    this.nextGroupId = this.pieces.length;
    this.nextZ = 1;
  }

  /**
   * Deterministic scatter into the margin around the solved area, so the empty
   * frame stays visible as an obvious target. Slots are laid out on a loose
   * grid and then jittered, which looks like a tidied pile rather than noise.
   */
  private scatter(): void {
    const g = this.geometry;
    const rng = createRng((this.puzzle.seed ^ 0x51ed270b) >>> 0);
    const rotation = this.puzzle.settings.rotation;

    const step = Math.max(g.cellW, g.cellH) * 1.04;
    const pad = Math.min(g.cellW, g.cellH) * 0.45;
    const slots: Array<[number, number]> = [];
    const inner = {
      x0: g.originX - pad,
      y0: g.originY - pad,
      x1: g.originX + g.puzzleW + pad,
      y1: g.originY + g.puzzleH + pad,
    };
    const half = step / 2;
    for (let y = half; y < g.boardH - half; y += step) {
      for (let x = half; x < g.boardW - half; x += step) {
        if (x > inner.x0 && x < inner.x1 && y > inner.y0 && y < inner.y1) continue;
        slots.push([x, y]);
      }
    }
    // Deterministic Fisher–Yates.
    for (let i = slots.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }

    const order = this.pieces.map((p) => p.id);
    for (let i = order.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [order[i], order[j]] = [order[j], order[i]];
    }

    order.forEach((pieceId, index) => {
      const piece = this.pieces[pieceId];
      const group = this.groups.get(pieceId)!;
      const rot = rotation ? rng.int(0, 3) : 0;
      const slot = slots[index % Math.max(1, slots.length)];
      const jitter = step * 0.16;
      const targetX = slot
        ? slot[0] - g.cellW / 2 + rng.range(-jitter, jitter)
        : rng.range(0, g.boardW - g.cellW);
      const targetY = slot
        ? slot[1] - g.cellH / 2 + rng.range(-jitter, jitter)
        : rng.range(0, g.boardH - g.cellH);
      const [rx, ry] = rotateQuarter(piece.solvedX, piece.solvedY, rot);
      group.rot = rot;
      group.ox = targetX - rx;
      group.oy = targetY - ry;
      group.z = index;
    });
    this.nextZ = order.length;
  }

  /* ---------------------------------------------------------------------- */
  /* Serialisation                                                          */
  /* ---------------------------------------------------------------------- */

  toState(): PuzzleSessionState {
    const g = this.geometry;
    return {
      puzzleId: this.puzzle.id,
      seed: this.puzzle.seed,
      cols: g.cols,
      rows: g.rows,
      puzzleW: g.puzzleW,
      puzzleH: g.puzzleH,
      boardW: g.boardW,
      boardH: g.boardH,
      cellW: g.cellW,
      cellH: g.cellH,
      tab: g.tab,
      groups: [...this.groups.values()].map((grp) => ({ ...grp, pieces: [...grp.pieces] })),
      locks: Object.fromEntries(this.locks),
      nextZ: this.nextZ,
      status: this.status,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      hintsUsed: this.hintsUsed,
      credit: Object.fromEntries(this.credit),
      journal: {
        undo: mapStacks(this.undoStacks),
        redo: mapStacks(this.redoStacks),
        versions: [...this.version.entries()],
        nextActionId: this.nextActionId,
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                               */
  /* ---------------------------------------------------------------------- */

  get groupList(): PuzzleGroup[] {
    return [...this.groups.values()];
  }

  get groupCount(): number {
    return this.groups.size;
  }

  get pieceCount(): number {
    return this.pieces.length;
  }

  getGroup(id: number): PuzzleGroup | undefined {
    return this.groups.get(id);
  }

  groupIdOf(pieceId: number): number {
    return this.owner[pieceId];
  }

  groupOf(pieceId: number): PuzzleGroup | undefined {
    return this.groups.get(this.owner[pieceId]);
  }

  /** World position of a piece's cell origin, plus its rotation. */
  pieceWorld(pieceId: number): { x: number; y: number; rot: number } {
    const piece = this.pieces[pieceId];
    const group = this.groups.get(this.owner[pieceId])!;
    const [rx, ry] = rotateQuarter(piece.solvedX, piece.solvedY, group.rot);
    return { x: group.ox + rx, y: group.oy + ry, rot: group.rot };
  }

  lockHolder(groupId: number): string | undefined {
    return this.locks.get(groupId);
  }

  get lockEntries(): Array<[number, string]> {
    return [...this.locks.entries()];
  }

  /** Connections made / connections needed. 0 → 1. */
  calculateProgress(): number {
    const total = this.pieces.length;
    if (total <= 1) return 1;
    return (total - this.groups.size) / (total - 1);
  }

  /** Groups of 2+ pieces — the "sections" shown on the results screen. */
  sectionCount(): number {
    let n = 0;
    for (const g of this.groups.values()) if (g.pieces.length > 1) n++;
    return n;
  }

  isComplete(): boolean {
    return this.groups.size === 1;
  }

  elapsedMs(now: number): number {
    if (!this.startedAt) return 0;
    return Math.max(0, (this.completedAt ?? now) - this.startedAt);
  }

  /* ---------------------------------------------------------------------- */
  /* Locking — one player per group at a time (spec §12)                   */
  /* ---------------------------------------------------------------------- */

  grab(groupId: number, playerId: string): number | null {
    const group = this.groups.get(groupId);
    if (!group) return null;
    const holder = this.locks.get(groupId);
    if (holder && holder !== playerId) return null;
    this.locks.set(groupId, playerId);
    group.z = this.nextZ++;
    return group.z;
  }

  release(groupId: number, playerId: string): boolean {
    if (this.locks.get(groupId) !== playerId) return false;
    this.locks.delete(groupId);
    return true;
  }

  /** Drop every lock held by a player — used when they disconnect. */
  releaseAll(playerId: string): number[] {
    const freed: number[] = [];
    for (const [groupId, holder] of this.locks) {
      if (holder === playerId) {
        this.locks.delete(groupId);
        freed.push(groupId);
      }
    }
    return freed;
  }

  /* ---------------------------------------------------------------------- */
  /* Mutations                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Move a group. `playerId` is checked against the lock when provided, so the
   * server can reject moves from a player who does not hold the piece.
   */
  movePiece(groupId: number, ox: number, oy: number, playerId?: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    if (playerId) {
      const holder = this.locks.get(groupId);
      if (holder && holder !== playerId) return false;
    }
    // Keep groups reachable: clamp their bounding box to the board with slack.
    const limits = this.offsetLimits(group);
    group.ox = Math.min(Math.max(ox, limits.minOx), limits.maxOx);
    group.oy = Math.min(Math.max(oy, limits.minOy), limits.maxOy);
    this.bump(groupId);
    return true;
  }

  /**
   * Rotate a group a quarter turn, keeping `pivot` (in world coords) fixed so
   * the piece turns under the cursor instead of flying across the board.
   */
  rotatePiece(
    groupId: number,
    dir: 1 | -1,
    pivot?: { x: number; y: number },
    playerId?: string,
  ): RotateResult | null {
    const group = this.groups.get(groupId);
    if (!group) return null;
    if (playerId) {
      const holder = this.locks.get(groupId);
      if (holder && holder !== playerId) return null;
    }
    const rot = (((group.rot + dir) % 4) + 4) % 4;
    if (pivot) {
      // Solved-space point currently under the pivot.
      const [sx, sy] = rotateQuarter(pivot.x - group.ox, pivot.y - group.oy, -group.rot);
      const [nx, ny] = rotateQuarter(sx, sy, rot);
      group.ox = pivot.x - nx;
      group.oy = pivot.y - ny;
    }
    group.rot = rot;
    this.bump(groupId);
    return { g: groupId, ox: group.ox, oy: group.oy, rot };
  }

  /**
   * Nearest legal connection for a group, or null. Two groups fit when their
   * rotations match and their offsets coincide within the snap distance.
   */
  snapPieces(groupId: number): { other: number; dx: number; dy: number; dist: number } | null {
    const group = this.groups.get(groupId);
    if (!group) return null;
    const { cols, rows, snapDistance } = this.geometry;
    let best: { other: number; dx: number; dy: number; dist: number } | null = null;

    for (const pieceId of group.pieces) {
      for (const nId of neighborIds(pieceId, cols, rows)) {
        const otherId = this.owner[nId];
        if (otherId === groupId) continue;
        const other = this.groups.get(otherId);
        if (!other || other.rot !== group.rot) continue;
        const dx = other.ox - group.ox;
        const dy = other.oy - group.oy;
        const dist = Math.hypot(dx, dy);
        if (dist <= snapDistance && (!best || dist < best.dist)) {
          best = { other: otherId, dx, dy, dist };
        }
      }
    }
    return best;
  }

  /** Absorb `fromIds` into `intoId`. Callers must align offsets first. */
  mergeGroups(intoId: number, fromIds: number[]): MergeResult | null {
    const keeper = this.groups.get(intoId);
    if (!keeper) return null;
    let connections = 0;
    const absorbed: number[] = [];

    for (const fromId of fromIds) {
      if (fromId === intoId) continue;
      const donor = this.groups.get(fromId);
      if (!donor) continue;
      connections += this.countConnections(keeper.pieces, donor.pieces);
      for (const pieceId of donor.pieces) {
        this.owner[pieceId] = intoId;
        this.pieces[pieceId].groupId = intoId;
        keeper.pieces.push(pieceId);
      }
      this.groups.delete(fromId);
      this.locks.delete(fromId);
      this.version.delete(fromId);
      absorbed.push(fromId);
    }
    keeper.z = this.nextZ++;
    this.bump(intoId);
    return {
      into: intoId,
      from: absorbed,
      ox: keeper.ox,
      oy: keeper.oy,
      rot: keeper.rot,
      z: keeper.z,
      connections,
    };
  }

  /**
   * Finish a drag: settle the group, then cascade-merge every connection the
   * new position created. Returns everything that changed for broadcasting.
   */
  drop(
    groupId: number,
    ox: number,
    oy: number,
    playerId: string,
    now: number,
  ): DropResult {
    const group = this.groups.get(groupId);
    if (!group) {
      return { moved: null, merges: [], completed: false, straightened: null };
    }
    const before: Transform = { ox: group.ox, oy: group.oy, rot: group.rot };
    this.movePiece(groupId, ox, oy, playerId);

    const ops: JournalOp[] = [];
    const merges: MergeResult[] = [];
    let currentId = groupId;

    // Cascade: a merge can bring the new, larger group into range of others.
    for (let guard = 0; guard < this.pieces.length; guard++) {
      const current = this.groups.get(currentId);
      if (!current) break;
      const snap = this.snapPieces(currentId);
      if (!snap) break;
      const other = this.groups.get(snap.other);
      if (!other) break;

      // The stationary group defines the resting place.
      const targetOx = other.ox;
      const targetOy = other.oy;
      const keeperId = current.pieces.length >= other.pieces.length ? currentId : snap.other;
      const donorId = keeperId === currentId ? snap.other : currentId;
      const keeper = this.groups.get(keeperId)!;
      const donor = this.groups.get(donorId)!;

      const keeperBefore: Transform = { ox: keeper.ox, oy: keeper.oy, rot: keeper.rot };
      const absorbedSnapshot: SplitGroup[] = [
        { id: donor.id, pieces: [...donor.pieces], ox: donor.ox, oy: donor.oy, rot: donor.rot, z: donor.z },
      ];

      keeper.ox = targetOx;
      keeper.oy = targetOy;
      const result = this.mergeGroups(keeperId, [donorId]);
      if (!result) break;

      ops.push({
        kind: 'merge',
        into: keeperId,
        keeperBefore,
        keeperAfter: { ox: keeper.ox, oy: keeper.oy, rot: keeper.rot },
        absorbed: absorbedSnapshot,
      });
      merges.push(result);
      this.credit.set(playerId, (this.credit.get(playerId) ?? 0) + result.connections);
      currentId = keeperId;
    }

    const settled = this.groups.get(currentId);
    const movedGroup = this.groups.get(groupId) ?? settled;
    const moved =
      movedGroup && (movedGroup.ox !== before.ox || movedGroup.oy !== before.oy)
        ? { g: movedGroup.id, ox: movedGroup.ox, oy: movedGroup.oy }
        : merges.length === 0 && settled
          ? { g: settled.id, ox: settled.ox, oy: settled.oy }
          : null;

    if (merges.length === 0) {
      ops.push({
        kind: 'transform',
        g: groupId,
        before,
        after: { ox: group.ox, oy: group.oy, rot: group.rot },
      });
    } else {
      ops.unshift({
        kind: 'transform',
        g: groupId,
        before,
        after: { ox, oy, rot: before.rot },
      });
    }

    let straightened: DropResult['straightened'] = null;
    let completed = false;
    if (this.isComplete() && !this.completedAt) {
      const last = this.groupList[0];
      if (last.rot !== 0) {
        // Straighten a finished-but-rotated puzzle so the reveal looks right.
        const centre = {
          x: this.geometry.boardW / 2,
          y: this.geometry.boardH / 2,
        };
        let guard = 0;
        while (last.rot !== 0 && guard++ < 4) {
          this.rotatePiece(last.id, 1, centre);
        }
        straightened = { g: last.id, ox: last.ox, oy: last.oy, rot: last.rot };
      }
      this.completedAt = now;
      this.status = 'complete';
      completed = true;
    }

    this.commit(playerId, ops);
    return { moved, merges, completed, straightened };
  }

  /* ---------------------------------------------------------------------- */
  /* Undo / redo                                                            */
  /* ---------------------------------------------------------------------- */

  private bump(groupId: number): void {
    this.version.set(groupId, (this.version.get(groupId) ?? 0) + 1);
  }

  private versionsFor(ops: JournalOp[]): Array<[number, number]> {
    const ids = new Set<number>();
    for (const op of ops) {
      if (op.kind === 'transform') ids.add(op.g);
      else {
        ids.add(op.into);
        for (const a of op.absorbed) ids.add(a.id);
      }
    }
    return [...ids].map((id) => [id, this.version.get(id) ?? 0] as [number, number]);
  }

  private commit(playerId: string, ops: JournalOp[]): void {
    if (!ops.length) return;
    const stack = this.undoStacks.get(playerId) ?? [];
    stack.push({
      id: this.nextActionId++,
      playerId,
      ops,
      versions: this.versionsFor(ops),
    });
    while (stack.length > JOURNAL_DEPTH) stack.shift();
    this.undoStacks.set(playerId, stack);
    this.redoStacks.set(playerId, []);
  }

  canUndo(playerId: string): boolean {
    return (this.undoStacks.get(playerId)?.length ?? 0) > 0;
  }

  canRedo(playerId: string): boolean {
    return (this.redoStacks.get(playerId)?.length ?? 0) > 0;
  }

  /**
   * Revert this player's last action.
   *
   * Refused when any group involved has changed since — safer than trying to
   * rebase an undo across someone else's move, and easy to explain in the UI.
   */
  undo(playerId: string): UndoResult | null {
    const stack = this.undoStacks.get(playerId);
    if (!stack?.length) return null;
    const action = stack[stack.length - 1];
    if (!this.versionsMatch(action)) {
      stack.pop();
      return { blocked: true, transforms: [], splits: [], merges: [] };
    }
    stack.pop();
    const result = this.applyInverse(action.ops);
    const redo = this.redoStacks.get(playerId) ?? [];
    redo.push({ ...action, versions: this.versionsFor(action.ops) });
    this.redoStacks.set(playerId, redo);
    return result;
  }

  redo(playerId: string): UndoResult | null {
    const stack = this.redoStacks.get(playerId);
    if (!stack?.length) return null;
    const action = stack[stack.length - 1];
    if (!this.versionsMatch(action)) {
      stack.pop();
      return { blocked: true, transforms: [], splits: [], merges: [] };
    }
    stack.pop();
    const result = this.applyForward(action.ops);
    const undo = this.undoStacks.get(playerId) ?? [];
    undo.push({ ...action, versions: this.versionsFor(action.ops) });
    this.undoStacks.set(playerId, undo);
    return result;
  }

  private versionsMatch(action: JournalAction): boolean {
    for (const [id, v] of action.versions) {
      if ((this.version.get(id) ?? 0) !== v) return false;
      if (!this.groups.has(id)) {
        // A merged-away group is fine only if it is the one we plan to restore.
        const restores = action.ops.some(
          (op) => op.kind === 'merge' && op.absorbed.some((a) => a.id === id),
        );
        if (!restores) return false;
      }
    }
    return true;
  }

  private applyInverse(ops: JournalOp[]): UndoResult {
    const transforms: RotateResult[] = [];
    const splits: Array<{ into: number; groups: SplitGroup[] }> = [];
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      if (op.kind === 'transform') {
        const group = this.groups.get(op.g);
        if (!group) continue;
        group.ox = op.before.ox;
        group.oy = op.before.oy;
        group.rot = op.before.rot;
        this.bump(op.g);
        transforms.push({ g: op.g, ox: group.ox, oy: group.oy, rot: group.rot });
      } else {
        const keeper = this.groups.get(op.into);
        if (!keeper) continue;
        const restored: SplitGroup[] = [];
        for (const snap of op.absorbed) {
          const set = new Set(snap.pieces);
          keeper.pieces = keeper.pieces.filter((p) => !set.has(p));
          const group: PuzzleGroup = {
            id: snap.id,
            pieces: [...snap.pieces],
            ox: snap.ox,
            oy: snap.oy,
            rot: snap.rot,
            z: snap.z,
          };
          this.groups.set(snap.id, group);
          for (const p of snap.pieces) {
            this.owner[p] = snap.id;
            this.pieces[p].groupId = snap.id;
          }
          this.bump(snap.id);
          restored.push({ ...group, pieces: [...group.pieces] });
        }
        keeper.ox = op.keeperBefore.ox;
        keeper.oy = op.keeperBefore.oy;
        keeper.rot = op.keeperBefore.rot;
        this.bump(op.into);
        restored.unshift({
          id: keeper.id,
          pieces: [...keeper.pieces],
          ox: keeper.ox,
          oy: keeper.oy,
          rot: keeper.rot,
          z: keeper.z,
        });
        splits.push({ into: op.into, groups: restored });
      }
    }
    if (this.groups.size > 1) {
      this.completedAt = null;
      if (this.status === 'complete') this.status = 'playing';
    }
    return { blocked: false, transforms, splits, merges: [] };
  }

  private applyForward(ops: JournalOp[]): UndoResult {
    const transforms: RotateResult[] = [];
    const merges: MergeResult[] = [];
    for (const op of ops) {
      if (op.kind === 'transform') {
        const group = this.groups.get(op.g);
        if (!group) continue;
        group.ox = op.after.ox;
        group.oy = op.after.oy;
        group.rot = op.after.rot;
        this.bump(op.g);
        transforms.push({ g: op.g, ox: group.ox, oy: group.oy, rot: group.rot });
      } else {
        const keeper = this.groups.get(op.into);
        if (!keeper) continue;
        keeper.ox = op.keeperAfter.ox;
        keeper.oy = op.keeperAfter.oy;
        keeper.rot = op.keeperAfter.rot;
        const result = this.mergeGroups(
          op.into,
          op.absorbed.map((a) => a.id),
        );
        if (result) merges.push(result);
      }
    }
    return { blocked: false, transforms, splits: [], merges };
  }

  /** Apply a split broadcast from the server (remote undo). */
  applySplit(into: number, groups: SplitGroup[]): void {
    const keeper = this.groups.get(into);
    for (const snap of groups) {
      if (snap.id === into && keeper) {
        keeper.pieces = [...snap.pieces];
        keeper.ox = snap.ox;
        keeper.oy = snap.oy;
        keeper.rot = snap.rot;
        keeper.z = snap.z;
        for (const p of snap.pieces) {
          this.owner[p] = into;
          this.pieces[p].groupId = into;
        }
        continue;
      }
      const group: PuzzleGroup = {
        id: snap.id,
        pieces: [...snap.pieces],
        ox: snap.ox,
        oy: snap.oy,
        rot: snap.rot,
        z: snap.z,
      };
      this.groups.set(snap.id, group);
      for (const p of snap.pieces) {
        this.owner[p] = snap.id;
        this.pieces[p].groupId = snap.id;
      }
      this.nextGroupId = Math.max(this.nextGroupId, snap.id + 1);
    }
    if (this.groups.size > 1) {
      this.completedAt = null;
      if (this.status === 'complete') this.status = 'playing';
    }
  }

  /** Apply a merge broadcast from the server (remote move). */
  applyMerge(into: number, from: number[], ox: number, oy: number, rot: number, z: number): void {
    const keeper = this.groups.get(into);
    if (!keeper) return;
    keeper.ox = ox;
    keeper.oy = oy;
    keeper.rot = rot;
    keeper.z = z;
    this.mergeGroups(into, from);
    keeper.z = z;
    this.nextZ = Math.max(this.nextZ, z + 1);
  }

  applyTransform(groupId: number, ox: number, oy: number, rot?: number): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    group.ox = ox;
    group.oy = oy;
    if (rot !== undefined) group.rot = rot;
  }

  applyLock(groupId: number, playerId: string | null, z?: number): void {
    if (playerId) this.locks.set(groupId, playerId);
    else this.locks.delete(groupId);
    if (z !== undefined) {
      const group = this.groups.get(groupId);
      if (group) group.z = z;
      this.nextZ = Math.max(this.nextZ, z + 1);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Hints (spec §16)                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Pick a genuinely useful next piece: prefer one that touches an existing
   * cluster, so the hint moves the puzzle forward rather than pointing at a
   * random stray.
   */
  pickHintTarget(): HintTarget | null {
    if (this.isComplete()) return null;
    const { cols, rows } = this.geometry;
    let best: { pieceId: number; score: number } | null = null;

    for (const piece of this.pieces) {
      const groupId = this.owner[piece.id];
      const group = this.groups.get(groupId)!;
      let touching = 0;
      let openNeighbours = 0;
      for (const nId of neighborIds(piece.id, cols, rows)) {
        const otherId = this.owner[nId];
        if (otherId === groupId) continue;
        openNeighbours++;
        const other = this.groups.get(otherId);
        if (other) touching = Math.max(touching, other.pieces.length);
      }
      if (!openNeighbours) continue;
      // Small strays that neighbour a big cluster score highest.
      const score = touching * 4 - group.pieces.length * 2 + openNeighbours;
      if (!best || score > best.score) best = { pieceId: piece.id, score };
    }
    if (!best) return null;

    const piece = this.pieces[best.pieceId];
    const band = (v: number, n: number) => (v < n / 3 ? 0 : v < (2 * n) / 3 ? 1 : 2);
    const rowWord = REGION_ROW[band(piece.row, rows)];
    const colWord = REGION_COL[band(piece.col, cols)];
    const region =
      rowWord === 'middle' && colWord === 'centre'
        ? 'the middle'
        : rowWord === 'middle'
          ? `the ${colWord} edge`
          : colWord === 'centre'
            ? `the ${rowWord} centre`
            : `the ${rowWord}-${colWord}`;

    return { pieceId: best.pieceId, region, col: piece.col, row: piece.row };
  }

  /**
   * True while this piece still has a neighbour it has not been joined to —
   * i.e. a hint pointing at it is still worth showing.
   */
  isPlaceable(pieceId: number): boolean {
    if (pieceId < 0 || pieceId >= this.pieces.length) return false;
    const groupId = this.owner[pieceId];
    const { cols, rows } = this.geometry;
    for (const nId of neighborIds(pieceId, cols, rows)) {
      if (this.owner[nId] !== groupId) return true;
    }
    return false;
  }

  /**
   * Hint level 4 — actually place the piece, by snapping its group onto a
   * neighbouring group and merging.
   *
   * The legal offset window differs per group (see `offsetLimits`), so a cluster
   * can come to rest somewhere a stray piece is not allowed to follow — shoved
   * against the right edge of the board, say. A neighbour we can reach without
   * disturbing anything is therefore preferred, and only if none is reachable do
   * the two meet at an offset both are allowed to occupy. That is what a person
   * does by hand; the alternative is a hint that promises to place the piece and
   * then quietly does nothing.
   */
  placeHint(pieceId: number, playerId: string, now: number): DropResult | null {
    const groupId = this.owner[pieceId];
    const group = this.groups.get(groupId);
    if (!group) return null;
    const { cols, rows } = this.geometry;

    const targets: PuzzleGroup[] = [];
    for (const nId of neighborIds(pieceId, cols, rows)) {
      const otherId = this.owner[nId];
      if (otherId === groupId) continue;
      const other = this.groups.get(otherId);
      if (other && !targets.includes(other)) targets.push(other);
    }
    if (!targets.length) return null;

    // Rotation is set per candidate because the bounding box — and so the
    // window — turns with it. Restored if nothing works, since an unbroadcast
    // rotation would desync every other client.
    const rot0 = group.rot;
    const inside = (
      limits: { minOx: number; maxOx: number; minOy: number; maxOy: number },
      ox: number,
      oy: number,
    ) => ox >= limits.minOx && ox <= limits.maxOx && oy >= limits.minOy && oy <= limits.maxOy;

    for (const target of targets) {
      group.rot = target.rot;
      if (inside(this.offsetLimits(group), target.ox, target.oy)) {
        this.bump(groupId);
        return this.drop(groupId, target.ox, target.oy, playerId, now);
      }
    }

    for (const target of targets) {
      // A group somebody else is holding is left where it is — their drag wins.
      const holder = this.locks.get(target.id);
      if (holder && holder !== playerId) continue;

      group.rot = target.rot;
      const mine = this.offsetLimits(group);
      const theirs = this.offsetLimits(target);
      const minOx = Math.max(mine.minOx, theirs.minOx);
      const maxOx = Math.min(mine.maxOx, theirs.maxOx);
      const minOy = Math.max(mine.minOy, theirs.minOy);
      const maxOy = Math.min(mine.maxOy, theirs.maxOy);
      if (minOx > maxOx || minOy > maxOy) continue;

      // Nearest mutually legal spot, so the cluster moves as little as possible.
      const ox = Math.min(Math.max(target.ox, minOx), maxOx);
      const oy = Math.min(Math.max(target.oy, minOy), maxOy);
      this.movePiece(target.id, ox, oy, playerId);
      this.bump(groupId);
      // The merge event carries the keeper's resting place, so the target's new
      // position reaches the other clients with the merge rather than silently.
      return this.drop(groupId, ox, oy, playerId, now);
    }

    group.rot = rot0;
    return null;
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * The legal window for a group's offset: far enough onto the board that the
   * group stays grabbable, with slack so edge pieces can still be parked outside
   * the frame. It depends on which pieces the group holds, so two groups do not
   * necessarily share a window — which is why `placeHint` has to check.
   */
  private offsetLimits(group: PuzzleGroup): {
    minOx: number;
    maxOx: number;
    minOy: number;
    maxOy: number;
  } {
    const g = this.geometry;
    const bounds = this.groupBounds(group);
    const slack = Math.max(g.cellW, g.cellH) * 1.5;
    return {
      minOx: -bounds.minX - slack,
      maxOx: g.boardW - bounds.maxX + slack,
      minOy: -bounds.minY - slack,
      maxOy: g.boardH - bounds.maxY + slack,
    };
  }

  private countConnections(a: number[], b: number[]): number {
    const { cols, rows } = this.geometry;
    const set = new Set(b);
    let n = 0;
    for (const pieceId of a) {
      for (const nId of neighborIds(pieceId, cols, rows)) {
        if (set.has(nId)) n++;
      }
    }
    return n;
  }

  /** Bounding box of a group in world coords, relative to its offset. */
  private groupBounds(group: PuzzleGroup): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } {
    const { cellW, cellH } = this.geometry;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pieceId of group.pieces) {
      const piece = this.pieces[pieceId];
      const corners: Array<[number, number]> = [
        [piece.solvedX, piece.solvedY],
        [piece.solvedX + cellW, piece.solvedY],
        [piece.solvedX, piece.solvedY + cellH],
        [piece.solvedX + cellW, piece.solvedY + cellH],
      ];
      for (const [cx, cy] of corners) {
        const [rx, ry] = rotateQuarter(cx, cy, group.rot);
        if (rx < minX) minX = rx;
        if (ry < minY) minY = ry;
        if (rx > maxX) maxX = rx;
        if (ry > maxY) maxY = ry;
      }
    }
    return { minX, minY, maxX, maxY };
  }
}

export interface UndoResult {
  blocked: boolean;
  transforms: RotateResult[];
  splits: Array<{ into: number; groups: SplitGroup[] }>;
  merges: MergeResult[];
}

/* -------------------------------------------------------------------------- */

function geometryFor(puzzle: Puzzle): PieceGeometry {
  const aspect =
    puzzle.image.width && puzzle.image.height
      ? puzzle.image.width / puzzle.image.height
      : 4 / 3;
  return buildGeometry({
    seed: puzzle.seed,
    cols: puzzle.cols,
    rows: puzzle.rows,
    aspect,
  });
}

export { BOARD_SCALE };
