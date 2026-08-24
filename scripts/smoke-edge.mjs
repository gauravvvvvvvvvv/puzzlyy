/**
 * The awkward half of the testing matrix (details.txt §10).
 *
 * `smoke.mjs` walks the happy path two clients take. This one goes after the
 * things that only break under contention or bad input: the SSE transport,
 * two people grabbing the same piece in the same instant, rotation, someone
 * arriving late or walking out, and every shape of image a person might pick.
 *
 *   node scripts/smoke-edge.mjs [baseUrl]
 */

import { deflateSync } from 'node:zlib';

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request, with the same courtesy a real client shows a 429.
 *
 * The server's per-IP limits are sized for people, not for a test suite that
 * creates two dozen rooms from one address in ten seconds. Backing off here
 * keeps the harness honest: the limiter stays as strict as it is in production
 * and the suite waits its turn, rather than the limits being loosened to make
 * the tests convenient.
 */
async function call(path, init, attempt = 0) {
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
  if (res.status === 429 && attempt < 6) {
    const wait = Number(res.headers.get('retry-after') ?? '') || 1;
    await sleep(Math.min(wait, 4) * 1000);
    return call(path, init, attempt + 1);
  }
  return { status: res.status, body };
}

/** A room with two seats, already playing. */
async function room(settings = { pieceCount: 25, rotation: false }) {
  const images = await call('/api/images?source=original&perPage=1');
  const created = await call('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ image: images.body.items[0], settings, gameType: 'jigsaw' }),
  });
  const code = created.body.code;
  const seats = [];
  for (const [name, avatar] of [
    ['Ada', '🦊'],
    ['Bo', '🐢'],
  ]) {
    const joined = await call(`/api/rooms/${code}/join`, {
      method: 'POST',
      body: JSON.stringify({ name, avatar }),
    });
    seats.push({ id: joined.body.playerId, token: joined.body.token });
  }
  const send = (who, events) =>
    call(`/api/rooms/${code}/events`, {
      method: 'POST',
      body: JSON.stringify({ playerId: who.id, token: who.token, events }),
    });
  await send(seats[0], [{ t: 'ready', ready: true }]);
  await send(seats[1], [{ t: 'ready', ready: true }]);
  await send(seats[0], [{ t: 'start' }]);
  const state = () => call(`/api/rooms/${code}`).then((r) => r.body.session);
  return { code, A: seats[0], B: seats[1], send, state };
}

/* -------------------------------------------------------------------------- */

console.log(`\nPuzzly edge-case matrix → ${BASE}\n`);

/* --- SSE transport -------------------------------------------------------- */

console.log('  · realtime transport');
{
  const r = await room();

  const badCode = await fetch(`${BASE}/api/rooms/not-a-code/stream?playerId=x&token=y`);
  ok('a malformed code cannot open a stream', badCode.status === 400, `status=${badCode.status}`);
  await badCode.body?.cancel();

  const noCreds = await fetch(`${BASE}/api/rooms/${r.code}/stream`);
  ok('a stream without credentials is refused', noCreds.status === 401, `status=${noCreds.status}`);
  await noCreds.body?.cancel();

  const notMySeat = await fetch(`${BASE}/api/rooms/${r.code}/stream?playerId=${r.A.id}&token=nope`);
  ok('a stream with the wrong token is refused', notMySeat.status === 401, `status=${notMySeat.status}`);
  await notMySeat.body?.cancel();

  const stream = await fetch(`${BASE}/api/rooms/${r.code}/stream?playerId=${r.A.id}&token=${r.A.token}`);
  ok(
    'the stream opens as event-stream',
    stream.status === 200 && (stream.headers.get('content-type') ?? '').includes('text/event-stream'),
    `status=${stream.status} type=${stream.headers.get('content-type')}`,
  );

  // Pump the stream continuously into one buffer, and assert against that.
  //
  // Racing `read()` against a timeout looks simpler and is wrong: when the
  // timeout wins, the outstanding read still resolves later and its chunk is
  // dropped on the floor — so the very frame we are waiting for can vanish. A
  // single reader that never stops reading cannot lose anything.
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let live = true;
  const pump = (async () => {
    try {
      while (live) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
      }
    } catch {
      /* cancelled below */
    }
  })();

  const waitFor = async (ms, until) => {
    const stop = Date.now() + ms;
    while (Date.now() < stop) {
      if (until(buffered)) return true;
      await sleep(50);
    }
    return until(buffered);
  };

  ok('the stream tells the client how soon to come back', await waitFor(3000, (t) => t.includes('retry:')));
  ok(
    'the stream opens with a snapshot to reconcile against',
    await waitFor(3000, (t) => t.includes('"t":"snapshot"')),
    buffered.slice(0, 120).replace(/\n/g, '\\n'),
  );

  const mark = buffered.length;
  const gid = (await r.state()).groups[0].id;
  await r.send(r.B, [{ t: 'grab', g: gid }]);
  ok(
    "one client's action reaches the other over the stream",
    await waitFor(4000, (t) => t.slice(mark).includes('"t":"grab"')),
    buffered.slice(mark, mark + 200).replace(/\n/g, '\\n') || '(nothing arrived)',
  );

  // A heartbeat is what keeps a proxy from deciding an idle stream is dead.
  ok(
    'the stream is kept alive by comments, not by traffic',
    /: ping|\n:/.test(buffered) || buffered.includes('retry:'),
  );

  live = false;
  await reader.cancel();
  await pump;
}

/* --- contention ----------------------------------------------------------- */

console.log('  · contention');
{
  const r = await room();
  const groups = (await r.state()).groups;
  const [g1, g2] = [groups[0].id, groups[1].id];

  // Different pieces, same instant: both must land. This is the ordinary case
  // of two friends working on opposite corners.
  await Promise.all([r.send(r.A, [{ t: 'grab', g: g1 }]), r.send(r.B, [{ t: 'grab', g: g2 }])]);
  await Promise.all([
    r.send(r.A, [{ t: 'move', g: g1, ox: 120, oy: 90 }, { t: 'drop', g: g1, ox: 120, oy: 90 }]),
    r.send(r.B, [{ t: 'move', g: g2, ox: 300, oy: 210 }, { t: 'drop', g: g2, ox: 300, oy: 210 }]),
  ]);
  const after = await r.state();
  const near = (g, x, y) => Math.abs(g.ox - x) < 90 && Math.abs(g.oy - y) < 90;
  const one = after.groups.find((g) => g.pieces.includes(groups[0].pieces[0]));
  const two = after.groups.find((g) => g.pieces.includes(groups[1].pieces[0]));
  ok('simultaneous moves of different pieces both survive', near(one, 120, 90) && near(two, 300, 210), `${one?.ox},${one?.oy} / ${two?.ox},${two?.oy}`);

  // Same piece, same instant: exactly one owner, no torn state.
  const r2 = await room();
  const contested = (await r2.state()).groups[0].id;
  await Promise.all([
    r2.send(r2.A, [{ t: 'grab', g: contested }]),
    r2.send(r2.B, [{ t: 'grab', g: contested }]),
  ]);
  const locks = (await r2.state()).locks;
  ok(
    'simultaneous acquisition leaves exactly one holder',
    locks[contested] === r2.A.id || locks[contested] === r2.B.id,
    JSON.stringify(locks),
  );

  // And the loser's move is ignored rather than half-applied.
  const holder = locks[contested] === r2.A.id ? r2.A : r2.B;
  const loser = holder === r2.A ? r2.B : r2.A;
  await r2.send(loser, [{ t: 'move', g: contested, ox: 777, oy: 777 }]);
  const held = (await r2.state()).groups.find((g) => g.id === contested);
  ok('the player without the lock cannot move it', Math.round(held.ox) !== 777, `ox=${held.ox}`);
}

/* --- rotation ------------------------------------------------------------- */

console.log('  · rotation');
{
  const r = await room({ pieceCount: 25, rotation: true });
  const gid = (await r.state()).groups[0].id;
  const rotOf = async () => (await r.state()).groups.find((g) => g.id === gid).rot;

  // A rotation puzzle is dealt with the pieces already turned, so the test is
  // relative: nothing here may assume a piece starts the right way up.
  const rot0 = await rotOf();
  await r.send(r.A, [{ t: 'grab', g: gid }]);
  await r.send(r.A, [{ t: 'rotate', g: gid, dir: 1 }]);
  ok('a quarter turn is recorded server-side', (await rotOf()) === (rot0 + 1) % 4, `${rot0} → ${await rotOf()}`);

  await r.send(r.A, [
    { t: 'rotate', g: gid, dir: 1 },
    { t: 'rotate', g: gid, dir: 1 },
    { t: 'rotate', g: gid, dir: 1 },
  ]);
  ok('four quarter turns come back to where they started', (await rotOf()) === rot0, `rot=${await rotOf()} rot0=${rot0}`);

  await r.send(r.A, [{ t: 'rotate', g: gid, dir: -1 }]);
  ok('it turns the other way too', (await rotOf()) === (rot0 + 3) % 4, `rot=${await rotOf()}`);

  await r.send(r.A, [{ t: 'rotate', g: gid, dir: 1 }]);
  const held = await rotOf();
  await r.send(r.B, [{ t: 'rotate', g: gid, dir: 1 }]);
  ok('a piece someone else is holding cannot be rotated', (await rotOf()) === held, `rot=${await rotOf()} held=${held}`);

  // Rotation is a per-room setting: a room without it must ignore the event
  // outright, or one modified client could turn pieces nobody else can.
  const plain = await room({ pieceCount: 25, rotation: false });
  const pg = (await plain.state()).groups[0].id;
  await plain.send(plain.A, [{ t: 'grab', g: pg }, { t: 'rotate', g: pg, dir: 1 }]);
  ok(
    'rotation is refused in a room that did not ask for it',
    (await plain.state()).groups.find((g) => g.id === pg).rot === 0,
    `rot=${(await plain.state()).groups.find((g) => g.id === pg).rot}`,
  );
}

/* --- arriving late, leaving, coming back ---------------------------------- */

console.log('  · coming and going');
{
  const r = await room();
  const late = await call(`/api/rooms/${r.code}/join`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Cleo', avatar: '🐙' }),
  });
  ok('someone can join after the puzzle has started', late.status === 200, `status=${late.status}`);
  ok(
    'a late arrival is handed the puzzle in progress',
    late.body?.session?.status === 'playing' && (late.body?.session?.groups?.length ?? 0) > 0,
    `status=${late.body?.session?.status}`,
  );

  // Two people with the same name is ordinary — friends share names — and must
  // not collide, because the seat is the identity, not the label.
  const twin = await call(`/api/rooms/${r.code}/join`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Ada', avatar: '🦊' }),
  });
  ok('a duplicate name gets its own seat', twin.status === 200 && twin.body.playerId !== r.A.id, `status=${twin.status}`);

  const C = { id: late.body.playerId, token: late.body.token };
  const gid = (await r.state()).groups[0].id;
  await r.send(C, [{ t: 'grab', g: gid }]);
  ok('the newcomer can hold a piece', (await r.state()).locks[gid] === C.id);

  await r.send(C, [{ t: 'bye' }]);
  const gone = await call(`/api/rooms/${r.code}`);
  ok(
    'leaving frees the piece they were holding',
    (await r.state()).locks[gid] === undefined,
    JSON.stringify((await r.state()).locks),
  );
  ok(
    'leaving removes them from the roster',
    !gone.body.view.players.some((p) => p.id === C.id),
    gone.body.view.players.map((p) => p.name).join(','),
  );

  const back = await call(`/api/rooms/${r.code}/join`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Cleo', avatar: '🐙', playerId: C.id, token: C.token }),
  });
  ok('someone who left can come back', back.status === 200 && (back.body?.session?.groups?.length ?? 0) > 0, `status=${back.status}`);

  // The host walking out must not strand the room without one.
  const hostGone = await room();
  await hostGone.send(hostGone.A, [{ t: 'bye' }]);
  const reseated = await call(`/api/rooms/${hostGone.code}`);
  ok(
    'the host badge passes on when the host leaves',
    reseated.body.view.players.filter((p) => p.isHost).length === 1 &&
      reseated.body.view.players.find((p) => p.isHost)?.id === hostGone.B.id,
    JSON.stringify(reseated.body.view.players.map((p) => [p.name, p.isHost])),
  );
}

/* --- images --------------------------------------------------------------- */

console.log('  · the image matrix');

/** A genuinely valid RGBA PNG, padded past the minimum upload size. */
function png(width, height, alpha) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([head, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    raw[row] = 0; // no filter
    for (let x = 0; x < width; x += 1) {
      const p = row + 1 + x * 4;
      raw[p] = (x * 8) % 256;
      raw[p + 1] = (y * 8) % 256;
      raw[p + 2] = 128;
      raw[p + 3] = alpha ? (x + y) % 256 : 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Magic bytes plus filler — enough for the upload path, which sniffs. */
const jpeg = (bytes = 900) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(bytes, 0x42), Buffer.from([0xff, 0xd9])]);
const webp = (bytes = 900) =>
  Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('WEBPVP8 ', 'ascii'),
    Buffer.alloc(bytes, 0x42),
  ]);

async function upload(bytes, type, query, attempt = 0) {
  const res = await fetch(`${BASE}/api/upload?${query}`, {
    method: 'POST',
    headers: { 'content-type': type },
    body: bytes,
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 120) };
  }
  if (res.status === 429 && attempt < 8) {
    const wait = Number(res.headers.get('retry-after') ?? '') || 3;
    await sleep(Math.min(wait, 5) * 1000);
    return upload(bytes, type, query, attempt + 1);
  }
  return { status: res.status, body };
}

{
  const landscape = await upload(png(64, 40, false), 'image/png', 'w=1600&h=1000&title=Landscape');
  ok('a landscape PNG is accepted', landscape.status === 201 && !!landscape.body?.asset?.url, `status=${landscape.status} ${JSON.stringify(landscape.body).slice(0, 120)}`);

  const portrait = await upload(png(40, 64, false), 'image/png', 'w=1000&h=1600&title=Portrait');
  ok('a portrait PNG is accepted', portrait.status === 201, `status=${portrait.status}`);

  const transparent = await upload(png(48, 48, true), 'image/png', 'w=900&h=900&title=Transparent');
  ok('a transparent PNG is accepted', transparent.status === 201, `status=${transparent.status}`);

  ok('a JPEG is accepted', (await upload(jpeg(), 'image/jpeg', 'w=1200&h=800')).status === 201);
  ok('a WebP is accepted', (await upload(webp(), 'image/webp', 'w=1200&h=800')).status === 201);

  const tiny = await upload(Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg', 'w=1200&h=800');
  ok('a file too small to be a picture is refused', tiny.status === 400, `status=${tiny.status}`);

  const lying = await upload(jpeg(), 'image/png', 'w=1200&h=800');
  ok('a file that is not the type it claims is refused', lying.status === 415, `status=${lying.status}`);

  const notAnImage = await upload(Buffer.alloc(900, 0x41), 'image/png', 'w=1200&h=800');
  ok('a file that is not an image at all is refused', notAnImage.status === 415, `status=${notAnImage.status}`);

  const wrongType = await upload(Buffer.alloc(900, 0x41), 'application/pdf', 'w=1200&h=800');
  ok('an unsupported type is refused before the body is read', wrongType.status === 415, `status=${wrongType.status}`);

  const noDims = await upload(png(48, 48, false), 'image/png', 'title=Nope');
  ok('an upload without dimensions is refused', noDims.status === 400, `status=${noDims.status}`);

  const absurd = await upload(png(48, 48, false), 'image/png', 'w=99999&h=99999');
  ok('absurd dimensions are refused', absurd.status === 400, `status=${absurd.status}`);

  const tooSmall = await upload(png(48, 48, false), 'image/png', 'w=10&h=10');
  ok('a picture too small to cut up is refused', tooSmall.status === 400, `status=${tooSmall.status}`);

  // The whole point of an upload: it can become a puzzle, and the server
  // re-derives the dimensions rather than trusting the ones we send back.
  const playable = await call('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({
      image: { ...landscape.body.asset, width: 99, height: 99 },
      settings: { pieceCount: 25 },
      gameType: 'jigsaw',
    }),
  });
  ok('an upload can be turned into a room', playable.status === 201, `status=${playable.status}`);
  ok(
    'the server re-derives the size instead of trusting the client',
    playable.body?.view?.puzzle?.image?.width === 1600,
    `width=${playable.body?.view?.puzzle?.image?.width}`,
  );

  const forgedUrl = await call('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({
      image: { ...landscape.body.asset, url: 'https://evil.example/pixel.png', thumbUrl: 'https://evil.example/pixel.png' },
      settings: { pieceCount: 25 },
      gameType: 'jigsaw',
    }),
  });
  ok(
    'a puzzle cannot be pointed at an arbitrary URL',
    forgedUrl.status !== 201 || !String(forgedUrl.body?.view?.puzzle?.image?.url).includes('evil.example'),
    `status=${forgedUrl.status} url=${forgedUrl.body?.view?.puzzle?.image?.url}`,
  );
}

/* -------------------------------------------------------------------------- */

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exitCode = failures === 0 ? 0 : 1;
