import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { RoomClient } from '@/features/rooms/RoomClient';
import { normalizeRoomCode } from '@/lib/ids';

/**
 * The puzzle room.
 *
 * Deliberately outside the `(site)` route group. A nested layout can only *add*
 * to what it inherits, so the only way for the board to own the whole viewport —
 * no header, no footer, no page scroll — is to sit beside that group rather than
 * inside it (spec §13).
 *
 * A server component so the room code is validated and canonicalised before any
 * JavaScript loads; everything after that is the client's job, because a room is
 * live state and there is nothing here worth rendering on a server.
 */

export const metadata: Metadata = {
  title: 'Puzzle room',
  // A private room behind a shareable code has no business in an index.
  robots: { index: false, follow: false },
};

interface RoomPageProps {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RoomPage({ params, searchParams }: RoomPageProps) {
  const [{ code: raw }, query] = await Promise.all([params, searchParams]);

  // Accepts `abx729`, `ABX 729` and `abx-729` — links get retyped and mangled.
  const code = normalizeRoomCode(decodeURIComponent(raw));
  if (!code) notFound();

  return <RoomClient code={code} solo={query.solo === '1'} />;
}
