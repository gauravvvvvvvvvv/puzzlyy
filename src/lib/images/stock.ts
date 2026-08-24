/**
 * Stock photo search — entirely optional.
 *
 * Both providers are keyed, and the product requirement is that the app works
 * with **zero API keys**. So this module never throws and never blocks: if no
 * key is configured, or the upstream call fails, the caller gets `null` and
 * falls back to Puzzly Originals (see `./index.ts`).
 *
 * Keys are read from `process.env` here and nowhere else. Only the normalised
 * `ImageAsset` crosses back to the client, and every URL it contains points at
 * a host on `ALLOWED_IMAGE_HOSTS` so `isSafeImageUrl` accepts it later when the
 * room is created.
 */

import type { ImageAsset } from '@/types/models';

const TIMEOUT_MS = 6_000;

/** Long edge we ask providers for: enough for 500 pieces, small enough to load fast. */
const TARGET_WIDTH = 1800;

export interface StockPage {
  items: ImageAsset[];
  hasMore: boolean;
  provider: string;
}

export type StockProviderName = 'unsplash' | 'pexels';

function unsplashKey(): string | undefined {
  const key = process.env.UNSPLASH_ACCESS_KEY?.trim();
  return key ? key : undefined;
}

function pexelsKey(): string | undefined {
  const key = process.env.PEXELS_API_KEY?.trim();
  return key ? key : undefined;
}

/** Which provider we'd use, if any. Safe to report to the client. */
export function stockProvider(): StockProviderName | null {
  if (unsplashKey()) return 'unsplash';
  if (pexelsKey()) return 'pexels';
  return null;
}

export function hasStockProvider(): boolean {
  return stockProvider() !== null;
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn('[puzzly] stock search failed', res.status, url.split('?')[0]);
      return null;
    }
    return (await res.json()) as unknown;
  } catch (error) {
    console.warn('[puzzly] stock search error', (error as Error).message);
    return null;
  }
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Trim a provider's caption into something that fits on a card. */
function titleFrom(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const text = str(candidate).trim();
    if (!text) continue;
    const clean = text.replace(/\s+/g, ' ');
    return clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}…` : clean;
  }
  return 'Untitled';
}

/* -------------------------------------------------------------------------- */
/* Unsplash                                                                   */
/* -------------------------------------------------------------------------- */

function unsplashSized(raw: string, width: number): string {
  if (!raw) return '';
  const join = raw.includes('?') ? '&' : '?';
  return `${raw}${join}w=${width}&q=80&fm=jpg&fit=max`;
}

async function searchUnsplash(key: string, query: string, page: number, perPage: number): Promise<StockPage | null> {
  const url =
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}` +
    `&page=${page}&per_page=${perPage}&orientation=landscape&content_filter=high`;
  const body = rec(await getJson(url, { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' }));
  if (!body || !Array.isArray(body.results)) return null;

  const items: ImageAsset[] = [];
  for (const entry of body.results) {
    const photo = rec(entry);
    if (!photo) continue;
    const urls = rec(photo.urls);
    const user = rec(photo.user);
    const raw = str(urls?.raw) || str(urls?.full);
    const full = unsplashSized(raw, TARGET_WIDTH);
    if (!full) continue;
    items.push({
      id: `unsplash-${str(photo.id)}`,
      source: 'stock',
      url: full,
      thumbUrl: unsplashSized(raw, 480) || full,
      width: num(photo.width) || TARGET_WIDTH,
      height: num(photo.height) || Math.round(TARGET_WIDTH * 0.66),
      title: titleFrom(photo.description, photo.alt_description, query),
      color: str(photo.color) || undefined,
      credit: {
        authorName: titleFrom(user?.name, 'Unsplash contributor'),
        authorUrl: str(rec(user?.links)?.html) || undefined,
        providerName: 'Unsplash',
        providerUrl: 'https://unsplash.com',
      },
      createdAt: 0,
    });
  }
  const totalPages = num(body.total_pages);
  return { items, hasMore: totalPages > page, provider: 'unsplash' };
}

/* -------------------------------------------------------------------------- */
/* Pexels                                                                     */
/* -------------------------------------------------------------------------- */

async function searchPexels(key: string, query: string, page: number, perPage: number): Promise<StockPage | null> {
  const url =
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}` +
    `&page=${page}&per_page=${perPage}&orientation=landscape`;
  const body = rec(await getJson(url, { Authorization: key }));
  if (!body || !Array.isArray(body.photos)) return null;

  const items: ImageAsset[] = [];
  for (const entry of body.photos) {
    const photo = rec(entry);
    if (!photo) continue;
    const src = rec(photo.src);
    const full = str(src?.large2x) || str(src?.large) || str(src?.original);
    if (!full) continue;
    items.push({
      id: `pexels-${num(photo.id) || str(photo.id)}`,
      source: 'stock',
      url: full,
      thumbUrl: str(src?.medium) || str(src?.small) || full,
      width: num(photo.width) || TARGET_WIDTH,
      height: num(photo.height) || Math.round(TARGET_WIDTH * 0.66),
      title: titleFrom(photo.alt, query),
      color: str(photo.avg_color) || undefined,
      credit: {
        authorName: titleFrom(photo.photographer, 'Pexels contributor'),
        authorUrl: str(photo.photographer_url) || undefined,
        providerName: 'Pexels',
        providerUrl: 'https://pexels.com',
      },
      createdAt: 0,
    });
  }
  return { items, hasMore: items.length >= perPage, provider: 'pexels' };
}

/* -------------------------------------------------------------------------- */

/**
 * Search whichever provider is configured. Returns `null` — not an error — when
 * nothing is configured or the upstream call fails, so the caller can quietly
 * fall back to Originals.
 */
export async function searchStock(query: string, page = 1, perPage = 24): Promise<StockPage | null> {
  const text = query.trim();
  if (!text) return null;
  const safePage = Math.max(1, Math.min(20, Math.floor(page)));
  const safePerPage = Math.max(1, Math.min(40, Math.floor(perPage)));

  const unsplash = unsplashKey();
  if (unsplash) {
    const result = await searchUnsplash(unsplash, text, safePage, safePerPage);
    if (result) return result;
  }
  const pexels = pexelsKey();
  if (pexels) {
    const result = await searchPexels(pexels, text, safePage, safePerPage);
    if (result) return result;
  }
  return null;
}
