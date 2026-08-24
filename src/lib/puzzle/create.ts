/**
 * Puzzle construction.
 *
 * A `Puzzle` is deliberately tiny: an image, a grid, a seed, and the settings.
 * Everything else — tab directions, jitter, the scatter layout, the sprite atlas
 * — is regenerated from those by `buildGeometry` and `PuzzleEngine.create`, so
 * two browsers that hold the same `Puzzle` agree on every pixel without
 * exchanging geometry.
 *
 * That determinism is why this factory does no randomisation beyond picking the
 * seed itself.
 */

import { difficultyFor } from '@/lib/format';
import { createId } from '@/lib/ids';
import type { GameType, ImageAsset, PieceCount, Puzzle, PuzzleSettings } from '@/types/models';

import { fitGrid } from './geometry';
import { randomSeed } from './rng';

export interface CreatePuzzleInput {
  image: ImageAsset;
  settings: PuzzleSettings;
  gameType?: GameType;
  /** Supply to reproduce an existing cut (rematch, challenge, tests). */
  seed?: number;
  title?: string;
  createdBy?: string;
  now?: number;
}

/**
 * The requested piece count is a target, not a promise: the grid is fitted to
 * the image's aspect ratio so pieces stay roughly square, which usually lands a
 * few pieces either side of the number the player picked. `pieceCount` reports
 * what they actually got.
 */
export function createPuzzle(input: CreatePuzzleInput): Puzzle {
  const now = input.now ?? Date.now();
  const aspect = input.image.height > 0 ? input.image.width / input.image.height : 1;
  const { cols, rows, count } = fitGrid(aspect, input.settings.pieceCount);

  return {
    id: createId('pz'),
    imageId: input.image.id,
    image: input.image,
    gameType: input.gameType ?? 'jigsaw',
    pieceCount: count,
    cols,
    rows,
    seed: input.seed ?? randomSeed(),
    settings: input.settings,
    difficulty: difficultyFor(count, input.settings),
    createdAt: now,
    createdBy: input.createdBy,
    title: (input.title ?? '').trim() || input.image.title || 'Untitled puzzle',
  };
}

/** Re-cut the same picture with a fresh seed, keeping the id stable-ish. */
export function recutPuzzle(puzzle: Puzzle, now = Date.now()): Puzzle {
  return { ...puzzle, id: createId('pz'), seed: randomSeed(), createdAt: now };
}

/** Preview of what a piece-count choice will actually produce. */
export function previewGrid(image: { width: number; height: number }, pieceCount: PieceCount) {
  const aspect = image.height > 0 ? image.width / image.height : 1;
  return fitGrid(aspect, pieceCount);
}
