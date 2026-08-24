/**
 * Piece sprite atlas.
 *
 * Each piece is rasterised **once** into a packed atlas texture, complete with
 * its bevel and edge shading. After that, drawing a frame is one `drawImage`
 * per visible piece — cheap enough that 500 pieces stay at 60fps, and far
 * cheaper than clipping a bezier path per piece per frame.
 *
 * Browser-only (needs canvas). The engine and the server never import this.
 */

import type { PuzzlePiece } from '@/types/models';
import { MAX_SPRITE_PIXELS, tracePiece, type PieceGeometry } from './geometry';

const ATLAS_MAX = 2048;

export interface SpriteEntry {
  atlas: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PieceAtlas {
  canvases: HTMLCanvasElement[];
  entries: SpriteEntry[];
  /** Hit-test outlines, in solved board coordinates. */
  paths: Path2D[];
  /** Device pixels per board unit used when rasterising. */
  scale: number;
  /** Sprite footprint in board units (cell plus tab bleed on all sides). */
  spriteW: number;
  spriteH: number;
  dispose(): void;
}

export interface BuildProgress {
  done: number;
  total: number;
}

/**
 * Build the atlas, yielding to the event loop between batches so the "cutting
 * pieces" progress bar can actually paint.
 */
export async function buildPieceAtlas(
  image: HTMLImageElement | ImageBitmap,
  geometry: PieceGeometry,
  opts: { onProgress?: (p: BuildProgress) => void; signal?: AbortSignal } = {},
): Promise<PieceAtlas> {
  const { cellW, cellH, tab, tabH, pieces, originX, originY, puzzleW, puzzleH } = geometry;

  const spriteW = cellW + tab * 2;
  const spriteH = cellH + tab * 2;

  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  let scale = Math.min(Math.max(dpr, 1), 2);
  const budget = pieces.length * spriteW * spriteH;
  if (budget * scale * scale > MAX_SPRITE_PIXELS) {
    scale = Math.sqrt(MAX_SPRITE_PIXELS / budget);
  }
  scale = Math.max(0.55, Math.min(scale, 2));

  const cellPxW = Math.ceil(spriteW * scale);
  const cellPxH = Math.ceil(spriteH * scale);
  const perRow = Math.max(1, Math.floor(ATLAS_MAX / cellPxW));
  const perCol = Math.max(1, Math.floor(ATLAS_MAX / cellPxH));
  const perAtlas = perRow * perCol;
  const atlasCount = Math.ceil(pieces.length / perAtlas);

  const canvases: HTMLCanvasElement[] = [];
  const contexts: CanvasRenderingContext2D[] = [];
  for (let i = 0; i < atlasCount; i++) {
    const remaining = pieces.length - i * perAtlas;
    const rowsNeeded = Math.min(perCol, Math.ceil(remaining / perRow));
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(ATLAS_MAX, perRow * cellPxW);
    canvas.height = rowsNeeded * cellPxH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    canvases.push(canvas);
    contexts.push(ctx);
  }

  const entries: SpriteEntry[] = new Array(pieces.length);
  const paths: Path2D[] = new Array(pieces.length);

  const batch = Math.max(8, Math.min(48, Math.ceil(pieces.length / 24)));
  for (let i = 0; i < pieces.length; i++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const piece = pieces[i];
    const atlasIndex = Math.floor(i / perAtlas);
    const slot = i % perAtlas;
    const col = slot % perRow;
    const row = Math.floor(slot / perRow);
    const x = col * cellPxW;
    const y = row * cellPxH;

    // Hit-test path lives in solved board coordinates.
    const path = new Path2D();
    tracePiece(path, piece.edges, cellW, cellH, tabH, piece.solvedX, piece.solvedY);
    paths[piece.id] = path;

    drawPieceSprite(contexts[atlasIndex], {
      image,
      piece,
      path,
      x,
      y,
      scale,
      cellW,
      cellH,
      tab,
      originX,
      originY,
      puzzleW,
      puzzleH,
    });

    entries[piece.id] = { atlas: atlasIndex, x, y, w: cellPxW, h: cellPxH };

    if (i % batch === batch - 1) {
      opts.onProgress?.({ done: i + 1, total: pieces.length });
      await nextFrame();
    }
  }
  opts.onProgress?.({ done: pieces.length, total: pieces.length });

  return {
    canvases,
    entries,
    paths,
    scale,
    spriteW,
    spriteH,
    dispose() {
      for (const canvas of canvases) {
        canvas.width = 0;
        canvas.height = 0;
      }
      canvases.length = 0;
    },
  };
}

interface DrawArgs {
  image: HTMLImageElement | ImageBitmap;
  piece: PuzzlePiece;
  path: Path2D;
  x: number;
  y: number;
  scale: number;
  cellW: number;
  cellH: number;
  tab: number;
  originX: number;
  originY: number;
  puzzleW: number;
  puzzleH: number;
}

/**
 * Paint one piece into its atlas slot: clipped image, then a two-tone bevel so
 * the piece reads as a physical object with thickness.
 */
function drawPieceSprite(ctx: CanvasRenderingContext2D, a: DrawArgs): void {
  const { piece, path, scale, tab } = a;
  const imgW = 'naturalWidth' in a.image ? a.image.naturalWidth : a.image.width;
  const imgH = 'naturalHeight' in a.image ? a.image.naturalHeight : a.image.height;

  ctx.save();
  // Slot -> board units. After this we can work directly in solved coordinates.
  ctx.translate(a.x, a.y);
  ctx.beginPath();
  ctx.rect(0, 0, Math.ceil((a.cellW + tab * 2) * scale), Math.ceil((a.cellH + tab * 2) * scale));
  ctx.clip();
  ctx.scale(scale, scale);
  ctx.translate(tab - piece.solvedX, tab - piece.solvedY);

  ctx.save();
  ctx.clip(path);
  // The whole image is mapped onto the solved rect; the clip and the slot
  // rect mean only this piece's pixels are ever rasterised.
  ctx.drawImage(a.image, 0, 0, imgW, imgH, a.originX, a.originY, a.puzzleW, a.puzzleH);

  const rim = Math.max(1, Math.min(a.cellW, a.cellH) * 0.045);

  // Lower-right shadow.
  ctx.save();
  ctx.translate(rim * 0.5, rim * 0.5);
  ctx.strokeStyle = 'rgba(24, 18, 32, 0.42)';
  ctx.lineWidth = rim * 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  ctx.restore();

  // Upper-left highlight.
  ctx.save();
  ctx.translate(-rim * 0.45, -rim * 0.45);
  ctx.strokeStyle = 'rgba(255, 252, 246, 0.38)';
  ctx.lineWidth = rim * 1.1;
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  ctx.restore();

  // Crisp inner contour keeps pieces legible against each other.
  ctx.strokeStyle = 'rgba(20, 15, 26, 0.5)';
  ctx.lineWidth = Math.max(0.8, rim * 0.4);
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  ctx.restore();

  ctx.restore();
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/* -------------------------------------------------------------------------- */
/* Image loading                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Load an image so it is safe to read back from a canvas.
 *
 * Remote hosts go through our own proxy, which keeps the canvas untainted, hides
 * which upstream provider we use, and means no third-party host can be hotlinked
 * by editing a URL.
 */
export function resolveImageUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith('/') || url.startsWith('data:') || url.startsWith('blob:')) return url;
  return `/api/proxy?u=${encodeURIComponent(url)}`;
}

export function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    const cleanup = () => {
      img.onload = null;
      img.onerror = null;
    };
    img.onload = () => {
      cleanup();
      resolve(img);
    };
    img.onerror = () => {
      cleanup();
      reject(new Error('That image could not be loaded.'));
    };
    signal?.addEventListener('abort', () => {
      cleanup();
      img.src = '';
      reject(new DOMException('Aborted', 'AbortError'));
    });
    img.src = resolveImageUrl(url);
  });
}
