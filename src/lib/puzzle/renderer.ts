/**
 * Canvas renderer for the jigsaw board.
 *
 * Owns the camera, the draw loop and hit testing. It reads the engine's state
 * directly and never mutates it, so React re-renders are not in the hot path:
 * pointer input mutates the engine, marks the renderer dirty, and the next
 * animation frame paints. React only hears about things a human needs to see in
 * the chrome (progress, players, toasts).
 */

import type { PuzzleGroup } from '@/types/models';
import type { PuzzleEngine } from './engine';
import type { PieceAtlas } from './sprites';
import { rotateQuarter } from './geometry';

export interface Camera {
  /** World point at the centre of the viewport. */
  cx: number;
  cy: number;
  scale: number;
}

export interface RendererTheme {
  boardBg: string;
  slot: string;
  slotLine: string;
  accent: string;
  hint: string;
}

export interface RemoteLock {
  groupId: number;
  color: string;
}

export interface HintState {
  level: 1 | 2 | 3 | 4;
  pieceId: number | null;
  /** Region rect in solved board coordinates. */
  region: { x: number; y: number; w: number; h: number } | null;
  startedAt: number;
}

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  engine: PuzzleEngine;
  atlas: PieceAtlas;
  image: HTMLImageElement | ImageBitmap | null;
  theme: RendererTheme;
  reducedMotion: boolean;
}

const MIN_SCALE = 0.12;
const MAX_SCALE = 3.2;
const PULSE_MS = 260;
const CAMERA_MS = 480;

export class PuzzleRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private engine: PuzzleEngine;
  private atlas: PieceAtlas;
  private image: HTMLImageElement | ImageBitmap | null;
  private theme: RendererTheme;
  private reducedMotion: boolean;

  private dpr = 1;
  private vw = 0;
  private vh = 0;
  private raf = 0;
  private dirty = true;
  private disposed = false;

  camera: Camera = { cx: 0, cy: 0, scale: 1 };

  /** Reference-image ghost drawn inside the solved slot. 0 hides it. */
  ghostOpacity = 0;
  showGrid = false;
  hint: HintState | null = null;
  remoteLocks: RemoteLock[] = [];
  snapPreview: { groupId: number; ox: number; oy: number } | null = null;
  draggingGroup: number | null = null;
  onCameraChange: ((camera: Camera) => void) | null = null;

  private pulses = new Map<number, number>();
  private completionAt = 0;
  private camAnim: {
    from: Camera;
    to: Camera;
    start: number;
    duration: number;
  } | null = null;
  private groupBoundsCache = new Map<number, { key: number; box: Box }>();
  private hitCtx: CanvasRenderingContext2D;

  constructor(opts: RendererOptions) {
    this.canvas = opts.canvas;
    const ctx = opts.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
    this.ctx = ctx;
    this.engine = opts.engine;
    this.atlas = opts.atlas;
    this.image = opts.image;
    this.theme = opts.theme;
    this.reducedMotion = opts.reducedMotion;

    const hit = document.createElement('canvas');
    hit.width = 1;
    hit.height = 1;
    this.hitCtx = hit.getContext('2d')!;

    this.resize();
    this.fit(false);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  setTheme(theme: RendererTheme): void {
    this.theme = theme;
    this.invalidate();
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
  }

  invalidate(): void {
    this.dirty = true;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (this.vw === w && this.vh === h && this.dpr === dpr) return;
    this.vw = w;
    this.vh = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dirty = true;
  }

  get viewport(): { width: number; height: number } {
    return { width: this.vw, height: this.vh };
  }

  /* ---------------------------------------------------------------------- */
  /* Camera                                                                 */
  /* ---------------------------------------------------------------------- */

  worldFromScreen(sx: number, sy: number): { x: number; y: number } {
    const { cx, cy, scale } = this.camera;
    return {
      x: (sx - this.vw / 2) / scale + cx,
      y: (sy - this.vh / 2) / scale + cy,
    };
  }

  screenFromWorld(wx: number, wy: number): { x: number; y: number } {
    const { cx, cy, scale } = this.camera;
    return {
      x: (wx - cx) * scale + this.vw / 2,
      y: (wy - cy) * scale + this.vh / 2,
    };
  }

  /** Zoom keeping the world point under `screen` pinned in place. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.worldFromScreen(sx, sy);
    const scale = clamp(this.camera.scale * factor, MIN_SCALE, MAX_SCALE);
    if (scale === this.camera.scale) return;
    this.camera.scale = scale;
    const after = this.worldFromScreen(sx, sy);
    this.camera.cx += before.x - after.x;
    this.camera.cy += before.y - after.y;
    this.camAnim = null;
    this.clampCamera();
    this.emitCamera();
    this.dirty = true;
  }

  zoomBy(factor: number): void {
    this.zoomAt(this.vw / 2, this.vh / 2, factor);
  }

  panBy(dxScreen: number, dyScreen: number): void {
    this.camera.cx -= dxScreen / this.camera.scale;
    this.camera.cy -= dyScreen / this.camera.scale;
    this.camAnim = null;
    this.clampCamera();
    this.emitCamera();
    this.dirty = true;
  }

  /** Frame the whole board (all scattered pieces). */
  fit(animate = true): void {
    const g = this.engine.geometry;
    const pad = 40;
    const scale = clamp(
      Math.min((this.vw - pad) / g.boardW, (this.vh - pad) / g.boardH),
      MIN_SCALE,
      MAX_SCALE,
    );
    this.moveTo({ cx: g.boardW / 2, cy: g.boardH / 2, scale }, animate);
  }

  /** Frame just the solved area — the "recentre puzzle" action. */
  centerPuzzle(animate = true): void {
    const g = this.engine.geometry;
    const pad = 90;
    const scale = clamp(
      Math.min((this.vw - pad) / g.puzzleW, (this.vh - pad) / g.puzzleH),
      MIN_SCALE,
      MAX_SCALE,
    );
    this.moveTo(
      {
        cx: g.originX + g.puzzleW / 2,
        cy: g.originY + g.puzzleH / 2,
        scale,
      },
      animate,
    );
  }

  /** Smoothly bring a world point into view — used by "Look here". */
  lookAt(wx: number, wy: number, scale?: number): void {
    this.moveTo(
      { cx: wx, cy: wy, scale: scale ?? Math.max(this.camera.scale, 0.6) },
      true,
    );
  }

  moveTo(target: Camera, animate: boolean): void {
    const clamped = this.clampTarget(target);
    if (!animate || this.reducedMotion) {
      this.camera = clamped;
      this.camAnim = null;
      this.emitCamera();
      this.dirty = true;
      return;
    }
    this.camAnim = {
      from: { ...this.camera },
      to: clamped,
      start: performance.now(),
      duration: CAMERA_MS,
    };
    this.dirty = true;
  }

  private clampTarget(cam: Camera): Camera {
    const g = this.engine.geometry;
    const scale = clamp(cam.scale, MIN_SCALE, MAX_SCALE);
    // Allow a generous margin so edge pieces are always reachable.
    const marginX = Math.min(this.vw / scale / 2, g.boardW * 0.5);
    const marginY = Math.min(this.vh / scale / 2, g.boardH * 0.5);
    return {
      scale,
      cx: clamp(cam.cx, -marginX * 0.4, g.boardW + marginX * 0.4),
      cy: clamp(cam.cy, -marginY * 0.4, g.boardH + marginY * 0.4),
    };
  }

  private clampCamera(): void {
    this.camera = this.clampTarget(this.camera);
  }

  private emitCamera(): void {
    this.onCameraChange?.(this.camera);
  }

  /* ---------------------------------------------------------------------- */
  /* Feedback                                                               */
  /* ---------------------------------------------------------------------- */

  pulse(groupId: number): void {
    if (this.reducedMotion) return;
    this.pulses.set(groupId, performance.now());
    this.dirty = true;
  }

  celebrate(): void {
    this.completionAt = performance.now();
    this.dirty = true;
  }

  /* ---------------------------------------------------------------------- */
  /* Hit testing                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Topmost piece under a world point, or null. Walks groups from front to
   * back and tests the real piece outline, so clicking a tab's notch correctly
   * falls through to the piece underneath.
   */
  pickPiece(wx: number, wy: number): { pieceId: number; groupId: number } | null {
    const groups = this.engine.groupList.sort((a, b) => b.z - a.z);
    for (const group of groups) {
      const [sx, sy] = rotateQuarter(wx - group.ox, wy - group.oy, -group.rot);
      const box = this.solvedBounds(group);
      if (sx < box.x0 || sx > box.x1 || sy < box.y0 || sy > box.y1) continue;
      for (const pieceId of group.pieces) {
        const path = this.atlas.paths[pieceId];
        if (!path) continue;
        if (this.hitCtx.isPointInPath(path, sx, sy)) {
          return { pieceId, groupId: group.id };
        }
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------------- */
  /* Draw loop                                                              */
  /* ---------------------------------------------------------------------- */

  private loop(now: number): void {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);

    if (this.camAnim) {
      const t = clamp((now - this.camAnim.start) / this.camAnim.duration, 0, 1);
      const e = easeOutQuint(t);
      const { from, to } = this.camAnim;
      this.camera = {
        cx: from.cx + (to.cx - from.cx) * e,
        cy: from.cy + (to.cy - from.cy) * e,
        // Interpolate zoom geometrically so it feels linear to the eye.
        scale: from.scale * Math.pow(to.scale / from.scale, e),
      };
      this.emitCamera();
      if (t >= 1) this.camAnim = null;
      this.dirty = true;
    }

    if (this.pulses.size) {
      for (const [id, t0] of this.pulses) {
        if (now - t0 > PULSE_MS) this.pulses.delete(id);
      }
      this.dirty = true;
    }
    if (this.hint || this.snapPreview || this.completionAt) this.dirty = true;
    if (this.completionAt && now - this.completionAt > 2600) this.completionAt = 0;

    if (!this.dirty) return;
    this.dirty = false;
    this.draw(now);
  }

  private draw(now: number): void {
    const ctx = this.ctx;
    const g = this.engine.geometry;
    const { cx, cy, scale } = this.camera;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.theme.boardBg;
    ctx.fillRect(0, 0, this.vw, this.vh);

    ctx.translate(this.vw / 2, this.vh / 2);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);

    const view: Box = {
      x0: cx - this.vw / 2 / scale,
      y0: cy - this.vh / 2 / scale,
      x1: cx + this.vw / 2 / scale,
      y1: cy + this.vh / 2 / scale,
    };

    this.drawSlot(ctx, view);
    this.drawHintRegion(ctx, now);
    this.drawPieces(ctx, view, now);
    this.drawSnapPreview(ctx);
    this.drawRemoteLocks(ctx);
    this.drawHintPiece(ctx, now);
    this.drawCompletionSheen(ctx, now);
  }

  /** The empty frame the puzzle belongs in, plus the optional reference ghost. */
  private drawSlot(ctx: CanvasRenderingContext2D, view: Box): void {
    const g = this.engine.geometry;
    const x = g.originX;
    const y = g.originY;
    if (x > view.x1 || y > view.y1 || x + g.puzzleW < view.x0 || y + g.puzzleH < view.y0) {
      return;
    }
    const r = Math.min(g.cellW, g.cellH) * 0.18;
    ctx.save();
    roundRect(ctx, x, y, g.puzzleW, g.puzzleH, r);
    ctx.fillStyle = this.theme.slot;
    ctx.fill();

    if (this.image && this.ghostOpacity > 0.001) {
      ctx.save();
      ctx.clip();
      ctx.globalAlpha = this.ghostOpacity;
      const iw = 'naturalWidth' in this.image ? this.image.naturalWidth : this.image.width;
      const ih = 'naturalHeight' in this.image ? this.image.naturalHeight : this.image.height;
      ctx.drawImage(this.image, 0, 0, iw, ih, x, y, g.puzzleW, g.puzzleH);
      ctx.restore();
    }

    if (this.showGrid) {
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = this.theme.slotLine;
      ctx.lineWidth = 1 / this.camera.scale;
      ctx.beginPath();
      for (let c = 1; c < g.cols; c++) {
        const gx = x + c * g.cellW;
        ctx.moveTo(gx, y);
        ctx.lineTo(gx, y + g.puzzleH);
      }
      for (let rr = 1; rr < g.rows; rr++) {
        const gy = y + rr * g.cellH;
        ctx.moveTo(x, gy);
        ctx.lineTo(x + g.puzzleW, gy);
      }
      ctx.stroke();
      ctx.restore();
    }

    ctx.strokeStyle = this.theme.slotLine;
    ctx.lineWidth = 1.5 / this.camera.scale;
    ctx.stroke();
    ctx.restore();
  }

  private drawPieces(ctx: CanvasRenderingContext2D, view: Box, now: number): void {
    const g = this.engine.geometry;
    const atlas = this.atlas;
    const groups = this.engine.groupList.sort((a, b) => a.z - b.z);
    const spriteW = atlas.spriteW;
    const spriteH = atlas.spriteH;

    for (const group of groups) {
      const box = this.worldBounds(group);
      if (box.x1 < view.x0 || box.x0 > view.x1 || box.y1 < view.y0 || box.y0 > view.y1) {
        continue;
      }

      const pulseT = this.pulses.get(group.id);
      const lifted = this.draggingGroup === group.id;

      ctx.save();
      ctx.translate(group.ox, group.oy);
      if (group.rot) ctx.rotate((group.rot * Math.PI) / 2);

      if (pulseT !== undefined) {
        const t = clamp((now - pulseT) / PULSE_MS, 0, 1);
        const k = 1 + Math.sin(t * Math.PI) * 0.035;
        const c = this.solvedCenter(group);
        ctx.translate(c.x, c.y);
        ctx.scale(k, k);
        ctx.translate(-c.x, -c.y);
      }

      if (lifted && group.pieces.length <= 40) {
        ctx.shadowColor = 'rgba(10, 6, 16, 0.5)';
        ctx.shadowBlur = 24 / this.camera.scale;
        ctx.shadowOffsetY = 10 / this.camera.scale;
      }

      // Transform the viewport into this group's solved space once, then cull
      // individual pieces with plain comparisons.
      const local = rotateBox(
        {
          x0: view.x0 - group.ox,
          y0: view.y0 - group.oy,
          x1: view.x1 - group.ox,
          y1: view.y1 - group.oy,
        },
        -group.rot,
      );

      for (const pieceId of group.pieces) {
        const piece = this.engine.pieces[pieceId];
        const px = piece.solvedX - g.tab;
        const py = piece.solvedY - g.tab;
        if (px > local.x1 || py > local.y1 || px + spriteW < local.x0 || py + spriteH < local.y0) {
          continue;
        }
        const e = atlas.entries[pieceId];
        if (!e) continue;
        ctx.drawImage(atlas.canvases[e.atlas], e.x, e.y, e.w, e.h, px, py, spriteW, spriteH);
      }
      ctx.restore();
    }
  }

  private drawSnapPreview(ctx: CanvasRenderingContext2D): void {
    const preview = this.snapPreview;
    if (!preview) return;
    const group = this.engine.getGroup(preview.groupId);
    if (!group) return;
    ctx.save();
    ctx.translate(preview.ox, preview.oy);
    if (group.rot) ctx.rotate((group.rot * Math.PI) / 2);
    ctx.strokeStyle = this.theme.accent;
    ctx.lineWidth = 2.5 / this.camera.scale;
    ctx.globalAlpha = 0.85;
    ctx.setLineDash([8 / this.camera.scale, 6 / this.camera.scale]);
    const limit = Math.min(group.pieces.length, 24);
    for (let i = 0; i < limit; i++) {
      const path = this.atlas.paths[group.pieces[i]];
      if (path) ctx.stroke(path);
    }
    ctx.restore();
  }

  private drawRemoteLocks(ctx: CanvasRenderingContext2D): void {
    if (!this.remoteLocks.length) return;
    for (const lock of this.remoteLocks) {
      const group = this.engine.getGroup(lock.groupId);
      if (!group) continue;
      ctx.save();
      ctx.translate(group.ox, group.oy);
      if (group.rot) ctx.rotate((group.rot * Math.PI) / 2);
      ctx.strokeStyle = lock.color;
      ctx.lineWidth = 3 / this.camera.scale;
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.95;
      if (group.pieces.length <= 8) {
        for (const pieceId of group.pieces) {
          const path = this.atlas.paths[pieceId];
          if (path) ctx.stroke(path);
        }
      } else {
        const box = this.solvedBounds(group);
        roundRect(ctx, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, 10 / this.camera.scale);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawHintRegion(ctx: CanvasRenderingContext2D, now: number): void {
    const hint = this.hint;
    if (!hint || hint.level < 2 || !hint.region) return;
    const pulse = 0.5 + 0.5 * Math.sin((now - hint.startedAt) / 420);
    const r = hint.region;
    ctx.save();
    ctx.strokeStyle = this.theme.hint;
    ctx.globalAlpha = 0.35 + pulse * 0.4;
    ctx.lineWidth = 3 / this.camera.scale;
    ctx.setLineDash([14 / this.camera.scale, 10 / this.camera.scale]);
    roundRect(ctx, r.x, r.y, r.w, r.h, 14 / this.camera.scale);
    ctx.stroke();
    ctx.globalAlpha = 0.08 + pulse * 0.06;
    ctx.fillStyle = this.theme.hint;
    ctx.fill();
    ctx.restore();
  }

  private drawHintPiece(ctx: CanvasRenderingContext2D, now: number): void {
    const hint = this.hint;
    if (!hint || hint.level < 3 || hint.pieceId === null) return;
    const group = this.engine.groupOf(hint.pieceId);
    if (!group) return;
    const path = this.atlas.paths[hint.pieceId];
    if (!path) return;
    const pulse = 0.5 + 0.5 * Math.sin((now - hint.startedAt) / 300);
    ctx.save();
    ctx.translate(group.ox, group.oy);
    if (group.rot) ctx.rotate((group.rot * Math.PI) / 2);
    ctx.strokeStyle = this.theme.hint;
    ctx.lineWidth = (2.5 + pulse * 2.5) / this.camera.scale;
    ctx.globalAlpha = 0.6 + pulse * 0.4;
    ctx.lineJoin = 'round';
    ctx.stroke(path);
    ctx.restore();
  }

  /** A single slow sheen across the finished picture. Restrained on purpose. */
  private drawCompletionSheen(ctx: CanvasRenderingContext2D, now: number): void {
    if (!this.completionAt) return;
    const t = clamp((now - this.completionAt) / 2600, 0, 1);
    const g = this.engine.geometry;
    const span = g.puzzleW * 1.6;
    const x = g.originX - span * 0.4 + t * span * 1.3;
    const grad = ctx.createLinearGradient(x - span * 0.18, 0, x + span * 0.18, 0);
    const alpha = Math.sin(t * Math.PI) * 0.22;
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, `rgba(255,255,255,${alpha})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save();
    roundRect(ctx, g.originX, g.originY, g.puzzleW, g.puzzleH, Math.min(g.cellW, g.cellH) * 0.18);
    ctx.clip();
    ctx.fillStyle = grad;
    ctx.fillRect(g.originX, g.originY, g.puzzleW, g.puzzleH);
    ctx.restore();
  }

  /* ---------------------------------------------------------------------- */
  /* Bounds helpers                                                         */
  /* ---------------------------------------------------------------------- */

  /** Group bounds in solved space, cached until its membership changes. */
  private solvedBounds(group: PuzzleGroup): Box {
    const cached = this.groupBoundsCache.get(group.id);
    if (cached && cached.key === group.pieces.length) return cached.box;
    const g = this.engine.geometry;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const pieceId of group.pieces) {
      const piece = this.engine.pieces[pieceId];
      x0 = Math.min(x0, piece.solvedX - g.tab);
      y0 = Math.min(y0, piece.solvedY - g.tab);
      x1 = Math.max(x1, piece.solvedX + g.cellW + g.tab);
      y1 = Math.max(y1, piece.solvedY + g.cellH + g.tab);
    }
    const box = { x0, y0, x1, y1 };
    this.groupBoundsCache.set(group.id, { key: group.pieces.length, box });
    return box;
  }

  private worldBounds(group: PuzzleGroup): Box {
    const local = this.solvedBounds(group);
    const rotated = rotateBox(local, group.rot);
    return {
      x0: rotated.x0 + group.ox,
      y0: rotated.y0 + group.oy,
      x1: rotated.x1 + group.ox,
      y1: rotated.y1 + group.oy,
    };
  }

  private solvedCenter(group: PuzzleGroup): { x: number; y: number } {
    const b = this.solvedBounds(group);
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  }

  /** World-space centre of a group — used to aim the camera and place labels. */
  groupCenter(groupId: number): { x: number; y: number } | null {
    const group = this.engine.getGroup(groupId);
    if (!group) return null;
    const b = this.worldBounds(group);
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  }
}

/* -------------------------------------------------------------------------- */

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Rotating an axis-aligned box by a quarter turn yields another one. */
function rotateBox(box: Box, rot: number): Box {
  const [ax, ay] = rotateQuarter(box.x0, box.y0, rot);
  const [bx, by] = rotateQuarter(box.x1, box.y1, rot);
  return {
    x0: Math.min(ax, bx),
    y0: Math.min(ay, by),
    x1: Math.max(ax, bx),
    y1: Math.max(ay, by),
  };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function easeOutQuint(t: number): number {
  return 1 - Math.pow(1 - t, 5);
}

export { MIN_SCALE, MAX_SCALE };
