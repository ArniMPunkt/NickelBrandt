-- NickelBrandt — Song-Reports: "Song melden" aus dem In-Game-Overflow-Menü
-- (falsche Metadaten / Song passt nicht in den Pool).
--
-- Run this manually in the Supabase SQL editor (after 008_crash_reports.sql).
-- The app does NOT apply migrations itself.
--
-- Each row is a SNAPSHOT of the song as displayed at report time (title,
-- artist, year, uri) - deliberately not a foreign key into pool_songs, so a
-- report stays traceable even after the pool row gets corrected or deleted.
-- No free text by design (privacy/security): reason is a fixed enum.
--
-- Access model (same as crash_reports): the outside world (anon key baked
-- into the app) may ONLY INSERT. No select/update/delete policy and no such
-- grants -> reports are write-only from the app and read exclusively through
-- the Supabase dashboard (table editor / SQL, which uses service_role and
-- bypasses RLS).
--
-- Lesson from 007 baked in: Supabase's default privileges don't reliably
-- cover new tables, so the grants are EXPLICIT (idempotent, re-runnable).

create table if not exists public.song_reports (
  id          uuid primary key default gen_random_uuid(),
  -- Song snapshot as displayed at report time:
  title       text not null,
  artist      text not null,
  year        int  not null,
  track_uri   text not null,
  -- Deck source: "pool:<uuid>" (themed pools are the only source since the
  -- Spotify-playlist import was removed; historical rows may carry a raw
  -- Spotify playlist id). Null when unknown (e.g. a Party game started before
  -- the app version that snapshots the source into game_state).
  source_id   text,
  source_name text,
  reason      text not null
    check (reason in ('wrong_year', 'wrong_title_artist', 'not_in_pool', 'other')),
  mode        text not null
    check (mode in ('hitster', 'bingo', 'timeline_quiz', 'pass_and_play')),
  -- Party lobby the report came from; null = Pass & Play (local game).
  lobby_id    uuid,
  created_at  timestamptz not null default now()
);

alter table public.song_reports enable row level security;

drop policy if exists "song_reports_insert" on public.song_reports;
create policy "song_reports_insert" on public.song_reports
  for insert with check (true);

-- INSERT only for the API roles; service_role (dashboard/SQL) gets everything.
grant insert on table public.song_reports to anon, authenticated;
grant all    on table public.song_reports to service_role;
