/**
 * `GET /api/images` — the picker's only data source.
 *
 * `?source=original|stock|upload`, plus `category`, `q` and `page`.
 *
 * The response reports which provider actually answered and whether it was a
 * fallback, so the UI can be honest ("showing Puzzly Originals — stock search
 * isn't configured") instead of silently showing something else.
 */

import { IMAGE_CATEGORIES, searchImages, stockProvider } from '@/lib/images';
import { clientKey, rateLimit } from '@/lib/server/ratelimit';
import { asInt, asString, fail, json } from '@/lib/server/validate';
import type { ImageSource } from '@/types/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function asSource(value: string | null): ImageSource {
  return value === 'stock' || value === 'upload' ? value : 'original';
}

export async function GET(request: Request): Promise<Response> {
  const limit = rateLimit('search', clientKey(request));
  if (!limit.ok) {
    return fail('Searching a bit fast. One moment.', 429, {
      'Retry-After': String(limit.retryAfter),
    });
  }

  const url = new URL(request.url);
  const source = asSource(url.searchParams.get('source'));
  const page = asInt(Number(url.searchParams.get('page') ?? '1'), 1, 20) ?? 1;
  const perPage = asInt(Number(url.searchParams.get('perPage') ?? '24'), 1, 40) ?? 24;

  const result = await searchImages({
    source,
    category: asString(url.searchParams.get('category'), 40),
    query: asString(url.searchParams.get('q'), 80),
    page,
    perPage,
  });

  return json({
    ...result,
    source,
    categories: IMAGE_CATEGORIES,
    stock: stockProvider(),
  });
}
