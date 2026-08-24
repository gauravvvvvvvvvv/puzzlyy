'use client';

/**
 * The room, end to end.
 *
 * One component decides which of the three screens a person is looking at —
 * waiting room, board, results — and owns the two things that outlive all of
 * them: the session (seat, transport, authoritative engine) and the sprite atlas.
 *
 * The atlas is the reason this split exists. Cutting 500 shaped pieces costs
 * real time, so it starts the moment the puzzle is known — during the lobby, or
 * during the join for someone arriving mid-game — and is deliberately *not*
 * remounted when the phase changes. Putting the cut inside the board would mean
 * re-cutting it on every restart and every reconnect.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';

import { Button, ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Logo } from '@/components/site/Logo';
import { Lobby } from '@/features/lobby/Lobby';
import { Completion } from '@/features/puzzle/Completion';
import { PuzzleRoom } from '@/features/puzzle/PuzzleRoom';
import { usePieceAtlas } from '@/hooks/usePieceAtlas';
import { useRoomSession } from '@/hooks/useRoomSession';
import { markPlayed, recordCompletion, rememberPuzzle } from '@/lib/storage/library';
import { clearLastRoom, clearSeat } from '@/lib/storage/seats';

export interface RoomClientProps {
  code: string;
  /** `?solo=1` — one player, same engine, no waiting room (spec §21). */
  solo: boolean;
}

export function RoomClient({ code, solo }: RoomClientProps) {
  const router = useRouter();
  const session = useRoomSession(code);
  const { phase, room, puzzle, engine, players, me, myId, isHost, connection, result, stats } =
    session;
  const { send, flush } = session;

  /* --- cutting the pieces -------------------------------------------------- */

  const geometry = engine?.geometry ?? null;

  // The URL is withheld until the geometry exists. `usePieceAtlas` keys its work
  // on the URL and the cut, so a picture that arrived a render before its
  // geometry would be seen once, skipped, and never picked up again.
  const imageUrl = geometry && puzzle ? puzzle.image.url : null;
  const cutKey = puzzle ? `${puzzle.id}:${puzzle.seed}` : '';
  const cut = usePieceAtlas(imageUrl, geometry, cutKey);

  /* --- solo: skip the waiting room ---------------------------------------- */

  // A rematch re-seeds the puzzle and drops the room back to the lobby, so this
  // is keyed on the seed rather than latched once.
  const autoStartedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!solo || !isHost || phase !== 'lobby' || !puzzle) return;
    if (!cut.atlas) return;
    if (autoStartedRef.current === puzzle.seed) return;
    autoStartedRef.current = puzzle.seed;
    // Ready then start: the host may force a start on their own, so a solo room
    // needs no second player to become playable.
    send({ t: 'ready', ready: true });
    send({ t: 'start' });
    flush();
  }, [cut.atlas, flush, isHost, phase, puzzle, send, solo]);

  /* --- My Puzzles ---------------------------------------------------------- */

  useEffect(() => {
    if (phase !== 'playing' || !puzzle) return;
    // The joining friend has never seen this puzzle before, so it is remembered
    // rather than only marked — otherwise "My Puzzles" would work for one of
    // the two people playing.
    rememberPuzzle({ puzzle, roomCode: code });
    markPlayed(puzzle.id, code);
  }, [code, phase, puzzle]);

  const recordedRef = useRef<string | null>(null);

  useEffect(() => {
    if (phase !== 'complete' || !result) return;
    const key = `${result.puzzleId}:${result.completedAt}`;
    if (recordedRef.current === key) return;
    recordedRef.current = key;
    recordCompletion(result.puzzleId, result.durationMs);
  }, [phase, result]);

  /* --- actions ------------------------------------------------------------- */

  const leave = useCallback(() => {
    send({ t: 'bye' });
    flush();
    // Leaving is a decision, not a disconnect: the seat is given up so the room
    // does not offer to resume something the player walked away from.
    clearSeat(code);
    clearLastRoom();
    router.push('/');
  }, [code, flush, router, send]);

  const ready = useCallback((value: boolean) => send({ t: 'ready', ready: value }), [send]);
  const start = useCallback(() => {
    send({ t: 'start' });
    flush();
  }, [flush, send]);
  const playAgain = useCallback(() => {
    send({ t: 'restart' });
    flush();
  }, [flush, send]);

  const cutting = useMemo(
    () => ({
      progress: cut.progress,
      ready: cut.atlas !== null,
      error: cut.error,
    }),
    [cut.atlas, cut.error, cut.progress],
  );

  /* --- screens ------------------------------------------------------------- */

  if (phase === 'error') {
    return (
      <Curtain
        title="That room is not open"
        body={session.fatal ?? 'Something went wrong on the way in.'}
      >
        <ButtonLink href="/play" variant="primary">
          <Icon name="jigsaw" size={18} />
          Start a new puzzle
        </ButtonLink>
        <ButtonLink href="/join" variant="ghost">
          Try another code
        </ButtonLink>
      </Curtain>
    );
  }

  if (phase === 'joining' || !room || !puzzle || !engine) {
    return <Curtain title="Getting you a seat…" body="Finding the room and catching up." spinner />;
  }

  if (phase === 'complete') {
    if (!result) {
      return <Curtain title="Adding up the results…" body="One moment." spinner />;
    }
    return (
      <div className="min-h-[100dvh] overflow-y-auto">
        <Completion
          result={result}
          roomCode={room.code}
          myId={myId}
          sections={stats.sections}
          solo={result.players.length < 2}
          onPlayAgain={playAgain}
          canPlayAgain={isHost}
        />
      </div>
    );
  }

  if (phase === 'playing') {
    if (cut.error) {
      return (
        <Curtain title="That picture would not cut" body={cut.error}>
          <Button variant="primary" onClick={() => location.reload()}>
            <Icon name="again" size={18} />
            Try again
          </Button>
          <ButtonLink href="/play" variant="ghost">
            Pick another picture
          </ButtonLink>
        </Curtain>
      );
    }
    if (!cut.atlas) {
      return (
        <Curtain
          title={`Cutting ${puzzle.pieceCount} pieces…`}
          body="Shaping every tab and notch. This only happens once."
          progress={cut.progress}
        />
      );
    }
    return (
      <PuzzleRoom
        session={session}
        engine={engine}
        puzzle={puzzle}
        atlas={cut.atlas}
        image={cut.image}
        solo={players.length < 2}
        onLeave={leave}
      />
    );
  }

  // Lobby. A solo player never sees it — they are already being started above,
  // so showing them an invite panel for a beat would be a small lie.
  if (solo) {
    return (
      <Curtain
        title={cutting.ready ? 'Setting up your board…' : `Cutting ${puzzle.pieceCount} pieces…`}
        body="Yours alone. No one else can wander in."
        progress={cut.progress}
      />
    );
  }

  return (
    <div className="min-h-[100dvh] overflow-y-auto">
      <Lobby
        room={room}
        puzzle={puzzle}
        players={players}
        me={me}
        myId={myId}
        isHost={isHost}
        connection={connection}
        cutProgress={cutting.progress}
        cutReady={cutting.ready}
        cutError={cutting.error}
        solo={false}
        onReady={ready}
        onStart={start}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Every between-state in the room, with the same shape.
 *
 * Joining, cutting and failing all deserve a real sentence rather than a bare
 * spinner — this is the screen a friend stares at while they wait to play, so it
 * says what is happening and roughly how far along it is.
 */
function Curtain({
  title,
  body,
  progress,
  spinner = false,
  children,
}: {
  title: string;
  body: string;
  progress?: number;
  spinner?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="grid min-h-[100dvh] place-items-center px-6 py-10">
      <div className="animate-rise w-full max-w-sm text-center">
        <div className="flex justify-center">
          <Logo size={34} />
        </div>

        <h1 className="mt-6 text-xl leading-tight text-[var(--fg)]" aria-live="polite">
          {title}
        </h1>
        <p className="mt-2 text-sm text-[var(--fg-muted)]">{body}</p>

        {progress !== undefined ? (
          <div
            className="mt-5 h-1.5 overflow-hidden rounded-full bg-[var(--surface-inset)]"
            role="progressbar"
            aria-valuenow={Math.round(progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Preparing the pieces"
          >
            <div
              className="h-full rounded-full transition-[width] duration-200 ease-[var(--ease-out-soft)]"
              style={{ width: `${Math.max(3, progress * 100)}%`, background: 'var(--accent)' }}
            />
          </div>
        ) : null}

        {spinner ? (
          <div
            aria-hidden="true"
            className="mx-auto mt-5 size-6 animate-spin rounded-full border-2 border-[var(--line-strong)] border-t-[var(--accent)]"
          />
        ) : null}

        {children ? (
          <div className="mt-6 flex flex-col items-center gap-2">{children}</div>
        ) : null}
      </div>
    </div>
  );
}
