/**
 * Theme preference.
 *
 * Dark is the house look, but the choice belongs to the player. The stored value
 * is deliberately readable by a tiny inline script (`THEME_BOOTSTRAP`) that runs
 * before first paint, because applying the theme from React would mean a visible
 * flash of the wrong colours on every page load.
 */

import { readJson, remove, writeJson } from './local';

export type ThemeChoice = 'light' | 'dark';

const KEY = 'theme';

export function loadTheme(): ThemeChoice | null {
  const value = readJson<unknown>(KEY, null);
  return value === 'light' || value === 'dark' ? value : null;
}

export function saveTheme(choice: ThemeChoice): void {
  writeJson(KEY, choice);
}

export function forgetTheme(): void {
  remove(KEY);
}

/** What the operating system asks for, when the player has not chosen. */
export function systemTheme(): ThemeChoice {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** What is on screen right now, according to the DOM the bootstrap script set up. */
export function currentTheme(): ThemeChoice {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function applyTheme(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', choice);
}

/**
 * Runs synchronously in `<head>`, before the browser paints anything. Kept as a
 * string next to the code that reads the same key so the two cannot drift; the
 * `puzzly:v1:` prefix is `storage/local.ts`'s and the quote-stripping is because
 * the value is stored as JSON.
 */
export const THEME_BOOTSTRAP = `(function(){try{var r=document.documentElement;var v=localStorage.getItem('puzzly:v1:theme');if(v){v=v.replace(/^"|"$/g,'');}if(v!=='light'&&v!=='dark'){v=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark';}r.setAttribute('data-theme',v);}catch(e){}})();`;
