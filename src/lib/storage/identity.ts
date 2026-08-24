/**
 * Anonymous identity (spec §2 — no signup, ever).
 *
 * A player is a name, an emoji and nothing else. It is generated on first visit
 * so the very first click can be "Play with a friend" rather than a form, and
 * kept in localStorage so a returning visitor is recognised by their friend.
 *
 * `id` is a client-side convenience only. The seat a player actually occupies in
 * a room is issued by the server at join time and proved with a token — nothing
 * here is a credential (spec §30).
 */

import { createId } from '@/lib/ids';
import { randomAvatar, randomName, sanitizeAvatar, sanitizeName } from '@/lib/multiplayer/identity';
import type { LocalIdentity } from '@/types/models';

import { readJson, writeJson } from './local';

const KEY = 'identity';

/**
 * The identity used before the browser has told us anything. Rendering the real
 * one during SSR is impossible — localStorage does not exist there — so pages
 * render this and swap on mount, which keeps markup identical on both sides and
 * avoids a hydration mismatch.
 */
export const ANONYMOUS: LocalIdentity = { id: '', name: 'You', avatar: '🙂' };

function isIdentity(value: unknown): value is LocalIdentity {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<LocalIdentity>;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.avatar === 'string';
}

/** Read the stored identity, creating one on first visit. Browser only. */
export function loadIdentity(): LocalIdentity {
  const stored = readJson<unknown>(KEY, null);
  if (isIdentity(stored) && stored.id) {
    // Re-sanitise on read: a value written by an older build (or edited by
    // hand) should not be able to put an over-long name on another player's
    // screen.
    return {
      id: stored.id,
      name: sanitizeName(stored.name) || randomName(),
      avatar: sanitizeAvatar(stored.avatar),
    };
  }
  const fresh: LocalIdentity = {
    id: createId('me', 10),
    name: randomName(),
    avatar: randomAvatar(),
  };
  writeJson(KEY, fresh);
  return fresh;
}

export function saveIdentity(identity: LocalIdentity): LocalIdentity {
  const clean: LocalIdentity = {
    id: identity.id || createId('me', 10),
    name: sanitizeName(identity.name) || randomName(),
    avatar: sanitizeAvatar(identity.avatar),
  };
  writeJson(KEY, clean);
  return clean;
}

export function updateIdentity(patch: Partial<LocalIdentity>): LocalIdentity {
  return saveIdentity({ ...loadIdentity(), ...patch });
}
