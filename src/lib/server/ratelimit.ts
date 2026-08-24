/**
 * Coarse per-IP rate limiting for the write endpoints (spec §30).
 *
 * Deliberately simple: an in-process token bucket, no Redis, no dependency. It
 * is not a defence against a distributed attacker — it is there so one buggy or
 * bored client cannot spin up thousands of rooms or hammer the event endpoint.
 *
 * Because it is per-instance, it is the *coarse* half of the story. The exact
 * per-seat budget lives in `spend()` in `lib/server/session.ts`, riding inside
 * the room record itself so it survives an instance change.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface Limiter {
  /** tokens restored per millisecond */
  rate: number;
  burst: number;
  buckets: Map<string, Bucket>;
}

const LIMITS = {
  /** Room creation: ~10 per minute, burst of 6. */
  create: { rate: 10 / 60_000, burst: 6 },
  /** Joining: ~30 per minute. */
  join: { rate: 30 / 60_000, burst: 10 },
  /**
   * Events, charged per event rather than per batch. This has to sit *above* the
   * authoritative per-seat budget in `session.ts` (30/s sustained, burst 240) —
   * it is the coarse outer guard, and if it bound first a normal drag would get
   * 429s while the real limiter still had room. Keyed by IP *and* seat, so two
   * players behind one router do not share it.
   */
  events: { rate: 40 / 1_000, burst: 300 },
  /** Uploads: ~20 per minute. */
  upload: { rate: 20 / 60_000, burst: 6 },
  /** Stock image search: ~60 per minute. */
  search: { rate: 60 / 60_000, burst: 20 },
  /** Image proxy: generous, it is hit once per puzzle image. */
  proxy: { rate: 120 / 60_000, burst: 40 },
} as const;

export type LimitName = keyof typeof LIMITS;

declare global {
  // eslint-disable-next-line no-var
  var __puzzlyLimits: Map<string, Limiter> | undefined;
}

function limiterFor(name: LimitName): Limiter {
  globalThis.__puzzlyLimits ??= new Map();
  let limiter = globalThis.__puzzlyLimits.get(name);
  if (!limiter) {
    const config = LIMITS[name];
    limiter = { rate: config.rate, burst: config.burst, buckets: new Map() };
    globalThis.__puzzlyLimits.set(name, limiter);
  }
  return limiter;
}

export interface LimitResult {
  ok: boolean;
  /** Seconds until the next token, for a Retry-After header. */
  retryAfter: number;
}

export function rateLimit(name: LimitName, key: string, cost = 1): LimitResult {
  const limiter = limiterFor(name);
  const now = Date.now();
  let bucket = limiter.buckets.get(key);
  if (!bucket) {
    bucket = { tokens: limiter.burst, updatedAt: now };
    limiter.buckets.set(key, bucket);
  }
  bucket.tokens = Math.min(
    limiter.burst,
    bucket.tokens + (now - bucket.updatedAt) * limiter.rate,
  );
  bucket.updatedAt = now;

  if (bucket.tokens < cost) {
    const deficit = cost - bucket.tokens;
    return { ok: false, retryAfter: Math.max(1, Math.ceil(deficit / limiter.rate / 1000)) };
  }
  bucket.tokens -= cost;

  // Keep the map from growing without bound on a long-lived instance.
  if (limiter.buckets.size > 5000) {
    for (const [k, b] of limiter.buckets) {
      if (now - b.updatedAt > 10 * 60_000) limiter.buckets.delete(k);
      if (limiter.buckets.size <= 2500) break;
    }
  }
  return { ok: true, retryAfter: 0 };
}

/**
 * Best-effort client identity for rate limiting. Behind Vercel's proxy the
 * left-most `x-forwarded-for` entry is the real client.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return (
    request.headers.get('x-real-ip') ??
    request.headers.get('cf-connecting-ip') ??
    'unknown'
  );
}
