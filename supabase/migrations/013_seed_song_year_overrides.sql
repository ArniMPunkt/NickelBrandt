-- NickelBrandt — Einmaliger Seed des Verifikations-Caches aus den bereits
-- kuratierten Pools (Konzept docs/spotify-playlist-import-konzept.md, K6/4.10).
--
-- Run this manually in the Supabase SQL editor, NACH 012_playlist_import.sql.
-- The app does NOT apply migrations itself.
--
-- ===========================================================================
-- WAS DAS HIER TUT
-- ===========================================================================
-- pool_songs enthaelt heute Titel, Artist, Track-ID, release_year und (soweit
-- vorhanden) ISRC - jede dieser Zeilen ist ein von Hand bestaetigtes Jahr aus
-- dem bisherigen Precheck-/Review-Verfahren. Dieser Seed uebernimmt genau
-- diese Handarbeit als manual_year in song_year_manual_overrides.
--
-- Wirkung: Beim Import einer Playlist, die sich mit den kuratierten Pools
-- ueberschneidet, entfaellt fuer die betroffenen Songs der gesamte
-- JAHRES-Lookup - kein MusicBrainz, kein Discogs, kein ListenBrainz.
--
-- PRAEZISIERUNG: Der initiale GET /v1/tracks/{id} entfaellt dadurch NICHT
-- automatisch. Er liefert erst die ISRC, ueber die dieser Cache ueberhaupt
-- gefunden wird - gespart wird er nur, wenn der Track bereits in
-- spotify_track_metadata liegt (eigener Cache, Konzept 4.8). Der Seed
-- verkuerzt also die Laufzeit und spart Fremd-API-Aufrufe; die kontoweite
-- Spotify-Quote schont er nur mittelbar.
--
-- IDEMPOTENT: "on conflict (isrc) do nothing" - ein zweiter Lauf aendert
-- nichts und ueberschreibt insbesondere keine spaeter im Dashboard gepflegten
-- Werte.
--
-- ===========================================================================
-- SCHRITT 1 (VOR dem Insert ausfuehren): Gegenprobe
-- ===========================================================================
-- pool_songs.isrc ist weder eindeutig noch indiziert. Wenn derselbe ISRC in
-- zwei Pools mit UNTERSCHIEDLICHEM Jahr steht, ist mindestens einer der beiden
-- Werte falsch - solche ISRCs werden bewusst NICHT geseedet (ein falsches
-- "manual_year" waere schlimmer als gar keines, weil es nie verfaellt und
-- jeden automatischen Lookup schlaegt).
--
-- Diese Abfrage zuerst laufen lassen und das Ergebnis ansehen: es ist ein
-- kostenloser Qualitaetsbefund ueber die Bestandsdaten.

-- select upper(regexp_replace(ps.isrc, '[^A-Za-z0-9]', '', 'g')) as isrc,
--        min(ps.release_year) as min_year,
--        max(ps.release_year) as max_year,
--        count(*)             as rows,
--        string_agg(distinct ps.title || ' — ' || ps.artist, ' | ') as songs
--   from public.pool_songs ps
--  where ps.isrc is not null
--    and upper(regexp_replace(ps.isrc, '[^A-Za-z0-9]', '', 'g')) ~ '^[A-Z0-9]{12}$'
--  group by 1
-- having min(ps.release_year) <> max(ps.release_year)
--  order by (max(ps.release_year) - min(ps.release_year)) desc;


-- ===========================================================================
-- SCHRITT 2: Seed
-- ===========================================================================

with normalized as (
  select upper(regexp_replace(ps.isrc, '[^A-Za-z0-9]', '', 'g')) as isrc,
         ps.release_year
    from public.pool_songs ps
   where ps.isrc is not null
),
consistent as (
  select n.isrc, min(n.release_year) as year
    from normalized n
   where n.isrc ~ '^[A-Z0-9]{12}$'
   group by n.isrc
  -- Widerspruechliche Jahre werden NICHT geseedet (siehe Schritt 1).
  having min(n.release_year) = max(n.release_year)
)
insert into public.song_year_manual_overrides (isrc, year, source, note)
select c.isrc, c.year, 'curated_pool', 'Seed aus pool_songs, Migration 013'
  from consistent c
on conflict (isrc) do nothing;


-- ===========================================================================
-- SCHRITT 3: Kontrolle
-- ===========================================================================
-- Erwartung: "geseedet" entspricht der Zahl eindeutiger, widerspruchsfreier
-- ISRCs aus pool_songs; "uebersprungen_konflikt" ist die Zeilenzahl aus
-- Schritt 1.

with normalized as (
  select upper(regexp_replace(ps.isrc, '[^A-Za-z0-9]', '', 'g')) as isrc,
         ps.release_year
    from public.pool_songs ps
   where ps.isrc is not null
),
valid as (
  select n.isrc, n.release_year from normalized n where n.isrc ~ '^[A-Z0-9]{12}$'
),
grouped as (
  select v.isrc, min(v.release_year) as min_year, max(v.release_year) as max_year
    from valid v group by v.isrc
)
select
  (select count(*) from public.song_year_manual_overrides
    where source = 'curated_pool')                                      as geseedet,
  -- Nur GUELTIGE ISRCs zaehlen - kaputte Werte sind nie Kandidaten gewesen.
  (select count(*) from grouped)                                        as gueltige_isrcs,
  (select count(*) from grouped where min_year <> max_year)             as uebersprungen_konflikt,
  (select count(*) from normalized where isrc !~ '^[A-Z0-9]{12}$')      as zeilen_mit_ungueltiger_isrc,
  (select count(*) from public.pool_songs where isrc is null)           as pool_songs_ohne_isrc;

-- Erwartung: geseedet = gueltige_isrcs - uebersprungen_konflikt
-- (sofern die Tabelle vorher leer war).
