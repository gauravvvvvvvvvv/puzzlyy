/**
 * Client-side image preparation.
 *
 * A photo straight off a phone is 4–12 MB of 4032×3024 JPEG. None of that helps
 * a jigsaw — the board never shows more than a couple of thousand pixels across —
 * and all of it costs upload time on a phone tethered to hotel wifi. So the
 * browser decodes, downscales and re-encodes before anything leaves the device.
 *
 * The numbers here are not arbitrary: they mirror `/api/upload` exactly. That
 * route sniffs the leading bytes and rejects a body whose real format disagrees
 * with its `Content-Type`, so the type we send is always the type the canvas
 * actually produced, never the type we asked for.
 *
 * **Browser-only.** Uses `createImageBitmap`, `<canvas>` and `URL`. Do not import
 * this from a server component — and note it is a sibling of the server-only
 * `./index`, which must never be pulled into a client bundle.
 */

/** Hard ceiling enforced by the upload route. */
export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
/** Below this the route assumes a truncated body. */
export const MIN_UPLOAD_BYTES = 256;
/** Anything smaller looks like a broken thumbnail once it is cut up. */
export const MIN_DIMENSION = 200;
export const MAX_DIMENSION = 8_000;

/**
 * Enough detail that a 500-piece puzzle still looks sharp when zoomed in, and
 * small enough to encode in well under a second on a mid-range phone.
 */
export const TARGET_MAX_EDGE = 2_400;

/**
 * Refuse absurd inputs before spending memory on a decode. A 40 MP HEIC turned
 * JPEG can still be under this; a 60 MB PSD export cannot.
 */
export const MAX_INPUT_BYTES = 40 * 1024 * 1024;

const ENCODE_TYPES = ['image/webp', 'image/jpeg'] as const;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const QUALITY_STEPS = [0.9, 0.82, 0.72, 0.6, 0.5];

export interface PreparedUpload {
  /** The bytes to send. `blob.type` is the Content-Type the route must be given. */
  blob: Blob;
  width: number;
  height: number;
  /** Average colour, used as the placeholder behind a loading board. */
  color: string;
  /** Local preview URL. Call `releasePrepared` when the picker moves on. */
  previewUrl: string;
  /** For "we shrank this for you" copy. */
  originalBytes: number;
  originalWidth: number;
  originalHeight: number;
}

/** Human-readable failure, safe to render straight into the UI. */
export class PrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrepareError';
  }
}

/* -------------------------------------------------------------------------- */
/* Decoding                                                                   */
/* -------------------------------------------------------------------------- */

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** ImageBitmaps hold GPU memory until explicitly closed. */
  release(): void;
}

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Safari has historically refused some valid files here. Fall through to
      // the <img> path rather than telling the player their photo is broken.
    }
  }
  return decodeViaElement(file);
}

function decodeViaElement(file: Blob): Promise<Decoded> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'sync';
    img.onload = () => {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (!width || !height) {
        URL.revokeObjectURL(url);
        reject(new PrepareError('That file does not look like an image we can read.'));
        return;
      }
      resolve({
        source: img,
        width,
        height,
        release: () => URL.revokeObjectURL(url),
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(
        new PrepareError(
          'We could not open that image. JPEG, PNG and WebP all work — HEIC from an iPhone often does not.',
        ),
      );
    };
    img.src = url;
  });
}

/** Read the pixel dimensions of an already-hosted image. */
export function measureImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Same-origin for uploads and Originals; stock CDNs all send permissive CORS.
    img.crossOrigin = 'anonymous';
    img.onload = () =>
      resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
    img.onerror = () => reject(new PrepareError('That picture could not be loaded.'));
    img.src = url;
  });
}

/* -------------------------------------------------------------------------- */
/* Encoding                                                                   */
/* -------------------------------------------------------------------------- */

function scaleFor(width: number, height: number, maxEdge: number): number {
  const longest = Math.max(width, height);
  return longest <= maxEdge ? 1 : maxEdge / longest;
}

function drawTo(decoded: Decoded, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new PrepareError('This browser would not give us a canvas to work on.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(decoded.source, 0, 0, width, height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

/** Average colour, via the cheapest downscale there is: draw the whole thing into 1×1. */
function averageColor(decoded: Decoded): string {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return '#8a8a8a';
    ctx.drawImage(decoded.source, 0, 0, 1, 1);
    const [r = 138, g = 138, b = 138] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    // A tainted canvas (a cross-origin source without CORS) throws here. The
    // colour is decoration, so a neutral grey is a perfectly good answer.
    return '#8a8a8a';
  }
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

export interface PrepareOptions {
  maxEdge?: number;
  /** Called with 0–1 so the UI can show something during a slow decode. */
  onProgress?: (fraction: number) => void;
}

/**
 * Decode → downscale → re-encode, shrinking further until the result fits the
 * upload limit. Throws `PrepareError` with copy that can be shown as-is.
 */
export async function prepareUpload(file: File | Blob, options: PrepareOptions = {}): Promise<PreparedUpload> {
  const { maxEdge = TARGET_MAX_EDGE, onProgress } = options;

  if (file.size > MAX_INPUT_BYTES) {
    throw new PrepareError(
      `That file is ${formatMb(file.size)} — a bit much even for us. Try one under ${formatMb(MAX_INPUT_BYTES)}.`,
    );
  }
  if (file.size < MIN_UPLOAD_BYTES) {
    throw new PrepareError('That file is empty.');
  }

  onProgress?.(0.1);
  const decoded = await decode(file);
  onProgress?.(0.45);

  try {
    if (decoded.width < MIN_DIMENSION || decoded.height < MIN_DIMENSION) {
      throw new PrepareError(
        `That image is only ${decoded.width}×${decoded.height}. Puzzles need at least ${MIN_DIMENSION} pixels on each side.`,
      );
    }
    if (decoded.width > MAX_DIMENSION * 4 || decoded.height > MAX_DIMENSION * 4) {
      throw new PrepareError('That image is enormous. Try exporting it a little smaller first.');
    }

    const color = averageColor(decoded);
    let edge = Math.min(maxEdge, MAX_DIMENSION);

    // Outer loop shrinks, inner loop drops quality. Quality first, because
    // pixels are what the puzzle is made of.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const scale = scaleFor(decoded.width, decoded.height, edge);
      const width = Math.max(MIN_DIMENSION, Math.round(decoded.width * scale));
      const height = Math.max(MIN_DIMENSION, Math.round(decoded.height * scale));
      const canvas = drawTo(decoded, width, height);

      for (const type of ENCODE_TYPES) {
        for (const quality of QUALITY_STEPS) {
          const blob = await toBlob(canvas, type, quality);
          // A browser that cannot encode `type` hands back PNG (or null). PNG is
          // allowed, so we keep it if it fits and otherwise move on.
          if (!blob || !ALLOWED_TYPES.has(blob.type)) break;
          if (blob.size >= MIN_UPLOAD_BYTES && blob.size <= MAX_UPLOAD_BYTES) {
            onProgress?.(1);
            return {
              blob,
              width,
              height,
              color,
              previewUrl: URL.createObjectURL(blob),
              originalBytes: file.size,
              originalWidth: decoded.width,
              originalHeight: decoded.height,
            };
          }
          // PNG ignores `quality`, so retrying it at a lower number is pointless.
          if (blob.type === 'image/png') break;
        }
      }

      onProgress?.(0.45 + 0.12 * (attempt + 1));
      edge = Math.round(edge * 0.72);
      if (edge < MIN_DIMENSION) break;
    }

    throw new PrepareError(
      'We could not get that picture under the size limit. Try a smaller export or a different photo.',
    );
  } finally {
    decoded.release();
  }
}

/** Release the object URL handed back by `prepareUpload`. */
export function releasePrepared(prepared: Pick<PreparedUpload, 'previewUrl'> | null): void {
  if (prepared?.previewUrl.startsWith('blob:')) URL.revokeObjectURL(prepared.previewUrl);
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
