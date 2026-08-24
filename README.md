<div align="center">

# 🧩 Puzzly

**Turn any picture into a puzzle. Solve it together with your favorite person.**

A real-time collaborative jigsaw puzzle for 1–6 players. No signup, no accounts —
create a room, share one link, and start solving together.

[![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-4-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

</div>

<!--
  Add a screenshot or GIF of a live room here — it does more for this README
  than any paragraph. Suggested: docs/demo.gif, then:
  ![Puzzly](docs/demo.gif)
-->

---

## Contents

- [Why this exists](#why-this-exists)
- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Deploying to production](#deploying-to-production)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Scripts](#scripts)
- [Security posture](#security-posture)
- [Roadmap](#roadmap)
- [License](#license)

---

## Why this exists

Most online jigsaw sites are either single-player, ad-choked, or require an
account before you can do anything. Puzzly is the opposite: you pick a picture,
you get a link, and the person you send it to is solving with you seconds later —
seeing your cursor, your grabs, and your merges as they happen.

It's also a deliberate exercise in building correct multiplayer on **serverless
infrastructure that runs at $0/month**. The interesting parts of this codebase
are in [How it works](#how-it-works).

## Features

- **Real-time co-op** — live cursors, piece locking, reactions, presence, and
  "look here" pings. 1–6 players per room.
- **Any picture** — upload your own, or browse built-in *Puzzly Originals* plus
  optional Unsplash / Pexels galleries.
- **No accounts** — an anonymous identity (name, emoji, colour) lives in your
  browser. Share one invite link and you're playing.
- **Solo mode** — the same puzzle engine, no room, no network.
- **Resumable** — a seat token on your device lets you rejoin a room you left.
- **Challenge links** — share a finished puzzle as a "beat my time" challenge.
- **Server-authoritative** — the server merges pieces and decides completion, so
  a tampered client can't fake a win.
- **Works with zero configuration** — no keys needed to run it locally.
- **Accessible by default** — 44px touch targets, reduced-motion support, and
  zoom that doesn't break the layout.

## Quick start

Requires **Node.js 20+**.

```bash
git clone https://github.com/<your-username>/puzzly.git
cd puzzly
npm install
npm run dev
```

Open <http://localhost:3000> and open a second browser tab to play against
yourself.

With no environment variables set, Puzzly runs fully self-contained:

| Concern | Zero-config behaviour |
| --- | --- |
| Rooms | in-process memory |
| Realtime fan-out | local SSE bus |
| Uploads | local disk (`.data/blobs`) |
| Images | Puzzly Originals, generated locally |

This is a **development** mode. It is single-instance only — see
[Deploying to production](#deploying-to-production) before sharing a link.

## Configuration

Copy the annotated template and fill in what you need:

```bash
cp .env.example .env.local
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | for production | Project URL. Public by design. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | for production | Lets the browser subscribe to realtime. Public by design. |
| `SUPABASE_SERVICE_ROLE_KEY` | for production | **Secret.** Server-only; bypasses RLS. |
| `SUPABASE_STORAGE_BUCKET` | for production | Private upload bucket (`puzzly-images`). |
| `SUPABASE_URL` | no | Only if the server should reach a different host than the browser. |
| `UNSPLASH_ACCESS_KEY` | no | Enables the Unsplash gallery. Server-side only. |
| `PEXELS_API_KEY` | no | Enables the Pexels gallery. Server-side only. |
| `NEXT_PUBLIC_SITE_URL` | no | Canonical origin for invite links. Only needed for a custom domain. |

Stock-photo providers are entirely optional — without them, Browse simply shows
Puzzly Originals and your own uploads. Provider keys never reach the browser;
images are proxied through `/api/proxy`.

## Deploying to production

1. **Create a free Supabase project.**
2. **Run [`sql/schema.sql`](sql/schema.sql)** in the SQL Editor. It creates the
   tables, enables deny-by-default RLS, and creates the private `puzzly-images`
   bucket (8 MB ceiling; JPEG/PNG/WebP only).
3. **Set the environment variables** above in your Vercel project.
4. **Deploy.** Then check `GET /api/health` — it reports which store,
   broadcaster, and blob store are actually live, and names the exact variable
   that would fix anything still in fallback mode.

```jsonc
// GET /api/health
{
  "ok": true,
  "ready": true,
  "storage": { "rooms": "durable", "images": "durable" },
  "realtime": "supabase",
  "warnings": []
}
```

`ready: false` with a populated `warnings` array means the deployment will serve
traffic but multiplayer won't be reliable across instances.

### Cost

The whole thing is designed to fit inside free tiers:

| Resource | Free allowance | What Puzzly uses |
| --- | --- | --- |
| Realtime connections | 200 | 1 WebSocket per open board |
| Realtime messages | 2,000,000 / mo | ~1 per decided fact; cursors and drag frames are batched and never persisted |
| Database | 500 MB | room records are a few KB — geometry is regenerated from a seed, never stored |
| Storage | 1 GB | uploads are resized and WebP-compressed in the browser first (150–500 KB) |
| Egress | 5 GB / mo | images are the only bulk traffic |

> Supabase free projects pause after 7 days of inactivity; opening the dashboard
> resumes them. Nothing here needs a paid add-on.

## How it works

```
  Puzzle Engine        pure TypeScript, no DOM, no network   src/lib/puzzle/engine.ts
       ↓
  Game State           authoritative room record             src/lib/server/session.ts
       ↓
  Realtime Adapter     validate → CAS → broadcast            src/lib/server/{store,broadcast}.ts
       ↓
  Realtime Transport   Supabase Realtime, or dev SSE         src/lib/realtime/*
```

The engine is standalone and reusable — solo mode instantiates it in the browser
and never touches the realtime layer.

### There is no in-memory room hub

Vercel runs each request in whichever instance happens to be warm. An SSE stream
and the `POST /events` that should feed it routinely land in **different**
processes, so `globalThis` state isn't shared and broadcasts vanish.

Puzzly therefore keeps **no game state in server memory at all**. Every mutation
is:

1. `store.getRoomVersioned(code)` — load the record and its version
2. rehydrate `PuzzleEngine.fromState(...)`
3. validate the client's request against that engine
4. `store.casRoom(record, expectedVersion)` — compare-and-swap
5. broadcast the resulting facts

If another instance committed first, the CAS returns false and the whole batch is
re-applied against the winner's state (6 attempts, then `503`). This is
optimistic concurrency in Postgres, and it's what makes two players on two
different Vercel instances agree.

### Realtime transport: Supabase broadcast

| Option | Verdict |
| --- | --- |
| **Supabase Realtime fan-out** | **Chosen.** Free tier, already the database, no new dependency. Browsers hold a WebSocket to Supabase, so no Vercel function stays open. |
| Cloudflare Durable Objects | Rejected. Durable Objects require the **Workers Paid** plan ($5/mo), breaking the $0 constraint, and would mean a second deploy target. |
| Persistent free Node host | Rejected. Free tiers that keep a WebSocket alive either sleep after ~15 min (cold start on the first invite click) or have been withdrawn. |

Servers `POST` batches to `{SUPABASE_URL}/realtime/v1/api/broadcast` with the
service-role key. Browsers subscribe to channel `puzzly:{ROOM_CODE}` with the
**anon** key and receive event `evt`. Nothing about the transport leaks a secret:
the anon key is public by design and every table is RLS deny-by-default.

Because clients talk to Supabase directly, **Vercel's 300-second function limit
never applies to a live session** — there's no long-lived function. (The dev SSE
route, used only in keyless mode, reserves `maxDuration: 300` in `vercel.json`
and reconnects transparently.)

### Ephemeral vs durable state

**Never persisted** — sent with `seq: 0`, exempt from gap detection:
cursors, in-flight drag frames, reactions, "look here" pings, presence beats.

**Persisted** — each bumps `seq`: piece grabs, drops, merges, splits, rotations,
ready/start/complete transitions, hints, and stale lock refreshes.

**A mouse move never writes to the database.**

## Project structure

```
src/
  app/
    (site)/            landing, play, browse, my-puzzles, join, challenge
    room/[code]/       the live board
    api/               rooms, events, upload, blob, images, proxy, health, cron
  components/          shared UI (Button, Icon, header, footer, theme)
  features/
    puzzle/            board, toolbar, minimap, hints, completion
    multiplayer/       cursors, presence, connection state
    lobby/             ready-up room lobby
    images/            picker, upload, stock browser
    rooms/             create / join / challenge flows
  lib/
    puzzle/            engine, geometry, rng, sprites, renderer  ← pure, reusable
    realtime/          transport implementations + room client
    storage/           anonymous identity, local library, seats
    server/            store, broadcast, session, blobs, validation, rate limits
  hooks/
  types/
sql/schema.sql         tables + RLS + storage bucket
scripts/               protocol smoke tests
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Next dev server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |

Protocol-level smoke tests drive a **running** server over real HTTP with two
independent clients — no browser, no shared memory:

```bash
npm run dev                              # in one terminal
node scripts/smoke.mjs                   # end-to-end room lifecycle
node scripts/smoke-cas.mjs               # compare-and-swap contention
node scripts/smoke-edge.mjs              # edge cases
node scripts/diagnose-hints.mjs          # hint progression
```

## Security posture

- **No secret reaches the client.** Only `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` are exposed, and both are public by design.
- **Deny-by-default RLS.** Every table has RLS enabled with *no policies*, and
  `anon`/`authenticated` have all privileges revoked. The anon key can subscribe
  to broadcasts and nothing else.
- **Membership is proven per request** — a server-issued `playerId` + `token`
  pair on every event batch, checked with a constant-time comparison.
- **Completion is never taken from the client.** The server merges pieces itself
  and decides when `groups.size === 1`.
- **Rate limited twice** — coarsely per IP, and exactly per seat via a token
  bucket stored inside the room record, so it survives instance changes.
- **Uploads are validated server-side** as well as in the browser: MIME type,
  dimensions, and a size cap.
- **Private storage.** Uploads are served back through `/api/blob/[id]`, keeping
  the puzzle canvas same-origin (and therefore untainted) and never exposing a
  storage URL.
- **Security headers** (`nosniff`, `Referrer-Policy`, `X-Frame-Options`) are set
  in `next.config.ts`; `poweredByHeader` is off.

## Roadmap

Jigsaw is live. The room, realtime, and results layers are keyed by `GameType`,
so a new mode means adding a registry entry plus a board component — the
transport and room record don't change.

| Mode | Players | Status |
| --- | --- | --- |
| **Jigsaw** | 1–6 | ✅ Live |
| Scramble — sliding tiles | 1–4 | 🚧 Planned |
| Spot the Difference | 1–4 | 🚧 Planned |
| Memory — match the pairs | 1–6 | 🚧 Planned |
| Hidden Objects | 1–4 | 🚧 Planned |
| Escape Room | 2–4 | 🚧 Planned |

## License

[Apache License 2.0](LICENSE) — see the LICENSE file for the full text.
