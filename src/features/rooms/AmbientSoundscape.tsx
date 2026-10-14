'use client';

import { useEffect, useRef, useState } from 'react';
import { roomWorld } from '@/lib/theme/roomWorlds';

type Scene = 'off' | 'rain' | 'ocean' | 'fireplace' | 'wind' | 'birds' | 'stream' | 'thunder';
const OPTIONS: {id:Scene; label:string}[] = [
  {id:'off', label:'Off'}, {id:'rain',label:'Rain on a window'},
  {id:'ocean',label:'Ocean waves'}, {id:'fireplace',label:'Crackling fireplace'},
  {id:'wind',label:'Gentle wind'}, {id:'birds',label:'Morning birds'},
  {id:'stream',label:'Forest stream'}, {id:'thunder',label:'Thunderstorm'},
];

/** Real CC0 field-recording loops, downloaded into /public/ambience at build time. */
export function AmbientSoundscape({roomTheme}:{roomTheme?:string}) {
  const [scene, setScene] = useState<Scene>('off');
  const [volume, setVolume] = useState(.35);
  const [status, setStatus] = useState('');
  const player = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (player.current) player.current.volume = volume;
  }, [volume]);

  useEffect(() => () => { player.current?.pause(); }, []);

  function choose(next:Scene) {
    const audio = player.current;
    setScene(next);
    setStatus('');
    if (!audio) return;
    audio.pause();
    if (next === 'off') { audio.removeAttribute('src'); audio.load(); return; }
    audio.src = '/ambience/' + next + '.mp3';
    audio.volume = volume;
    // Call play directly in the click/change handler, not in an effect after the
    // user gesture. That distinction matters for browser autoplay restrictions.
    setStatus('Loading sound…');
    void audio.play().then(() => setStatus('')).catch(() =>
      setStatus('Playback blocked. Press Play to enable sound.'));
  }

  const suggested = roomWorld(roomTheme).sound as Scene;
  return <details className="border-b border-[var(--line)] px-3 py-2" aria-label="Ambient soundscapes">
    <summary className="cursor-pointer text-xs font-medium text-[var(--fg)]">
      Ambient · {OPTIONS.find(option => option.id === scene)?.label ?? 'Off'}
    </summary>
    <div className="mt-3 space-y-3">
      <label className="block text-xs text-[var(--fg-muted)]" htmlFor="ambient-scene">Soundscape</label>
      <select id="ambient-scene" value={scene} onChange={e => choose(e.target.value as Scene)}
        className="min-h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--surface-inset)] px-2 text-sm text-[var(--fg)]">
        {OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => choose(suggested)}
          className="rounded-lg border border-[var(--line)] px-3 py-2 text-xs">Use {roomWorld(roomTheme).name} ambience</button>
        {scene !== 'off' && <button type="button" onClick={() => {
          const audio = player.current;
          if (!audio) return;
          setStatus('Starting sound…');
          void audio.play().then(() => setStatus('')).catch(() => setStatus('Your browser blocked audio. Try again.'));
        }} className="rounded-lg border border-[var(--line)] px-3 py-2 text-xs">Play</button>}
      </div>
      {scene !== 'off' && <label className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
        Volume <input type="range" aria-label="Ambient volume" min="0" max="1" step=".05" value={volume}
          onChange={e => setVolume(Number(e.target.value))} className="min-w-0 flex-1 accent-[var(--accent)]" />
      </label>}
      {status && <p role="status" className="text-xs text-[var(--fg-muted)]">{status}</p>}
      <p className="text-2xs text-[var(--fg-subtle)]">Real CC0 field recordings. Your choice plays only for you.</p>
    </div>
    <audio ref={player} loop preload="none" onPlaying={() => setStatus('')}
      onError={() => setStatus('Sound failed to load. Try another sound or retry.')} />
  </details>;
}
