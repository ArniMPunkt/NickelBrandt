-- NickelBrandt Online — Fundament: Spielmodi (Bingo / Timeline-Quiz) + Simultan-Runden
--
-- Run this manually in the Supabase SQL editor (after 004_song_pools.sql).
-- The app does NOT apply migrations itself.
--
-- 1) lobbies.game_mode / lobbies.mode_config
--    The host picks the mode (and its config) in the WAITING ROOM, before any
--    game_state exists - so it lives as real columns on lobbies. All players
--    already subscribe to the lobbies row, so the choice is visible to everyone
--    without extra sync. At game start the mode is snapshotted into game_state
--    (same pattern as cardsToWin & co).
--
-- 2) round_answers: one row per (lobby, round, player) for the simultaneous
--    rounds of the new modes. A separate table INSTEAD of a jsonb map inside
--    lobbies.game_state, deliberately:
--      - simultaneous submissions are plain INSERTs. A jsonb map would need
--        read-modify-write from multiple clients and silently DROP answers on
--        concurrent submits (PostgREST cannot jsonb_set server-side without an
--        RPC function);
--      - the UNIQUE constraint makes double-submission impossible at the DB
--        level (the app treats error 23505 as "already answered");
--      - resolution (host-authoritative) just SELECTs the current round's rows.
--    The round's DEADLINE + the resolved RESULTS stay in game_state jsonb:
--    those are written by a single writer (the host), so no contention there.
--    Party scale (friends circle), RLS deliberately open like 001.

-- ---------------------------------------------------------------------------
-- Lobby: mode + mode config
-- ---------------------------------------------------------------------------

alter table public.lobbies
  add column if not exists game_mode   text  not null default 'hitster',
  add column if not exists mode_config jsonb not null default '{}'::jsonb;

-- (no "if not exists" for constraints -> drop first so the file is re-runnable)
alter table public.lobbies drop constraint if exists lobbies_game_mode_check;
alter table public.lobbies
  add constraint lobbies_game_mode_check
  check (game_mode in ('hitster', 'bingo', 'timeline_quiz'));

-- mode_config keys (per mode, all optional):
--   bingo:         { "bingoGridSize": 4 | 5 }
--   timeline_quiz: { "timelineCardCount": <int> }
--   hitster:       {} (uses the existing settings flow)

-- ---------------------------------------------------------------------------
-- Simultaneous rounds: one answer row per (lobby, round, player)
-- ---------------------------------------------------------------------------

create table if not exists public.round_answers (
  id           uuid primary key default gen_random_uuid(),
  lobby_id     uuid not null references public.lobbies(id) on delete cascade,
  round_number int  not null,
  player_id    text not null,               -- device/session id (as in lobby_players)
  answer       jsonb not null,              -- mode-specific payload (opaque here)
  submitted_at timestamptz not null default now(),
  unique (lobby_id, round_number, player_id)
);

create index if not exists round_answers_lobby_round_idx
  on public.round_answers(lobby_id, round_number);

-- ---------------------------------------------------------------------------
-- Realtime: submissions show up live ("3/5 haben geantwortet"), and the host
-- can resolve as soon as everyone answered.
-- (If the table is already a member, Postgres errors with "already member" -
--  that's fine, ignore it.)
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.round_answers;

-- ---------------------------------------------------------------------------
-- Row Level Security: same open prototype policies as 001 (friends circle).
-- ---------------------------------------------------------------------------

alter table public.round_answers enable row level security;

drop policy if exists "open_round_answers_select" on public.round_answers;
drop policy if exists "open_round_answers_write"  on public.round_answers;
create policy "open_round_answers_select" on public.round_answers for select using (true);
create policy "open_round_answers_write"  on public.round_answers for all    using (true) with check (true);
