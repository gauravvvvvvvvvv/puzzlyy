/**
 * Headless visual/interaction regression: node scripts/smoke-visual.mjs
 * Run a local dev server first. Screenshots are saved to /tmp for CI artifacts.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const base = process.argv[2] ?? 'http://127.0.0.1:3000';
const out = '/tmp/puzzly-qa';
await mkdir(out,{recursive:true});
const json = async (route,body) => {
  const response = await fetch(base+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined);
  const payload=await response.json();
  if(!response.ok)throw new Error(route+' returned '+response.status+': '+JSON.stringify(payload).slice(0,150));
  return payload;
};
const stock=await json('/api/images?source=original&perPage=1');
const image=stock.items?.[0];
if(!image)throw new Error('Missing original sample image');
const room=await json('/api/rooms',{image,settings:{pieceCount:25,rotation:false,blindMode:false},gameType:'jigsaw'});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const results=[];
async function check(name,fn){
  try{const t=Date.now();await fn();results.push({name,status:'PASS',ms:Date.now()-t});}
  catch(e){results.push({name,status:'FAIL',reason:String(e)});}
}
try{
  const desktop=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await desktop.newPage();
  await check('Desktop lobby renders',async()=>{
    await page.goto(base+'/room/'+room.code,{waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:/i'm ready/i}).waitFor({timeout:30000});
    await page.screenshot({path:out+'/lobby-desktop.png'});
  });
  await check('Ready button toggles without network delay',async()=>{
    const b=page.getByRole('button',{name:/i'm ready/i});
    await b.click();
    await page.getByRole('button',{name:/you're ready/i}).waitFor({timeout:500});
  });
  await check('Chat submit is immediate',async()=>{
    const field=page.getByRole('textbox',{name:'Room message'});
    await field.fill('Browser QA instant chat');
    await page.getByRole('button',{name:'Send'}).click();
    await page.getByText('Browser QA instant chat').waitFor({timeout:600});
  });
  await check('Start the puzzle without a second player',async()=>{
    const start=page.getByRole('button',{name:/start solving/i});
    await start.waitFor({timeout:60000});
    await start.click();
    await page.getByRole('button',{name:/board settings/i}).waitFor({timeout:60000});
    await page.screenshot({path:out+'/board-desktop.png'});
  });
  await check('Hint button reacts to tap',async()=>{
    const hint=page.getByRole('button',{name:/hint/i}).first();
    await hint.click();
    await page.getByText(/Try looking around|The piece you want|That one|Placed it for you/).first().waitFor({timeout:8000});
  });
  await check('Reaction tray works',async()=>{
    await page.getByRole('button',{name:/say something/i}).click();
    await page.getByRole('button',{name:/react with/i}).first().click();
    await page.screenshot({path:out+'/reaction-desktop.png'});
  });
  await check('Reference ghost toggle remains present',async()=>{
    await page.getByRole('button',{name:/board settings/i}).click();
    const label=page.getByText('Reference ghost');
    await label.waitFor({timeout:4000});
    await page.screenshot({path:out+'/settings-desktop.png'});
  });
  await check('Six media tiles fit in desktop gallery',async()=>{
    const widths=await page.evaluate(()=>{
      const parent=document.querySelector('[aria-label="Room messages"]');
      return {width:window.innerWidth,chatWidth:parent?.getBoundingClientRect().width??0};
    });
    if(widths.chatWidth<180||widths.chatWidth>450)throw new Error('Chat width out of range: '+JSON.stringify(widths));
  });
  const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
  const phone=await mobile.newPage();
  await check('Mobile room joins and opens chat',async()=>{
    await phone.goto(base+'/room/'+room.code,{waitUntil:'domcontentloaded'});
    const chat=phone.getByRole('button',{name:/open room chat/i});
    await chat.waitFor({timeout:30000});
    await chat.click();
    await phone.getByRole('textbox',{name:'Room message'}).waitFor({timeout:3000});
    await phone.screenshot({path:out+'/chat-mobile.png'});
  });
  await check('Mobile chat and media controls are touch accessible',async()=>{
    const a=phone.getByRole('button',{name:/join voice|mute microphone/i});
    const b=phone.getByRole('button',{name:/start camera|stop camera/i});
    if(!(await a.isVisible())||!(await b.isVisible()))throw new Error('Call buttons missing');
    const sizes=await Promise.all([a.boundingBox(),b.boundingBox()]);
    if(sizes.some(x=>!x||x.height<42||x.width<42))throw new Error('Call buttons below touch target');
    if(await phone.getByText('🎙 Join voice').count())throw new Error('Old emoji button found');
  });
  await check('Mobile chat never overflows screen',async()=>{
    const w=await phone.evaluate(()=>({screen:window.innerWidth,doc:document.documentElement.scrollWidth}));
    if(w.doc>w.screen+3)throw new Error('Horizontal overflow: '+JSON.stringify(w));
  });
  await desktop.close();await mobile.close();
}finally{await browser.close()}
for(const x of results)console.log(x.status+' '+x.name+(x.ms!==undefined?' '+x.ms+'ms':' '+x.reason));
if(results.some(x=>x.status==='FAIL'))process.exitCode=1;
