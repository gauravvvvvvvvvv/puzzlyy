'use client';

/**
 * The board's controls (spec §15).
 *
 * One bar, bottom-centred, floating over the canvas. It docks to the bottom on a
 * phone because that is where thumbs are, and every target is 44px so it works
 * without a mouse (spec §24). Zoom, fit and preview act on the renderer directly
 * — they are camera concerns, not game state, so routing them through React would
 * add a re-render for nothing.
 *
 * The two popovers (reactions, settings) open upward and close on the next click
 * anywhere else, which is the behaviour people already expect from a toolbar.
 */

import { useEffect, useRef, useState } from 'react';

import { Button, IconButton } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { ThemeToggle } from '@/components/site/ThemeToggle';
import { REACTIONS } from '@/lib/multiplayer/identity';
import type { PuzzleRenderer } from '@/lib/puzzle/renderer';

export interface BoardToolbarProps {
  rendererRef: React.RefObject<PuzzleRenderer | null>;
  previewOpen: boolean;
  onPreview: () => void;
  onHint: () => void;
  hintsUsed: number;
  hintBusy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onReact: (emoji: string) => void;
  /** Arms or cancels "look here" — the board takes it from there. */
  onPing: () => void;
  pingArmed: boolean;
  ghost: boolean;
  onGhost: (value: boolean) => void;
  grid: boolean;
  onGrid: (value: boolean) => void;
  sound: boolean;
  onSound: (value: boolean) => void;
  onLeave: () => void;
  /** Hidden once the puzzle is solved — the results screen takes over. */
  hidden?: boolean;
}

export function BoardToolbar({
  rendererRef,
  previewOpen,
  onPreview,
  onHint,
  hintsUsed,
  hintBusy,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onReact,
  onPing,
  pingArmed,
  ghost,
  onGhost,
  grid,
  onGrid,
  sound,
  onSound,
  onLeave,
  hidden = false,
}: BoardToolbarProps) {
  const [open, setOpen] = useState<'none' | 'reactions' | 'settings'>('none');
  const barRef = useRef<HTMLDivElement | null>(null);

  // Close on any interaction outside the bar, and on Escape.
  useEffect(() => {
    if (open === 'none') return;
    const away = (event: PointerEvent) => {
      if (!barRef.current?.contains(event.target as Node)) setOpen('none');
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen('none');
    };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  if (hidden) return null;

  const renderer = () => rendererRef.current;

  return (
    <div
      ref={barRef}
      className="pb-safe px-safe absolute inset-x-2 bottom-0 z-20 flex justify-center sm:inset-x-0 sm:bottom-2"
    >
      <div className="relative">
        {open === 'reactions' ? (
          <Popover label="Reactions">
            <div className="flex gap-1">
              {REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={`React with ${emoji}`}
                  className="grid size-11 place-items-center rounded-md text-2xl transition-transform duration-150 hover:scale-115 hover:bg-[var(--surface-3)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none"
                  onClick={() => {
                    onReact(emoji);
                    setOpen('none');
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-2.5 text-left text-xs text-[var(--fg-muted)] hover:bg-[var(--surface-3)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none"
              onClick={() => {
                onPing();
                setOpen('none');
              }}
            >
              <Icon name="pin" size={15} />
              {pingArmed
                ? 'Stop pointing'
                : 'Look here — then tap the spot you mean'}
            </button>
          </Popover>
        ) : null}

        {open === 'settings' ? (
          <Popover label="Board settings">
            <Toggle
              label="Reference ghost"
              hint="A faint copy of the picture in the frame"
              checked={ghost}
              onChange={onGhost}
            />
            <Toggle
              label="Slot grid"
              hint="Show where the pieces belong"
              checked={grid}
              onChange={onGrid}
            />
            <Toggle
              label="Sound effects"
              hint="A click when pieces join"
              checked={sound}
              onChange={onSound}
            />
            <div className="my-1 h-px bg-[var(--line)]" />
            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
              <span className="text-xs text-[var(--fg)]">Appearance</span>
              <ThemeToggle compact />
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 w-full justify-start text-[var(--color-danger-400)]"
              onClick={onLeave}
            >
              <Icon name="arrow-left" size={16} />
              Leave the room
            </Button>
          </Popover>
        ) : null}

        <div
          className="panel flex items-center gap-0.5 p-1 shadow-[var(--shadow-lift)]"
          role="toolbar"
          aria-label="Board controls"
        >
          <IconButton label="Zoom out" onClick={() => renderer()?.zoomBy(1 / 1.25)}>
            <Icon name="zoom-out" size={19} />
          </IconButton>
          <IconButton label="Zoom in" onClick={() => renderer()?.zoomBy(1.25)}>
            <Icon name="zoom-in" size={19} />
          </IconButton>
          <IconButton label="Fit the whole board" onClick={() => renderer()?.fit()}>
            <Icon name="fit" size={19} />
          </IconButton>

          <Divider />

          <IconButton
            label={previewOpen ? 'Hide the picture' : 'Show the picture'}
            variant={previewOpen ? 'secondary' : 'ghost'}
            aria-pressed={previewOpen}
            onClick={onPreview}
          >
            <Icon name="eye" size={19} />
          </IconButton>

          <IconButton
            label={hintsUsed ? `Hint (${hintsUsed} used)` : 'Give me a hint'}
            onClick={onHint}
            disabled={hintBusy}
          >
            <Icon name="bulb" size={19} />
            {/* Hints are allowed but counted, and the count is shown rather than
                hidden — it turns up on the results screen either way. */}
            {hintsUsed > 0 ? (
              <span
                aria-hidden="true"
                className="num absolute top-0.5 right-0.5 text-[0.5625rem] text-[var(--color-butter-400)]"
              >
                {hintsUsed}
              </span>
            ) : null}
          </IconButton>

          <Divider />

          <IconButton label="Undo" onClick={onUndo} disabled={!canUndo}>
            <Icon name="undo" size={19} />
          </IconButton>
          <IconButton label="Redo" onClick={onRedo} disabled={!canRedo}>
            <Icon name="redo" size={19} />
          </IconButton>

          <Divider />

          <IconButton
            label={pingArmed ? 'Stop pointing' : 'Say something'}
            variant={open === 'reactions' || pingArmed ? 'secondary' : 'ghost'}
            aria-expanded={open === 'reactions'}
            onClick={() => setOpen(open === 'reactions' ? 'none' : 'reactions')}
          >
            {/* The pin replaces the bubble while a spot is being chosen, so the bar
                itself shows the board is waiting for a tap. */}
            <Icon name={pingArmed ? 'pin' : 'reaction'} size={19} />
          </IconButton>
          <IconButton
            label="Board settings"
            variant={open === 'settings' ? 'secondary' : 'ghost'}
            aria-expanded={open === 'settings'}
            onClick={() => setOpen(open === 'settings' ? 'none' : 'settings')}
          >
            <Icon name="settings" size={19} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-6 w-px bg-[var(--line)]" />;
}

function Popover({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="panel animate-rise absolute bottom-full left-1/2 mb-2 w-[min(20rem,calc(100vw-1.5rem))] -translate-x-1/2 p-1.5 shadow-[var(--shadow-lift)]"
    >
      {children}
    </div>
  );
}

/** A switch row. Native checkbox underneath, so keyboard and AT get it free. */
function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-[var(--surface-3)]">
      <span className="min-w-0">
        <span className="block text-xs text-[var(--fg)]">{label}</span>
        <span className="block text-2xs text-[var(--fg-subtle)]">{hint}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--ring)]"
        style={{ background: checked ? 'var(--accent)' : 'var(--line-strong)' }}
      >
        <span
          className="absolute top-0.5 size-4 rounded-full bg-white transition-[left] duration-200 ease-[var(--ease-out-soft)]"
          style={{ left: checked ? '1.125rem' : '0.125rem' }}
        />
      </span>
    </label>
  );
}
