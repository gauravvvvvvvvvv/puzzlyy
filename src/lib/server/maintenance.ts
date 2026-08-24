/**
 * Housekeeping.
 *
 * Rooms and challenges both carry an `expiresAt`, and the store knows how to
 * delete the expired ones — but nothing was ever asking it to. Left alone, a
 * memory instance grows until it is recycled and a Supabase project accumulates
 * rows forever, which on a free plan eventually stops being free. Uploaded
 * pictures are swept here too, and they are the expensive half: a row is bytes,
 * a picture is megabytes.
 *
 * Two triggers, because one of them is not always available:
 *
 *  - a daily cron (`/api/cron/sweep`), which is what actually keeps a deployment
 *    tidy, and
 *  - an opportunistic sweep on the low-traffic write paths, so a local dev server,
 *    a self-hosted box, or a deployment where nobody configured cron still cleans
 *    up after itself.
 *
 * Both are best-effort by design: a failed sweep must never turn into a failed
 * room creation.
 */

import { getBlobStore } from './blobs';
import { getRoomStore } from './store';

/** Once a day is plenty — nothing here is urgent, and expiry is already enforced on read. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * How many expired uploads to delete per sweep.
 *
 * Each one is two round trips (bytes, then row), and a sweep runs on a request's
 * budget — so it takes a bite rather than the whole backlog. Anything left over
 * is still expired at the next sweep, and the daily cron catches up quickly.
 */
const IMAGE_BATCH = 40;

/**
 * Per-instance, and deliberately so. Instances come and go on Vercel, which at
 * worst means a few extra sweeps — far cheaper than a lock to prevent them.
 */
let lastSweepAt = 0;
let inFlight: Promise<void> | null = null;

/** Delete everything that has expired. Resolves even when the store fails. */
export async function runSweep(
  now: number = Date.now(),
): Promise<{ ok: boolean; kind: string; images: number }> {
  const store = getRoomStore();
  lastSweepAt = now;
  let images = 0;
  try {
    await store.sweep(now);
    images = await sweepImages(now);
    return { ok: true, kind: store.kind, images };
  } catch (error: unknown) {
    console.warn('[puzzly] sweep failed', (error as Error).message);
    return { ok: false, kind: store.kind, images };
  }
}

/**
 * Delete uploads nobody has used in three days.
 *
 * Order matters. The bytes go first, then the row: if the process dies in
 * between, the row is still expired and the next sweep tries again, whereas the
 * reverse leaves bytes with no record and nothing to find them by.
 *
 * A picture a live room was cut from is skipped no matter how stale it looks —
 * the room and the image slide their expiries on different events, so a room
 * really can outlive its picture's clock, and a puzzle with no image is broken
 * rather than merely tidy. `imageInUse` errs towards "yes" on a failed lookup.
 */
async function sweepImages(now: number): Promise<number> {
  const store = getRoomStore();
  const blobs = getBlobStore();
  const stale = await store.staleImages(now, IMAGE_BATCH);
  let deleted = 0;

  for (const id of stale) {
    try {
      if (await store.imageInUse(id)) continue;
      await blobs.delete(id);
      await store.deleteImage(id);
      deleted += 1;
    } catch (error: unknown) {
      // One bad picture must not stop the rest; it stays expired and is retried.
      console.warn('[puzzly] could not delete image', id, (error as Error).message);
    }
  }
  return deleted;
}

/**
 * Sweep if it has been a while, without making the caller wait.
 *
 * Returns immediately: the request that happened to be the one to notice should
 * not pay for the cleanup. Concurrent callers share the single in-flight run.
 */
export function maybeSweep(now: number = Date.now()): void {
  if (inFlight) return;
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  // Claim the slot before awaiting, so a burst of requests starts one sweep.
  lastSweepAt = now;
  inFlight = runSweep(now)
    .then(() => undefined)
    .finally(() => {
      inFlight = null;
    });
}
