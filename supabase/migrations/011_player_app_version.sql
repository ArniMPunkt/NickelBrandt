-- NickelBrandt Online — Protokoll-Versions-Gate: App-Version pro Spieler
--
-- Run this manually in the Supabase SQL editor (after 010_pool_icons.sql).
-- The app does NOT apply migrations itself.
--
-- Jedes Gerät schreibt beim Erstellen/Beitreten einer Lobby seine
-- App-Version (Constants.expoConfig?.version) hier hinein. Der Lobby-Screen
-- vergleicht die Werte aller Zeilen live (bestehende lobby_players-Realtime-
-- Subscription) und zeigt eine NICHT-blockierende Warnung, wenn sie
-- voneinander abweichen - z.B. wenn ein Gerät noch einen alten Build fährt,
-- der neuere Logging-/Sync-Logik nicht kennt (siehe frühere Stats-Event-
-- Untersuchung). null = Zeile wurde vor dieser Migration geschrieben (alter
-- Client) - zählt beim Vergleich als eigener "unbekannt"-Stand, nicht als
-- Match mit irgendeiner bekannten Version.
--
-- Nur Party betroffen; Pass & Play ist ein einzelnes Gerät ohne Versions-
-- Mismatch-Möglichkeit, daher keine Änderung dort.

alter table public.lobby_players
  add column if not exists app_version text;

-- RLS / Realtime: unchanged (open policies from 001 + existing publication
-- already cover this column).
