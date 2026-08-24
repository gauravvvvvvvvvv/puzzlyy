/**
 * Id, room-code and token generation.
 *
 * Uses Web Crypto, which is available in the browser, in Node 20+ and on the
 * Edge runtime, so the same helpers work everywhere.
 */

/** Unambiguous alphabet: no O/0, I/1, S/5 — room codes get read aloud. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXY2346789';
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

function fromAlphabet(alphabet: string, length: number): string {
  const bytes = randomBytes(length * 2);
  let out = '';
  let i = 0;
  // Rejection sampling keeps the distribution uniform.
  const limit = 256 - (256 % alphabet.length);
  while (out.length < length) {
    if (i >= bytes.length) {
      const more = randomBytes(length * 2);
      bytes.set(more.subarray(0, Math.min(more.length, bytes.length)));
      i = 0;
    }
    const b = bytes[i++];
    if (b < limit) out += alphabet[b % alphabet.length];
  }
  return out;
}

/** Human-friendly room code, formatted `ABX-729`. */
export function generateRoomCode(): string {
  return `${fromAlphabet(CODE_ALPHABET, 3)}-${fromAlphabet(CODE_ALPHABET, 3)}`;
}

/** Accepts `abx729`, `ABX 729`, `abx-729` → `ABX-729`. */
export function normalizeRoomCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
  if (cleaned.length !== 6) return null;
  for (const ch of cleaned) if (!CODE_ALPHABET.includes(ch)) return null;
  return `${cleaned.slice(0, 3)}-${cleaned.slice(3)}`;
}

export function isRoomCode(input: string): boolean {
  return normalizeRoomCode(input) !== null;
}

export function createId(prefix: string, length = 12): string {
  return `${prefix}_${fromAlphabet(ID_ALPHABET, length)}`;
}

/** Bearer token proving a client is a specific player in a specific room. */
export function createToken(): string {
  return fromAlphabet(ID_ALPHABET + ID_ALPHABET.toUpperCase(), 32);
}

/** Constant-time-ish comparison for tokens. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
