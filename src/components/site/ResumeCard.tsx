'use client';

/**
 * "You were in a room" — offered, never forced.
 *
 * A player who closed the tab mid-puzzle should not have to remember a room code
 * to get back in (spec §22). The seat token is still on this device, so the link
 * genuinely resumes the same seat rather than joining as a stranger.
 */

import { useEffect, useState } from 'react';

import { Icon } from '@/components/ui/Icon';
import { buttonClass } from '@/components/ui/Button';
import { formatRelative } from '@/lib/format';
import { clearLastRoom, loadLastRoom, loadSeat, type LastRoom } from '@/lib/storage/seats';
import Link from 'next/link';

export function ResumeCard() {
  const [room, setRoom] = useState<LastRoom | null>(null);

  useEffect(() => {
    const last = loadLastRoom();
    // No seat means the token expired or was cleared; the offer would be a lie.
    if (last && loadSeat(last.code)) setRoom(last);
  }, []);

  if (!room) return null;

  return (
    <div className="card animate-rise flex flex-wrap items-center gap-3 p-3 pl-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
        <Icon name="again" size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{room.title || 'Your puzzle'}</p>
        <p className="text-2xs text-[var(--fg-subtle)]">
          <span className="num">{room.code}</span> · left {formatRelative(room.savedAt)}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <Link href={`/room/${room.code}`} className={buttonClass('primary', 'sm')}>
          Pick up where you left off
        </Link>
        <button
          type="button"
          aria-label="Forget this room"
          title="Forget this room"
          onClick={() => {
            clearLastRoom();
            setRoom(null);
          }}
          className={buttonClass('ghost', 'sm', 'w-9 px-0')}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
    </div>
  );
}
