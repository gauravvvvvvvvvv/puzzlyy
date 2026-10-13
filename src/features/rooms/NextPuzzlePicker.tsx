'use client';

import { useState } from 'react';
import { ImagePicker } from '@/features/images/ImagePicker';
import type { RoomSession } from '@/hooks/useRoomSession';
import { DEFAULT_PUZZLE_SETTINGS, PIECE_COUNTS } from '@/types/models';
import type { ImageAsset, PuzzleSettings } from '@/types/models';

export function NextPuzzlePicker({ session, onClose }: {
  session: RoomSession; onClose: () => void;
}) {
  const [image, setImage] = useState<ImageAsset | null>(null);
  const [settings, setSettings] = useState<PuzzleSettings>({
    ...DEFAULT_PUZZLE_SETTINGS,
    pieceCount: session.room?.settings.pieceCount ?? 100,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const choose = async () => {
    if (!image || busy) return;
    setBusy(true);
    setError('');
    try {
      await session.choosePuzzle(image, settings);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not choose that puzzle.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <p className="eyebrow">Same room, new adventure</p>
          <h2 className="mt-1 text-2xl">Choose your next puzzle</h2>
          <p className="mt-2 text-sm text-[var(--fg-muted)]">
            Everyone stays in the room, and your chat and call stay connected.
          </p>
        </div>
        <button type="button" onClick={onClose}
          className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm">Back</button>
      </header>
      <ImagePicker value={image} onSelect={setImage} />
      <section className="card space-y-3 p-4">
        <h3 className="text-base">Puzzle difficulty</h3>
        <div className="flex flex-wrap gap-2">
          {PIECE_COUNTS.map(count => (
            <button key={count} type="button"
              aria-pressed={settings.pieceCount === count}
              onClick={() => setSettings(current => ({ ...current, pieceCount: count }))}
              className={'rounded-lg border px-3 py-2 text-sm ' +
                (settings.pieceCount === count ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--line)]')}>
              {count} pieces
            </button>
          ))}
        </div>
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" checked={settings.rotation}
            onChange={e => setSettings(s => ({ ...s, rotation: e.target.checked }))} /> Rotate pieces
        </label>
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" checked={settings.blindMode}
            onChange={e => setSettings(s => ({ ...s, blindMode: e.target.checked }))} /> Blind mode
        </label>
      </section>
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      <button type="button" disabled={!image || busy} onClick={() => void choose()}
        className="rounded-lg bg-[var(--accent)] px-5 py-3 text-sm text-white disabled:opacity-40">
        {busy ? 'Preparing the next round…' : 'Play this picture together'}
      </button>
    </div>
  );
}
