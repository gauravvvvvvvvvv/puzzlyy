'use client';

/**
 * "Beat my time" (spec §22).
 *
 * The whole point of a challenge link is that it works on a phone, from a chat
 * app, with no account and no explanation — so this page has one sentence, one
 * picture, and one obvious button. The time to beat is the headline because it is
 * the only reason the link was sent.
 *
 * A challenge outlives the room it came from but not forever. When the original
 * cut has been swept the page says so plainly and offers the next best thing
 * rather than a dead end.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button, ButtonLink, Pill } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Logo } from '@/components/site/Logo';
import { DIFFICULTY_LABEL, difficultyFor, formatDuration, spellDuration } from '@/lib/format';
import { ApiError, createRoom, fetchChallenge } from '@/lib/realtime/api';
import { rememberPuzzle } from '@/lib/storage/library';
import type { Challenge, Puzzle } from '@/types/models';

export interface ChallengeLandingProps {
  id: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; challenge: Challenge; puzzle: Puzzle | null };

export function ChallengeLanding({ id }: ChallengeLandingProps) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [accepting, setAccepting] = useState<'solo' | 'shared' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchChallenge(id)
      .then(({ challenge, puzzle }) => {
        if (!cancelled) setState({ kind: 'ready', challenge, puzzle });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          kind: 'error',
          message:
            cause instanceof ApiError
              ? cause.message
              : 'That challenge link could not be opened. It may have expired.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  const accept = useCallback(
    async (mode: 'solo' | 'shared') => {
      if (state.kind !== 'ready' || !state.puzzle || accepting) return;
      setAccepting(mode);
      setFailure(null);
      try {
        // The same picture, the same settings, a fresh scramble — that is what
        // makes the times comparable.
        const { code, view } = await createRoom({
          image: state.puzzle.image,
          settings: state.challenge.settings,
          gameType: state.challenge.gameType,
          title: state.puzzle.title,
          hostCanForceStart: true,
        });
        rememberPuzzle({ puzzle: view.puzzle, roomCode: code });
        router.push(mode === 'solo' ? `/room/${code}?solo=1` : `/room/${code}`);
      } catch (cause) {
        setFailure(
          cause instanceof ApiError
            ? cause.message
            : 'We could not set that up. Check your connection and try again.',
        );
        setAccepting(null);
      }
    },
    [accepting, router, state],
  );

  /* --- between states ------------------------------------------------------ */

  if (state.kind === 'loading') {
    return (
      <Shell>
        <p className="text-sm text-[var(--fg-muted)]" aria-live="polite">
          Opening the challenge…
        </p>
      </Shell>
    );
  }

  if (state.kind === 'error') {
    return (
      <Shell>
        <h1 className="text-xl leading-tight">This challenge has closed</h1>
        <p className="mt-2 text-sm text-[var(--fg-muted)]">{state.message}</p>
        <div className="mt-6 flex flex-col items-center gap-2">
          <ButtonLink href="/play" variant="primary" size="lg">
            <Icon name="jigsaw" size={19} />
            Make your own puzzle
          </ButtonLink>
          <ButtonLink href="/" variant="ghost">
            Back home
          </ButtonLink>
        </div>
      </Shell>
    );
  }

  const { challenge, puzzle } = state;
  const difficulty = DIFFICULTY_LABEL[difficultyFor(challenge.pieceCount, challenge.settings)];

  /* --- the challenge ------------------------------------------------------- */

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-5 px-4 py-8 lg:grid-cols-[1fr_1fr] lg:items-center lg:py-16">
      <section className="animate-rise card overflow-hidden">
        <div className="aspect-[4/3] w-full" style={{ background: 'var(--surface-inset)' }}>
          {puzzle ? (
            <img
              src={puzzle.image.thumbUrl || puzzle.image.url}
              alt={puzzle.title}
              className="size-full object-cover"
              decoding="async"
            />
          ) : (
            <div className="grid size-full place-items-center text-[var(--fg-subtle)]">
              <Icon name="image" size={34} />
            </div>
          )}
        </div>
        {puzzle ? (
          <div className="p-4">
            <p className="truncate text-sm text-[var(--fg)]">{puzzle.title}</p>
          </div>
        ) : null}
      </section>

      <section className="animate-rise">
        <div className="flex items-center gap-2">
          <Logo size={28} showWord={false} />
          <p className="eyebrow">A challenge for you</p>
        </div>

        <h1 className="mt-4 text-2xl leading-tight text-balance">
          <span aria-hidden="true">{challenge.byAvatar} </span>
          {challenge.byName} solved this one.
        </h1>

        <p className="mt-4 text-sm text-[var(--fg-muted)]">Time to beat</p>
        <p className="num text-5xl leading-none tracking-tight text-[var(--fg)]">
          {formatDuration(challenge.timeMs)}
        </p>
        <p className="mt-1.5 text-sm text-[var(--fg-muted)]">
          {spellDuration(challenge.timeMs)} · {challenge.pieceCount} pieces
        </p>

        <div className="mt-4 flex flex-wrap gap-1.5">
          <Pill tone="accent">{difficulty}</Pill>
          <Pill>{challenge.pieceCount} pieces</Pill>
          {challenge.settings.rotation ? <Pill tone="warn">Rotation on</Pill> : null}
        </div>

        {puzzle ? (
          <div className="mt-7 flex flex-col gap-2">
            <Button
              size="lg"
              variant="primary"
              onClick={() => void accept('solo')}
              disabled={accepting !== null}
            >
              <Icon name="play" size={20} />
              {accepting === 'solo' ? 'Setting up…' : 'Take the challenge'}
            </Button>
            <Button
              size="lg"
              variant="secondary"
              onClick={() => void accept('shared')}
              disabled={accepting !== null}
            >
              <Icon name="users" size={20} />
              {accepting === 'shared' ? 'Setting up…' : 'Team up on it instead'}
            </Button>
            <p className="text-2xs text-[var(--fg-subtle)]">
              Same picture, same settings, freshly scrambled. No signup.
            </p>
          </div>
        ) : (
          <div className="mt-7 flex flex-col gap-2">
            <p className="text-sm text-[var(--fg-muted)]">
              The original cut has since been cleared away, so this exact puzzle cannot be
              rebuilt — but the time still stands.
            </p>
            <ButtonLink href="/play" variant="primary" size="lg">
              <Icon name="jigsaw" size={19} />
              Make your own puzzle
            </ButtonLink>
          </div>
        )}

        {failure ? (
          <p role="alert" className="mt-3 text-xs text-[var(--color-danger-400)]">
            {failure}
          </p>
        ) : null}
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-[70vh] place-items-center px-6 py-12">
      <div className="animate-rise w-full max-w-sm text-center">
        <div className="flex justify-center">
          <Logo size={34} />
        </div>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}
