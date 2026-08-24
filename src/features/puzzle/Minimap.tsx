'use client';

/**
 * The minimap (spec §14).
 *
 * On a 500-piece board the camera can only ever hold a fraction of the table, so
 * this is how you find the corner where you left the sky pieces. It shows the
 * whole board, which pieces have found each other, and where you are looking —
 * and clicking it moves the camera there.
 *
 * It draws itself from the engine and the renderer's camera on an animation
 * frame, but only when something actually changed. A minimap that repaints 60
 * times a second while nobody touches the board would be a silly thing to spend
 * a phone's battery on.
 */

import { useCallback, useEffect, useRef } from 'react';

import type { PuzzleEngine } from '@/lib/puzzle/engine';
import type { PuzzleRenderer } from '@/lib/puzzle/renderer';

export interface MinimapProps {
  engine: PuzzleEngine;
  rendererRef: React.RefObject<PuzzleRenderer | null>;
  /** Fires on any engine change, so the map keeps up with the other player. */
  subscribe: (listener: () => void) => () => void;
  className?: string;
}

const WIDTH = 148;

export function Minimap({ engine, rendererRef, subscribe, className = '' }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dirtyRef = useRef(0);
  const signatureRef = useRef('');
  const draggingRef = useRef(false);

  const geometry = engine.geometry;
  const height = Math.round((WIDTH * geometry.boardH) / geometry.boardW);

  useEffect(() => subscribe(() => (dirtyRef.current += 1)), [subscribe]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(WIDTH * dpr);
    canvas.height = Math.round(height * dpr);

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const renderer = rendererRef.current;
      if (!renderer) return;

      const camera = renderer.camera;
      const signature = `${Math.round(camera.cx)},${Math.round(camera.cy)},${camera.scale.toFixed(3)},${dirtyRef.current}`;
      if (signature === signatureRef.current) return;
      signatureRef.current = signature;

      paint(ctx, engine, renderer, WIDTH, height, dpr);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, height, rendererRef]);

  const look = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const fx = (event.clientX - rect.left) / rect.width;
      const fy = (event.clientY - rect.top) / rect.height;
      // No animation while dragging: the camera should track the finger.
      renderer.lookAt(fx * geometry.boardW, fy * geometry.boardH);
    },
    [geometry.boardH, geometry.boardW, rendererRef],
  );

  return (
    <canvas
      ref={canvasRef}
      // Not `aria-hidden`: it is genuinely decorative for anyone who cannot see
      // the board, and the toolbar's Fit button covers the same need.
      role="presentation"
      className={`panel block cursor-pointer touch-none p-0 ${className}`}
      style={{ width: WIDTH, height }}
      title="Jump to a part of the board"
      onPointerDown={(event) => {
        draggingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        look(event);
      }}
      onPointerMove={(event) => {
        if (draggingRef.current) look(event);
      }}
      onPointerUp={() => {
        draggingRef.current = false;
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
      }}
    />
  );
}

/* -------------------------------------------------------------------------- */

function paint(
  ctx: CanvasRenderingContext2D,
  engine: PuzzleEngine,
  renderer: PuzzleRenderer,
  width: number,
  height: number,
  dpr: number,
) {
  const g = engine.geometry;
  const sx = width / g.boardW;
  const sy = height / g.boardH;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const style = getComputedStyle(ctx.canvas);
  const read = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;

  ctx.fillStyle = read('--board-bg', '#17161a');
  ctx.fillRect(0, 0, width, height);

  // The solved slot, so the map has a landmark.
  ctx.strokeStyle = read('--line', 'rgba(255,255,255,0.09)');
  ctx.lineWidth = 1;
  ctx.strokeRect(
    g.originX * sx,
    g.originY * sy,
    g.puzzleW * sx,
    g.puzzleH * sy,
  );

  const accent = read('--accent', '#ff8a5b');
  const loose = read('--fg-subtle', 'rgba(255,255,255,0.4)');
  const pw = Math.max(1, g.cellW * sx);
  const ph = Math.max(1, g.cellH * sy);

  // Joined pieces in the accent colour: the map fills in as the picture comes
  // together, which is the whole point of looking at it.
  for (const group of engine.groupList) {
    const joined = group.pieces.length > 1;
    ctx.fillStyle = joined ? accent : loose;
    ctx.globalAlpha = joined ? 0.85 : 0.4;
    const swap = group.rot % 2 === 1;
    for (const pieceId of group.pieces) {
      const world = engine.pieceWorld(pieceId);
      ctx.fillRect(world.x * sx, world.y * sy, swap ? ph : pw, swap ? pw : ph);
    }
  }
  ctx.globalAlpha = 1;

  // Where the player is looking.
  const view = renderer.viewport;
  const halfW = view.width / renderer.camera.scale / 2;
  const halfH = view.height / renderer.camera.scale / 2;
  ctx.strokeStyle = read('--fg', '#f5f3ef');
  ctx.lineWidth = 1.5;
  ctx.strokeRect(
    (renderer.camera.cx - halfW) * sx,
    (renderer.camera.cy - halfH) * sy,
    halfW * 2 * sx,
    halfH * 2 * sy,
  );
}
