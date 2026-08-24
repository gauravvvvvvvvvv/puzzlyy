/**
 * Compare-and-swap contention test. Requires `fake-supabase.mjs` and a server
 * pointed at it:
 *
 *   node scripts/fake-supabase.mjs 54321 &
 *   SUPABASE_URL=http://127.0.0.1:54321 \
 *   SUPABASE_SERVICE_ROLE_KEY=fake \
 *   SUPABASE_STORAGE_BUCKET=puzzly-images npx next dev -p 3002 &
 *   node scripts/smoke-cas.mjs http://localhost:3002 http://localhost:54321
 *
 * ## What this is for
 *
 * Spec §1 rests on one claim: Puzzly is correct across Vercel instances because
 * every mutation is a `load -> mutate -> PATCH ?version=eq.N` compare-and-swap,
 * and a lost race is retried against the winner's state. That claim had never
 * been tested. `smoke-edge.mjs` has a contention section, but against a store
 * that answers in microseconds the two requests never overlap — 186 CAS attempts
 * across a full run produced *zero* conflicts, so the retry branch in `withRoom`
 * was dead code as far as any test could tell.
 *
 * So this test makes the race happen on purpose: `fake-supabase` is told to delay
 * every REST call, which widens the read-modify-write window until concurrent
 * requests genuinely collide. Then it asserts the only thing that matters —
 * **nobody's work is lost**. Every accepted move must be present in the final
 * state, and no request may fall back to the 503 "room is busy".
 *
 * A conflict count of zero fails this test. That is deliberate: if the harness
 * stops producing contention, the test is no longer checking anything, and
 * silently passing would be worse than failing.
 */

const BASE = process.argv[2] ?? 'http://localhost:3002';
const FAKE = process.argv[3] ?? 'http://localhost:54321';
const LATENCY_MS = 45;

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

const stats = () => fetch(`${FAKE}/__stats`).then((r) => r.json());
const latency = (ms) => fetch(`${FAKE}/__latency?ms=${ms}`, { method: 'POST' });

console.log(`\nPuzzly CAS contention → ${BASE} (via ${FAKE})\n`);

/* --- 0. the harness has to be the durable one ---------------------------- */

const health = await call('/api/health');
ok(
  'server is running against the durable store',
  health.body?.storage?.rooms === 'durable',
  `rooms=${health.body?.storage?.rooms} — start the server with SUPABASE_URL set`,
);
if (health.body?.storage?.rooms !== 'durable') {
  console.log('\nAborting: this test is meaningless against the in-memory store.\n');
  process.exitCode = 1;
  throw new Error('not durable');
}

let reachable = true;
try {
  await stats();
} catch {
  reachable = false;
}
ok('fake-supabase control endpoint is reachable', reachable, FAKE);
if (!reachable) {
  process.exitCode = 1;
  throw new Error('no control endpoint');
}

/* --- 1. one arm of the experiment ---------------------------------------- */

const images = await call('/api/images?source=original&perPage=1');
const asset = images.body?.items?.[0];

/**
 * Drive `PAIRS` simultaneous move-pairs through a fresh room at a given REST
 * latency, and report what happened.
 *
 * Run twice: once serialized (latency 0, no conflicts) and once contended. The
 * serialized arm is the control — it establishes how far the *engine* legitimately
 * moves a dropped group, so the contended arm can be judged against that instead
 * of against a naive "it must be exactly where I asked".
 */
async function runArm(label, latencyMs) {
  const created = await call('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({
      image: asset,
      settings: { pieceCount: 100, rotation: false },
      gameType: 'jigsaw',
      title: `CAS ${label}`,
    }),
  });
  const code = created.body?.code;
  if (!code) throw new Error(`could not create room for ${label} arm`);

  const join = (name) =>
    call(`/api/rooms/${code}/join`, {
      method: 'POST',
      body: JSON.stringify({ name, avatar: '🦊' }),
    });
  const a = await join('Ada');
  const b = await join('Bo');
  const A = { id: a.body.playerId, token: a.body.token };
  const B = { id: b.body.playerId, token: b.body.token };

  const send = (who, events) =>
    call(`/api/rooms/${code}/events`, {
      method: 'POST',
      body: JSON.stringify({ playerId: who.id, token: who.token, events }),
    });
  const state = () => call(`/api/rooms/${code}`).then((r) => r.body.session);

  await send(A, [{ t: 'ready', ready: true }]);
  await send(B, [{ t: 'ready', ready: true }]);
  await send(A, [{ t: 'start' }]);

  const started = await state();
  const pieceTotal = started.groups.reduce((n, g) => n + g.pieces.length, 0);

  // Single-piece groups only: a merge changes a group's identity mid-test and
  // makes "did this move survive" unanswerable.
  const singles = started.groups.filter((g) => g.pieces.length === 1);
  const targets = singles.slice(0, PAIRS * 2);

  await latency(latencyMs);
  const before = await stats();

  const intended = new Map();
  const origins = new Map();
  const responses = [];

  for (let i = 0; i < PAIRS; i += 1) {
    const gA = targets[i * 2];
    const gB = targets[i * 2 + 1];
    const moveA = { ox: Math.round(gA.ox) + 211 + i, oy: Math.round(gA.oy) + 307 + i };
    const moveB = { ox: Math.round(gB.ox) - 197 - i, oy: Math.round(gB.oy) - 289 - i };
    intended.set(gA.id, moveA);
    intended.set(gB.id, moveB);
    origins.set(gA.id, { ox: gA.ox, oy: gA.oy });
    origins.set(gB.id, { ox: gB.ox, oy: gB.oy });

    const [rA, rB] = await Promise.all([
      send(A, [{ t: 'grab', g: gA.id }, { t: 'move', g: gA.id, ...moveA }, { t: 'drop', g: gA.id, ...moveA }]),
      send(B, [{ t: 'grab', g: gB.id }, { t: 'move', g: gB.id, ...moveB }, { t: 'drop', g: gB.id, ...moveB }]),
    ]);
    responses.push(rA, rB);
  }

  const after = await stats();
  await latency(0);

  const final = await state();
  const byId = new Map(final.groups.map((g) => [g.id, g]));

  // Three separate things are worth knowing about each group:
  //   drift    — how far the server put it from where we asked (snapping)
  //   travel   — how far it actually moved from where it started
  //   stranded — it never moved at all, which is what a clobbered write looks like
  let maxDrift = 0;
  const stranded = [];
  const vanished = [];

  for (const [id, want] of intended) {
    const group = byId.get(id);
    if (!group) {
      vanished.push(id);
      continue;
    }
    const origin = origins.get(id);
    const drift = Math.hypot(group.ox - want.ox, group.oy - want.oy);
    const travel = Math.hypot(group.ox - origin.ox, group.oy - origin.oy);
    const asked = Math.hypot(want.ox - origin.ox, want.oy - origin.oy);
    maxDrift = Math.max(maxDrift, drift);
    // Generous: anything that covered less than a third of the requested
    // distance did not really move, whatever snapping did afterwards.
    if (travel < asked / 3) stranded.push(`${id}: travelled ${Math.round(travel)} of ${Math.round(asked)}`);
  }

  return {
    label,
    code,
    responses,
    attempts: after.casAttempts - before.casAttempts,
    conflicts: after.casConflicts - before.casConflicts,
    rejections: after.rejections.length,
    unsupported: after.unsupported,
    moves: intended.size,
    maxDrift,
    stranded,
    vanished,
    pieceTotal,
    finalPieceTotal: final.groups.reduce((n, g) => n + g.pieces.length, 0),
  };
}

const PAIRS = 8;

const control = await runArm('serialized', 0);
const contended = await runArm('contended', LATENCY_MS);

console.log(
  `        serialized: ${control.attempts} attempts, ${control.conflicts} conflicts, max drift ${Math.round(control.maxDrift)}`,
);
console.log(
  `        contended:  ${contended.attempts} attempts, ${contended.conflicts} conflicts, max drift ${Math.round(contended.maxDrift)}`,
);

/* --- 2. what must be true ------------------------------------------------ */

ok('the serialized arm never hit a race', control.conflicts === 0, `${control.conflicts} conflicts`);

// If this fails the rest proves nothing, so it is a failure and not a skip: an
// un-contended harness cannot test a retry loop.
ok(
  'the harness actually produced contention',
  contended.conflicts > 0,
  `0 conflicts in ${contended.attempts} attempts — raise LATENCY_MS or the test is inert`,
);

for (const arm of [control, contended]) {
  const busy = arm.responses.filter((r) => r.status === 503);
  ok(`[${arm.label}] no request gave up with "the room is busy"`, busy.length === 0, `${busy.length}/${arm.responses.length}`);

  const rejected = arm.responses.filter((r) => r.status !== 200);
  ok(`[${arm.label}] every request was accepted`, rejected.length === 0, rejected.map((r) => r.status).join(','));

  // The assertion that actually means "no write was lost". A clobbered commit
  // leaves the group sitting exactly where it started; snapping never does.
  ok(`[${arm.label}] all ${arm.moves} moves left their starting position`, arm.stranded.length === 0, arm.stranded.slice(0, 3).join(' | '));

  ok(`[${arm.label}] no group vanished`, arm.vanished.length === 0, arm.vanished.join(','));

  // Immune to snapping, and a strong check on merge bookkeeping: pieces are
  // conserved no matter how groups combine.
  ok(
    `[${arm.label}] pieces are conserved (${arm.finalPieceTotal})`,
    arm.finalPieceTotal === arm.pieceTotal,
    `${arm.pieceTotal} → ${arm.finalPieceTotal}`,
  );

  ok(`[${arm.label}] no write was refused by a constraint`, arm.rejections === 0, String(arm.rejections));
  ok(`[${arm.label}] every query the store sent was understood`, arm.unsupported.length === 0, arm.unsupported.slice(0, 3).join(', '));
}

// The point of the control arm: whatever residual drift exists is the puzzle
// engine snapping a dropped group to its neighbour, not concurrency losing data.
// Contention must not make it worse.
ok(
  'contention does not distort placement beyond the serialized baseline',
  contended.maxDrift <= Math.max(control.maxDrift, 1) * 1.5 + 8,
  `serialized ${Math.round(control.maxDrift)} vs contended ${Math.round(contended.maxDrift)}`,
);

// Every committed mutation must bump the version, so a client can trust a gap in
// `seq` to mean "I missed something" rather than "the server double-counted".
const room = await fetch(`${FAKE}/rest/v1/rooms?code=eq.${contended.code}&select=version`, {
  headers: { apikey: 'fake', Authorization: 'Bearer fake' },
}).then((r) => r.json());
const version = room?.[0]?.version ?? 0;
ok('the row version advanced', version > 0, `version=${version}`);

/* -------------------------------------------------------------------------- */

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exitCode = failures === 0 ? 0 : 1;
