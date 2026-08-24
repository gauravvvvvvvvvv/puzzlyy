'use client';

/**
 * Create a room (spec §7–§13).
 *
 * Two decisions and one button. The picture comes first because it is the part
 * people care about; difficulty is a row of chips, not a form. Nothing here asks
 * for a name, an email or an account — the whole point is that the next screen is
 * a link you can paste to someone.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { ImagePicker } from '@/features/images/ImagePicker';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { DIFFICULTY_LABEL, PIECE_COUNT_BLURB, difficultyFor } from '@/lib/format';
import { ApiError, createRoom } from '@/lib/realtime/api';
import { rememberPuzzle } from '@/lib/storage/library';
import { takePendingImage } from '@/lib/storage/pending';
import {
  DEFAULT_PUZZLE_SETTINGS,
  PIECE_COUNTS,
  type ImageAsset,
  type PieceCount,
  type PuzzleSettings,
} from '@/types/models';

function pieceCountFromParam(raw: string | null): PieceCount | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return PIECE_COUNTS.find((count) => count === parsed) ?? null;
}

export function CreateRoomFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const solo = params.get('solo') === '1';

  const [image, setImage] = useState<ImageAsset | null>(null);
  const [settings, setSettings] = useState<PuzzleSettings>(() => ({
    ...DEFAULT_PUZZLE_SETTINGS,
    pieceCount: pieceCountFromParam(params.get('pieces')) ?? DEFAULT_PUZZLE_SETTINGS.pieceCount,
  }));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A picture chosen over on /browse is waiting for us.
  useEffect(() => {
    const parked = takePendingImage();
    if (parked) setImage(parked);
  }, []);

  const difficulty = useMemo(
    () => difficultyFor(settings.pieceCount, settings),
    [settings],
  );

  async function create() {
    if (!image || creating) return;
    setCreating(true);
    setError(null);

    try {
      const { code, view } = await createRoom({
        image,
        settings,
        title: image.title,
        hostCanForceStart: true,
      });
      // Recorded before navigating: even a room nobody joins leaves the picture
      // in "My Puzzles".
      rememberPuzzle({ puzzle: view.puzzle, roomCode: code });
      router.push(solo ? `/room/${code}?solo=1` : `/room/${code}`);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'We could not make the room. Check your connection and try again.',
      );
      setCreating(false);
    }
  }

  return (
    <div className="pb-28">
      <header className="mb-9">
        <p className="eyebrow mb-3">{solo ? 'Solo puzzle' : 'Step 1 of 2 · private room'}</p>
        <h1 className="text-3xl sm:text-4xl">
          {solo ? 'Cut yourself a puzzle' : 'Make a room for the two of you'}
        </h1>
        <p className="mt-3 max-w-xl text-[var(--fg-muted)]">
          {solo
            ? 'Same board, same pieces, no waiting for anyone. You can still invite someone once it is open.'
            : 'Pick a picture and how hard you want it. The next screen gives you one link to send.'}
        </p>
      </header>

      {/* ------------------------------------------------------------ Picture */}
      <section aria-labelledby="pick-picture">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="pick-picture" className="text-xl">
            The picture
          </h2>
          {image ? (
            <button
              type="button"
              onClick={() => setImage(null)}
              className="text-sm text-[var(--fg-subtle)] underline decoration-dotted hover:text-[var(--fg)]"
            >
              Clear choice
            </button>
          ) : null}
        </div>
        <ImagePicker className="mt-4" value={image} onSelect={setImage} />
      </section>

      {/* --------------------------------------------------------- Difficulty */}
      <section className="mt-14" aria-labelledby="pick-difficulty">
        <h2 id="pick-difficulty" className="text-xl">
          How hard
        </h2>
        <p className="mt-1.5 text-sm text-[var(--fg-muted)]">
          Right now that reads as{' '}
          <strong className="font-semibold text-[var(--fg)]">{DIFFICULTY_LABEL[difficulty]}</strong>.
        </p>

        <ul className="mt-5 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {PIECE_COUNTS.map((count) => {
            const active = settings.pieceCount === count;
            return (
              <li key={count}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSettings((current) => ({ ...current, pieceCount: count }))}
                  className={`flex h-full w-full flex-col rounded-lg p-4 text-left transition-[box-shadow,background-color] ${
                    active
                      ? 'bg-[var(--accent-soft)] shadow-[0_0_0_2px_var(--accent)]'
                      : 'bg-[var(--surface)] shadow-[0_0_0_1px_var(--line)] hover:shadow-[0_0_0_1px_var(--line-strong)]'
                  }`}
                >
                  <span className="num text-2xl">{count}</span>
                  <span className="mt-0.5 text-2xs text-[var(--fg-subtle)]">pieces</span>
                  <span className="mt-2 text-sm text-[var(--fg-muted)]">
                    {PIECE_COUNT_BLURB[count]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-6 grid gap-2 sm:grid-cols-2">
          <Toggle
            label="Rotation"
            hint="Pieces start turned the wrong way and have to be spun upright."
            checked={settings.rotation}
            onChange={(rotation) => setSettings((current) => ({ ...current, rotation }))}
          />
          <Toggle
            label="Blind mode"
            hint="Hides the reference picture unless you deliberately peek at it."
            checked={settings.blindMode}
            onChange={(blindMode) => setSettings((current) => ({ ...current, blindMode }))}
          />
        </div>
      </section>

      {/* ------------------------------------------------------------ Confirm */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--line)] bg-[color-mix(in_oklab,var(--bg)_88%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-4xl items-center gap-3 px-4 py-3 sm:px-6">
          {image ? (
            <img
              src={image.thumbUrl || image.url}
              alt=""
              className="hidden size-11 shrink-0 rounded-md object-cover sm:block"
            />
          ) : null}
          <div className="min-w-0 flex-1">
            {error ? (
              <p className="text-sm text-[var(--color-danger-400)]">{error}</p>
            ) : image ? (
              <>
                <p className="truncate text-sm font-medium">{image.title}</p>
                <p className="num text-2xs text-[var(--fg-subtle)]">
                  {settings.pieceCount} pieces · {DIFFICULTY_LABEL[difficulty]}
                  {settings.rotation ? ' · rotation' : ''}
                  {settings.blindMode ? ' · blind' : ''}
                </p>
              </>
            ) : (
              <p className="text-sm text-[var(--fg-muted)]">Choose a picture to carry on.</p>
            )}
          </div>
          <Button
            variant="primary"
            size="lg"
            disabled={!image || creating}
            onClick={() => void create()}
          >
            {creating ? (
              'Cutting it up…'
            ) : (
              <>
                {solo ? 'Start playing' : 'Create the room'}
                <Icon name="arrow-right" size={18} />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`card flex items-start gap-3 p-4 text-left transition-colors ${
        checked ? 'border-[var(--accent)]' : 'hover:border-[var(--line-strong)]'
      }`}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors ${
          checked ? 'bg-[var(--accent)]' : 'bg-[var(--surface-inset)]'
        }`}
      >
        <span
          className={`size-5 rounded-full bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block text-2xs text-[var(--fg-muted)]">{hint}</span>
      </span>
    </button>
  );
}
