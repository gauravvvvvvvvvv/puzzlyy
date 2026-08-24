'use client';

/**
 * The player's name and emoji, editable in place.
 *
 * There is no signup (spec §2), so this is the whole of "your account": a name
 * your friend will recognise and a face to put on your cursor. It is edited from
 * the header so nobody has to fill in a form before playing — the identity
 * already exists by the time they see it.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { AVATARS, sanitizeName } from '@/lib/multiplayer/identity';
import { ANONYMOUS, loadIdentity, updateIdentity } from '@/lib/storage/identity';
import type { LocalIdentity } from '@/types/models';

export function IdentityChip() {
  const [identity, setIdentity] = useState<LocalIdentity>(ANONYMOUS);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameId = useId();

  useEffect(() => {
    setIdentity(loadIdentity());
  }, []);

  useEffect(() => {
    if (!open) return;
    setDraft(identity.name);
    const frame = requestAnimationFrame(() => inputRef.current?.select());

    function onPointerDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, identity.name]);

  function commit(patch: Partial<LocalIdentity>) {
    setIdentity(updateIdentity(patch));
  }

  function saveName() {
    // An empty box means "leave it alone", not "give me a random name" — which is
    // what `sanitizeName` would do with a blank string.
    if (draft.trim()) {
      const clean = sanitizeName(draft);
      if (clean !== identity.name) commit({ name: clean });
    }
    setOpen(false);
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="inline-flex h-11 max-w-[11rem] items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--surface)] pr-3 pl-2 text-left transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--surface-2)]"
      >
        <span aria-hidden="true" className="text-lg leading-none">
          {identity.avatar}
        </span>
        <span className="truncate text-sm font-medium">{identity.name}</span>
        <Icon name="settings" size={15} className="shrink-0 text-[var(--fg-subtle)]" />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Your name and face"
          className="card absolute right-0 z-40 mt-2 w-[17.5rem] animate-pop p-3 shadow-[var(--shadow-lift)]"
        >
          <label htmlFor={nameId} className="eyebrow mb-1.5 block">
            Your name
          </label>
          <div className="flex gap-2">
            <input
              id={nameId}
              ref={inputRef}
              value={draft}
              maxLength={18}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveName();
              }}
              className="h-10 min-w-0 flex-1 rounded-sm border border-[var(--line-strong)] bg-[var(--surface-inset)] px-2.5 text-sm outline-none focus-visible:border-[var(--accent)]"
              placeholder="Who are you?"
              autoComplete="off"
              spellCheck={false}
            />
            <Button size="sm" variant="primary" onClick={saveName} className="h-10">
              Save
            </Button>
          </div>

          <p className="eyebrow mt-3 mb-1.5">Pick a face</p>
          <div className="grid grid-cols-8 gap-1">
            {AVATARS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`Use ${emoji}`}
                aria-pressed={identity.avatar === emoji}
                onClick={() => commit({ avatar: emoji })}
                className={`flex aspect-square items-center justify-center rounded-sm text-base transition-colors ${
                  identity.avatar === emoji
                    ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]'
                    : 'hover:bg-[var(--surface-inset)]'
                }`}
              >
                <span aria-hidden="true">{emoji}</span>
              </button>
            ))}
          </div>
          <p className="mt-3 text-2xs text-[var(--fg-subtle)]">
            Stored on this device only. No account, no email.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function IdentityChipSlot() {
  return (
    <div className="hidden sm:block">
      <IdentityChip />
    </div>
  );
}
