/**
 * `GET /api/cron/sweep` — delete expired rooms, challenges and uploads.
 *
 * Wired to a daily Vercel cron in `vercel.json`, which is free on every plan.
 * Vercel signs cron requests with `Authorization: Bearer $CRON_SECRET` when that
 * variable is set, and this route honours it if present — but it must not *require*
 * it, because the app has to work with zero configuration, and because the worst a
 * stranger can do by calling this is ask us to delete things that already expired.
 *
 * The rate limit is what stops it being used as a way to make us do work.
 */

import { maybeSweep, runSweep } from '@/lib/server/maintenance';
import { clientKey, rateLimit } from '@/lib/server/ratelimit';
import { fail, json } from '@/lib/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const authorized =
    secret !== undefined && secret !== ''
      ? request.headers.get('authorization') === `Bearer ${secret}`
      : request.headers.get('x-vercel-cron') !== null;

  if (!authorized) {
    // Not a rejection — an unsigned caller still gets a sweep, just a throttled
    // one, and learns nothing about whether a secret is configured.
    const limit = rateLimit('create', clientKey(request));
    if (!limit.ok) {
      return fail('Already tidying up. Try again shortly.', 429, {
        'Retry-After': String(limit.retryAfter),
      });
    }
    maybeSweep();
    return json({ ok: true, swept: 'scheduled' });
  }

  const result = await runSweep();
  return json({ ok: result.ok, swept: 'now', store: result.kind, images: result.images });
}
