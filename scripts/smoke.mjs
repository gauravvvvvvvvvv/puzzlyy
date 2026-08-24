/**
 * End-to-end protocol smoke test against a running dev server.
 *
 * Two independent HTTP "clients" — no browser, no shared memory — drive a real
 * room through the exact API a browser uses, then assert the server converged.
 * This is what acceptance criteria 5-10 actually mean at the wire level.
 *
 *   node scripts/smoke.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? 'http://localhost:3001';

let failures = 0;
let checks = 0;

function ok(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(path, init) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body };
}

/* -------------------------------------------------------------------------- */

console.log(`\nPuzzly protocol smoke test → ${BASE}\n`);

/* --- 0. capabilities ------------------------------------------------------ */

const health = await call('/api/health');
ok('health responds', health.status === 200 && health.body?.ok === true, JSON.stringify(health.body));
console.log(`        store=${health.body?.storage?.rooms} realtime=${health.body?.realtime}`);

const images = await call('/api/images?source=original&perPage=3');
const asset = images.body?.items?.[0] ?? null;
ok('originals available with no API keys', asset !== null, JSON.stringify(images.body).slice(0, 200));
if (!asset) {
  process.exitCode = 1;
  throw new Error('no originals returned — cannot continue');
}

/* --- 1. create ------------------------------------------------------------ */

const created = await call('/api/rooms', {
  method: 'POST',
  body: JSON.stringify({
    image: asset,
    settings: { pieceCount: 25, rotation: false },
    gameType: 'jigsaw',
    title: 'Smoke test',
  }),
});
ok('room created', created.status === 201 && typeof created.body?.code === 'string', JSON.stringify(created.body).slice(0, 200));
const code = created.body.code;
// Six characters from an unambiguous alphabet, split by a hyphen — `ABX-729`
// is one possible output, not the only shape.
ok('room code is readable aloud', /^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(code) && !/[OIS015]/.test(code), code);

/* --- 2. two independent clients join ------------------------------------- */

const a = await call(`/api/rooms/${code}/join`, {
  method: 'POST',
  body: JSON.stringify({ name: 'Ada', avatar: '🦊' }),
});
const b = await call(`/api/rooms/${code}/join`, {
  method: 'POST',
  body: JSON.stringify({ name: 'Bo', avatar: '🐢' }),
});
ok('client A joined', a.status === 200 && !!a.body?.playerId, JSON.stringify(a.body).slice(0, 160));
ok('client B joined', b.status === 200 && !!b.body?.playerId, JSON.stringify(b.body).slice(0, 160));
ok('distinct seats', a.body?.playerId !== b.body?.playerId);
ok('A is host, B is not', a.body?.player?.isHost === true && b.body?.player?.isHost === false);

// Criterion 6: both clients see the same puzzle.
ok(
  'both see the same puzzle',
  a.body?.view?.puzzle?.id === b.body?.view?.puzzle?.id &&
    a.body?.view?.puzzle?.seed === b.body?.view?.puzzle?.seed,
);
ok('both see two players', b.body?.view?.players?.length === 2);

const A = { id: a.body.playerId, token: a.body.token };
const B = { id: b.body.playerId, token: b.body.token };

const send = (who, events) =>
  call(`/api/rooms/${code}/events`, {
    method: 'POST',
    body: JSON.stringify({ playerId: who.id, token: who.token, events }),
  });

/* --- 3. authorization ---------------------------------------------------- */

const forged = await send({ id: A.id, token: 'not-the-real-token' }, [{ t: 'ready', ready: true }]);
ok('forged token rejected', forged.status === 401 || forged.status === 403, `status=${forged.status}`);

const impersonation = await send({ id: B.id, token: A.token }, [{ t: 'ready', ready: true }]);
ok('token from another seat rejected', impersonation.status === 401 || impersonation.status === 403, `status=${impersonation.status}`);

/* --- 4. start the game --------------------------------------------------- */

await send(A, [{ t: 'ready', ready: true }]);
await send(B, [{ t: 'ready', ready: true }]);
const started = await send(A, [{ t: 'start' }]);
ok('host started the game', started.status === 200, JSON.stringify(started.body));

const afterStart = await call(`/api/rooms/${code}`);
ok('room is playing', afterStart.body?.view?.room?.status === 'playing', JSON.stringify(afterStart.body?.view?.room?.status));

// An invalid event is a deliberate no-op rather than an error — a stale client
// should not be punished with a failure it cannot act on. So the assertion is
// about state, not status.
await send(B, [{ t: 'restart' }]);
const afterFakeRestart = await call(`/api/rooms/${code}`);
ok(
  'a non-host restart changes nothing',
  afterFakeRestart.body?.view?.room?.status === 'playing' &&
    afterFakeRestart.body?.session?.seed === afterStart.body?.session?.seed,
  `status=${afterFakeRestart.body?.view?.room?.status}`,
);

/* --- 5. movement, locking, merging --------------------------------------- */

// The full authoritative state is served alongside the view, not inside it.
const state = () => call(`/api/rooms/${code}`).then((r) => r.body.session);

const session0 = afterStart.body?.session;
ok('authoritative state served', Array.isArray(session0?.groups), Object.keys(session0 ?? {}).join(','));

const firstGroup = session0.groups[0];
const gid = firstGroup.id;

// A grabs a group; B must not be able to move it.
const grab = await send(A, [{ t: 'grab', g: gid }]);
ok('A grabbed a group', grab.status === 200);

const locked = await state();
ok('the lock is recorded against A', locked.locks?.[gid] === A.id, JSON.stringify(locked.locks));

await send(B, [{ t: 'move', g: gid, ox: 9999, oy: 9999 }]);
const contested = await state();
const contestedGroup = contested.groups.find((g) => g.id === gid);
ok(
  'a locked group ignores the other player',
  contestedGroup.ox !== 9999 && contestedGroup.oy !== 9999,
  `ox=${contestedGroup.ox} oy=${contestedGroup.oy}`,
);

// A moves it somewhere legal, then drops it there.
const targetX = Math.round(firstGroup.ox + 40);
const targetY = Math.round(firstGroup.oy + 25);
await send(A, [{ t: 'move', g: gid, ox: targetX, oy: targetY }]);
await send(A, [{ t: 'drop', g: gid, ox: targetX, oy: targetY }]);

const moved = await state();
const movedGroup = moved.groups.find((g) => g.id === gid);
ok(
  'the move survived on the server',
  Math.abs(movedGroup.ox - targetX) < 60 && Math.abs(movedGroup.oy - targetY) < 60,
  `got ${movedGroup.ox},${movedGroup.oy} wanted ${targetX},${targetY}`,
);
ok('the group is no longer locked', moved.locks?.[gid] === undefined, JSON.stringify(moved.locks));

/* --- 6. hint places a piece (server-authoritative merging) --------------- */

const before = moved.groups.length;
await send(B, [{ t: 'hint', level: 4 }]);
const hinted = await state();
const after = hinted.groups.length;
ok('a level-4 hint placed a piece and merged groups', after < before, `${before} → ${after}`);
ok('hint counted', (hinted.hintsUsed ?? 0) >= 1, String(hinted.hintsUsed));
ok('credit was assigned to the player who acted', Object.keys(hinted.credit ?? {}).length >= 1, JSON.stringify(hinted.credit));

/* --- 7. undo/redo -------------------------------------------------------- */

// Asserting on status here would prove nothing: an event the server cannot act
// on is a deliberate 200 no-op, so `undo accepted` passed for months while undo
// did nothing at all. The engine is rehydrated from `record.session` on every
// request, so a journal that is not persisted is a journal that is always empty.
// Hence: move a group, then assert the pieces actually go back.

const preUndo = await state();
const lone = preUndo.groups.find((g) => g.pieces.length === 1) ?? preUndo.groups[0];
const uid = lone.id;
const home = { ox: lone.ox, oy: lone.oy };

// A deliberately odd offset — a round number risks landing inside snapping
// distance of a neighbour, which would merge the group and change the question.
await send(A, [{ t: 'grab', g: uid }]);
await send(A, [{ t: 'move', g: uid, ox: home.ox + 137, oy: home.oy + 101 }]);
await send(A, [{ t: 'drop', g: uid, ox: home.ox + 137, oy: home.oy + 101 }]);

const afterMove = await state();
const movedU = afterMove.groups.find((g) => g.id === uid);
ok(
  'a fresh move landed on the server',
  movedU !== undefined && (movedU.ox !== home.ox || movedU.oy !== home.oy),
  movedU ? `${home.ox},${home.oy} → ${movedU.ox},${movedU.oy}` : 'the group merged away',
);

await send(A, [{ t: 'undo' }]);
const afterUndo = await state();
const undoneU = afterUndo.groups.find((g) => g.id === uid);
ok(
  'undo put the group back where it started',
  undoneU !== undefined &&
    Math.round(undoneU.ox) === Math.round(home.ox) &&
    Math.round(undoneU.oy) === Math.round(home.oy),
  `wanted ${home.ox},${home.oy} got ${undoneU?.ox},${undoneU?.oy}`,
);

await send(A, [{ t: 'redo' }]);
const afterRedo = await state();
const redoneU = afterRedo.groups.find((g) => g.id === uid);
ok(
  'redo put it back where undo took it from',
  redoneU !== undefined &&
    movedU !== undefined &&
    Math.round(redoneU.ox) === Math.round(movedU.ox) &&
    Math.round(redoneU.oy) === Math.round(movedU.oy),
  `wanted ${movedU?.ox},${movedU?.oy} got ${redoneU?.ox},${redoneU?.oy}`,
);

// The journal is per-player, so B pressing undo takes back B's own last move —
// never A's. Without that, either player could quietly rearrange the other's work.
await send(B, [{ t: 'undo' }]);
const afterOther = await state();
const stillU = afterOther.groups.find((g) => g.id === uid);
ok(
  "one player's undo cannot move another player's group",
  stillU !== undefined &&
    Math.round(stillU.ox) === Math.round(redoneU?.ox ?? NaN) &&
    Math.round(stillU.oy) === Math.round(redoneU?.oy ?? NaN),
  `${redoneU?.ox},${redoneU?.oy} → ${stillU?.ox},${stillU?.oy}`,
);

// Undo survives the journal being rebuilt from the stored session on every
// request — which is the whole reason it was broken. Depth is capped, so asking
// for more than there is must be inert rather than corrupting.
await send(A, [{ t: 'undo' }, { t: 'undo' }, { t: 'undo' }, { t: 'undo' }, { t: 'undo' }]);
const drained = await state();
ok(
  'undoing past the start of the journal is harmless',
  Array.isArray(drained.groups) && drained.groups.length >= 1 && drained.status === 'playing',
  `groups=${drained.groups?.length} status=${drained.status}`,
);

/* --- 8. reconnect restores the same seat --------------------------------- */

const resumed = await call(`/api/rooms/${code}/join`, {
  method: 'POST',
  body: JSON.stringify({ name: 'Ada', avatar: '🦊', playerId: A.id, token: A.token }),
});
ok('same seat resumed after a refresh', resumed.body?.playerId === A.id && resumed.body?.resumed === true, JSON.stringify(resumed.body?.resumed));
ok('resume carries the full state back', (resumed.body?.session?.groups?.length ?? 0) > 0);
// Against a fresh read rather than a count captured earlier: the point is that a
// refreshed client sees exactly what the room currently says, not what it said
// before the last few moves.
const roomNow = await state();
ok(
  'resumed state matches what the other client sees',
  resumed.body?.session?.groups?.length === roomNow.groups.length &&
    resumed.body?.session?.seed === roomNow.seed,
  `${resumed.body?.session?.groups?.length} vs ${roomNow.groups.length}`,
);

const staleSeat = await call(`/api/rooms/${code}/join`, {
  method: 'POST',
  body: JSON.stringify({ name: 'Ada', avatar: '🦊', playerId: A.id, token: 'stale' }),
});
ok('a stale token becomes a fresh seat, not an error', staleSeat.status === 200 && staleSeat.body?.playerId !== A.id, `status=${staleSeat.status}`);

/* --- 9. bad rooms -------------------------------------------------------- */

const missing = await call('/api/rooms/YYY-999');
ok('unknown room is a clean 404', missing.status === 404, `status=${missing.status}`);

const badAlphabet = await call('/api/rooms/ZZZ-000');
ok('a code using excluded characters is rejected outright', badAlphabet.status === 400, `status=${badAlphabet.status}`);

const malformed = await call('/api/rooms/not-a-code');
ok('malformed code is rejected', malformed.status === 400 || malformed.status === 404, `status=${malformed.status}`);

const noSeat = await call(`/api/rooms/${code}/events`, {
  method: 'POST',
  body: JSON.stringify({ events: [{ t: 'ready', ready: true }] }),
});
ok('events without credentials are refused', noSeat.status === 401, `status=${noSeat.status}`);

/* --- 10. full room ------------------------------------------------------- */

let lastJoin = null;
for (let i = 0; i < 6; i += 1) {
  lastJoin = await call(`/api/rooms/${code}/join`, {
    method: 'POST',
    body: JSON.stringify({ name: `Extra${i}`, avatar: '🐛' }),
  });
  if (lastJoin.status !== 200) break;
}
ok('a full room turns people away with a reason', lastJoin.status === 409 || lastJoin.status === 403, `status=${lastJoin.status} body=${JSON.stringify(lastJoin.body)}`);

/* --- 11. secrets (criterion 12) ------------------------------------------ */

// Naming the variable that would fix a warning is helpful; *containing one* is
// not. So the check is for values — never for names.
//
// The JWT pattern is deliberately three dot-separated segments rather than a
// bare `eyJ`: Supabase keys are JWTs, while a dev bundle's inlined sourcemap is
// also base64 of `{"` and would otherwise match every file on disk.
const secretish =
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|\bsbp_[a-f0-9]{20,}/;
ok('health leaks no key material', !secretish.test(JSON.stringify(health.body)));

// The real test of criterion 12: nothing secret reached the client bundle.
// Dev-server HMR chunks are skipped — they are rewritten constantly and are not
// what ships. Run after `npm run build` for the meaningful answer.
const bundleDir = new URL('../.next/static/', import.meta.url);
const forbidden = ['SUPABASE_SERVICE_ROLE_KEY', 'PEXELS_API_KEY', 'UNSPLASH_ACCESS_KEY', 'CRON_SECRET'];
let scanned = 0;
const offenders = [];
try {
  const { readdir, readFile } = await import('node:fs/promises');
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.name.endsWith('.js') || entry.name.includes('.hot-update.')) continue;
      scanned += 1;
      const text = await readFile(child, 'utf8');
      if (secretish.test(text)) offenders.push(`${entry.name}: key-shaped value`);
      // These names must never even be *referenced* from client code.
      for (const name of forbidden) {
        if (text.includes(name)) offenders.push(`${entry.name}: ${name}`);
      }
    }
  };
  await walk(bundleDir);
} catch {
  scanned = -1;
}

if (scanned === -1) {
  console.log('  SKIP  client bundle scan (no .next/static — run `npm run build` first)');
} else {
  ok(`client bundle carries no secrets (${scanned} files)`, offenders.length === 0, offenders.join(', '));
}

/* --- 12. maintenance ----------------------------------------------------- */

const sweep = await call('/api/cron/sweep');
ok('sweep endpoint responds', sweep.status === 200 && sweep.body?.ok === true, JSON.stringify(sweep.body));

/* --- 13. all the way to complete ----------------------------------------- */

const premature = await call('/api/challenges', {
  method: 'POST',
  body: JSON.stringify({ code, playerId: A.id }),
});
ok('a challenge cannot be minted before the puzzle is solved', premature.status === 409, `status=${premature.status}`);

// Level-4 hints place a piece each, so a two-dozen-piece puzzle is a cheap way
// to drive the room all the way to `complete` through the real event path.
let guard = 0;
let stalls = 0;
let live = await state();
while (live.status !== 'complete' && guard < 80) {
  guard += 1;
  const before = live.groups.length;
  const res = await send(guard % 2 ? A : B, [{ t: 'hint', level: 4 }]);
  live = await state();
  if (live.groups.length === before) {
    stalls += 1;
    // A stall that repeats is information, not noise: print the board once so a
    // failure here says *why* rather than only that progress stopped.
    if (stalls === 3) {
      console.log(`        stalled at ${before} groups (http=${res.status})`);
      console.log(`        ${live.groups.map((g) => `#${g.id}[${g.pieces.length}]@${Math.round(g.ox)},${Math.round(g.oy)}r${g.rot}`).join(' ')}`);
      console.log(`        locks=${JSON.stringify(live.locks)}`);
    }
    if (stalls >= 6) break;
  } else {
    stalls = 0;
  }
}
ok('the room reaches complete through real events', live.status === 'complete', `status=${live.status} after ${guard} hints`);
ok('completion is stamped', typeof live.completedAt === 'number' && live.completedAt > 0, String(live.completedAt));

const finished = await call(`/api/rooms/${code}`);
ok('the view agrees the room is complete', finished.body?.view?.room?.status === 'complete', String(finished.body?.view?.room?.status));
ok('progress reads as finished', finished.body?.view?.session?.progress === 1, String(finished.body?.view?.session?.progress));

const challenge = await call('/api/challenges', {
  method: 'POST',
  body: JSON.stringify({ code, playerId: A.id }),
});
ok(
  'a challenge link is minted after completion',
  challenge.status === 200 || challenge.status === 201,
  `status=${challenge.status} ${JSON.stringify(challenge.body ?? null).slice(0, 160)}`,
);
const challengeId = challenge.body?.challenge?.id;
ok(
  'the challenge carries a time to beat',
  (challenge.body?.challenge?.timeMs ?? 0) > 0,
  JSON.stringify(challenge.body?.challenge ?? null).slice(0, 160),
);
ok('the challenge path is what the client expects', challenge.body?.path === `/c/${challengeId}`, String(challenge.body?.path));

if (challengeId) {
  const fetched = await call(`/api/challenges/${challengeId}`);
  ok('the challenge can be opened by a stranger', fetched.status === 200 && !!fetched.body?.challenge, JSON.stringify(fetched.body).slice(0, 160));
  ok('the challenge resolves its puzzle so it can be replayed', !!fetched.body?.puzzle?.image?.url, JSON.stringify(fetched.body?.puzzle?.image ?? null).slice(0, 120));
}

/* --- 14. rematch ---------------------------------------------------------- */

const seedBefore = live.seed;
await send(A, [{ t: 'restart' }]);
const rematch = await state();
ok('the host can restart once complete', rematch.status === 'lobby', String(rematch.status));
ok('a rematch re-scrambles the same picture', rematch.seed !== seedBefore, `${seedBefore} → ${rematch.seed}`);
ok('the puzzle keeps its identity across a rematch', rematch.puzzleId === live.puzzleId);

/* -------------------------------------------------------------------------- */

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exitCode = failures === 0 ? 0 : 1;
