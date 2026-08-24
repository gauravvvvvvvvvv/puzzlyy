import Link from 'next/link';

import { LogoMark } from '@/components/site/Logo';

const LINKS = [
  { href: '/play', label: 'Start a puzzle' },
  { href: '/browse', label: 'Browse pictures' },
  { href: '/my-puzzles', label: 'My puzzles' },
  { href: '/join', label: 'Join with a code' },
] as const;

export function SiteFooter() {
  return (
    <footer className="relative z-1 mt-24 border-t border-[var(--line)]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <LogoMark size={26} />
          <p className="text-sm text-[var(--fg-muted)]">
            Turn any picture into a game you can play together.
          </p>
        </div>

        <nav aria-label="Footer">
          <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="text-sm text-[var(--fg-muted)] transition-colors hover:text-[var(--fg)]"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 pb-10 sm:px-6">
        <p className="text-2xs text-[var(--fg-subtle)]">
          No accounts, no tracking, no app to install. Rooms disappear on their own after a day.
        </p>
      </div>
    </footer>
  );
}
