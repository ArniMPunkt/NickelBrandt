-- NickelBrandt — Automatischer Song-Pool-Import aus einer oeffentlichen
-- Spotify-Playlist (Konzept: docs/spotify-playlist-import-konzept.md).
--
-- Run this manually in the Supabase SQL editor (after 011_player_app_version.sql).
-- The app does NOT apply migrations itself.
--
-- ===========================================================================
-- VORAUSSETZUNG (einmalig im Dashboard, VOR dieser Migration)
-- ===========================================================================
-- Authentication -> Providers -> "Anonymous sign-ins" aktivieren. Ohne das
-- liefert auth.uid() null und jede nutzerseitige RPC bricht mit
-- 'not_authenticated' ab. Begruendung: Konzept 4.2 - Job- und Pool-Besitz
-- werden ueber auth.uid() in der Datenbank erzwungen, nicht clientseitig.
--
-- ===========================================================================
-- DDL-REIHENFOLGE (verbindlich, Konzept 4)
-- ===========================================================================
-- playlist_import_jobs und imported_pools referenzieren einander gegenseitig.
-- Ein Skript, das beide Fremdschluessel inline deklariert, ist nicht
-- ausfuehrbar - egal welche Tabelle zuerst kommt. Deshalb:
--   1. app_config, spotify_api_budget, spotify_quota_signals,
--      spotify_gameplay_reservations
--   2. playlist_import_jobs OHNE FK auf imported_pools
--   3. imported_pools, imported_pool_members, imported_pool_songs
--   4. playlist_import_requests, playlist_import_dropped_songs,
--      playlist_import_job_errors
--   5. ALTER TABLE ... ADD CONSTRAINT fuer die Gegenrichtung
--   6. Caches, Indizes, RLS, Grants/Revokes, Publication, Storage-Bucket
--   7. RPCs
--
-- Grants sind ueberall EXPLIZIT (Lektion aus 007: Supabases Default-
-- Privilegien fuer neue Tabellen greifen nicht verlaesslich). Tabellen ohne
-- App-Lesebedarf bekommen zusaetzlich ein explizites REVOKE.
--
-- Idempotent: mehrfaches Ausfuehren aendert nichts (create ... if not exists,
-- drop policy if exists, pg_constraint-/pg_publication_tables-Pruefungen).
-- ===========================================================================


-- ===========================================================================
-- 1. Konfiguration und Budget-Ledger
-- ===========================================================================

create table if not exists public.app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.app_config (key, value) values
  ('playlist_import', jsonb_build_object(
     'enabled',              false,  -- Kill-Switch gesamt (erst nach Abnahme auf true)
     'scraper_enabled',      false,  -- getrennt: bei DOM-Bruch nur den Browser abschalten
     'max_playlist_entries', 200,
     'min_import_songs',     40,
     'min_retention',        0.85,
     'hard_min_retention',   0.60,
     'large_pool_threshold', 120,
     'max_queue',            10,
     'max_requests_per_owner_per_day', 5,
     'reuse_pool_hours',     24,
     'job_lease_seconds',    90,
     'max_attempts',         3,      -- gilt NUR fuer attempts (Lease-Verlust), nie fuer deferrals
     'job_active_timeout_s', 900,    -- aktive Rechenzeit, ohne not_before-Wartezeit
     'min_worker_version',   1,      -- beim Claim durchgesetzt
     'pipeline_version',     1,      -- eingefroren je Job; Aenderung nur bei leerer Queue
     'decision_version',     1       -- dito
  )),
  ('spotify_budget', jsonb_build_object(
     'window_hours',        4,   -- ANNAHME, nicht bestaetigt (Konzept 12.2)
     'observed_ceiling',  594,   -- in EINEM Testlauf beobachtet, kein garantiertes Limit
     'gameplay_reserve',  250,   -- ausschliesslich App/Cover-Art
     'import_cap',        220,   -- Obergrenze Worker je Fenster (wandert mit, s. reserve_spotify_calls)
     'safety_margin',     124,   -- Puffer gegen die unbekannte Reset-Semantik
     'max_gameplay_reservation',   64,
     'max_quota_signals_per_hour',  6,
     -- INVARIANTE: reservation_guard_seconds >= maximale Dauer eines
     -- Cover-Batches (max_gameplay_reservation Calls inkl. Retries/Backoff).
     -- 64 Calls bei 6 parallelen Requests liegen weit darunter; 600 s lassen
     -- Luft fuer Retry-Wartezeiten. Wer max_gameplay_reservation erhoeht,
     -- muss diesen Wert mit erhoehen.
     'reservation_guard_seconds', 600,  -- keine NEUE Reservierung so kurz vor Fensterende
     'reservation_valid_seconds', 900   -- Gueltigkeit einer Gameplay-Reservierung
  ))
on conflict (key) do nothing;

comment on table public.app_config is
  'Feature-Flags und Betriebsparameter. Schreibzugriff ausschliesslich ueber '
  'set_playlist_import_config() bzw. das Dashboard (service_role).';


create table if not exists public.spotify_api_budget (
  id             smallint primary key default 1 check (id = 1),
  window_start   timestamptz not null default now(),
  used_import    int not null default 0 check (used_import >= 0),
  used_gameplay  int not null default 0 check (used_gameplay >= 0),
  -- GLOBALE Sperre: blockiert App UND Worker. Nur service_role setzt sie.
  blocked_until  timestamptz,
  blocked_reason text,
  -- IMPORT-Sperre: blockiert nur den Worker. Darf aus (gedeckelten,
  -- rate-limitierten) App-Signalen entstehen - der Schaden bei Missbrauch
  -- bleibt damit auf "Importe pausieren" begrenzt.
  import_blocked_until timestamptz,
  -- Verbrauch beim letzten QUOTA_EXCEEDED; fliesst in JEDE weitere Zulassung ein.
  last_ceiling_observed int,
  updated_at     timestamptz not null default now()
);
insert into public.spotify_api_budget (id) values (1) on conflict do nothing;


create table if not exists public.spotify_quota_signals (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  retry_after_s int not null,
  reason        text,
  created_at    timestamptz not null default now()
);
create index if not exists sqs_owner_idx  on public.spotify_quota_signals (owner_id, created_at desc);
create index if not exists sqs_recent_idx on public.spotify_quota_signals (created_at desc);


-- Gameplay-Reservierungen: gebunden an Eigentuemer, Budgetfenster und
-- Gueltigkeitsende, einmalig abrechenbar.
create table if not exists public.spotify_gameplay_reservations (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  valid_until  timestamptz not null,
  granted      int not null check (granted > 0),
  used         int,
  settled_at   timestamptz,
  created_at   timestamptz not null default now(),
  -- Kein stilles Clamping: ein Settlement ausserhalb [0, granted] ist ein Fehler.
  constraint sgr_used_range check (used is null or (used >= 0 and used <= granted))
);
create index if not exists sgr_open_idx
  on public.spotify_gameplay_reservations (owner_id, created_at desc) where settled_at is null;
-- Vollstaendig (nicht nur partiell): settle_gameplay_calls und der Aufraeum-
-- Task greifen auch auf bereits abgerechnete Zeilen zu.
create index if not exists sgr_owner_idx
  on public.spotify_gameplay_reservations (owner_id, created_at desc);


-- ===========================================================================
-- 2. Jobs (OHNE FK auf imported_pools - siehe DDL-Reihenfolge)
-- ===========================================================================

create table if not exists public.playlist_import_jobs (
  id                  uuid primary key default gen_random_uuid(),

  -- Eingabe: nur die ID, nie eine URL (SSRF strukturell ausgeschlossen,
  -- "si=..." kann gar nicht erst uebertragen werden).
  playlist_id         text not null check (playlist_id ~ '^[A-Za-z0-9]{22}$'),
  -- Beide Versionen werden beim Insert aus app_config EINGEFROREN.
  pipeline_version    int  not null,
  decision_version    int  not null,

  status              text not null default 'queued'
                        check (status in ('queued','running','succeeded','failed','cancelled')),
  phase               text not null default 'queued'
                        check (phase in ('queued','head','scraping','budget','metadata',
                                         'years','crosscheck','writing','done')),
  not_before          timestamptz,

  -- Lease + Fencing
  worker_id           text,
  lease_expires_at    timestamptz,
  fencing_token       bigint not null default 0,
  -- GETRENNTE Zaehler: nur attempts laeuft gegen max_attempts und wird
  -- AUSSCHLIESSLICH vom Reaper bei Lease-Verlust erhoeht.
  attempts            int    not null default 0,
  deferrals           int    not null default 0,
  -- Aktive Rechenzeit; serverseitig aus heartbeat_at fortgeschrieben.
  active_ms           bigint not null default 0,

  -- Fortschritt (Units = externe Requests)
  phase_done          int not null default 0,
  phase_total         int,
  units_done          int not null default 0,
  units_total         int,
  eta_seconds         int,

  -- Playlist-Kopfdaten aus GET /playlists/{id}
  playlist_name       text,
  playlist_owner      text,
  snapshot_id_before  text,
  snapshot_id_after   text,

  -- Scraper-Vertrag
  expected_entry_count  int,
  extracted_entry_count int,
  scrape_complete       boolean,
  scraper_version       text,
  scrape_warnings       text[],

  -- Wiederverwendungs-KANDIDAT; die Entscheidung faellt erst in Phase `head`.
  reuse_candidate_pool_id uuid,

  -- Ergebnis (FK auf imported_pools wird nachtraeglich ergaenzt)
  pool_id             uuid,
  unique_track_count  int,
  verified_count      int,
  dropped_count       int,
  retention           real,
  result_warning      text,

  -- NUR der Code steht in dieser (fuer Realtime/REST offenen) Zeile.
  -- Technische Details: playlist_import_job_errors.
  error_code          text,

  created_at          timestamptz not null default now(),
  started_at          timestamptz,
  heartbeat_at        timestamptz,
  finished_at         timestamptz,
  -- Erst beim Erreichen eines Endzustands gesetzt: finished_at + 7 Tage.
  purge_after         timestamptz
);

create index if not exists pij_queue_idx
  on public.playlist_import_jobs (status, not_before, created_at)
  where status in ('queued','running');
create unique index if not exists pij_active_playlist_uniq
  on public.playlist_import_jobs (playlist_id)
  where status in ('queued','running');
create index if not exists pij_lease_idx
  on public.playlist_import_jobs (lease_expires_at) where status = 'running';
create index if not exists pij_purge_idx
  on public.playlist_import_jobs (purge_after)
  where status in ('succeeded','failed','cancelled');
-- Indizes fuer die beiden Fremdschluessel auf imported_pools (nachtraeglich in
-- Abschnitt 5 angelegt). Ohne sie kostet jedes Loeschen eines Pools einen
-- Seq-Scan ueber alle Jobs.
create index if not exists pij_pool_idx on public.playlist_import_jobs (pool_id)
  where pool_id is not null;
create index if not exists pij_reuse_candidate_idx
  on public.playlist_import_jobs (reuse_candidate_pool_id)
  where reuse_candidate_pool_id is not null;


-- ===========================================================================
-- 3. Importierte Pools
-- ===========================================================================

create table if not exists public.imported_pools (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  description         text,
  -- Gespiegelt in den eigenen Storage-Bucket, nie Spotifys CDN-URL
  -- (die laeuft laut Doku in unter einem Tag ab).
  icon_url            text,
  spotify_playlist_id text not null,
  snapshot_id         text,
  source_job_id       uuid references public.playlist_import_jobs(id) on delete set null,
  song_count          int  not null,
  pipeline_version    int  not null,
  decision_version    int  not null,
  import_stats        jsonb,
  created_at          timestamptz not null default now(),
  last_used_at        timestamptz not null default now(),
  expires_at          timestamptz not null default now() + interval '30 days'
);

create table if not exists public.imported_pool_members (
  pool_id  uuid not null references public.imported_pools(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (pool_id, owner_id)
);

create table if not exists public.imported_pool_songs (
  id               uuid primary key default gen_random_uuid(),
  pool_id          uuid not null references public.imported_pools(id) on delete cascade,
  position         int  not null,
  title            text not null,
  artist           text not null,
  spotify_track_id text not null,
  release_year     int  not null,
  isrc             text,

  -- Provenienz: woher stammt genau dieses Jahr?
  year_source      text not null
    check (year_source in ('manual_override','musicbrainz','musicbrainz_soft_checked',
                           'musicbrainz_lb_confirmed')),
  decision_status  text not null,
  decision_version int  not null,
  risk_flags       text[],
  mb_recording_id  uuid,
  lookup_versions  jsonb,

  constraint imported_pool_songs_track_uniq unique (pool_id, spotify_track_id)
);

create index if not exists ips_pool_idx  on public.imported_pool_songs (pool_id, position);
create index if not exists ipm_owner_idx on public.imported_pool_members (owner_id);
create index if not exists ip_reuse_idx  on public.imported_pools (spotify_playlist_id, created_at desc);
create index if not exists ip_expiry_idx on public.imported_pools (expires_at);
-- Fremdschluessel ohne Index: jedes Loeschen der Zielzeile fuehrt sonst zu
-- einem Seq-Scan auf der referenzierenden Tabelle (und haelt dabei Sperren).
create index if not exists ip_source_job_idx on public.imported_pools (source_job_id)
  where source_job_id is not null;


-- ===========================================================================
-- 4. Requests, Verlustliste, Fehlerdetails
-- ===========================================================================

create table if not exists public.playlist_import_requests (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.playlist_import_jobs(id) on delete cascade,
  owner_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  app_version  text,
  created_at   timestamptz not null default now(),
  cancelled_at timestamptz,
  unique (job_id, owner_id)
);
create index if not exists pir_owner_idx on public.playlist_import_requests (owner_id, created_at desc);
create index if not exists pir_job_active_idx on public.playlist_import_requests (job_id)
  where cancelled_at is null;


create table if not exists public.playlist_import_dropped_songs (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references public.playlist_import_jobs(id) on delete cascade,
  position         int,
  -- Bestimmt die Darstellung im UI (Track vs. lokale Datei vs. Episode).
  entry_kind       text not null default 'track'
    check (entry_kind in ('track','local_file','episode','unavailable')),
  spotify_track_id text,
  title            text,
  artist           text,
  reason           text not null
    check (reason in ('needs_review','no_isrc','duplicate_track','duplicate_isrc',
                      'local_file','episode','unavailable','metadata_failed',
                      'soft_check_pending')),
  detail           text
);
create index if not exists pids_job_idx on public.playlist_import_dropped_songs (job_id);


-- Technische Fehlerdetails: strikt getrennt, NIE fuer Clients lesbar.
create table if not exists public.playlist_import_job_errors (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references public.playlist_import_jobs(id) on delete cascade,
  error_code text not null,
  detail     text,
  phase      text,
  created_at timestamptz not null default now()
);
create index if not exists pije_job_idx on public.playlist_import_job_errors (job_id);


-- ===========================================================================
-- 5. Gegenrichtung der Fremdschluessel (jetzt existieren beide Tabellen)
-- ===========================================================================
-- "add constraint if not exists" gibt es in Postgres nicht. WICHTIG:
-- pg_constraint.conname ist nicht datenbankweit eindeutig, sondern nur je
-- Relation - die Pruefung MUSS deshalb an conrelid haengen.

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'pij_pool_id_fkey'
                    and conrelid = 'public.playlist_import_jobs'::regclass) then
    alter table public.playlist_import_jobs
      add constraint pij_pool_id_fkey
      foreign key (pool_id) references public.imported_pools(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'pij_reuse_candidate_fkey'
                    and conrelid = 'public.playlist_import_jobs'::regclass) then
    alter table public.playlist_import_jobs
      add constraint pij_reuse_candidate_fkey
      foreign key (reuse_candidate_pool_id) references public.imported_pools(id) on delete set null;
  end if;
end $$;


-- ===========================================================================
-- 6. Verifikations-Caches
-- ===========================================================================

-- Server-Cache fuer GET /v1/tracks/{id}. Schuetzt primaer die KONTOWEITE
-- Spotify-Quote, sekundaer die Laufzeit.
create table if not exists public.spotify_track_metadata (
  spotify_track_id   text primary key check (spotify_track_id ~ '^[A-Za-z0-9]{22}$'),
  title              text not null,
  artist             text not null,
  isrc               text check (isrc is null or isrc ~ '^[A-Z0-9]{12}$'),
  album_name         text,
  album_type         text,
  album_artist       text,
  album_release_date text,
  duration_ms        int,
  track_number       int,
  disc_number        int,
  is_playable        boolean,
  source_version     int not null default 1,
  fetched_at         timestamptz not null default now()
);
create index if not exists stm_isrc_idx on public.spotify_track_metadata (isrc) where isrc is not null;


-- Provider-Lookups, JE PROVIDER eigen versioniert.
create table if not exists public.song_year_lookups (
  provider         text not null check (provider in ('musicbrainz','discogs','listenbrainz')),
  provider_version int  not null,
  lookup_key       text not null,   -- 'isrc:ABCDE1234567' | 'text:<titel>|<artist>'
  status           text not null,   -- ok | uncertain | no_match | error
  year             int,
  entity_id        text,
  match_method     text,
  score            real,
  payload          jsonb,
  checked_at       timestamptz not null default now(),
  primary key (provider, provider_version, lookup_key)
);
create index if not exists syl_stale_idx on public.song_year_lookups (provider, checked_at);


-- Menschliche Uebersteuerung: NUR nach ISRC, ohne Version, ohne Verfall.
create table if not exists public.song_year_manual_overrides (
  isrc   text primary key check (isrc ~ '^[A-Z0-9]{12}$'),
  year   int  not null check (year between 1850 and 2100),
  source text not null check (source in ('curated_pool','review_csv','dashboard')),
  note   text,
  set_at timestamptz not null default now()
);

comment on table public.song_year_manual_overrides is
  'Von Hand bestaetigte Jahre. Bewusst OHNE Versionsspalte: eine Erhoehung der '
  'Lookup- oder Decision-Version darf menschliche Arbeit nie entwerten.';


-- ===========================================================================
-- 7. Row Level Security
-- ===========================================================================

alter table public.app_config                     enable row level security;
alter table public.spotify_api_budget             enable row level security;
alter table public.spotify_quota_signals          enable row level security;
alter table public.spotify_gameplay_reservations  enable row level security;
alter table public.playlist_import_jobs           enable row level security;
alter table public.playlist_import_requests       enable row level security;
alter table public.playlist_import_dropped_songs  enable row level security;
alter table public.playlist_import_job_errors     enable row level security;
alter table public.imported_pools                 enable row level security;
alter table public.imported_pool_members          enable row level security;
alter table public.imported_pool_songs            enable row level security;
alter table public.spotify_track_metadata         enable row level security;
alter table public.song_year_lookups              enable row level security;
alter table public.song_year_manual_overrides     enable row level security;

-- Feature-Flags: weltlesbar (kein Personenbezug), nie schreibbar.
drop policy if exists "app_config_read" on public.app_config;
create policy "app_config_read" on public.app_config for select using (true);

-- Sperrzustand lesbar, damit die App den Cover-Prefetch unterlassen kann.
drop policy if exists "sab_read" on public.spotify_api_budget;
create policy "sab_read" on public.spotify_api_budget for select using (true);

-- Job sichtbar genau dann, wenn ein EIGENER, NICHT STORNIERTER Request auf ihn zeigt.
drop policy if exists "pij_read_own" on public.playlist_import_jobs;
create policy "pij_read_own" on public.playlist_import_jobs
  for select to authenticated using (
    exists (select 1 from public.playlist_import_requests r
             where r.job_id = playlist_import_jobs.id
               and r.owner_id = auth.uid()
               and r.cancelled_at is null)
  );

drop policy if exists "pir_read_own" on public.playlist_import_requests;
create policy "pir_read_own" on public.playlist_import_requests
  for select to authenticated using (owner_id = auth.uid());

-- Verlustliste: dieselbe Bedingung wie beim Job. Ein stornierter Nutzer
-- verliert den Zugriff auf einen von anderen fortgefuehrten Import.
drop policy if exists "pids_read_own" on public.playlist_import_dropped_songs;
create policy "pids_read_own" on public.playlist_import_dropped_songs
  for select to authenticated using (
    exists (select 1 from public.playlist_import_requests r
             where r.job_id = playlist_import_dropped_songs.job_id
               and r.owner_id = auth.uid()
               and r.cancelled_at is null)
  );

drop policy if exists "ip_read_member" on public.imported_pools;
create policy "ip_read_member" on public.imported_pools
  for select to authenticated using (
    exists (select 1 from public.imported_pool_members m
             where m.pool_id = imported_pools.id and m.owner_id = auth.uid())
  );

drop policy if exists "ipm_read_own" on public.imported_pool_members;
create policy "ipm_read_own" on public.imported_pool_members
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists "ips_read_member" on public.imported_pool_songs;
create policy "ips_read_member" on public.imported_pool_songs
  for select to authenticated using (
    exists (select 1 from public.imported_pool_members m
             where m.pool_id = imported_pool_songs.pool_id and m.owner_id = auth.uid())
  );

-- Bewusst KEINE Policy (und keine Grants) fuer:
--   spotify_quota_signals, spotify_gameplay_reservations,
--   playlist_import_job_errors, spotify_track_metadata, song_year_lookups,
--   song_year_manual_overrides
-- -> nur service_role (bypasst RLS) und das Dashboard sehen diese Daten.


-- ===========================================================================
-- 8. Grants und Revokes (explizit, Lektion aus 007)
-- ===========================================================================

grant select on table public.app_config         to anon, authenticated;
grant select on table public.spotify_api_budget to anon, authenticated;

-- SPALTENWEISER Grant: nur was das Fortschritts-UI braucht. Interne
-- Betriebsfelder (worker_id, lease_expires_at, fencing_token, attempts,
-- deferrals, active_ms, reuse_candidate_pool_id, purge_after) bleiben aussen vor.
grant select (
  id, playlist_id, status, phase, not_before,
  phase_done, phase_total, units_done, units_total, eta_seconds,
  playlist_name, playlist_owner,
  expected_entry_count, extracted_entry_count, scrape_complete,
  unique_track_count, verified_count, dropped_count, retention, result_warning,
  pool_id, error_code, created_at, started_at, finished_at
) on table public.playlist_import_jobs to authenticated;

grant select on table public.playlist_import_requests      to authenticated;
grant select on table public.playlist_import_dropped_songs to authenticated;
grant select on table public.imported_pools                to authenticated;
grant select on table public.imported_pool_members         to authenticated;
grant select on table public.imported_pool_songs           to authenticated;

-- Explizite REVOKEs fuer alles, was Clients nie sehen duerfen. Verlaesst sich
-- nicht darauf, dass Default-Privilegien nichts vergeben haben.
revoke all on table public.spotify_quota_signals         from anon, authenticated;
revoke all on table public.spotify_gameplay_reservations from anon, authenticated;
revoke all on table public.playlist_import_job_errors    from anon, authenticated;
revoke all on table public.spotify_track_metadata        from anon, authenticated;
revoke all on table public.song_year_lookups             from anon, authenticated;
revoke all on table public.song_year_manual_overrides    from anon, authenticated;
-- Schreibrechte auf den lesbaren Tabellen ebenfalls explizit entziehen:
-- geschrieben wird ausschliesslich ueber die RPCs weiter unten.
revoke insert, update, delete on table public.app_config                    from anon, authenticated;
revoke insert, update, delete on table public.spotify_api_budget            from anon, authenticated;
revoke insert, update, delete on table public.playlist_import_jobs          from anon, authenticated;
revoke insert, update, delete on table public.playlist_import_requests      from anon, authenticated;
revoke insert, update, delete on table public.playlist_import_dropped_songs from anon, authenticated;
revoke insert, update, delete on table public.imported_pools                from anon, authenticated;
revoke insert, update, delete on table public.imported_pool_members         from anon, authenticated;
revoke insert, update, delete on table public.imported_pool_songs           from anon, authenticated;

grant all on table public.app_config                     to service_role;
grant all on table public.spotify_api_budget             to service_role;
grant all on table public.spotify_quota_signals          to service_role;
grant all on table public.spotify_gameplay_reservations  to service_role;
grant all on table public.playlist_import_jobs           to service_role;
grant all on table public.playlist_import_requests       to service_role;
grant all on table public.playlist_import_dropped_songs  to service_role;
grant all on table public.playlist_import_job_errors     to service_role;
grant all on table public.imported_pools                 to service_role;
grant all on table public.imported_pool_members          to service_role;
grant all on table public.imported_pool_songs            to service_role;
grant all on table public.spotify_track_metadata         to service_role;
grant all on table public.song_year_lookups              to service_role;
grant all on table public.song_year_manual_overrides     to service_role;


-- ===========================================================================
-- 9. Realtime-Publication (bedingt - "add table" ist NICHT idempotent und
--    wuerde eine erneut ausgefuehrte Migration mitsamt Transaktion abbrechen)
-- ===========================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'playlist_import_jobs'
  ) then
    alter publication supabase_realtime add table public.playlist_import_jobs;
  end if;
end $$;


-- ===========================================================================
-- 10. Storage-Bucket fuer gespiegelte Pool-Cover
-- ===========================================================================
-- 010_pool_icons.sql beschreibt den Bucket nur als manuellen Dashboard-Schritt.
-- Hier wird er angelegt, falls er fehlt. Faellt der Upload trotzdem aus,
-- bleibt icon_url null und die App zeigt ihren Fallback-Glyph.

insert into storage.buckets (id, name, public)
values ('pool-icons', 'pool-icons', true)
on conflict (id) do nothing;


-- ===========================================================================
-- 11. Hilfsfunktion: aktive Rechenzeit serverseitig fortschreiben
-- ===========================================================================
-- ENTSCHEIDUNG: active_ms wird IMMER hier berechnet, nie vom Worker uebergeben.
-- Der Worker kann den Wert dadurch weder falsch berechnen noch faelschen, und
-- alle Endzustaende verhalten sich garantiert gleich.

-- WICHTIG: Nur ein LAUFENDER Job hat ueberhaupt eine offene Zeitspanne. Fuer
-- jeden anderen Status wird der gespeicherte Wert unveraendert zurueckgegeben.
-- Sonst faellt die Berechnung bei einem zurueckgestellten Job (queued,
-- heartbeat_at = null) auf started_at zurueck und zaehlt die Laufzeit vor dem
-- Defer beim naechsten Endzustand ein ZWEITES Mal - reproduziert: nach defer
-- 3.600.000 ms, nach anschliessendem cancel 7.211.478 ms statt ~3.600.000 ms.
create or replace function public.pij_active_ms(
  j public.playlist_import_jobs,
  p_until timestamptz default null
) returns bigint
language sql stable as $$
  select case
    when j.status <> 'running' then coalesce(j.active_ms, 0)
    else coalesce(j.active_ms, 0) + greatest(0, (extract(epoch from (
           coalesce(p_until, now())
           - coalesce(j.heartbeat_at, j.started_at, coalesce(p_until, now()))
         )) * 1000)::bigint)
  end;
$$;

revoke all on function public.pij_active_ms(public.playlist_import_jobs, timestamptz)
  from public, anon, authenticated;
-- Streng genommen nicht noetig (die aufrufenden RPCs sind SECURITY DEFINER und
-- laufen mit den Rechten des Eigentuemers), aber der Grant kostet nichts und
-- schliesst die Fehlerklasse "permission denied for function" auch dann aus,
-- wenn spaeter eine Funktion auf SECURITY INVOKER umgestellt wird.
grant execute on function public.pij_active_ms(public.playlist_import_jobs, timestamptz)
  to service_role;


-- ===========================================================================
-- 12. Nutzerseitige RPCs
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- request_playlist_import
--
-- LOCK-REIHENFOLGE (verbindlich):
--   1. GLOBALER Queue-Lock
--   2. app_config ERST DANACH lesen (sonst arbeitet der Request mit einem
--      Config-Snapshot, den ein paralleler Admin-Wechsel ueberholt hat)
--   3. Tagesquote pruefen
--   4. Playlist-Lock
--   5. Insert/Join + Queue-Pruefung
-- ---------------------------------------------------------------------------
create or replace function public.request_playlist_import(p_playlist_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cfg    jsonb;
  v_uid  uuid := auth.uid();
  v_job  uuid;
  v_cand uuid;
  v_pos  int;
  v_new  boolean := false;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_playlist_id is null or p_playlist_id !~ '^[A-Za-z0-9]{22}$' then
    raise exception 'invalid_playlist_id' using errcode = '22023';
  end if;

  -- (1) Globaler Queue-Lock. Er serialisiert nur die millisekundenkurzen
  --     Request-RPCs, nicht die Jobs. Ohne ihn sehen unter READ COMMITTED zwei
  --     parallele Transaktionen fuer VERSCHIEDENE Playlists denselben
  --     Zaehlerstand, fuegen beide ein und committen beide - ohne
  --     nachtraeglichen Abbruch. Gleiches gilt fuer die Tagesquote.
  perform pg_advisory_xact_lock(hashtext('playlist_import:queue'));

  -- (2) Config ERST JETZT lesen (race-frei gegen set_playlist_import_config).
  select value into cfg from app_config where key = 'playlist_import';
  if cfg is null then
    raise exception 'feature_disabled' using errcode = '0A000';
  end if;
  if not coalesce((cfg->>'enabled')::boolean, false) then
    raise exception 'feature_disabled' using errcode = '0A000';
  end if;

  -- (3) Tagesquote je Nutzer - jetzt serialisiert und damit belastbar.
  if (select count(*) from playlist_import_requests
       where owner_id = v_uid and created_at > now() - interval '24 hours')
     >= (cfg->>'max_requests_per_owner_per_day')::int then
    raise exception 'owner_quota_exceeded' using errcode = '53400';
  end if;

  -- (4) Playlist-Lock. Denselben Lock nehmen alle terminalen RPCs vor ihrem
  --     Zustandswechsel - sonst kann ein Worker genau zwischen unserem
  --     DO-NOTHING-Insert und dem folgenden Select den Job terminal setzen.
  perform pg_advisory_xact_lock(hashtext('playlist_import:' || p_playlist_id));

  -- (5a) Wiederverwendungs-KANDIDAT. Der snapshot_id-Vergleich kann hier nicht
  --      stattfinden (dafuer braucht es einen Spotify-Call) und passiert im
  --      Worker, Phase `head`. FOR KEY SHARE haelt die Zeile gegen paralleles
  --      Loeschen fest, damit der Insert unten nicht in einen FK-Fehler laeuft.
  select p.id into v_cand
    from imported_pools p
   where p.spotify_playlist_id = p_playlist_id
     and p.created_at > now() - make_interval(hours => (cfg->>'reuse_pool_hours')::int)
     and p.pipeline_version = (cfg->>'pipeline_version')::int
     and p.decision_version = (cfg->>'decision_version')::int
   order by p.created_at desc
   limit 1
   for key share;

  -- (5b) Queue-Laenge - unter dem globalen Lock jetzt VOR dem Insert pruefbar.
  if not exists (select 1 from playlist_import_jobs
                  where playlist_id = p_playlist_id and status in ('queued','running'))
     and (select count(*) from playlist_import_jobs where status in ('queued','running'))
         >= (cfg->>'max_queue')::int then
    raise exception 'queue_full' using errcode = '53300';
  end if;

  -- (5c) Job atomar anlegen ODER den bestehenden aktiven Job uebernehmen.
  insert into playlist_import_jobs
    (playlist_id, pipeline_version, decision_version, reuse_candidate_pool_id)
  values (p_playlist_id,
          (cfg->>'pipeline_version')::int,
          (cfg->>'decision_version')::int,
          v_cand)
  on conflict (playlist_id) where status in ('queued','running') do nothing
  returning id into v_job;

  if v_job is null then
    select id into v_job from playlist_import_jobs
     where playlist_id = p_playlist_id and status in ('queued','running')
     limit 1;
  else
    v_new := true;
  end if;

  insert into playlist_import_requests (job_id, owner_id) values (v_job, v_uid)
    on conflict (job_id, owner_id) do update set cancelled_at = null;

  select count(*) into v_pos from playlist_import_jobs
   where status = 'queued'
     and created_at <= (select created_at from playlist_import_jobs where id = v_job);

  -- Die rohe UUID eines fremden Pools geht den Client nichts an.
  return jsonb_build_object(
    'job_id',          v_job,
    'joined_existing', not v_new,
    'reuse_possible',  v_cand is not null,
    'queue_position',  v_pos
  );
end; $$;


-- ---------------------------------------------------------------------------
-- cancel_my_playlist_import — TERMINAL-TEMPLATE
--   1. playlist_id ohne schreibenden Row-Lock ermitteln
--   2. Playlist-Advisory-Lock nehmen
--   3. Zeilen DANACH per FOR UPDATE lesen
--   4. Zustand erneut validieren
--   5. Mutation
-- ---------------------------------------------------------------------------
create or replace function public.cancel_my_playlist_import(p_job_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_pl  text;
  j     public.playlist_import_jobs;
  r     public.playlist_import_requests;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- (1) playlist_id OHNE schreibenden Row-Lock
  select playlist_id into v_pl from playlist_import_jobs where id = p_job_id;
  if v_pl is null then return false; end if;

  -- (2) Advisory-Lock VOR jeder Mutation. In v3.2 wurde cancelled_at davor
  --     gesetzt - genau dort lag das Race mit finish_*, das den Request dann
  --     noch als aktiv sehen konnte.
  perform pg_advisory_xact_lock(hashtext('playlist_import:' || v_pl));

  -- (3) Zeilen jetzt erst sperren
  select * into r from playlist_import_requests
   where job_id = p_job_id and owner_id = v_uid for update;
  if not found then return false; end if;

  select * into j from playlist_import_jobs where id = p_job_id for update;
  if not found then return false; end if;

  -- (4) erneut validieren (kann sich zwischen 1 und 3 geaendert haben)
  if r.cancelled_at is not null then
    return true;                      -- idempotent: schon storniert
  end if;

  -- (5) Mutation
  update playlist_import_requests set cancelled_at = now() where id = r.id;

  if j.status in ('queued','running')
     and not exists (select 1 from playlist_import_requests
                      where job_id = p_job_id and cancelled_at is null) then
    update playlist_import_jobs
       set status           = 'cancelled',
           phase            = 'done',
           active_ms        = public.pij_active_ms(j),
           heartbeat_at     = null,
           lease_expires_at = null,
           worker_id        = null,
           fencing_token    = fencing_token + 1,
           finished_at      = now(),
           purge_after      = now() + interval '7 days'
     where id = p_job_id;
  end if;

  return true;
end; $$;


-- ---------------------------------------------------------------------------
-- touch_imported_pool / delete_imported_pool
-- ---------------------------------------------------------------------------
create or replace function public.touch_imported_pool(p_pool_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from imported_pool_members
                  where pool_id = p_pool_id and owner_id = v_uid) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;
  update imported_pools
     set last_used_at = now(),
         expires_at   = greatest(expires_at, now() + interval '30 days')
   where id = p_pool_id;
end; $$;


create or replace function public.delete_imported_pool(p_pool_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_left int;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- Poolzeile ZUERST sperren: sonst koennen zwei gleichzeitige Aufrufe die
  -- letzten beiden Mitgliedschaften loeschen, beide "es sind noch welche da"
  -- sehen und einen mitgliedslosen Pool zuruecklassen.
  perform 1 from imported_pools where id = p_pool_id for update;
  if not found then return false; end if;

  delete from imported_pool_members
   where pool_id = p_pool_id and owner_id = v_uid;
  if not found then return false; end if;

  select count(*) into v_left from imported_pool_members where pool_id = p_pool_id;
  if v_left = 0 then
    -- Songs und Mitgliedschaften haengen am Cascade. Das Storage-Objekt kann
    -- Postgres nicht loeschen - der Aufraeum-Task des Workers raeumt verwaiste
    -- imported/*-Objekte ab (Konzept 10.4).
    delete from imported_pools where id = p_pool_id;
  end if;
  return true;
end; $$;


-- ---------------------------------------------------------------------------
-- reserve_gameplay_calls / settle_gameplay_calls
--
-- Die App reserviert VOR dem Cover-Batch und rechnet danach GENAU DIESE
-- Reservierung ab. Nachtraegliches Melden verlaere genau die Faelle, die
-- zaehlen (App abgeraeumt, Absturz, Netzabbruch mitten im Batch).
-- ---------------------------------------------------------------------------
create or replace function public.reserve_gameplay_calls(p_calls int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb; b public.spotify_api_budget; v_uid uuid := auth.uid();
  v_window interval; v_window_end timestamptz; v_valid_until timestamptz;
  v_ceiling int; v_limit int; v_want int; v_grant int; v_res uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if coalesce(p_calls, 0) <= 0 then
    raise exception 'invalid_call_count' using errcode = '22023';
  end if;

  select value into cfg from app_config where key = 'spotify_budget';
  v_want   := least(p_calls, (cfg->>'max_gameplay_reservation')::int);
  v_window := make_interval(hours => (cfg->>'window_hours')::int);

  select * into b from spotify_api_budget where id = 1 for update;
  if b.window_start < now() - v_window then
    update spotify_api_budget
       set window_start = now(), used_import = 0, used_gameplay = 0, updated_at = now()
     where id = 1 returning * into b;
  end if;
  v_window_end := b.window_start + v_window;

  if b.blocked_until is not null and b.blocked_until > now() then
    return jsonb_build_object('granted', 0, 'reservation_id', null,
                              'reason', 'quota_blocked', 'retry_at', b.blocked_until);
  end if;

  -- FENSTERGRENZE: keine neue Reservierung so kurz vor dem Reset, dass sie
  -- erst nach dem Fensterwechsel verbraucht wuerde - sonst laufen Calls im
  -- neuen Fenster, ohne dort gezaehlt zu sein.
  if now() + make_interval(secs => (cfg->>'reservation_guard_seconds')::int) > v_window_end then
    return jsonb_build_object('granted', 0, 'reservation_id', null,
                              'reason', 'window_closing', 'retry_at', v_window_end);
  end if;

  v_ceiling := least((cfg->>'observed_ceiling')::int,
                     coalesce(b.last_ceiling_observed, (cfg->>'observed_ceiling')::int));
  v_limit   := v_ceiling - (cfg->>'safety_margin')::int;

  -- Das Spiel darf bis an die globale Grenze, aber die Spielreserve gehoert ihm
  -- allein: verbrauchtes Import-Budget bremst es nicht aus.
  v_grant := greatest(0, least(
               v_want,
               (cfg->>'gameplay_reserve')::int - b.used_gameplay,
               v_limit - (b.used_import + b.used_gameplay)));

  if v_grant = 0 then
    return jsonb_build_object('granted', 0, 'reservation_id', null,
                              'reason', 'budget_exhausted', 'retry_at', v_window_end);
  end if;

  update spotify_api_budget
     set used_gameplay = used_gameplay + v_grant, updated_at = now() where id = 1;

  insert into spotify_gameplay_reservations (owner_id, window_start, valid_until, granted)
  values (v_uid, b.window_start,
          least(v_window_end, now() + make_interval(secs => (cfg->>'reservation_valid_seconds')::int)),
          v_grant)
  returning id, valid_until into v_res, v_valid_until;

  -- valid_until UND window_end gehoeren in die Antwort: der Client muss
  -- erkennen koennen, dass seine Reservierung frueher endet als er annimmt,
  -- und den Batch dann abbrechen statt Calls nach dem Fensterwechsel zu
  -- feuern (die das Settlement anschliessend nicht mehr gutschreiben kann).
  return jsonb_build_object('granted', v_grant,
                            'reservation_id', v_res,
                            'valid_until', v_valid_until,
                            'window_end', v_window_end);
end; $$;


create or replace function public.settle_gameplay_calls(p_reservation_id uuid, p_used int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.spotify_gameplay_reservations;
  b public.spotify_api_budget;
  v_uid uuid := auth.uid(); v_release int;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into r from spotify_gameplay_reservations
   where id = p_reservation_id and owner_id = v_uid for update;
  if not found then
    raise exception 'unknown_reservation' using errcode = '22023';  -- auch: fremde Reservierung
  end if;

  if r.settled_at is not null then
    return jsonb_build_object('released', 0, 'already_settled', true);  -- idempotent
  end if;

  -- Kein stilles Clamping: ein Wert ausserhalb [0, granted] ist ein Fehler.
  if p_used is null or p_used < 0 or p_used > r.granted then
    raise exception 'invalid_used_count' using errcode = '22023';
  end if;

  v_release := r.granted - p_used;

  update spotify_gameplay_reservations
     set used = p_used, settled_at = now() where id = r.id;

  select * into b from spotify_api_budget where id = 1 for update;

  -- Fenster- UND Gueltigkeitsbindung: nach einem Fensterwechsel sind die
  -- Zaehler bereits auf 0, eine alte Reservierung darf dann nichts freigeben.
  if v_release > 0 and b.window_start = r.window_start and now() <= r.valid_until then
    update spotify_api_budget
       set used_gameplay = greatest(0, used_gameplay - v_release), updated_at = now()
     where id = 1;
  else
    v_release := 0;
  end if;

  return jsonb_build_object('released', v_release, 'already_settled', false);
end; $$;


-- ---------------------------------------------------------------------------
-- report_spotify_quota_signal
--
-- Setzt AUSSCHLIESSLICH die Import-Sperre, nie die globale: ein von jedem
-- angemeldeten Client erreichbarer globaler Breaker waere ein Ein-Zeilen-DoS
-- gegen laufende Partien.
-- ---------------------------------------------------------------------------
create or replace function public.report_spotify_quota_signal(p_reason text, p_retry_after_s int)
returns void
language plpgsql security definer set search_path = public as $$
declare cfg jsonb; v_uid uuid := auth.uid(); v_s int;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select value into cfg from app_config where key = 'spotify_budget';

  if (select count(*) from spotify_quota_signals
       where owner_id = v_uid and created_at > now() - interval '1 hour')
     >= (cfg->>'max_quota_signals_per_hour')::int then
    return;                                  -- still verwerfen, kein Fehler an den Client
  end if;

  v_s := least(greatest(coalesce(p_retry_after_s, 0), 60), 4 * 3600);

  insert into spotify_quota_signals (owner_id, retry_after_s, reason)
  values (v_uid, v_s, left(coalesce(p_reason, ''), 64));

  update spotify_api_budget
     set import_blocked_until = greatest(coalesce(import_blocked_until, now()),
                                         now() + make_interval(secs => v_s)),
         updated_at = now()
   where id = 1;
end; $$;


-- ===========================================================================
-- 13. Worker-seitige RPCs (service_role)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- claim_playlist_import_job
--   - setzt min_worker_version tatsaechlich durch
--   - erhoeht fencing_token bei JEDEM Claim (korrekt)
--   - erhoeht attempts NICHT: ein Claim nach einem Budget-Deferral ist kein
--     Fehlversuch. attempts gehoert allein dem Reaper.
-- ---------------------------------------------------------------------------
create or replace function public.claim_playlist_import_job(
  p_worker_id text, p_worker_version int
) returns public.playlist_import_jobs
language plpgsql security definer set search_path = public as $$
declare cfg jsonb; j public.playlist_import_jobs;
begin
  select value into cfg from app_config where key = 'playlist_import';
  if not coalesce((cfg->>'enabled')::boolean, false) then
    return null;
  end if;
  if coalesce(p_worker_version, 0) < (cfg->>'min_worker_version')::int then
    raise exception 'worker_version_too_old' using errcode = '0A000';
  end if;

  select * into j from playlist_import_jobs
   where status = 'queued'
     and (not_before is null or not_before <= now())
   order by created_at
   limit 1
   for update skip locked;
  if not found then return null; end if;

  update playlist_import_jobs
     set status           = 'running',
         fencing_token    = fencing_token + 1,
         worker_id        = p_worker_id,
         started_at       = coalesce(started_at, now()),
         heartbeat_at     = now(),
         lease_expires_at = now() + make_interval(secs => (cfg->>'job_lease_seconds')::int),
         not_before       = null
   where id = j.id
   returning * into j;

  return j;
end; $$;


-- ---------------------------------------------------------------------------
-- heartbeat_playlist_import_job — Lease verlaengern, Fortschritt schreiben,
-- active_ms serverseitig fortschreiben.
-- ---------------------------------------------------------------------------
create or replace function public.heartbeat_playlist_import_job(
  p_job_id uuid, p_fencing bigint, p_phase text default null,
  p_progress jsonb default '{}'::jsonb
) returns bigint
language plpgsql security definer set search_path = public as $$
declare cfg jsonb; j public.playlist_import_jobs; v_active bigint;
begin
  select value into cfg from app_config where key = 'playlist_import';

  select * into j from playlist_import_jobs where id = p_job_id for update;
  if not found or j.fencing_token <> p_fencing or j.status <> 'running' then
    raise exception 'stale_fencing_token' using errcode = '55000';
  end if;

  v_active := public.pij_active_ms(j);

  update playlist_import_jobs
     set active_ms             = v_active,
         heartbeat_at          = now(),
         lease_expires_at      = now() + make_interval(secs => (cfg->>'job_lease_seconds')::int),
         phase                 = coalesce(p_phase, phase),
         phase_done            = coalesce((p_progress->>'phase_done')::int, phase_done),
         phase_total           = coalesce((p_progress->>'phase_total')::int, phase_total),
         units_done            = coalesce((p_progress->>'units_done')::int, units_done),
         units_total           = coalesce((p_progress->>'units_total')::int, units_total),
         eta_seconds           = coalesce((p_progress->>'eta_seconds')::int, eta_seconds),
         playlist_name         = coalesce(p_progress->>'playlist_name', playlist_name),
         playlist_owner        = coalesce(p_progress->>'playlist_owner', playlist_owner),
         snapshot_id_before    = coalesce(p_progress->>'snapshot_id_before', snapshot_id_before),
         expected_entry_count  = coalesce((p_progress->>'expected_entry_count')::int, expected_entry_count),
         extracted_entry_count = coalesce((p_progress->>'extracted_entry_count')::int, extracted_entry_count),
         scrape_complete       = coalesce((p_progress->>'scrape_complete')::boolean, scrape_complete),
         scraper_version       = coalesce(p_progress->>'scraper_version', scraper_version),
         unique_track_count    = coalesce((p_progress->>'unique_track_count')::int, unique_track_count)
   where id = p_job_id;

  return v_active;
end; $$;


-- ---------------------------------------------------------------------------
-- reserve_spotify_calls — TERMINAL-TEMPLATE fuer die Job-Validierung.
-- Das Fencing-Token wird NACH dem Advisory-Lock und unter FOR UPDATE geprueft;
-- in v3.2 lag die Pruefung davor, sodass ein zwischenzeitlich terminalisierter
-- Job noch Budget reservieren konnte.
-- ---------------------------------------------------------------------------
create or replace function public.reserve_spotify_calls(
  p_job_id uuid, p_fencing bigint, p_calls int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb; b public.spotify_api_budget; j public.playlist_import_jobs;
  v_pl text; v_window interval; v_window_end timestamptz;
  v_ceiling int; v_limit int; v_import_cap int;
begin
  if coalesce(p_calls, 0) <= 0 then
    raise exception 'invalid_call_count' using errcode = '22023';
  end if;

  -- (1) playlist_id ohne schreibenden Row-Lock
  select playlist_id into v_pl from playlist_import_jobs where id = p_job_id;
  if v_pl is null then
    raise exception 'unknown_job' using errcode = '22023';
  end if;
  -- (2) Playlist-Lock
  perform pg_advisory_xact_lock(hashtext('playlist_import:' || v_pl));
  -- (3) Zeile danach sperren
  select * into j from playlist_import_jobs where id = p_job_id for update;
  -- (4) erneut validieren
  if not found or j.fencing_token <> p_fencing or j.status <> 'running'
     or j.lease_expires_at is null or j.lease_expires_at < now() then
    raise exception 'stale_fencing_token' using errcode = '55000';
  end if;

  -- (5) Budget
  select value into cfg from app_config where key = 'spotify_budget';
  v_window := make_interval(hours => (cfg->>'window_hours')::int);

  select * into b from spotify_api_budget where id = 1 for update;
  if b.window_start < now() - v_window then
    update spotify_api_budget
       set window_start = now(), used_import = 0, used_gameplay = 0, updated_at = now()
     where id = 1 returning * into b;
  end if;
  v_window_end := b.window_start + v_window;

  if b.blocked_until is not null and b.blocked_until > now() then
    return jsonb_build_object('granted', false, 'reason', 'quota_blocked',
                              'retry_at', b.blocked_until);
  end if;
  if b.import_blocked_until is not null and b.import_blocked_until > now() then
    return jsonb_build_object('granted', false, 'reason', 'import_blocked',
                              'retry_at', b.import_blocked_until);
  end if;
  if now() + make_interval(secs => (cfg->>'reservation_guard_seconds')::int) > v_window_end then
    return jsonb_build_object('granted', false, 'reason', 'window_closing',
                              'retry_at', v_window_end);
  end if;

  -- SELBSTKALIBRIERUNG: eine tatsaechlich beobachtete Grenze schlaegt den
  -- konfigurierten Startwert - dauerhaft, nicht nur als Protokoll.
  v_ceiling := least((cfg->>'observed_ceiling')::int,
                     coalesce(b.last_ceiling_observed, (cfg->>'observed_ceiling')::int));
  v_limit   := v_ceiling - (cfg->>'safety_margin')::int;

  -- Der Import-Deckel WANDERT MIT der beobachteten Decke. Ein fixes
  -- import_cap bei gesunkener Decke liesse dem Spiel sonst weniger als die
  -- zugesagte Reserve.
  v_import_cap := least((cfg->>'import_cap')::int,
                        greatest(0, v_limit - (cfg->>'gameplay_reserve')::int));

  if b.used_import + p_calls > v_import_cap
     or b.used_import + b.used_gameplay + p_calls > v_limit then
    return jsonb_build_object('granted', false, 'reason', 'budget_exhausted',
                              'retry_at', v_window_end,
                              'limit', v_limit, 'import_cap', v_import_cap,
                              'used', b.used_import + b.used_gameplay);
  end if;

  update spotify_api_budget
     set used_import = used_import + p_calls, updated_at = now() where id = 1;

  return jsonb_build_object('granted', true, 'window_end', v_window_end);
end; $$;


-- ---------------------------------------------------------------------------
-- record_spotify_quota_block — globale Sperre + Selbstkalibrierung
-- ---------------------------------------------------------------------------
create or replace function public.record_spotify_quota_block(
  p_retry_after_s int, p_used_observed int default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_s int;
begin
  if p_used_observed is not null and p_used_observed < 0 then
    raise exception 'invalid_used_observed' using errcode = '22023';
  end if;
  v_s := least(greatest(coalesce(p_retry_after_s, 3600), 60), 24 * 3600);
  update spotify_api_budget
     set blocked_until = greatest(coalesce(blocked_until, now()),
                                  now() + make_interval(secs => v_s)),
         blocked_reason = 'QUOTA_EXCEEDED',
         last_ceiling_observed = case
           when p_used_observed is null then last_ceiling_observed
           else least(coalesce(last_ceiling_observed, p_used_observed), p_used_observed)
         end,
         updated_at = now()
   where id = 1;
end; $$;


-- ---------------------------------------------------------------------------
-- defer_playlist_import — TERMINAL-TEMPLATE (kein Fehler, kein attempts)
-- ---------------------------------------------------------------------------
create or replace function public.defer_playlist_import(
  p_job_id uuid, p_fencing bigint, p_not_before timestamptz, p_reason text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_pl text; j public.playlist_import_jobs;
begin
  select playlist_id into v_pl from playlist_import_jobs where id = p_job_id;      -- (1)
  if v_pl is null then
    raise exception 'unknown_job' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('playlist_import:' || v_pl));             -- (2)
  select * into j from playlist_import_jobs where id = p_job_id for update;        -- (3)
  if not found or j.fencing_token <> p_fencing or j.status <> 'running' then       -- (4)
    raise exception 'stale_fencing_token' using errcode = '55000';
  end if;

  update playlist_import_jobs                                                       -- (5)
     set status           = 'queued',
         phase            = 'queued',
         not_before       = greatest(coalesce(p_not_before, now()), now()),
         deferrals        = deferrals + 1,
         active_ms        = public.pij_active_ms(j),
         heartbeat_at     = null,
         lease_expires_at = null,
         worker_id        = null,
         fencing_token    = fencing_token + 1
   where id = p_job_id;

  if p_reason is not null then
    insert into playlist_import_job_errors (job_id, error_code, detail, phase)
    values (p_job_id, 'deferred', left(p_reason, 2000), j.phase);
  end if;
end; $$;


-- ---------------------------------------------------------------------------
-- fail_playlist_import — TERMINAL-TEMPLATE, terminaler Fehler ohne Verlustliste
-- ---------------------------------------------------------------------------
create or replace function public.fail_playlist_import(
  p_job_id uuid, p_fencing bigint, p_code text, p_detail text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_pl text; j public.playlist_import_jobs;
begin
  select playlist_id into v_pl from playlist_import_jobs where id = p_job_id;      -- (1)
  if v_pl is null then
    raise exception 'unknown_job' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('playlist_import:' || v_pl));             -- (2)
  select * into j from playlist_import_jobs where id = p_job_id for update;        -- (3)
  if not found or j.fencing_token <> p_fencing or j.status <> 'running' then       -- (4)
    raise exception 'stale_fencing_token' using errcode = '55000';
  end if;

  update playlist_import_jobs                                                       -- (5)
     set status           = 'failed',
         phase            = 'done',
         error_code       = p_code,
         active_ms        = public.pij_active_ms(j),
         heartbeat_at     = null,
         lease_expires_at = null,
         worker_id        = null,
         fencing_token    = fencing_token + 1,
         finished_at      = now(),
         purge_after      = now() + interval '7 days'
   where id = p_job_id;

  -- Technische Details NIE in die Jobzeile.
  insert into playlist_import_job_errors (job_id, error_code, detail, phase)
  values (p_job_id, p_code, left(coalesce(p_detail, ''), 4000), j.phase);
end; $$;


-- ---------------------------------------------------------------------------
-- finish_playlist_import — TERMINAL-TEMPLATE, EINE Transaktion fuer beide
-- Endzustaende mit Verlustliste.
--   p_outcome = 'pool'     -> Pool anlegen, Songs, Mitgliedschaften, Job succeeded
--   p_outcome = 'rejected' -> kein Pool, aber Verlustliste + Kennzahlen,
--                             Job failed (too_much_dropped / too_few_verified)
-- ---------------------------------------------------------------------------
create or replace function public.finish_playlist_import(
  p_job_id   uuid,
  p_fencing  bigint,
  p_outcome  text,
  p_pool     jsonb default null,
  p_songs    jsonb default '[]'::jsonb,
  p_dropped  jsonb default '[]'::jsonb,
  p_stats    jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_pl text; j public.playlist_import_jobs; v_pool uuid;
begin
  -- NULL not in (...) ergibt NULL, nie true - NULL wuerde sonst durchrutschen.
  if p_outcome is null or p_outcome not in ('pool','rejected') then
    raise exception 'invalid_outcome' using errcode = '22023';
  end if;

  select playlist_id into v_pl from playlist_import_jobs where id = p_job_id;      -- (1)
  if v_pl is null then
    raise exception 'unknown_job' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('playlist_import:' || v_pl));             -- (2)
  select * into j from playlist_import_jobs where id = p_job_id for update;        -- (3)
  if not found or j.fencing_token <> p_fencing or j.status <> 'running' then       -- (4)
    raise exception 'stale_fencing_token' using errcode = '55000';
  end if;

  -- (5) Kein aktiver Request mehr -> nichts anlegen, Job als cancelled beenden.
  if not exists (select 1 from playlist_import_requests
                  where job_id = p_job_id and cancelled_at is null) then
    update playlist_import_jobs
       set status = 'cancelled', phase = 'done',
           active_ms = public.pij_active_ms(j),
           heartbeat_at = null, lease_expires_at = null, worker_id = null,
           fencing_token = fencing_token + 1,
           finished_at = now(), purge_after = now() + interval '7 days'
     where id = p_job_id;
    return null;
  end if;

  if p_outcome = 'pool' then
    insert into imported_pools (
      name, description, icon_url, spotify_playlist_id, snapshot_id,
      source_job_id, song_count, pipeline_version, decision_version, import_stats
    ) values (
      coalesce(nullif(p_pool->>'name',''), 'Importierte Playlist'),
      p_pool->>'description',
      p_pool->>'icon_url',
      v_pl,
      p_pool->>'snapshot_id',
      p_job_id,
      coalesce(jsonb_array_length(p_songs), 0),
      j.pipeline_version,
      j.decision_version,
      coalesce(p_pool->'import_stats', p_stats)
    ) returning id into v_pool;

    insert into imported_pool_songs (
      pool_id, position, title, artist, spotify_track_id, release_year, isrc,
      year_source, decision_status, decision_version, risk_flags,
      mb_recording_id, lookup_versions
    )
    select v_pool, s.position, s.title, s.artist, s.spotify_track_id,
           s.release_year, s.isrc, s.year_source, s.decision_status,
           j.decision_version, s.risk_flags, s.mb_recording_id, s.lookup_versions
      from jsonb_to_recordset(p_songs) as s(
             position int, title text, artist text, spotify_track_id text,
             release_year int, isrc text, year_source text, decision_status text,
             risk_flags text[], mb_recording_id uuid, lookup_versions jsonb);

    -- Mitgliedschaft fuer ALLE aktiven Requester (geteilter Job, Konzept 4.3).
    insert into imported_pool_members (pool_id, owner_id)
    select v_pool, r.owner_id
      from playlist_import_requests r
     where r.job_id = p_job_id and r.cancelled_at is null
    on conflict do nothing;
  end if;

  -- Verlustliste in BEIDEN Faellen - gerade der Ablehnungsfall braucht sie.
  insert into playlist_import_dropped_songs (
    job_id, position, entry_kind, spotify_track_id, title, artist, reason, detail
  )
  select p_job_id, d.position, coalesce(d.entry_kind, 'track'), d.spotify_track_id,
         d.title, d.artist, d.reason, d.detail
    from jsonb_to_recordset(p_dropped) as d(
           position int, entry_kind text, spotify_track_id text,
           title text, artist text, reason text, detail text);

  update playlist_import_jobs
     set status = case when p_outcome = 'pool' then 'succeeded' else 'failed' end,
         phase  = 'done',
         pool_id = v_pool,
         snapshot_id_after  = coalesce(p_stats->>'snapshot_id_after', snapshot_id_after),
         unique_track_count = coalesce((p_stats->>'unique_track_count')::int, unique_track_count),
         verified_count     = coalesce((p_stats->>'verified_count')::int, verified_count),
         dropped_count      = coalesce((p_stats->>'dropped_count')::int,
                                       jsonb_array_length(p_dropped)),
         retention          = coalesce((p_stats->>'retention')::real, retention),
         result_warning     = p_stats->>'result_warning',
         error_code         = case when p_outcome = 'rejected'
                                   then coalesce(p_stats->>'error_code', 'too_much_dropped')
                                   else null end,
         active_ms          = public.pij_active_ms(j),
         heartbeat_at = null, lease_expires_at = null, worker_id = null,
         fencing_token = fencing_token + 1,
         finished_at = now(), purge_after = now() + interval '7 days'
   where id = p_job_id;

  return v_pool;
end; $$;


-- ---------------------------------------------------------------------------
-- finish_playlist_import_reuse — TERMINAL-TEMPLATE, Wiederverwendung nach
-- bestandener Snapshot-/Versionspruefung (ein einziger Spotify-Call).
-- ---------------------------------------------------------------------------
create or replace function public.finish_playlist_import_reuse(
  p_job_id uuid, p_fencing bigint, p_pool_id uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_pl text; j public.playlist_import_jobs; v_count int;
begin
  select playlist_id into v_pl from playlist_import_jobs where id = p_job_id;      -- (1)
  if v_pl is null then
    raise exception 'unknown_job' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('playlist_import:' || v_pl));             -- (2)
  select * into j from playlist_import_jobs where id = p_job_id for update;        -- (3)
  if not found or j.fencing_token <> p_fencing or j.status <> 'running' then       -- (4)
    raise exception 'stale_fencing_token' using errcode = '55000';
  end if;

  -- Nur GENAU der Pool, den request_playlist_import als Kandidat eingetragen
  -- hat. Ohne diese Bindung koennte ein Worker-Bug einen beliebigen fremden
  -- Pool anhaengen - und damit fremde Mitgliedschaften vergeben.
  if j.reuse_candidate_pool_id is null
     or p_pool_id is distinct from j.reuse_candidate_pool_id then
    raise exception 'pool_not_reuse_candidate' using errcode = '22023';
  end if;

  -- Pool muss (noch) existieren und darf waehrenddessen nicht verschwinden.
  perform 1 from imported_pools where id = p_pool_id for key share;
  if not found then
    raise exception 'unknown_pool' using errcode = '22023';
  end if;

  if not exists (select 1 from playlist_import_requests
                  where job_id = p_job_id and cancelled_at is null) then
    update playlist_import_jobs
       set status = 'cancelled', phase = 'done',
           active_ms = public.pij_active_ms(j),
           heartbeat_at = null, lease_expires_at = null, worker_id = null,
           fencing_token = fencing_token + 1,
           finished_at = now(), purge_after = now() + interval '7 days'
     where id = p_job_id;
    return null;
  end if;

  insert into imported_pool_members (pool_id, owner_id)
  select p_pool_id, r.owner_id
    from playlist_import_requests r
   where r.job_id = p_job_id and r.cancelled_at is null
  on conflict do nothing;

  update imported_pools
     set last_used_at = now(),
         expires_at   = greatest(expires_at, now() + interval '30 days')
   where id = p_pool_id;

  select song_count into v_count from imported_pools where id = p_pool_id;

  update playlist_import_jobs
     set status = 'succeeded', phase = 'done',
         pool_id = p_pool_id,
         verified_count = coalesce(verified_count, v_count),
         result_warning = 'reused_pool',
         active_ms = public.pij_active_ms(j),
         heartbeat_at = null, lease_expires_at = null, worker_id = null,
         fencing_token = fencing_token + 1,
         finished_at = now(), purge_after = now() + interval '7 days'
   where id = p_job_id;

  return p_pool_id;
end; $$;


-- ---------------------------------------------------------------------------
-- reap_playlist_import_jobs — verwaiste Leases und ueberschrittene Rechenzeit.
-- attempts wird HIER und nur hier erhoeht. Terminale Zweige setzen finished_at
-- und purge_after, sonst raeumt purge_playlist_import_jobs sie nie ab.
-- ---------------------------------------------------------------------------
create or replace function public.reap_playlist_import_jobs()
returns int
language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb; r record; j public.playlist_import_jobs;
  v_timeout_ms bigint; v_max int; n int := 0;
begin
  select value into cfg from app_config where key = 'playlist_import';
  v_timeout_ms := (cfg->>'job_active_timeout_s')::bigint * 1000;
  v_max        := (cfg->>'max_attempts')::int;

  for r in
    select pij.id, pij.playlist_id
      from playlist_import_jobs pij
     where pij.status = 'running'
       and (pij.lease_expires_at < now()
            or public.pij_active_ms(pij) > v_timeout_ms)
     order by pij.lease_expires_at
     limit 50
  loop
    perform pg_advisory_xact_lock(hashtext('playlist_import:' || r.playlist_id));  -- (2)
    select * into j from playlist_import_jobs where id = r.id for update;          -- (3)
    continue when not found or j.status <> 'running';                              -- (4)

    -- (4b) Lease UND Laufzeit ERNEUT auswerten. Zwischen der Auswahl oben und
    -- dem Advisory-Lock koennen Minuten liegen - in denen ein
    -- heartbeat_playlist_import_job die Lease laengst erneuert haben kann.
    -- Ohne diese zweite Pruefung terminalisiert der Reaper einen Job, der
    -- gerade wieder gesund ist (reproduziert: status=failed trotz gueltiger Lease).
    continue when (j.lease_expires_at is not null and j.lease_expires_at >= now())
                  and public.pij_active_ms(j) <= v_timeout_ms;

    if j.lease_expires_at is not null and j.lease_expires_at < now() then
      -- Lease-Verlust: der einzige echte Fehlversuch.
      if j.attempts + 1 < v_max then
        update playlist_import_jobs
           set status = 'queued', phase = 'queued',
               attempts = attempts + 1,
               active_ms = public.pij_active_ms(j, j.lease_expires_at),
               heartbeat_at = null, lease_expires_at = null, worker_id = null,
               fencing_token = fencing_token + 1,
               not_before = now() + make_interval(secs => 30 * (j.attempts + 1))
         where id = j.id;
      else
        update playlist_import_jobs
           set status = 'failed', phase = 'done',
               attempts = attempts + 1, error_code = 'worker_lost',
               active_ms = public.pij_active_ms(j, j.lease_expires_at),
               heartbeat_at = null, lease_expires_at = null, worker_id = null,
               fencing_token = fencing_token + 1,
               finished_at = now(), purge_after = now() + interval '7 days'
         where id = j.id;
        insert into playlist_import_job_errors (job_id, error_code, detail, phase)
        values (j.id, 'worker_lost', 'lease expired, max_attempts reached', j.phase);
      end if;
    else
      -- Aktive Rechenzeit ueberschritten: terminal, kein Requeue.
      update playlist_import_jobs
         set status = 'failed', phase = 'done', error_code = 'job_timeout',
             active_ms = public.pij_active_ms(j),
             heartbeat_at = null, lease_expires_at = null, worker_id = null,
             fencing_token = fencing_token + 1,
             finished_at = now(), purge_after = now() + interval '7 days'
       where id = j.id;
      insert into playlist_import_job_errors (job_id, error_code, detail, phase)
      values (j.id, 'job_timeout', 'active compute time exceeded', j.phase);
    end if;

    n := n + 1;
  end loop;

  return n;
end; $$;


-- ---------------------------------------------------------------------------
-- purge_playlist_import_jobs — NUR terminale Zustaende.
-- ---------------------------------------------------------------------------
create or replace function public.purge_playlist_import_jobs()
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with gone as (
    delete from playlist_import_jobs
     where status in ('succeeded','failed','cancelled')
       and purge_after is not null
       and purge_after < now()
    returning 1
  )
  select count(*) into n from gone;

  delete from spotify_quota_signals         where created_at < now() - interval '24 hours';
  delete from spotify_gameplay_reservations where created_at < now() - interval '24 hours';

  return n;
end; $$;


-- ---------------------------------------------------------------------------
-- set_playlist_import_config — der EINZIGE Schreibweg auf app_config.
-- Nimmt denselben globalen Queue-Lock wie request_playlist_import und setzt
-- "Versionswechsel nur bei leerer Queue" tatsaechlich durch.
--
-- ABWEICHUNG (bewusst): enabled/scraper_enabled duerfen JEDERZEIT gesetzt
-- werden, auch bei gefuellter Queue. Ein Kill-Switch, der auf eine leere Queue
-- warten muss, ist im Ernstfall keiner - und er verhindert nur NEUE Jobs,
-- veraendert also nichts an bereits eingefrorenen Job-Versionen.
-- ---------------------------------------------------------------------------
create or replace function public.set_playlist_import_config(p_patch jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare cfg jsonb; v_active int; v_touches_version boolean;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'invalid_patch' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('playlist_import:queue'));

  v_touches_version := (p_patch ? 'pipeline_version') or (p_patch ? 'decision_version');

  if v_touches_version then
    select count(*) into v_active from playlist_import_jobs
     where status in ('queued','running');
    if v_active > 0 then
      raise exception 'queue_not_empty' using errcode = '55006';
    end if;
  end if;

  update app_config
     set value = value || p_patch, updated_at = now()
   where key = 'playlist_import'
   returning value into cfg;

  return cfg;
end; $$;


-- ===========================================================================
-- 14. Funktions-Grants und -Revokes
-- ===========================================================================

-- Nutzerseitig
revoke all on function public.request_playlist_import(text)                 from public;
revoke all on function public.cancel_my_playlist_import(uuid)               from public;
revoke all on function public.touch_imported_pool(uuid)                     from public;
revoke all on function public.delete_imported_pool(uuid)                    from public;
revoke all on function public.reserve_gameplay_calls(int)                   from public;
revoke all on function public.settle_gameplay_calls(uuid,int)               from public;
revoke all on function public.report_spotify_quota_signal(text,int)         from public;

grant execute on function public.request_playlist_import(text)              to authenticated;
grant execute on function public.cancel_my_playlist_import(uuid)            to authenticated;
grant execute on function public.touch_imported_pool(uuid)                  to authenticated;
grant execute on function public.delete_imported_pool(uuid)                 to authenticated;
grant execute on function public.reserve_gameplay_calls(int)                to authenticated;
grant execute on function public.settle_gameplay_calls(uuid,int)            to authenticated;
grant execute on function public.report_spotify_quota_signal(text,int)      to authenticated;

-- Worker-seitig: erst fuer ALLE entziehen ...
revoke all on function public.claim_playlist_import_job(text,int)                    from public, anon, authenticated;
revoke all on function public.heartbeat_playlist_import_job(uuid,bigint,text,jsonb)  from public, anon, authenticated;
revoke all on function public.reserve_spotify_calls(uuid,bigint,int)                 from public, anon, authenticated;
revoke all on function public.record_spotify_quota_block(int,int)                    from public, anon, authenticated;
revoke all on function public.defer_playlist_import(uuid,bigint,timestamptz,text)    from public, anon, authenticated;
revoke all on function public.fail_playlist_import(uuid,bigint,text,text)            from public, anon, authenticated;
revoke all on function public.finish_playlist_import(uuid,bigint,text,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.finish_playlist_import_reuse(uuid,bigint,uuid)         from public, anon, authenticated;
revoke all on function public.reap_playlist_import_jobs()                            from public, anon, authenticated;
revoke all on function public.purge_playlist_import_jobs()                           from public, anon, authenticated;
revoke all on function public.set_playlist_import_config(jsonb)                      from public, anon, authenticated;

-- ... und DANACH gezielt an service_role vergeben.
-- ACHTUNG: service_role umgeht RLS, aber NICHT die Funktionsrechte. "revoke all
-- ... from public" nimmt das Default-EXECUTE weg, das PostgreSQL jeder neuen
-- Funktion an PUBLIC gibt - ohne die folgenden Grants scheitert jeder
-- Worker-Aufruf mit "permission denied for function".
grant execute on function public.claim_playlist_import_job(text,int)                    to service_role;
grant execute on function public.heartbeat_playlist_import_job(uuid,bigint,text,jsonb)  to service_role;
grant execute on function public.reserve_spotify_calls(uuid,bigint,int)                 to service_role;
grant execute on function public.record_spotify_quota_block(int,int)                    to service_role;
grant execute on function public.defer_playlist_import(uuid,bigint,timestamptz,text)    to service_role;
grant execute on function public.fail_playlist_import(uuid,bigint,text,text)            to service_role;
grant execute on function public.finish_playlist_import(uuid,bigint,text,jsonb,jsonb,jsonb,jsonb) to service_role;
grant execute on function public.finish_playlist_import_reuse(uuid,bigint,uuid)         to service_role;
grant execute on function public.reap_playlist_import_jobs()                            to service_role;
grant execute on function public.purge_playlist_import_jobs()                           to service_role;
grant execute on function public.set_playlist_import_config(jsonb)                      to service_role;

-- Die nutzerseitigen RPCs ruft der Worker nicht auf; service_role bekommt sie
-- trotzdem, damit Wartung/Support ueber das Dashboard moeglich bleibt.
grant execute on function public.request_playlist_import(text)              to service_role;
grant execute on function public.cancel_my_playlist_import(uuid)            to service_role;
grant execute on function public.touch_imported_pool(uuid)                  to service_role;
grant execute on function public.delete_imported_pool(uuid)                 to service_role;
grant execute on function public.reserve_gameplay_calls(int)                to service_role;
grant execute on function public.settle_gameplay_calls(uuid,int)            to service_role;
grant execute on function public.report_spotify_quota_signal(text,int)      to service_role;


-- ===========================================================================
-- FERTIG. Naechster Schritt: 013_seed_song_year_overrides.sql (einmaliger
-- Seed des Verifikations-Caches aus den bereits reviewten pool_songs).
-- Das Feature bleibt bis "set_playlist_import_config('{\"enabled\": true}')"
-- vollstaendig abgeschaltet.
-- ===========================================================================
