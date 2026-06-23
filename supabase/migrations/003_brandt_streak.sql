-- NickelBrandt Online — Prompt #22: "Brandt" -> hot-streak statistic
--
-- Run this manually in the Supabase SQL editor (after 002_game_state.sql).
--
-- "Brandt" no longer means a successful steal. It is now the best hot-streak of
-- consecutive correct OWN placements within a single game. We track a running
-- streak (current_streak) plus its per-game peak (max_brandt_streak), and drop
-- the old steal counter (brandts_count), which is no longer used by the app.

alter table public.lobby_players
  add column if not exists current_streak    int not null default 0,
  add column if not exists max_brandt_streak int not null default 0;

-- Old steal counter, replaced by the streak fields above.
alter table public.lobby_players
  drop column if exists brandts_count;

-- RLS / Realtime: unchanged from 001/002 (open policies + existing publication
-- already cover these columns).
