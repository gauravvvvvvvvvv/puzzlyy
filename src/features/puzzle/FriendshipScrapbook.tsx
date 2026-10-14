'use client';

import { useEffect, useState } from 'react';
import type { SessionResult } from '@/types/models';

interface Page { key: string; title: string; image: string; date: number; duration: number; friends: string[]; pieces: number }
const STORE = 'puzzly:friendship-scrapbook:v1';
const MAX_PAGES = 36;

function load(): Page[] {
  try {
    const raw = localStorage.getItem(STORE);
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((p): p is Page =>
      !!p && typeof p.key === 'string' && typeof p.title === 'string' &&
      typeof p.image === 'string' && Array.isArray(p.friends)).slice(0,MAX_PAGES) : [];
  } catch { return []; }
}

export function saveScrapbookPage(result: SessionResult) {
  if (typeof window === 'undefined') return;
  const key = result.roomCode + ':' + result.puzzleId + ':' + result.completedAt;
  const saved = load();
  if (saved.some(p => p.key === key)) return;
  const page: Page = {
    key, title: result.puzzleTitle, image: result.imageUrl, date: result.completedAt,
    duration: result.durationMs, pieces: result.pieceCount,
    friends: result.players.map(player => player.name),
  };
  try { localStorage.setItem(STORE,JSON.stringify([page,...saved].slice(0,MAX_PAGES))); } catch { /* storage may be disabled */ }
}

export function FriendshipScrapbook({ latest }: { latest: SessionResult }) {
  const [pages,setPages] = useState<Page[]>([]);
  const [open,setOpen] = useState(false);
  useEffect(() => { saveScrapbookPage(latest); setPages(load()); }, [latest]);
  if (!pages.length) return null;
  return <section className="card p-4">
    <button type="button" onClick={() => setOpen(o => !o)}
      aria-expanded={open} className="flex w-full items-center justify-between gap-2 text-left">
      <span className="text-sm font-semibold">Friendship scrapbook <span className="text-xs font-normal text-[var(--fg-muted)]">({pages.length} memories on this device)</span></span>
      <span aria-hidden="true">{open ? '−' : '+'}</span>
    </button>
    {open && <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
      {pages.map(page => <article key={page.key} className="overflow-hidden rounded-xl border border-[var(--line)]">
        <div className="aspect-[4/3] overflow-hidden bg-[var(--surface-inset)]">
          <img src={page.image} loading="lazy" alt={page.title} className="size-full object-cover" />
        </div>
        <div className="space-y-1 p-2">
          <p className="truncate text-xs font-semibold" title={page.title}>{page.title}</p>
          <p className="text-[11px] text-[var(--fg-muted)]">{new Date(page.date).toLocaleDateString()} · {page.pieces} pieces</p>
          <p className="line-clamp-2 text-[11px] text-[var(--fg-muted)]">{page.friends.join(', ')}</p>
        </div>
      </article>)}
    </div>}
  </section>;
}
