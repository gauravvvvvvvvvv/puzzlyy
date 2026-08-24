/**
 * Puzzly Originals — the zero-API-key default image collection.
 *
 * The app has to be fully playable with no accounts and no keys, so the default
 * gallery cannot be a remote stock provider. Each entry below is a *recipe*: a
 * deterministic generative composition rendered to a self-contained SVG from a
 * seed derived from its own id. The same id therefore produces the same picture
 * on every instance, forever, without storing a single byte anywhere.
 *
 * Served from `/api/originals/[id]` — same origin, which is what keeps the
 * puzzle canvas untainted so `lib/puzzle/sprites.ts` can read pixels back.
 *
 * Compositions deliberately avoid large flat regions: a puzzle cut from an
 * even field of colour is miserable to solve, so every renderer lays down a
 * tonal gradient first and builds texture on top of it.
 */

import { createRng, hashString, type Rng } from '@/lib/puzzle/rng';
import type { ImageAsset } from '@/types/models';

/* -------------------------------------------------------------------------- */
/* Specs                                                                      */
/* -------------------------------------------------------------------------- */

export type OriginalKind =
  | 'dunes'
  | 'bloom'
  | 'skyline'
  | 'orbit'
  | 'grove'
  | 'tide'
  | 'confetti'
  | 'aurora'
  | 'quilt'
  | 'terrazzo'
  | 'ribbon'
  | 'blossom';

export interface OriginalSpec {
  id: string;
  title: string;
  kind: OriginalKind;
  /** Six stops, darkest first. Renderers rely on that ordering. */
  palette: readonly string[];
  width: number;
  height: number;
  /** Matches an id in `IMAGE_CATEGORIES` so Originals filter like stock does. */
  category: string;
}

const PALETTES = {
  dusk: ['#2a1a3c', '#4d2f63', '#8d4f8b', '#d1707f', '#f5a97a', '#ffe9c9'],
  lagoon: ['#0d2b3e', '#14495c', '#1f7a80', '#49b39c', '#8ed9c0', '#e6f7ec'],
  ember: ['#2c1116', '#5c1f22', '#9c3520', '#d76032', '#f39b4e', '#ffe3b8'],
  forest: ['#12240f', '#1f3b1c', '#365c2b', '#5d8a3f', '#96b95f', '#eaf3d4'],
  midnight: ['#080b1c', '#111634', '#22305c', '#3f5590', '#8f9fd4', '#f0f2ff'],
  peach: ['#7a3348', '#b1546a', '#e0838a', '#f5aca2', '#ffd0bc', '#fff3e6'],
  mint: ['#254b45', '#3a7a68', '#63ab8f', '#9ed3b4', '#c9ead6', '#f5fbf3'],
  sand: ['#43301f', '#6f4f31', '#a4784c', '#cfa274', '#e9cfa6', '#fdf3e0'],
  berry: ['#2a0f31', '#4f1750', '#83276f', '#b8467f', '#e2789f', '#ffd9e4'],
  slate: ['#171b21', '#262d38', '#3d4756', '#66788c', '#a2b3c2', '#eef3f7'],
} as const;

/**
 * The gallery. Ordered for browsing rather than alphabetically — the first row
 * should look inviting.
 */
export const ORIGINALS: readonly OriginalSpec[] = [
  { id: 'orig-dune-dusk', title: 'Dune Dusk', kind: 'dunes', palette: PALETTES.dusk, width: 1600, height: 1200, category: 'nature' },
  { id: 'orig-bloom-peach', title: 'Peach Bloom', kind: 'bloom', palette: PALETTES.peach, width: 1400, height: 1400, category: 'flowers' },
  { id: 'orig-orbit-midnight', title: 'Quiet Orbit', kind: 'orbit', palette: PALETTES.midnight, width: 1600, height: 1200, category: 'space' },
  { id: 'orig-grove-forest', title: 'Pine Grove', kind: 'grove', palette: PALETTES.forest, width: 1600, height: 1200, category: 'nature' },
  { id: 'orig-skyline-ember', title: 'Ember City', kind: 'skyline', palette: PALETTES.ember, width: 1600, height: 1040, category: 'cities' },
  { id: 'orig-aurora-lagoon', title: 'Aurora', kind: 'aurora', palette: PALETTES.lagoon, width: 1600, height: 1200, category: 'space' },
  { id: 'orig-quilt-sand', title: 'Patchwork', kind: 'quilt', palette: PALETTES.sand, width: 1400, height: 1400, category: 'art' },
  { id: 'orig-tide-lagoon', title: 'Lagoon Tide', kind: 'tide', palette: PALETTES.lagoon, width: 1600, height: 1200, category: 'nature' },
  { id: 'orig-confetti-peach', title: 'Confetti', kind: 'confetti', palette: PALETTES.peach, width: 1500, height: 1125, category: 'art' },
  { id: 'orig-ribbon-ember', title: 'Ribbons', kind: 'ribbon', palette: PALETTES.ember, width: 1600, height: 1200, category: 'abstract' },
  { id: 'orig-blossom-mint', title: 'Meadow', kind: 'blossom', palette: PALETTES.mint, width: 1400, height: 1400, category: 'flowers' },
  { id: 'orig-terrazzo-peach', title: 'Terrazzo', kind: 'terrazzo', palette: PALETTES.peach, width: 1500, height: 1125, category: 'architecture' },

  { id: 'orig-dune-sand', title: 'Long Sands', kind: 'dunes', palette: PALETTES.sand, width: 1600, height: 1200, category: 'travel' },
  { id: 'orig-bloom-berry', title: 'Night Bloom', kind: 'bloom', palette: PALETTES.berry, width: 1400, height: 1400, category: 'flowers' },
  { id: 'orig-orbit-slate', title: 'Cold Moons', kind: 'orbit', palette: PALETTES.slate, width: 1600, height: 1200, category: 'space' },
  { id: 'orig-grove-dusk', title: 'Hills at Dusk', kind: 'grove', palette: PALETTES.dusk, width: 1600, height: 1200, category: 'travel' },
  { id: 'orig-skyline-midnight', title: 'Midnight Blocks', kind: 'skyline', palette: PALETTES.midnight, width: 1600, height: 1040, category: 'cities' },
  { id: 'orig-aurora-berry', title: 'Violet Curtains', kind: 'aurora', palette: PALETTES.berry, width: 1600, height: 1200, category: 'fantasy' },
  { id: 'orig-quilt-mint', title: 'Cotton Quilt', kind: 'quilt', palette: PALETTES.mint, width: 1400, height: 1400, category: 'cute' },
  { id: 'orig-tide-berry', title: 'Berry Tide', kind: 'tide', palette: PALETTES.berry, width: 1500, height: 1500, category: 'abstract' },
  { id: 'orig-confetti-mint', title: 'Sprinkles', kind: 'confetti', palette: PALETTES.mint, width: 1500, height: 1125, category: 'cute' },
  { id: 'orig-ribbon-lagoon', title: 'Current', kind: 'ribbon', palette: PALETTES.lagoon, width: 1600, height: 1200, category: 'abstract' },
  { id: 'orig-blossom-peach', title: 'Blossom', kind: 'blossom', palette: PALETTES.peach, width: 1400, height: 1400, category: 'flowers' },
  { id: 'orig-terrazzo-slate', title: 'Grey Terrazzo', kind: 'terrazzo', palette: PALETTES.slate, width: 1500, height: 1125, category: 'architecture' },
];

const BY_ID = new Map(ORIGINALS.map((spec) => [spec.id, spec]));

export function originalById(id: string): OriginalSpec | null {
  return BY_ID.get(id) ?? null;
}

/** Originals are vector, so one URL serves both the board and the thumbnail. */
export function originalAsset(spec: OriginalSpec): ImageAsset {
  return {
    id: spec.id,
    source: 'original',
    url: `/api/originals/${spec.id}`,
    thumbUrl: `/api/originals/${spec.id}`,
    width: spec.width,
    height: spec.height,
    title: spec.title,
    color: spec.palette[3],
    credit: { authorName: 'Puzzly Originals', providerName: 'Puzzly' },
    createdAt: 0,
  };
}

export const ORIGINAL_ASSETS: readonly ImageAsset[] = ORIGINALS.map(originalAsset);

/* -------------------------------------------------------------------------- */
/* SVG primitives                                                             */
/* -------------------------------------------------------------------------- */

interface Sink {
  defs: string[];
  body: string[];
  nextId: () => string;
}

/** One decimal place is plenty and keeps the document small. */
function f(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function rect(x: number, y: number, w: number, h: number, fill: string, extra = ''): string {
  return `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${fill}"${extra}/>`;
}

function circle(cx: number, cy: number, r: number, fill: string, opacity = 1): string {
  const o = opacity >= 1 ? '' : ` opacity="${f(opacity)}"`;
  return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="${fill}"${o}/>`;
}

function petal(cx: number, cy: number, rx: number, ry: number, deg: number, fill: string, opacity = 1): string {
  const o = opacity >= 1 ? '' : ` opacity="${f(opacity)}"`;
  return `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" fill="${fill}"${o} transform="rotate(${f(deg)} ${f(cx)} ${f(cy)})"/>`;
}

function fill(d: string, color: string, opacity = 1): string {
  const o = opacity >= 1 ? '' : ` opacity="${f(opacity)}"`;
  return `<path d="${d}" fill="${color}"${o}/>`;
}

function linear(s: Sink, dir: 'v' | 'h' | 'd', from: string, to: string): string {
  const id = s.nextId();
  const coords =
    dir === 'v'
      ? 'x1="0" y1="0" x2="0" y2="1"'
      : dir === 'h'
        ? 'x1="0" y1="0" x2="1" y2="0"'
        : 'x1="0" y1="0" x2="1" y2="1"';
  s.defs.push(
    `<linearGradient id="${id}" ${coords}><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`,
  );
  return `url(#${id})`;
}

function radial(s: Sink, from: string, to: string): string {
  const id = s.nextId();
  s.defs.push(
    `<radialGradient id="${id}" cx="0.5" cy="0.42" r="0.8"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></radialGradient>`,
  );
  return `url(#${id})`;
}

/** A soft horizontal wave filled down past the bottom edge. */
function wave(rng: Rng, w: number, h: number, y: number, amp: number): string {
  const steps = 4;
  const dx = (w + 80) / steps;
  let cx = -40;
  let cy = y;
  let d = `M ${f(cx)} ${f(cy)}`;
  for (let i = 0; i < steps; i++) {
    const x1 = cx + dx / 3;
    const x2 = cx + (dx * 2) / 3;
    const x3 = cx + dx;
    const y3 = y + rng.range(-amp * 0.6, amp * 0.6);
    d += ` C ${f(x1)} ${f(cy + rng.range(-amp, amp))} ${f(x2)} ${f(y3 + rng.range(-amp, amp))} ${f(x3)} ${f(y3)}`;
    cx = x3;
    cy = y3;
  }
  return `${d} L ${f(w + 40)} ${f(h + 60)} L -40 ${f(h + 60)} Z`;
}

/** A handful of oversized translucent blobs, so nothing reads as flat colour. */
function wash(s: Sink, rng: Rng, w: number, h: number, p: readonly string[], count = 5): void {
  for (let i = 0; i < count; i++) {
    s.body.push(
      circle(
        rng.range(-0.1, 1.1) * w,
        rng.range(-0.1, 1.1) * h,
        Math.min(w, h) * rng.range(0.28, 0.62),
        p[rng.int(2, 5)],
        rng.range(0.1, 0.24),
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Renderers                                                                  */
/* -------------------------------------------------------------------------- */

type Renderer = (s: Sink, rng: Rng, w: number, h: number, p: readonly string[]) => void;

const dunes: Renderer = (s, rng, w, h, p) => {
  s.body.push(rect(0, 0, w, h, linear(s, 'v', p[1], p[4])));
  s.body.push(
    circle(w * rng.range(0.56, 0.8), h * rng.range(0.17, 0.3), Math.min(w, h) * rng.range(0.09, 0.15), p[5], 0.92),
  );
  const bands = 6;
  for (let i = 0; i < bands; i++) {
    const y = h * (0.3 + (i / (bands - 1)) * 0.66);
    const idx = Math.max(0, 4 - Math.round((i / (bands - 1)) * 4));
    s.body.push(fill(wave(rng, w, h, y, h * 0.05), p[idx]));
  }
};

const tide: Renderer = (s, rng, w, h, p) => {
  s.body.push(rect(0, 0, w, h, linear(s, 'd', p[0], p[2])));
  for (let i = 0; i < rng.int(8, 11); i++) {
    s.body.push(
      circle(
        rng.range(-0.1, 1.1) * w,
        rng.range(-0.1, 1.1) * h,
        Math.min(w, h) * rng.range(0.24, 0.66),
        p[rng.int(2, 5)],
        rng.range(0.18, 0.4),
      ),
    );
  }
  for (let i = 0; i < 4; i++) {
    const r = Math.min(w, h) * rng.range(0.3, 0.55);
    const cx = rng.range(0.1, 0.9) * w;
    const cy = rng.range(0.1, 0.9) * h;
    s.body.push(
      `<path d="M ${f(cx - r)} ${f(cy)} A ${f(r)} ${f(r)} 0 0 1 ${f(cx + r)} ${f(cy)}" fill="none" stroke="${p[5]}" stroke-width="${f(Math.min(w, h) * rng.range(0.006, 0.018))}" opacity="${f(rng.range(0.3, 0.6))}" transform="rotate(${f(rng.range(0, 360))} ${f(cx)} ${f(cy)})"/>`,
    );
  }
};

const bloom: Renderer = (s, rng, w, h, p) => {
  s.body.push(rect(0, 0, w, h, radial(s, p[5], p[3])));
  wash(s, rng, w, h, p, 4);
  const cx = w / 2;
  const cy = h / 2;
  const rings = rng.int(3, 4);
  for (let ring = rings; ring >= 1; ring--) {
    const count = 6 + ring * 3;
    const reach = Math.min(w, h) * 0.46 * (ring / rings);
    const color = p[Math.max(0, 4 - ring)];
    const phase = rng.range(0, Math.PI * 2);
    for (let i = 0; i < count; i++) {
      const a = phase + (i / count) * Math.PI * 2;
      const px = cx + Math.cos(a) * reach * 0.56;
      const py = cy + Math.sin(a) * reach * 0.56;
      s.body.push(petal(px, py, reach * 0.56, reach * 0.2, (a * 180) / Math.PI, color, 0.88));
    }
  }
  s.body.push(circle(cx, cy, Math.min(w, h) * 0.1, p[5]));
  s.body.push(circle(cx, cy, Math.min(w, h) * 0.06, p[1], 0.9));
};

const skyline: Renderer = (s, rng, w, h, p) => {
  s.body.push(rect(0, 0, w, h, linear(s, 'v', p[1], p[4])));
  s.body.push(
    circle(w * rng.range(0.6, 0.82), h * rng.range(0.2, 0.34), Math.min(w, h) * 0.12, p[5], 0.95),
  );
  const layers = 3;
  for (let layer = 0; layer < layers; layer++) {
    const baseY = h * (0.58 + layer * 0.13);
    const color = p[Math.max(0, 3 - layer)];
    let x = -20;
    while (x < w + 20) {
      const bw = rng.range(w * 0.04, w * 0.12);
      const bh = rng.range(h * 0.14, h * 0.46) * (1 - layer * 0.16);
      const y = baseY - bh;
      s.body.push(rect(x, y, bw, h - y + 20, color));
      if (layer === layers - 1 && bw > w * 0.05) {
        const cols = Math.max(1, Math.floor(bw / (w * 0.022)));
        const rows = Math.max(1, Math.floor(bh / (h * 0.055)));
        for (let c = 0; c < cols; c++) {
          for (let r = 0; r < rows; r++) {
            if (!rng.chance(0.5)) continue;
            s.body.push(
              rect(
                x + (c + 0.28) * (bw / cols),
                y + (r + 0.3) * (bh / rows),
                (bw / cols) * 0.44,
                (bh / rows) * 0.34,
                p[5],
                ` opacity="${f(rng.range(0.4, 0.85))}"`,
              ),
            );
          }
        }
      }
      x += bw + rng.range(w * 0.004, w * 0.022);
    }
  }
};

const orbit: Renderer = (s, rng, w, h, p) => {
  s.body.push(rect(0, 0, w, h, radial(s, p[2], p[0])));
  for (let i = 0; i < 170; i++) {
    s.body.push(circle(rng.next() * w, rng.next() * h, rng.range(0.6, 2.6), p[5], rng.range(0.25, 0.95)));
  }
  const cx = w * rng.range(0.34, 0.62);
  const cy = h * rng.range(0.42, 0.6);
  const r = Math.min(w, h) * rng.range(0.2, 0.28);
  s.body.push(
    `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(r * 1.95)}" ry="${f(r * 0.4)}" fill="none" stroke="${p[3]}" stroke-width="${f(r * 0.15)}" opacity="0.55" transform="rotate(-18 ${f(cx)} ${f(cy)})"/>`,
  );
  s.body.push(circle(cx, cy, r, linear(s, 'd', p[4], p[2])));
  s.body.push(circle(cx + r * 0.44, cy - r * 0.22, r * 0.94, p[0], 0.3));
  for (let i = 0; i < 3; i++) {
    s.body.push(
      circle(
        rng.range(0.08, 0.92) * w,
        rng.range(0.08, 0.9) * h,
        Math.min(w, h) * rng.range(0.018, 0.046),
        p[rng.int(3, 5)],
        0.92,
      ),
    );
  }
};

const grove: Renderer = (s, rng, w, h, p) => {
  s.body.push(rect(0, 0, w, h, linear(s, 'v', p[5], p[4])));
  s.body.push(circle(w * 0.74, h * 0.22, Math.min(w, h) * 0.08, p[5], 0.95));
  for (let layer = 0; layer < 3; layer++) {
    const baseY = h * (0.56 + layer * 0.1);
    const color = p[Math.max(0, 3 - layer)];
    const points: string[] = [`-40,${f(h + 40)}`, `-40,${f(baseY)}`];
    let x = -40;
    while (x < w + 40) {
      const step = rng.range(w * 0.1, w * 0.22);
      const peak = baseY - rng.range(h * 0.08, h * 0.26) * (1 - layer * 0.2);
      points.push(`${f(x + step / 2)},${f(peak)}`);
      points.push(`${f(x + step)},${f(baseY - rng.range(0, h * 0.03))}`);
      x += step;
    }
    points.push(`${f(w + 40)},${f(h + 40)}`);
    s.body.push(`<polygon points="${points.join(' ')}" fill="${color}"/>`);
  }
  for (let i = 0; i < rng.int(10, 15); i++) {
    const tx = rng.range(0.02, 0.98) * w;
    const th = rng.range(h * 0.1, h * 0.24);
    const ty = h * rng.range(0.74, 0.96);
    const tw = th * 0.46;
    s.body.push(rect(tx - tw * 0.06, ty - th * 0.14, tw * 0.12, th * 0.2, p[0]));
    for (let t = 0; t < 3; t++) {
      const ly = ty - th * (0.1 + t * 0.27);
      const lw = tw * (1 - t * 0.24);
      s.body.push(
        `<polygon points="${f(tx)},${f(ly - th * 0.36)} ${f(tx - lw / 2)},${f(ly)} ${f(tx + lw / 2)},${f(ly)}" fill="${p[0]}"/>`,
      );
    }
  }
};

const confetti: Renderer = (s, rng, w, h, p) => {
  s.body.push(rect(0, 0, w, h, linear(s, 'd', p[5], p[4])));
  wash(s, rng, w, h, p, 6);
  for (let i = 0; i < rng.int(100, 140); i++) {
    const x = rng.next() * w;
    const y = rng.next() * h;
    const size = Math.min(w, h) * rng.range(0.014, 0.052);
    const color = p[rng.int(0, 4)];
    const rot = rng.range(0, 360);
    const kind = rng.int(0, 3);
    if (kind === 0) {
      s.body.push(circle(x, y, size / 2, color, rng.range(0.7, 1)));
    } else if (kind === 1) {
      s.body.push(
        `<rect x="${f(x - size / 2)}" y="${f(y - size / 6)}" width="${f(size)}" height="${f(size / 3)}" rx="${f(size / 6)}" fill="${color}" transform="rotate(${f(rot)} ${f(x)} ${f(y)})"/>`,
      );
    } else if (kind === 2) {
      s.body.push(
        `<polygon points="${f(x)},${f(y - size / 2)} ${f(x + size / 2)},${f(y + size / 2)} ${f(x - size / 2)},${f(y + size / 2)}" fill="${color}" transform="rotate(${f(rot)} ${f(x)} ${f(y)})"/>`,
      );
    } else {
      s.body.push(
        `<path d="M ${f(x - size / 2)} ${f(y)} A ${f(size / 2)} ${f(size / 2)} 0 0 1 ${f(x + size / 2)} ${f(y)}" fill="none" stroke="${color}" stroke-width="${f(size * 0.22)}" stroke-linecap="round" transform="rotate(${f(rot)} ${f(x)} ${f(y)})"/>`,
      );
    }
  }
};

const aurora: Renderer = (s, rng, w, h, p) => {
  s.body.push(rect(0, 0, w, h, linear(s, 'v', p[0], p[2])));
  for (let i = 0; i < 220; i++) {
    s.body.push(circle(rng.next() * w, rng.next() * h * 0.75, rng.range(0.5, 2.1), p[5], rng.range(0.2, 0.85)));
  }
  const blur = s.nextId();
  s.defs.push(
    `<filter id="${blur}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${f(Math.min(w, h) * 0.018)}"/></filter>`,
  );
  for (let i = 0; i < rng.int(5, 8); i++) {
    const x = w * rng.range(-0.05, 1.05);
    const cw = w * rng.range(0.07, 0.2);
    const top = h * rng.range(-0.05, 0.14);
    const bot = h * rng.range(0.55, 0.88);
    const bend = w * rng.range(-0.13, 0.13);
    const mid = (top + bot) / 2;
    const d =
      `M ${f(x)} ${f(top)} C ${f(x + bend)} ${f(mid)} ${f(x - bend)} ${f(bot * 0.82)} ${f(x + bend * 0.5)} ${f(bot)}` +
      ` L ${f(x + bend * 0.5 + cw)} ${f(bot)} C ${f(x - bend + cw)} ${f(bot * 0.82)} ${f(x + bend + cw)} ${f(mid)} ${f(x + cw)} ${f(top)} Z`;
    s.body.push(
      `<path d="${d}" fill="${p[rng.int(2, 5)]}" opacity="${f(rng.range(0.35, 0.7))}" filter="url(#${blur})"/>`,
    );
  }
  s.body.push(fill(wave(rng, w, h, h * 0.87, h * 0.03), p[0]));
};

const quilt: Renderer = (s, rng, w, h, p) => {
  const cols = rng.int(5, 7);
  const rows = Math.max(4, Math.round((cols * h) / w));
  const cw = w / cols;
  const ch = h / rows;
  s.body.push(rect(0, 0, w, h, p[4]));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cw;
      const y = r * ch;
      const bg = p[rng.int(2, 5)];
      const fg = p[rng.int(0, 3)];
      const unit = Math.min(cw, ch);
      s.body.push(rect(x, y, cw + 0.6, ch + 0.6, bg));
      switch (rng.int(0, 4)) {
        case 0:
          s.body.push(circle(x + cw / 2, y + ch / 2, unit * 0.33, fg));
          break;
        case 1:
          s.body.push(
            fill(`M ${f(x)} ${f(y + ch)} A ${f(cw)} ${f(ch)} 0 0 1 ${f(x + cw)} ${f(y)} L ${f(x)} ${f(y)} Z`, fg),
          );
          break;
        case 2:
          s.body.push(
            `<polygon points="${f(x)},${f(y)} ${f(x + cw)},${f(y)} ${f(x + cw / 2)},${f(y + ch)}" fill="${fg}"/>`,
          );
          break;
        case 3:
          for (let i = 0; i < 3; i++) {
            s.body.push(rect(x, y + (ch * (i * 2 + 0.5)) / 6, cw, ch * 0.15, fg));
          }
          break;
        default:
          s.body.push(circle(x + cw * 0.31, y + ch * 0.31, unit * 0.15, fg));
          s.body.push(circle(x + cw * 0.69, y + ch * 0.69, unit * 0.15, fg));
      }
    }
  }
  const stitch: string[] = [];
  for (let c = 1; c < cols; c++) stitch.push(`<line x1="${f(c * cw)}" y1="0" x2="${f(c * cw)}" y2="${f(h)}"/>`);
  for (let r = 1; r < rows; r++) stitch.push(`<line x1="0" y1="${f(r * ch)}" x2="${f(w)}" y2="${f(r * ch)}"/>`);
  s.body.push(
    `<g stroke="${p[5]}" stroke-width="${f(Math.min(cw, ch) * 0.035)}" stroke-dasharray="${f(cw * 0.06)} ${f(cw * 0.05)}" opacity="0.65">${stitch.join('')}</g>`,
  );
};

const terrazzo: Renderer = (s, rng, w, h, p) => {
  s.body.push(rect(0, 0, w, h, linear(s, 'd', p[5], p[4])));
  wash(s, rng, w, h, p, 5);
  for (let i = 0; i < rng.int(240, 320); i++) {
    const cx = rng.next() * w;
    const cy = rng.next() * h;
    const r = Math.min(w, h) * rng.range(0.008, 0.03);
    const sides = rng.int(4, 7);
    const phase = rng.range(0, Math.PI * 2);
    const points: string[] = [];
    for (let k = 0; k < sides; k++) {
      const a = phase + (k / sides) * Math.PI * 2;
      const rr = r * rng.range(0.6, 1.35);
      points.push(`${f(cx + Math.cos(a) * rr)},${f(cy + Math.sin(a) * rr)}`);
    }
    s.body.push(
      `<polygon points="${points.join(' ')}" fill="${p[rng.int(0, 4)]}" opacity="${f(rng.range(0.7, 1))}"/>`,
    );
  }
};

const ribbon: Renderer = (s, rng, w, h, p) => {
  s.body.push(rect(0, 0, w, h, linear(s, 'd', p[5], p[3])));
  wash(s, rng, w, h, p, 4);
  for (let i = 0; i < rng.int(6, 9); i++) {
    const y0 = h * rng.range(-0.1, 1.1);
    const y1 = h * rng.range(-0.1, 1.1);
    const c1x = w * rng.range(0.1, 0.5);
    const c1y = h * rng.range(-0.2, 1.2);
    const c2x = w * rng.range(0.5, 0.9);
    const c2y = h * rng.range(-0.2, 1.2);
    s.body.push(
      `<path d="M ${f(-w * 0.05)} ${f(y0)} C ${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(w * 1.05)} ${f(y1)}" fill="none" stroke="${p[rng.int(0, 4)]}" stroke-width="${f(Math.min(w, h) * rng.range(0.05, 0.16))}" stroke-linecap="round" opacity="${f(rng.range(0.55, 0.95))}"/>`,
    );
  }
};

const blossom: Renderer = (s, rng, w, h, p) => {
  s.body.push(rect(0, 0, w, h, linear(s, 'v', p[5], p[4])));
  wash(s, rng, w, h, p, 4);
  for (let i = 0; i < rng.int(7, 11); i++) {
    const x = rng.next() * w;
    s.body.push(
      `<path d="M ${f(x)} ${f(h + 10)} C ${f(x + w * 0.05)} ${f(h * 0.72)} ${f(x - w * 0.05)} ${f(h * 0.5)} ${f(x + w * 0.02)} ${f(h * rng.range(0.18, 0.46))}" fill="none" stroke="${p[1]}" stroke-width="${f(Math.min(w, h) * 0.009)}" opacity="0.7"/>`,
    );
  }
  for (let i = 0; i < rng.int(11, 17); i++) {
    const cx = rng.range(0.05, 0.95) * w;
    const cy = rng.range(0.08, 0.92) * h;
    const r = Math.min(w, h) * rng.range(0.035, 0.085);
    const petals = rng.int(5, 8);
    const color = p[rng.int(0, 3)];
    const phase = rng.range(0, Math.PI * 2);
    for (let k = 0; k < petals; k++) {
      const a = phase + (k / petals) * Math.PI * 2;
      const px = cx + Math.cos(a) * r * 0.62;
      const py = cy + Math.sin(a) * r * 0.62;
      s.body.push(petal(px, py, r * 0.6, r * 0.34, (a * 180) / Math.PI, color, 0.9));
    }
    s.body.push(circle(cx, cy, r * 0.3, p[4]));
  }
};

const RENDERERS: Record<OriginalKind, Renderer> = {
  dunes,
  bloom,
  skyline,
  orbit,
  grove,
  tide,
  confetti,
  aurora,
  quilt,
  terrazzo,
  ribbon,
  blossom,
};

/* -------------------------------------------------------------------------- */

/**
 * Render a spec to a standalone SVG document.
 *
 * Nothing external is referenced, so the result is safe to load in an `<img>`
 * and draw into a canvas.
 */
export function renderOriginalSvg(spec: OriginalSpec): string {
  const rng = createRng(hashString(spec.id));
  let counter = 0;
  const sink: Sink = { defs: [], body: [], nextId: () => `d${(counter++).toString(36)}` };
  RENDERERS[spec.kind](sink, rng, spec.width, spec.height, spec.palette);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.width}" height="${spec.height}" ` +
    `viewBox="0 0 ${spec.width} ${spec.height}" role="img" aria-label="${spec.title}">` +
    `<defs>${sink.defs.join('')}</defs>${sink.body.join('')}</svg>`
  );
}
