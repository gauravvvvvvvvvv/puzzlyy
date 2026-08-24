'use client';

/**
 * The player's motion preference, as a boolean React can branch on.
 *
 * The stylesheet already neutralises CSS animation for `prefers-reduced-motion`,
 * but canvas work is invisible to CSS: the renderer has to be *told* not to
 * animate camera moves or celebrate. This is that channel.
 */

import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

export function useReducedMotion(): boolean {
  // Starts false so server and first client render agree; the effect corrects it
  // before anything has had a chance to animate.
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia(QUERY);
    setReduced(query.matches);

    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
