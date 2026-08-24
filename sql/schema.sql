-- ---------------------------------------------------------------------------
-- Puzzly — Supabase schema
--
-- Run this once in the Supabase dashboard: SQL Editor > New query > Run.
--
-- Design notes
--   * Every table has RLS enabled and *no policies*. The anon key therefore
--     cannot read or write anything; only the service-role key (used strictly
--     server-side) can, because it bypasses RLS. This is what lets us ship the
--     anon key to the browser for realtime without exposing room state.
--   * `rooms.version` gives us optimistic concurrency. A write is issued as
--     `PATCH /rooms?code=eq.X&version=eq.N`; if it matches zero rows another
--     instance got there first and the caller reloads and retries. This is what
--     makes multiplayer correct without any in-memory server state.
--   * Realtime is used in *broadcast* mode only, so no table needs to be added
--     to a publication. Nothing about cursors or drags ever touches Postgres.
-- ---------------------------------------------------------------------------

create extension if not exists "pgcrypto";

-- --- rooms -----------------------------------------------------------------
-- One row per live room. `data` holds { room, puzzle, session } — small by
-- design: piece geometry is regenerated from a 32-bit seed, never stored.
create table if not exists public.rooms (
  code        text primary key,
  status      text        not null default 'lobby',
  version     bigint      not null default 0,
  data        jsonb       not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create index if not exists rooms_expires_at_idx on public.rooms (expires_at);
create index if not exists rooms_status_idx     on public.rooms (status);

-- --- puzzles ---------------------------------------------------------------
-- Kept separately so "My Puzzles" and challenge links survive the room.
create table if not exists public.puzzles (
  id         text primary key,
  data       jsonb       not null,
  created_at timestamptz not null default now()
);

-- --- images ----------------------------------------------------------------
-- Metadata only (id, dimensions, title, attribution). The bytes live in
-- Storage; never inline an image in Postgres.
--
-- `expires_at` is "three days after this picture was last used", not after it
-- was uploaded: it slides forward every time a room is cut from the image or the
-- board fetches its bytes. Nullable, so a database created before this column
-- existed can be migrated by re-running this file — rows without an expiry are
-- simply never swept.
create table if not exists public.images (
  id         text primary key,
  data       jsonb       not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

alter table public.images add column if not exists expires_at timestamptz;

create index if not exists images_expires_at_idx on public.images (expires_at);

-- --- challenges ------------------------------------------------------------
create table if not exists public.challenges (
  id         text primary key,
  data       jsonb       not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists challenges_expires_at_idx on public.challenges (expires_at);

-- --- Lock everything down --------------------------------------------------
alter table public.rooms      enable row level security;
alter table public.puzzles    enable row level security;
alter table public.images     enable row level security;
alter table public.challenges enable row level security;

-- No policies are created on purpose. Deny-by-default for anon and authenticated;
-- the service-role key bypasses RLS entirely.

revoke all on public.rooms      from anon, authenticated;
revoke all on public.puzzles    from anon, authenticated;
revoke all on public.images     from anon, authenticated;
revoke all on public.challenges from anon, authenticated;

-- --- Storage bucket for uploads -------------------------------------------
-- Private. Uploaded images are read back server-side and served through
-- /api/blob/[id], which keeps the puzzle canvas same-origin (and therefore
-- untainted) and means no storage URL is ever exposed to a client.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'puzzly-images',
  'puzzly-images',
  false,
  8388608,                                            -- 8 MB hard ceiling
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- --- Housekeeping ----------------------------------------------------------
-- The app sweeps expired rows opportunistically, so this is optional. If you
-- want it scheduled, enable pg_cron in Database > Extensions and uncomment:
--
--   select cron.schedule(
--     'puzzly-sweep',
--     '17 * * * *',
--     $$ select public.puzzly_sweep(); $$
--   );
--
-- Note what is *not* here: expired images. Deleting an `images` row from SQL
-- would orphan its bytes in Storage, with nothing left to find them by. Uploads
-- are swept by `/api/cron/sweep`, which deletes the bytes first and the row
-- second, and skips any picture a live room was cut from.

create or replace function public.puzzly_sweep()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.rooms      where expires_at < now();
  delete from public.challenges where expires_at < now();
$$;

revoke all on function public.puzzly_sweep() from anon, authenticated;
