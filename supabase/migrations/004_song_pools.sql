-- NickelBrandt — Prompt #25: pre-made themed song pools
--
-- Run this manually in the Supabase SQL editor (Dashboard -> SQL Editor -> New
-- query). Table creation is not an app-runtime action, so the app never runs this.
--
-- ===========================================================================
-- WHAT THESE TABLES ARE (and are NOT)
-- ===========================================================================
-- song_pools / pool_songs hold STATIC, EXTERNALLY-CURATED REFERENCE DATA:
-- pre-made themed pools (e.g. "Pop 70er-90er") of verified songs, each with a
-- confirmed Spotify track id and a MusicBrainz-verified release year.
--
--  * NOT user-generated content. Regular app users never write here - they only
--    READ finished pools at game start (and the game draws a random, unseen
--    subset, which also solves the spoiler problem for whoever curated a pool).
--  * NO runtime AI dependency. The app contains no API key and never calls any
--    AI service. Pools are produced once, OUTSIDE the app, in a separate prep
--    phase (chat-assisted song lists + an external verification script that
--    fills these tables via the service key). The app is unaware of how the data
--    was produced; it just reads verified rows.
--
-- Hence the access model below: world-readable, but writable only by the service
-- role (the import script), never by anon/authenticated app clients.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.song_pools (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,                    -- e.g. "Pop 70er-90er"
  description text,                             -- short blurb for the picker UI
  created_at  timestamptz not null default now()
);

create table if not exists public.pool_songs (
  id               uuid primary key default gen_random_uuid(),
  pool_id          uuid not null references public.song_pools(id) on delete cascade,
  title            text not null,
  artist           text not null,
  -- A song without a verified Spotify track id does not belong in this table.
  spotify_track_id text not null,
  -- MusicBrainz-verified original release year (see the playlist year check).
  release_year     int  not null,
  -- Optional: kept when available, useful for future re-verification.
  isrc             text,
  created_at       timestamptz not null default now(),
  -- No duplicate songs within the same pool.
  constraint pool_songs_pool_track_uniq unique (pool_id, spotify_track_id)
);

-- pool_id is the hot filter (load all songs of a chosen pool).
create index if not exists pool_songs_pool_id_idx on public.pool_songs(pool_id);

-- ---------------------------------------------------------------------------
-- Realtime: intentionally NOT added to supabase_realtime.
-- ---------------------------------------------------------------------------
-- These are static reference tables; the app never subscribes to live changes
-- (unlike lobbies / lobby_players). Nothing to publish here.

-- ---------------------------------------------------------------------------
-- Row Level Security: world-readable, service-role-only writes
-- ---------------------------------------------------------------------------
-- Read: open to the app's anon/authenticated clients (pure reference data, no
--   user content to protect).
-- Write: NO insert/update/delete policy is created for anon/authenticated, so
--   with RLS enabled those operations are denied for regular app clients. The
--   service_role key (used only by the external import script) BYPASSES RLS by
--   design, so the script can populate/maintain these tables. This is exactly
--   the "read-only reference data, backend-writable" pattern.

alter table public.song_pools enable row level security;
alter table public.pool_songs enable row level security;

-- SELECT for app clients (drop-first so this migration is safe to re-run).
drop policy if exists "song_pools_read"  on public.song_pools;
create policy "song_pools_read"  on public.song_pools
  for select to anon, authenticated using (true);

drop policy if exists "pool_songs_read" on public.pool_songs;
create policy "pool_songs_read" on public.pool_songs
  for select to anon, authenticated using (true);

-- (Deliberately no write policies for anon/authenticated -> writes are denied
--  for them; the service_role key bypasses RLS for the import script.)
