/**
 * `POST /api/upload` — accept a user's own picture.
 *
 * The body is the **raw image bytes**, not multipart: the browser already has to
 * decode the file onto a canvas to downscale it (a phone photo is 4000px wide
 * and 6 MB; a 500-piece puzzle needs about 2000px), so it re-encodes and POSTs
 * the result directly. That keeps typical bodies at 150–500 KB, avoids a
 * multipart parser, and means the dimensions are known before upload:
 *
 *     POST /api/upload?w=2000&h=1333&title=Beach
 *     Content-Type: image/jpeg
 *     <bytes>
 *
 * `Content-Type` is a claim, so the leading bytes are sniffed and have to agree
 * with it — otherwise `/api/blob/[id]` would happily serve whatever was sent back
 * under a type of the uploader's choosing.
 *
 * The stored asset points at `/api/blob/{id}`, so the bucket stays private and
 * the image is same-origin for the canvas.
 */

import { createId } from '@/lib/ids';
import { ALLOWED_UPLOAD_TYPES, getBlobStore, hasDurableBlobStore } from '@/lib/server/blobs';
import { clientKey, rateLimit } from '@/lib/server/ratelimit';
import { getRoomStore, IMAGE_TTL_MS } from '@/lib/server/store';
import { asInt, asString, fail, json } from '@/lib/server/validate';
import type { ImageAsset } from '@/types/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Generous for a browser-downscaled image; small enough to reject a raw upload. */
const MAX_BYTES = 6 * 1024 * 1024;
const MIN_BYTES = 256;
const MIN_DIMENSION = 200;
const MAX_DIMENSION = 8_000;

/** What the bytes actually are, regardless of what the header says. */
function sniff(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'image/png';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === 'RIFF' &&
    String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const limit = rateLimit('upload', clientKey(request));
  if (!limit.ok) {
    return fail('That is a lot of uploads. Give it a second.', 429, {
      'Retry-After': String(limit.retryAfter),
    });
  }

  const declaredType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim();
  if (!ALLOWED_UPLOAD_TYPES.includes(declaredType)) {
    return fail('Images need to be a JPEG, PNG or WebP.', 415);
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BYTES) {
    return fail('That image is too big. Try one under 6 MB.', 413);
  }

  const url = new URL(request.url);
  const width = asInt(Number(url.searchParams.get('w')), MIN_DIMENSION, MAX_DIMENSION);
  const height = asInt(Number(url.searchParams.get('h')), MIN_DIMENSION, MAX_DIMENSION);
  if (!width || !height) {
    return fail('Missing image dimensions.', 400);
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return fail('The upload did not finish. Try again.', 400);
  }

  if (bytes.byteLength < MIN_BYTES) return fail('That file looks empty.', 400);
  if (bytes.byteLength > MAX_BYTES) return fail('That image is too big. Try one under 6 MB.', 413);

  const actualType = sniff(bytes);
  if (!actualType) return fail('That file is not an image we can read.', 415);
  if (actualType !== declaredType) return fail('That file is not the type it claims to be.', 415);

  const id = createId('img');
  try {
    await getBlobStore().put(id, bytes, actualType);
  } catch (error) {
    console.error('[puzzly] upload failed', error);
    return fail('We could not save that image. Please try again.', 502);
  }

  const asset: ImageAsset = {
    id,
    source: 'upload',
    url: `/api/blob/${id}`,
    thumbUrl: `/api/blob/${id}`,
    width,
    height,
    title: asString(url.searchParams.get('title'), 80) || 'Your picture',
    color: asString(url.searchParams.get('color'), 7)?.match(/^#[0-9a-fA-F]{6}$/)?.[0],
    createdAt: Date.now(),
  };

  // The record is what lets the server re-derive a trusted asset later, so a
  // room can never be created from client-invented dimensions. The expiry starts
  // now and slides forward every time the picture is actually used.
  try {
    await getRoomStore().putImage(asset, asset.createdAt + IMAGE_TTL_MS);
  } catch (error) {
    console.error('[puzzly] could not record uploaded image', error);
    return fail('We could not save that image. Please try again.', 502);
  }

  return json(
    {
      asset,
      // Surfaced so the picker can warn that a local-disk upload will not be
      // visible to the other player.
      durable: hasDurableBlobStore(),
    },
    { status: 201 },
  );
}
