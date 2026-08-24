/**
 * The image pipeline.
 *
 * `ImageProvider` is the single seam every image comes through, so the rest of
 * the app never has to know whether a picture is a generated Original, an
 * upload sitting in blob storage, or a stock photo from a keyed provider.
 *
 *     ImageProvider
 *       ├── OriginalsProvider  — always available, zero keys, zero storage
 *       ├── UploadProvider     — blob storage, resolved by id
 *       └── StockProvider      — optional keys, falls back to Originals
 *
 * Originals are the default deliberately: the product has to be fully playable
 * with no configuration at all, so "no keys" must mean "smaller gallery", never
 * "empty gallery".
 *
 * **Server-only.** This module reads storage and env; client code should call
 * `/api/images` and import categories from `./categories`.
 */

import type { ImageAsset, ImageSource } from '@/types/models';

import { categoryById, queryFor } from './categories';
import { ORIGINAL_ASSETS, ORIGINALS, originalAsset, originalById } from './originals';
import { hasStockProvider, searchStock, stockProvider } from './stock';
import { getRoomStore, touchImage } from '@/lib/server/store';
import { isSafeImageUrl } from '@/lib/server/validate';

export { IMAGE_CATEGORIES, categoryById } from './categories';
export { ORIGINALS, originalById, renderOriginalSvg } from './originals';
export { hasStockProvider, stockProvider } from './stock';

const MIN_DIMENSION = 64;
const MAX_DIMENSION = 8_000;

export interface ImageQuery {
  source: ImageSource;
  category?: string | null;
  query?: string | null;
  page?: number;
  perPage?: number;
}

export interface ImagePage {
  items: ImageAsset[];
  page: number;
  hasMore: boolean;
  /** Which backend actually answered. `originals` when stock fell back. */
  provider: string;
  /** True when a stock request was served from Originals instead. */
  fallback: boolean;
}

export interface ImageProvider {
  readonly source: ImageSource;
  readonly label: string;
  /** False when the provider cannot answer at all (no keys, no storage). */
  readonly available: boolean;
  search(query: ImageQuery): Promise<ImagePage>;
  /** Re-derive a trusted asset from an id. `null` means "do not use this". */
  resolve(id: string): Promise<ImageAsset | null>;
}

function normalisePaging(query: ImageQuery): { page: number; perPage: number } {
  const page = Math.max(1, Math.min(20, Math.floor(query.page ?? 1)));
  const perPage = Math.max(1, Math.min(40, Math.floor(query.perPage ?? 24)));
  return { page, perPage };
}

function tokens(text: string | null | undefined): string[] {
  return (text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/* -------------------------------------------------------------------------- */
/* Originals                                                                  */
/* -------------------------------------------------------------------------- */

class OriginalsProvider implements ImageProvider {
  readonly source: ImageSource = 'original';
  readonly label = 'Puzzly Originals';
  readonly available = true;

  async search(query: ImageQuery): Promise<ImagePage> {
    const { page, perPage } = normalisePaging(query);
    const words = tokens(query.query);
    const category = query.category ? categoryById(query.category)?.id : null;

    let matches = ORIGINALS.filter((spec) => !category || spec.category === category);
    if (words.length) {
      matches = matches.filter((spec) => {
        const haystack = `${spec.title} ${spec.kind} ${spec.category}`.toLowerCase();
        return words.some((word) => haystack.includes(word));
      });
    }
    // A category with no Originals of its own should still show something
    // rather than an empty grid.
    if (!matches.length && (category || words.length)) matches = [...ORIGINALS];

    const start = (page - 1) * perPage;
    return {
      items: matches.slice(start, start + perPage).map(originalAsset),
      page,
      hasMore: matches.length > start + perPage,
      provider: 'originals',
      fallback: false,
    };
  }

  async resolve(id: string): Promise<ImageAsset | null> {
    const spec = originalById(id);
    return spec ? originalAsset(spec) : null;
  }
}

/* -------------------------------------------------------------------------- */
/* Uploads                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * There are no accounts, so there is no server-side "my uploads" list to page
 * through — the browser keeps its own library in local storage and asks for
 * specific ids. `search` therefore returns nothing on purpose.
 */
class UploadProvider implements ImageProvider {
  readonly source: ImageSource = 'upload';
  readonly label = 'Your uploads';
  readonly available = true;

  async search(query: ImageQuery): Promise<ImagePage> {
    const { page } = normalisePaging(query);
    return { items: [], page, hasMore: false, provider: 'uploads', fallback: false };
  }

  async resolve(id: string): Promise<ImageAsset | null> {
    if (!id.startsWith('img_')) return null;
    const asset = await getRoomStore().getImage(id);
    // Resolving is what room creation does, so this is the moment a picture
    // proves it is still wanted. Pushes the three-day clock back out.
    if (asset) touchImage(id);
    return asset;
  }
}

/* -------------------------------------------------------------------------- */
/* Stock                                                                      */
/* -------------------------------------------------------------------------- */

class StockProvider implements ImageProvider {
  readonly source: ImageSource = 'stock';
  readonly label = 'Stock photos';

  get available(): boolean {
    return hasStockProvider();
  }

  async search(query: ImageQuery): Promise<ImagePage> {
    const { page, perPage } = normalisePaging(query);
    const text = (query.query ?? '').trim();
    const term = text || queryFor(query.category, 'landscape nature scenery');

    const result = this.available ? await searchStock(term, page, perPage) : null;
    if (result && result.items.length) {
      return { items: result.items, page, hasMore: result.hasMore, provider: result.provider, fallback: false };
    }

    // No keys, an upstream failure, or an empty result set — hand back
    // Originals so the picker is never a dead end.
    const originals = await ORIGINALS_PROVIDER.search(query);
    return { ...originals, provider: 'originals', fallback: true };
  }

  /**
   * Stock photos live on the provider's CDN, not in our storage, so there is
   * nothing to look up by id. Room creation validates the URL host instead
   * (see `trustImageAsset`).
   */
  async resolve(): Promise<ImageAsset | null> {
    return null;
  }
}

/* -------------------------------------------------------------------------- */

const ORIGINALS_PROVIDER = new OriginalsProvider();
const UPLOAD_PROVIDER = new UploadProvider();
const STOCK_PROVIDER = new StockProvider();

export function imageProviders(): readonly ImageProvider[] {
  return [ORIGINALS_PROVIDER, STOCK_PROVIDER, UPLOAD_PROVIDER];
}

export function providerFor(source: ImageSource): ImageProvider {
  switch (source) {
    case 'stock':
      return STOCK_PROVIDER;
    case 'upload':
      return UPLOAD_PROVIDER;
    default:
      return ORIGINALS_PROVIDER;
  }
}

export function searchImages(query: ImageQuery): Promise<ImagePage> {
  return providerFor(query.source).search(query);
}

/** The default gallery shown before anyone types anything. */
export function defaultGallery(): readonly ImageAsset[] {
  return ORIGINAL_ASSETS;
}

/**
 * Turn a client-supplied asset into one the server is willing to cut a puzzle
 * from. Originals and uploads are re-derived from authoritative data so the
 * client cannot lie about dimensions; stock keeps its CDN URL but has to pass
 * the host allowlist and end up with plausible dimensions.
 *
 * Returns `null` when the asset should be rejected.
 */
export async function trustImageAsset(asset: ImageAsset): Promise<ImageAsset | null> {
  const resolved = await providerFor(asset.source).resolve(asset.id);
  if (resolved) return resolved;
  if (asset.source !== 'stock') return null;

  if (!isSafeImageUrl(asset.url)) return null;
  const thumb = isSafeImageUrl(asset.thumbUrl) ? asset.thumbUrl : asset.url;
  const width = clampDimension(asset.width);
  const height = clampDimension(asset.height);
  if (!width || !height) return null;

  return {
    ...asset,
    url: asset.url,
    thumbUrl: thumb,
    width,
    height,
    createdAt: asset.createdAt || Date.now(),
  };
}

function clampDimension(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < MIN_DIMENSION || rounded > MAX_DIMENSION) return null;
  return rounded;
}

/** Reported by `/api/health` and the picker so the UI can explain itself. */
export function imageCapabilities(): { originals: number; stock: string | null } {
  return { originals: ORIGINALS.length, stock: stockProvider() };
}
