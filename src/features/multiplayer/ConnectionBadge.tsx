'use client';

/**
 * Connection state, said plainly (spec §22).
 *
 * Deliberately quiet while everything is fine: a permanent green "Connected"
 * badge is noise, so the healthy state shrinks to a dot. The badge only grows
 * words when the player needs reassurance that their pieces are safe.
 */

import { Icon } from '@/components/ui/Icon';
import type { ConnectionStatus } from '@/types/events';

const COPY: Record<ConnectionStatus, { label: string; tone: string; calm: boolean }> = {
  idle: { label: 'Connecting…', tone: 'var(--fg-subtle)', calm: false },
  connecting: { label: 'Connecting…', tone: 'var(--color-butter-400)', calm: false },
  connected: { label: 'Connected', tone: 'var(--color-mint-400)', calm: true },
  reconnecting: { label: 'Reconnecting…', tone: 'var(--color-butter-400)', calm: false },
  closed: { label: 'Offline', tone: 'var(--fg-subtle)', calm: false },
  error: { label: 'Connection lost', tone: 'var(--color-danger-400)', calm: false },
};

export function ConnectionBadge({
  status,
  className = '',
}: {
  status: ConnectionStatus;
  className?: string;
}) {
  const { label, tone, calm } = COPY[status];

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-2xs font-semibold ${className}`}
      style={{ color: tone }}
      // A status region, so a screen reader hears about a drop without being
      // yanked away from whatever it was reading.
      role="status"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ${calm ? '' : 'animate-pulse'}`}
        style={{ background: tone }}
      />
      {calm ? <span className="sr-only">{label}</span> : <span>{label}</span>}
    </span>
  );
}

/**
 * The heavier version: a bar across the top of the board while the socket is
 * down, with the one promise that matters.
 */
export function ConnectionBanner({ status }: { status: ConnectionStatus }) {
  if (status === 'connected' || status === 'idle') return null;

  const failed = status === 'error' || status === 'closed';

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-3 pt-3"
    >
      <div
        className="panel flex items-center gap-2 px-3 py-2 text-xs shadow-[var(--shadow-lift)]"
        style={{
          borderColor: failed
            ? 'color-mix(in oklab, var(--color-danger-500) 45%, transparent)'
            : 'color-mix(in oklab, var(--color-butter-400) 45%, transparent)',
        }}
      >
        <Icon
          name="wifi"
          size={15}
          style={{ color: failed ? 'var(--color-danger-400)' : 'var(--color-butter-400)' }}
        />
        <span className="text-[var(--fg)]">{COPY[status].label}</span>
        <span className="text-[var(--fg-subtle)]">Your progress is saved.</span>
      </div>
    </div>
  );
}
