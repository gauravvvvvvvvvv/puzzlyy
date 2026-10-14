/**
 * Room lifecycle + social protocol regression checks.
 * Start the dev server first, then:
 *   node scripts/smoke-social.mjs [http://localhost:3000]
 *
 * Runs against the zero-config in-memory backend. No writes to production.
 */
const base = process.argv[2] ?? 'http://localhost:3000';
let failures = 0;
function check(name, truth, detail = '') {
  console.log((truth ? 'PASS ' : 'FAIL ') + name + (truth ? '' : ': ' + detail));
  if (!truth) failures += 1;
}
async function api(path, payload) {
  const response = await fetch(base + path, payload === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}
const library = await api('/api/images?source=original&perPage=3');
const images = library.body?.items ?? [];
if (!images.length) throw new Error('No original puzzle images to test.');
const created = await api('/api/rooms', {
  image: images[0], settings: { pieceCount: 25, rotation: false, blindMode: false },
  gameType: 'jigsaw',
});
check('created room', created.status === 201);
if (!created.body?.code) process.exit(1);
const code = created.body.code;
const roomPath = '/api/rooms/' + encodeURIComponent(code);
const alice = await api(roomPath + '/join', { name: 'Ada', avatar: '🦊' });
const bob = await api(roomPath + '/join', { name: 'Bo', avatar: '🐢' });
check('two authenticated seats', alice.body?.token && bob.body?.token &&
  alice.body.playerId !== bob.body.playerId);
const A = { playerId: alice.body.playerId, token: alice.body.token };
const B = { playerId: bob.body.playerId, token: bob.body.token };
const send = (seat, events) => api(roomPath + '/events', { ...seat, events });
const beforeResume = await api(roomPath);
const resumed = await api(roomPath + '/join', { ...A, name: 'Ada', avatar: '🦊' });
const afterResume = await api(roomPath);
check('resume increments the durable sequence exactly once',
  resumed.status === 200 &&
  resumed.body.seq === afterResume.body.seq &&
  afterResume.body.seq === beforeResume.body.seq + 1);


// Solo hosts can start from the lobby without inviting a second player.
const soloRoom = await api('/api/rooms', {
  image: images[0], settings: { pieceCount: 25, rotation: false, blindMode: false },
  gameType: 'jigsaw', hostCanForceStart: false,
});
const soloCode = soloRoom.body?.code;
check('solo test room created', !!soloCode);
if (soloCode) {
  const soloPath = '/api/rooms/' + soloCode;
  const soloSeat = await api(soloPath + '/join', { name: 'Solo', avatar: '⭐' });
  const soloStart = await api(soloPath + '/events', {
    playerId: soloSeat.body?.playerId, token: soloSeat.body?.token,
    events: [{ t: 'ready', ready: true }, { t: 'start' }],
  });
  const soloState = await api(soloPath);
  check('host can start alone without force-start setting',
    soloStart.status === 200 && soloState.body?.view?.room?.status === 'playing');
}

const chat = await send(A, [{ t: 'chat', text: 'Hello, next puzzle?' }]);
check('chat event accepted', chat.status === 200);
const snapshot = await api(roomPath);
check('chat persists in room', snapshot.body?.view?.chat?.some(m => m.text === 'Hello, next puzzle?'));
check('rooms last thirty days from activity',
  snapshot.body?.view?.room?.expiresAt > Date.now() + 29 * 86400000);
const forgedChat = await send({ ...A, token: 'not-the-token' }, [{ t: 'chat', text: 'Forged' }]);
check('chat requires seat credentials', forgedChat.status === 401);
const fakeRtc = await send({ ...A, token: 'wrong' }, [{
  t: 'rtc', to: B.playerId, kind: 'offer', data: '{}',
}]);
check('RTC signaling requires seat credentials', fakeRtc.status === 401);
const ice = await api(roomPath + '/ice', A);
check('ICE config supplied', ice.status === 200 && ice.body?.iceServers?.length >= 1);
const fakeIce = await api(roomPath + '/ice', { ...A, token: 'wrong' });
check('TURN credentials require seat credentials', fakeIce.status === 401);

const another = images[1] ?? images[0];
const request = { ...A, image: another, settings: { pieceCount: 50, rotation: false, blindMode: false } };
const notHost = await api(roomPath + '/puzzle', { ...request, ...B });
check('only host can change puzzle', notHost.status === 403);
const changed = await api(roomPath + '/puzzle', request);
check('host can change picture in same room', changed.status === 200);
const after = await api(roomPath);
check('room code survives puzzle change', after.body?.view?.room?.code === code);
check('new round created', after.body?.view?.room?.round === 2 &&
  after.body?.view?.puzzle?.id !== snapshot.body?.view?.puzzle?.id);
check('chat survives puzzle change', after.body?.view?.chat?.[0]?.text === 'Hello, next puzzle?');
check('both players remain seated', after.body?.view?.players?.length === 2);

await send(A, [{ t: 'ready', ready: true }]);
await send(B, [{ t: 'ready', ready: true }]);
const playing = await api(roomPath);
check('next round starts without rejoining', playing.body?.view?.room?.status === 'playing');
await send(A, [{ t: 'grab', g: 0 }]);
const grabbed = await api(roomPath);
check('piece lock belongs to host', grabbed.body?.session?.locks?.['0'] === A.playerId);
const contested = await send(B, [{ t: 'tug', g: 0, force: 0 }]);
check('contesting a held piece accepted', contested.status === 200);
const tugSnap = await api(roomPath);
check('visible server-resolved contest', tugSnap.body?.view?.tugs?.some(t => t.g === 0));
for (let i = 0; i < 6; i++) await send(B, [{ t: 'tug', g: 0, force: 12 }]);
const resolved = await api(roomPath);
check('tug has one authoritative winner',
  [A.playerId, B.playerId].includes(resolved.body?.session?.locks?.['0']));
check('tug record released after resolution',
  !(resolved.body?.view?.tugs ?? []).some(t => t.g === 0));

console.log('\n' + (failures ? failures + ' checks failed' : 'All social protocol checks passed'));
if (failures) process.exitCode = 1;
