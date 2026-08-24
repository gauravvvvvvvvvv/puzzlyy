/**
 * Game registry.
 *
 * The room, realtime and results layers are all keyed by `GameType`, so adding a
 * second mode means adding an entry here plus a board component — not touching
 * the transport or the room record (spec §28).
 */

import type { GameDefinition, GameType } from '@/types/models';

export const GAMES: readonly GameDefinition[] = [
  {
    type: 'jigsaw',
    name: 'Jigsaw',
    tagline: 'Turn any picture into a puzzle.',
    blurb: 'Cut a picture into pieces and rebuild it together.',
    icon: 'jigsaw',
    status: 'live',
    players: { min: 1, max: 6 },
  },
  {
    type: 'scramble',
    name: 'Scramble',
    tagline: 'Slide the tiles back into place.',
    blurb: 'A sliding tile puzzle with one square missing.',
    icon: 'scramble',
    status: 'soon',
    players: { min: 1, max: 4 },
  },
  {
    type: 'find-difference',
    name: 'Spot the Difference',
    tagline: 'Seven changes. Find them all.',
    blurb: 'Two near-identical pictures, one sharp pair of eyes.',
    icon: 'spot',
    status: 'soon',
    players: { min: 1, max: 4 },
  },
  {
    type: 'memory',
    name: 'Memory',
    tagline: 'Match every pair.',
    blurb: 'Flip cards, remember what you saw, clear the board.',
    icon: 'memory',
    status: 'soon',
    players: { min: 1, max: 6 },
  },
  {
    type: 'hidden-object',
    name: 'Hidden Objects',
    tagline: 'Everything is in there somewhere.',
    blurb: 'A busy scene and a list of things to find in it.',
    icon: 'search',
    status: 'soon',
    players: { min: 1, max: 4 },
  },
  {
    type: 'escape',
    name: 'Escape Room',
    tagline: 'One locked door, two clever people.',
    blurb: 'Linked puzzles you can only finish by talking to each other.',
    icon: 'key',
    status: 'soon',
    players: { min: 2, max: 4 },
  },
];

export const LIVE_GAMES = GAMES.filter((g) => g.status === 'live');

export function gameDefinition(type: GameType): GameDefinition {
  return GAMES.find((g) => g.type === type) ?? GAMES[0];
}

export function isPlayable(type: GameType): boolean {
  return gameDefinition(type).status === 'live';
}
