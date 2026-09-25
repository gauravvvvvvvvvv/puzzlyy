/**
 * `GET /api/cron/sweep` — keep Supabase active and delete expired data.
 *
 * Wired to the daily Vercel cron in `vercel.json`.
 *
 * The explicit Supabase read below is intentional: even when there is nothing
 * to sweep, the scheduled request still creates real database activity. This
 * keeps a low-traffic Puzzly deployment from looking completely idle to
 * Supabase's free-tier inactivity detector.
 */

import { maybeSweep, runSweep } from '@/lib/server/maintenance';
import { clientKey, rateLimit } from '@/lib/server/ratelimit';
import { supabaseServiceKey, supabaseUrl } from '@/lib/server/store';
import { fail, json } from '@/lib/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function pingSupabase(): Promise<boolean> {
  const url = supabaseUrl();
  const key = supabaseServiceKey();
  if (!url || !key) return false;

  try {
    const response = await fetch(
      `${url.replace(/\/$/, '')}/rest/v1/rooms?select=code&limit=1`,
      {
        method: 'GET',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
        cache: 'no-store',
      },
    );
    return response.ok;
  } catch (error) {
    console.warn('[puzzly] Supabase keepalive failed', error);
    return false;
  }
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const authorized =
    secret !== undefined && secret !== ''
      ? request.headers.get('authorization') === `Bearer ${secret}`
      : request.headers.get('x-vercel-cron') !== null;

  if (!authorized) {
    const limit = rateLimit('create', clientKey(request));
    if (!limit.ok) {
      return fail('Already tidying up. Try again shortly.', 429, {
        'Retry-After': String(limit.retryAfter),
      });
    }
    maybeSweep();
    return json({ ok: true, swept: 'scheduled' });
  }

  // Do this independently of the sweep. A future cleanup refactor must not
  // accidentally remove the tiny database request that keeps Supabase active.
  const keepalive = await pingSupabase();
  const result = await runSweep();

  return json({
    ok: result.ok && keepalive,
    keepalive,
    swept: 'now',
    store: result.kind,
    images: result.images,
  });
}
