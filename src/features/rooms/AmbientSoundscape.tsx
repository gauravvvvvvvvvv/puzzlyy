'use client';

import { useEffect, useRef, useState } from 'react';

type Scene = 'off' | 'rain' | 'ocean' | 'fireplace';

/** All audio is synthesized on-device. Playback only begins after a click. */
export function AmbientSoundscape() {
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
    const seconds = 6;
    const samples = Math.round(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, samples, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let low = 0;
    // Seamless-ish textured noise with a gentle changing envelope.
    for (let i = 0; i < samples; i++) {
      const t = i / ctx.sampleRate;
      const random = Math.random() * 2 - 1;
      low = low * .995 + random * .005;
      const wave = Math.sin(t * (scene === 'ocean' ? 0.36 : 1.8) * Math.PI * 2);
      data[i] = scene === 'ocean' ? low * (0.65 + .35 * wave) * 7 :
        scene === 'fireplace' ? (Math.abs(random) > .992 ? random * .48 : low * 2) :
        random * .14 + low * 1.2;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = scene === 'rain' ? 'highpass' : 'lowpass';
    filter.frequency.value = scene === 'rain' ? 230 : scene === 'ocean' ? 500 : 1100;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start();
    audio.current = { ctx, gain, source };
    return () => { source.stop(); void ctx.close(); if (audio.current?.ctx === ctx) audio.current = null; };
  }, [scene]);

  useEffect(() => { if (audio.current) audio.current.gain.gain.value = volume; }, [volume]);

  return <section className="border-t border-[var(--line)] px-3 py-3" aria-label="Ambient soundscapes">
    <p className="mb-2 text-xs font-medium text-[var(--fg)]">Ambient sounds <span className="font-normal text-[var(--fg-subtle)]">· only you hear these</span></p>
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Choose background ambience">
      {(['off','rain','ocean','fireplace'] as const).map(key =>
        <button type="button" key={key} aria-pressed={scene === key}
          onClick={() => setScene(key)}
          className={'min-h-9 rounded-lg border px-3 text-xs capitalize transition-colors active:scale-95 ' +
            (scene === key ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--line)] hover:bg-[var(--surface-inset)]')}>
          {key === 'off' ? 'Off' : key}
        </button>)}
    </div>
    {scene !== 'off' && <label className="mt-2 flex items-center gap-2 text-xs text-[var(--fg-muted)]">
      Volume
      <input type="range" aria-label="Ambient sound volume" min={0} max={1} step={.05}
        value={volume} onChange={e => setVolume(Number(e.target.value))}
        className="min-w-0 flex-1 accent-[var(--accent)]" />
    </label>}
  </section>;
}
