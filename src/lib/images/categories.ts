/**
 * Browse categories.
 *
 * The same list drives the stock search and the Originals filter, so a category
 * chip always has something behind it even with no API keys configured.
 */

import type { StockCategory } from '@/types/models';

export const IMAGE_CATEGORIES: readonly StockCategory[] = [
  { id: 'nature', label: 'Nature', query: 'landscape nature scenery' },
  { id: 'animals', label: 'Animals', query: 'animal wildlife portrait' },
  { id: 'travel', label: 'Travel', query: 'travel destination view' },
  { id: 'cities', label: 'Cities', query: 'city skyline street' },
  { id: 'space', label: 'Space', query: 'space galaxy nebula stars' },
  { id: 'architecture', label: 'Architecture', query: 'architecture building facade' },
  { id: 'art', label: 'Art', query: 'painting artwork colourful' },
  { id: 'food', label: 'Food', query: 'food flatlay colourful' },
  { id: 'cars', label: 'Cars', query: 'car classic automotive' },
  { id: 'flowers', label: 'Flowers', query: 'flowers blossom garden' },
  { id: 'cute', label: 'Cute', query: 'cute puppy kitten' },
  { id: 'fantasy', label: 'Fantasy', query: 'fantasy magical dreamlike' },
  { id: 'anime', label: 'Anime-inspired', query: 'anime illustration pastel sky' },
  { id: 'abstract', label: 'Abstract', query: 'abstract pattern texture' },
];

const BY_ID = new Map(IMAGE_CATEGORIES.map((c) => [c.id, c]));

export function categoryById(id: string): StockCategory | null {
  return BY_ID.get(id) ?? null;
}

/** Falls back to the category's own label so a chip never renders empty. */
export function queryFor(categoryId: string | null | undefined, fallback = ''): string {
  if (!categoryId) return fallback;
  return BY_ID.get(categoryId)?.query ?? fallback;
}
