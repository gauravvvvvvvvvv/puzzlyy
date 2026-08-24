/**
 * `GET /api/health` — is this deployment actually able to host a game?
 *
 * The app runs with zero configuration, but zero configuration means
 * single-instance realtime and non-durable storage, which on Vercel is a
 * different product ("works on my machine, breaks for my friend"). Rather than
 * let that be a mystery, every capability is reported here, along with the
 * specific environment variable that would fix it.
 *
 * Deliberately says nothing secret: booleans and names only, never a key, a
 * bucket URL, or a project URL.
 */

import { imageCapabilities } from '@/lib/images';
import { hasDurableBlobStore } from '@/lib/server/blobs';
import { realtimeMode } from '@/lib/server/broadcast';
import { hasDurableStore } from '@/lib/server/store';
import { json } from '@/lib/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const rooms = hasDurableStore();
  const blobs = hasDurableBlobStore();
  const realtime = realtimeMode();
  const images = imageCapabilities();

  const warnings: string[] = [];
  if (!rooms) {
    warnings.push(
      'Rooms are stored in memory. They will not survive a redeploy and are not ' +
        'shared between instances. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
  if (!blobs) {
    warnings.push(
      'Uploaded images are stored on the local filesystem and will disappear. ' +
        'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and create the storage bucket.',
    );
  }
  if (realtime === 'sse') {
    warnings.push(
      'Realtime is using the built-in SSE fallback, which only works when every ' +
        'player is served by the same instance. Set NEXT_PUBLIC_SUPABASE_ANON_KEY to use Supabase Realtime.',
    );
  }

  // `ok` is about serving traffic, not about being ideally configured — a local
  // dev server is healthy, it is just limited, and the warnings say how.
  return json({
    ok: true,
    ready: rooms && blobs && realtime === 'supabase',
    storage: { rooms: rooms ? 'durable' : 'memory', images: blobs ? 'durable' : 'filesystem' },
    realtime,
    images,
    warnings,
  });
}
