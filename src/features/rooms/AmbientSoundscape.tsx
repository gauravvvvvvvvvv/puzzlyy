'use client';

import { useEffect, useRef, useState } from 'react';

import { roomWorld } from '@/lib/theme/roomWorlds';
type Scene = 'off' | 'rain' | 'ocean' | 'fireplace' | 'synth';

/** All audio is synthesized on-device. Playback only begins after a click. */
export function AmbientSoundscape({roomTheme}:{roomTheme?:string}) {
  const [scene, setScene] = useState<Scene>('off');
  const [volume, setVolume] = useState(.22);
  const audio = useRef<{ ctx: AudioContext; gain: GainNode; source: AudioBufferSourceNode } | null>(null);

  useEffect(() => {
    const old = audio.current;
    if (old) {
      old.source.stop();
      void old.ctx.close();
      audio.current = null;
    }
    if (scene === 'off') return;
    if (typeof AudioContext === 'undefined') return;
    const ctx = new AudioContext();
    // Distinct acoustic textures: surf swells, ember pops, rain droplets,
    // or a warm electronic drone. Avoid recycling the same noise for all scenes.
    const seconds = 12;
    const samples = Math.round(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, samples, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let brown = 0;
    let previous = 0;
    const pops = new Float32Array(samples);
    if (scene === 'fireplace' || scene === 'rain') {
      const density = scene === 'fireplace' ? 22 : 220;
      for (let n = 0; n < seconds * density; n++) {
        const at = Math.floor(Math.random() * samples);
        const duration = Math.round(ctx.sampleRate * (scene === 'fireplace' ? .014 : .006));
        const strength = scene === 'fireplace' ? .25 : .055;
        for (let j = 0; j < duration && at + j < samples; j++) {
          pops[at + j] += (Math.random() * 2 - 1) * strength * Math.exp(-j / (duration * .23));
        }
      }
    }
    for (let i = 0; i < samples; i++) {
      const t = i / ctx.sampleRate;
      const white = Math.random() * 2 - 1;
      brown = (brown + .024 * white) / 1.024;
      const surf = Math.pow(.5 + .5 * Math.sin(2 * Math.PI * t / 6), 2);
      if (scene === 'ocean') {
        data[i] = (brown * 2 + white * .11) * (.12 + .88 * surf);
      } else if (scene === 'fireplace') {
        data[i] = brown * .22 + pops[i];
      } else if (scene === 'rain') {
        previous = previous * .83 + white * .17;
        data[i] = (white - previous) * .085 + pops[i];
      } else {
        // Slow, beating analog-style chord with no sharp synthetic hiss.
        const chords = [110, 164.81, 220, 329.63];
        data[i] = chords.reduce((sum, f, n) =>
          sum + Math.sin(2 * Math.PI * f * t + .11 * Math.sin(t * (.6 + n * .09))) * (.07 / (n + 1)), 0);
      }
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = scene === 'rain' ? 'highpass' : 'lowpass';
    filter.frequency.value = scene === 'rain' ? 420 : scene === 'ocean' ? 850 : scene === 'fireplace' ? 2100 : 1800;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start();
    void ctx.resume();
    audio.current = { ctx, gain, source };
    return () => { source.stop(); void ctx.close(); if (audio.current?.ctx === ctx) audio.current = null; };
  }, [scene]);

  useEffect(() => { if (audio.current) audio.current.gain.gain.value = volume; }, [volume]);

  const suggested = roomWorld(roomTheme).sound as Scene;
  return <section className="border-t border-[var(--line)] px-3 py-3" aria-label="Ambient soundscapes">
    <p className="mb-2 text-xs font-medium text-[var(--fg)]">Ambient sounds <span className="font-normal text-[var(--fg-subtle)]">· only you hear these</span></p>
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Choose background ambience">
      {(['off','rain','ocean','fireplace','synth'] as const).map(key =>
        <button type="button" key={key} aria-pressed={scene === key}
          onClick={() => setScene(key)}
          className={'min-h-9 rounded-lg border px-3 text-xs capitalize transition-colors active:scale-95 ' +
            (scene === key ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--line)] hover:bg-[var(--surface-inset)]')}>
          {key === 'off' ? 'Off' : key}
        </button>)}
    </div>
    <button type="button" className="mt-2 text-xs underline underline-offset-2 text-[var(--fg-muted)]" onClick={() => setScene(suggested)}>Try {roomWorld(roomTheme).name} ambience ({suggested})</button>
    {scene !== 'off' && <label className="mt-2 flex items-center gap-2 text-xs text-[var(--fg-muted)]">
      Volume
      <input type="range" aria-label="Ambient sound volume" min={0} max={1} step={.05}
        value={volume} onChange={e => setVolume(Number(e.target.value))}
        className="min-w-0 flex-1 accent-[var(--accent)]" />
    </label>}
  </section>;
}
