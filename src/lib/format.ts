/**
 * Difficulty labelling and the small pieces of formatting that both the server
 * and the client need. Kept DOM-free so API routes can import it.
 */

import type { Difficulty, PieceCount, PuzzleSettings } from '@/types/models';

/** Derived, never stored twice: piece count plus the modifiers that bite. */
export function difficultyFor(pieceCount: number, settings: PuzzleSettings): Difficulty {
  let score = pieceCount;
  if (settings.rotation) score *= 2.2;
  if (settings.blindMode) score *= 1.8;
  if (score <= 40) return 'relaxed';
  if (score <= 90) return 'easy';
  if (score <= 260) return 'medium';
  if (score <= 700) return 'hard';
  return 'brutal';
}

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  relaxed: 'Relaxed',
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
  brutal: 'Brutal',
};

/** Rough "two people, first time" estimate. Honest enough to be useful. */
export const PIECE_COUNT_BLURB: Record<PieceCount, string> = {
  25: 'A few minutes',
  50: 'About ten minutes',
  100: 'Twenty minutes or so',
  250: 'Most of an hour',
  500: 'An evening together',
};

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

/** `04:32`, or `1:04:32` once it runs past an hour. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "4 minutes 32 seconds" — for screen readers and share text. */
export function spellDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (seconds || !minutes) parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
  return parts.join(' ');
}

export function formatPercent(progress: number): string {
  return `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
}

export function formatRelative(timestamp: number, now = Date.now()): string {
  const diff = now - timestamp;
  const minute = 60_000;
  if (diff < minute) return 'just now';
  if (diff < 60 * minute) {
    const m = Math.round(diff / minute);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (diff < 24 * 60 * minute) {
    const h = Math.round(diff / (60 * minute));
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.round(diff / (24 * 60 * minute));
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** `1.4 MB` */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
