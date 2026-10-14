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
  getVideoData?():{title?:string};
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
  const [showVideo,setShowVideo]=useState(true);
  const [resolvedTitle,setResolvedTitle]=useState('');
  const wrapper=useRef<HTMLDivElement>(null);
  const api=useRef<YouTubePlayer|null>(null);
  const loadedTrack=useRef<string|null>(null);
  const isHostRef=useRef(session.isHost);
  const playingRef=useRef(music.playing);
  isHostRef.current=session.isHost;
  playingRef.current=music.playing;
  const sessionRef=useRef(session);
  sessionRef.current=session;
  const latestMusic=useRef(music);
  latestMusic.current=music;
  const suppress=useRef(0);

  const emit=useCallback((action:'play'|'pause'|'next'|'select'|'remove'|'clear'|'seek',index?:number)=>{
    setPending(action);
    sessionRef.current.send({t:'music',action,index});
    sessionRef.current.flush();
  },[]);

  useEffect(()=>{setPending('');},[music.updatedAt,music.current,music.playing,music.queue.length]);

  const isYouTube=track?.provider==='youtube';
  const trackId=track?.id;
  const mediaId=track?.mediaId;
  const playlist=!!mediaId&&(mediaId.startsWith('list:')||mediaId.startsWith('playlist:')||mediaId.startsWith('album:'));
  const shownTitle=resolvedTitle&&track?.title==='YouTube selection'?resolvedTitle:track?.title;

  // Keep ONE YouTube iframe/player mounted across queue changes, video
  // minimization and jukebox collapse. Recreating it kills playback and
  // loses the browser gesture that enabled subsequent tracks to play.
  useEffect(()=>{
    if(!isYouTube||!wrapper.current)return;
    let gone=false;
    setPlayerReady(false);
    setPlayerError('');
    setFallback(false);
    loadedTrack.current=null;
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
            onReady:()=>{if(!gone)setPlayerReady(true);},
            onError:(event)=>{
              if(gone)return;
              const reason=event.data===101||event.data===150?'This video blocks embedding.':event.data===100?'Video is unavailable.':'Video playback failed.';
              setPlayerError(reason+' Open it on YouTube to listen.');
              setFallback(true);
            },
            onAutoplayBlocked:()=>{
              if(!gone)setPlayerError('Autoplay blocked. Press Play here or tap the video player.');
            },
            onStateChange:(event)=>{
              if(gone)return;
              if(event.data===1) {
                try {const name=next.getVideoData?.().title;if(name)setResolvedTitle(name);}catch{}
              }
              if(!isHostRef.current||Date.now()<suppress.current)return;
              if(event.data===0) {
                // Advance the shared queue when a video or full playlist finishes.
                if(latestMusic.current.queue.length>1)emit('next');
                else emit('pause');
              } else if(event.data===1&&!playingRef.current)emit('play');
              else if(event.data===2&&playingRef.current)emit('pause');
            },
          },
        });
        api.current=next;
      } catch {
        if(!gone){setFallback(true);setPlayerError('YouTube player failed to initialize. Use the fallback player.');}
      }
    }).catch(()=>{
      if(!gone){setFallback(true);setPlayerError('YouTube API unavailable. Use the fallback player.');}
    });
    return()=>{
      gone=true;
      loadedTrack.current=null;
      try{api.current?.destroy();}catch{}
      api.current=null;
      host.replaceChildren();
    };
  },[isYouTube,emit]);

  // The player stays mounted when switching songs. Loading the next ID into
  // the existing player supports continuous queue/playlist playback.
  useEffect(()=>{
    const player=api.current;
    if(!isYouTube||!player||!playerReady||!trackId||!mediaId||loadedTrack.current===trackId)return;
    const seconds=timeAt(music.position,music.updatedAt,music.playing);
    loadedTrack.current=trackId;
    suppress.current=Date.now()+1200;
    setResolvedTitle('');
    setFallback(false);
    setPlayerError('');
    try {
      if(mediaId.startsWith('list:')) {
        const options={list:mediaId.slice(5),listType:'playlist',startSeconds:seconds};
        if(music.playing)player.loadPlaylist(options);
        else player.cuePlaylist(options);
      } else if(music.playing)player.loadVideoById(mediaId,seconds);
      else player.cueVideoById(mediaId,seconds);
    } catch {
      loadedTrack.current=null;
      setPlayerError('Could not load this selection. Open it on YouTube instead.');
      setFallback(true);
    }
  },[isYouTube,playerReady,trackId,mediaId,music.position,music.updatedAt,music.playing]);

  useEffect(()=>{
    if(!isYouTube||playerReady||fallback)return;
    const timeout=window.setTimeout(()=>{
      setFallback(true);
      setPlayerError('YouTube player timed out. Try the fallback or open YouTube.');
    },11000);
    return()=>window.clearTimeout(timeout);
  },[isYouTube,playerReady,fallback,trackId]);

  // Sync room commands without forcing autoplay after every network update.
  useEffect(()=>{
    const player=api.current;
    if(!player||!playerReady||!isYouTube||!trackId||loadedTrack.current!==trackId||fallback)return;
    const current=timeAt(music.position,music.updatedAt,music.playing);
    try {
      suppress.current=Date.now()+950;
      if(Math.abs(player.getCurrentTime()-current)>4)player.seekTo(current,true);
      if(!music.playing)player.pauseVideo();
    }catch{}
  },[music.current,music.updatedAt,music.position,music.playing,playerReady,isYouTube,trackId,fallback]);

  const playLocal=(play:boolean)=>{
    const player=api.current;
    if(!player||!playerReady||fallback){
      setPlayerError('Player is unavailable. Try the provider controls or open the selection directly.');
      return;
    }
    try {
      suppress.current=Date.now()+700;
      if(play)player.playVideo();else player.pauseVideo();
      setPlayerError('');
    }catch{setPlayerError('Playback failed. Use the video controls or open YouTube.');}
  };

  const hostAction=(action:'play'|'pause'|'next')=>{
    if(isYouTube&&action==='play')playLocal(true);
    else if(isYouTube&&action==='pause')playLocal(false);
    emit(action);
  };
  const add=(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault();
    const parsed=parseMusicLink(url);
    if(!parsed){setError('Paste a valid YouTube video/playlist or Spotify track, album or playlist link.');return;}
    if(music.queue.length>=40){setError('Queue is full (40 entries).');return;}
    setError('');
    setPending('add');
    session.send({t:'music',action:'add',track:{
      id:'',provider:parsed.provider,mediaId:parsed.mediaId,
      title:title.trim().slice(0,90)||(parsed.provider==='spotify'?'Spotify selection':'YouTube selection'),addedBy:'',
    }});
    session.flush();
    setUrl('');
    setTitle('');
    setExpanded(true);
  };

  const spotify=track?.provider==='spotify'?track.mediaId.split(':'):null;
  const input='min-h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--surface-inset)] px-3 text-xs outline-none focus:border-[var(--accent)]';
  const playerDock=showVideo
    ? 'min-w-0 border-t border-[var(--line)]'
    : 'fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-3 z-[65] w-[min(92vw,280px)] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-2xl';
  return <section className="min-w-0 border-b border-[var(--line)] px-3 py-2">
    <button type="button" aria-expanded={expanded} aria-controls="jukebox-controls"
      onClick={()=>setExpanded(value=>!value)}
      className="flex min-h-9 w-full min-w-0 items-center justify-between gap-2 text-left text-sm font-semibold">
      <span className="truncate">Jukebox · {music.queue.length} queued {pending&&<span className="text-2xs font-normal text-[var(--fg-muted)]">Syncing…</span>}</span>
      <span aria-hidden="true">{expanded?'▾':'▸'}</span>
    </button>
    {track&&<section className="mt-2 min-w-0 overflow-visible rounded-xl border border-[var(--line)] bg-[var(--surface-inset)]">
      <div className="flex min-w-0 items-center justify-between gap-2 p-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold" title={shownTitle}>{shownTitle}</p>
          <p className="truncate text-2xs text-[var(--fg-muted)]">
            {track.provider==='youtube'?'YouTube':'Spotify'} · {playlist?'Playlist / album · ':''}{track.addedBy}
          </p>
        </div>
        {session.isHost&&<span className="shrink-0 text-2xs text-[var(--fg-muted)]">{music.playing?'Room playing':'Room paused'}</span>}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-[var(--line)] px-3 py-2">
        <button type="button" onClick={()=>setShowVideo(value=>!value)}
          aria-label={showVideo?'Minimize video to a floating player':'Return player to jukebox'}
          className="min-h-9 rounded-lg border border-[var(--line)] px-3 text-xs hover:bg-[var(--surface-2)]">
          {showVideo?'Minimize player':'Expand player'}
        </button>
        {session.isHost&&<button type="button" onClick={()=>emit('remove',music.current)}
          className="min-h-9 rounded-lg border border-[var(--line)] px-3 text-xs text-[var(--color-danger-400)] hover:bg-[var(--surface-2)]">
          Remove {playlist?'playlist':'song'}
        </button>}
      </div>
      {isYouTube&&<div className={playerDock}>
        {!showVideo&&<div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
          <span className="min-w-0 truncate font-semibold">{shownTitle}</span>
          <button type="button" onClick={()=>setShowVideo(true)} aria-label="Expand YouTube player"
            className="shrink-0 rounded px-2 py-1 underline underline-offset-2">Expand</button>
        </div>}
        <div className={'relative w-full overflow-hidden bg-black '+(showVideo?'aspect-video min-h-[200px]':'h-[200px]')}>
          <div ref={wrapper} className={fallback?'hidden':'h-full w-full [&_iframe]:h-full [&_iframe]:w-full'}/>
          {fallback&&<iframe title="YouTube fallback player" className="absolute inset-0 h-full w-full"
            src={mediaId?.startsWith('list:')
              ? 'https://www.youtube-nocookie.com/embed/videoseries?list='+encodeURIComponent(mediaId.slice(5))
              : 'https://www.youtube-nocookie.com/embed/'+encodeURIComponent(mediaId??'')+'?playsinline=1&controls=1'}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin" allowFullScreen/>}
          {!playerReady&&!fallback&&<div className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-white/80">Loading YouTube…</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2 px-2 py-2">
          <button type="button" onClick={()=>playLocal(true)} disabled={!playerReady||fallback}
            className="min-h-9 rounded-lg bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--accent-fg)] disabled:opacity-50">Play here</button>
          <button type="button" onClick={()=>playLocal(false)} disabled={!playerReady||fallback}
            className="min-h-9 rounded-lg border border-[var(--line)] px-3 text-xs disabled:opacity-50">Pause</button>
          <a target="_blank" rel="noopener noreferrer" href={youtubeHref(mediaId??'')}
            className="ml-auto text-xs underline underline-offset-2">YouTube ↗</a>
        </div>
        {playerError&&<p role="alert" className="px-3 pb-2 text-xs text-amber-300">{playerError}</p>}
      </div>}
      {spotify&&<div className={playerDock}>
        {!showVideo&&<div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
          <span className="min-w-0 truncate font-semibold">{shownTitle}</span>
          <button type="button" onClick={()=>setShowVideo(true)} aria-label="Expand Spotify player"
            className="shrink-0 rounded px-2 py-1 underline underline-offset-2">Expand</button>
        </div>}
        <iframe key={track.id} title={'Spotify: '+track.title} loading="eager"
          src={'https://open.spotify.com/embed/'+encodeURIComponent(spotify[0])+'/'+encodeURIComponent(spotify[1])}
          className="block h-[152px] w-full border-0"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"/>
        <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
          <span className="text-[var(--fg-muted)]">Play through Spotify</span>
          <a href={spotifyHref(track.mediaId)} target="_blank" rel="noopener noreferrer"
            className="underline underline-offset-2">Open ↗</a>
        </div>
      </div>}
      {session.isHost&&<div className="flex flex-wrap gap-2 border-t border-[var(--line)] px-3 py-2">
        <button type="button" onClick={()=>hostAction(music.playing?'pause':'play')}
          className="min-h-9 rounded-lg border border-[var(--line)] px-3 text-xs">{music.playing?'Pause room':'Play room'}</button>
        <button type="button" onClick={()=>hostAction('next')}
          className="min-h-9 rounded-lg border border-[var(--line)] px-3 text-xs">Next track</button>
      </div>}
    </section>}
    {expanded&&<div id="jukebox-controls" className="mt-3 min-w-0 space-y-3">
      {music.queue.length>0&&<div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">Up next · {music.queue.length} entries</span>
        {session.isHost&&<button type="button" onClick={()=>emit('clear')}
          className="min-h-9 rounded-lg border border-[var(--line)] px-3 text-xs text-[var(--color-danger-400)] hover:bg-[var(--surface-2)]">Clear queue</button>}
      </div>}
      {music.queue.length>0&&<ol className="max-h-48 space-y-1 overflow-y-auto overscroll-contain">
        {music.queue.map((item,i)=>{
          const isList=item.mediaId.startsWith('list:')||item.mediaId.startsWith('playlist:')||item.mediaId.startsWith('album:');
          return <li key={item.id} className="flex min-w-0 items-center gap-2 rounded-lg bg-[var(--surface-inset)] px-2 py-1.5 text-xs">
            <span className="shrink-0 text-[var(--fg-subtle)]">{i+1}.</span>
            <span className={'min-w-0 flex-1 truncate '+(i===music.current?'font-semibold':'')} title={item.title}>
              {i===music.current&&resolvedTitle&&item.title==='YouTube selection'?resolvedTitle:item.title}
              <span className="ml-1 text-2xs font-normal text-[var(--fg-muted)]">· {isList?'Playlist':'Song'}</span>
            </span>
            {session.isHost&&<button type="button" onClick={()=>emit('select',i)} disabled={i===music.current}
              aria-label={'Play '+item.title} className="min-h-9 rounded px-2 hover:bg-[var(--surface-2)] disabled:opacity-40">Play</button>}
            {session.isHost&&<button type="button" onClick={()=>emit('remove',i)}
              aria-label={'Remove '+(isList?'playlist ':'song ')+item.title}
              className="min-h-9 rounded border border-[var(--line)] px-2 hover:bg-[var(--surface-2)]">Remove</button>}
          </li>;
        })}
      </ol>}
      {!track&&<p className="text-xs text-[var(--fg-muted)]">Add a song or playlist to start listening together.</p>}
      <details className="rounded-lg border border-[var(--line)] px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium">Add music</summary>
        <form onSubmit={add} className="mt-3 space-y-2">
          <input required className={input} value={url} onChange={e=>setUrl(e.target.value)}
            placeholder="Paste YouTube / Spotify URL" aria-label="Music URL" inputMode="url"/>
          <input className={input} value={title} onChange={e=>setTitle(e.target.value)}
            placeholder="Song or playlist title (optional)" aria-label="Music title"/>
          <button type="submit" className="min-h-10 rounded-lg bg-[var(--accent)] px-4 text-xs font-semibold text-[var(--accent-fg)]">Add to queue</button>
          {error&&<p role="alert" className="text-xs text-rose-400">{error}</p>}
        </form>
      </details>
      <p className="text-2xs text-[var(--fg-muted)]">Playback stays active when the queue closes or the player is minimized. YouTube requires a visible mini-player; Spotify needs a local play action and Premium authentication for a fully custom player.</p>
    </div>}
  </section>;
}
