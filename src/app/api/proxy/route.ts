/**
 * `GET /api/proxy?u=<url>` — same-origin passthrough for stock photos.
 *
 * Building a sprite atlas means reading pixels back off a canvas, and a
 * cross-origin image taints the canvas and makes that throw. Stock CDNs do send
 * permissive CORS headers, but relying on that leaves the whole board one header
 * change away from breaking, so external images come through here instead.
 *
 * This is a deliberately narrow door, not a general fetcher:
 *   - https only, and only hosts on `ALLOWED_IMAGE_HOSTS`
 *   - the *final* URL after redirects is re-checked against the allowlist
 *   - the response must actually be an image, and is size-capped
 *
 * Without those checks this would be an SSRF hole pointed at the platform's
 * internal network.
 */

import { clientKey, rateLimit } from '@/lib/server/ratelimit';
import { ALLOWED_IMAGE_HOSTS, fail } from '@/lib/server/validate';

export const runtime = 'nodejs';

const MAX_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

function allowed(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!ALLOWED_IMAGE_HOSTS.has(url.hostname)) return null;
  return url;
}

export async function GET(request: Request): Promise<Response> {
  const limit = rateLimit('proxy', clientKey(request));
  if (!limit.ok) {
    return fail('Too many image requests.', 429, { 'Retry-After': String(limit.retryAfter) });
  }

  const target = allowed(new URL(request.url).searchParams.get('u') ?? '');
  if (!target) return fail('That image host is not allowed.', 400);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: { Accept: 'image/*' },
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return fail('Could not load that image.', 502);
  }

  if (!upstream.ok || !upstream.body) return fail('Could not load that image.', 502);
  // A redirect could have walked off the allowlist.
  if (upstream.url && !allowed(upstream.url)) return fail('That image host is not allowed.', 400);

  const contentType = upstream.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) return fail('That URL is not an image.', 415);

  const declared = Number(upstream.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) return fail('That image is too large.', 413);

  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) return fail('That image is too large.', 413);

  return new Response(bytes as BodyInit, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'public, max-age=86400, s-maxage=604800',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
