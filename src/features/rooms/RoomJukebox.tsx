'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RoomSession } from '@/hooks/useRoomSession';
import type { MusicTrack } from '@/types/models';

/**
 * The queue, timestamps, and playback intention are room-authoritative.
 * YouTube uses its public iframe player API for synchronized seeking.
 * Spotify's official embeds cannot be commanded to seek/play, so its playlist
 * is shared but its playback must be started manually on each device.
 */
function parseMusicLink(input: string): Pick<MusicTrack, 'provider' | 'mediaId'> | null {
  try {
    const u = new URL(input.trim());
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1);
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? {provider:'youtube', mediaId:id} : null;
    }
    if (['www.youtube.com','youtube.com','m.youtube.com','music.youtube.com'].includes(u.hostname)) {
      const playlist = u.searchParams.get('list');
      if (playlist && /^[A-Za-z0-9_-]{10,50}$/.test(playlist)) {
        return {provider:'youtube', mediaId:'list:'+playlist};
      }
      const id = u.searchParams.get('v') ?? u.pathname.split('/').filter(Boolean).pop();
      return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? {provider:'youtube', mediaId:id} : null;
    }
    if (u.hostname === 'open.spotify.com') {
      const pieces = u.pathname.split('/').filter(Boolean);
      const id = pieces[pieces.length-1];
      if (['track','playlist','album'].includes(pieces[pieces.length-2]) && /^[a-zA-Z0-9]{22}$/.test(id)) {
        return {provider:'spotify', mediaId:pieces[pieces.length-2]+':'+id};
      }
    }
  } catch { /* not a supported URL */ }
  return null;
}

type YouTubePlayer = {
  loadVideoById(id: string, start?: number): void;
  cueVideoById(id: string, start?: number): void;
  loadPlaylist(options: {list: string; listType: string; index?: number; startSeconds?: number}): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  destroy(): void;
  getCurrentTime(): number;
};
type YoutubeAPI = {Player: new (element: HTMLElement, config: {
  height: string; width: string;
  playerVars: Record<string,string | number>;
  events: {onReady: () => void};
}) => YouTubePlayer};
declare global { interface Window {YT?: YoutubeAPI; onYouTubeIframeAPIReady?: () => void} }

let playerApi: Promise<YoutubeAPI> | null = null;
function youtubeAPI(): Promise<YoutubeAPI> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Browser only'));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!playerApi) {
    playerApi = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        if (window.YT) resolve(window.YT);
        else reject(new Error('YouTube playback unavailable'));
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => { playerApi = null; reject(new Error('YouTube could not load')); };
      document.head.appendChild(script);
    });
  }
  return playerApi;
}

export function RoomJukebox({session}: {session: RoomSession}) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [listening, setListening] = useState(false);
  const [playerReady, setPlayerReady] = useState(0);
  const [error, setError] = useState('');
  const playerHost = useRef<HTMLDivElement>(null);
  const player = useRef<YouTubePlayer | null>(null);
  const trackKey = useRef('');
  const listeningRef = useRef(false);
  listeningRef.current = listening;
  const music = session.music;
  const track = music.queue[music.current] ?? null;
  const serverSeconds = Math.max(0, music.position +
    (music.playing ? (Date.now() - music.updatedAt) / 1000 : 0));
  const isYoutube = track?.provider === 'youtube';
  const enabled = listening && isYoutube;
  const mediaId = track?.mediaId ?? '';

  useEffect(() => {
    if (!enabled || !playerHost.current) return;
    let cancelled = false;
    void youtubeAPI().then(YT => {
      if (cancelled || !playerHost.current || player.current) return;
      player.current = new YT.Player(playerHost.current, {
        height: '96', width: '160',
        playerVars: {playsinline:1, controls:1, rel:0, origin:window.location.origin},
        events: {onReady: () => {
          if (!cancelled) { setError(''); setPlayerReady(n => n + 1); }
        }},
      });
    }).catch(e => setError(e instanceof Error ? e.message : 'Cannot load YouTube'));
    return () => { cancelled = true; };
  }, [enabled]);

  useEffect(() => {
    const api = player.current;
    if (!api || !enabled || !track) return;
    const key = track.id;
    if (key !== trackKey.current) {
      trackKey.current = key;
      try {
        if (track.mediaId.startsWith('list:')) {
          api.loadPlaylist({list: track.mediaId.slice(5), listType:'playlist', startSeconds:serverSeconds});
        } else if (music.playing) api.loadVideoById(track.mediaId, serverSeconds);
        else api.cueVideoById(track.mediaId, serverSeconds);
      } catch { /* player might still be initializing; retry on sync */ }
    }
    try {
      if (Math.abs(api.getCurrentTime() - serverSeconds) > 2.5) api.seekTo(serverSeconds, true);
      if (music.playing) api.playVideo();
      else api.pauseVideo();
    } catch { /* player API not ready */ }
  }, [enabled, track, music, serverSeconds, playerReady]);

  useEffect(() => {
    if (enabled) return;
    if (player.current) { try { player.current.destroy(); } catch {} player.current = null; }
    trackKey.current = '';
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      const api = player.current;
      if (!api || !listeningRef.current) return;
      const seconds = Math.max(0,music.position + (music.playing ? (Date.now()-music.updatedAt)/1000 : 0));
      try { if (Math.abs(api.getCurrentTime()-seconds) > 3) api.seekTo(seconds,true); } catch { /* awaiting player */ }
    }, 4000);
    return () => clearInterval(id);
  }, [enabled,music]);

  const emit = (action: 'play'|'pause'|'next'|'select'|'remove'|'seek', index?:number) => {
    session.send({t:'music',action,index});
    session.flush();
  };
  const add = () => {
    const parsed = parseMusicLink(url);
    if (!parsed) { setError('Paste a Spotify track/playlist/album or YouTube video/playlist link.'); return; }
    setError('');
    session.send({t:'music',action:'add',track:{
      id:'',provider:parsed.provider,mediaId:parsed.mediaId,
      title:title.trim().slice(0,90) || (parsed.provider === 'spotify' ? 'Spotify selection' : 'YouTube selection'),
      addedBy:''
    }});
    session.flush();
    setUrl('');
    setTitle('');
  };
  const spotify = track?.provider === 'spotify' ? track.mediaId.split(':') : null;
  return (
    <details className="border-b border-[var(--line)] px-3 py-3">
      <summary className="cursor-pointer text-sm font-medium">Shared jukebox · {music.queue.length} queued</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs leading-relaxed text-[var(--fg-muted)]">Add a YouTube video or playlist, or a Spotify track or playlist. The host manages the queue. YouTube playback syncs across listeners; Spotify embeds require each listener to press play because Spotify does not expose synchronized controls.</p>
        <input className="w-full rounded-lg border border-[var(--line)] bg-[var(--surface-inset)] p-2 text-xs"
          value={url} onChange={e=>setUrl(e.target.value)} placeholder="Spotify / YouTube URL" aria-label="Music link"/>
        <input className="w-full rounded-lg border border-[var(--line)] bg-[var(--surface-inset)] p-2 text-xs"
          value={title} onChange={e=>setTitle(e.target.value)} placeholder="Title (optional)" aria-label="Track title"/>
        <button type="button" onClick={add} className="min-h-10 rounded-lg bg-[var(--accent)] px-4 text-xs font-semibold text-[var(--accent-fg)] transition active:scale-95">Add to queue</button>
        {error && <p role="alert" className="text-xs text-rose-400">{error}</p>}
        {track && <div className="space-y-2 rounded-xl bg-[var(--surface-inset)] p-2">
          <p className="truncate text-xs font-semibold">{track.title}</p>
          <p className="text-[11px] text-[var(--fg-muted)]">{track.provider === 'youtube' ? 'YouTube' : 'Spotify'} · {track.addedBy}</p>
          <button type="button" onClick={()=>setListening(v=>!v)}
            className="min-h-10 rounded-lg border border-[var(--line)] px-3 text-xs transition hover:bg-[var(--surface-2)] active:scale-95">
            {listening ? 'Stop listening' : 'Listen together'}
          </button>
          {enabled && <div className="min-h-24" ref={playerHost} />}
          {listening && spotify && <iframe title="Spotify playlist" loading="lazy" allow="autoplay; encrypted-media; fullscreen"
            className="w-full rounded-lg" height="152"
            src={'https://open.spotify.com/embed/'+spotify[0]+'/'+spotify[1]} />}
          {session.isHost && <div className="flex flex-wrap gap-2">
            <button className="rounded-lg border px-3 py-2 text-xs" onClick={()=>emit(music.playing?'pause':'play')}>
              {music.playing?'Pause':'Play'}
            </button>
            <button className="rounded-lg border px-3 py-2 text-xs" onClick={()=>emit('next')}>Next</button>
          </div>}
        </div>}
        <ol className="max-h-40 space-y-1 overflow-y-auto">
          {music.queue.map((item,i)=><li key={item.id} className="flex items-center gap-2 rounded-lg p-1 text-xs">
            <span className="w-4 text-[var(--fg-subtle)]">{i+1}</span>
            <span className={'min-w-0 flex-1 truncate '+(i===music.current?'font-semibold':'')}>{item.title}</span>
            {session.isHost && <button type="button" onClick={()=>emit('select',i)} className="rounded px-2 py-1 hover:bg-[var(--surface-inset)]">Select</button>}
            {session.isHost && <button type="button" onClick={()=>emit('remove',i)} aria-label={'Remove '+item.title} className="rounded px-2 py-1 hover:bg-[var(--surface-inset)]">×</button>}
          </li>)}
        </ol>
      </div>
    </details>
  );
}
