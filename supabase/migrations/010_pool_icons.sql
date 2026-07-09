-- NickelBrandt — Pool-Icons (VORBEREITET, Feature noch nicht umgesetzt).
--
-- Analyse-Ergebnis (Ticket "Pool-Icons"): song_pools hat kein nutzbares
-- Freifeld, also braucht ein individuelles Pool-Icon eine neue Spalte.
-- Diese Datei ist die dafür nötige minimale Schema-Erweiterung — NUR
-- einspielen, wenn/sobald das Icon-Feature tatsächlich gebaut wird.
-- Run manually in the Supabase SQL editor (after 009_song_reports.sql).
--
-- Konzept (geringster Aufwand):
--   - Public-Read Storage-Bucket "pool-icons" im Supabase-Dashboard anlegen
--     (Storage -> New bucket -> public). Kein SQL nötig.
--   - Icon (quadratisch, 168x168 px WebP/PNG) über das Dashboard hochladen,
--     Public-URL kopieren und hier in icon_url eintragen.
--   - App zeigt icon_url wie ein Playlist-Cover; NULL -> bisheriger
--     🎵-Fallback (deckt alle Bestands-Pools ab, bis Arni Icons ergänzt).
--
-- Kein neues Grant/RLS nötig: die Spalte hängt an song_pools, dessen
-- SELECT-Freigabe für anon bereits existiert (Migration 004).

alter table public.song_pools
  add column if not exists icon_url text;

comment on column public.song_pools.icon_url is
  'Public URL des Pool-Icons (Supabase Storage "pool-icons", 168x168 WebP/PNG); NULL = App-Fallback-Glyph.';
