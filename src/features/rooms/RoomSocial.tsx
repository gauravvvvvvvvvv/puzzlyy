'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { RoomSession } from '@/hooks/useRoomSession';

type Mode = { audio: boolean; video: boolean };
type Remote = { playerId: string; stream: MediaStream };
const OFF: Mode = { audio: false, video: false };

function MediaTile({ stream, label, muted = false }: {
  stream: MediaStream; label: string; muted?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream]);
  return (
    <div className="relative min-h-24 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-inset)] shadow-sm">
      {stream.getVideoTracks().length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-center text-sm font-medium text-[var(--fg-muted)]">
          <span className="rounded-full bg-[var(--accent-soft)] px-4 py-2">🎙 {label}</span>
        </div>
      )}
      <video ref={video} autoPlay playsInline muted={muted}
        className={'aspect-video w-full object-cover ' +
          (stream.getVideoTracks().length ? 'bg-black' : 'opacity-0')} />
      <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-2xs text-white">
        {label}
      </span>
    </div>
  );
}

/**
 * Room-level social layer. Stays mounted throughout lobby, gameplay, results,
 * and puzzle changes. Voice/video permissions are requested only on click.
 * WebRTC carries the media; authenticated room events carry signaling.
 */
export function RoomSocial({ session, code }: { session: RoomSession; code: string }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<Mode>(OFF);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [remote, setRemote] = useState<Remote[]>([]);
  const [unread, setUnread] = useState(0);
  const [typing, setTyping] = useState<string | null>(null);
  const typingAt = useRef(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [callExpanded, setCallExpanded] = useState(false);
  const pane = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const modeRef = useRef<Mode>(OFF);
  const iceServersRef = useRef<RTCIceServer[]>([{ urls: 'stun:stun.l.google.com:19302' }]);
  const pcs = useRef(new Map<string, RTCPeerConnection>());
  const peerModes = useRef(new Map<string, Mode>());
  const pendingIce = useRef(new Map<string, RTCIceCandidateInit[]>());
  const processed = useRef(0);
  const decodeRef = useRef(session.decodeSignal);
  decodeRef.current = session.decodeSignal;
  const sendRef = useRef(session.send);
  const flushRef = useRef(session.flush);
  sendRef.current = session.send;
  flushRef.current = session.flush;

  const notify = useCallback((event: Parameters<RoomSession['send']>[0]) => {
    sendRef.current(event);
    flushRef.current();
  }, []);

  const closePeer = useCallback((id: string) => {
    const pc = pcs.current.get(id);
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.close();
      pcs.current.delete(id);
    }
    setRemote(list => list.filter(item => item.playerId !== id));
  }, []);

  const createPeer = useCallback((id: string) => {
    const existing = pcs.current.get(id);
    if (existing && existing.signalingState !== 'closed') return existing;
    if (!mediaRef.current) return null;
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
    pcs.current.set(id, pc);
    for (const track of mediaRef.current.getTracks()) pc.addTrack(track, mediaRef.current);
    pc.onicecandidate = (evt) => {
      if (evt.candidate) notify({ t: 'rtc', to: id, kind: 'candidate', data: JSON.stringify(evt.candidate.toJSON()) });
    };
    pc.ontrack = (evt) => {
      const stream = evt.streams[0] ?? new MediaStream([evt.track]);
      setRemote(list => [...list.filter(item => item.playerId !== id), { playerId: id, stream }]);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') setError('A call connection failed. Try toggling voice or video.');
    };
    return pc;
  }, [notify]);

  const flushIce = useCallback(async (id: string, pc: RTCPeerConnection) => {
    const queue = pendingIce.current.get(id) ?? [];
    pendingIce.current.delete(id);
    for (const item of queue) {
      try { await pc.addIceCandidate(new RTCIceCandidate(item)); } catch { /* stale candidate */ }
    }
  }, []);

  const offerTo = useCallback(async (id: string) => {
    if (!mediaRef.current || !peerModes.current.get(id) || pcs.current.has(id)) return;
    const pc = createPeer(id);
    if (!pc) return;
    try {
      await pc.setLocalDescription(await pc.createOffer());
      if (pc.localDescription) notify({
        t: 'rtc', to: id, kind: 'offer', data: JSON.stringify(pc.localDescription.toJSON()),
      });
    } catch { closePeer(id); }
  }, [createPeer, notify, closePeer]);

  // One deterministic offerer prevents glare when two participants enable at once.
  const maybeOffer = useCallback((id: string) => {
    if (session.myId && session.myId < id && mediaRef.current) void offerTo(id);
  }, [session.myId, offerTo]);

  const changeMode = useCallback(async (next: Mode) => {
    if (busy) return;
    setBusy(true);
    setError('');
    const previous = mediaRef.current;
    const active = previous ?? new MediaStream();
    let acquired: MediaStream | null = null;
    try {
      if ((next.audio && !active.getAudioTracks().length) ||
          (next.video && !active.getVideoTracks().length)) {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone/camera capture is unavailable on this browser.');
        acquired = await navigator.mediaDevices.getUserMedia({
          audio: next.audio && !active.getAudioTracks().length,
          video: next.video && !active.getVideoTracks().length
            ? { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 20 } }
            : false,
        });
        for (const track of acquired.getTracks()) active.addTrack(track);
      }
      if (next.audio || next.video) {
        try { iceServersRef.current = await session.loadIceServers(); }
        catch { /* STUN can still connect on permissive networks. */ }
      }
      // Preserve tracks which stay enabled, particularly the camera when
      // toggling microphone. Do not reacquire device permissions needlessly.
      for (const track of active.getTracks()) {
        if ((track.kind === 'audio' && !next.audio) || (track.kind === 'video' && !next.video)) {
          active.removeTrack(track);
          track.stop();
        }
      }
      for (const id of [...pcs.current.keys()]) closePeer(id);
      mediaRef.current = active.getTracks().length ? active : null;
      setPreview(mediaRef.current ? new MediaStream(mediaRef.current.getTracks()) : null);
      modeRef.current = next;
      setMode(next);
      notify({ t: 'media', ...next });
      if (mediaRef.current) {
        for (const [id, theirs] of peerModes.current) {
          if (theirs.audio || theirs.video) maybeOffer(id);
        }
      }
    } catch (e) {
      acquired?.getTracks().forEach(track => {
        active.removeTrack(track);
        track.stop();
      });
      setError(e instanceof Error ? e.message : 'Could not access your device.');
    } finally {
      setBusy(false);
    }
  }, [busy, closePeer, maybeOffer, notify, session.loadIceServers]);

  // Signals come only through the seat-authenticated server path.
  useEffect(() => {
    for (const { id, event } of session.signals) {
      if (id <= processed.current) continue;
      processed.current = id;
      if (event.t === 'typing') {
        if (typingTimer.current) clearTimeout(typingTimer.current);
        setTyping(event.active
          ? (session.players.find(p => p.id === event.playerId)?.name ?? 'Someone')
          : null);
        if (event.active) typingTimer.current = setTimeout(() => setTyping(null), 2200);
        continue;
      }
      if (event.t === 'media') {
        const previous = peerModes.current.get(event.playerId);
        peerModes.current.set(event.playerId, { audio: event.audio, video: event.video });
        if (!event.audio && !event.video) {
          closePeer(event.playerId);
        } else {
          if (previous && (previous.audio !== event.audio || previous.video !== event.video)) {
            closePeer(event.playerId);
          }
          maybeOffer(event.playerId);
        }
        continue;
      }
      const peerId = event.playerId;
      if (!modeRef.current.audio && !modeRef.current.video) continue;
      void (async () => {
        try {
          const decoded = await decodeRef.current(event.data);
          if (event.kind === 'candidate') {
            const candidate = JSON.parse(decoded) as RTCIceCandidateInit;
            const pc = pcs.current.get(peerId);
            if (pc?.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(candidate));
            else pendingIce.current.set(peerId, [...(pendingIce.current.get(peerId) ?? []), candidate].slice(-64));
            return;
          }
          if (event.kind === 'offer') {
            // The sender is restarting negotiation. Replace any stale peer.
            closePeer(peerId);
            const pc = createPeer(peerId);
            if (!pc) return;
            await pc.setRemoteDescription(JSON.parse(decoded) as RTCSessionDescriptionInit);
            await flushIce(peerId, pc);
            await pc.setLocalDescription(await pc.createAnswer());
            if (pc.localDescription) notify({
              t: 'rtc', to: peerId, kind: 'answer', data: JSON.stringify(pc.localDescription.toJSON()),
            });
          } else {
            const pc = pcs.current.get(peerId);
            if (!pc || pc.signalingState === 'closed') return;
            await pc.setRemoteDescription(JSON.parse(decoded) as RTCSessionDescriptionInit);
            await flushIce(peerId, pc);
          }
        } catch { setError('Call negotiation failed. Toggle your microphone or camera to retry.'); }
      })();
    }
  }, [session.signals, closePeer, createPeer, flushIce, notify, maybeOffer]);

  // A periodic re-announcement heals lost one-shot signaling and rejoins.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (modeRef.current.audio || modeRef.current.video) {
        notify({ t: 'media', ...modeRef.current });
      }
    }, 10000);
    return () => window.clearInterval(timer);
  }, [notify]);

  const rosterKey = session.players.map(p => p.id).join(':');
  useEffect(() => {
    const active = modeRef.current;
    if (active.audio || active.video) notify({ t: 'media', ...active });
    const live = new Set(session.players.map(p => p.id));
    for (const id of [...pcs.current.keys()]) if (!live.has(id)) closePeer(id);
  // A roster change is a good moment to introduce our call capability to a newcomer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rosterKey, notify, closePeer]);

  useEffect(() => {
    if (pane.current) pane.current.scrollTop = pane.current.scrollHeight;
    if (!open && session.chat.length) setUnread(v => v + 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.chat.length]);

  useEffect(() => { if (open) setUnread(0); }, [open]);

  useEffect(() => () => {
    for (const pc of pcs.current.values()) pc.close();
    mediaRef.current?.getTracks().forEach(track => track.stop());
    if (typingTimer.current) clearTimeout(typingTimer.current);
  }, []);

  const sendMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = message.trim().slice(0, 500);
    if (!text) return;
    session.sendChat(text);
    notify({ t: 'typing', active: false });
    setMessage('');
  };

  const hasMedia = mode.audio || mode.video;
  const videoCount = (preview && mode.video ? 1 : 0) + remote.filter(r => r.stream.getVideoTracks().length > 0).length;
  return (
    <>
      {!open && <button type="button" onClick={() => setOpen(true)}
        className="fixed bottom-20 right-3 z-40 rounded-full border border-[var(--line)] bg-[var(--surface)] px-4 py-2.5 text-sm shadow-lg lg:hidden"
        aria-label="Open room chat" style={{ bottom: 'max(5rem, env(safe-area-inset-bottom))' }}>Chat {unread > 0 ? '(' + unread + ')' : ''}</button>}
      {open && <button type="button" onClick={() => setOpen(false)}
        className="fixed inset-0 z-40 bg-black/35 lg:hidden" aria-label="Close room chat" />}
      <aside className={(open ? 'flex fixed inset-y-0 right-0 z-50 w-[min(94vw,420px)]' : 'hidden') +
        ' lg:static lg:z-auto lg:flex lg:w-[min(30vw,380px)] shrink-0 flex-col border-l border-[var(--line)] bg-[var(--surface)] shadow-xl lg:shadow-none'}>
        <header className="flex items-center justify-between border-b border-[var(--line)] p-3">
          <div><p className="text-sm font-semibold">Room chat</p>
            <p className="text-2xs text-[var(--fg-subtle)]">Room {code} · round {session.room?.round ?? 1}</p>
          </div>
          <button type="button" onClick={() => setOpen(false)} className="rounded p-2 lg:hidden">Close</button>
        </header>
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] p-3">
          <button type="button" disabled={busy} aria-pressed={mode.audio}
            onClick={() => void changeMode({ ...mode, audio: !mode.audio })}
            className={'min-h-11 flex-1 rounded-xl border px-3 py-2 text-xs font-semibold transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ' + (mode.audio ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--fg)] ring-2 ring-[var(--accent)]/40' : 'border-[var(--line)] bg-[var(--surface-inset)] hover:border-[var(--accent)]')}>
            {busy ? 'Connecting…' : mode.audio ? '● Voice on' : '🎙 Join voice'}
          </button>
          <button type="button" disabled={busy} aria-pressed={mode.video}
            onClick={() => void changeMode({ ...mode, video: !mode.video })}
            className={'min-h-11 flex-1 rounded-xl border px-3 py-2 text-xs font-semibold transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ' + (mode.video ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--fg)] ring-2 ring-[var(--accent)]/40' : 'border-[var(--line)] bg-[var(--surface-inset)] hover:border-[var(--accent)]')}>
            {busy ? 'Connecting…' : mode.video ? '● Camera on' : '📷 Start video'}
          </button>
          {hasMedia && <span role="status" className="text-2xs text-[var(--fg-subtle)]">Media connected</span>}
          {(videoCount > 0 || hasMedia) && <button type="button" onClick={() => setCallExpanded(value => !value)} className="rounded-lg border border-[var(--line)] px-3 py-2 text-xs transition hover:bg-[var(--surface-inset)] active:scale-95">{callExpanded ? 'Compact view' : 'Expand videos'}</button>}
        </div>
        {error && <p role="alert" className="px-3 pt-2 text-xs text-red-500">{error}</p>}
        {(preview || remote.length > 0) && (
          <div className={(callExpanded ? 'fixed inset-3 z-[60] max-h-[calc(100dvh-1.5rem)] rounded-xl border bg-[var(--surface)] p-3 shadow-2xl sm:inset-[5vh_5vw] ' : 'max-h-[min(40dvh,330px)] border-b p-2 ') + 'overflow-auto border-[var(--line)]'}>
            {callExpanded && <button type="button" onClick={() => setCallExpanded(false)} className="mb-3 w-full rounded-lg border p-2 text-sm hover:bg-[var(--surface-inset)]">Close full call view</button>}
            <div className={'grid gap-2 ' + (videoCount >= 5 ? 'grid-cols-2 sm:grid-cols-3' : videoCount >= 3 ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-2')}>
            {preview && mode.video && <MediaTile stream={preview} label="You" muted />}
            {remote.map(({ playerId, stream }) => {
              const player = session.players.find(p => p.id === playerId);
              return <MediaTile key={playerId} stream={stream} label={player?.name ?? 'Friend'} />;
            })}
            </div>
            {videoCount >= 5 && <p className="mt-2 text-center text-2xs text-[var(--fg-muted)]">Six-person video grid · individual streams</p>}
          </div>
        )}
        <div ref={pane} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3" aria-label="Room messages" role="log">
          {session.chat.length === 0 && <p className="text-center text-xs text-[var(--fg-muted)]">
            Your conversation stays here when you play the next puzzle.
          </p>}
          {session.chat.map(entry => <div key={entry.id}
            className={'max-w-[95%] rounded-xl px-3 py-2 text-xs ' +
              (entry.playerId === session.myId ? 'ml-auto bg-[var(--accent-soft)]' : 'bg-[var(--surface-inset)]')}>
            <p className="mb-1 font-semibold text-[var(--fg)]">{entry.name}</p>
            <p className="break-words whitespace-pre-wrap text-[var(--fg-muted)]">{entry.text}</p>
          </div>)}
        </div>
        {typing && <p className="px-3 pb-1 text-2xs italic text-[var(--fg-muted)]">{typing} is typing…</p>}
        {session.history.length > 0 && (
          <details className="border-t border-[var(--line)] px-3 py-2">
            <summary className="cursor-pointer text-xs text-[var(--fg-muted)]">
              Puzzles completed together ({session.history.length})
            </summary>
            <ul className="mt-2 max-h-24 space-y-1 overflow-auto">
              {session.history.slice(-6).reverse().map(result => (
                <li key={result.puzzleId} className="truncate text-xs">
                  {result.puzzleTitle} · {result.pieceCount} pieces
                </li>
              ))}
            </ul>
          </details>
        )}
        <form onSubmit={sendMessage} className="flex gap-2 border-t border-[var(--line)] p-3">
          <input value={message} onChange={e => {
            setMessage(e.target.value);
            if (Date.now() - typingAt.current > 900) {
              typingAt.current = Date.now();
              notify({ t: 'typing', active: e.target.value.length > 0 });
            }
          }} maxLength={500}
            placeholder="Message the room..." aria-label="Room message"
            className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--surface-inset)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]" />
          <button disabled={!message.trim()} type="submit"
            className="min-h-11 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm text-white transition-all hover:brightness-110 hover:shadow-md active:scale-95 disabled:opacity-40">Send</button>
        </form>
      </aside>
    </>
  );
}
