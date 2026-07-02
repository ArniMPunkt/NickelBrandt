-- NickelBrandt Online — Bingo-Modus: Board-Speicherung
--
-- Run this manually in the Supabase SQL editor (after 005_game_modes.sql).
-- The app does NOT apply migrations itself.
--
-- One jsonb board per player on lobby_players (analog zu `timeline`), NOT a
-- separate table and NOT inside lobbies.game_state:
--   - unlike round ANSWERS (concurrent multi-client INSERTs -> own table,
--     see 005), the board has a SINGLE writer per round: startBingoGame writes
--     the fresh boards, and afterwards only the one client that wins the
--     resolve claim marks cells. No write contention -> jsonb column is safe;
--   - keeping it on the player row reuses the existing lobby_players realtime
--     subscription and keeps game_state small (it is rewritten every round).
--
-- Board shape (row-major, length = gridSize²):
--   [ { "color": "decade" | "before_after_2000" | "year_guess" | "title_artist",
--       "marked": boolean }, ... ]

alter table public.lobby_players
  add column if not exists bingo_board jsonb;

-- RLS / Realtime: unchanged (open policies from 001 + existing publication
-- already cover this column).
