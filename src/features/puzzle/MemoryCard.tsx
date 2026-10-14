'use client';

import { useState } from 'react';
import type { SessionResult, RoomAchievement, RoomMoment } from '@/types/models';
import { formatDuration } from '@/lib/format';

/** Private, on-device image export. No screenshot upload or paid service. */
export function MemoryCard({result, achievements, moments}: {
  result:SessionResult; achievements:RoomAchievement[]; moments:RoomMoment[];
}) {
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const save = async () => {
    setBusy(true);setError('');
    try {
      const canvas = document.createElement('canvas');
      canvas.width=1200;canvas.height=800;
      const ctx=canvas.getContext('2d');
      if(!ctx) throw new Error('Canvas is unavailable.');
      const bg = ctx.createLinearGradient(0,0,1200,800);
      bg.addColorStop(0,'#1e1a2d');bg.addColorStop(1,'#40233e');
      ctx.fillStyle=bg;ctx.fillRect(0,0,1200,800);
      ctx.fillStyle='#ffab7e';ctx.font='700 34px sans-serif';
      ctx.fillText('PUZZLY · OUR PUZZLE MEMORY',70,85);
      ctx.fillStyle='#fff5ef';ctx.font='700 68px sans-serif';
      const title = result.puzzleTitle.length>28?result.puzzleTitle.slice(0,27)+'…':result.puzzleTitle;
      ctx.fillText(title,70,175);
      ctx.font='26px sans-serif';ctx.fillStyle='#efd9d0';
      ctx.fillText(formatDuration(result.durationMs)+' together · '+result.pieceCount+' pieces',70,227);
      const image = new Image();
      image.crossOrigin='anonymous';
      image.src=result.imageUrl;
      await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('Could not load this puzzle image.'));});
      const x=70,y=267,w=600,h=425,aspect=image.width/image.height;
      const iw=aspect>w/h?w:h*aspect,ih=aspect>w/h?w/aspect:h;
      ctx.save();ctx.beginPath();ctx.roundRect(x,y,w,h,20);ctx.clip();
      ctx.drawImage(image,x-(iw-w)/2,y-(ih-h)/2,iw,ih);ctx.restore();
      ctx.font='700 25px sans-serif';ctx.fillStyle='#ffbc92';ctx.fillText('THE CREW',715,305);
      ctx.font='23px sans-serif';ctx.fillStyle='#f7eeed';
      result.players.slice(0,6).forEach((p,i)=>ctx.fillText(p.name.slice(0,23)+' · '+p.connections+' connections',715,355+i*52));
      const badges=achievements.filter(a=>result.players.some(p=>p.id===a.playerId))
        .slice(-3).map(a=>a.name).join(' · ');
      ctx.font='17px sans-serif';ctx.fillStyle='#d4b6c4';
      ctx.fillText((badges || moments.slice(-2).map(m=>m.label).join(' · ')).slice(0,48),70,738);
      ctx.fillText(new Date(result.completedAt).toLocaleDateString()+' · puzzly',70,775);
      const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Export failed')), 'image/png'));
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');a.href=url;a.download='puzzly-memory-'+result.roomCode+'.png';a.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(e) {setError(e instanceof Error?e.message:'Could not export memory card.');}
    finally {setBusy(false);}
  };
  return <div className="space-y-2">
    <button type="button" disabled={busy} onClick={()=>void save()}
      className="rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-3 text-sm font-semibold transition hover:-translate-y-0.5 active:scale-95">
      {busy?'Creating memory card…':'Save our puzzle memory'}
    </button>
    {error&&<p role="alert" className="text-xs text-rose-400">{error}</p>}
  </div>;
}
