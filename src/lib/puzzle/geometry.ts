/**
 * Jigsaw geometry.
 *
 * The cut is defined once per *shared edge* and referenced by both neighbouring
 * pieces, so the two outlines are exact complements — pieces interlock with no
 * seam, no gap and no overlap, at any zoom level.
 *
 * Nothing in here touches the DOM: it emits path commands into a sink, which is
 * satisfied by `Path2D` in the browser and can be adapted to SVG or a headless
 * geometry checker on the server.
 */

import type { EdgeSpec, PieceEdges, PuzzlePiece } from '@/types/models';
import { createRng, type Rng } from './rng';

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

/** Tab height as a fraction of the shorter cell dimension. */
const TAB_RATIO = 0.235;
/** Head-room for the bulge overshoot when sizing sprites. */
const TAB_BLEED = 1.14;
/** Snap distance as a fraction of the shorter cell dimension. */
export const SNAP_RATIO = 0.36;
/** How much bigger than the solved image the scatter board is. */
export const BOARD_SCALE = 1.72;
/** Target on-board area of one cell, in board units. Keeps tabs crisp. */
const CELL_TARGET = 88 * 88;
/** Cap on total pre-rendered sprite pixels (~4 bytes each). */
export const MAX_SPRITE_PIXELS = 9_000_000;

/* -------------------------------------------------------------------------- */
/* Path sink                                                                  */
/* -------------------------------------------------------------------------- */

export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number,
  ): void;
  closePath(): void;
}

type Cubic = {
  c1: readonly [number, number];
  c2: readonly [number, number];
  to: readonly [number, number];
};

/* -------------------------------------------------------------------------- */
/* Grid fitting                                                               */
/* -------------------------------------------------------------------------- */

export interface GridFit {
  cols: number;
  rows: number;
  count: number;
}

/**
 * Choose a column/row split that lands near `target` pieces while keeping
 * individual pieces as square as possible for the given image aspect ratio.
 */
export function fitGrid(aspect: number, target: number): GridFit {
  const safeAspect = clamp(aspect || 1, 0.2, 5);
  const ideal = Math.sqrt(target * safeAspect);
  let best: GridFit | null = null;
  let bestScore = Infinity;

  for (let cols = Math.max(2, Math.floor(ideal) - 3); cols <= Math.ceil(ideal) + 3; cols++) {
    for (const rows of [Math.floor(target / cols), Math.round(target / cols), Math.ceil(target / cols)]) {
      if (rows < 2 || cols < 2) continue;
      const count = cols * rows;
      // Prefer the right piece count first, squareness second.
      const countErr = Math.abs(count - target) / target;
      const cellAspect = safeAspect / (cols / rows);
      const squareErr = Math.abs(Math.log(cellAspect));
      const score = countErr * 3 + squareErr;
      if (score < bestScore) {
        bestScore = score;
        best = { cols, rows, count };
      }
    }
  }
  return best ?? { cols: 5, rows: 5, count: 25 };
}

/** Solved-image size in board units, sized so cells stay a comfortable size. */
export function fitPuzzleSize(
  aspect: number,
  count: number,
): { width: number; height: number } {
  const safeAspect = clamp(aspect || 1, 0.2, 5);
  const area = count * CELL_TARGET;
  const height = Math.round(Math.sqrt(area / safeAspect));
  const width = Math.round(height * safeAspect);
  return { width, height };
}

/* -------------------------------------------------------------------------- */
/* Edge generation                                                            */
/* -------------------------------------------------------------------------- */

const FLAT: EdgeSpec = { tab: 0, j0: 0, j1: 0.5, j2: 0 };

function makeEdge(rng: Rng): EdgeSpec {
  return {
    tab: rng.chance(0.5) ? 1 : -1,
    j0: rng.range(-1, 1),
    j1: rng.next(),
    j2: rng.range(-1, 1),
  };
}

export interface PieceGeometry {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  /** Tab curve amplitude, in board units. Pass this to `tracePiece`. */
  tabH: number;
  /** Maximum outward reach of a tab including bulge overshoot. Sizes sprites. */
  tab: number;
  puzzleW: number;
  puzzleH: number;
  boardW: number;
  boardH: number;
  /** Top-left of the solved image inside the board. */
  originX: number;
  originY: number;
  pieces: PuzzlePiece[];
  snapDistance: number;
}

/**
 * Build the full static geometry for a puzzle. Pure function of
 * (seed, cols, rows, image aspect) — every peer derives an identical result.
 */
export function buildGeometry(opts: {
  seed: number;
  cols: number;
  rows: number;
  aspect: number;
}): PieceGeometry {
  const { seed, cols, rows } = opts;
  const { width: puzzleW, height: puzzleH } = fitPuzzleSize(opts.aspect, cols * rows);
  const cellW = puzzleW / cols;
  const cellH = puzzleH / rows;
  const tabH = Math.min(cellW, cellH) * TAB_RATIO;
  const tab = tabH * TAB_BLEED;

  const boardW = Math.round(puzzleW * BOARD_SCALE);
  const boardH = Math.round(puzzleH * BOARD_SCALE);
  const originX = Math.round((boardW - puzzleW) / 2);
  const originY = Math.round((boardH - puzzleH) / 2);

  const rng = createRng(seed ^ 0x9e3779b9);

  // hEdges[r][c] is the cut between (c, r-1) and (c, r); rows 0 and `rows` are
  // the flat outer border. Canonical bulge direction is +y (down).
  const hEdges: EdgeSpec[][] = [];
  for (let r = 0; r <= rows; r++) {
    const line: EdgeSpec[] = [];
    for (let c = 0; c < cols; c++) {
      line.push(r === 0 || r === rows ? FLAT : makeEdge(rng));
    }
    hEdges.push(line);
  }
  // vEdges[c][r] is the cut between (c-1, r) and (c, r). Canonical bulge is +x.
  const vEdges: EdgeSpec[][] = [];
  for (let c = 0; c <= cols; c++) {
    const line: EdgeSpec[] = [];
    for (let r = 0; r < rows; r++) {
      line.push(c === 0 || c === cols ? FLAT : makeEdge(rng));
    }
    vEdges.push(line);
  }

  const pieces: PuzzlePiece[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = r * cols + c;
      const edges: PieceEdges = {
        top: hEdges[r][c],
        bottom: hEdges[r + 1][c],
        left: vEdges[c][r],
        right: vEdges[c + 1][r],
      };
      pieces.push({
        id,
        col: c,
        row: r,
        solvedX: originX + c * cellW,
        solvedY: originY + r * cellH,
        edges,
        groupId: id,
      });
    }
  }

  return {
    cols,
    rows,
    cellW,
    cellH,
    tabH,
    tab,
    puzzleW,
    puzzleH,
    boardW,
    boardH,
    originX,
    originY,
    pieces,
    snapDistance: Math.min(cellW, cellH) * SNAP_RATIO,
  };
}

/* -------------------------------------------------------------------------- */
/* Edge curves                                                                */
/* -------------------------------------------------------------------------- */

const STRAIGHT: readonly Cubic[] = [
  { c1: [1 / 3, 0], c2: [2 / 3, 0], to: [1, 0] },
];

/**
 * One cut as cubic segments in edge-local space: `t` runs 0→1 along the edge,
 * `u` is displacement along the outward normal in units of the tab height.
 *
 * Shape: a narrow neck opening into a wide bulb, plus a barely-there wave on
 * the shoulders so the cut reads as hand-made rather than stamped.
 */
function unitSegments(spec: EdgeSpec): readonly Cubic[] {
  if (spec.tab === 0) return STRAIGHT;

  const h = (0.9 + spec.j1 * 0.2) * spec.tab;
  const shift = spec.j0 * 0.03;
  const skew = spec.j2 * 0.025;
  const nl = 0.395 + shift - skew;
  const nr = 0.605 + shift + skew;
  const w = 0.02 * h; // shoulder wave amplitude

  return [
    { c1: [nl * 0.3, w], c2: [nl * 0.7, -w], to: [nl, 0] },
    { c1: [nl - 0.08, 0.16 * h], c2: [nl - 0.15, 0.58 * h], to: [nl - 0.02, 0.78 * h] },
    { c1: [nl + 0.05, 1.02 * h], c2: [nr - 0.05, 1.02 * h], to: [nr + 0.02, 0.78 * h] },
    { c1: [nr + 0.15, 0.58 * h], c2: [nr + 0.08, 0.16 * h], to: [nr, 0] },
    { c1: [nr + (1 - nr) * 0.3, -w], c2: [nr + (1 - nr) * 0.7, w], to: [1, 0] },
  ];
}

/**
 * Emit one edge into `sink`. The canonical direction is A→B; pass
 * `reverse: true` to walk B→A over the *identical* curve, which is what lets a
 * shared cut be traced from either side without drift.
 */
function emitEdge(
  sink: PathSink,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  nx: number,
  ny: number,
  amp: number,
  spec: EdgeSpec,
  reverse: boolean,
): void {
  const segs = unitSegments(spec);
  const dx = bx - ax;
  const dy = by - ay;
  const mx = (t: number, u: number) => ax + dx * t + nx * u * amp;
  const my = (t: number, u: number) => ay + dy * t + ny * u * amp;

  if (!reverse) {
    for (const s of segs) {
      sink.bezierCurveTo(
        mx(s.c1[0], s.c1[1]),
        my(s.c1[0], s.c1[1]),
        mx(s.c2[0], s.c2[1]),
        my(s.c2[0], s.c2[1]),
        mx(s.to[0], s.to[1]),
        my(s.to[0], s.to[1]),
      );
    }
    return;
  }

  // Backwards: control points swap, and each segment ends at the previous
  // segment's start point.
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    const start = i === 0 ? ([0, 0] as const) : segs[i - 1].to;
    sink.bezierCurveTo(
      mx(s.c2[0], s.c2[1]),
      my(s.c2[0], s.c2[1]),
      mx(s.c1[0], s.c1[1]),
      my(s.c1[0], s.c1[1]),
      mx(start[0], start[1]),
      my(start[0], start[1]),
    );
  }
}

/**
 * Trace a complete piece outline into `sink`, with the piece's *cell* origin at
 * (ox, oy). Tabs extend up to `tabH` beyond the cell on any side.
 */
export function tracePiece(
  sink: PathSink,
  edges: PieceEdges,
  cellW: number,
  cellH: number,
  tabH: number,
  ox: number,
  oy: number,
): void {
  const x0 = ox;
  const y0 = oy;
  const x1 = ox + cellW;
  const y1 = oy + cellH;

  sink.moveTo(x0, y0);
  // Top: canonical left→right, outward normal +y (down).
  emitEdge(sink, x0, y0, x1, y0, 0, 1, tabH, edges.top, false);
  // Right: canonical top→bottom, outward normal +x.
  emitEdge(sink, x1, y0, x1, y1, 1, 0, tabH, edges.right, false);
  // Bottom: shared with the piece below; canonical left→right, normal +y.
  emitEdge(sink, x0, y1, x1, y1, 0, 1, tabH, edges.bottom, true);
  // Left: shared with the piece to the left; canonical top→bottom, normal +x.
  emitEdge(sink, x0, y0, x0, y1, 1, 0, tabH, edges.left, true);
  sink.closePath();
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Solved-space neighbours of a piece: [left, right, top, bottom]. */
export function neighborIds(id: number, cols: number, rows: number): number[] {
  const c = id % cols;
  const r = Math.floor(id / cols);
  const out: number[] = [];
  if (c > 0) out.push(id - 1);
  if (c < cols - 1) out.push(id + 1);
  if (r > 0) out.push(id - cols);
  if (r < rows - 1) out.push(id + cols);
  return out;
}

/** Rotate (x, y) by `rot` quarter turns clockwise about the origin. */
export function rotateQuarter(x: number, y: number, rot: number): [number, number] {
  switch (((rot % 4) + 4) % 4) {
    case 1:
      return [-y, x];
    case 2:
      return [-x, -y];
    case 3:
      return [y, -x];
    default:
      return [x, y];
  }
}
