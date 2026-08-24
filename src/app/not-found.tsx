import Link from 'next/link';

import { ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';

export const metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-center px-4 py-24 text-center sm:px-6">
      <span className="mb-6 flex size-14 items-center justify-center rounded-2xl bg-[var(--surface-2)] text-[var(--fg-subtle)]">
        <Icon name="jigsaw" size={26} />
      </span>
      <h1 className="text-3xl">This piece doesn&rsquo;t fit anywhere</h1>
      <p className="mt-3 text-[var(--fg-muted)]">
        The page you were looking for isn&rsquo;t here. If you were following an invite, the room may
        have finished or expired — rooms clear themselves after a day.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
        <ButtonLink href="/play" variant="primary">
          Start a puzzle
        </ButtonLink>
        <ButtonLink href="/join">Enter a room code</ButtonLink>
      </div>
      <Link href="/" className="mt-6 text-sm text-[var(--fg-subtle)] hover:text-[var(--fg)]">
        Back home
      </Link>
    </div>
  );
}
