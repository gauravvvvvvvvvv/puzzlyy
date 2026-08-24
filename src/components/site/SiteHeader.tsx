'use client';

/**
 * Site header.
 *
 * Client-side only because the active nav item comes from the current path. It
 * stays out of the way: one row on desktop, and on mobile the nav drops to a
 * second scrollable row rather than hiding behind a hamburger — four
 * destinations do not need a menu (spec §4).
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { IdentityChip } from '@/components/site/IdentityChip';
import { Logo } from '@/components/site/Logo';
import { ThemeToggle } from '@/components/site/ThemeToggle';
import { ButtonLink } from '@/components/ui/Button';

const NAV = [
  { href: '/', label: 'Home' },
  { href: '/play', label: 'Play' },
  { href: '/browse', label: 'Browse' },
  { href: '/my-puzzles', label: 'My Puzzles' },
] as const;

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({ pathname, className = '' }: { pathname: string; className?: string }) {
  return (
    <ul className={`flex items-center gap-1 ${className}`}>
      {NAV.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`inline-flex h-10 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors ${
                active
                  ? 'bg-[var(--surface-inset)] text-[var(--fg)]'
                  : 'text-[var(--fg-muted)] hover:bg-[var(--surface-inset)] hover:text-[var(--fg)]'
              }`}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function SiteHeader() {
  const pathname = usePathname() ?? '/';

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[color-mix(in_oklab,var(--bg)_86%,transparent)] backdrop-blur-xl backdrop-saturate-150">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Logo />

        <nav aria-label="Main" className="ml-4 hidden md:block">
          <NavLinks pathname={pathname} />
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle compact />
          <div className="hidden sm:block">
            <IdentityChip />
          </div>
          <ButtonLink href="/play" variant="primary" size="sm" className="h-10">
            Play
          </ButtonLink>
        </div>
      </div>

      {/* Mobile nav: a real row, scrollable if the labels ever grow. */}
      <nav
        aria-label="Main"
        className="no-scrollbar -mt-px overflow-x-auto border-t border-[var(--line)] px-2 pb-1.5 md:hidden"
      >
        <NavLinks pathname={pathname} className="pt-1.5" />
      </nav>
    </header>
  );
}
