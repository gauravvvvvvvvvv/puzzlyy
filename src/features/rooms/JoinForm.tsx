'use client';

/**
 * Join with a room code (spec §9).
 *
 * The invite link is the main path; this is the fallback for a code read out over
 * the phone or copied out of a screenshot. It accepts anything recognisable —
 * `abx729`, `ABX 729`, or the whole invite URL pasted in — and checks the room
 * really exists before navigating, so a typo says "no room with that code"
 * instead of dropping someone on an error page.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { ApiError, fetchRoom } from '@/lib/realtime/api';
import { normalizeRoomCode } from '@/lib/ids';

export interface JoinFormProps {
  /** Prefilled from `?code=`, e.g. when an invite link is opened after expiry. */
  initialCode?: string;
  autoFocus?: boolean;
}

export function JoinForm({ initialCode = '', autoFocus = true }: JoinFormProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [raw, setRaw] = useState(() => tidy(initialCode));
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const code = normalizeRoomCode(raw);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!code || checking) return;

    setChecking(true);
    setError(null);
    try {
      // A HEAD-style existence check. The room page will fetch it again, but
      // this is what turns a wrong code into a sentence rather than a blank room.
      await fetchRoom(code);
      router.push(`/room/${code}`);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 404
          ? 'No room with that code. Rooms clear themselves after a day — ask for a fresh link.'
          : cause instanceof ApiError
            ? cause.message
            : 'We could not reach the room. Check your connection and try again.',
      );
      setChecking(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <label htmlFor="room-code" className="block text-sm font-medium">
        Room code
      </label>
      <div className="mt-2 flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <input
            ref={inputRef}
            id="room-code"
            name="code"
            value={raw}
            onChange={(event) => {
              setRaw(tidy(event.target.value));
              setError(null);
            }}
            placeholder="ABX-729"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            aria-invalid={raw.length >= 7 && !code}
            aria-describedby="room-code-hint"
            className="num h-13 w-full rounded-lg border border-[var(--line-strong)] bg-[var(--surface-inset)] px-4 text-xl tracking-[0.18em] uppercase outline-none placeholder:text-[var(--fg-subtle)] placeholder:tracking-[0.18em] focus-visible:border-[var(--accent)]"
          />
        </div>
        <Button type="submit" variant="primary" size="lg" disabled={!code || checking}>
          {checking ? 'Looking…' : 'Join'}
          {checking ? null : <Icon name="arrow-right" size={18} />}
        </Button>
      </div>

      <p id="room-code-hint" className="mt-2 text-2xs text-[var(--fg-subtle)]">
        Six characters, in two groups of three. You can paste the whole invite link instead.
      </p>

      {error ? (
        <p role="alert" className="mt-4 rounded-md border border-[color-mix(in_oklab,var(--color-danger-500)_40%,transparent)] px-3 py-2 text-sm text-[var(--color-danger-400)]">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Keep the field readable while it is being typed: strip anything that is not a
 * code character, uppercase it, and put the hyphen back in the middle. A pasted
 * URL reduces to just its code because the slashes and letters around it are
 * dropped by `normalizeRoomCode` — so pull the code out of the path first.
 */
function tidy(input: string): string {
  const fromUrl = /\/room\/([A-Za-z0-9-]{6,8})/.exec(input);
  const source = fromUrl?.[1] ?? input;
  const cleaned = source.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  return cleaned.length > 3 ? `${cleaned.slice(0, 3)}-${cleaned.slice(3)}` : cleaned;
}
