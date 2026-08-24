/**
 * A picture handed from one page to another.
 *
 * Browsing and creating are separate screens, and "use this one" on a card in
 * /browse has to survive the navigation to /play. A query string cannot carry an
 * asset (URLs, credit, dimensions), and a client-side context would not survive a
 * hard reload, so the choice is parked here for one hop.
 *
 * Read-and-clear, with a short expiry: a picture chosen yesterday should not
 * quietly reappear the next time the create screen opens.
 */

import type { ImageAsset } from '@/types/models';

import { readJson, remove, writeJson } from './local';

const KEY = 'pending-image';
/** Long enough to survive a slow page load, short enough to feel like one action. */
const TTL_MS = 30 * 60 * 1000;

interface Parked {
  asset: ImageAsset;
  savedAt: number;
}

function looksLikeAsset(value: unknown): value is ImageAsset {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<ImageAsset>;
  return typeof v.id === 'string' && typeof v.url === 'string' && typeof v.source === 'string';
}

export function savePendingImage(asset: ImageAsset): void {
  const parked: Parked = { asset, savedAt: Date.now() };
  writeJson(KEY, parked);
}

/** Returns the parked picture and forgets it. */
export function takePendingImage(): ImageAsset | null {
  const parked = readJson<Parked | null>(KEY, null);
  remove(KEY);
  if (!parked || !looksLikeAsset(parked.asset)) return null;
  if (Date.now() - parked.savedAt > TTL_MS) return null;
  return parked.asset;
}

export function clearPendingImage(): void {
  remove(KEY);
}
