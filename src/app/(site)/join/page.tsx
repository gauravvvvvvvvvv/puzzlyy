import Link from 'next/link';

import { JoinForm } from '@/features/rooms/JoinForm';
import { Icon } from '@/components/ui/Icon';

export const metadata = {
  title: 'Join a room',
  description: 'Enter the six-character room code your friend sent you.',
};

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;

  return (
    <div className="mx-auto w-full max-w-lg px-4 pt-16 pb-24 sm:px-6 sm:pt-24">
      <span className="mb-6 flex size-12 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
        <Icon name="key" size={24} />
      </span>
      <h1 className="text-3xl sm:text-4xl">Got a code?</h1>
      <p className="mt-3 text-[var(--fg-muted)]">
        Type it in and you are straight into the room. No account, no waiting room.
      </p>

      <div className="card mt-8 p-5">
        <JoinForm initialCode={code ?? ''} />
      </div>

      <p className="mt-8 text-sm text-[var(--fg-subtle)]">
        No code?{' '}
        <Link href="/play" className="underline decoration-dotted hover:text-[var(--fg)]">
          Make a room yourself
        </Link>{' '}
        and send the link instead.
      </p>
    </div>
  );
}
