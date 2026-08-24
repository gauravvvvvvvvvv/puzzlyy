'use client';

/**
 * "My Puzzles" (spec §10).
 *
 * Local to this device, because there are no accounts. That is a feature: the
 * list costs nothing, needs no login, and quietly disappears with the browser
 * profile — which is the right lifetime for a shelf of holiday photos.
 *
 * Rendered empty on the server and filled in after mount, since localStorage does
 * not exist during SSR.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { Button, ButtonLink, Pill } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { DIFFICULTY_LABEL, difficultyFor, formatDuration, formatRelative } from '@/lib/format';
import { measureImage } from '@/lib/images/prepare';
import {
  entryToImage,
  forgetPuzzle,
  libraryStats,
  loadLibrary,
} from '@/lib/storage/library';
import { savePendingImage } from '@/lib/storage/pending';
import type { LibraryEntry } from '@/types/models';

export function PuzzleLibrary() {
  const router = useRouter();
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setEntries(loadLibrary()), []);

  const stats = useMemo(() => libraryStats(entries ?? []), [entries]);

  async function playAgain(entry: LibraryEntry) {
    setBusyId(entry.puzzleId);
    setError(null);
    try {
      const asset = entryToImage(entry);
      const sized =
        asset.width && asset.height ? asset : { ...asset, ...(await measureImage(asset.url)) };
      savePendingImage(sized);
      router.push(`/play?pieces=${entry.pieceCount}`);
    } catch {
      setError('That picture is no longer available. It may have been an upload that expired.');
      setBusyId(null);
    }
  }

  if (entries === null) return <LibrarySkeleton />;

  if (!entries.length) {
    return (
      <div className="card flex flex-col items-center px-6 py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-[var(--surface-inset)] text-[var(--fg-subtle)]">
          <Icon name="grid" size={24} />
        </span>
        <h2 className="mt-5 text-xl">Nothing on the shelf yet</h2>
        <p className="mt-2 max-w-sm text-sm text-[var(--fg-muted)]">
          Every puzzle you cut shows up here, with your best time. Nothing is uploaded to an
          account — this list lives in this browser.
        </p>
        <ButtonLink href="/play" variant="primary" className="mt-6">
          <Icon name="plus" size={18} />
          Make your first one
        </ButtonLink>
      </div>
    );
  }

  return (
    <div>
      <dl className="mb-8 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Puzzles" value={String(stats.total)} />
        <Stat label="Finished" value={String(stats.played)} />
        <Stat
          label="Best time"
          value={stats.bestTimeMs === null ? '—' : formatDuration(stats.bestTimeMs)}
        />
        <Stat
          label="Favourite size"
          value={stats.favouriteCount ? `${stats.favouriteCount} pcs` : '—'}
        />
      </dl>

      {error ? (
        <p
          role="alert"
          className="mb-5 rounded-md border border-[color-mix(in_oklab,var(--color-danger-500)_40%,transparent)] px-3 py-2 text-sm text-[var(--color-danger-400)]"
        >
          {error}
        </p>
      ) : null}

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => (
          <li key={entry.puzzleId} className="card overflow-hidden">
            <div
              className="relative aspect-[4/3] w-full"
              style={{ background: 'var(--surface-inset)' }}
            >
              <img
                src={entry.thumbUrl || entry.imageUrl}
                alt={entry.title}
                loading="lazy"
                decoding="async"
                className="size-full object-cover"
              />
              {entry.bestTimeMs !== null ? (
                <span className="absolute top-2 left-2">
                  <Pill tone="good">
                    <Icon name="clock" size={12} />
                    <span className="num">{formatDuration(entry.bestTimeMs)}</span>
                  </Pill>
                </span>
              ) : null}
            </div>

            <div className="p-4">
              <h3 className="truncate text-base">{entry.title}</h3>
              <p className="num mt-1 text-2xs text-[var(--fg-subtle)]">
                {entry.pieceCount} pieces ·{' '}
                {DIFFICULTY_LABEL[difficultyFor(entry.pieceCount, entry.settings)]}
                {entry.timesPlayed > 0
                  ? ` · played ${entry.timesPlayed}×`
                  : ' · not finished yet'}
              </p>
              <p className="mt-0.5 text-2xs text-[var(--fg-subtle)]">
                {entry.lastPlayedAt
                  ? `Last played ${formatRelative(entry.lastPlayedAt)}`
                  : `Made ${formatRelative(entry.createdAt)}`}
              </p>

              <div className="mt-4 flex items-center gap-1.5">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busyId === entry.puzzleId}
                  onClick={() => void playAgain(entry)}
                >
                  <Icon name="again" size={15} />
                  {busyId === entry.puzzleId ? 'Opening…' : 'Play again'}
                </Button>
                {entry.lastRoomCode ? (
                  <Link
                    href={`/room/${entry.lastRoomCode}`}
                    className="rounded-sm px-2 py-1 text-2xs text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                  >
                    Last room
                  </Link>
                ) : null}
                <span className="flex-1" />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${entry.title}`}
                  title="Remove from this list"
                  className="w-9 px-0"
                  onClick={() => setEntries(forgetPuzzle(entry.puzzleId))}
                >
                  <Icon name="trash" size={15} />
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <dt className="text-2xs text-[var(--fg-subtle)]">{label}</dt>
      <dd className="num mt-1 text-xl text-[var(--fg)]">{value}</dd>
    </div>
  );
}

function LibrarySkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse">
      <div className="mb-8 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-20 rounded-lg bg-[var(--surface-inset)]" />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="h-72 rounded-lg bg-[var(--surface-inset)]" />
        ))}
      </div>
    </div>
  );
}
