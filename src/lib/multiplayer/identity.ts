/**
 * Anonymous identity.
 *
 * No accounts for the MVP (spec §2): a player is a name, an emoji and a colour,
 * generated on first visit and kept in localStorage. Shared by client and
 * server so colour assignment agrees on both sides.
 */

import type { PlayerColorId } from '@/types/models';

export const PLAYER_COLORS: Record<PlayerColorId, { hex: string; name: string }> = {
  1: { hex: '#ff8a5b', name: 'Apricot' },
  2: { hex: '#7dd3c0', name: 'Mint' },
  3: { hex: '#b79bff', name: 'Lilac' },
  4: { hex: '#ffd166', name: 'Butter' },
  5: { hex: '#ff8fa3', name: 'Rose' },
  6: { hex: '#7cc5ff', name: 'Sky' },
};

export function playerColor(colorId: PlayerColorId): string {
  return PLAYER_COLORS[colorId]?.hex ?? PLAYER_COLORS[1].hex;
}

/** First unused colour, so two players never look alike. */
export function nextColorId(taken: PlayerColorId[]): PlayerColorId {
  const ids: PlayerColorId[] = [1, 2, 3, 4, 5, 6];
  return ids.find((id) => !taken.includes(id)) ?? 1;
}

export const AVATARS = [
  '🦊',
  '🐼',
  '🦉',
  '🐙',
  '🦋',
  '🐝',
  '🦔',
  '🐳',
  '🦩',
  '🐢',
  '🦌',
  '🐧',
  '🦑',
  '🐌',
  '🦜',
  '🐛',
] as const;

const ADJECTIVES = [
  'Cosy',
  'Clever',
  'Quiet',
  'Sunny',
  'Brave',
  'Snug',
  'Merry',
  'Swift',
  'Amber',
  'Velvet',
  'Golden',
  'Rusty',
];

const NOUNS = [
  'Fox',
  'Otter',
  'Sparrow',
  'Comet',
  'Lantern',
  'Pebble',
  'Willow',
  'Harbour',
  'Ember',
  'Meadow',
  'Compass',
  'Marble',
];

export function randomName(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a} ${n}`;
}

export function randomAvatar(): string {
  return AVATARS[Math.floor(Math.random() * AVATARS.length)];
}

/** Trim, collapse whitespace, cap length, and never allow an empty name. */
export function sanitizeName(input: unknown): string {
  if (typeof input !== 'string') return randomName();
  const cleaned = input.replace(/\s+/g, ' ').trim().slice(0, 18);
  return cleaned.length >= 1 ? cleaned : randomName();
}

export function sanitizeAvatar(input: unknown): string {
  if (typeof input !== 'string') return randomAvatar();
  // Accept one or two code points of emoji; fall back otherwise.
  const points = [...input];
  if (points.length === 0 || points.length > 4) return randomAvatar();
  return points.slice(0, 4).join('');
}

export const REACTIONS = ['❤️', '😂', '🔥', '👀', '🎉', '😭'] as const;
export type Reaction = (typeof REACTIONS)[number];

export function isReaction(value: unknown): value is Reaction {
  return typeof value === 'string' && (REACTIONS as readonly string[]).includes(value);
}
