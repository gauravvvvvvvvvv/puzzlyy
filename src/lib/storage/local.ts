/**
 * localStorage, defensively.
 *
 * Every accessor here can throw or come back empty for reasons that have
 * nothing to do with a bug: Safari private browsing throws on write, a browser
 * set to block site data throws on read, and a first visit is simply empty. So
 * storage is treated as a cache that may vanish — never as the source of truth
 * for anything the player would be upset to lose. Puzzle progress lives on the
 * server (spec §22); what lives here is convenience.
 */

const PREFIX = 'puzzly:v1:';

let warned = false;

function store(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    // Touching the property is itself what throws in a blocked context.
    return window.localStorage;
  } catch {
    if (!warned) {
      warned = true;
      console.info('[puzzly] Local storage is unavailable; preferences will not persist.');
    }
    return null;
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const s = store();
  if (!s) return fallback;
  try {
    const raw = s.getItem(PREFIX + key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    // Corrupt or truncated value: drop it rather than failing forever.
    try {
      s.removeItem(PREFIX + key);
    } catch {
      /* nothing else to try */
    }
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota exceeded, or writes are blocked. Both are survivable.
  }
}

export function remove(key: string): void {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(PREFIX + key);
  } catch {
    /* nothing to do */
  }
}

/** Every Puzzly key currently present, without the prefix. */
export function keys(): string[] {
  const s = store();
  if (!s) return [];
  const out: string[] = [];
  try {
    for (let i = 0; i < s.length; i += 1) {
      const key = s.key(i);
      if (key?.startsWith(PREFIX)) out.push(key.slice(PREFIX.length));
    }
  } catch {
    return out;
  }
  return out;
}

export function isAvailable(): boolean {
  return store() !== null;
}
