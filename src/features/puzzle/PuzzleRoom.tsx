'use client';

/**
 * The playing room: chrome around the board.
 *
 * Everything a human reads lives here — progress, the clock, who is here, toasts
 * — and everything a hand touches lives in `PuzzleBoard`. Keeping the two apart
 * is what lets the canvas repaint sixty times a second while this component
 * re-renders about once (spec §27).
 *
 * It also owns the renderer handle. The toolbar and the minimap both drive the
 * camera, and neither should have to know how a canvas works, so the ref is
 * created here and handed to all three.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Logo } from '@/components/site/Logo';
import { Button, IconButton } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { ConnectionBadge, ConnectionBanner } from '@/features/multiplayer/ConnectionBadge';
import { Avatar, PresenceRail } from '@/features/multiplayer/PresenceRail';
import { BoardToolbar } from '@/features/puzzle/BoardToolbar';
import { Minimap } from '@/features/puzzle/Minimap';
import { PuzzleBoard } from '@/features/puzzle/PuzzleBoard';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import type { RoomSession } from '@/hooks/useRoomSession';
import { formatDuration } from '@/lib/format';
import { readJson, writeJson } from '@/lib/storage/local';
import type { PuzzleEngine } from '@/lib/puzzle/engine';
import type { PuzzleRenderer } from '@/lib/puzzle/renderer';
import { setSoundEnabled, soundEnabled } from '@/lib/puzzle/sound';
import type { PieceAtlas } from '@/lib/puzzle/sprites';
import type { Puzzle } from '@/types/models';

export interface PuzzleRoomProps {
  session: RoomSession;
  engine: PuzzleEngine;
  puzzle: Puzzle;
  atlas: PieceAtlas;
  image: HTMLImageElement | null;
  solo: boolean;
  onLeave: () => void;
}

export function PuzzleRoom({
  session,
  engine,
  puzzle,
  atlas,
  image,
  solo,
  onLeave,
}: PuzzleRoomProps) {
  const reducedMotion = useReducedMotion();
  const rendererRef = useRef<PuzzleRenderer | null>(null);
  const fullscreenRef = useRef<HTMLDivElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const pointerRef = useRef({ x: 0, y: 0 });
  const hintLevelRef = useRef<{ at: number; level: number }>({ at: 0, level: 0 });

  const [ghost, setGhost] = useState(!puzzle.settings.blindMode);
  const [grid, setGrid] = useState(false);
  const [edgeFocus, setEdgeFocus] = useState(false);
  useEffect(() => {
    setGrid(readJson<boolean>('board:grid', false));
    setEdgeFocus(readJson<boolean>('board:edges', false));
  }, []);
  const updateGrid = useCallback((enabled: boolean) => {
    setGrid(enabled);
    writeJson('board:grid', enabled);
  }, []);
  const updateEdges = useCallback((enabled: boolean) => {
    setEdgeFocus(enabled);
    writeJson('board:edges', enabled);
  }, []);

  const [milestone, setMilestone] = useState<number | null>(null);
  const celebrated = useRef(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);

  const [now, setNow] = useState(() => Date.now());

  // Undo is offered once you have done something undoable, and taken away again
  // when the journal empties. The server owns the real journal — a refusal comes
  // back as a readable message rather than a silently dead button.
  const [acted, setActed] = useState(false);
  /**
   * How many undos are waiting to be redone.
   *
   * The local engine cannot answer this: only the server ever runs `undo`, so the
   * client's own redo stack is permanently empty. So we count. Up on an undo, down
   * on a redo, and back to zero on any fresh action — which mirrors the server,
   * where committing a new action clears the redo stack.
   */
  const [redoDepth, setRedoDepth] = useState(0);

  /** "Look here" has been asked for and is waiting for a spot on the board. */
  const [pingArmed, setPingArmed] = useState(false);
  const [stickerArmed, setStickerArmed] = useState<string | null>(null);

  // Sound starts on and is corrected after mount, because the stored preference
  // and `prefers-reduced-motion` both live in the browser and the server renders
  // this first. Same shape as `useReducedMotion`.
  const [sound, setSound] = useState(true);

  const { send, players, myId, stats, connection, notice, dismissNotice, subscribe } = session;
  const complete = session.phase === 'complete' || stats.complete;

  useEffect(() => setSound(soundEnabled()), []);

  // Browser Fullscreen APIs can be denied (especially on iOS). A fixed canvas
  // surface works consistently and hides the room chrome on every device.
  const toggleFullscreen = useCallback(() => {
    setFullscreen(active => !active);
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setFullscreen(false);
      }
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [fullscreen]);

  useEffect(() => {
    const id = requestAnimationFrame(() => rendererRef.current?.resize());
    return () => cancelAnimationFrame(id);
  }, [fullscreen]);

  /* --- the clock ---------------------------------------------------------- */

  useEffect(() => {
    if (complete) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [complete]);

  const elapsed = engine.elapsedMs(now);

  // Co-op milestones are a small celebration, not a modal that steals input.
  useEffect(() => {
    const mark = Math.floor(stats.progress * 4);
    if (mark < 1 || mark > 3 || mark <= celebrated.current) return;
    celebrated.current = mark;
    setMilestone(mark * 25);
    const timer = window.setTimeout(() => setMilestone(null), 2200);
    return () => window.clearTimeout(timer);
  }, [stats.progress]);

  /* --- actions ------------------------------------------------------------ */

  const react = useCallback(
    (emoji: string) => {
      session.reactNow(emoji, pointerRef.current.x, pointerRef.current.y);
    },
    [session.reactNow],
  );

  /**
   * Arm "look here" rather than firing it.
   *
   * The old behaviour sent the ping at wherever the mouse happened to be last,
   * which for a toolbar click is the toolbar, and on a touchscreen is nowhere in
   * particular. Now the button asks for a spot and the next tap on the board
   * chooses it. Pressing it again backs out, so the same button and the same
   * shortcut both toggle.
   */
  const ping = useCallback(() => {
    if (complete) return;
    setPingArmed((armed) => !armed);
  }, [complete]);

  const placeSticker = useCallback((symbol: string, point: {x: number; y: number}) => {
    setStickerArmed(null);
    session.stickerNow(symbol,point.x,point.y);
  }, [session.stickerNow]);

  const placePing = useCallback(
    (point: { x: number; y: number } | null) => {
      setPingArmed(false);
      if (point) send({ t: 'ping', x: point.x, y: point.y });
    },
    [send],
  );

  const hint = useCallback(() => {
    // No artificial timer or disabled-button interval: feedback is painted
    // immediately and the transport flushes the authoritative action.
    // Track the level in a ref so rapid successive taps never read stale
    // React state and accidentally request the same level twice.
    const now = Date.now();
    const previous = hintLevelRef.current;
    const serverLevel = session.hint?.playerId === myId ? session.hint.level : 0;
    const activeLevel = now - previous.at < 9000 ? previous.level : 0;
    const level = Math.min(4, Math.max(serverLevel, activeLevel) + 1) as 1 | 2 | 3 | 4;
    hintLevelRef.current = { at: now, level: level === 4 ? 0 : level };
    session.previewHint(level);
    send({ t: 'hint', level });
    session.flush();
  }, [myId, send, session.flush, session.hint, session.previewHint]);

  const undo = useCallback(() => {
    send({ t: 'undo' });
    setRedoDepth((depth) => depth + 1);
  }, [send]);

  const redo = useCallback(() => {
    send({ t: 'redo' });
    setRedoDepth((depth) => Math.max(0, depth - 1));
  }, [send]);

  /** A fresh action makes Undo available and drops anything waiting to be redone. */
  const noteAction = useCallback(() => {
    setActed(true);
    setRedoDepth(0);
  }, []);

  const toggleSound = useCallback((value: boolean) => {
    setSoundEnabled(value);
    setSound(value);
  }, []);

  /* --- keyboard (spec §26) ------------------------------------------------ */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const renderer = rendererRef.current;
      const mod = event.metaKey || event.ctrlKey;

      if (mod && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && (event.key === 'y' || event.key === 'Y')) {
        event.preventDefault();
        redo();
        return;
      }
      if (mod) return;

      switch (event.key) {
        case '+':
        case '=':
          renderer?.zoomBy(1.25);
          break;
        case '-':
        case '_':
          renderer?.zoomBy(1 / 1.25);
          break;
        case '0':
        case 'f':
        case 'F':
          renderer?.fit();
          break;
        case 'c':
        case 'C':
          renderer?.centerPuzzle();
          break;
        case 'p':
        case 'P':
          setPreviewOpen((open) => !open);
          break;
        case 'h':
        case 'H':
          hint();
          break;
        case 'l':
        case 'L':
          ping();
          break;
        case 'Escape':
          setPreviewOpen(false);
          setPingArmed(false);
          break;
        default:
          return;
      }
      event.preventDefault();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hint, ping, redo, undo]);

  /* --- undo availability -------------------------------------------------- */

  useEffect(() => {
    // A rejoining player may already have an authoritative undo journal.
    // Initialize controls from the restored engine, not only from future events.
    setActed(engine.canUndo(myId));
    setRedoDepth(engine.canRedo(myId) ? 1 : 0);
    return subscribe(() => {
      setActed(engine.canUndo(myId));
      setRedoDepth(engine.canRedo(myId) ? 1 : 0);
    });
  }, [engine, myId, subscribe]);

  const roster = useMemo(() => players.filter(p=>!p.spectator)
    .sort((a,b)=>a.joinedAt-b.joinedAt), [players]);

  /* ---------------------------------------------------------------------- */

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* ---- chrome ------------------------------------------------------- */}
      {/* In landscape the notch sits over the left edge, which is exactly where the
          logo and the leave button live — hence the inset-aware padding. */}
      <header
        className="flex shrink-0 items-center gap-2 sm:gap-3 border-b border-[var(--line)] py-2"
        style={{
          paddingLeft: 'max(0.75rem, env(safe-area-inset-left))',
          paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
        }}
      >
        <Logo size={26} showWord={false} />

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-[var(--fg)]">{puzzle.title}</p>
          <div className="mt-1 flex items-center gap-2">
            <div
              className="h-1 min-w-16 flex-1 overflow-hidden rounded-full bg-[var(--surface-inset)]"
              role="progressbar"
              aria-valuenow={Math.round(stats.progress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Puzzle progress"
            >
              <div
                className="h-full rounded-full transition-[width] duration-300 ease-[var(--ease-out-soft)]"
                style={{
                  width: `${Math.max(1, stats.progress * 100)}%`,
                  background: 'var(--accent)',
                }}
              />
            </div>
            <span className="num shrink-0 text-2xs text-[var(--fg-subtle)]">
              {stats.placed}/{stats.total}
            </span>
          </div>
        </div>

        <p className="num hidden shrink-0 tabular text-sm text-[var(--fg-muted)] sm:block" aria-label="Time played">
          {formatDuration(elapsed)}
        </p>

        {/* The full rail is a panel on the board at large sizes; here it shrinks
            to the thing that matters on a phone — who is present. */}
        <ul className="flex shrink-0 items-center gap-1 lg:hidden">
          {roster.map((player) => (
            <li key={player.id}>
              <Avatar player={player} away={!player.connected} size={26} />
            </li>
          ))}
        </ul>

        <ConnectionBadge status={connection} className="shrink-0" />
        <IconButton label="Puzzle only fullscreen" onClick={() => void toggleFullscreen()} className="shrink-0">
          <Icon name="maximize" size={19} />
        </IconButton>


      </header>

      {/* ---- board ------------------------------------------------------- */}
      <div className="relative min-h-0 flex-1">
        <div ref={fullscreenRef} className={fullscreen
          ? "fixed inset-0 z-[100] h-[100dvh] w-screen overflow-hidden bg-[var(--bg-deep)]"
          : "relative size-full overflow-hidden bg-[var(--bg-deep)]"}>
          <PuzzleBoard
          session={session}
          engine={engine}
          atlas={atlas}
          image={image}
          rendererRef={rendererRef}
          pointerRef={pointerRef}
          reducedMotion={reducedMotion}
          ghost={ghost}
          grid={grid}
          edgeFocus={edgeFocus}
          frozen={complete || Boolean(session.me?.spectator)}
          pingArmed={pingArmed}
          stickerArmed={stickerArmed}
          onPlaceSticker={placeSticker}
          onPlacePing={placePing}
          onError={setBoardError}
          onActed={noteAction}
        />
        {fullscreen && <button type="button" onClick={() => void toggleFullscreen()}
          className="absolute right-3 top-3 z-50 grid size-11 place-items-center rounded-xl border border-[var(--line)] bg-[var(--surface)]/90 text-[var(--fg)] shadow-md transition hover:bg-[var(--surface-inset)] active:scale-95"
          aria-label="Exit puzzle fullscreen" title="Exit fullscreen">
          <Icon name="minimize" size={20} />
        </button>}
        </div>

        <ConnectionBanner status={connection} />
        {milestone !== null && (
          <div role="status" className="pointer-events-none absolute left-1/2 top-16 z-30 -translate-x-1/2 rounded-full bg-[var(--accent-soft)] px-5 py-2 text-sm font-semibold shadow-lg">
            {milestone}% together! Keep going
          </div>
        )}

        <div className="panel absolute top-3 left-3 hidden w-52 p-2 lg:block">
          <PresenceRail players={roster} myId={myId} variant="board" />
        </div>

        <Minimap
          engine={engine}
          rendererRef={rendererRef}
          subscribe={subscribe}
          className="absolute top-3 right-3 hidden sm:block"
        />

        {/* Held-open reference. A modal would be wrong: people want to glance at
            the picture while their other hand is still on a piece. */}
        {previewOpen ? (
          <div className="animate-fade-in absolute inset-0 z-20 grid place-items-center bg-[color-mix(in_oklab,var(--bg-deep)_78%,transparent)] p-6">
            <div className="card relative max-h-full max-w-2xl overflow-hidden">
              <img
                src={puzzle.image.url}
                alt={`Reference picture: ${puzzle.image.title}`}
                className="block max-h-[70vh] w-full object-contain"
              />
              <IconButton
                label="Close the picture"
                variant="secondary"
                className="absolute top-2 right-2"
                onClick={() => setPreviewOpen(false)}
              >
                <Icon name="close" size={18} />
              </IconButton>
            </div>
          </div>
        ) : null}

        <BoardToolbar
          rendererRef={rendererRef}
          previewOpen={previewOpen}
          onPreview={() => setPreviewOpen((open) => !open)}
          onHint={hint}
          hintsUsed={stats.hintsUsed}
          hintBusy={false}
          canUndo={acted}
          canRedo={redoDepth > 0}
          onUndo={undo}
          onRedo={redo}
          onReact={react}
          onSticker={setStickerArmed}
          onPing={ping}
          pingArmed={pingArmed}
          ghost={ghost}
          onGhost={setGhost}
          grid={grid}
          onGrid={updateGrid}
          edgeFocus={edgeFocus}
          onEdgeFocus={updateEdges}
          sound={sound}
          onSound={toggleSound}
          onLeave={onLeave}
          hidden={complete || Boolean(session.me?.spectator)}
        />

        {/* ---- messages ---------------------------------------------------- */}
        {/* Bottom-anchored, so the safe-area padding lifts the stack clear of the
            toolbar rather than hiding underneath it. */}
        <div className="pb-safe pointer-events-none absolute inset-x-0 bottom-18 z-20 flex flex-col items-center gap-2 px-3">
          {pingArmed ? (
            <p className="panel animate-rise px-3 py-2 text-xs" role="status" aria-live="polite">
              <Icon
                name="pin"
                size={14}
                style={{ color: 'var(--color-butter-400)', marginRight: 6 }}
              />
              Tap the spot you want to point at.{' '}
              <span className="text-[var(--fg-subtle)]">Esc to cancel</span>
            </p>
          ) : null}

          {session.hint ? (
            <p className="panel animate-rise px-3 py-2 text-xs" role="status" aria-live="polite">
              <Icon
                name="bulb"
                size={14}
                style={{ color: 'var(--color-butter-400)', marginRight: 6 }}
              />
              {hintSentence(
                session.hint.level,
                session.hint.region,
                session.hint.playerId === myId
                  ? null
                  : (players.find((p) => p.id === session.hint?.playerId)?.name ?? 'Your friend'),
              )}
            </p>
          ) : null}

          {notice ? (
            <div
              className="panel animate-rise pointer-events-auto flex items-center gap-2 px-3 py-2 text-xs"
              role="status"
              aria-live="polite"
            >
              <span className="text-[var(--fg)]">{notice}</span>
              <button
                type="button"
                onClick={dismissNotice}
                aria-label="Dismiss"
                className="rounded-sm text-[var(--fg-subtle)] hover:text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none"
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ) : null}
        </div>

        {/* A board that cannot draw is not something to paper over. */}
        {boardError ? (
          <div className="absolute inset-0 z-30 grid place-items-center bg-[var(--bg-deep)] p-6">
            <div className="card max-w-sm p-5 text-center">
              <h2 className="text-lg">The board could not open</h2>
              <p className="mt-2 text-sm text-[var(--fg-muted)]">{boardError}</p>
              <Button variant="secondary" className="mt-4" onClick={() => location.reload()}>
                <Icon name="again" size={17} />
                Try again
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {solo ? null : (
        <p className="sr-only" aria-live="polite">
          {players.filter((p) => p.connected).length} of {players.length} players connected.
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The words for each hint level (spec §17).
 *
 * A hint the other person asked for is still worth showing — it is half of
 * knowing what your friend is doing — but it is reported rather than addressed
 * to you, so nobody follows an instruction meant for someone else.
 */
function hintSentence(level: number, region: string, byName: string | null): string {
  if (byName) {
    if (level <= 2) return `${byName} is looking around ${region}.`;
    if (level === 3) return `${byName} asked where that piece goes.`;
    return `${byName} used a hint to place a piece.`;
  }
  if (level <= 1) return `Try looking around ${region}.`;
  if (level === 2) return `The piece you want is somewhere in ${region}.`;
  if (level === 3) return 'That one — it belongs in the highlighted spot.';
  return 'Placed it for you. That one was hiding.';
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}
