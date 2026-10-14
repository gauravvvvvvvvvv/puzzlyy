'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createRoom } from '@/lib/realtime/api';
import type { ImageAsset } from '@/types/models';
type Daily = {day:string;image:ImageAsset;seed:number};
export default function DailyPage() {
  const router=useRouter();
  const [daily,setDaily]=useState<Daily|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>{
    let live=true;
    void fetch('/api/daily').then(r=>r.json()).then((v:Daily)=>{if(live)setDaily(v);})
      .catch(()=>{if(live)setError('Could not load today’s puzzle.');});
    return ()=>{live=false;};
  },[]);
  const start=async()=>{
    if(!daily)return;
    setBusy(true);setError('');
    try {
      const room=await createRoom({image:daily.image,
        settings:{pieceCount:100,rotation:false,blindMode:false},
        daily:true,hostCanForceStart:true});
      router.push('/room/'+room.code+'?solo=1');
    } catch(e) {setError(e instanceof Error?e.message:'Could not start daily puzzle');setBusy(false);}
  };
  return <main className="mx-auto max-w-xl space-y-6 px-5 py-12">
    <p className="eyebrow">Daily puzzle · {daily?.day ?? 'Loading'}</p>
    <h1 className="text-3xl font-semibold">A fresh puzzle every day</h1>
    <p className="text-[var(--fg-muted)]">Same image and piece layout for everyone, refreshed at midnight UTC. Invite friends to the same room and compare your shared achievements.</p>
    {daily?.image && <div className="overflow-hidden rounded-2xl border border-[var(--line)]">
      <img src={daily.image.thumbUrl} alt={daily.image.title} className="aspect-[4/3] w-full object-cover" />
      <div className="p-4 text-lg font-semibold">{daily.image.title}</div>
    </div>}
    <button type="button" onClick={()=>void start()} disabled={busy||!daily}
      className="min-h-12 w-full rounded-xl bg-[var(--accent)] px-5 text-[var(--accent-fg)] transition hover:brightness-110 active:scale-95 disabled:opacity-50">
      {busy?'Preparing puzzle…':'Play today’s puzzle'}
    </button>
    {error&&<p role="alert" className="text-sm text-red-400">{error}</p>}
    <p className="text-xs text-[var(--fg-subtle)]">Share your room link for the friends scoreboard. No account is required.</p>
  </main>;
}
