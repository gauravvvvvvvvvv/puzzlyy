'use client';

/**
 * Last-resort error boundary for the whole app.
 *
 * Says what happened in plain language and offers the two things that actually
 * help — try again, or go somewhere that works. The technical detail is kept in a
 * collapsed block so it can be read out to us without shouting at the player
 * (spec §33).
 */

import { useEffect } from 'react';

import { Button, ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[puzzly] Unhandled error', error);
  }, [error]);

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-center px-4 py-24 text-center sm:px-6">
      <span className="mb-6 flex size-14 items-center justify-center rounded-2xl bg-[color-mix(in_oklab,var(--color-danger-500)_14%,transparent)] text-[var(--color-danger-400)]">
        <Icon name="flag" size={26} />
      </span>
      <h1 className="text-3xl">Something came apart</h1>
      <p className="mt-3 text-[var(--fg-muted)]">
        That is our fault, not yours. Nothing you had in progress is lost — puzzle state lives on the
        server, so reloading picks it back up.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <ButtonLink href="/">Back home</ButtonLink>
      </div>

      <details className="mt-8 w-full text-left">
        <summary className="cursor-pointer text-2xs text-[var(--fg-subtle)] select-none">
          Technical details
        </summary>
        <pre className="num mt-2 max-h-40 overflow-auto rounded-sm bg-[var(--surface-inset)] p-3 text-2xs whitespace-pre-wrap text-[var(--fg-muted)]">
          {error.message || 'Unknown error'}
          {error.digest ? `\n\ndigest: ${error.digest}` : ''}
        </pre>
      </details>
    </div>
  );
}
