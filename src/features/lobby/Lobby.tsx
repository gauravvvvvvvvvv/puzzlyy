'use client';

/**
 * The waiting room (spec §12).
 *
 * This screen does one job: get a link into a friend's hands and then get out of
 * the way. So the invite is the largest thing on it, the room code is readable
 * out loud over a phone call, and the picture everyone is about to solve is
 * right there — because seeing it is half the anticipation.
 *
 * It is also where the sprite atlas is quietly cut. By the time READY turns
 * green, 500 shaped pieces have already been rasterised, so pressing start opens
 * a board that is instantly playable instead of a progress bar.
 */

import { useEffect, useMemo, useState } from 'react';

import { Button, IconButton, Pill } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { ConnectionBadge } from '@/features/multiplayer/ConnectionBadge';
import { PresenceRail } from '@/features/multiplayer/PresenceRail';
import { useClipboard } from '@/hooks/useClipboard';
import { DIFFICULTY_LABEL, PIECE_COUNT_BLURB } from '@/lib/format';
import type { ConnectionStatus } from '@/types/events';
import type { Player, Puzzle, Room } from '@/types/models';

export interface LobbyProps {
  room: Room;
  puzzle: Puzzle;
  players: Player[];
  me: Player | null;
  myId: string;
  isHost: boolean;
  connection: ConnectionStatus;
  /** 0..1 while the pieces are being cut. */
  cutProgress: number;
  cutReady: boolean;
  cutError: string | null;
  solo: boolean;
  onReady: (ready: boolean) => void;
  onStart: () => void;
}

export function Lobby({
  room,
  puzzle,
  players,
  me,
  myId,
  isHost,
  connection,
  cutProgress,
  cutReady,
  cutError,
  solo,
  onReady,
  onStart,
}: LobbyProps) {
  const { copied, copy, canShare, share } = useClipboard();
  const [inviteUrl, setInviteUrl] = useState('');

  // `location` only exists in the browser, and the URL is the one thing on this
  // page that genuinely cannot be rendered on a server.
  useEffect(() => {
    setInviteUrl(`${window.location.origin}/room/${room.code}`);
  }, [room.code]);

  const alone = players.length < 2;
  const everyoneReady = players.length >= 2 && players.every((p) => p.ready);
  const canStart = isHost && cutReady && (solo || everyoneReady || !alone);

  const blurb = useMemo(
    () => PIECE_COUNT_BLURB[puzzle.settings.pieceCount] ?? '',
    [puzzle.settings.pieceCount],
  );

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-5 px-4 py-8 lg:grid-cols-[1.15fr_1fr] lg:py-14">
      {/* ---- the picture -------------------------------------------------- */}
      <section className="card overflow-hidden">
        <div className="relative aspect-[4/3] w-full" style={{ background: 'var(--surface-inset)' }}>
          <img
            src={puzzle.image.thumbUrl || puzzle.image.url}
            alt={puzzle.image.title}
            className="size-full object-cover"
            decoding="async"
          />
          <div className="absolute top-3 left-3 flex flex-wrap gap-1.5">
            <Pill tone="accent">
              <span className="num">{puzzle.pieceCount}</span> pieces
            </Pill>
            <Pill>{DIFFICULTY_LABEL[puzzle.difficulty]}</Pill>
            {puzzle.settings.rotation ? <Pill tone="warn">Rotation on</Pill> : null}
            {puzzle.settings.blindMode ? <Pill tone="warn">Blind mode</Pill> : null}
          </div>
        </div>

        <div className="p-5">
          <h1 className="text-2xl leading-tight">{puzzle.title}</h1>
          <p className="mt-1 text-sm text-[var(--fg-muted)]">
            {puzzle.cols} × {puzzle.rows} · {blurb}
          </p>
          {puzzle.image.credit ? (
            <p className="mt-2 text-2xs text-[var(--fg-subtle)]">
              Photo by {puzzle.image.credit.authorName} on {puzzle.image.credit.providerName}
            </p>
          ) : null}

          <CutStatus progress={cutProgress} ready={cutReady} error={cutError} total={puzzle.pieceCount} />
        </div>
      </section>

      {/* ---- the invite --------------------------------------------------- */}
      <section className="flex flex-col gap-4">
        {!solo ? (
          <div className="card p-5">
            <p className="eyebrow">Invite your person</p>

            <div className="mt-3 flex items-center gap-2">
              <code
                className="num flex-1 truncate rounded-md border border-[var(--line)] bg-[var(--surface-inset)] px-3 py-2.5 text-sm text-[var(--fg-muted)]"
                title={inviteUrl}
              >
                {inviteUrl || `…/room/${room.code}`}
              </code>
              <IconButton
                label="Copy invite link"
                variant="secondary"
                onClick={() => void copy(inviteUrl, 'link')}
                disabled={!inviteUrl}
              >
                <Icon name={copied === 'link' ? 'check' : 'copy'} size={18} />
              </IconButton>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() =>
                  void (canShare
                    ? share(
                        {
                          title: 'Puzzly',
                          text: `Come solve “${puzzle.title}” with me.`,
                          url: inviteUrl,
                        },
                        'link',
                      )
                    : copy(inviteUrl, 'link'))
                }
                disabled={!inviteUrl}
              >
                <Icon name={canShare ? 'share' : 'link'} size={18} />
                {copied === 'link' ? 'Copied!' : canShare ? 'Share invite' : 'Copy invite link'}
              </Button>

              <Button variant="ghost" onClick={() => void copy(room.code, 'code')}>
                <Icon name={copied === 'code' ? 'check' : 'copy'} size={16} />
                <span className="num tracking-[0.14em]">{room.code}</span>
              </Button>
            </div>

            <p className="mt-3 text-2xs text-[var(--fg-subtle)]">
              They can also go to Puzzly and type <span className="num">{room.code}</span>. No
              account, no download.
            </p>
          </div>
        ) : null}

        {/* ---- who's here ------------------------------------------------- */}
        <div className="card flex-1 p-5">
          <div className="flex items-baseline justify-between">
            <p className="eyebrow">
              {solo ? 'Solo' : alone ? 'Waiting for your friend' : `${players.length} here`}
            </p>
            <ConnectionBadge status={connection} />
          </div>

          <PresenceRail players={players} myId={myId} variant="lobby" className="mt-3" />

          {alone && !solo ? (
            <p className="mt-4 flex items-center gap-2 rounded-md bg-[var(--surface-inset)] px-3 py-2.5 text-xs text-[var(--fg-muted)]">
              <Icon name="users" size={15} />
              The board opens the moment they arrive. You can start alone too.
            </p>
          ) : null}
        </div>

        {/* ---- go --------------------------------------------------------- */}
        <div className="flex flex-col gap-2">
          {!solo ? (
            <Button
              size="lg"
              variant={me?.ready ? 'secondary' : 'primary'}
              onClick={() => onReady(!me?.ready)}
              aria-pressed={me?.ready ?? false}
            >
              <Icon name={me?.ready ? 'check' : 'play'} size={20} />
              {me?.ready ? "You're ready" : "I'm ready"}
            </Button>
          ) : null}

          {isHost ? (
            <Button size="lg" variant="primary" onClick={onStart} disabled={!canStart}>
              <Icon name="sparkle" size={20} />
              {!cutReady
                ? 'Cutting the pieces…'
                : solo || alone
                  ? 'Start solving'
                  : everyoneReady
                    ? 'Start — everyone’s ready'
                    : 'Start anyway'}
            </Button>
          ) : (
            <p
              className="rounded-md border border-[var(--line)] px-3 py-3 text-center text-xs text-[var(--fg-muted)]"
              role="status"
            >
              {everyoneReady
                ? 'Waiting for the host to start…'
                : 'Mark yourself ready and the host will start.'}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The cutting progress bar.
 *
 * Worth its own component because it is the only honest answer to "why is this
 * taking a second" on a 500-piece puzzle, and because it must never block the
 * invite — a friend can be arriving while the pieces are still being cut.
 */
function CutStatus({
  progress,
  ready,
  error,
  total,
}: {
  progress: number;
  ready: boolean;
  error: string | null;
  total: number;
}) {
  if (error) {
    return (
      <p
        role="alert"
        className="mt-4 rounded-md border border-[color-mix(in_oklab,var(--color-danger-500)_40%,transparent)] px-3 py-2 text-xs text-[var(--color-danger-400)]"
      >
        {error}
      </p>
    );
  }

  if (ready) {
    return (
      <p className="mt-4 flex items-center gap-1.5 text-xs text-[var(--color-mint-400)]">
        <Icon name="check" size={14} />
        {total} pieces ready
      </p>
    );
  }

  return (
    <div className="mt-4" role="status" aria-live="polite">
      <div className="flex items-baseline justify-between text-2xs text-[var(--fg-subtle)]">
        <span>Cutting {total} pieces…</span>
        <span className="num">{Math.round(progress * 100)}%</span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--surface-inset)]">
        <div
          className="h-full rounded-full transition-[width] duration-200 ease-[var(--ease-out-soft)]"
          style={{ width: `${Math.max(3, progress * 100)}%`, background: 'var(--accent)' }}
        />
      </div>
    </div>
  );
}
