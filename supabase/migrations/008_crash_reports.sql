-- NickelBrandt — Crash-Reports: direkter Upload aus dem nativen iOS
-- Exception-Handler (plugins/withCrashDiagnostics.js).
--
-- Run this manually in the Supabase SQL editor (after 007_fix_round_answers_rls.sql).
-- The app does NOT apply migrations itself.
--
-- The uncaught-exception handler POSTs one row per fatal NSException via
-- PostgREST (INSERT with Prefer: return=minimal) right before the process
-- aborts - TestFlight strips exactly this information (exception name/reason).
--
-- Access model (deliberately narrower than the game tables): the outside world
-- (anon key baked into the app) may ONLY INSERT. No select/update/delete
-- policy and no such grants -> crash reports are write-only from the app and
-- read exclusively through the Supabase dashboard (table editor / SQL, which
-- uses service_role and bypasses RLS).
--
-- Lesson from 007 baked in: Supabase's default privileges don't reliably
-- cover new tables, so the grants are EXPLICIT (idempotent, re-runnable).

create table if not exists public.crash_reports (
  id               uuid primary key default gen_random_uuid(),
  app_version      text,
  build_number     text,
  device_model     text,
  os_version       text,
  exception_name   text,
  exception_reason text,
  stack_trace      text,
  created_at       timestamptz not null default now()
);

alter table public.crash_reports enable row level security;

drop policy if exists "crash_reports_insert" on public.crash_reports;
create policy "crash_reports_insert" on public.crash_reports
  for insert with check (true);

-- INSERT only for the API roles; service_role (dashboard/SQL) gets everything.
grant insert on table public.crash_reports to anon, authenticated;
grant all    on table public.crash_reports to service_role;
