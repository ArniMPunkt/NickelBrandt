-- NickelBrandt Online — Fix: "permission denied for table round_answers"
--
-- Run this manually in the Supabase SQL editor (after 006_bingo_board.sql).
-- The app does NOT apply migrations itself.
--
-- DIAGNOSIS (why this happened):
--   Two different failures produce a 42501 error, but with DIFFERENT texts:
--     - missing table GRANT for the role:
--         "permission denied for table round_answers"      <- what we saw
--     - RLS policy rejection on insert:
--         "new row violates row-level security policy ..."
--   The observed text is the GRANT variant. The open policies from 005
--   (open_round_answers_select / open_round_answers_write) are correct and in
--   place — but policies only FILTER rows; the role additionally needs the
--   plain table privilege, and that is what's missing here.
--
--   The tables from 001/004 never needed explicit grants because Supabase's
--   ALTER DEFAULT PRIVILEGES normally auto-grants to anon/authenticated on
--   newly created tables. For round_answers that default evidently didn't
--   apply (defaults are tied to the role that creates the object, so they
--   silently don't fire when a script runs under a different role/path).
--   Explicit grants are the robust fix and are harmless if already present.
--
-- SCOPE CHECK (rest of 005/006):
--   - lobbies.game_mode / mode_config (005) and lobby_players.bingo_board
--     (006) are only NEW COLUMNS on existing tables. Table-level grants cover
--     all columns, including ones added later -> not affected.
--   - round_answers is the only new TABLE, and it has no sequence (uuid
--     default) -> nothing else to grant.
--   - Both Bingo and Timeline-Quiz submit through round_answers, so this one
--     fix covers both modes.

-- ---------------------------------------------------------------------------
-- Table privileges for the API roles (re-runnable: GRANT is idempotent).
-- select: live "X/Y haben geantwortet" + resolution reads
-- insert: players submitting answers
-- delete: (defensive) cleanup follows lobby deletion via ON DELETE CASCADE,
--         but keep parity with the other open prototype tables.
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on table public.round_answers
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Re-assert the open policies from 005 (belt and braces, drop-first so the
-- file stays re-runnable). No-op if 005 already created them.
-- ---------------------------------------------------------------------------

alter table public.round_answers enable row level security;

drop policy if exists "open_round_answers_select" on public.round_answers;
drop policy if exists "open_round_answers_write"  on public.round_answers;
create policy "open_round_answers_select" on public.round_answers for select using (true);
create policy "open_round_answers_write"  on public.round_answers for all    using (true) with check (true);
