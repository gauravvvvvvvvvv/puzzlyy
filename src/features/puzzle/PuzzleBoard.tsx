'use client';

/**
 * The board.
 *
 * Everything a player actually touches happens here: pointer input, the camera,
 * live cursors, reactions and pings. It owns no puzzle logic of its own — the
 * engine decides what a drag means and the renderer decides how it looks. This
 * file is the hand on the mouse in between.
 *
 * Three rules keep it fast enough to hold 500 pieces (spec §27):
 *
 * 1. **The canvas is one React element.** Pieces are drawn, not mounted.
 * 2. **Pointer input never sets React state.** It mutates the engine and marks
 *    the renderer dirty; the next animation frame paints.
 * 3. **Cursors, pings and reactions are positioned in a single rAF loop** that
 *    writes `transform` directly. React renders them once and then keeps out of
 *    the way, because their screen position changes every time the camera moves.
 *
 * The optimistic-then-authoritative split is worth spelling out. Dragging edits
 * the local engine immediately so the piece keeps up with your hand, and the
 * same gesture is sent as a compact event. The server re-runs it, decides
 * whether it snapped, and broadcasts the outcome; that broadcast is what the
 * scores and the completion are built from. If the two ever disagree the server
 * wins, because its version arrives as an absolute position.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { PuzzleEngine } from '@/lib/puzzle/engine';
import { PuzzleRenderer } from '@/lib/puzzle/renderer';
import type { Camera, HintState, RemoteLock, RendererTheme } from '@/lib/puzzle/renderer';
import { chime, mergeKey, snap, warmSound } from '@/lib/puzzle/sound';
import type { PieceAtlas } from '@/lib/puzzle/sprites';
import { playerColor } from '@/lib/multiplayer/identity';
import { RoomThemeEnvironment } from '@/features/theme/RoomThemeEnvironment';
import { roomWorld } from '@/lib/theme/roomWorlds';
import { CURSOR_TTL_MS } from '@/hooks/useRoomSession';
import type { RoomSession } from '@/hooks/useRoomSession';
import type { Player } from '@/types/models';

export interface PuzzleBoardProps {
  session: RoomSession;
  engine: PuzzleEngine;
  atlas: PieceAtlas;
  image: HTMLImageElement | null;
  /** Filled in by this component so the toolbar and minimap can drive the camera. */
  rendererRef: React.RefObject<PuzzleRenderer | null>;
  /** Last pointer position in board coordinates, for anchoring reactions. */
  pointerRef: React.RefObject<{ x: number; y: number }>;
  reducedMotion: boolean;
  /** Reference-image ghost inside the solved slot. */
  ghost: boolean;
  grid: boolean;
  edgeFocus: boolean;
  /** True once the puzzle is finished — input stops, the picture stays. */
  frozen: boolean;
  /**
   * "Look here" is waiting for a spot to be chosen. The next tap on the board
   * places the ping instead of picking up a piece.
   */
  pingArmed: boolean;
  stickerArmed?: string | null;
  onPlaceSticker?: (symbol: string, point: {x: number; y: number}) => void;
  /** The chosen spot in board coordinates, or `null` if the player backed out. */
  onPlacePing: (point: { x: number; y: number } | null) => void;
  onError: (message: string) => void;
  /** Called after any local action, so Undo can be offered honestly. */
  onActed: () => void;
}

/** How much of the board a single wheel notch covers. */
const WHEEL_ZOOM = 0.0016;

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; id: number; x: number; y: number }
  | { kind: 'drag'; id: number; g: number; dx: number; dy: number; moved: boolean }
  | { kind: 'tug'; id: number; g: number; x: number; y: number; lastAt: number }
  | { kind: 'pinch'; a: number; b: number; dist: number; mx: number; my: number };

export function PuzzleBoard({
  session,
  engine,
  atlas,
  image,
  rendererRef,
  pointerRef,
  reducedMotion,
  ghost,
  grid,
  edgeFocus,
  frozen,
  pingArmed,
  stickerArmed,
  onPlaceSticker,
  onPlacePing,
  onError,
  onActed,
}: PuzzleBoardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  /** Survives the renderer being rebuilt on reconnect. */
  const cameraRef = useRef<Camera | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<Gesture>({ kind: 'none' });
  const spaceRef = useRef(false);
  const cursorNodesRef = useRef(new Map<string, HTMLDivElement>());
  const handledPingRef = useRef<string | null>(null);
  const tugsRef = useRef(session.tugs);
  tugsRef.current = session.tugs;
  const tugSentAtRef = useRef(0);
  const lastHoverHitAt = useRef(0);
  const keyboardGroupRef = useRef<number | null>(null);

  /** Read inside handlers and the rAF loop, where props would be stale. */
  const trailAtRef = useRef(new Map<string, number>());
  const playersRef = useRef<Player[]>(session.players);
  playersRef.current = session.players;
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;
  const motionRef = useRef(reducedMotion);
  motionRef.current = reducedMotion;
  const stickerArmedRef = useRef(stickerArmed);
  stickerArmedRef.current = stickerArmed;
  const stickerCallback = useRef(onPlaceSticker);
  stickerCallback.current = onPlaceSticker;
  const pingArmedRef = useRef(pingArmed);
  pingArmedRef.current = pingArmed;

  const [cursorStyle, setCursorStyle] = useState('grab');

  // `useRoomSession` returns a fresh object every render, so only its stable
  // members may be named as effect dependencies — depending on `session` itself
  // would rebuild the renderer, and throw away the atlas, on every keystroke.
  const { send, myId, refreshStats, subscribe, cursorsRef } = session;

  /** Parent callbacks, held in refs so they cannot retrigger the lifecycle. */
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onActedRef = useRef(onActed);
  onActedRef.current = onActed;
  const onPlacePingRef = useRef(onPlacePing);
  onPlacePingRef.current = onPlacePing;

  /* --- locks: who is holding what, in their own colour ------------------- */

  const remoteLocks = useCallback((): RemoteLock[] => {
    const locks: RemoteLock[] = [];
    for (const [groupId, holder] of engineRef.current.lockEntries) {
      if (holder === myId) continue;
      const player = playersRef.current.find((p) => p.id === holder);
      if (!player) continue;
      locks.push({ groupId, color: playerColor(player.colorId) });
    }
    return locks;
  }, [myId]);

  /* --- renderer lifecycle ------------------------------------------------ */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: PuzzleRenderer;
    try {
      renderer = new PuzzleRenderer({
        canvas,
        engine,
        atlas,
        image,
        theme: readTheme(canvas),
        reducedMotion: motionRef.current,
      });
    } catch (cause) {
      onErrorRef.current(
        cause instanceof Error
          ? cause.message
          : 'This browser cannot draw the puzzle board.',
      );
      return;
    }

    // The constructor frames the whole board, which is right the first time and
    // wrong on every reconnect — a player who has zoomed into a corner should
    // stay there when the socket blips.
    if (cameraRef.current) {
      renderer.camera = { ...cameraRef.current };
      renderer.invalidate();
    }
    cameraRef.current = { ...renderer.camera };
    renderer.onCameraChange = (camera) => {
      cameraRef.current = { ...camera };
    };
    renderer.remoteLocks = remoteLocks();
    renderer.ghostOpacity = ghost ? 0.16 : 0;
    renderer.showGrid = grid;
    renderer.edgeFocus = edgeFocus;
    rendererRef.current = renderer;

    const observer = new ResizeObserver(() => {
      renderer.resize();
      renderer.invalidate();
    });
    observer.observe(canvas);

    // Remote mutations land in the engine without React hearing about it, so the
    // repaint has to be triggered from the same channel.
    const unsubscribe = subscribe((event) => {
      if (event?.t === 'move') renderer.noteRemoteMove(event.g, event.ox, event.oy);
      renderer.remoteLocks = remoteLocks();
      renderer.invalidate();
    });

    return () => {
      cameraRef.current = { ...renderer.camera };
      renderer.onCameraChange = null;
      unsubscribe();
      observer.disconnect();
      renderer.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
    // Intentionally keyed on what the renderer draws. `subscribe` and
    // `remoteLocks` are stable and the parent callbacks live in refs, so the
    // renderer — and the atlas it holds — survives ordinary re-renders.
  }, [engine, atlas, image, remoteLocks, rendererRef, subscribe]);

  // An optimistic grab that lost a server race changes into a tug without
  // requiring the player to release and click the same piece again.
  useEffect(() => {
    const contested = session.contested;
    const gesture = gestureRef.current;
    if (!contested || gesture.kind !== 'drag' || gesture.g !== contested.g) return;
    const screen = pointersRef.current.get(gesture.id);
    if (!screen) return;
    gestureRef.current = {
      kind: 'tug', id: gesture.id, g: gesture.g,
      x: screen.x, y: screen.y, lastAt: 0,
    };
    const renderer = rendererRef.current;
    if (renderer) {
      renderer.draggingGroup = null;
      renderer.snapPreview = null;
      renderer.invalidate();
    }
  }, [session.contested, rendererRef]);

  /* --- cheap renderer settings, no rebuild ------------------------------- */

  useEffect(() => {
    rendererRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion, rendererRef]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.ghostOpacity = ghost ? 0.16 : 0;
    renderer.showGrid = grid;
    renderer.edgeFocus = edgeFocus;
    renderer.invalidate();
  }, [ghost, grid, edgeFocus, rendererRef]);

  // The palette lives in CSS, so the canvas has to be told when it changes.
  useEffect(() => {
    const target = document.documentElement;
    const sync = () => rendererRef.current?.setTheme(readTheme(canvasRef.current));
    const observer = new MutationObserver(sync);
    observer.observe(target, { attributes: true, attributeFilter: ['data-theme'] });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', sync);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', sync);
    };
  }, [rendererRef, session.room?.theme]);

  /* --- hints ------------------------------------------------------------- */

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    const notice = session.hint;
    if (!notice) {
      renderer.hint = null;
      renderer.invalidate();
      return;
    }

    // The server sends the region as words ("the top-right") because that is
    // what level 1 shows; the rectangle to draw is ours to work out.
    const state: HintState = {
      level: clampLevel(notice.level),
      pieceId: notice.pieceId,
      region: regionRect(engine, notice.pieceId),
      startedAt: performance.now(),
    };
    renderer.hint = state;

    // Only move the camera for the player who asked. Yanking someone else's view
    // because their friend wanted a hint would be rude.
    if (notice.playerId === myId && notice.pieceId !== null && notice.level >= 2) {
      const world = engine.pieceWorld(notice.pieceId);
      renderer.lookAt(world.x, world.y);
    }
    renderer.invalidate();
  }, [session.hint, engine, myId, rendererRef]);

  /* --- "look here" ------------------------------------------------------- */

  useEffect(() => {
    const renderer = rendererRef.current;
    const latest = session.pings[session.pings.length - 1];
    if (!renderer || !latest) return;
    if (handledPingRef.current === latest.id) return;
    handledPingRef.current = latest.id;
    // Including our own ping: a player who pings then looks away still expects
    // the board to be looking at the thing they pointed at.
    renderer.lookAt(latest.x, latest.y);
  }, [session.pings, rendererRef]);

  /* --- completion -------------------------------------------------------- */

  useEffect(() => {
    if (!frozen) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.draggingGroup = null;
    renderer.snapPreview = null;
    renderer.hint = null;
    renderer.centerPuzzle();
    renderer.celebrate();
  }, [frozen, rendererRef]);

  /* --- overlay positioning: one loop for everything in world space ------- */

  useEffect(() => {
    let raf = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const renderer = rendererRef.current;
      const overlay = overlayRef.current;
      if (!renderer || !overlay) return;

      // React-rendered marks (reactions, pings) carry their world point on the
      // element; the camera decides where that lands this frame.
      for (const el of overlay.querySelectorAll<HTMLElement>('[data-world]')) {
        const point = renderer.screenFromWorld(Number(el.dataset.wx), Number(el.dataset.wy));
        el.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
      }

      // Tiny cursor trails use pooled DOM and expire naturally. Limit sampling
      // to avoid allocating nodes for each pointer frame.
      if (!motionRef.current) {
        for (const [id, mark] of cursorsRef.current) {
          if (!mark.down || Date.now() - mark.at > 700) continue;
          const last = trailAtRef.current.get(id) ?? 0;
          if (Date.now() - last < 85 || overlay.querySelectorAll('[data-trail]').length > 80) continue;
          trailAtRef.current.set(id, Date.now());
          const spot = renderer.screenFromWorld(mark.x, mark.y);
          const dot = document.createElement('span');
          dot.dataset.trail = '';
          dot.className = 'pointer-events-none absolute size-1.5 rounded-full shadow-sm';
          const player = playersRef.current.find(p => p.id === id);
          dot.style.background = roomWorld(session.room?.theme).trail;
          dot.style.boxShadow = '0 0 9px '+roomWorld(session.room?.theme).trail;
          dot.style.transform = 'translate3d(' + spot.x + 'px,' + spot.y + 'px,0)';
          dot.style.animation = 'puzzly-trail-fade .55s ease-out forwards';
          dot.onanimationend = () => dot.remove();
          overlay.appendChild(dot);
        }
      }
      }

      // Cursors are built by hand: they change many times a second and must
      // never cause a render.
      const cursors = cursorsRef.current;
      if (!cursors) return;
      const now = Date.now();
      for (const [id, mark] of cursors) {
        if (now - mark.at > CURSOR_TTL_MS) {
          cursors.delete(id);
          continue;
        }
        const player = playersRef.current.find((p) => p.id === id);
        if (!player) continue;
        const node = ensureCursorNode(cursorNodesRef.current, overlay, player);
        const point = renderer.screenFromWorld(mark.x, mark.y);
        node.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
        node.style.opacity = mark.down ? '1' : '0.78';
      }
      for (const [id, node] of cursorNodesRef.current) {
        if (!cursors.has(id)) {
          node.remove();
          cursorNodesRef.current.delete(id);
        }
      }
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      for (const node of cursorNodesRef.current.values()) node.remove();
      cursorNodesRef.current.clear();
    };
  }, [cursorsRef, rendererRef]);

  /* --- wheel: needs to be non-passive to stop the page zooming ----------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (event: WheelEvent) => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      // Trackpad pinch arrives as ctrl+wheel with small deltas; both paths want
      // the same "zoom about the pointer" behaviour, just at different gains.
      const gain = event.ctrlKey ? 3 : 1;
      const factor = Math.exp(-event.deltaY * WHEEL_ZOOM * gain);
      renderer.zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [rendererRef]);

  /* --- space to pan ------------------------------------------------------ */

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || isTyping(event.target)) return;
      // Space would otherwise scroll the page behind the board.
      event.preventDefault();
      spaceRef.current = true;
      setCursorStyle('grab');
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      spaceRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  /* --- pointer input ----------------------------------------------------- */

  const screenPoint = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      warmSound();
      const renderer = rendererRef.current;
      if (!renderer) return;
      const screen = screenPoint(event);
      pointersRef.current.set(event.pointerId, screen);
      event.currentTarget.setPointerCapture(event.pointerId);

      // Two fingers always mean "move the view", unless a piece is already
      // being dragged — interrupting that would drop it somewhere random.
      if (pointersRef.current.size === 2 && gestureRef.current.kind !== 'drag') {
        const [a, b] = [...pointersRef.current.keys()];
        gestureRef.current = pinchFrom(pointersRef.current, a, b);
        renderer.draggingGroup = null;
        renderer.snapPreview = null;
        return;
      }
      if (pointersRef.current.size !== 1) return;

      const world = renderer.worldFromScreen(screen.x, screen.y);
      pointerRef.current = world;

      if (stickerArmedRef.current && !frozenRef.current) {
        stickerCallback.current?.(stickerArmedRef.current, {x: world.x, y: world.y});
        gestureRef.current = {kind: 'none'};
        return;
      }

      // "Look here" is waiting for a spot, so this tap chooses it rather than
      // picking up a piece. A secondary button backs out — the same gesture that
      // escapes a placement mode in every drawing app. The parent does the
      // sending, so arming, sending and disarming all stay in one place.
      if (pingArmedRef.current && !frozenRef.current) {
        onPlacePingRef.current(
          event.button === 1 || event.button === 2 ? null : { x: world.x, y: world.y },
        );
        gestureRef.current = { kind: 'none' };
        return;
      }

      const wantsPan =
        frozenRef.current ||
        spaceRef.current ||
        event.button === 1 ||
        event.button === 2 ||
        event.shiftKey;

      if (!wantsPan) {
        // Alt-click is the "look here" ping (spec §19) — cheap to reach and
        // impossible to trigger by accident while solving.
        if (event.altKey) {
          send({ t: 'ping', x: world.x, y: world.y });
          gestureRef.current = { kind: 'none' };
          return;
        }

        const hit = renderer.pickPiece(world.x, world.y);
        if (hit) {
          const engineNow = engineRef.current;
          const z = engineNow.grab(hit.groupId, myId);
          if (z === null) {
            // Locked piece: start a short, server-resolved tug contest.
            // Panning would move this player's viewport unexpectedly.
            gestureRef.current = { kind: 'tug', id: event.pointerId, g: hit.groupId,
              x: screen.x, y: screen.y, lastAt: 0 };
            send({ t: 'tug', g: hit.groupId, force: 0 });
            window.setTimeout(() => {
              if (tugsRef.current.some(t => t.g === hit.groupId)) {
                send({ t: 'tug', g: hit.groupId, force: 0 });
              }
            }, 1950);
            setCursorStyle('grabbing');
            return;
          } else {
            const group = engineNow.getGroup(hit.groupId);
            if (group) {
              gestureRef.current = {
                kind: 'drag',
                id: event.pointerId,
                g: hit.groupId,
                dx: world.x - group.ox,
                dy: world.y - group.oy,
                moved: false,
              };
              send({ t: 'grab', g: hit.groupId });
              renderer.draggingGroup = hit.groupId;
              renderer.invalidate();
              setCursorStyle('grabbing');
              return;
            }
          }
        }
      }

      gestureRef.current = { kind: 'pan', id: event.pointerId, x: screen.x, y: screen.y };
      setCursorStyle('grabbing');
    },
    [myId, pointerRef, rendererRef, screenPoint, send],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const screen = screenPoint(event);
      const known = pointersRef.current.has(event.pointerId);
      if (known) pointersRef.current.set(event.pointerId, screen);

      const world = renderer.worldFromScreen(screen.x, screen.y);
      pointerRef.current = world;

      const gesture = gestureRef.current;

      if (gesture.kind === 'pinch') {
        const a = pointersRef.current.get(gesture.a);
        const b = pointersRef.current.get(gesture.b);
        if (!a || !b) return;
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        renderer.zoomAt(mx, my, dist / gesture.dist);
        renderer.panBy(mx - gesture.mx, my - gesture.my);
        gestureRef.current = { kind: 'pinch', a: gesture.a, b: gesture.b, dist, mx, my };
        return;
      }

      if (gesture.kind === 'tug' && gesture.id === event.pointerId) {
        const now = performance.now();
        const motion = Math.hypot(screen.x - gesture.x, screen.y - gesture.y);
        if (now - gesture.lastAt >= 130 && motion > 3) {
          send({ t: 'tug', g: gesture.g, force: Math.min(12, Math.round(motion / 6)) });
          gestureRef.current = { ...gesture, x: screen.x, y: screen.y, lastAt: now };
        }
        return;
      }

      if (gesture.kind === 'drag' && gesture.id === event.pointerId) {
        const engineNow = engineRef.current;
        // An authoritative tug win or rejected grab can revoke this hold.
        if (engineNow.lockHolder(gesture.g) !== myId) {
          gestureRef.current = { kind: 'none' };
          renderer.draggingGroup = null;
          renderer.snapPreview = null;
          renderer.invalidate();
          return;
        }
        const duel = tugsRef.current.find(t => t.g === gesture.g);
        if (duel && performance.now() - tugSentAtRef.current > 130) {
          tugSentAtRef.current = performance.now();
          send({ t: 'tug', g: gesture.g, force: 8 });
        }
        engineNow.movePiece(gesture.g, world.x - gesture.dx, world.y - gesture.dy, myId);
        const group = engineNow.getGroup(gesture.g);
        if (!group) {
          gestureRef.current = { kind: 'none' };
          return;
        }
        if (!gesture.moved) gestureRef.current = { ...gesture, moved: true };

        // Show where it would land. The engine already knows, so this costs one
        // neighbour scan rather than a second implementation of snapping.
        const snap = engineNow.snapPieces(gesture.g);
        if (snap && snap.dist < engineNow.geometry.snapDistance * 0.65) {
          // Magnetism stays client-side. Apply a small attraction only near a
          // valid neighbour; the authoritative snap still occurs on drop.
          engineNow.movePiece(gesture.g, group.ox + snap.dx * 0.18,
            group.oy + snap.dy * 0.18, myId);
        }
        renderer.snapPreview = snap
          ? { groupId: gesture.g, ox: group.ox + snap.dx, oy: group.oy + snap.dy }
          : null;

        // Safe at pointer rate: the outbox keeps only the newest position per
        // group and flushes about twelve times a second.
        send({ t: 'move', g: gesture.g, ox: group.ox, oy: group.oy });
        send({ t: 'cursor', x: world.x, y: world.y, down: true });
        renderer.invalidate();
        return;
      }

      if (gesture.kind === 'pan' && gesture.id === event.pointerId) {
        renderer.panBy(screen.x - gesture.x, screen.y - gesture.y);
        gestureRef.current = { kind: 'pan', id: gesture.id, x: screen.x, y: screen.y };
        return;
      }

      if (!frozenRef.current) {
        send({ t: 'cursor', x: world.x, y: world.y, down: false });
        // A cheap affordance: the hand only opens over something grabbable.
        // Hover outlines need only ~20Hz hit-testing; dragging stays full-rate.
        const now = performance.now();
        if (now - lastHoverHitAt.current >= 50) {
          lastHoverHitAt.current = now;
          setCursorStyle(renderer.pickPiece(world.x, world.y) ? 'grab' : 'default');
        }
      }
    },
    [myId, pointerRef, rendererRef, screenPoint, send],
  );

  const finishPointer = useCallback(
    (pointerId: number, cancelled: boolean) => {
      const renderer = rendererRef.current;
      pointersRef.current.delete(pointerId);
      const gesture = gestureRef.current;

      if (gesture.kind === 'tug' && gesture.id === pointerId) {
        gestureRef.current = { kind: 'none' };
        setCursorStyle('grab');
        return;
      }

      if (gesture.kind === 'pinch') {
        // A finger left mid-pinch. If one is still down, carry on panning with
        // it rather than stopping dead.
        const remaining = [...pointersRef.current.entries()][0];
        gestureRef.current = remaining
          ? { kind: 'pan', id: remaining[0], x: remaining[1].x, y: remaining[1].y }
          : { kind: 'none' };
        return;
      }

      if (gesture.kind === 'drag' && gesture.id === pointerId) {
        gestureRef.current = { kind: 'none' };
        const engineNow = engineRef.current;
        const group = engineNow.getGroup(gesture.g);
        if (renderer) {
          renderer.draggingGroup = null;
          renderer.snapPreview = null;
        }

        if (group && !cancelled && engineNow.lockHolder(gesture.g) === myId) {
          const ox = group.ox;
          const oy = group.oy;
          // The server decides whether this snapped; it is told first so the
          // round trip starts while we are still drawing the optimistic result.
          send({ t: 'drop', g: gesture.g, ox, oy });

          // Credit belongs to the authoritative merge broadcast, so the
          // optimistic drop's bookkeeping is rolled straight back.
          const creditBefore = engineNow.credit.get(myId) ?? 0;
          const result = engineNow.drop(gesture.g, ox, oy, myId, Date.now());
          engineNow.credit.set(myId, creditBefore);
          engineNow.release(gesture.g, myId);

          if (result.merges.length && 'vibrate' in navigator) {
            navigator.vibrate?.(12);
          }
          for (const merge of result.merges) {
            renderer?.pulse(merge.into);
            // Keyed on the merge itself, because the server will echo this same
            // merge back in a moment and both call sites ask to play it.
            snap(mergeKey(merge.into, merge.from), {
              connections: merge.connections,
              mine: true,
              source: 'optimistic',
            });
          }
          if (result.completed) {
            renderer?.celebrate();
            chime();
          }
          if (gesture.moved || result.merges.length) onActedRef.current();
          refreshStats();
        } else if (group) {
          engineNow.release(gesture.g, myId);
        }

        renderer?.invalidate();
        setCursorStyle('grab');
        return;
      }

      if (gesture.kind === 'pan' && gesture.id === pointerId) {
        gestureRef.current = { kind: 'none' };
        setCursorStyle('default');
      }
    },
    [myId, refreshStats, rendererRef, send],
  );

  const rotateHeld = useCallback((dir: 1 | -1) => {
    const gesture = gestureRef.current;
    if (gesture.kind !== 'drag') return;
    engineRef.current.rotatePiece(gesture.g, dir, pointerRef.current, myId);
    send({ t: 'rotate', g: gesture.g, dir });
    onActedRef.current();
    rendererRef.current?.invalidate();
  }, [myId, pointerRef, rendererRef, send]);

  const onBoardKeyDown = useCallback((event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (frozenRef.current || event.metaKey || event.ctrlKey || event.altKey) return;
    const current = engineRef.current;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const selected = keyboardGroupRef.current;
    const finish = () => {
      const id = keyboardGroupRef.current;
      if (id === null) return;
      const group = current.getGroup(id);
      if (group && current.lockHolder(id) === myId) {
        send({ t: 'drop', g: id, ox: group.ox, oy: group.oy });
        current.drop(id, group.ox, group.oy, myId, Date.now());
        current.release(id, myId);
        onActedRef.current();
        refreshStats();
      }
      keyboardGroupRef.current = null;
      renderer.draggingGroup = null;
      renderer.snapPreview = null;
      renderer.invalidate();
    };

    if (event.key.toLowerCase() === 'n') {
      event.preventDefault();
      const groups = current.groupList.map(group => group.id).sort((a, b) => a - b);
      if (!groups.length) return;
      const start = selected === null ? -1 : groups.indexOf(selected);
      finish();
      for (let step = 1; step <= groups.length; step++) {
        const id = groups[(start + step) % groups.length];
        if (current.lockHolder(id) && current.lockHolder(id) !== myId) continue;
        if (current.grab(id, myId) === null) continue;
        keyboardGroupRef.current = id;
        const group = current.getGroup(id);
        if (group && group.pieces.length) { const point = current.pieceWorld(group.pieces[0]); renderer.lookAt(point.x, point.y); }
        renderer.draggingGroup = id;
        send({ t: 'grab', g: id });
        renderer.invalidate();
        break;
      }
      return;
    }
    if (selected === null) return;
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault();
      finish();
      return;
    }
    if (event.key === 'q' || event.key === 'Q' || event.key === 'e' || event.key === 'E') {
      if (!current.puzzle.settings.rotation) return;
      event.preventDefault();
      const dir = event.key.toLowerCase() === 'e' ? 1 : -1;
      current.rotatePiece(selected, dir, undefined, myId);
      send({ t: 'rotate', g: selected, dir });
      renderer.invalidate();
      return;
    }
    const directions: Record<string, [number, number]> = {
      ArrowUp: [0, -1], ArrowDown: [0, 1],
      ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const group = current.getGroup(selected);
    if (!group || current.lockHolder(selected) !== myId) return;
    const pace = event.shiftKey ? 40 : 12;
    current.movePiece(selected, group.ox + direction[0] * pace, group.oy + direction[1] * pace, myId);
    send({ t: 'move', g: selected, ox: group.ox, oy: group.oy });
    renderer.snapPreview = null;
    renderer.invalidate();
  }, [myId, refreshStats, rendererRef, send]);

  /* --- rotation ---------------------------------------------------------- */

  useEffect(() => {
    if (!engine.puzzle.settings.rotation) return;

    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey) return;
      const dir = event.key === 'e' || event.key === 'E' ? 1 : event.key === 'q' || event.key === 'Q' ? -1 : 0;
      if (!dir) return;
      const gesture = gestureRef.current;
      // Only ever rotates the group in your hand, so the keys can never disturb
      // the board while you are looking for a piece.
      if (gesture.kind !== 'drag') return;
      event.preventDefault();
      const renderer = rendererRef.current;
      engineRef.current.rotatePiece(
        gesture.g,
        dir as 1 | -1,
        pointerRef.current ?? undefined,
        myId,
      );
      send({ t: 'rotate', g: gesture.g, dir: dir as 1 | -1 });
      onActedRef.current();
      renderer?.invalidate();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine, myId, pointerRef, rendererRef, send]);

  /* ---------------------------------------------------------------------- */

  return (
    <div className="relative size-full overflow-hidden" style={{ background: 'var(--board-bg)' }}>
      {engine.puzzle.settings.rotation && (
        <div className="pointer-events-auto absolute bottom-24 left-3 z-30 flex gap-2 rounded-xl border border-[var(--line)] bg-[var(--surface)]/95 p-1.5 shadow-lg sm:bottom-20"
          role="group" aria-label="Rotate the piece you are holding">
          <button type="button" onClick={() => rotateHeld(-1)} aria-label="Rotate held piece left"
            className="min-h-11 min-w-11 rounded-lg border border-[var(--line)] text-sm font-semibold hover:bg-[var(--surface-inset)] active:scale-95">↶</button>
          <button type="button" onClick={() => rotateHeld(1)} aria-label="Rotate held piece right"
            className="min-h-11 min-w-11 rounded-lg border border-[var(--line)] text-sm font-semibold hover:bg-[var(--surface-inset)] active:scale-95">↷</button>
          <span className="hidden self-center px-1 text-xs text-[var(--fg-muted)] sm:inline">Hold a piece · Q/E</span>
        </div>
      )}
      <p id="puzzly-board-keyboard-help" className="sr-only">Keyboard puzzle controls: Tab to focus this board, press N to select the next piece, arrow keys to move it, Shift plus arrow for large steps, Enter to place, or Escape to release. Q and E rotate a selected piece when rotation is enabled.</p>
      <canvas
        tabIndex={0}
        role="application"
        aria-label="Interactive puzzle board"
        aria-describedby="puzzly-board-keyboard-help"
        onKeyDown={onBoardKeyDown}
        ref={canvasRef}
        // `touch-none` is what makes dragging possible on a phone: without it the
        // browser claims the gesture for scrolling (spec §24).
        className={"block size-full touch-none select-none " + (session.tugs.length && !reducedMotion ? "puzzly-tug-board" : "")}
        style={{ cursor: frozen ? 'default' : pingArmed ? 'crosshair' : cursorStyle, animation: session.tugs.length && !reducedMotion ? 'puzzly-tug-shake 120ms ease-in-out infinite' : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => finishPointer(event.pointerId, false)}
        onPointerCancel={(event) => finishPointer(event.pointerId, true)}
        onPointerLeave={(event) => {
          if (gestureRef.current.kind === 'none') pointersRef.current.delete(event.pointerId);
        }}
        // A canvas has no useful context menu, and right-drag is a pan.
        onContextMenu={(event) => event.preventDefault()}
      />

      <RoomThemeEnvironment />
      {session.tugs.length > 0 && (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-10"
          style={{ animation: 'puzzly-tug-shake 120ms ease-in-out infinite' }} />
      )}
      {session.tugs.length > 0 && (
        <div className="pointer-events-none absolute inset-x-3 top-3 z-20 mx-auto max-w-xs space-y-2">
          {session.tugs.map(contest => {
            const a = session.players.find(p => p.id === contest.defender)?.name ?? 'Player 1';
            const b = session.players.find(p => p.id === contest.challenger)?.name ?? 'Player 2';
            const total = Math.max(1, contest.defenderScore + contest.challengerScore);
            return (
              <div key={contest.g} role="status"
                className="rounded-xl border border-[var(--line)] bg-[var(--surface)]/95 p-3 shadow-lg backdrop-blur">
                <p className="text-center text-sm font-semibold">Tug of war! Pull the piece</p>
                <div className="mt-2 flex justify-between text-xs">
                  <span>{a}</span><span>{b}</span>
                </div>
                <div className="mt-1 flex h-2 overflow-hidden rounded-full bg-[var(--surface-inset)]">
                  <div className="bg-blue-400 transition-[width] duration-100"
                    style={{ width: String(contest.defenderScore / total * 100) + '%' }} />
                  <div className="flex-1 bg-orange-400" />
                </div>
                <p className="mt-1 text-center text-2xs text-[var(--fg-muted)]">
                  Both players can pull with their pointer. Best effort wins.
                </p>
              </div>
            );
          })}
        </div>
      )}

      <div ref={overlayRef} className="pointer-events-none absolute inset-0 overflow-hidden">
        {session.moments.filter(m => Date.now() - m.at < 4500).map(m => (
          <div key={m.id} className="pointer-events-none absolute inset-x-4 top-1/4 z-30 flex justify-center">
            <span className="puzzly-world-celebration rounded-full border bg-[var(--surface)]/95 px-5 py-3 text-sm font-semibold shadow-2xl"
              style={{animation:'puzzly-moment-pop 1s ease-in-out infinite alternate'}}>
              {m.kind === 'combo' ? '✨' : m.kind === 'high-five' ? '🙌' : '🌟'} {m.label}
            </span>
          </div>
        ))}
        {session.stickers.map(sticker => (
          <div key={sticker.id} data-world data-wx={sticker.x} data-wy={sticker.y}
            className="pointer-events-none absolute top-0 left-0 z-20 text-4xl"
            style={{animation:'puzzly-sticker-pop 10s ease-out forwards'}}>
            {sticker.symbol}
          </div>
        ))}
        {session.pings.map((ping) => (
          <div
            key={ping.id}
            data-world
            data-wx={ping.x}
            data-wy={ping.y}
            className="absolute top-0 left-0 -translate-x-1/2 -translate-y-1/2 will-change-transform"
            style={{ transform: 'translate3d(-9999px,-9999px,0)' }}
          >
            <span className="relative grid place-items-center">
              <span
                className="absolute size-10 rounded-full animate-pulse-ring"
                style={{ background: pingColor(session.players, ping.playerId) }}
              />
              <span
                className="size-3 rounded-full"
                style={{ background: pingColor(session.players, ping.playerId) }}
              />
            </span>
            <span className="panel absolute top-6 left-1/2 -translate-x-1/2 px-2 py-1 text-2xs whitespace-nowrap">
              {ping.text || 'Look here'}
            </span>
          </div>
        ))}

        {session.reactions.map((burst) => (
          <div
            key={burst.id}
            data-world
            data-wx={burst.x}
            data-wy={burst.y}
            className="absolute top-0 left-0 will-change-transform"
            style={{ transform: 'translate3d(-9999px,-9999px,0)' }}
          >
            <span className="block -translate-x-1/2 -translate-y-full animate-float-up text-3xl drop-shadow-[0_2px_6px_rgba(0,0,0,0.35)]">
              {burst.emoji}
            </span>
          </div>
        ))}
      </div>
      <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden" aria-live="off">
        {session.reactions.flatMap(burst => Array.from({ length: 24 }, (_, i) => {
          const seed = (i * 67 + burst.id.length * 37) % 101;
          return <span key={burst.id + ':' + i} className="absolute text-2xl sm:text-3xl"
            style={{
              left: (4 + ((seed * 37 + i * 13) % 92)) + '%',
              top: '-10%',
              animation: 'puzzly-emoji-shower ' + (1.2 + i % 5 * .22) + 's ease-in ' + (i % 9 * .055) + 's forwards',
              opacity: .95,
            }}>{burst.emoji}</span>;
        }))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** The canvas cannot read CSS variables, so hand it resolved colours. */
function readTheme(canvas?: HTMLCanvasElement | null): RendererTheme {
  const root = canvas?.closest('[data-room-theme]') ?? document.documentElement;
  const style = getComputedStyle(root);
  const pick = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    boardBg: pick('--board-bg', '#17161a'),
    slot: pick('--board-slot', 'rgba(255,255,255,0.035)'),
    slotLine: pick('--line', 'rgba(255,255,255,0.09)'),
    accent: pick('--world-snap', pick('--accent', '#ff8a5b')),
    hint: pick('--color-butter-400', '#ffd166'),
  };
}

function clampLevel(level: number): 1 | 2 | 3 | 4 {
  if (level >= 4) return 4;
  if (level === 3) return 3;
  if (level === 2) return 2;
  return 1;
}

/**
 * The rectangle behind the words the server sent.
 *
 * `pickHintTarget` describes the target as one of nine bands ("the top-right"),
 * so the drawn region has to be the same nine-way split of the solved slot or
 * the picture and the sentence would disagree.
 */
function regionRect(
  engine: PuzzleEngine,
  pieceId: number | null,
): { x: number; y: number; w: number; h: number } | null {
  if (pieceId === null) return null;
  const piece = engine.pieces[pieceId];
  if (!piece) return null;
  const g = engine.geometry;
  const band = (value: number, count: number) =>
    value < count / 3 ? 0 : value < (2 * count) / 3 ? 1 : 2;
  const w = g.puzzleW / 3;
  const h = g.puzzleH / 3;
  return {
    x: g.originX + band(piece.col, g.cols) * w,
    y: g.originY + band(piece.row, g.rows) * h,
    w,
    h,
  };
}

function pinchFrom(
  pointers: Map<number, { x: number; y: number }>,
  a: number,
  b: number,
): Gesture {
  const pa = pointers.get(a);
  const pb = pointers.get(b);
  if (!pa || !pb) return { kind: 'none' };
  return {
    kind: 'pinch',
    a,
    b,
    dist: Math.hypot(pa.x - pb.x, pa.y - pb.y) || 1,
    mx: (pa.x + pb.x) / 2,
    my: (pa.y + pb.y) / 2,
  };
}

function pingColor(players: Player[], playerId: string): string {
  const player = players.find((p) => p.id === playerId);
  return player ? playerColor(player.colorId) : 'var(--accent)';
}

/** Never swallow a keystroke aimed at a text field. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

/**
 * A friend's cursor: a coloured dot with their name.
 *
 * Built with DOM calls rather than JSX because it moves at pointer rate and must
 * never trigger a React render. `textContent` rather than `innerHTML` because the
 * name comes from another person.
 */
function ensureCursorNode(
  nodes: Map<string, HTMLDivElement>,
  overlay: HTMLElement,
  player: Player,
): HTMLDivElement {
  const existing = nodes.get(player.id);
  if (existing) {
    const label = existing.querySelector('span[data-name]');
    if (label && label.textContent !== player.name) label.textContent = player.name;
    return existing;
  }

  const color = playerColor(player.colorId);
  const node = document.createElement('div');
  node.className =
    'absolute top-0 left-0 flex items-center gap-1.5 will-change-transform transition-opacity duration-200';
  node.style.transform = 'translate3d(-9999px,-9999px,0)';

  const dot = document.createElement('span');
  dot.className = 'size-3 shrink-0 rounded-full';
  dot.style.background = color;
  dot.style.boxShadow = '0 0 0 2px rgba(0,0,0,0.35)';

  const label = document.createElement('span');
  label.dataset.name = '';
  label.className = 'rounded-full px-1.5 py-0.5 text-[0.625rem] font-semibold whitespace-nowrap';
  label.style.background = color;
  label.style.color = '#17161a';
  label.textContent = player.name;

  node.append(dot, label);
  overlay.append(node);
  nodes.set(player.id, node);
  return node;
}
