'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { RoomSession } from '@/hooks/useRoomSession';
import type { MusicTrack } from '@/types/models';

function parseMusicLink(input: string): Pick<MusicTrack, 'provider' | 'mediaId'> | null {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.split('/')[1];
      return /^[\w-]{11}$/.test(id) ? {provider:'youtube', mediaId:id} : null;
    }
    if (['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','www.youtube-nocookie.com'].includes(u.hostname)) {
      const id = u.searchParams.get('v') ||
        (u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/embed/') ? u.pathname.split('/')[2] : null);
      if (id && /^[\w-]{11}$/.test(id)) return {provider:'youtube', mediaId:id};
      const list = u.searchParams.get('list');
      if (list && /^[\w-]{10,80}$/.test(list)) return {provider:'youtube', mediaId:'list:'+list};
    }
    if (u.hostname === 'open.spotify.com') {
      const parts = u.pathname.split('/').filter(Boolean);
      const idx = parts.findIndex(p => ['track','album','playlist'].includes(p));
      if (idx !== -1 && /^[a-zA-Z0-9]{22}$/.test(parts[idx+1] ?? ''))
        return {provider:'spotify', mediaId:parts[idx]+':'+parts[idx+1]};
    }
  } catch { /* invalid input */ }
  return null;
}

type YouTubePlayer = {
  cueVideoById(id:string, seconds?:number):void;
  loadVideoById(id:string, seconds?:number):void;
  cuePlaylist(options:{list:string;listType:string;startSeconds?:number}):void;
  loadPlaylist(options:{list:string;listType:string;startSeconds?:number}):void;
  getCurrentTime():number;
  playVideo():void;
  pauseVideo():void;
  seekTo(seconds:number, ahead:boolean):void;
  destroy():void;
};
type YoutubeAPI = {Player:new(node:HTMLElement, settings:{
  width:string;height:string;
  playerVars:Record<string,number|string>;
  events:{
    onReady:()=>void;
    onError:(event:{data:number})=>void;
    onAutoplayBlocked:()=>void;
    onStateChange:(event:{data:number})=>void;
  };
})=>YouTubePlayer};
declare global {interface Window {YT?: YoutubeAPI; onYouTubeIframeAPIReady?:()=>void}}
let loader:Promise<YoutubeAPI>|null=null;
function loadYouTube():Promise<YoutubeAPI> {
  if(window.YT?.Player) return Promise.resolve(window.YT);
  if(!loader) {
    loader=new Promise((resolve,reject)=>{
      const previous=window.onYouTubeIframeAPIReady;
      let finished=false;
      const finish=(result:YoutubeAPI|null)=>{
        if(finished) return;
        finished=true;
        window.clearTimeout(timeout);
        if(result) resolve(result); else {loader=null; reject(new Error('YouTube player could not load')); }
      };
      window.onYouTubeIframeAPIReady=()=>{previous?.(); finish(window.YT?.Player?window.YT:null);};
      const timeout=window.setTimeout(()=>finish(null),12000);
      if(!document.querySelector('script[data-puzzly-youtube]')) {
        const script=document.createElement('script');
        script.dataset.puzzlyYoutube='true';
        script.src='https://www.youtube.com/iframe_api';
        script.async=true;
        script.onerror=()=>finish(null);
        document.head.appendChild(script);
      }
    });
  }
  return loader;
}
const timeAt=(position:number,updatedAt:number,playing:boolean)=>
  Math.max(0,position+(playing?(Date.now()-updatedAt)/1000:0));
const youtubeHref=(id:string)=>id.startsWith('list:')
  ? 'https://www.youtube.com/playlist?list='+encodeURIComponent(id.slice(5))
  : 'https://www.youtube.com/watch?v='+encodeURIComponent(id);
const spotifyHref=(id:string)=> {
  const [kind,code]=id.split(':');
  return 'https://open.spotify.com/'+kind+'/'+code;
};

export function RoomJukebox({session}:{session:RoomSession}) {
  const {music}=session;
  const track=music.queue[music.current]??null;
  const [url,setUrl]=useState('');
  const [title,setTitle]=useState('');
  const [error,setError]=useState('');
  const [playerError,setPlayerError]=useState('');
  const [playerReady,setPlayerReady]=useState(false);
  const [fallback,setFallback]=useState(false);
  const [pending,setPending]=useState('');
  const [expanded,setExpanded]=useState(true);
  const wrapper=useRef<HTMLDivElement>(null);
  const api=useRef<YouTubePlayer|null>(null);
  const isHostRef=useRef(session.isHost);
  const playingRef=useRef(music.playing);
  isHostRef.current=session.isHost;
  playingRef.current=music.playing;
  const sessionRef=useRef(session);
  sessionRef.current=session;
  const latestMusic=useRef(music);
  latestMusic.current=music;
  const suppress=useRef(0);

  const emit=useCallback((action:'play'|'pause'|'next'|'select'|'remove'|'seek',index?:number)=>{
    setPending(action);
    sessionRef.current.send({t:'music',action,index});
    sessionRef.current.flush();
  },[]);

  useEffect(()=>{ setPending(''); },[music.updatedAt,music.current,music.playing,music.queue.length]);

  const isYouTube=track?.provider==='youtube';
  const trackId=track?.id;
  const mediaId=track?.mediaId;

  useEffect(()=>{
    if(!isYouTube||!mediaId||!wrapper.current||!expanded) return;
    let gone=false;
    setPlayerReady(false);
    setPlayerError('');
    setFallback(false);
    const host=wrapper.current;
    const element=document.createElement('div');
    element.style.width='100%';
    element.style.height='100%';
    host.replaceChildren(element);
    void loadYouTube().then(YT=>{
      if(gone)return;
      try {
        const next=new YT.Player(element,{
          width:'100%',height:'100%',
          playerVars:{playsinline:1,controls:1,rel:0,origin:window.location.origin,enablejsapi:1},
          events:{
            onReady:()=>{
              if(gone)return;
              setPlayerReady(true);
              const state=latestMusic.current;
              const seconds=timeAt(state.position,state.updatedAt,state.playing);
              try {
                if(mediaId.startsWith('list:')) next.cuePlaylist({list:mediaId.slice(5),listType:'playlist',startSeconds:seconds});
                else next.cueVideoById(mediaId,seconds);
              } catch {setPlayerError('Could not cue video. Use the direct video link.');}
            },
            onError:(event)=>{
              if(gone)return;
              const reason=event.data===101||event.data===150?'This video blocks embedding.':event.data===100?'Video is unavailable.':'Video playback failed.';
              setPlayerError(reason+' You can open it on YouTube.');
              setFallback(true);
            },
            onAutoplayBlocked:()=>{
              if(!gone)setPlayerError('Autoplay blocked. Tap Play here or use the controls in the video.');
            },
            onStateChange:(event)=>{
              if(gone||!isHostRef.current||Date.now()<suppress.current) return;
              if(event.data===1&&!playingRef.current) emit('play');
              if(event.data===2&&playingRef.current) emit('pause');
            },
          },
        });
        api.current=next;
      } catch {
        if(!gone){setFallback(true);setPlayerError('Interactive player failed. Use the built-in video player below.');}
      }
    }).catch(()=>{
      if(!gone){setFallback(true);setPlayerError('YouTube API unavailable. Use the built-in video player below.');}
    });
    return()=>{
      gone=true;
      setPlayerReady(false);
      try{api.current?.destroy();}catch{}
      api.current=null;
      host.replaceChildren();
    };
  },[trackId,mediaId,isYouTube,expanded,emit]);

  // Script loading may succeed while an embedded video itself never becomes
  // ready (blocked privacy extensions, provider errors, or restricted networks).
  // Never strand the user on a perpetual spinner.
  useEffect(() => {
    if (!isYouTube || playerReady || fallback || !expanded) return;
    const timeout = window.setTimeout(() => {
      setFallback(true);
      setPlayerError('Embedded player timed out. Try the fallback or open YouTube.');
    }, 11000);
    return () => window.clearTimeout(timeout);
  }, [isYouTube, playerReady, fallback, expanded, trackId]);

  // Apply authoritative track position on track changes and host commands, not
  // on every rendering frame. Do not issue autoplay repeatedly.
  useEffect(()=>{
    const player=api.current;
    if(!player||!playerReady||!isYouTube||!mediaId)return;
    const current=timeAt(music.position,music.updatedAt,music.playing);
    try {
      suppress.current=Date.now()+950;
      if(Math.abs(player.getCurrentTime()-current)>4) player.seekTo(current,true);
      if(!music.playing) player.pauseVideo();
      // Playback is not forced here: browsers require a fresh local click.
    }catch{}
  },[music.current,music.updatedAt,music.position,music.playing,playerReady,isYouTube,mediaId]);

  const playLocal=(play:boolean)=>{
    const player=api.current;
    if(!player||!playerReady){
      setPlayerError('Player is still loading. Use the video controls or open the video directly.');
      return;
    }
    try {
      suppress.current=Date.now()+700;
      if(play)player.playVideo();else player.pauseVideo();
      setPlayerError('');
    }catch {setPlayerError('Playback failed here. Try the video controls or open YouTube.');}
  };

  const hostAction=(action:'play'|'pause'|'next')=>{
    if(track?.provider==='youtube' && action==='play')playLocal(true);
    else if(track?.provider==='youtube' && action==='pause')playLocal(false);
    emit(action);
  };
  const add=(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault();
    const parsed=parseMusicLink(url);
    if(!parsed){setError('Paste a valid YouTube video/playlist or Spotify track, album or playlist link.');return;}
    if(music.queue.length>=40){setError('Queue is full (40 tracks).');return;}
    setError('');
    setPending('add');
    session.send({t:'music',action:'add',track:{
      id:'',provider:parsed.provider,mediaId:parsed.mediaId,
      title:title.trim().slice(0,90)||(parsed.provider==='spotify'?'Spotify selection':'YouTube selection'),addedBy:'',
    }});
    session.flush();
    setUrl('');setTitle('');
    setExpanded(true);
  };

  const spotify=track?.provider==='spotify'?track.mediaId.split(':'):null;
  const input='min-h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--surface-inset)] px-3 text-xs outline-none focus:border-[var(--accent)]';
  return <details open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}
    className="min-w-0 border-b border-[var(--line)] px-3 py-2">
    <summary className="cursor-pointer text-sm font-semibold">Jukebox · {music.queue.length} queued {pending&&<span className="ml-1 text-2xs font-normal text-[var(--fg-muted)]">Syncing…</span>}</summary>
    <div className="mt-3 min-w-0 space-y-3">
      {track ? <section className="min-w-0 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-inset)]">
        <div className="flex min-w-0 items-center justify-between gap-2 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold">{track.title}</p>
            <p className="truncate text-2xs text-[var(--fg-muted)]">{track.provider==='youtube'?'YouTube':'Spotify'} · {track.addedBy}</p>
          </div>
          {session.isHost&&<span className="shrink-0 text-2xs text-[var(--fg-muted)]">{music.playing?'Room playing':'Room paused'}</span>}
        </div>
        {isYouTube&&<>
          <div className="relative aspect-video min-h-44 w-full overflow-hidden bg-black">
            <div ref={wrapper} className={fallback?'hidden':'h-full w-full [&_iframe]:h-full [&_iframe]:w-full'}/>
            {fallback&&<iframe title="YouTube video (fallback player)" className="absolute inset-0 h-full w-full"
              src={mediaId?.startsWith('list:')
                ? 'https://www.youtube-nocookie.com/embed/videoseries?list='+encodeURIComponent(mediaId.slice(5))
                : 'https://www.youtube-nocookie.com/embed/'+encodeURIComponent(mediaId??'')+'?playsinline=1&controls=1'}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              referrerPolicy="strict-origin-when-cross-origin" allowFullScreen/>}
            {!playerReady&&!fallback&&<div className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-white/80">Loading YouTube player…</div>}
          </div>
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <button type="button" onClick={()=>playLocal(true)} disabled={!playerReady||fallback}
              className="min-h-9 rounded-lg bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--accent-fg)] disabled:opacity-50">Play here</button>
            <button type="button" onClick={()=>playLocal(false)} disabled={!playerReady||fallback}
              className="min-h-9 rounded-lg border border-[var(--line)] px-3 text-xs disabled:opacity-50">Pause here</button>
            <a target="_blank" rel="noopener noreferrer" href={youtubeHref(mediaId??'')}
              className="ml-auto text-xs underline underline-offset-2">Open on YouTube ↗</a>
          </div>
          {playerError&&<p role="alert" className="px-3 pb-2 text-xs text-amber-300">{playerError}</p>}
          <p className="px-3 pb-2 text-2xs text-[var(--fg-muted)]">Each listener may need to press Play locally. Some videos cannot be embedded.</p>
        </>}
        {spotify&&<>
          <iframe key={track.id} title={'Spotify: '+track.title} loading="eager"
            src={'https://open.spotify.com/embed/'+encodeURIComponent(spotify[0])+'/'+encodeURIComponent(spotify[1])}
            className="block h-[152px] w-full border-0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"/>
          <div className="flex items-center gap-2 px-3 py-2 text-xs">
            <a href={spotifyHref(track.mediaId)} target="_blank" rel="noopener noreferrer"
              className="underline underline-offset-2">Open in Spotify ↗</a>
            <span className="ml-auto text-2xs text-[var(--fg-muted)]">Play locally</span>
          </div>
        </>}
        {session.isHost&&<div className="flex gap-2 border-t border-[var(--line)] px-3 py-2">
          <button type="button" onClick={()=>hostAction(music.playing?'pause':'play')} className="min-h-9 rounded-lg border border-[var(--line)] px-3 text-xs">
            {music.playing?'Pause room':'Play room'}
          </button>
          <button type="button" onClick={()=>hostAction('next')} className="min-h-9 rounded-lg border border-[var(--line)] px-3 text-xs">Next track</button>
        </div>}
      </section>:<p className="text-xs text-[var(--fg-muted)]">Queue something to listen together.</p>}
      {music.queue.length>1&&<ol className="max-h-36 space-y-1 overflow-y-auto overscroll-contain">
        {music.queue.map((item,i)=><li key={item.id} className="flex min-w-0 items-center gap-2 rounded-lg bg-[var(--surface-inset)] px-2 py-1 text-xs">
          <span className="shrink-0 text-[var(--fg-subtle)]">{i+1}.</span>
          <span className={'min-w-0 flex-1 truncate '+(i===music.current?'font-semibold':'')}>{item.title}</span>
          {session.isHost&&<button type="button" onClick={()=>emit('select',i)} className="min-h-8 rounded px-2 hover:bg-[var(--surface-2)]">Play</button>}
          {session.isHost&&<button type="button" onClick={()=>emit('remove',i)} aria-label={'Remove '+item.title} className="min-h-8 rounded px-2 hover:bg-[var(--surface-2)]">×</button>}
        </li>)}
      </ol>}
      <details className="rounded-lg border border-[var(--line)] px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium">Add music</summary>
        <form onSubmit={add} className="mt-3 space-y-2">
          <input required className={input} value={url} onChange={e=>setUrl(e.target.value)}
            placeholder="Paste YouTube / Spotify URL" aria-label="Music URL" inputMode="url"/>
          <input className={input} value={title} onChange={e=>setTitle(e.target.value)}
            placeholder="Track title (optional)" aria-label="Track title"/>
          <button type="submit" className="min-h-10 rounded-lg bg-[var(--accent)] px-4 text-xs font-semibold text-[var(--accent-fg)]">Add to queue</button>
          {error&&<p role="alert" className="text-xs text-rose-400">{error}</p>}
        </form>
      </details>
    </div>
  </details>;
}
