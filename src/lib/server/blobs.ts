/**
 * Blob storage for uploaded images.
 *
 * Uploads are downscaled and re-encoded in the browser before they get here, so
 * a blob is typically 150–500 KB. Images are served back through
 * `/api/blob/[id]` — same origin, which keeps the puzzle canvas untainted and
 * means no storage URL or key is ever exposed to the client.
 *
 * There are two implementations and they are **not** interchangeable:
 *
 *  - `SupabaseBlobStore` is the production store. Durable, shared by every
 *    instance, survives deploys.
 *  - `FsBlobStore` is a **development** convenience so the app runs with zero
 *    configuration. On a serverless host it writes to `/tmp`, which is per
 *    instance and wiped on redeploy — a blob written by one request is often
 *    invisible to the next. It must never be the production store, so it
 *    announces itself loudly if it is ever constructed on Vercel, and the
 *    Supabase store does not quietly fall back to it (a failed upload has to
 *    surface as a failed upload).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { supabaseServiceKey, supabaseUrl } from './store';

export interface StoredBlob {
  data: Uint8Array;
  contentType: string;
}

export interface BlobStore {
  readonly kind: string;
  /** True only for storage that survives a redeploy and is shared by instances. */
  readonly durable: boolean;
  put(id: string, data: Uint8Array, contentType: string): Promise<void>;
  get(id: string): Promise<StoredBlob | null>;
  delete(id: string): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const ALLOWED_UPLOAD_TYPES = Object.keys(CONTENT_TYPES);

function extensionFor(contentType: string): string {
  return CONTENT_TYPES[contentType] ?? 'bin';
}

/* -------------------------------------------------------------------------- */
/* Filesystem (development only)                                              */
/* -------------------------------------------------------------------------- */

/**
 * Writes under `.data/blobs` locally. Keeps a small in-process cache so the
 * common "both players load the same image" case does not hit the disk twice.
 *
 * Not durable, not shared between instances. Development only.
 */
class FsBlobStore implements BlobStore {
  readonly kind = 'fs (development only — not durable)';
  readonly durable = false;
  private dir: string;
  private cache = new Map<string, StoredBlob>();
  private ready: Promise<void> | null = null;

  constructor() {
    const onVercel = Boolean(process.env.VERCEL);
    this.dir = onVercel
      ? path.join(os.tmpdir(), 'puzzly-blobs')
      : path.join(process.cwd(), '.data', 'blobs');
    if (onVercel) {
      console.error(
        '[puzzly] No durable blob storage configured. Uploaded images are being ' +
          'written to this instance’s /tmp and WILL disappear. Set ' +
          'NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and create the ' +
          'storage bucket. See README.md > Deployment modes.',
      );
    }
  }

  private ensure(): Promise<void> {
    this.ready ??= fs.mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.ready;
  }

  private async find(id: string): Promise<string | null> {
    for (const ext of new Set(Object.values(CONTENT_TYPES))) {
      const file = path.join(this.dir, `${id}.${ext}`);
      try {
        await fs.access(file);
        return file;
      } catch {
        /* keep looking */
      }
    }
    return null;
  }

  async put(id: string, data: Uint8Array, contentType: string): Promise<void> {
    await this.ensure();
    const file = path.join(this.dir, `${id}.${extensionFor(contentType)}`);
    await fs.writeFile(file, data);
    this.remember(id, { data, contentType });
  }

  async get(id: string): Promise<StoredBlob | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    await this.ensure();
    const file = await this.find(id);
    if (!file) return null;
    const data = new Uint8Array(await fs.readFile(file));
    const ext = path.extname(file).slice(1);
    const contentType =
      Object.entries(CONTENT_TYPES).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
    const blob = { data, contentType };
    this.remember(id, blob);
    return blob;
  }

  async delete(id: string): Promise<void> {
    this.cache.delete(id);
    const file = await this.find(id);
    if (file) await fs.rm(file, { force: true });
  }

  private remember(id: string, blob: StoredBlob): void {
    this.cache.set(id, blob);
    if (this.cache.size > 24) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Supabase Storage                                                           */
/* -------------------------------------------------------------------------- */

class SupabaseBlobStore implements BlobStore {
  readonly kind = 'supabase-storage';
  readonly durable = true;
  private base: string;
  private key: string;
  private bucket: string;

  constructor(url: string, key: string, bucket: string) {
    this.base = `${url.replace(/\/$/, '')}/storage/v1/object`;
    this.key = key;
    this.bucket = bucket;
  }

  /**
   * Throws on failure on purpose. Writing to local disk instead would make the
   * upload look successful and then 404 for the other player, which is exactly
   * the failure mode that is hardest to debug.
   */
  async put(id: string, data: Uint8Array, contentType: string): Promise<void> {
    const name = `${id}.${extensionFor(contentType)}`;
    const res = await fetch(`${this.base}/${this.bucket}/${name}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.key}`,
        'Content-Type': contentType,
        'x-upsert': 'true',
      },
      body: new Blob([data as BlobPart], { type: contentType }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[puzzly] supabase storage upload failed', res.status, detail.slice(0, 300));
      throw new Error(`Storage rejected the upload (${res.status}).`);
    }
  }

  async get(id: string): Promise<StoredBlob | null> {
    for (const ext of new Set(Object.values(CONTENT_TYPES))) {
      try {
        const res = await fetch(`${this.base}/${this.bucket}/${id}.${ext}`, {
          headers: { Authorization: `Bearer ${this.key}` },
          cache: 'no-store',
        });
        if (!res.ok) continue;
        const buffer = new Uint8Array(await res.arrayBuffer());
        const contentType =
          res.headers.get('content-type') ??
          Object.entries(CONTENT_TYPES).find(([, e]) => e === ext)?.[0] ??
          'application/octet-stream';
        return { data: buffer, contentType };
      } catch {
        /* try the next extension */
      }
    }
    return null;
  }

  async delete(id: string): Promise<void> {
    for (const ext of new Set(Object.values(CONTENT_TYPES))) {
      await fetch(`${this.base}/${this.bucket}/${id}.${ext}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.key}` },
      }).catch(() => undefined);
    }
  }
}

/* -------------------------------------------------------------------------- */

declare global {
  // eslint-disable-next-line no-var
  var __puzzlyBlobs: BlobStore | undefined;
}

export function getBlobStore(): BlobStore {
  if (globalThis.__puzzlyBlobs) return globalThis.__puzzlyBlobs;
  // Falls back to the public URL: SUPABASE_URL is an optional override, and
  // reading only it would silently downgrade production to local-disk blobs,
  // which do not survive a deploy on Vercel.
  const url = supabaseUrl();
  const key = supabaseServiceKey();
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'puzzly-images';
  const store: BlobStore =
    url && key ? new SupabaseBlobStore(url, key, bucket) : new FsBlobStore();
  globalThis.__puzzlyBlobs = store;
  return store;
}

/** True when uploads will still be there after the next deploy. */
export function hasDurableBlobStore(): boolean {
  return getBlobStore().durable;
}
