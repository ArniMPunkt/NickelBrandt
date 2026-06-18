-- NickelBrandt Online — initial schema (Etappe 1: Lobby system)
--
-- Run this manually in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Table creation is not an app-runtime action, so the app never executes this.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.lobbies (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,             -- 6-char join code
  host_id     text not null,                    -- host's device/session id
  status      text not null default 'waiting',  -- waiting | playing | finished
  created_at  timestamptz not null default now()
);

create table if not exists public.lobby_players (
  id          uuid primary key default gen_random_uuid(),
  lobby_id    uuid not null references public.lobbies(id) on delete cascade,
  player_name text not null,
  player_id   text not null,                    -- device/session id
  is_host     boolean not null default false,
  joined_at   timestamptz not null default now()
);

create index if not exists lobby_players_lobby_id_idx on public.lobby_players(lobby_id);

-- ---------------------------------------------------------------------------
-- Realtime: make these tables emit postgres_changes events
-- ---------------------------------------------------------------------------
-- (If a table is already a member of the publication, Postgres errors with
--  "already member" - that's fine, just ignore it / run the other line.)
alter publication supabase_realtime add table public.lobbies;
alter publication supabase_realtime add table public.lobby_players;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- PROTOTYPE: fully open policies (anyone may read/write) - fine for a small
-- friends-circle test. TODO before broader use: tighten these, e.g. only allow
-- a row to be modified/deleted by the matching player_id, and validate inserts.

alter table public.lobbies enable row level security;
alter table public.lobby_players enable row level security;

create policy "open_lobbies_select" on public.lobbies for select using (true);
create policy "open_lobbies_write"  on public.lobbies for all    using (true) with check (true);

create policy "open_lobby_players_select" on public.lobby_players for select using (true);
create policy "open_lobby_players_write"  on public.lobby_players for all    using (true) with check (true);
