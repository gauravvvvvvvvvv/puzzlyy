/**
 * Blob storage for uploaded images.
 *
 * Uploads are downscaled and re-encoded in the browser before they get here, so
 * a blob is typically 150–500 KB. Images are served back through
 * `/api/blob/[id]` — same origin, which keeps the puzzle canvas untainted and
 * means no storage URL or key is ever exposed to the client.
 *
 * There are three implementations:
 *
 *  - `R2BlobStore` is preferred in production. Durable, shared by every
 *    instance, cheap to keep, and has no public bucket URL.
 *  - `SupabaseBlobStore` remains a durable fallback for older deployments.
 *  - `FsBlobStore` is a **development** convenience so the app runs with zero
 *    configuration. On a serverless host it writes to `/tmp`, which is per
 *    instance and wiped on redeploy — a blob written by one request is often
 *    invisible to the next. It must never be the production store, so it
 *    announces itself loudly if it is ever constructed on Vercel, and the
 *    Supabase store does not quietly fall back to it (a failed upload has to
 *    surface as a failed upload).
 */

import { promises as fs } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
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
          'written to this instance’s /tmp and WILL disappear. Configure R2 ' +
          '(R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET) ' +
          'or Supabase Storage. See README.md > Deployment modes.',
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
/* Cloudflare R2                                                              */
/* -------------------------------------------------------------------------- */

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

function r2Config(): R2Config | null {
  const values = {
    accountId: process.env.R2_ACCOUNT_ID?.trim() ?? '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID?.trim() ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim() ?? '',
    bucket: process.env.R2_BUCKET?.trim() ?? '',
  };
  const configured = Object.values(values).filter(Boolean).length;
  if (configured === 0) return null;
  if (configured !== 4) {
    const missing: string[] = [];
    if (!values.accountId) missing.push('R2_ACCOUNT_ID');
    if (!values.accessKeyId) missing.push('R2_ACCESS_KEY_ID');
    if (!values.secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY');
    if (!values.bucket) missing.push('R2_BUCKET');
    throw new Error(`Incomplete R2 configuration. Missing: ${missing.join(', ')}`);
  }
  return values;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function awsDate(now = new Date()): { amzDate: string; day: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, day: iso.slice(0, 8) };
}

/**
 * Sign one path-style request for R2's S3-compatible endpoint.
 *
 * We deliberately keep the signed-header set tiny. Content-Type can still be
 * sent on PUT, but does not need to participate in the signature.
 */
function signR2Request(
  config: R2Config,
  method: 'GET' | 'PUT' | 'DELETE',
  objectName: string,
  payload: Uint8Array | '',
): { url: string; headers: Record<string, string> } {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const path = `/${encodeURIComponent(config.bucket)}/${encodeURIComponent(objectName)}`;
  const { amzDate, day } = awsDate();
  const payloadHash = sha256Hex(payload);

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    path,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${day}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${config.secretAccessKey}`, day);
  const kRegion = hmac(kDate, 'auto');
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    url: `https://${host}${path}`,
    headers: {
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
  };
}

class R2BlobStore implements BlobStore {
  readonly kind = 'cloudflare-r2';
  readonly durable = true;

  constructor(private config: R2Config) {}

  async put(id: string, data: Uint8Array, contentType: string): Promise<void> {
    const name = `${id}.${extensionFor(contentType)}`;
    const signed = signR2Request(this.config, 'PUT', name, data);
    const res = await fetch(signed.url, {
      method: 'PUT',
      headers: { ...signed.headers, 'Content-Type': contentType },
      body: new Blob([data as BlobPart], { type: contentType }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[puzzly] R2 upload failed', res.status, detail.slice(0, 300));
      throw new Error(`R2 rejected the upload (${res.status}).`);
    }
  }

  async get(id: string): Promise<StoredBlob | null> {
    for (const [contentType, ext] of Object.entries(CONTENT_TYPES)) {
      const signed = signR2Request(this.config, 'GET', `${id}.${ext}`, '');
      try {
        const res = await fetch(signed.url, {
          headers: signed.headers,
          cache: 'no-store',
        });
        if (res.status === 404) continue;
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          console.error('[puzzly] R2 read failed', res.status, detail.slice(0, 300));
          continue;
        }
        return {
          data: new Uint8Array(await res.arrayBuffer()),
          contentType: res.headers.get('content-type') ?? contentType,
        };
      } catch {
        /* try the next extension */
      }
    }
    return null;
  }

  async delete(id: string): Promise<void> {
    for (const ext of Object.values(CONTENT_TYPES)) {
      const signed = signR2Request(this.config, 'DELETE', `${id}.${ext}`, '');
      await fetch(signed.url, { method: 'DELETE', headers: signed.headers }).catch(() => undefined);
    }
  }
}

class MigratingBlobStore implements BlobStore {
  readonly kind = 'cloudflare-r2 (supabase read fallback)';
  readonly durable = true;

  constructor(
    private primary: BlobStore,
    private legacy: BlobStore,
  ) {}

  put(id: string, data: Uint8Array, contentType: string): Promise<void> {
    return this.primary.put(id, data, contentType);
  }

  async get(id: string): Promise<StoredBlob | null> {
    return (await this.primary.get(id)) ?? this.legacy.get(id);
  }

  async delete(id: string): Promise<void> {
    await Promise.allSettled([this.primary.delete(id), this.legacy.delete(id)]);
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

  const url = supabaseUrl();
  const key = supabaseServiceKey();
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'puzzly-images';
  const legacy = url && key ? new SupabaseBlobStore(url, key, bucket) : null;

  // Prefer R2 for every new write. During migration, reads fall back to
  // Supabase Storage so existing puzzle links keep working until their normal
  // expiry sweep removes those old objects.
  const r2 = r2Config();
  if (r2) {
    const primary = new R2BlobStore(r2);
    globalThis.__puzzlyBlobs = legacy ? new MigratingBlobStore(primary, legacy) : primary;
    return globalThis.__puzzlyBlobs;
  }

  // No R2 configured: preserve the old Supabase Storage behaviour.
  const store: BlobStore = legacy ?? new FsBlobStore();
  globalThis.__puzzlyBlobs = store;
  return store;
}

/** True when uploads will still be there after the next deploy. */
export function hasDurableBlobStore(): boolean {
  return getBlobStore().durable;
}
