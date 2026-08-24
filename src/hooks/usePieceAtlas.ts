'use client';

/**
 * Cut the picture into sprites, once.
 *
 * Rasterising 500 shaped pieces takes a moment, so it happens here rather than
 * inside the renderer: the hook reports progress while it works, which is what
 * lets the room show "Cutting 500 pieces…" instead of a frozen screen (spec §14).
 *
 * The work is keyed on the things that change the shapes — the picture and the
 * cut — so a rematch (new seed) rebuilds, but a reconnect, a camera move or a
 * re-render never does. GPU-backed canvases are expensive to hold, so the old
 * atlas is always disposed before a new one replaces it.
 */

import { useEffect, useRef, useState } from 'react';

import type { PieceGeometry } from '@/lib/puzzle/geometry';
import { buildPieceAtlas, loadImage, resolveImageUrl } from '@/lib/puzzle/sprites';
import type { PieceAtlas } from '@/lib/puzzle/sprites';

export interface AtlasState {
  atlas: PieceAtlas | null;
  image: HTMLImageElement | null;
  /** 0..1, for the cutting progress bar. */
  progress: number;
  error: string | null;
}

const IDLE: AtlasState = { atlas: null, image: null, progress: 0, error: null };

export function usePieceAtlas(
  imageUrl: string | null,
  geometry: PieceGeometry | null,
  /** Anything that changes the shapes but not the URL — the cut seed. */
  cutKey: string | number,
): AtlasState {
  const [state, setState] = useState<AtlasState>(IDLE);
  const liveRef = useRef<PieceAtlas | null>(null);

  useEffect(() => {
    if (!imageUrl || !geometry) return;

    const url = imageUrl;
    const cut = geometry;
    const controller = new AbortController();
    let cancelled = false;

    async function build() {
      setState({ atlas: null, image: null, progress: 0, error: null });
      try {
        const image = await loadImage(resolveImageUrl(url), controller.signal);
        if (cancelled) return;

        const atlas = await buildPieceAtlas(image, cut, {
          signal: controller.signal,
          onProgress: ({ done, total }) => {
            if (!cancelled) {
              setState((prev) => ({ ...prev, progress: total > 0 ? done / total : 0 }));
            }
          },
        });
        if (cancelled) {
          atlas.dispose();
          return;
        }

        liveRef.current?.dispose();
        liveRef.current = atlas;
        setState({ atlas, image, progress: 1, error: null });
      } catch (cause) {
        if (cancelled) return;
        setState({
          atlas: null,
          image: null,
          progress: 0,
          error:
            cause instanceof Error && cause.message
              ? cause.message
              : 'That picture could not be prepared for play.',
        });
      }
    }

    void build();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // Keyed on the picture and the cut, not on `geometry`: that object is rebuilt
    // whenever the engine is, and depending on it would re-cut every sprite on
    // every reconnect.
  }, [imageUrl, cutKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Release the canvases when the room closes, not just when the cut changes.
  useEffect(
    () => () => {
      liveRef.current?.dispose();
      liveRef.current = null;
    },
    [],
  );

  return state;
}
