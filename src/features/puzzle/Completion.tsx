'use client';

/**
 * The results screen (spec §20).
 *
 * The moment worth designing for: two people just finished something together.
 * So the picture they made is the biggest thing here, the time is the headline,
 * and the split of who placed what is stated without turning it into a
 * leaderboard — it says "you did this together", not "you won".
 *
 * The celebration is deliberately small. A single rise, one line of confetti
 * behaviour in the renderer behind it, and nothing that has to be waited out
 * before the buttons work (spec §20: "not excessive confetti").
 */

import { useState } from 'react';

import { Button, ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Avatar } from '@/features/multiplayer/PresenceRail';
import { useClipboard } from '@/hooks/useClipboard';
import { formatDuration, spellDuration } from '@/lib/format';
import { playerColor } from '@/lib/multiplayer/identity';
import { ApiError, createChallenge } from '@/lib/realtime/api';
import type { SessionResult } from '@/types/models';

export interface CompletionProps {
  result: SessionResult;
  roomCode: string;
  myId: string;
  sections: number;
  solo: boolean;
  /** Same picture, fresh scramble. Host-only in a shared room. */
  onPlayAgain: () => void;
  canPlayAgain: boolean;
}

export function Completion({
  result,
  roomCode,
  myId,
  sections,
  solo,
  onPlayAgain,
  canPlayAgain,
}: CompletionProps) {
  const { copied, copy, canShare, share } = useClipboard();
  const [challenge, setChallenge] = useState<{ url: string } | null>(null);
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const players = [...result.players].sort((a, b) => b.connections - a.connections);
  const summary = summaryLine(result, solo);

  async function makeChallenge() {
    setBusy(true);
    setChallengeError(null);
    try {
      const { path } = await createChallenge(roomCode, myId);
      const url = `${window.location.origin}${path}`;
      setChallenge({ url });
      await (canShare
        ? share(
            {
              title: 'Puzzly',
              text: `We solved “${result.puzzleTitle}” in ${formatDuration(result.durationMs)}. Beat that.`,
              url,
            },
            'challenge',
          )
        : copy(url, 'challenge'));
    } catch (cause) {
      setChallengeError(
        cause instanceof ApiError
          ? cause.message
          : 'Could not build a challenge link. Try again in a moment.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-5 px-4 py-8 lg:grid-cols-[1.1fr_1fr] lg:py-12">
      {/* ---- the picture they made --------------------------------------- */}
      <section className="animate-rise card overflow-hidden">
        <div className="relative aspect-[4/3] w-full" style={{ background: 'var(--surface-inset)' }}>
          <img
            src={result.imageUrl}
            alt={result.puzzleTitle}
            className="size-full object-cover"
            decoding="async"
          />
        </div>
        <div className="p-5">
          <h1 className="text-xl leading-tight">{result.puzzleTitle}</h1>
          <p className="mt-1 text-sm text-[var(--fg-muted)]">{summary}</p>
        </div>
      </section>

      {/* ---- the numbers -------------------------------------------------- */}
      <section className="flex flex-col gap-4">
        <div className="animate-rise">
          <p className="eyebrow">Puzzle complete 🎉</p>
          <p className="num mt-1 text-5xl leading-none tracking-tight text-[var(--fg)]">
            {formatDuration(result.durationMs)}
          </p>
          <p className="mt-1.5 text-sm text-[var(--fg-muted)]">
            {spellDuration(result.durationMs)} · {result.pieceCount} pieces
          </p>
        </div>

        <dl className="grid grid-cols-3 gap-2">
          <Stat label="Pieces" value={result.pieceCount} />
          <Stat label="Sections" value={sections} />
          <Stat label="Hints" value={result.hintsUsed} />
        </dl>

        {/* Who placed what. Bars rather than a table, because the shape of the
            collaboration is the interesting part. */}
        <div className="card p-4">
          <p className="eyebrow">{solo ? 'Your run' : 'Between you'}</p>
          <ul className="mt-3 flex flex-col gap-2.5">
            {players.map((player) => (
              <li key={player.id} className="flex items-center gap-2.5">
                <Avatar
                  player={{
                    id: player.id,
                    name: player.name,
                    avatar: player.avatar,
                    colorId: player.colorId,
                    isHost: false,
                    ready: true,
                    connected: true,
                    joinedAt: 0,
                    lastSeenAt: 0,
                    connections: player.connections,
                  }}
                  size={28}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="truncate text-[var(--fg)]">
                      {player.name}
                      {player.id === myId ? (
                        <span className="ml-1 text-[var(--fg-subtle)]">(you)</span>
                      ) : null}
                    </span>
                    <span className="num shrink-0 text-[var(--fg-muted)]">
                      {player.connections} · {Math.round(player.share * 100)}%
                    </span>
                  </p>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--surface-inset)]">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(2, player.share * 100)}%`,
                        background: playerColor(player.colorId),
                      }}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* ---- what next --------------------------------------------------- */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
              variant="primary"
              onClick={onPlayAgain}
              disabled={!canPlayAgain}
              className="flex-1"
            >
              <Icon name="again" size={20} />
              Play again
            </Button>
            <ButtonLink href="/play" size="lg" variant="secondary" className="flex-1">
              <Icon name="plus" size={20} />
              New puzzle
            </ButtonLink>
          </div>

          {!canPlayAgain ? (
            <p className="text-2xs text-[var(--fg-subtle)]" role="status">
              Only the host can restart. Ask them for another round.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => void makeChallenge()} disabled={busy}>
              <Icon name="flag" size={17} />
              {busy
                ? 'Building…'
                : copied === 'challenge'
                  ? 'Challenge copied!'
                  : 'Challenge a friend'}
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                void copy(
                  `We solved “${result.puzzleTitle}” (${result.pieceCount} pieces) in ${formatDuration(result.durationMs)} on Puzzly.`,
                  'result',
                )
              }
            >
              <Icon name={copied === 'result' ? 'check' : 'share'} size={17} />
              {copied === 'result' ? 'Copied!' : 'Share result'}
            </Button>
          </div>

          {challenge ? (
            <p className="text-2xs break-all text-[var(--fg-subtle)]">
              Challenge link: <span className="num">{challenge.url}</span>
            </p>
          ) : null}
          {challengeError ? (
            <p role="alert" className="text-2xs text-[var(--color-danger-400)]">
              {challengeError}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card px-3 py-2.5">
      <dt className="text-2xs text-[var(--fg-subtle)]">{label}</dt>
      <dd className="num text-lg text-[var(--fg)]">{value}</dd>
    </div>
  );
}

/** One sentence about what just happened, in plain words. */
function summaryLine(result: SessionResult, solo: boolean): string {
  if (solo) {
    return result.hintsUsed
      ? `Solved on your own, with ${result.hintsUsed} hint${result.hintsUsed === 1 ? '' : 's'}.`
      : 'Solved on your own, no hints.';
  }
  const names = result.players.map((p) => p.name);
  const people =
    names.length === 2
      ? `${names[0]} and ${names[1]}`
      : names.length > 2
        ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
        : (names[0] ?? 'You');
  return `${people} put this back together.`;
}
