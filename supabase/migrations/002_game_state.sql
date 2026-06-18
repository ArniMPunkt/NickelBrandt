-- NickelBrandt Online — Etappe 2: game state sync
--
-- Run this manually in the Supabase SQL editor (after 001_init.sql).

-- Per-lobby round state (deck, current card, active player, phase, etc.).
alter table public.lobbies
  add column if not exists game_state jsonb;

-- Per-player game data.
alter table public.lobby_players
  add column if not exists timeline      jsonb not null default '[]'::jsonb,
  add column if not exists score         int   not null default 0,
  add column if not exists chips         int   not null default 2,
  add column if not exists brandts_count int   not null default 0;

-- RLS: unchanged from migration 001 (open policies already cover these tables).
-- TODO before broader use: tighten so a player may only modify their own row
-- (player_id match) and only the host may write lobbies.game_state.

-- Realtime: lobbies + lobby_players are already in the supabase_realtime
-- publication from 001_init.sql, so game_state / timeline / score changes
-- already emit postgres_changes events. (No action needed here.)
