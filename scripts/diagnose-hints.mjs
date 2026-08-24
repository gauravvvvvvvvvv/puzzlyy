/**
 * Throwaway diagnostic: why does a run of level-4 hints stop short of complete?
 *
 * Drives one room with nothing but hints and prints the group table each round,
 * so a plateau shows its shape (sizes, offsets, rotations, locks) instead of
 * just a progress number.
 *
 *   node scripts/diagnose-hints.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? 'http://localhost:3001';

async function call(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

const images = await call('/api/images?source=original&perPage=1');
const asset = images.body.items[0];

const created = await call('/api/rooms', {
  method: 'POST',
  body: JSON.stringify({
    image: asset,
    settings: { pieceCount: 25, rotation: false },
    gameType: 'jigsaw',
    title: 'Hint diagnosis',
  }),
});
const code = created.body.code;
const a = await call(`/api/rooms/${code}/join`, {
  method: 'POST',
  body: JSON.stringify({ name: 'Ada', avatar: '🦊' }),
});
const A = { id: a.body.playerId, token: a.body.token };

const send = (events) =>
  call(`/api/rooms/${code}/events`, {
    method: 'POST',
    body: JSON.stringify({ playerId: A.id, token: A.token, events }),
  });

await send([{ t: 'ready', ready: true }]);
await send([{ t: 'start' }]);

const state = () => call(`/api/rooms/${code}`).then((r) => r.body.session);

let live = await state();
console.log(
  `room ${code}  ${live.cols}x${live.rows} = ${live.cols * live.rows} pieces  ` +
    `cell ${live.cellW}x${live.cellH}  puzzle ${live.puzzleW}x${live.puzzleH}  board ${live.boardW}x${live.boardH}`,
);

const table = (s) =>
  s.groups
    .map((g) => `#${g.id}[${g.pieces.length}] ${Math.round(g.ox)},${Math.round(g.oy)} r${g.rot}`)
    .join('  ');

let stalledFor = 0;
for (let i = 1; i <= 60; i += 1) {
  const before = live.groups.length;
  const res = await send([{ t: 'hint', level: 4 }]);
  live = await state();
  const after = live.groups.length;
  console.log(`hint ${String(i).padStart(2)}  groups ${before} → ${after}  status=${live.status}  http=${res.status}`);
  if (after === before) {
    stalledFor += 1;
    if (stalledFor === 1) {
      console.log(`  groups: ${table(live)}`);
      console.log(`  locks:  ${JSON.stringify(live.locks)}`);
      console.log(`  pieces per group: ${live.groups.map((g) => g.pieces.join('/')).join(' | ')}`);
    }
    if (stalledFor >= 3) break;
  } else {
    stalledFor = 0;
  }
  if (live.status === 'complete') break;
}

console.log(`\nfinal: status=${live.status} groups=${live.groups.length} hintsUsed=${live.hintsUsed}`);
console.log(`  ${table(live)}`);
