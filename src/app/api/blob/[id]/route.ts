/**
 * `GET /api/blob/[id]` — serve an uploaded image.
 *
 * Uploads are served through here rather than from a storage URL for two
 * reasons: the storage bucket stays private (no key or bucket URL ever reaches a
 * browser), and the image is same-origin so the puzzle canvas is not tainted
 * when it reads pixels back to build its sprite atlas.
 */

import { getBlobStore } from '@/lib/server/blobs';
import { touchImage } from '@/lib/server/store';
import { fail } from '@/lib/server/validate';

export const runtime = 'nodejs';

const ID = /^img_[A-Za-z0-9]{6,32}$/;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!ID.test(id)) return fail('Not a valid image id.', 400);

  const blob = await getBlobStore().get(id);
  if (!blob) return fail('That image is no longer available.', 404);

  // Somebody is looking at this picture, so it is not abandoned. Fire-and-forget
  // and throttled to once an hour per instance, so the hot path stays hot — see
  // `touchImage`. Note the immutable cache header below means a long session may
  // never come back here, which is why room creation refreshes the expiry too.
  touchImage(id);

  return new Response(blob.data as BodyInit, {
    headers: {
      'Content-Type': blob.contentType,
      // Content is immutable for a given id, so this is safe and keeps repeat
      // loads (both players, every reconnect) off the storage backend.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': String(blob.data.byteLength),
    },
  });
}
