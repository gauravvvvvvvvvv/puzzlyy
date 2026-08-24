/**
 * The sound two pieces make when they join.
 *
 * Synthesised with WebAudio rather than shipped as an audio file. Three reasons,
 * in order of how much they matter:
 *
 *  1. A snap has to be *instant*. A decoded oscillator starts on the same frame
 *     as the merge; an `<audio>` element does not, and a 60 ms delay reads as a
 *     different, worse interaction.
 *  2. It can respond to what happened. Joining two single pieces is a small
 *     click; closing a six-piece seam is a lower, fuller one — same recipe,
 *     different numbers. A sample can only be played louder.
 *  3. No binary asset, no extra request, nothing to host. (Directive §2: the
 *     whole thing has to stay free.)
 *
 * The recipe is two layers, which is what makes it read as *wood* rather than as
 * a beep: a short triangle tone that drops in pitch (the body of the piece) plus
 * a filtered noise burst an octave and a half up (the edge catching). Both decay
 * inside 100 ms, because a puzzle can produce a dozen of these in a few seconds
 * and anything with a tail turns into mud.
 */

import { readJson, writeJson } from '@/lib/storage/local';

const KEY = 'sound';

/** How long a merge stays "already heard". See `snap`. */
const DEDUPE_MS = 900;

/** A puzzle can only be finished once. See `chime`. */
const CHIME_COOLDOWN_MS = 4000;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let enabled: boolean | null = null;
let broken = false;
let lastChime = 0;

const recent = new Map<string, number>();

/* -------------------------------------------------------------------------- */
/* Preference                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * On unless the player has said otherwise — or unless they have asked the
 * operating system for reduced motion.
 *
 * Reduced motion is not literally about sound, but it is the only signal a
 * browser gives us about sensory sensitivity, and someone who turns off
 * animation is very unlikely to want unsolicited noise. Treating it as "quiet
 * by default" is a deliberate reading, and the toggle in settings overrides it
 * either way.
 */
export function soundEnabled(): boolean {
  if (enabled !== null) return enabled;
  const stored = readJson<unknown>(KEY, null);
  if (stored === true || stored === false) {
    enabled = stored;
    return enabled;
  }
  const quiet =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  enabled = !quiet;
  return enabled;
}

export function setSoundEnabled(value: boolean): void {
  enabled = value;
  writeJson(KEY, value);
  if (!value) recent.clear();
}

/* -------------------------------------------------------------------------- */
/* Audio graph                                                                */
/* -------------------------------------------------------------------------- */

interface AudioWindow {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

/**
 * Built on first use, not on import.
 *
 * Browsers refuse to start an audio context until the page has been interacted
 * with, and a refused context stays refused — so creating one at module load
 * would permanently poison it. The first snap always follows a pointer gesture
 * (a drag) or a remote event on a page that has already been dragged, which is
 * exactly when a context is allowed to start.
 */
function audio(): { ctx: AudioContext; master: GainNode } | null {
  if (broken) return null;
  if (ctx && master) {
    // Tabbing away can suspend it; nothing tells us when it comes back.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    return { ctx, master };
  }
  try {
    const w = window as unknown as AudioWindow;
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) {
      broken = true;
      return null;
    }
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    return { ctx, master };
  } catch {
    // No audio hardware, a locked-down browser, too many live contexts. None of
    // it is worth telling the player about.
    broken = true;
    return null;
  }
}

/** One short buffer of white noise, reused by every snap. */
function noiseBuffer(context: AudioContext): AudioBuffer {
  if (noise) return noise;
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * 0.2), context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  noise = buffer;
  return buffer;
}

/* -------------------------------------------------------------------------- */
/* The snap                                                                   */
/* -------------------------------------------------------------------------- */

export interface SnapOptions {
  /** Pieces newly joined. More pieces read lower and fuller. */
  connections?: number;
  /** Somebody else's merge. Audible, but it should not compete with your own. */
  mine?: boolean;
}

/**
 * Play the snap for one merge, at most once.
 *
 * The deduplication is the point of the `key` argument. A merge you make arrives
 * twice — once optimistically, the moment you let go, and again when the server
 * broadcasts its authoritative version — and a level-4 hint arrives *only* from
 * the server, with no local path at all. So neither call site can decide on its
 * own whether to make a sound: filtering on "was this mine?" would double up on
 * drags or go silent on hints. Instead both call sites ask for the same key and
 * the first one through wins.
 *
 * `${into}:${from}` identifies a merge on either side of the wire, because the
 * engine's own `MergeResult` and the broadcast `merge` event carry the same two
 * fields.
 */
export function snap(key: string, options: SnapOptions = {}): void {
  if (!soundEnabled()) return;

  const now = Date.now();
  const last = recent.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return;
  recent.set(key, now);
  if (recent.size > 64) {
    for (const [k, at] of recent) if (now - at > DEDUPE_MS) recent.delete(k);
  }

  const graph = audio();
  if (!graph) return;

  const { ctx: context, master: out } = graph;
  const at = context.currentTime;
  const connections = Math.max(1, options.connections ?? 1);
  const mine = options.mine !== false;

  // A bigger join is a bigger object: lower, louder, slightly longer.
  const size = Math.min(connections, 6);
  const pitch = 560 - size * 42;
  const gain = (mine ? 0.32 : 0.15) * (1 + size * 0.05);

  try {
    // Body — a triangle wave sliding down a fifth. The slide is what makes it a
    // "tuk" instead of a "beep".
    const tone = context.createOscillator();
    tone.type = 'triangle';
    tone.frequency.setValueAtTime(pitch, at);
    tone.frequency.exponentialRampToValueAtTime(pitch * 0.55, at + 0.07);

    const toneGain = context.createGain();
    toneGain.gain.setValueAtTime(0.0001, at);
    toneGain.gain.exponentialRampToValueAtTime(gain, at + 0.004);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.1);

    tone.connect(toneGain).connect(out);
    tone.start(at);
    tone.stop(at + 0.12);

    // Edge — a very short filtered noise burst, which is the click of two
    // cardboard tabs meeting.
    const grain = context.createBufferSource();
    grain.buffer = noiseBuffer(context);
    grain.playbackRate.value = 1;

    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = pitch * 3.2;
    band.Q.value = 1.4;

    const grainGain = context.createGain();
    grainGain.gain.setValueAtTime(gain * 0.7, at);
    grainGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.045);

    grain.connect(band).connect(grainGain).connect(out);
    grain.start(at);
    grain.stop(at + 0.06);
  } catch {
    /* A dropped sound is never worth interrupting a drag for. */
  }
}

/**
 * The last piece going in.
 *
 * Two rising notes rather than a fanfare — the completion screen does the
 * celebrating, and spec §22 is explicit that this moment should not be
 * excessive.
 *
 * Guarded by a cooldown for the same reason `snap` takes a key: the local drop
 * and the server's broadcast both notice the puzzle is finished, and the last
 * piece should not land twice.
 */
export function chime(): void {
  if (!soundEnabled()) return;
  const now = Date.now();
  if (now - lastChime < CHIME_COOLDOWN_MS) return;
  lastChime = now;

  const graph = audio();
  if (!graph) return;

  const { ctx: context, master: out } = graph;
  const at = context.currentTime;
  try {
    [0, 0.11].forEach((offset, index) => {
      const tone = context.createOscillator();
      tone.type = 'triangle';
      tone.frequency.value = index === 0 ? 587.33 : 880; // D5 → A5
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, at + offset);
      gain.gain.exponentialRampToValueAtTime(0.22, at + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + offset + 0.3);
      tone.connect(gain).connect(out);
      tone.start(at + offset);
      tone.stop(at + offset + 0.34);
    });
  } catch {
    /* see `snap` */
  }
}

/** Stable across both sides of the wire — see `snap`. */
export function mergeKey(into: number, from: readonly number[]): string {
  return `${into}:${[...from].sort((a, b) => a - b).join(',')}`;
}
