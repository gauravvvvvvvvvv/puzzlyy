/**
 * Realtime client entry point.
 *
 * The app asks for a transport and gets whichever backend this deployment can
 * actually support. Nothing above this file knows which one it received: both
 * satisfy `RealtimeTransport`, so the puzzle, lobby and presence code is written
 * once (spec §28).
 *
 *   - **Supabase Realtime** when the browser has a URL and anon key. Correct
 *     across serverless instances, and ephemeral traffic goes peer-to-peer.
 *   - **SSE** otherwise. Zero configuration — `npm run dev` and any
 *     single-process host work with no accounts at all — but every request has
 *     to reach the same process, so it is not a production answer on Vercel.
 */

import type { RealtimeTransport, TransportConfig } from '@/types/events';

import type { RealtimeMode } from './api';
import { SseTransport } from './sse';
import { SupabaseTransport, supabaseBrowserConfig } from './supabase';

export type { RealtimeMode } from './api';
export { ApiError } from './api';
export { BaseTransport } from './transport';
export { SseTransport } from './sse';
export { SupabaseTransport } from './supabase';

/**
 * Which mode this browser can really use.
 *
 * The server reports what it *thinks* is available, but only the bundle knows
 * whether `NEXT_PUBLIC_SUPABASE_ANON_KEY` was actually inlined at build time —
 * setting it in Vercel *after* a build leaves the running bundle without it. So
 * the server's answer is treated as a preference and checked here, and the
 * fallback is loud, because silently serving SSE from a multi-instance
 * deployment would look like random desync rather than a misconfiguration.
 */
export function resolveMode(preferred: RealtimeMode): RealtimeMode {
  if (preferred !== 'supabase') return 'sse';
  if (supabaseBrowserConfig()) return 'supabase';
  console.warn(
    '[puzzly] The server reports Supabase Realtime, but this bundle has no ' +
      'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY. Falling back to SSE, ' +
      'which only works when every request reaches the same server process. ' +
      'Set both variables and redeploy.',
  );
  return 'sse';
}

export function createTransport(config: TransportConfig, mode: RealtimeMode): RealtimeTransport {
  return resolveMode(mode) === 'supabase'
    ? new SupabaseTransport(config)
    : new SseTransport(config);
}
