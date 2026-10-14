/**
 * Manual multiplayer playground regression checks.
 * Run locally after npm run dev:
 *    node scripts/smoke-playground.mjs
 * Not wired into GitHub Actions.
 */
const origin=process.argv[2]??'http://localhost:3000';
let failures=0;
function test(name,valid){console.log((valid?'PASS':'FAIL')+' '+name);if(!valid)failures++;}
async function request(path,payload){
 const init=payload===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)};
 const res=await fetch(origin+path,init);
 let body;try{body=await res.json();}catch{body={};}
 return {status:res.status,body};
}
const daily=await request('/api/daily');
test('daily image and UTC day exist',daily.status===200&&Boolean(daily.body.image?.id)&&/^\d{4}-\d{2}-\d{2}$/.test(daily.body.day));
if(!daily.body.image)process.exit(1);
const payload={image:daily.body.image,daily:true,gameType:'jigsaw',
 settings:{pieceCount:25,rotation:false,blindMode:false}};
const first=await request('/api/rooms',payload);
const second=await request('/api/rooms',payload);
test('daily rooms created',Boolean(first.body.code&&second.body.code));
test('daily geometry and image deterministic',first.body.view?.puzzle?.seed===second.body.view?.puzzle?.seed&&
 first.body.view?.puzzle?.imageId===second.body.view?.puzzle?.imageId&&
 first.body.view?.room?.dailyKey===daily.body.day);
if(!first.body.code)process.exit(1);
const path='/api/rooms/'+first.body.code;
const seats=[];
for(let i=0;i<6;i++){
 const j=await request(path+'/join',{name:'P'+i,avatar:'🦊'});
 if(j.body.playerId)seats.push(j.body);
}
test('six interactive players join',seats.length===6&&seats.every(x=>!x.player.spectator));
const spectator=await request(path+'/join',{name:'Viewer',avatar:'🐼',watch:true});
test('full rooms admit authenticated spectator',spectator.status===200&&spectator.body.player?.spectator===true);
const extra=await request(path+'/join',{name:'Another viewer',avatar:'🐼'});
test('overflow joins as spectator',extra.body?.player?.spectator===true);
const send=(seat,events)=>request(path+'/events',{playerId:seat.playerId,token:seat.token,events});
const host=seats[0];
await send(host,[{t:'theme',theme:'space'}]);
let room=await request(path);
test('theme persists through snapshot',room.body.view?.room?.theme==='space');
await send(host,[{t:'music',action:'add',track:{id:'',provider:'youtube',mediaId:'dQw4w9WgXcQ',title:'Test track',addedBy:''}}]);
room=await request(path);
test('music queue persisted',room.body.view?.music?.queue?.length===1);
const viewerSeat=spectator.body;
await send(viewerSeat,[{t:'chat',text:'Watching!'}]);
room=await request(path);
test('spectator can chat',room.body.view?.chat?.some(m=>m.text==='Watching!'));
await send(viewerSeat,[{t:'sticker',symbol:'⭐',x:120,y:120}]);
room=await request(path);
test('spectator can leave a sticker',room.body.view?.stickers?.some(s=>s.symbol==='⭐'));
await send(viewerSeat,[{t:'theme',theme:'arcade'},{t:'music',action:'play'}]);
room=await request(path);
test('spectator cannot change host theme or media controls',room.body.view?.room?.theme==='space'&&
 room.body.view?.music?.playing===false);
for(const seat of seats)await send(seat,[{t:'ready',ready:true}]);
room=await request(path);
test('six players may start while spectators watch',room.body.view?.room?.status==='playing');
await send(viewerSeat,[{t:'grab',g:0},{t:'hint',level:4}]);
room=await request(path);
test('spectator cannot grab puzzle pieces or spend hints',room.body.view?.session?.hintsUsed===0 &&
 !room.body.session?.locks?.['0']);
console.log(failures?failures+' checks failed':'All playground checks passed');
if(failures)process.exitCode=1;
