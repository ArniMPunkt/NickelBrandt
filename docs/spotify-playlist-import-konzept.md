# Konzept: Automatischer Song-Pool-Import aus einer öffentlichen Spotify-Playlist

Status: **v4.0 — implementierungsreif** (nach fünf Prüfrunden)
Stand: 2026-07-31
Grundlage: Vorarbeit + Codex-Zweitmeinung (v1), Repo-Abgleich (v2),
gemessene Experimente E1–E4 + Codex-Gesamturteil (v3),
Codex-SQL-/RLS-/Concurrency-Review (v3.1/v3.2),
**Codex-Abschlussreview: Lock-Reihenfolge, Fensterübergänge, Config-Race (v4.0)**

> **Normativ ist ab v4.0 die Migration**, nicht dieses Dokument:
> [`supabase/migrations/012_playlist_import.sql`](../supabase/migrations/012_playlist_import.sql)
> enthält alle Tabellen, RLS-Policies, Grants/Revokes und **sämtliche RPCs mit
> vollständigen, ausführbaren Funktionskörpern**; der einmalige Seed des
> Verifikations-Caches liegt in
> [`013_seed_song_year_overrides.sql`](../supabase/migrations/013_seed_song_year_overrides.sql).
> Dieses Dokument erklärt das Warum und zeigt die entscheidenden Auszüge —
> bei Abweichungen gilt die Migration.

> **Was v4.0 gegenüber v3.2 ändert:** verbindliches Terminal-Template für
> jeden Zustandswechsel und Cancel-Lock-Reihenfolge korrigiert (4.11), keine
> Reservierung mehr über Fenstergrenzen hinweg (4.11), Config-Lesen erst nach
> dem globalen Lock plus Admin-RPC mit erzwungener Leer-Queue-Bedingung (4.11),
> `active_ms` ausnahmslos serverseitig berechnet (4.11/10.2), RLS der
> Verlustliste an `cancelled_at is null` gebunden (4.6). Dazu die
> Aufräumarbeiten in 3.2, 8.3, 9.3, 12.2 und 14.

---

## 0. Kurzfassung

Nutzer fügt eine öffentliche Spotify-Playlist-URL ein → die App legt asynchron
einen verifizierten Song-Pool an, ohne weitere Interaktion.

Der Kernmechanismus ist jetzt **empirisch bestätigt**: Ein Headless-Browser
ermittelt Track-IDs + Reihenfolge, alles Weitere läuft über offizielle APIs
(`GET /v1/tracks/{id}` → MusicBrainz → Discogs/ListenBrainz). Der Job läuft
serverseitig, die App abonniert nur den Fortschritt.

Die Messungen haben aber die **bindende Randbedingung** verschoben. Sie ist
nicht mehr die Frage „geht der Zugriff überhaupt", sondern:

> **Spotify zählt Development-Mode-Kontingente seit dem 23. Juli 2026 pro
> Entwicklerkonto statt pro App. Gemessen: 594 Einzel-Track-Requests bis
> `QUOTA_EXCEEDED` mit ~4 Stunden Sperre — die anschließend auch die
> Cover-Art des laufenden Spiels blockierte.**

Damit ist eine zweite Spotify-App **keine** Isolation mehr (v2 hat das falsch
angenommen), und das Feature ist kapazitätsbegrenzt: realistisch **ein kalter
200-Song-Import pro ~4-Stunden-Fenster**, bei striktem Vorrang für laufende
Partien. Das gesamte Konzept ist darauf ausgelegt: geteiltes Budget-Ledger,
harte Spielreserve, persistenter Circuit Breaker, Kontingentierung nach
erwarteten API-Calls statt nach „Jobs pro Tag".

Was sich gegenüber v2 sonst strukturell geändert hat, steht kompakt in
Abschnitt 2 — jeweils mit Verweis auf den Abschnitt, in dem es **aufgelöst**
ist, nicht als offene Liste.

---

## 1. Empirisch gesicherte Grundlagen (E1–E4)

Alle vier Experimente aus v2/Abschnitt 10 wurden durchgeführt. Ihre Ergebnisse
sind ab hier Fakten, keine Annahmen.

### E1 — Fremde Playlist-Inhalte sind nicht zugänglich; das Fehlerbild ist zweigeteilt

| Aufruf | Ergebnis |
|---|---|
| `GET /playlists/{id}/items` + Client Credentials | **401** „Valid user authentication required" |
| `GET /playlists/{id}/items` + fremder User-PKCE-Token | **403** Forbidden |
| `GET /playlists/{id}` (ohne `/items`) | **200**, aber ohne `tracks`/`items`-Feld |

Die Vorlage aus v1/v2 ist im Ergebnis bestätigt — der Scraper bleibt nötig.
Die Fehlerbehandlung muss aber **401 und 403 gleichermaßen** als „kein Zugriff"
werten. Ein Worker, der nur auf 403 prüft, hält den Client-Credentials-Fall
für einen Auth-Fehler und würde Tokens erneuern statt zum Scraper zu wechseln.
Umgekehrt darf 401 hier **nicht** die übliche „Token abgelaufen"-Retry-Schleife
auslösen. Siehe Fehlertaxonomie (9.4) und `spotify/playlist-access.ts` (7).

### E2 — Playlist-Kopfdaten sind offiziell verfügbar, die Sollzahl nicht

`GET /playlists/{id}` liefert mit Client Credentials `name`, `owner`, `public`,
`images`, **`snapshot_id`** — aber **kein `tracks.total`**.

Konsequenzen, beide eingearbeitet:

- Pool-Name und Pool-Cover kommen offiziell und ohne Scraping (10.4 löst die
  Ablaufproblematik der Bild-URLs).
- `snapshot_id` ist ein billiger, offizieller **Konsistenzanker**: vor und nach
  dem Scrape abgefragt, erkennt er eine Playlist-Änderung während des Laufs
  (6.3).
- Die **Sollzahl für die Vollständigkeitsprüfung muss aus dem Scrape selbst
  kommen** (6.2) — die in v2 vorgesehene Quelle existiert nicht.

### E3 — Kontingente gelten pro Entwicklerkonto (macht K2 aus v2 ungültig)

Seit **23. Juli 2026** zählt Spotify Development-Mode-Quoten pro
**Entwickleraccount**, nicht mehr pro `client_id`.

Gemessen: **594 erfolgreiche Einzel-Track-Requests**, dann `QUOTA_EXCEEDED`
mit **~4 Stunden `Retry-After`**. Die Sperre griff anschließend **auch für
App-Kontrollanfragen** (Cover-Art etc.).

Damit ist die zentrale Maßnahme aus v2 („zweite Spotify-App isoliert den Blast
Radius") **falsch**. Eine zweite App bleibt sinnvoll — für getrennte Secrets,
getrennte Metriken und getrennte kurzfristige Rolling-Limits —, aber das
**Kontingent-Budget ist kontoweit geteilt**. Abschnitt 3 baut das komplette
Budget-Modell darauf auf; es ist der invasivste Teil dieses Konzepts und
berührt als einziger auch bestehenden Spielcode.

### E4 — Der Scraper funktioniert, aber die naive Vollständigkeitsprüfung ist nachweislich falsch

Positiv: 194/194 und 308/308 Einträge, über **drei Läufe exakt reproduzierbar**,
und die **Reihenfolge stimmt mit den kuratierten Referenzdaten überein**.

Kritisch: Die Playlist-Seite enthält **Track-Links außerhalb der Playlist**
(Empfehlungen, „ähnliche Titel", Verlinkungen im Seitenrahmen). Naive
DOM-Sammlung ergab **204 statt 194** bzw. **318 statt 308** Treffer.

Damit ist die in v2 formulierte Bedingung `complete = extracted >= expected`
**nachweislich falsch** — sie hätte in beiden Testfällen fälschlich Erfolg
gemeldet, mit 10 fremden Songs im Pool. Der neue Scraper-Vertrag (Abschnitt 6)
leitet Mitgliedschaft ausschließlich aus **beobachteten Netzwerkantworten** ab
und verlangt **exakte Gleichheit**.

Nicht bewiesen: DOM-Stabilität über die Zeit. Drei Läufe **innerhalb einer
Sitzung** sind kein Beleg für mehrtägige Robustheit. Bleibt als Restrisiko
in 12.1 stehen, ausdrücklich nicht als gelöst markiert.

---

## 2. Was sich gegenüber v2 geändert hat — und wo es aufgelöst ist

| # | Änderung | Aufgelöst in |
|---|---|---|
| 1 | Zweite Spotify-App isoliert **nicht** das Kontingent (E3) → geteiltes Budget-Ledger, Spielreserve, persistenter Breaker, Kontingent nach API-Calls | **3**, 4.9, 4.10 |
| 2 | `using (true)` auf der Job-Tabelle war eine Sicherheitslücke → **Supabase Anonymous Auth**, Besitz über `auth.uid()` | **4.2**, 4.4, 4.5 |
| 3 | „Scale-to-Zero + Pull-Worker" war ein Widerspruch → **dauerhaft laufender Minimal-Consumer** | **10.1** |
| 4 | `song_pools` **nicht** erweitern → eigene Tabellen `imported_pools`/`imported_pool_songs`/`imported_pool_members`, gemeinsame Deck-Logik über einen Service | **4.7**, 9.1 |
| 5 | `manual_year` nicht unter `(isrc, lookup_version)` → eigene Tabelle `song_year_manual_overrides` (nur ISRC), Provider-Lookups getrennt versioniert, Provenienz am Pool-Song | **4.8** |
| 6 | `MIN_VERIFIED_SONGS = 25` war zu klein → zwei Gates: absolute Mindestgröße aus Modus/Spielerzahl/`cardsToWin`, plus Retention-Gate ~85 % | **8.3** |
| 7 | Abnahme „0 abweichende Jahre" allein unzureichend → Adjudikation, Precision/Coverage getrennt, Holdout, Risiko-Segmente | **11** |
| 8 | Scraper-Vollständigkeit `>=` war falsch (E4) → Netzwerk-Herkunft, exakte Gleichheit, Einträge vs. Track-IDs, `snapshot_id`-Anker | **6** |
| 9 | Worker-Absturz konnte Jobs dauerhaft blockieren → Lease, Fencing-Token, Reaper, Max-Attempts | 4.5, **10.2** |
| 10 | Pool-Schreiben war zwei REST-Inserts mit Kompensationslöschung → **eine transaktionale RPC** | 4.11 (`finish_playlist_import`) |
| 11 | Job-Dedup kollidierte mit Cancel → Job (Arbeit) und **Request (Nutzerwunsch)** getrennt | **4.4**, 4.6 |
| 12 | Ergebnis-UI versprach Gründe pro Titel, Schema hatte nur Aggregate → `playlist_import_dropped_songs` | **4.6**, 9.3 |
| 13 | Playlist-Cover-URLs laufen in < 1 Tag ab → Spiegelung in den bestehenden Storage-Bucket | **10.4** |
| 14 | „Ablauf verlängert sich bei Nutzung" war unspezifiziert → `touch_imported_pool`-RPC, konkret verdrahtet | 4.11, **10.5** |

Unverändert gültig aus v2: Portierungsumfang ~600–800 Zeilen statt 2000 (der
Text-Matching-Pfad entfällt, weil wir mit Track-IDs starten), Cache-Seed aus
den kuratierten Pools, und der Policy-Blocker (Spiele-/Trivia-Verbot) als
bewusst akzeptiertes Risiko ohne erneute Diskussion.

---

## 3. Die bindende Randbedingung: das geteilte Spotify-Kontingent

Dieser Abschnitt ersetzt K2 aus v2 vollständig.

### 3.1 Was gemessen wurde und was daraus folgt

- Kontingent gilt **pro Entwicklerkonto**, App-übergreifend (E3).
- Beobachtete Obergrenze: **594** erfolgreiche `GET /v1/tracks/{id}`.
- Danach `QUOTA_EXCEEDED`, `Retry-After` **~4 h**, **auch für die App**.
- Ein kalter 200-Song-Import verbraucht damit rund **ein Drittel** der
  gemessenen Obergrenze; zwei bis drei kalte Importe reißen sie.

Nicht bekannt (bleibt Restrisiko, 12.2): ob das Fenster rollierend oder fix
ist, ob 594 eine harte Konstante oder lastabhängig ist, und ob andere
Endpunkte anders gewichtet werden. Das Modell muss deshalb **messend und
selbstkorrigierend** sein, nicht auf eine feste Zahl vertrauen.

### 3.2 Vier Konsequenzen fürs Design

**(a) Geteiltes Budget-Ledger über App **und** Worker.**
Eine Tabelle `spotify_api_budget` (4.9) führt Buch. **Beide Seiten reservieren
vorab, niemand meldet nachträglich:** der Worker genau einen Call in Phase 1
(den Head-Request) und in Phase 3 die Metadaten plus den späteren
Snapshot-after-Call (5.1), die App ihre Cover-Calls vor
dem Batch (`reserve_gameplay_calls`, 4.11) mit anschließendem, an die Reservierungs-ID
gebundenem `settle_gameplay_calls` für den nicht verbrauchten Rest. Nachträgliches Melden
verliert genau die Fälle, die zählen — App im Hintergrund abgeräumt, Absturz,
Netzabbruch mitten im Batch. Ohne den App-Anteil ist das Ledger blind für den
größten Dauerverbraucher; deshalb ist diese Änderung an bestehendem Spielcode
([spotify.ts](../src/services/spotify.ts), Cover-Art-Abschnitt) Teil des
Umfangs und keine Option.

**(b) Harte Spielreserve, die der Import nie anfasst.**
Das Budget zerfällt in drei Teile, die zusammen die beobachtete Decke ergeben:
`gameplay_reserve` (250, nur App) + `import_cap` (220, nur Worker) +
`safety_margin` (124, Puffer) = 594. Die Reserve wirkt damit **strukturell** —
sie steckt in der Aufteilung selbst und wird in der Zulassungsformel nicht noch
einmal abgezogen (4.11). Der Worker kommt bis `import_cap`, solange die
Gesamtsumme unter `Decke − safety_margin` bleibt; die App kommt bis
`gameplay_reserve`, ohne dass verbrauchtes Import-Budget sie ausbremst.
Konsequenz im Betrieb: Ein Import wartet lieber auf das nächste Fenster, als
eine laufende Partie um ihre Cover zu bringen.

**(c) Persistenter Circuit Breaker.**
Ein In-Memory-Breaker wie der bestehende in
[spotify.ts:1231-1241](../src/services/spotify.ts#L1231-L1241) überlebt keinen
Neustart und ist pro Gerät blind für die anderen. Bei jedem `QUOTA_EXCEEDED`
schreibt der Entdecker (App oder Worker) `blocked_until = now() + retry_after`
ins Ledger — die App über ein gedeckeltes, rate-limitiertes Signal, das nur die
**Import**-Sperre setzen kann, der Worker über `record_spotify_quota_block` für
die **globale** Sperre (4.11). **Alle** Beteiligten lesen das vor jeder
Batch-Aktion:

- Worker: nimmt keinen Job an, solange `blocked_until` **oder**
  `import_blocked_until` in der Zukunft liegt.
- App: startet den Cover-Prefetch gar nicht erst — das spart die heutige
  429-Salve inklusive Breaker-Strikes und macht die Cover-Fallbacks sofort
  sichtbar, statt nach zwei Fehlversuchen.

**(d) Kontingentierung nach erwarteten Calls, nicht nach Jobs.**
`global_per_day = 50` aus v2 ist unbrauchbar: ein einziger kalter Import
verbraucht mehr als die halbe gemessene Kapazität. Ersetzt durch ein
Call-Budget je Fenster (4.1/4.9). Ein Job wird nicht nach Anzahl bewertet,
sondern nach `uncached_track_count` — der erst **nach** dem Scraping feststeht.
Der Ablauf trägt das (Abschnitt 5.2): Scrapen ist billig und quotenfrei, die
Budget-Entscheidung fällt danach, und bei Ablehnung wird der Job mit
`not_before = blocked_until` **requeued**, nicht verworfen.

### 3.3 Was das Feature dadurch realistisch leistet

| Situation | Spotify-Calls | Machbarkeit |
|---|---|---|
| 200 Songs, kalter Cache | ~202 (inkl. 2 Kopf-Calls) | ~1× pro Fenster (`import_cap` 220) |
| 200 Songs, Playlist unverändert schon importiert | 1 (nur Snapshot-Prüfung) | jederzeit |
| 200 Songs, Überschneidung mit kuratierten Pools | 60–150 | mehrmals möglich |
| 50 Songs, kalter Cache | ~50 | mehrmals pro Fenster |

Das ist eine ehrliche Einschränkung, die ins UI gehört (9.2: „Import startet um
ca. 18:40, sobald das Spotify-Kontingent frei ist"), und sie erhöht den Wert
zweier Maßnahmen erheblich: des **Metadaten-Caches** (4.8) und des
**Seeds aus den kuratierten Pools** (4.10).

---

## 4. Datenmodell — Migrations-Entwurf `012_playlist_import.sql`

> Konventionen wie 004/009/010/011: manuell im Supabase-SQL-Editor auszuführen,
> idempotent, `drop policy if exists` vor `create policy`, **explizite** Grants
> (Lektion aus 007), Kommentare an den Spalten. Die App spielt keine
> Migrationen ein.

**DDL-Reihenfolge (verbindlich).** `playlist_import_jobs` und `imported_pools`
referenzieren einander gegenseitig. Ein Skript, das beide Fremdschlüssel inline
deklariert, ist nicht ausführbar — egal welche Tabelle zuerst kommt. Die
Migration legt deshalb in dieser Reihenfolge an:

1. `app_config`, `spotify_api_budget`, `spotify_quota_signals`
2. `playlist_import_jobs` — **ohne** Fremdschlüssel auf `imported_pools`
3. `imported_pools`, `imported_pool_members`, `imported_pool_songs`
   (`source_job_id` darf inline referenzieren, weil Schritt 2 fertig ist)
4. `playlist_import_requests`, `playlist_import_dropped_songs`
5. **`alter table playlist_import_jobs add constraint …`** für `pool_id`
   (idempotent, siehe 4.7)
6. Caches (`spotify_track_metadata`, `song_year_lookups`,
   `song_year_manual_overrides`), Indizes, Policies, Grants, Publication
7. Seed (4.10)

**Grants.** Jede neue Tabelle bekommt ihre Grants **explizit** — für
`service_role` immer, für `authenticated` nur dort, wo die App wirklich liest
(4.4 sogar spaltenweise). 007 dokumentiert, dass Supabases Default-Privilegien
für neue Tabellen nicht verlässlich greifen; das wird hier nicht wiederholt.

### 4.1 `app_config` — Feature-Flags, Kill-Switches, Budgetparameter

```sql
create table if not exists public.app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.app_config (key, value) values
  ('playlist_import', jsonb_build_object(
     'enabled',              false,  -- Kill-Switch gesamt
     'scraper_enabled',      false,  -- getrennt: DOM-Bruch abschalten, Cache-Importe weiterlaufen lassen
     'max_playlist_entries', 200,
     'min_import_songs',     40,     -- absolute Untergrenze, siehe 8.3
     'min_retention',        0.85,
     'hard_min_retention',   0.60,
     'large_pool_threshold', 120,
     'max_queue',            10,
     'max_requests_per_owner_per_day', 5,
     'reuse_pool_hours',     24,
     'job_lease_seconds',    90,
     'max_attempts',         3,     -- gilt NUR fuer attempts (Crash/Lease), nicht fuer deferrals
     'job_active_timeout_s', 900,   -- aktive Rechenzeit, ohne not_before-Wartezeit (5.2)
     'min_worker_version',   1,     -- beim Claim durchgesetzt (4.11)
     'pipeline_version',     1,     -- muss fuer Pool-Wiederverwendung uebereinstimmen
     'decision_version',     1      -- dito; Erhoehung entwertet alte Pools fuer Reuse
  )),
  ('spotify_budget', jsonb_build_object(
     'window_hours',        4,   -- ANNAHME, nicht bestätigt (12.2)
     'observed_ceiling',  594,   -- in EINEM Testlauf beobachtet, kein garantiertes Limit
     'gameplay_reserve',  250,   -- ausschliesslich App/Cover-Art
     'import_cap',        220,   -- Obergrenze Worker je Fenster
     'safety_margin',     124,   -- Puffer gegen die unbekannte Reset-Semantik
     'max_gameplay_reservation', 64,  -- Klammer je reserve_gameplay_calls-Aufruf
     'max_quota_signals_per_hour', 6  -- Missbrauchsbremse fuer Quota-Signale (4.11)
  ))
on conflict (key) do nothing;

alter table public.app_config enable row level security;
drop policy if exists "app_config_read" on public.app_config;
create policy "app_config_read" on public.app_config
  for select using (true);          -- reine Feature-Flags, kein Personenbezug
grant select on table public.app_config to anon, authenticated;
grant all    on table public.app_config to service_role;
```

**Kalibrierung der Budgetwerte (250 / 220 / 124 = 594).** Bewusst konservativer
als in v3 (250 / 300 / 44). Begründung: Die 594 sind eine **in einem einzigen
Testlauf beobachtete** Obergrenze, kein von Spotify zugesichertes Limit; und die
~4 h `Retry-After` können ebenso gut die **Restzeit bis zu einem festen
Reset-Zeitpunkt** gewesen sein wie eine Fenstergröße. Solange die Reset-Semantik
nicht gemessen ist (12.2), trägt der Puffer von 124 eine **um rund 21 % (124/594)
niedrigere reale Grenze**, ohne dass das laufende Spiel etwas merkt.

Fällt die reale Decke **weiter** als das, greift nicht mehr der Startwert,
sondern die Selbstkalibrierung: `effective_import_cap` bewegt sich mit der
beobachteten Decke nach unten und hält die Spielreserve konstant (4.11).

Praktische Folge: Ein kalter Import mit 200 Tracks (+2 Kopf-/Snapshot-Calls =
202) passt weiterhin in ein Fenster, ein zweiter nicht. Das ist die Absicht.

**Entscheidung (§2/#2):** Job- und Pool-Besitz wird über
**Supabase Anonymous Auth** und `auth.uid()` durchgesetzt.

Begründung gegenüber den beiden Alternativen:

| Variante | Besitz per RLS erzwingbar | Realtime möglich | Aufwand |
|---|---|---|---|
| **Anonymous Auth (gewählt)** | ✅ `auth.uid()` in jeder Policy | ✅ authentifizierte Kanäle | App-Client-Konfiguration + Dashboard-Schalter |
| Gehashtes Job-Token | nur über RPC pro Zugriff | ❌ (Realtime prüft den JWT, nicht ein Payload-Feld) → Polling im 2-s-Takt | mittel, aber schlechteres UI |
| Private Broadcast-Kanäle | – | setzt Auth **voraus** | löst das Problem nicht eigenständig |

Nur die erste Variante erzwingt Besitz **in der Datenbank** und behält die
Realtime-Mechanik, die die Lobby bereits nutzt. Die zweite verlagert jeden
Zugriff in eine RPC und degradiert das Fortschritts-UI auf Polling.

Nötige Änderungen:

1. Supabase-Dashboard: Anonymous Sign-ins aktivieren.
2. [supabase.ts:66-72](../src/services/supabase.ts#L66-L72): der Client läuft
   heute mit `persistSession: false, autoRefreshToken: false`. Für eine
   dauerhafte Geräteidentität braucht er einen AsyncStorage-Adapter,
   `persistSession: true`, `autoRefreshToken: true`.
3. Beim App-Start (nur wenn der Import sichtbar ist): `signInAnonymously()`,
   falls keine Session existiert.

**Verträglichkeit mit dem Bestand — geprüft:** Die Policies aus
[001_init.sql:47-51](../supabase/migrations/001_init.sql#L47-L51) sind ohne
`to`-Klausel geschrieben, gelten also für alle Rollen; ein anonym angemeldeter
Nutzer hat die Rolle `authenticated` und fällt weiterhin darunter. Die Policies
aus 004/009 nennen `anon, authenticated` explizit. Es bricht also nichts —
**zu verifizieren bleibt**, dass die Table-Grants für `authenticated` auf allen
Bestandstabellen gesetzt sind (Supabase tut das per Default; 007 zeigt, dass
man sich darauf nicht blind verlassen sollte).

**Bewusste Konsequenz:** Nach Neuinstallation ist die anonyme Identität weg,
damit auch der Zugriff auf eigene importierte Pools. Das ist vertretbar, weil
importierte Pools ohnehin ablaufen (10.5); es gehört in den Hilfetext.

### 4.3 Identitäts- und Besitzmodell im Überblick

```
auth.users (anonym)
   │
   ├─ playlist_import_requests   (owner_id = auth.uid())  ← „ich möchte diese Playlist"
   │        │ n:1
   │        ▼
   │   playlist_import_jobs      (kein owner — geteilte Arbeitseinheit)
   │        │ 1:n
   │        ├─ playlist_import_dropped_songs
   │        ▼
   │   imported_pools            (Zugriff ausschließlich über Mitgliedschaft)
   │        │ 1:n
   │        ├─ imported_pool_songs
   └────────┴─ imported_pool_members (pool_id, owner_id)
```

Die Trennung **Request ≠ Job** löst die Dedup-/Cancel-Kollision (2/#11): Zwei
Nutzer teilen sich dieselbe Arbeit, aber jeder kann nur seinen **eigenen**
Wunsch zurückziehen. Der Job endet erst, wenn kein aktiver Request mehr
existiert.

### 4.4 `playlist_import_jobs` — die geteilte Arbeitseinheit

```sql
create table if not exists public.playlist_import_jobs (
  id                  uuid primary key default gen_random_uuid(),

  -- Eingabe: nur die ID, nie eine URL (SSRF strukturell ausgeschlossen, si=… kann
  -- gar nicht erst übertragen werden)
  playlist_id         text not null check (playlist_id ~ '^[A-Za-z0-9]{22}$'),
  -- BEIDE Versionen werden beim Insert aus app_config eingefroren (4.11) - ohne
  -- das liefe ein laufender Job gegen eine Konfiguration, die sich unter ihm
  -- geaendert haben kann. Kein Default: request_playlist_import setzt sie explizit.
  pipeline_version    int  not null,
  decision_version    int  not null,

  status              text not null default 'queued'
                        check (status in ('queued','running','succeeded','failed','cancelled')),
  phase               text not null default 'queued'
                        check (phase in ('queued','head','scraping','budget','metadata',
                                         'years','crosscheck','writing','done')),
  not_before          timestamptz,   -- Requeue nach Budget-/Sperrfenster (3.2d)

  -- Lease + Fencing (10.2)
  worker_id           text,
  lease_expires_at    timestamptz,
  fencing_token       bigint not null default 0,
  -- GETRENNTE Zaehler: nur `attempts` laeuft gegen max_attempts. Ein Budget-
  -- Requeue ist kein Fehlversuch und darf die Crash-Grenze nicht aufbrauchen.
  attempts            int    not null default 0,   -- Lease-Verlust / Crash / harter Fehler
  deferrals           int    not null default 0,   -- Budget-/Sperr-Requeues, unbegrenzt
  -- Aktive Rechenzeit, per Heartbeat fortgeschrieben. Das Job-Timeout (5.2) misst
  -- DIESE Summe, nicht die Wanduhr - sonst killt ein stundenlanges not_before den Job.
  active_ms           bigint not null default 0,

  -- Fortschritt (Units = externe Requests, siehe 9.2)
  phase_done          int not null default 0,
  phase_total         int,
  units_done          int not null default 0,
  units_total         int,
  eta_seconds         int,

  -- Playlist-Kopfdaten aus GET /playlists/{id} (E2)
  playlist_name       text,
  playlist_owner      text,
  snapshot_id_before  text,
  snapshot_id_after   text,

  -- Scraper-Vertrag (6.2)
  expected_entry_count int,
  extracted_entry_count int,
  scrape_complete      boolean,
  scraper_version      text,
  scrape_warnings      text[],

  -- Wiederverwendungs-KANDIDAT (4.11): die Entscheidung faellt erst in Phase `head`,
  -- weil sie snapshot_id vergleicht - und das kann nur der Worker.
  reuse_candidate_pool_id uuid,

  -- Ergebnis. FK auf imported_pools wird NACHTRAEGLICH ergaenzt (4.7, DDL-Reihenfolge).
  pool_id             uuid,
  unique_track_count  int,
  verified_count      int,
  dropped_count       int,
  retention           real,
  result_warning      text,   -- z.B. 'low_retention'

  -- NUR der Code steht in dieser (fuer Realtime/REST offenen) Zeile. Technische
  -- Details landen in playlist_import_job_errors (service_role only, s.u.):
  -- ein Laengenlimit begrenzt die Menge, nicht den Informationsgehalt.
  error_code          text,

  created_at          timestamptz not null default now(),
  started_at          timestamptz,
  heartbeat_at        timestamptz,
  finished_at         timestamptz,
  -- Erst beim ERREICHEN eines Endzustands gesetzt (finish_/fail_-RPC): finished_at + 7 Tage.
  -- Kein Default ab created_at - ein lange auf Budget wartender Job darf nicht
  -- vor seinem Abschluss weggeraeumt werden (10.5).
  purge_after         timestamptz
);

create index if not exists pij_queue_idx on public.playlist_import_jobs (status, not_before, created_at)
  where status in ('queued','running');
create unique index if not exists pij_active_playlist_uniq
  on public.playlist_import_jobs (playlist_id) where status in ('queued','running');
create index if not exists pij_lease_idx on public.playlist_import_jobs (lease_expires_at)
  where status = 'running';

alter table public.playlist_import_jobs enable row level security;

-- Sichtbar genau dann, wenn ein EIGENER, NICHT STORNIERTER Request auf diesen
-- Job zeigt. Ohne die cancelled_at-Bedingung behielte ein Nutzer nach dem
-- Zuruecknehmen seines Wunsches weiter Lesezugriff auf den fremd weiterlaufenden Job.
drop policy if exists "pij_read_own" on public.playlist_import_jobs;
create policy "pij_read_own" on public.playlist_import_jobs
  for select to authenticated using (
    exists (select 1 from public.playlist_import_requests r
             where r.job_id = playlist_import_jobs.id
               and r.owner_id = auth.uid()
               and r.cancelled_at is null)
  );

-- SPALTENWEISER Grant: nur was das Fortschritts-UI braucht. Interne Betriebsfelder
-- (worker_id, lease_expires_at, fencing_token, attempts, deferrals, active_ms,
--  reuse_candidate_pool_id, purge_after) bleiben ausgespart.
grant select (
  id, playlist_id, status, phase, not_before,
  phase_done, phase_total, units_done, units_total, eta_seconds,
  playlist_name, playlist_owner,
  expected_entry_count, extracted_entry_count, scrape_complete,
  unique_track_count, verified_count, dropped_count, retention, result_warning,
  pool_id, error_code, created_at, started_at, finished_at
) on table public.playlist_import_jobs to authenticated;

grant all on table public.playlist_import_jobs to service_role;

-- Technische Fehlerdetails: strikt getrennt, NIE fuer Clients lesbar.
create table if not exists public.playlist_import_job_errors (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references public.playlist_import_jobs(id) on delete cascade,
  error_code text not null,
  detail     text,          -- Provider-Antwort, Stack-Fragment, interner Pfad
  phase      text,
  created_at timestamptz not null default now()
);
create index if not exists pije_job_idx on public.playlist_import_job_errors (job_id);
alter table public.playlist_import_job_errors enable row level security;
-- Keine Policy, kein Grant fuer anon/authenticated -> nur service_role + Dashboard.
grant all on table public.playlist_import_job_errors to service_role;

-- Fortschritt per postgres_changes direkt auf der Tabelle (kein View-Umweg).
-- "alter publication ... add table" ist NICHT idempotent und wuerde eine erneut
-- ausgefuehrte Migration mitsamt umgebender Transaktion abbrechen.
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
```

Der Unique-Index über `('queued','running')` bleibt — er kann jetzt aber nicht
mehr dauerhaft blockieren, weil der Reaper (10.2) verwaiste `running`-Jobs
requeued oder abschließt.

> **Wichtig zum Realtime-Payload:** `postgres_changes` wertet die
> SELECT-**Policy** des Abonnenten aus, filtert aber **nicht** spaltenweise —
> ein berechtigter Abonnent bekommt die ganze Zeile. Das ist hier vertretbar und
> zugleich der Grund für den Zuschnitt dieser Tabelle: Sie enthält **keine**
> Eigentümerkennung (die liegt in `playlist_import_requests`), keine IP, keine
> URL mit `si=…` und **keine technischen Fehlerdetails mehr** — nur den
> `error_code`, den die Fehlertaxonomie (9.4) ohnehin in einen deutschen Satz
> übersetzt. Wer die Zeile sehen darf, hat den Import selbst angefordert. Der
> spaltenweise Grant bleibt trotzdem sinnvoll — er deckt den REST-Pfad
> (initiales Laden, Refetch, Polling-Fallback) ab.
>
> **Client-seitig zu erledigen, nicht nur zu dokumentieren:** Die
> Spaltenprojektion bei `postgres_changes` (`select`-Array im Subscription-Filter)
> setzt eine neuere `@supabase/supabase-js` voraus als die derzeit gepinnte
> `^2.108.2` ([package.json](../package.json)) — der Versionssprung gehört in
> Etappe 4 (13), die Subscription bekommt die konkreten Fortschrittsspalten im
> **Code**, und ein Integrationstest prüft die tatsächlich übertragene Payload.
> Solange die Projektion nicht verifiziert ist, gilt die Annahme „ganze Zeile"
> aus dem Absatz oben — deshalb steht in dieser Tabelle nichts, was das nicht
> verträgt.

### 4.5 `playlist_import_requests` — der eigentümergebundene Nutzerwunsch

```sql
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

alter table public.playlist_import_requests enable row level security;

drop policy if exists "pir_read_own" on public.playlist_import_requests;
create policy "pir_read_own" on public.playlist_import_requests
  for select to authenticated using (owner_id = auth.uid());

-- Kein direktes insert/update: beides ausschließlich über die RPCs in 4.11.
grant select on table public.playlist_import_requests to authenticated;
grant all    on table public.playlist_import_requests to service_role;
```

**Fortschritt lesen — direkt auf der Job-Tabelle, ohne View.** Die in v3
vorgesehene `security_invoker`-View war nicht funktionsfähig: Eine solche View
löst Rechte **und** RLS beim aufrufenden Nutzer gegen die **Basistabellen** auf.
Da `playlist_import_jobs` dort weder Grant noch SELECT-Policy für
`authenticated` hatte, hätte die View konstant null Zeilen geliefert. Der
Weckruf-Umweg über `playlist_import_requests` entfällt damit ebenfalls.

Stattdessen: Policy + spaltenweiser Grant + Publication liegen jetzt direkt auf
der Job-Tabelle (4.4), und die App abonniert gefiltert auf die ihr bekannte
Job-ID:

```ts
// 1. initial laden (REST, deckt auch den Kaltstart nach App-Neustart ab)
const { data: job } = await supabase
  .from('playlist_import_jobs')
  .select('id,status,phase,not_before,phase_done,phase_total,units_done,' +
          'units_total,eta_seconds,playlist_name,expected_entry_count,' +
          'extracted_entry_count,unique_track_count,verified_count,' +
          'dropped_count,retention,result_warning,pool_id,error_code')
  .eq('id', jobId).single();

// 2. live folgen
const channel = supabase
  .channel(`import:${jobId}`)
  .on('postgres_changes',
      { event: 'UPDATE', schema: 'public',
        table: 'playlist_import_jobs', filter: `id=eq.${jobId}` },
      ({ new: row }) => onJob(row))
  .subscribe((status) => {
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') startPollingFallback();
  });
```

Verbindliche Regeln für den Client:

- **Initiales Laden vor dem Abo** — sonst fehlt der Stand zwischen Screen-Aufbau
  und erstem Event.
- **Refetch bei Reconnect und App-Resume**: Während der Kanal weg war, sind
  Events verloren gegangen; der REST-Read stellt den Wahrheitsstand her.
- **3-s-Polling nur als Fallback**, wenn der Kanal gar nicht zustande kommt
  (`CHANNEL_ERROR`/`TIMED_OUT`) — nicht dauerhaft parallel zum Abo.
- Nach `status in ('succeeded','failed','cancelled')` Abo und Polling beenden.

Damit ist die offene Entscheidung 14/#3 aus v3 erledigt: Realtime ist der
Normalfall, Polling der Notnagel.

### 4.6 `playlist_import_dropped_songs` — Gründe pro Titel

Löst die Diskrepanz zwischen Ergebnis-UI und Schema (2/#12):

```sql
create table if not exists public.playlist_import_dropped_songs (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references public.playlist_import_jobs(id) on delete cascade,
  position         int,                   -- Position in der Playlist (1-basiert)
  -- Eintragsart: bestimmt, WIE die Zeile im UI dargestellt wird (9.3).
  entry_kind       text not null default 'track'
    check (entry_kind in ('track','local_file','episode','unavailable')),
  spotify_track_id text,                  -- null bei local_file / episode / unavailable
  -- Anzeigedaten. Fuer 'track' aus spotify_track_metadata bzw. dem Scrape;
  -- fuer die uebrigen Arten aus den Anzeigefeldern des Scrapes (6.2) - dort ist
  -- oft nur ein Titel vorhanden, artist kann null sein.
  title            text,
  artist           text,
  reason           text not null
    check (reason in ('needs_review','no_isrc','duplicate_track','duplicate_isrc',
                      'local_file','episode','unavailable','metadata_failed',
                      'soft_check_pending')),
  detail           text                   -- z.B. 'mb_uncertain+catalog_context'
);

create index if not exists pids_job_idx on public.playlist_import_dropped_songs (job_id);

alter table public.playlist_import_dropped_songs enable row level security;

-- Dieselbe Bedingung wie bei der Job-RLS, INKLUSIVE cancelled_at is null: wer
-- seinen Wunsch zurueckzieht, verliert auch den Blick in die Verlustliste eines
-- Imports, den andere fortfuehren.
drop policy if exists "pids_read_own" on public.playlist_import_dropped_songs;
create policy "pids_read_own" on public.playlist_import_dropped_songs
  for select to authenticated using (
    exists (select 1 from public.playlist_import_requests r
             where r.job_id = playlist_import_dropped_songs.job_id
               and r.owner_id = auth.uid()
               and r.cancelled_at is null)
  );

grant select on table public.playlist_import_dropped_songs to authenticated;
grant all    on table public.playlist_import_dropped_songs to service_role;
```

Die Zeilen werden mit dem Job gepurged (`on delete cascade`, 7 Tage) — die
Verlustliste ist ein Ergebnisbericht, kein Dauerarchiv.

### 4.7 `imported_pools` / `imported_pool_songs` / `imported_pool_members`

**Entscheidung (§2/#4):** eigene Tabellen statt Erweiterung von
`song_pools`. `song_pools` ist per
[004:9-23](../supabase/migrations/004_song_pools.sql#L9-L23) bewusst
weltlesbare, kuratierte Referenzdaten; importierte Playlists brauchen
Eigentümer, Sichtbarkeit, Ablauf, Löschung und eine völlig andere RLS. Ein
clientseitiger `source`-Filter wäre **keine** Zugriffskontrolle gewesen.

```sql
create table if not exists public.imported_pools (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  description         text,
  icon_url            text,          -- gespiegelt in eigenen Storage (10.4), nie Spotifys CDN-URL
  spotify_playlist_id text not null,
  snapshot_id         text,
  source_job_id       uuid references public.playlist_import_jobs(id) on delete set null,
  song_count          int  not null,
  pipeline_version    int  not null,
  decision_version    int  not null,
  import_stats        jsonb,         -- {"entries":194,"unique":191,"verified":172,"retention":0.90}
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

  -- Provenienz (§2/#5): woher stammt genau dieses Jahr?
  year_source      text not null
    check (year_source in ('manual_override','musicbrainz','musicbrainz_soft_checked',
                           'musicbrainz_lb_confirmed')),
  decision_status  text not null,
  decision_version int  not null,
  risk_flags       text[],
  mb_recording_id  uuid,
  lookup_versions  jsonb,   -- {"musicbrainz":1,"discogs":1,"listenbrainz":1}

  constraint imported_pool_songs_track_uniq unique (pool_id, spotify_track_id)
);

-- Gegenrichtung des Fremdschluessels: erst JETZT moeglich, weil beide Tabellen
-- existieren (DDL-Reihenfolge, Abschnitt 4). "add constraint if not exists" gibt
-- es in Postgres nicht -> idempotent ueber pg_constraint pruefen. WICHTIG:
-- conname ist nicht datenbankweit eindeutig, sondern nur je Relation - die
-- Pruefung MUSS deshalb zusaetzlich an conrelid haengen, sonst haelt ein
-- gleichnamiger Constraint auf einer anderen Tabelle die Migration faelschlich
-- fuer bereits ausgefuehrt.
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

create index if not exists ips_pool_idx on public.imported_pool_songs (pool_id, position);
create index if not exists ipm_owner_idx on public.imported_pool_members (owner_id);
create index if not exists ip_reuse_idx
  on public.imported_pools (spotify_playlist_id, created_at desc);

alter table public.imported_pools        enable row level security;
alter table public.imported_pool_members enable row level security;
alter table public.imported_pool_songs   enable row level security;

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

grant select on table public.imported_pools, public.imported_pool_members,
                       public.imported_pool_songs to authenticated;
grant all    on table public.imported_pools, public.imported_pool_members,
                       public.imported_pool_songs to service_role;
```

**Doppelte Deck-Logik vermeiden** (ausdrückliche Vorgabe): Nicht die Tabellen
mischen, sondern die App-Seite über **einen** Service abstrahieren.

```ts
// src/services/poolSource.ts  (neu)
export type PoolRef =
  | { kind: 'curated';  id: string }
  | { kind: 'imported'; id: string };

export interface PoolSummary {           // gemeinsame Sicht für Picker + PoolIcon
  ref: PoolRef; name: string; description: string | null;
  iconUrl: string | null; songCount: number | null; expiresAt: string | null;
}

export function listPools(): Promise<PoolSummary[]>;   // beide Quellen, eine Liste
export function loadSongs(ref: PoolRef): Promise<GameCard[]>;
export function poolKey(ref: PoolRef): string;         // "pool:<uuid>" | "import:<uuid>"
```

- [deck.ts](../src/services/deck.ts) bekommt `DeckSource = { kind:'pool'|'import', … }`
  und ruft nur noch `poolSource.loadSongs()`. Die dortige Notiz, die Union sei
  „für eine mögliche zweite Quelle" in Ein-Element-Form belassen worden, wird
  damit eingelöst.
- `PoolIcon`, `poolProgress`, `PlaylistPicker` arbeiten unverändert weiter, weil
  sie nur `PoolSummary`/`poolKey` sehen.
- `song_reports.source_id` bekommt zusätzlich das Präfix `import:<uuid>`; die
  Spalte ist freier Text ohne Check-Constraint
  ([009:31-35](../supabase/migrations/009_song_reports.sql#L31-L35)), also
  keine Migration nötig — nur der Kommentar dort gehört aktualisiert.

**Party-Modus:** Nur das spielende Gerät lädt das Deck
([deck.ts:18-25](../src/services/deck.ts#L18-L25), Aufrufer sind ausschließlich
`SetupScreen` und `LobbyScreen` des Hosts). Gäste brauchen deshalb **keinen**
Lesezugriff auf importierte Pools; die besitzgebundene RLS ist mit dem
Party-Modus verträglich. *(Zu bestätigen, falls sich das Deck-Laden je auf
Gäste ausweitet — dann braucht es einen Mitgliedschafts-Grant an die Lobby.)*

### 4.8 Verifikations-Caches

**§2/#5, aufgelöst in drei Tabellen mit sauber getrennten
Verfallsregeln.**

```sql
-- (1) Spotify-Metadaten: Server-Cache, schützt primär die kontoweite Quote (3.2)
create table if not exists public.spotify_track_metadata (
  spotify_track_id   text primary key check (spotify_track_id ~ '^[A-Za-z0-9]{22}$'),
  title              text not null,
  artist             text not null,      -- alle Künstler, ", "-verbunden (wie pool_songs)
  isrc               text check (isrc is null or isrc ~ '^[A-Z0-9]{12}$'),
  album_name         text,
  album_type         text,               -- album | single | compilation
  album_artist       text,
  album_release_date text,               -- roh: "YYYY" | "YYYY-MM" | "YYYY-MM-DD"
  duration_ms        int,
  track_number       int,
  disc_number        int,
  is_playable        boolean,
  source_version     int not null default 1,
  fetched_at         timestamptz not null default now()
);
create index if not exists stm_isrc_idx on public.spotify_track_metadata (isrc) where isrc is not null;

-- (2) Provider-Lookups: JE PROVIDER eigen versioniert, mit eigenem Schlüsselraum
create table if not exists public.song_year_lookups (
  provider         text not null check (provider in ('musicbrainz','discogs','listenbrainz')),
  provider_version int  not null,
  lookup_key       text not null,   -- 'isrc:ABCDE1234567' | 'text:<norm-titel>|<norm-artist>'
  status           text not null,   -- ok | uncertain | no_match | error
  year             int,
  entity_id        text,            -- MB-Recording-MBID / Discogs-Release-ID / …
  match_method     text,
  score            real,
  payload          jsonb,           -- normalisierter Kandidat: Neubewertung ohne Netz
  checked_at       timestamptz not null default now(),
  primary key (provider, provider_version, lookup_key)
);
create index if not exists syl_stale_idx on public.song_year_lookups (provider, checked_at);

-- (3) Menschliche Übersteuerung: NUR nach ISRC, ohne Version, ohne Verfall
create table if not exists public.song_year_manual_overrides (
  isrc       text primary key check (isrc ~ '^[A-Z0-9]{12}$'),
  year       int  not null check (year between 1850 and 2100),
  source     text not null check (source in ('curated_pool','review_csv','dashboard')),
  note       text,
  set_at     timestamptz not null default now()
);

alter table public.spotify_track_metadata      enable row level security;
alter table public.song_year_lookups           enable row level security;
alter table public.song_year_manual_overrides  enable row level security;
grant all on table public.spotify_track_metadata,
                    public.song_year_lookups,
                    public.song_year_manual_overrides to service_role;

comment on table public.song_year_manual_overrides is
  'Von Hand bestätigte Jahre. Bewusst OHNE Versionsspalte: eine Erhoehung der Lookup- '
  'oder Decision-Version darf menschliche Arbeit nie entwerten (Fehler in Konzept v2).';
```

Die Trennung von Lookup und Entscheidung aus v2 bleibt gültig und ist der
Grund für den Aufbau: `detect-risk-flags` zieht `catalog_context`/
`compilation_context` aus dem **Spotify-Album-Kontext**
([detect-risk-flags.js:89-155](../scripts/lib/decision/detect-risk-flags.js#L89-L155)),
dieselbe ISRC kann also je nach Album zu einem anderen Ergebnis führen.
Gecacht wird nur der Lookup; die Entscheidung läuft bei jedem Import neu
(rein, ohne Netz) und wird mit `decision_version` am fertigen Pool-Song
protokolliert.

**Auflösungsreihenfolge im Worker:**

1. `song_year_manual_overrides[isrc]` → Jahr steht, `year_source='manual_override'`, keine externen Requests.
2. `song_year_lookups` mit aktueller `provider_version` innerhalb TTL → in `detect-risk-flags`/`decide-year` einspeisen.
3. Sonst Live-Lookup → zurückschreiben.

TTL: `status='ok'` 365 Tage, sonst 30 Tage (Negativ-Caching mit Verfall, weil
MusicBrainz wächst). `spotify_track_metadata` 180 Tage.

### 4.9 `spotify_api_budget` — das geteilte Ledger (3.2)

```sql
create table if not exists public.spotify_api_budget (
  id             smallint primary key default 1 check (id = 1),
  window_start   timestamptz not null default now(),
  used_import    int not null default 0,
  used_gameplay  int not null default 0,   -- enthaelt auch offene Reservierungen (4.11)
  -- GLOBALE Sperre: blockiert App UND Worker. Wird ausschliesslich von
  -- service_role gesetzt (Worker-Beobachtung), nie von einem App-Client.
  blocked_until  timestamptz,
  blocked_reason text,
  -- IMPORT-Sperre: blockiert nur den Worker. Darf auch aus App-Signalen entstehen
  -- (gedeckelt + rate-limitiert), weil der Schaden bei Missbrauch auf "Importe
  -- pausieren" begrenzt bleibt statt Partien zu treffen (4.11).
  import_blocked_until timestamptz,
  -- Verbrauch beim letzten QUOTA_EXCEEDED. Fliesst als Obergrenze in JEDE
  -- weitere Zulassung ein (nicht nur protokolliert, siehe reserve_spotify_calls).
  last_ceiling_observed int,
  updated_at     timestamptz not null default now()
);
insert into public.spotify_api_budget (id) values (1) on conflict do nothing;

-- Gameplay-Reservierungen: gebunden an Eigentuemer UND Budgetfenster, einmalig
-- abrechenbar. Ohne diese Tabelle waere settle_gameplay_calls(reserved, used)
-- eine offene Schreibmöglichkeit auf den globalen Zaehler (4.11).
create table if not exists public.spotify_gameplay_reservations (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- Fensterbindung: nach einem Fensterwechsel wurden die Zaehler ohnehin
  -- zurueckgesetzt - eine alte Reservierung darf dann NICHTS mehr freigeben.
  window_start timestamptz not null,
  -- Zusaetzliche Lebensdauergrenze; zusammen mit reservation_guard_seconds
  -- kann eine Reservierung den Fensteruebergang nicht ueberspannen.
  valid_until  timestamptz not null,
  granted      int not null check (granted > 0),
  used         int,
  settled_at   timestamptz,
  created_at   timestamptz not null default now(),
  -- Kein stilles Clamping: ein Settlement ausserhalb [0, granted] ist ein Fehler.
  constraint sgr_used_range check (used is null or (used >= 0 and used <= granted))
);
create index if not exists sgr_open_idx on public.spotify_gameplay_reservations (owner_id, created_at desc)
  where settled_at is null;

alter table public.spotify_gameplay_reservations enable row level security;
-- Kein direkter Zugriff: ausschliesslich ueber die beiden RPCs.
grant all on table public.spotify_gameplay_reservations to service_role;

-- Missbrauchsbremse fuer Quota-Signale aus der App (4.11).
create table if not exists public.spotify_quota_signals (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  retry_after_s int not null,
  reason     text,
  created_at timestamptz not null default now()
);
create index if not exists sqs_owner_idx on public.spotify_quota_signals (owner_id, created_at desc);
create index if not exists sqs_recent_idx on public.spotify_quota_signals (created_at desc);

alter table public.spotify_api_budget    enable row level security;
alter table public.spotify_quota_signals enable row level security;

-- Die App darf den Sperrzustand LESEN (um den Cover-Prefetch zu unterlassen),
-- aber nichts schreiben; Zaehlerstaende gehen nur ueber RPCs (4.11).
drop policy if exists "sab_read" on public.spotify_api_budget;
create policy "sab_read" on public.spotify_api_budget for select using (true);
grant select on table public.spotify_api_budget to anon, authenticated;
grant all    on table public.spotify_api_budget to service_role;

-- Signale: kein Lesezugriff fuer Clients, Schreiben nur ueber die RPC.
grant all on table public.spotify_quota_signals to service_role;
```

### 4.10 Seed der manuellen Übersteuerungen aus den kuratierten Pools

Unverändert wertvoll aus v2 — jetzt in die richtige Tabelle. Ausführbar samt
Gegenprobe und Kontrollabfrage in
[013_seed_song_year_overrides.sql](../supabase/migrations/013_seed_song_year_overrides.sql);
der Auszug hier zeigt nur den Kern:

```sql
with normalized as (
  select upper(regexp_replace(isrc, '[^A-Za-z0-9]', '', 'g')) as isrc, release_year
    from public.pool_songs where isrc is not null
),
consistent as (
  select isrc, min(release_year) as year
    from normalized
   where isrc ~ '^[A-Z0-9]{12}$'
   group by isrc
  having min(release_year) = max(release_year)   -- widersprüchliche Jahre NICHT seeden
)
insert into public.song_year_manual_overrides (isrc, year, source, note)
select isrc, year, 'curated_pool', 'seed aus pool_songs, Migration 012'
  from consistent
on conflict (isrc) do nothing;
```

Vor dem Ausführen die Gegenprobe laufen lassen (`having min <> max`) — die
Trefferzahl ist zugleich ein kostenloser Qualitätsbefund über die
Bestandsdaten.

### 4.11 RPCs

Alle mit `security definer` und `set search_path = public`. Schreibende
Job-RPCs sind ausschließlich für `service_role` ausführbar; die
nutzerseitigen prüfen `auth.uid()`.

**Nutzerseitig (`authenticated`):**

| RPC | Zweck | Kernprüfungen |
|---|---|---|
| `request_playlist_import(p_playlist_id)` | Request anlegen, Job wiederverwenden oder erzeugen | ID-Format · `enabled` · Tagesquote je `auth.uid()` · `max_queue` · **Advisory-Lock je Playlist** + `on conflict` gegen den Partial-Unique-Index · Wiederverwendungs-**Kandidat** nur bei passender `pipeline_version`/`decision_version` (Snapshot-Prüfung folgt im Worker) |
| `cancel_my_playlist_import(p_job_id)` | **eigenen Request** zurückziehen, ggf. den Job beenden | folgt dem Terminal-Template: Playlist-Lock **zuerst**, dann Request- und Jobzeile per `FOR UPDATE`, dann erst `cancelled_at` setzen (nur bei `owner_id = auth.uid()`, wiederholter Aufruf folgenlos). Existiert danach kein aktiver Request mehr: Job atomar auf `cancelled` (`fencing_token+1`, Lease/Worker geleert, `finished_at`, `purge_after`, `active_ms`-Rest). Ohne diesen Schritt bliebe ein lange wartender `queued`-Job nach dem letzten Cancel für immer in der Queue und blockierte den Unique-Index |
| `touch_imported_pool(p_pool_id)` | Nutzung melden, Ablauf verlängern | Mitgliedschaft geprüft; `last_used_at = now()`, `expires_at = greatest(expires_at, now() + 30 Tage)` |
| `delete_imported_pool(p_pool_id)` | eigene Mitgliedschaft entfernen; letzte Mitgliedschaft löscht den Pool | Mitgliedschaft geprüft |
| `reserve_gameplay_calls(p_calls int)` | App reserviert Cover-Calls **vor** dem Batch (3.2a) | `p_calls` auf `max_gameplay_reservation` geklammert; gibt `granted` ≤ `p_calls` zurück; erhöht `used_gameplay` **sofort** |
| `settle_gameplay_calls(p_reservation_id uuid, p_used int)` | **genau eine eigene** Reservierung abrechnen | Reservierung muss dem Aufrufer gehören und offen sein; `0 ≤ used ≤ granted` erzwungen; Freigabe nur im **selben** Budgetfenster; Wiederholungsaufruf ist folgenlos (idempotent) |
| `report_spotify_quota_signal(p_reason text, p_retry_after_s int)` | App meldet eine beobachtete Quota-Sperre | `p_retry_after_s` auf [60 s, 4 h] geklammert · max. `max_quota_signals_per_hour` je `auth.uid()` · setzt **nur** `import_blocked_until`, **nie** `blocked_until` |

**Warum Reservieren statt Nachmelden.** Ein nachträglicher Bericht geht genau
dann verloren, wenn er am wichtigsten ist: App im Hintergrund abgeräumt,
Absturz, Netzwerkabbruch mitten im Cover-Batch. Die Calls sind dann verbraucht,
das Ledger weiß nichts davon, und der Worker plant auf Basis eines zu
optimistischen Stands. Deshalb: `reserve_gameplay_calls(n)` **vor** dem Batch —
das Ledger ist im Zweifel zu pessimistisch, was die harmlose Richtung ist —,
danach `settle_gameplay_calls(reservation_id, tatsächlich_verbraucht)`. Fällt das Settle aus,
verfällt die Reservierung spätestens mit dem Fensterwechsel.

**Warum App-Signale nur die Import-Sperre setzen dürfen.** Eine RPC, die jeder
anonym angemeldete Client aufrufen kann und
die den globalen Breaker setzt, wäre ein Ein-Zeilen-Denial-of-Service gegen
alle Partien. Die Aufteilung in `blocked_until` (nur `service_role`) und
`import_blocked_until` (aus App-Signalen, geklammert und rate-limitiert)
begrenzt den möglichen Schaden auf „Importe pausieren".

Die entscheidenden Regeln der nicht-trivialen RPCs — die vollständigen,
ausführbaren Funktionskörper stehen in
[012_playlist_import.sql](../supabase/migrations/012_playlist_import.sql):

**Lock-Reihenfolge von `request_playlist_import`** (Körper: Migration,
Abschnitt 12):

1. **Globaler Queue-Lock** `pg_advisory_xact_lock(hashtext('playlist_import:queue'))`
2. **`app_config` lesen** — erst jetzt, damit kein überholter Snapshot verwendet wird
3. **Tagesquote** je `auth.uid()` prüfen
4. **Playlist-Lock** `pg_advisory_xact_lock(hashtext('playlist_import:' || playlist_id))`
5. Reuse-Kandidat (`for key share`), Queue-Länge, `insert … on conflict … do nothing`,
   Request anhängen

Warum der globale Lock nötig ist: Unter READ COMMITTED sehen zwei parallele
Transaktionen für **verschiedene** Playlists denselben Zählerstand, fügen beide
ein und committen beide — die Grenze bleibt dauerhaft überschritten, es gibt
keinen nachträglichen Abbruch. Dasselbe galt für die nutzerbezogene Tagesquote.
Der Lock serialisiert nur die millisekundenkurzen Request-RPCs, nicht die Jobs.

Der Reuse-Kandidat wird mit `for key share` festgehalten, damit er zwischen
Auswahl und Insert nicht gelöscht werden kann (sonst FK-Fehler), und beide
Config-Versionen werden beim Insert **eingefroren**. Zurück an den Client geht
`reuse_possible` als Boolean — die rohe UUID eines fremden Pools nützt ihm
nichts.

### Das Terminal-Template — verbindlich für jeden Zustandswechsel

Jede RPC, die einen Job in einen anderen Zustand überführt, folgt **exakt**
dieser Reihenfolge. Die vollständigen Funktionskörper stehen in
[012_playlist_import.sql](../supabase/migrations/012_playlist_import.sql),
Abschnitte 12–13.

```sql
-- (1) playlist_id ermitteln, OHNE schreibenden Row-Lock
select playlist_id into v_pl from playlist_import_jobs where id = p_job_id;
if v_pl is null then raise exception 'unknown_job' using errcode='22023'; end if;

-- (2) Playlist-Advisory-Lock
perform pg_advisory_xact_lock(hashtext('playlist_import:' || v_pl));

-- (3) Zeile ERST DANACH sperren
select * into j from playlist_import_jobs where id = p_job_id for update;

-- (4) Zustand erneut validieren - er kann sich zwischen (1) und (3) geaendert haben
if not found or j.fencing_token <> p_fencing or j.status <> 'running' then
  raise exception 'stale_fencing_token' using errcode='55000';
end if;

-- (5) Mutation
```

Betroffen sind: `finish_playlist_import`, `finish_playlist_import_reuse`,
`fail_playlist_import`, `defer_playlist_import`, `cancel_my_playlist_import`,
der terminale Zweig von `reap_playlist_import_jobs` **und
`reserve_spotify_calls`**.

Warum auch die Budget-RPC: In v3.2 prüfte sie das Fencing-Token **einmalig vor**
dem Budget-Row-Lock. Ein Job, der in diesem Moment terminalisiert wurde, konnte
danach trotzdem noch Budget reservieren — verbrannte Quote für Arbeit, die
niemand mehr abholt. Jetzt liegt die Prüfung hinter Advisory-Lock und
`FOR UPDATE` und verlangt zusätzlich einen gültigen Lease.

**Der Cancel-Pfad war der eigentliche Fehler in v3.2:** Er setzte `cancelled_at`,
**bevor** er den Playlist-Lock nahm. Ein parallel laufendes `finish_*` konnte den
Request dadurch noch als aktiv sehen und einem Nutzer eine Pool-Mitgliedschaft
zuweisen, der gerade abgebrochen hatte — oder umgekehrt den Job für verwaist
halten. In der neuen Fassung liegt jede Mutation hinter dem Lock (Schritt 5), und
ein wiederholter Aufruf ist folgenlos.

**Konfigurationswechsel: `set_playlist_import_config(p_patch jsonb)`.**
`pipeline_version` und `decision_version` werden je Job eingefroren, aber ein
Wechsel mitten im Betrieb erzeugte trotzdem eine gemischte Lage. Die Regel „nur
bei leerer Queue" steht jetzt nicht mehr als Kommentar da, sondern wird von der
RPC durchgesetzt: Sie nimmt **denselben globalen Queue-Lock** wie
`request_playlist_import`, prüft bei Versionsänderungen auf
`count(*) = 0` über `queued`/`running` und schreibt erst dann.

> **Bewusste Abweichung:** `enabled` und `scraper_enabled` dürfen **jederzeit**
> gesetzt werden, auch bei gefüllter Queue. Ein Kill-Switch, der auf eine leere
> Queue warten muss, ist im Ernstfall keiner — und er verhindert ausschließlich
> **neue** Jobs, ändert also nichts an bereits eingefrorenen Job-Versionen. Die
> Leer-Queue-Bedingung gilt deshalb genau für die beiden Versionsschlüssel.

**Config wird erst nach dem globalen Lock gelesen.** In v3.2 las
`request_playlist_import` `app_config`, *bevor* es den Queue-Lock nahm — ein
Request konnte alte Werte lesen, am Lock warten, und danach mit einem
überholten Snapshot einen Job anlegen. Reihenfolge jetzt: globaler Lock →
Config lesen → Tagesquote → Playlist-Lock → Insert/Join.

**`active_ms` berechnet ausnahmslos der Server.** Keine der RPCs nimmt einen
`p_active_ms_delta`-Parameter mehr entgegen; alle rufen dieselbe Hilfsfunktion
`pij_active_ms(job, [bis])` auf. Sie schreibt **nur für `status = 'running'`**
aus `heartbeat_at` (ersatzweise `started_at`) fort; für jeden anderen Status
gibt sie den gespeicherten Wert unverändert zurück. Ohne diese Fallunterscheidung
fällt ein zurückgestellter Job (`queued`, `heartbeat_at = null`) auf sein
ursprüngliches `started_at` zurück und zählt die Laufzeit vor dem Defer beim
nächsten Endzustand doppelt — im Test: 3.600.000 ms nach dem Defer,
7.211.478 ms nach dem anschließenden Cancel. Der Reaper rechnet bei
Lease-Verlust bis `lease_expires_at`, nicht bis `now()` — nach Ablauf des Lease
hat der Worker nachweislich nicht mehr gearbeitet.

**Zulassungsformel von `reserve_spotify_calls`** (Körper: Migration,
Abschnitt 13) — nach der Job-Validierung aus dem Template oben:

```
v_ceiling    = least(observed_ceiling, coalesce(last_ceiling_observed, observed_ceiling))
v_limit      = v_ceiling - safety_margin
v_import_cap = least(import_cap, greatest(0, v_limit - gameplay_reserve))

gewaehrt  <=>  used_import + p_calls <= v_import_cap
          AND  used_import + used_gameplay + p_calls <= v_limit
```

Drei Eigenschaften, die dabei zusammenspielen:

- **`last_ceiling_observed` wirkt**, statt nur protokolliert zu werden: eine
  einmal real beobachtete Grenze schlägt den konfigurierten Startwert dauerhaft.
- **Die Spielreserve wird nicht doppelt abgezogen** — sie steckt strukturell in
  der Aufteilung, und `used_gameplay` ist in der linken Summe ohnehin enthalten.
- **Der Import-Deckel wandert mit.** Fällt die beobachtete Decke auf 396, sinkt
  `v_limit` auf 272 und `v_import_cap` auf 22 — die zugesagten 250 für das Spiel
  bleiben unangetastet. Mit dem festen `import_cap = 220` aus v3.2 wären dem
  Spiel dort nur 52 geblieben.

Ebenfalls abgelehnt wird kurz vor Fensterende (`reservation_guard_seconds`),
mit `retry_at = window_end` — derselbe Grund wie bei den Gameplay-Reservierungen.

**Regeln, die `reserve_gameplay_calls`/`settle_gameplay_calls` durchsetzen**
(Körper: Migration, Abschnitt 12):

| Regel | Warum |
|---|---|
| `p_calls > 0` erzwungen, gedeckelt auf `max_gameplay_reservation` | keine Null-/Negativ-Reservierungen, keine Einzelanfrage über die Reserve |
| **Keine neue Reservierung kurz vor Fensterende** (`reservation_guard_seconds`, Rückgabe `retry_at = window_end`) | sonst reserviert ein Client um 21:55 und verbraucht die Calls um 22:05 — im neuen Fenster, ohne dort gezählt zu sein |
| Reservierung trägt `valid_until = least(window_end, now() + reservation_valid_seconds)` und gibt **`valid_until` und `window_end` an den Aufrufer zurück** | begrenzt die Lebensdauer zusätzlich zum Fenster — und der Client kann erkennen, dass seine Reservierung früher endet als angenommen, statt danach blind weiterzufeuern |
| Settlement nur über `reservation_id`, nur für die **eigene**, noch offene Reservierung | ein Client kann keine fremde Buchung freigeben |
| `0 ≤ p_used ≤ granted` **erzwungen**, kein stilles Clamping — plus `check`-Constraint auf der Tabelle | ein Wert außerhalb ist ein Fehler im Aufrufer, kein zu korrigierender Messwert |
| Freigabe nur bei `window_start`-Gleichheit **und** `now() ≤ valid_until` | nach einem Fensterwechsel stehen die Zähler ohnehin auf 0 |
| Wiederholter Aufruf: `already_settled = true`, kein zweiter Effekt | Retry nach Netzwerkabbruch bleibt folgenlos |

**Pflicht auf der Aufruferseite:** Wer reserviert, muss `valid_until` und
`window_end` auswerten und den Batch **abbrechen**, sobald einer der beiden
Zeitpunkte erreicht ist — nicht bis zum letzten reservierten Call
weiterarbeiten. Calls nach dem Fensterwechsel laufen sonst zwar durch, werden
aber im neuen Fenster nicht gezählt, und das Settlement kann sie nicht mehr
gutschreiben. Dieselbe Regel gilt für den Worker gegenüber dem `window_end`
aus `reserve_spotify_calls`. `reservation_guard_seconds` ist so gewählt, dass
ein voller Batch (`max_gameplay_reservation` Calls inklusive Retries) bequem
davor passt; wer den Deckel erhöht, muss den Guard mit erhöhen.

**Warum die Reservierung eine eigene Zeile braucht.** Die v3.1-Signatur
`settle_gameplay_calls(p_reserved, p_used)` nahm zwei frei wählbare Zahlen von
jedem angemeldeten Client entgegen — ohne Bezug zu einer tatsächlichen
Reservierung. Ein einziger Aufruf mit großem `p_reserved` hätte `used_gameplay`
auf 0 gedrückt und damit die Buchführung entwertet, die das ganze Budgetmodell
trägt; mehrfaches Settlen hätte denselben Effekt schrittweise erzielt. Mit
`reservation_id` + `owner_id` + `window_start` + `settled_at` ist jede
Freigabe an genau eine eigene, noch offene Reservierung im aktuellen Fenster
gebunden, und ein Wiederholungsaufruf (Retry nach Netzwerkabbruch) bleibt
folgenlos.

**Verfall statt Leck:** Wird nie gesettlet (App abgeräumt, Absturz), bleibt die
Reservierung als verbraucht stehen und verfällt mit dem Fensterwechsel. Der
Aufräum-Task löscht Reservierungszeilen älter als 24 h (10.5). Das ist die
gewollte Richtung — im Zweifel zu pessimistisch buchen.

Der Funktionskörper von `report_spotify_quota_signal` sowie sämtliche
`grant execute`/`revoke`-Anweisungen stehen in
[012_playlist_import.sql](../supabase/migrations/012_playlist_import.sql),
Abschnitte 12 und 14.

**Klassifikation kurzfristig vs. stundenlang — am `reason`-Feld, nicht an einer
Zeitschwelle.** Spotify liefert bei Drosselung eine maschinenlesbare Ursache mit;
die v3-Schwellen (`< 120 s` in 5.2 gegen `> 600 s` in `report_spotify_usage`)
widersprachen einander und hätten denselben Vorfall je nach Aufrufer
unterschiedlich eingestuft. Verbindlich ist ab jetzt:

| Signal | Einstufung | Reaktion |
|---|---|---|
| HTTP 429 **ohne** `QUOTA_EXCEEDED`-Ursache | `RATE_LIMITED` | im Worker aussitzen (`Retry-After` beachten), kein Requeue, kein Ledger-Block |
| HTTP 429 **mit** `reason = QUOTA_EXCEEDED` (bzw. gleichbedeutender Ursachenangabe) | `QUOTA_EXCEEDED` | `record_spotify_quota_block`, Job-Requeue mit `not_before` |

`Retry-After` bestimmt danach nur noch **wie lange** gesperrt wird, nicht mehr
**ob** es eine Quotensperre war. Ist die Ursache im Einzelfall nicht auslesbar,
gilt die konservative Annahme `QUOTA_EXCEEDED` — lieber einen Import zu lange
verschieben als eine Partie beschädigen.

**Worker-seitig (`service_role`, für `anon`/`authenticated` revoked):**

| RPC | Zweck |
|---|---|
| `claim_playlist_import_job(p_worker_id, p_worker_version int)` | **prüft zuerst `p_worker_version >= min_worker_version`** und lehnt einen veralteten Worker ab, ohne einen Job zu belegen; holt sonst den ältesten Job mit `status='queued' and (not_before is null or not_before <= now())` per `for update skip locked`; setzt `status='running'`, **`fencing_token+1`** (bei jedem Claim korrekt), `started_at = coalesce(started_at, now())`, `lease_expires_at = now() + job_lease_seconds`. **Erhöht `attempts` NICHT** — ein Claim nach einem reinen Budget-Deferral ist kein Fehlversuch; `attempts` gehört allein dem Reaper (s.u.) |
| `heartbeat_playlist_import_job(p_job_id, p_fencing, p_phase, p_progress jsonb)` | Lease verlängern, Fortschritt schreiben, `active_ms` **serverseitig** aus `heartbeat_at` fortschreiben (kein Worker-Parameter); **verweigert bei falschem Fencing-Token**. Kein Request-Anfassen nötig — die App hängt direkt an dieser Tabelle (4.5) |
| `finish_playlist_import(p_job_id, p_fencing, p_outcome, p_pool jsonb, p_songs jsonb, p_dropped jsonb)` | **eine Transaktion** für **alle** Endzustände mit Verlustliste. `p_outcome = 'pool'`: `imported_pools` anlegen, `imported_pool_songs` per `jsonb_to_recordset`, `imported_pool_members` für **alle aktiven Requester**, `playlist_import_dropped_songs` füllen, Job `succeeded`. `p_outcome = 'rejected'`: **kein** Pool, aber Verlustliste + Kennzahlen schreiben, Job `failed` mit `error_code` (`too_much_dropped`/`too_few_verified`). Setzt in beiden Fällen `finished_at = now()`, `purge_after = now() + 7 Tage` und schreibt den seit dem letzten Heartbeat angefallenen `active_ms`-Rest mit. Nimmt vorher den Playlist-Advisory-Lock |
| `finish_playlist_import_reuse(p_job_id, p_fencing, p_pool_id)` | Wiederverwendung nach bestandener Snapshot-/Versionsprüfung: Mitgliedschaft für alle aktiven Requester, `touch` auf den Pool, Job `succeeded` mit `result_warning='reused_pool'`, `finished_at`/`purge_after`/`active_ms`-Rest — ohne Scrape, ohne Metadaten-Phase. Playlist-Advisory-Lock wie bei `finish_playlist_import` |
| `fail_playlist_import(p_job_id, p_fencing, p_code, p_detail)` | **terminaler** Fehler ohne Verlustliste: `failed`, `finished_at`, `purge_after`, `active_ms`-Rest **serverseitig** ergänzt. `p_detail` wandert nach `playlist_import_job_errors` (4.4), **nicht** in die Jobzeile |
| `defer_playlist_import(p_job_id, p_fencing, p_not_before, p_reason)` | **kein** Fehler: zurück auf `queued` mit `not_before`, `deferrals+1`, `attempts` **unverändert**, Lease freigeben, `active_ms`-Rest mitschreiben. Playlist-Advisory-Lock wie oben. Für Budget-/Sperrfälle (5.2) |
| `record_spotify_quota_block(p_retry_after_s, p_used_observed)` | `blocked_until` setzen **und** `last_ceiling_observed = least(bisher, p_used_observed)` fortschreiben — fließt danach in jede Zulassung ein (`reserve_spotify_calls`) |
| `reap_playlist_import_jobs()` | `status='running' and lease_expires_at < now()`: **`attempts+1`** (die einzige Stelle, die diesen Zähler erhöht — Lease-Verlust ist der einzige echte Fehlversuch); dann `attempts < max_attempts` → requeue (Lease frei, `not_before = now() + Backoff`), sonst `failed` mit `worker_lost` **inklusive `finished_at = now()` und `purge_after = now() + 7 Tage`** (sonst räumt `purge_playlist_import_jobs` diese Jobs nie ab). Setzt in beiden Fällen keine Verlustliste (10.2) |
| `purge_playlist_import_jobs()` | löscht **ausschließlich terminale** Jobs (`status in ('succeeded','failed','cancelled')`) mit `purge_after < now()`; `queued`/`running` bleiben unangetastet, egal wie alt |

---

## 5. Ablauf eines Jobs

### 5.1 Phasen

| # | Phase | Inhalt | Spotify-Calls | reserviert in |
|---|---|---|---|---|
| 0 | `queued` | wartet auf Worker / auf `not_before` | 0 | – |
| 1 | `head` | `GET /playlists/{id}` → Name, Owner, `public`, Cover, `snapshot_id_before`; **Reuse-Entscheidung** (s.u.) | 1 | Phase 1: genau **1** |
| 2 | `scraping` | Browser: Einträge + Reihenfolge aus beobachteten Netzwerkantworten (6) | 0 | – |
| 3 | `budget` | Cache-Abgleich → `uncached_count`; `reserve_spotify_calls` | 0 | – |
| 4 | `metadata` | `GET /v1/tracks/{id}` für nicht gecachte IDs | `uncached_count` | Phase 3 |
| 5 | `years` | MusicBrainz: ISRC-Batches (12/Query), dann Text-Fallback | 0 | – |
| 6 | `crosscheck` | Discogs + ListenBrainz nur für offene Zeilen | 0 | – |
| 7 | `writing` | `snapshot_id_after` holen und prüfen, Gates (8.3), `finish_playlist_import` | 1 | Phase 3 (zusammen mit den Metadaten) |
| 8 | `done` | `pool_id` steht, Mitgliedschaften vergeben | – | – |

Zwischen 5 und 6 laufen `detect-risk-flags` → `decide-year` (rein, ohne Netz).

**Jeder Spotify-Call geht durchs Ledger — auch die Kopf-Calls.** Reserviert wird
aber nur, was der jeweilige Pfad wirklich braucht: in Phase 1 **genau ein** Call
(der Head-Request), und in Phase 3 `uncached_count + 1` (Metadaten plus den
späteren Snapshot-after-Call). Ein erfolgreicher Reuse endet nach Phase 1 und
verbraucht damit tatsächlich nur einen einzigen Call — die pauschale
Zweierreservierung aus v3.1 hätte jede Reuse-Prüfung doppelt so teuer gebucht,
wie sie ist. In v3 liefen die Kopf-Calls ganz an der Buchführung vorbei.

**Die Reihenfolge ist bewusst so gewählt:** Das Scraping ist quotenfrei, also
steht die exakte Zahl benötigter Spotify-Calls fest, **bevor** die große
Reservierung fällt. Das ist die Umsetzung von 3.2(d).

**Reuse-Entscheidung in Phase 1** (Auflösung des Cache-Umgehungsproblems): Hat
der Job ein `reuse_candidate_pool_id` (von `request_playlist_import` gesetzt,
bereits auf `pipeline_version`/`decision_version` geprüft), vergleicht der Worker
jetzt zusätzlich `snapshot_id_before` mit `imported_pools.snapshot_id`.

- **Gleich** → `finish_playlist_import_reuse`: Mitgliedschaft vergeben, fertig.
  Kosten: ein einziger Spotify-Call, kein Browser, keine Metadaten.
- **Verschieden** → die Playlist wurde seit dem letzten Import bearbeitet; der
  Kandidat wird verworfen und der Job läuft vollständig durch.

Damit ist die Wiederverwendung an **Playlist-ID + Alter + Snapshot +
Pipeline-Version + Decision-Version** gebunden. Der reine 24-Stunden-Test aus v3
hätte einen Pool auch dann ausgeliefert, wenn die Playlist inzwischen andere
Songs enthielt oder die Entscheidungslogik weitergezogen war — also genau das
Cache-Schema aus 4.8 umgangen.

### 5.2 Abbruch- und Wartebedingungen

| Bedingung | Reaktion | Zähler |
|---|---|---|
| Kein aktiver Request mehr (alle zurückgezogen) | Job `cancelled`, Prüfung an jeder Phasengrenze | – |
| `reserve_spotify_calls` verweigert | **`defer_playlist_import`** mit `not_before = retry_at`, zurück auf `queued`; kein Fehler für den Nutzer, UI zeigt Startzeit | `deferrals+1` |
| `QUOTA_EXCEEDED` (per `reason`, nicht per Zeitschwelle) | `record_spotify_quota_block`, dann `defer_playlist_import`; bereits geholte Metadaten liegen im Cache und gehen nicht verloren | `deferrals+1` |
| `RATE_LIMITED` (429 ohne Quota-Ursache) | im Worker aussitzen (`Retry-After`), kein Requeue, kein Ledger-Block | – |
| `snapshot_id_after ≠ before` | Lauf wiederholen (max. 2×), dann `playlist_changed` (6.3) | `attempts` unverändert |
| `scrape_complete = false` | `scrape_incomplete`, **nie** Teilerfolg | terminal |
| Gate (b) verletzt | `finish_playlist_import(p_outcome => 'rejected')` — **mit** Verlustliste (8.3) | terminal |
| Lease abgelaufen | Reaper requeued oder schließt ab (10.2) | `attempts+1` |
| `active_ms > job_active_timeout_s` | `fail_playlist_import('job_timeout')` | terminal |

**Deferrals sind keine Fehlversuche — und Claims auch nicht.** `attempts` wird
an **genau einer** Stelle erhöht: im Reaper, bei tatsächlichem Lease-Verlust
(4.11). Weder `defer_playlist_import` noch der nachfolgende Claim rühren ihn an.
In v3.1 zählte der Claim jeden Anlauf mit, wodurch ein Job, der dreimal auf
freies Budget wartete, sich beim dritten Mal selbst als `worker_lost` beendet
hätte — obwohl er kerngesund war. `fencing_token` steigt weiterhin bei **jedem**
Claim; das ist korrekt und schützt gegen Zombie-Worker.

**Das Timeout misst `active_ms`, nicht die Wanduhr.** Ein Job, der um 18:00
startet, wegen Budget bis 22:00 wartet und dann in vier Minuten durchläuft, hat
vier Minuten Rechenzeit verbraucht — nicht vier Stunden. Die v3-Formulierung
„Job-Timeout 15 min" hätte jeden budgetverschobenen Job zuverlässig getötet.

---

## 6. Scraper-Vertrag (neu, auf Basis von E4)

### 6.1 Mitgliedschaft kommt aus dem Netzwerk, Reihenfolge aus dem DOM

E4 hat gezeigt: Die Seite enthält Track-Links, die nicht zur Playlist gehören
(+10 in beiden Testfällen). Deshalb:

- **Mitgliedschaft**: ausschließlich aus den im Browser **beobachteten
  Netzwerkantworten** der Playlist-Seite (Puppeteer `page.on('response')`,
  gefiltert auf die Datenendpunkte der Seite). Nur was dort als Playlist-Eintrag
  auftaucht, ist ein Eintrag.
- **Reihenfolge**: aus dem gescrollten DOM, weil die Netzwerkantworten
  seitenweise und teils außer der Reihe eintreffen. Abgleich: Jede DOM-Position
  muss einer Netzwerk-Mitgliedschaft entsprechen; DOM-Einträge ohne
  Netzwerk-Beleg werden **verworfen und gezählt** (`warnings`), nicht
  aufgenommen.
- **Akkumulation nach jedem Scroll-Schritt** (Spotify virtualisiert die Liste
  und entfernt ältere Zeilen wieder) — unverändert aus der Vorlage.

### 6.2 Rückgabevertrag

```ts
interface ScrapeResult {
  /** Playlist-EINTRÄGE in Reihenfolge — inklusive Duplikaten, lokalen Dateien, Episoden. */
  entries: Array<{
    position: number;
    kind: 'track' | 'local_file' | 'episode' | 'unavailable';
    spotifyTrackId: string | null;      // null außer bei kind === 'track'
    /**
     * Anzeigedaten aus derselben Netzwerkantwort, aus der die Mitgliedschaft
     * stammt. PFLICHT — ohne sie kann die Verlustliste (9.3) für genau die
     * Einträge nichts anzeigen, die nie eine Spotify-Metadatenabfrage erleben:
     * verworfene Duplikate, lokale Dateien, Episoden, nicht verfügbare Titel.
     */
    displayTitle: string | null;
    displayArtist: string | null;       // bei local_file/episode oft null
  }>;
  /** Sollzahl der EINTRÄGE aus den beobachteten Netzwerkantworten. */
  expectedEntryCount: number | null;
  /** Woher die Sollzahl stammt — 'og_meta' ist ein schwächeres Signal. */
  expectedSource: 'network_total' | 'og_meta' | null;
  extractedEntryCount: number;          // entries.length
  /** EXAKTE Gleichheit, nicht >= (E4). */
  complete: boolean;
  domOnlyRejected: number;              // DOM-Treffer ohne Netzwerk-Beleg
  scrollRounds: number;
  fetchedAt: string;                    // ISO
  scraperVersion: string;               // "2026-07-31.1"
  warnings: string[];
}
```

Regeln, die der Worker durchsetzt:

- `complete === (expectedEntryCount !== null && extractedEntryCount === expectedEntryCount)`.
  **Nur exakte Gleichheit.** Mehr Treffer als erwartet sind genauso ein Fehler
  wie weniger — E4 hat gezeigt, dass „mehr" der wahrscheinlichere Fehlerfall ist.
- `expectedSource === 'og_meta'` → **Abbruch mit `scrape_no_total`.** In v3 durfte
  der Job hier mit einer Warnung weiterlaufen; das widerspricht der eigenen
  E4-Invariante. Nach E4 ist die Netzwerk-Sollzahl die **einzige** Quelle, der
  die Vollständigkeitsaussage standhält — und eine unbestätigte
  Vollständigkeitsaussage ist genau der Fehler, der 10 fremde Songs in den Pool
  gebracht hätte. Das og-Signal bleibt im Vertrag, aber nur als
  Diagnose-/Plausibilitätswert in `warnings`, nie als Entscheidungsgrundlage.
  (Erledigt damit die offene Entscheidung 14/#4 aus v3.)
- `expectedEntryCount === null` → `scrape_no_total`, Abbruch. Es wird **nicht**
  geraten.
- `entries.length > max_playlist_entries` → `too_large`, Abbruch vor jedem
  Spotify-Call.
- `kind !== 'track'` → Zeile in `playlist_import_dropped_songs` mit
  `entry_kind = kind`, `spotify_track_id = null` und den Anzeigedaten aus dem
  Scrape. Die Sollzahl zählt **Einträge**, die Pool-Größe zählt **eindeutige
  Track-IDs** — beide Zahlen werden getrennt geführt (`expected_entry_count`,
  `unique_track_count`).
- Jede verworfene Zeile — gleich aus welchem Grund und in welcher Phase —
  **muss** Anzeigedaten mitführen. Reihenfolge der Quellen: `spotify_track_metadata`
  (falls die Metadatenphase sie erreicht hat), sonst `displayTitle`/`displayArtist`
  aus dem Scrape. Nur so kann die UI in 9.3 halten, was sie verspricht.
- Duplikate (gleiche Track-ID mehrfach, oder gleiche ISRC unter zwei IDs)
  werden als `duplicate_track`/`duplicate_isrc` protokolliert und einmal
  aufgenommen. Ohne diese Dedupe bricht der Unique-Index in
  `imported_pool_songs`.

### 6.3 `snapshot_id` als Konsistenzanker

`snapshot_id_before` in Phase 1, `snapshot_id_after` in Phase 7. Bei
Abweichung: der Zwischenstand ist inkonsistent (jemand hat die Playlist während
des Laufs bearbeitet) → **Lauf wiederholen**, maximal zweimal, danach
`playlist_changed`. Kein Weiterlaufen mit gemischten Ständen.

Der Anker ist billig (zwei Requests) und offiziell — das ist der praktische
Gewinn aus E2, der das fehlende `tracks.total` teilweise kompensiert.

---

## 7. Modulaufteilung

```
packages/song-decision/                 # rein, plattformunabhängig, ESM+TS
  src/{detect-risk-flags,decide-year,plan-discogs-lookup,map-verification-result}.ts
  src/upload-ready.ts                   # Statusliste, geteilt mit dem CLI-Upload (8.2)
  test/                                 # die 21 bestehenden Tests als Golden Tests

services/playlist-import-worker/
  src/index.ts                          # Claim-Loop, Reaper-Tick, Heartbeat, Shutdown
  src/config.ts                         # ENV + app_config
  src/queue/
    jobs.ts                             # claim / heartbeat / finish / finish_reuse / fail / defer (Fencing-Token)
    lease.ts                            # Lease-Erneuerung, Selbstabbruch bei verlorenem Lease
    progress.ts                         # Units-Modell + ETA (9.2)
  src/scrape/
    browser.ts                          # Launch, Recycle nach JEDEM Job, Watchdog/Hard-Kill
    playlist-scraper.ts                 # Netzwerk-Mitschnitt + Scroll-Schleife
    scrape-result.ts                    # Vertrag 6.2 + Vollständigkeitsprüfung
  src/spotify/
    client.ts                           # Client Credentials, Pacer, Retry-Klassifikation
    playlist-access.ts                  # 401 UND 403 -> 'no_access' (E1), kein Token-Retry
    playlist-head.ts                    # GET /playlists/{id}: Name, Cover, snapshot_id (E2) + Reuse-Entscheidung (5.1)
    track-metadata.ts                   # /tracks/{id} + Cache
    budget.ts                           # reserve_spotify_calls (Kopf-Calls + Metadaten) / record_spotify_quota_block
  src/verify/
    limiter.ts                          # EIN prozessweiter Limiter je Fremd-API
    musicbrainz.ts                      # ISRC-Batch (12) + Text-Fallback + Scoring (Port)
    discogs.ts · listenbrainz.ts        # Port
    lookup-cache.ts                     # song_year_lookups + manual_overrides, TTL
  src/pool/
    gates.ts                            # absolute Mindestgröße + Retention (8.3)
    build-pool.ts                       # Dedupe, Provenienz, Payload für finish_playlist_import
    cover.ts                            # Playlist-Cover in den Storage spiegeln (10.4)
  src/telemetry/logger.ts               # Redaction: Tokens, vollständige URLs, IPs
  Dockerfile                            # offizielles Puppeteer-Image, gepinnt, non-root

src/services/poolSource.ts              # App: eine Sicht auf kuratierte + importierte Pools (4.7)
```

Leitplanken:

- `packages/song-decision` ohne Node-spezifische Importe (kein `fs`, kein
  `process.env`) — sonst ist ein späterer App-/Edge-Einsatz verbaut.
- `src/verify/limiter.ts` hält **prozessweite** Limiter (MusicBrainz ~1/s,
  Discogs 50/min, Spotify per Config). Kein Limiter pro Job — auch wenn bei
  Concurrency 1 heute nichts kollidiert, ist die Nachrüstung sonst ein Rewrite.
- Der Browser wird **nach jedem Job** recycelt; Watchdog killt Prozesse älter
  als 5 min oder über RSS-Schwelle.

---

## 8. Verifikations-Pipeline und Aufnahmekriterien

### 8.1 Ablauf pro Song

```
Track-ID
 └─ spotify_track_metadata ──miss──▶ GET /v1/tracks/{id}   (budgetiert, 3.2)
      └─ title, artist, isrc, album_{name,type,artist,release_date}
           └─ song_year_manual_overrides[isrc] ──treffer──▶ FERTIG (year_source=manual_override)
                └─ song_year_lookups[musicbrainz] ──miss──▶ MB ISRC-Batch ──miss──▶ MB-Textsuche
                     ▼
              detect-risk-flags(mb + Spotify-Album-Kontext)   ← immer frisch, nie gecacht
                     ▼
                 decide-year
        ┌────────────┼─────────────────────┐
        ▼            ▼                     ▼
  accepted_auto  accepted_auto_soft   needs_review
        │             │                     │
        │      Discogs Soft-Check    Discogs Hard-Check + ListenBrainz
        │        ┌────┴────┐              ┌──┴───┐
        ▼        ▼         ▼              ▼      ▼
      POOL     POOL    VERWORFEN      POOL   VERWORFEN
```

### 8.2 Aufnahmekriterium

| Ergebnis | `year_source` | In den Pool? |
|---|---|---|
| manuelle Übersteuerung (Seed/Dashboard) | `manual_override` | ✅ |
| `accepted_auto` | `musicbrainz` | ✅ |
| `accepted_auto_soft` + Discogs konfliktfrei | `musicbrainz_soft_checked` | ✅ |
| ListenBrainz `likely_accept_existing_mb` | `musicbrainz_lb_confirmed` | ✅ (per Flag abschaltbar) |
| `soft_discogs_pending` (Check nicht gelaufen) | – | ❌ `soft_check_pending` |
| alles Übrige | – | ❌ `needs_review` |

Die Statusliste lebt in `packages/song-decision/src/upload-ready.ts` und wird
von Worker **und** dem bestehenden
[validate-upload-rows.js](../scripts/lib/upload/validate-upload-rows.js)
genutzt — sonst driften der automatische und der kuratierte Weg auseinander.

**Niemals** auf `album.release_date` als Jahr zurückfallen. Genau dagegen
existiert die Pipeline (Remaster 2019 für einen Song von 1975).

### 8.3 Die zwei Gates (§2/#6)

`MIN_VERIFIED_SONGS = 25` aus v2 war zu klein. Grund, am Code belegt: Der
Standard ist `cardsToWin: 10`
([GameContext.tsx:98](../src/context/GameContext.tsx#L98),
[SettingsContext.tsx:48](../src/context/SettingsContext.tsx#L48)), gewonnen
wird bei `cardsToWin − 1` **korrekten** Platzierungen
([GameContext.tsx:195-198](../src/context/GameContext.tsx#L195-L198)) — jede
falsche Platzierung verbraucht ebenfalls eine Karte. Und ein leerer Stapel
beendet die Partie nicht sauber, sondern liefert
`currentCard: null` ([GameContext.tsx:151-154](../src/context/GameContext.tsx#L151-L154)):
ein zu kleiner Pool erzeugt ein **kaputtes**, kein kurzes Spiel.

**Gate (a) — absolute Mindestgröße, modus- und spielerabhängig**

Für Hitster (der anspruchsvollste Modus):

```
benoetigt(spieler, cardsToWin) = spieler                      // Startkarten
                               + ceil(spieler × (cardsToWin−1) / trefferquote)
                               × sicherheitsfaktor
mit trefferquote = 0,5 und sicherheitsfaktor = 1,15
```

| Spieler | `cardsToWin` = 10 |
|---|---|
| 2 | ~44 |
| 4 | ~88 |
| 6 | ~132 |

Für Bingo ergibt sich der Bedarf aus der Feldzahl (4×4 oder 5×5,
[bingo.ts:174](../src/game/bingo.ts#L174)) plus Runden-Reserve, für das
Timeline-Quiz aus `QUIZ_BASE_SLOTS = 10`
([timelineQuiz.ts:17](../src/game/timelineQuiz.ts#L17)) plus Rundenzahl; beide
liegen deutlich unter dem Hitster-Bedarf.

Umsetzung an zwei Stellen, aus **einer** Quelle:

1. Neues `src/game/deckRequirements.ts` mit `requiredCards(mode, players, settings)`.
2. **Importzeit** (Worker, kennt die Spielerzahl nicht): harte Untergrenze
   `min_import_songs = 40` — knapp unter dem rechnerischen Bedarf einer
   2-Spieler-Partie (~44) und damit die absolute Schwelle, unterhalb derer ein
   Pool für **keine** Konstellation mehr taugt; die exakte Prüfung übernimmt das
   Startgate. Dazu Berechnung von
   `recommended_max_players` aus der Pool-Größe, gespeichert in
   `imported_pools.import_stats`.
3. **Spielstart**: der heutige Test `tracks.length < trimmed.length + 1`
   ([SetupScreen.tsx:125](../src/screens/SetupScreen.tsx#L125)) wird durch
   `requiredCards(...)` ersetzt — mit sprechender Meldung („Dieser Pool reicht
   für 3 Spieler bei 10 Karten"). Das ist eine Verbesserung am Bestand und Teil
   des Umfangs, weil kuratierte Pools heute derselben zu laxen Prüfung
   unterliegen.

**Gate (b) — Retention relativ zur deduplizierten Playlist**

`retention = verified_count / unique_track_count`

Dabei ist `unique_track_count` die Zahl der **echten Kandidaten**: eindeutige
Spotify-Track-IDs nach Dedupe, ohne lokale Dateien, Episoden und nicht
Verfügbares. Diese Einträge stehen zwar in der Verlustliste, gehören aber nicht
in den Nenner — sie sind nie am Verifikationsweg gescheitert, sondern waren nie
darauf. Beide UI-Zahlen aus 9.3 ergeben sich daraus ohne zusätzliche Spalten:
`unverified = unique_track_count − verified_count` und
`dropped_entry_count = expected_entry_count − unique_track_count`.

| Retention | Ergebnis |
|---|---|
| ≥ 0,85 | Erfolg ohne Warnung |
| 0,60 … 0,85 | Erfolg mit `result_warning = 'low_retention'`; die **vollständige Verlustliste** wird vor dem ersten Spielen angezeigt und muss bestätigt werden |
| < 0,60 | `too_much_dropped` — **außer** `verified_count ≥ large_pool_threshold (120)`, dann Warnstatus wie oben |
| `verified_count < min_import_songs` | `too_few_verified`, unabhängig von der Retention |

Die Ausnahme für große Playlists ist der von Codex geforderte Weg „transparente
Verlustliste statt starrer Ablehnung": Ein 200-Song-Import, der 125 gesicherte
Songs liefert, ist spielbar — aber der Nutzer sieht, welche 75 fehlen und warum.

**Auch der Ablehnungsfall schreibt die Verlustliste.** `too_much_dropped` und
`too_few_verified` sind die beiden Fehler, bei denen der Nutzer die Gründe am
dringendsten braucht — sonst steht da nur „zu viel verworfen" ohne jeden Beleg.
Sie laufen deshalb über
`finish_playlist_import(p_outcome => 'rejected', p_dropped => …)` und **nicht**
über `fail_playlist_import`, das keine Verlustliste entgegennimmt (v3 rief hier
die falsche RPC auf). Der Job endet als `failed` mit dem passenden
`error_code`, aber `playlist_import_dropped_songs` ist gefüllt, und das
Fehler-UI (9.4) verlinkt direkt darauf.

---

## 9. App-seitiger Ablauf

### 9.1 Einstieg

Im bestehenden `PlaylistPicker`
([PlaylistPickerScreen.tsx](../src/screens/PlaylistPickerScreen.tsx)) listet
`poolSource.listPools()` künftig **beide** Quellen: kuratierte Pools wie bisher,
darunter „Meine importierten Pools" mit Ablaufhinweis. Über der Liste die Zeile
**„＋ Aus Spotify-Playlist erstellen"**, sichtbar nur bei
`app_config.playlist_import.enabled`. Der historische Kommentar im Kopf der
Datei (die entfernte Spotify-Quelle) wird beim Umbau aktualisiert.

### 9.2 Import-Screen

Eingabe: ein Textfeld. Validierung client- **und** serverseitig gegen
`^https?://open\.spotify\.com/playlist/([A-Za-z0-9]{22})(\?.*)?$`; übertragen
wird nur die extrahierte ID — damit kann `si=…` gar nicht erst in ein Log
geraten.

| Phase | Anzeige | Balken |
|---|---|---|
| `queued` | „Warteschlange — Platz 2" | unbestimmt |
| `queued` + `not_before` | „Startet ca. 18:40, sobald das Spotify-Kontingent frei ist" | unbestimmt |
| `head` | „Playlist wird geprüft…" | unbestimmt |
| `scraping` | „Playlist wird gelesen… 84/194" | bestimmt, sobald `expectedEntryCount` steht |
| `budget` | „Warte auf freies Spotify-Kontingent…" | unbestimmt |
| `metadata` | „Songdaten werden geladen… 120/191" | bestimmt |
| `years` | „Erscheinungsjahre werden geprüft… 150/191" | bestimmt |
| `crosscheck` | „Zweitprüfung unsicherer Songs… 12/31" | bestimmt |
| `writing` | „Pool wird angelegt…" | unbestimmt |

**Fortschritt/ETA**: Eine *Unit* ist ein externer Request. `units_total` wird
nach jeder Phase neu geschätzt (nach `scraping`: `uncached_count` +
`ceil(uncachedIsrc/12)` + 0,25·N geschätzter Text-Fallback; nach `years` stehen
Fallback- und Crosscheck-Menge fest). ETA = Σ über die Restphasen von
`Rest-Units / gemessener Durchsatz **dieser** API` — getrennt, weil
MusicBrainz (1/s), Discogs (50/min) und Spotify (budgetiert) völlig
unterschiedlich takten. Anzeige konservativ gerundet, nie rückwärts laufend.

Laufzeit realistisch (unverändert aus v2, mit den echten Konstanten gerechnet):
**2,5–6 min kalt, 20–60 s warm.** Ein „Läuft im Hintergrund weiter"-Hinweis ist
Pflicht; beim Zurückkehren hängt sich der Screen über die gemerkte Job-ID
wieder an (die Job-ID liegt in AsyncStorage, der Besitz an der anonymen
Identität).

### 9.3 Ergebnis

```
✓ „Hitster: Guilty Pleasure" importiert
172 von 191 eindeutigen Songs mit gesichertem Erscheinungsjahr  (90 %)
  19 ohne gesichertes Jahr:  16 unsicheres Jahr · 3 ohne ISRC
  3 Einträge nicht importierbar:  1 Duplikat · 1 lokale Datei · 1 Podcast-Folge
  [ Pool spielen ]   [ Verlustliste ansehen ]
```

**Zwei getrennte Zahlen, bewusst.** `unverified_unique_track_count` (Songs, die
den Verifikationsweg nicht bestanden haben) und `dropped_entry_count`
(Playlist-Einträge, die gar nicht erst Kandidaten waren: Duplikate, lokale
Dateien, Episoden, nicht Verfügbares) dürfen nicht in dieselbe Zeile. Nur die
erste Zahl steht im Nenner der Retention aus 8.3 — ein Duplikat ist kein
Verifikationsfehler, und eine Playlist mit vielen Doppeleinträgen würde sonst
grundlos am Retention-Gate scheitern. In der Verlustliste tauchen beide
Gruppen auf, aber optisch getrennt.

„Verlustliste" liest `playlist_import_dropped_songs` (4.6) und zeigt je Zeile
Titel, Künstler und Grund. Die Anzeigedaten dafür liefert der Scraper-Vertrag
(6.2) — auch für Einträge, die nie eine Spotify-Metadatenabfrage erleben. Die
Darstellung richtet sich nach `entry_kind`:

| `entry_kind` | Darstellung |
|---|---|
| `track` | „Titel — Künstler", Grund als Klartext („kein gesichertes Jahr") |
| `local_file` | „Titel (lokale Datei)" — kein Künstler, kein Spotify-Link; Hinweis, dass lokale Dateien nicht abspielbar sind |
| `episode` | „Titel (Podcast-Folge)" — Podcasts gehören nicht in einen Song-Pool |
| `unavailable` | „Titel (in dieser Region nicht verfügbar)"; ohne Titel: „Eintrag #37 (nicht verfügbar)" |

Bei `result_warning = 'low_retention'` wird die Liste **vor** dem ersten Spielen
gezeigt und muss bestätigt werden (8.3); bei `too_much_dropped`/`too_few_verified`
ist sie der Hauptinhalt des Fehlerbildschirms.

### 9.4 Fehlertaxonomie

| `error_code` | Ursache | Anzeige | Retry |
|---|---|---|---|
| `invalid_playlist_url` | Muster passt nicht | „Das ist kein gültiger Playlist-Link." | – |
| `playlist_not_found` | 404 | „Playlist nicht gefunden — ist sie öffentlich?" | nein |
| `playlist_private` | `public = false` / Login-Wand | „Diese Playlist ist nicht öffentlich." | nein |
| `playlist_no_access` | **401 oder 403** auf `/items` (E1) | intern; führt zum Scraper, nie ins UI | – |
| `playlist_changed` | `snapshot_id` abweichend nach 2 Versuchen | „Die Playlist wurde gerade bearbeitet. Bitte erneut versuchen." | ja |
| `too_large` | > `max_playlist_entries` | „Playlist hat 412 Einträge — maximal 200 möglich." | nein |
| `too_few_verified` | Gate (a) | „Nur 31 Songs konnten gesichert werden — zu wenig für eine Partie." **+ Verlustliste** | nein |
| `too_much_dropped` | Gate (b) | „Zu viele Songs ohne gesichertes Jahr (48 %)." + Verlustliste | nein |
| `scrape_incomplete` | `complete = false` | „Playlist konnte nicht vollständig gelesen werden." | ja, später |
| `scrape_no_total` | Sollzahl fehlt oder stammt nur aus `og_meta` (6.2) | wie oben | ja, später |
| `scraper_broken` | Selektoren/Netzwerkform geändert | „Der Import funktioniert gerade nicht." **+ Hinweis auf den Kopier-Weg** (12.1) | nein |
| `spotify_rate_limited` | 429 **ohne** Quota-Ursache (4.11) | intern ausgesessen, kein UI | – |
| `spotify_quota_exceeded` | 429 **mit** Quota-Ursache | „Spotifys Kontingent ist gerade erschöpft. Der Import startet automatisch, sobald es wieder frei ist (voraussichtlich ca. 21:15)." | automatisch |
| `budget_exhausted` | Reservierung verweigert | wie oben (Requeue, kein Fehlerdialog) | automatisch |
| `feature_disabled` / `queue_full` / `owner_quota_exceeded` | Flags/Quoten | jeweils eigener Text | teils |
| `worker_lost` | Lease abgelaufen, `max_attempts` erreicht | „Der Import wurde unterbrochen." | ja |
| `job_timeout` | `active_ms` > `job_active_timeout_s` (Rechenzeit, nicht Wartezeit) | wie oben | ja |
| `internal` | Rest | „Unerwarteter Fehler beim Import." | ja |

Die Trennung `spotify_rate_limited` (kurz, intern) von
`spotify_quota_exceeded` (stundenlang, mit Startzeit im UI) ist die direkte
Umsetzung von 3.2(c).

**Der Client bekommt ausschließlich den `error_code`** — die Übersetzung in
einen deutschen Satz passiert in der App anhand dieser Tabelle. Provider-
Antworten, Stack-Fragmente und interne Pfade landen in
`playlist_import_job_errors` (4.4) und im Worker-Log. Ein Längenlimit auf einem
Freitextfeld hätte nur die Menge begrenzt, nicht den Informationsgehalt.

---

## 10. Betrieb

### 10.1 Hosting: dauerhaft laufender Minimal-Consumer

**Entscheidung (§2/#3).** „Scale-to-Zero" und „Pull-Worker" aus v2
schließen sich aus: Ein auf null skalierter Prozess kann nicht pollen. Geweckt
werden könnte er nur über einen eingehenden Kanal — also genau die
Angriffsfläche, die das Konzept mit der Supabase-Queue bewusst vermieden hat.

Gewählt: **ein dauerhaft laufender Node-Consumer**, der nur beim tatsächlichen
Job einen Chromium startet.

- Ruhezustand: ein Node-Prozess, ~60–80 MB RSS, Poll-Intervall 5 s (plus
  Reaper-Tick alle 60 s). Chromium läuft ausschließlich während Phase 2.
- Kosten: Größenordnung 5 $/Monat (Railway/Fly Minimalinstanz).
- Keine eingehende Verbindung, kein Zertifikat, keine öffentliche Route.

Dokumentierte Alternative, falls die Kosten stören: Supabase Database Webhook
(`pg_net`) auf `INSERT` in `playlist_import_jobs` → `POST /wake` am Worker mit
gemeinsamem Secret, dazu `auto_start_machines` bei Fly. Das ist die einzige
Variante, die echtes Scale-to-Zero erlaubt — **um den Preis einer eingehenden
Route**. Ein reiner Cron-Poll (alle 2 min) spart weder Kosten noch Komplexität
nennenswert und fügt Latenz hinzu.

Zu Plesk (wint.global): weiterhin die Option mit dem höchsten Bedauerns-Risiko.
Chromium auf einer geteilten Hosting-Kiste trifft bei RAM-Spitzen oder
OOM-Kills **fremde Produktivprojekte**. Nur mit harten cgroup-Limits
(`--memory`, `--cpus`, `--pids-limit`) und Watchdog.

Weiterhin gültig: Concurrency 1, Browser nach jedem Job recyceln, offizielles
Puppeteer-Image gepinnt, non-root mit Chrome-Sandbox, `/tmp` begrenzt.

### 10.2 Lease, Fencing, Reaper

- **Claim** setzt `lease_expires_at = now() + 90 s` und erhöht `fencing_token`
  — **nicht** `attempts` (4.11).
- **Heartbeat** alle 15 s verlängert den Lease und schreibt den seit dem letzten
  Heartbeat angefallenen `active_ms`-Zuwachs fort; scheitert er zweimal, bricht
  der Worker den Job **selbst** ab (er hat den Lease verloren).
- **Jede** schreibende Worker-RPC führt das Fencing-Token mit und wird bei
  Abweichung abgelehnt — ein wiederbelebter Zombie-Worker kann keine
  Ergebnisse eines längst requeueten Jobs schreiben. Jede **terminale** RPC
  nimmt zusätzlich den Playlist-Advisory-Lock (4.11).
- **Reaper** (`reap_playlist_import_jobs`, aufgerufen im Worker-Loop und
  zusätzlich per `pg_cron` minütlich): wertet Lease-Ablauf und aktive Laufzeit
  **nach** dem Advisory-Lock und `FOR UPDATE` ein zweites Mal aus und lässt den
  Job in Ruhe, wenn ein Heartbeat ihn zwischenzeitlich wiederbelebt hat
  (zwischen Auswahl und Lock können Minuten liegen). Erst danach: `running` mit
  abgelaufenem Lease → `attempts + 1` (**die einzige Stelle, die diesen Zähler
  erhöht**), dann
  `attempts < max_attempts` requeue, sonst `failed` mit `worker_lost`,
  `finished_at` und `purge_after`. Damit kann der Unique-Index über
  `('queued','running')` keine Playlist dauerhaft blockieren — und der terminal
  gesetzte Job wird später auch tatsächlich abgeräumt.
- **Beim Abschluss** (finish/fail/defer/cancel) wird der seit dem letzten
  Heartbeat aufgelaufene `active_ms`-Rest mitgeschrieben, damit die
  Rechenzeitmessung nicht am Ende systematisch zu niedrig ausfällt.

### 10.3 Geheimnisse

Nur im Worker-Container: `SPOTIFY_IMPORT_CLIENT_ID/SECRET`, `DISCOGS_TOKEN`,
`SUPABASE_SERVICE_ROLE_KEY`. Die zweite Spotify-App bleibt sinnvoll für
getrennte Secrets, Rolling-Limits und Metriken — sie isoliert nach E3 aber
**nicht** das Kontingent (3.1). Die App braucht für dieses Feature keinen neuen
Schlüssel.

### 10.4 Pool-Cover: Spiegelung statt Verlinkung

Spotifys Bild-URLs laufen laut Doku in **unter einem Tag** ab — eine 30-Tage-
Cache-Dauer für `icon_url` (v2) war schlicht falsch.

Gewählt: Der Worker lädt das Cover in Phase 1 **einmal** herunter und legt es im
Storage-Bucket `pool-icons` unter `imported/<pool_id>.jpg` ab;
`imported_pools.icon_url` zeigt auf diese eigene, nicht ablaufende URL. Kosten:
~20 KB je Import.

**Der Bucket wird von der Migration angelegt, nicht vorausgesetzt.**
[010_pool_icons.sql](../supabase/migrations/010_pool_icons.sql) beschreibt ihn
nur als manuellen Dashboard-Schritt („Kein SQL nötig") — ob er auf dieser
Instanz existiert, ist damit ungewiss. Migration 012 legt ihn idempotent an:

```sql
insert into storage.buckets (id, name, public)
values ('pool-icons', 'pool-icons', true)
on conflict (id) do nothing;
```

**Fallback, falls der Upload dennoch scheitert** (Bucket fehlt, Storage nicht
erreichbar, Download-Fehler): `icon_url = null`, Job läuft **normal weiter**,
`PoolIcon` zeigt den bestehenden 🎵-Fallback. Ein fehlendes Titelbild darf
niemals einen sonst gültigen Import scheitern lassen.

**Löschung an den Datensatz gekoppelt.** Das Storage-Objekt hängt nicht am
Cascade der Tabelle. Es wird deshalb explizit mitgelöscht, und zwar an der
einzigen Stelle, die beide Seiten kennt: dem Aufräum-Task des Workers (10.5) —
er löscht erst das Objekt, dann die Zeile, und räumt zusätzlich verwaiste
`imported/*`-Objekte ohne zugehörige `imported_pools`-Zeile ab (deckt
`delete_imported_pool` und jeden abgebrochenen Import mit ab). Ein DB-Trigger
scheidet aus, weil Postgres von dort keine Storage-Objekte löschen kann.

Verworfen: Auflösen bei jedem Zugriff (kostet Spotify-Calls aus genau dem
Budget, das 3.2 schützen soll) und kurze TTL mit Lazy-Refresh (gleicher
Einwand, plus Komplexität).

### 10.5 Ablauf, Verlängerung, Löschung

- `imported_pools.expires_at` = 30 Tage ab Import.
- `poolSource.loadSongs()` ruft bei `kind === 'imported'`
  `touch_imported_pool(id)` auf → `last_used_at = now()`,
  `expires_at = greatest(expires_at, now() + 30 Tage)`. Damit ist die
  Verlängerung tatsächlich implementiert und nicht nur behauptet (2/#14).
- Aufräum-Task (Worker-Tick, täglich):
  - Pools mit `expires_at < now()`: erst Storage-Objekt, dann Zeile (Songs und
    Mitgliedschaften per Cascade); anschließend verwaiste `imported/*`-Objekte.
  - Jobs über `purge_playlist_import_jobs()` — **nur terminale Zustände** mit
    `purge_after < now()` (Dropped-Songs per Cascade). `queued`/`running` sind
    ausgenommen, und `purge_after` wird erst beim Abschluss gesetzt (4.4), nicht
    beim Anlegen. In v3 hätte ein Job, der über Nacht auf freies Budget wartet,
    sich sieben Tage nach seiner *Erstellung* selbst gelöscht — mitsamt der
    Zeile, an der die App hängt.
  - `spotify_quota_signals` und `spotify_gameplay_reservations` älter als 24 h.
- Der Nutzer kann jederzeit `delete_imported_pool` auslösen; die letzte
  entfernte Mitgliedschaft löscht den Pool.

### 10.6 Logging, Aufbewahrung, Attribution

- Übertragen wird nur die Playlist-**ID**, nie die URL → `si=…` ist strukturell
  ausgeschlossen.
- Worker-Logs ohne Tokens, ohne vollständige URLs mit Query, ohne IPs.
- Jobs 7 Tage ab **Abschluss**. Technische Fehlerdetails stehen nicht in der
  Jobzeile, sondern in `playlist_import_job_errors` (service-role only, 4.4);
  der Client sieht ausschließlich den `error_code`.
- Attribution: „Musikdaten von Spotify" im Pool-Detail/Ergebnis; MusicBrainz,
  Discogs und ListenBrainz ebenfalls nennen (teils lizenzseitig gefordert).

### 10.7 Kill-Switches

`playlist_import.enabled = false` → RPC weist ab, Worker nimmt nichts an,
App blendet den Einstieg aus.

`scraper_enabled = false` schaltet den Browser ab. **Präzisierung gegenüber
v3:** Damit laufen ausschließlich **fertige Pool-Wiederverwendungen** weiter —
also Jobs, deren `reuse_candidate_pool_id` die Snapshot-/Versionsprüfung in
Phase 1 besteht (5.1). Alles andere ist ohne Scraper unmöglich, denn die
Playlist-**Mitgliedschaft** gibt es nur aus dem Browser (E1/E4); der
Metadaten-Cache hilft dann nichts, weil unbekannt bleibt, *welche* Tracks
überhaupt gefragt sind. Jobs ohne gültigen Reuse-Kandidaten enden bei
abgeschaltetem Scraper mit `feature_disabled`, statt in der Queue zu
verhungern.

Beides wirkt ohne Deploy.

---

## 11. Abnahme (§2/#7)

„0 abweichende Jahre gegen die kuratierten Pools" bleibt ein **notwendiges**
Gate, ist aber allein nicht ausreichend — unter anderem, weil der Referenzpool
selbst Fehler enthalten kann.

**A. Kalibrierlauf gegen die beiden kuratierten Referenzplaylists**
(050YaQ0larRRXuDXmmVgVi, 5DojEaEysNoNnqfdYCWEbf). Der Seed aus 4.10 wird für
diesen Lauf **deaktiviert**, sonst prüft man seine eigene Kopie.

- Jede Abweichung wird **einzeln adjudiziert** (Quelle nachschlagen,
  Entscheidung dokumentieren): Pipeline falsch, Referenz falsch, oder beide
  vertretbar (Original vs. Re-Release). Ergebnis ist eine Adjudikationsliste,
  kein bloßer Zähler.
- Berichtet werden **getrennt**:
  - **Precision** = korrekte Jahre unter den aufgenommenen Songs (Ziel: 100 %
    nach Adjudikation; jede echte Pipeline-Abweichung blockiert den Rollout),
  - **Coverage** = Anteil automatisch aufgenommener Songs (Ziel ≥ 85 %, siehe
    Gate (b) in 8.3).

**B. Holdout.** Mindestens zwei Playlists, die **nicht** in kuratierte Pools
eingeflossen sind, werden vollständig von Hand geprüft und dienen als
unabhängige Messung. Ohne Holdout misst der Kalibrierlauf teilweise sich selbst.

**C. Risiko-Segmente.** Gezielt zusammengestellte Testmengen (je 20–30 Songs),
weil genau dort die Entscheidungslogik arbeitet:

| Segment | Prüft |
|---|---|
| Remaster / „… (2019 Remaster)" | `remaster_or_deluxe_context`, `mb_year_suspicious_late` |
| Greatest Hits / Best of | `compilation_context`, `catalog_context` |
| Compilations mit „Various Artists" | Artist-Zuordnung + Kontext-Flags |
| Reissues / Jubiläumsausgaben | Discogs-vs-MB-Konflikt (`discogs_earlier_than_mb`) |
| Tracks ohne ISRC | `no_isrc`-Pfad, Verwerfen statt Raten |
| Text-Fallback-Fälle (ISRC-Miss in MB) | `mb_text_match_only`, Scoring |

**D. Betriebsabnahme** (nicht inhaltlich, aber Rollout-blockierend):
Budget-Ledger stimmt nach einem echten Import mit den Zählern überein;
ein simulierter Worker-Absturz wird vom Reaper korrekt aufgeräumt;
`QUOTA_EXCEEDED` setzt `blocked_until` und die App unterlässt den
Cover-Prefetch.

---

## 12. Restrisiken (offen, bewusst nicht als gelöst dargestellt)

**12.1 DOM-/Netzwerk-Stabilität des Scrapers.** E4 belegt Korrektheit und
Reproduzierbarkeit über **drei Läufe innerhalb einer Sitzung** — nicht über
Tage oder Wochen. Spotify fährt Anti-Scraping-Maßnahmen hoch; die
Netzwerkform kann sich ohne Vorwarnung ändern. Gegenmaßnahmen: `scraperVersion`
in jedem Ergebnis, getrennter `scraper_enabled`-Kill-Switch, Fehlercode
`scraper_broken` mit Verweis auf den scraper-freien Weg (Playlist ins eigene
Profil kopieren, dann liefert `/items` die Inhalte regulär —
[import-spotify-playlist.js:370-376](../scripts/import-spotify-playlist.js#L370-L376);
in der App kostete das den zusätzlichen Scope `playlist-read-private` und damit
einen erneuten Consent-Dialog,
[spotify.ts:462-463](../src/services/spotify.ts#L462-L463)).
**Vor dem Rollout**: derselbe Testlauf an drei verschiedenen Tagen.

**12.2 Semantik des Spotify-Kontingents.** Gemessen sind 594 Requests und ~4 h
`Retry-After` in **einem** Testlauf (E3). Unbekannt bleiben: ob 594 eine stabile
Grenze oder lastabhängig ist, ob das Fenster rollierend oder fix ist — die ~4 h
können ebenso gut die Restzeit bis zu einem festen Reset gewesen sein wie eine
Fenstergröße —, und wie andere Endpunkte gewichtet werden. Deshalb die
konservative Aufteilung 250/220/124 (4.1) und die Selbstkalibrierung über
`last_ceiling_observed`, die eine tatsächlich beobachtete Grenze dauerhaft
gegen den Startwert durchsetzt (4.11). **Vor der Feature-Aktivierung** wird die
Reset-Semantik gemessen (wann genau werden die Zähler frei?) und die Werte
werden danach nachgezogen — gemeinsam mit 12.5 und als Teil der
Betriebsabnahme (11 D).

**12.3 Anonyme Identität.** Neuinstallation der App = neue Identität = Verlust
des Zugriffs auf eigene importierte Pools (4.2). Bewusst akzeptiert.

**12.5 Getrennte Breaker (`blocked_until` / `import_blocked_until`).** Die
Aufteilung beruht auf der Einschätzung, dass ein von App-Signalen erreichbarer
*globaler* Breaker ein Denial-of-Service gegen laufende Partien wäre, ein auf
Importe begrenzter dagegen tragbar. Belastbare Messdaten dazu — wie oft die App
im Alltag überhaupt eine Quotensperre sieht, und ob die Signale in der Praxis
zutreffen — fehlen. Wird zusammen mit der Reset-Semantik (12.2) **vor der
Feature-Aktivierung** nachgemessen; bis dahin bewusst akzeptiertes Restrisiko,
kein Konstruktionsfehler.

**12.4 Policy.** Das Spiele-/Trivia-Verbot der Spotify Developer Policy und der
Scraping-Verstoß gegen die Developer Terms bleiben unverändert bestehen und
sind vom Projektinhaber bewusst akzeptiert (App bleibt privat, kein
Public-Release). Nicht erneut aufgerollt.

---

## 13. Umsetzung in Etappen

| # | Etappe | Ergebnis | Abhängig von |
|---|---|---|---|
| 1 | Migration `012` + Seed (nur SQL-Datei, manuell eingespielt) + Anonymous Auth im Dashboard | Schema, Budget-Ledger, warmer Override-Cache | – |
| 2 | `packages/song-decision` extrahieren, 21 Golden Tests grün, `upload-ready.ts` geteilt | portierte Entscheidungslogik | – |
| 3 | **Worker ohne Scraper**: Track-IDs als CSV-Input, volle Verifikation, Budget-RPCs | Pipeline gegen die kuratierten Pools abgenommen (11 A) | 1, 2 |
| 4 | App: Anonymous Auth, `poolSource.ts`, `deckRequirements.ts`, Cover-Pfad auf `reserve_gameplay_calls`/`settle_gameplay_calls` umstellen, **`@supabase/supabase-js` anheben** (Spaltenprojektion bei `postgres_changes`, heute `^2.108.2`) inkl. Integrationstest der Realtime-Payload | Bestand vorbereitet, Startgate korrigiert | 1 |
| 5 | Scraper nach Vertrag 6 + Job-Loop + Lease/Reaper | End-to-End serverseitig | 3 |
| 6 | Import-UI (Fortschritt, Ergebnis, Verlustliste, importierte Pools im Picker) | Feature nutzbar | 4, 5 |
| 7 | Holdout + Risiko-Segmente (11 B/C), Betriebsabnahme (11 D), Kill-Switches scharf | Rollout-Freigabe | 6 |

Etappe 3 bleibt der wichtigste Zwischenschritt: Die gesamte
Verifikations-Pipeline ist damit **ohne einen einzigen Browser** gebaut und
gegen menschlich reviewte Referenzdaten geprüft.

Etappe 4 ist bewusst vorgezogen — sie enthält mit der Budget-Meldung im
Cover-Pfad und dem korrigierten Startgate zwei Änderungen, die den Bestand
**unabhängig vom Import** verbessern.

---

## 14. Offene Entscheidungen für die Gegenprüfung

1. **Anonymous Auth** (4.2) verändert die globale Supabase-Client-Konfiguration
   für **alle** Online-Features (`persistSession`, `autoRefreshToken`,
   Storage-Adapter). Die Policy-Analyse sagt: verträglich. Bestätigen — und
   prüfen, ob die Table-Grants für `authenticated` auf allen Bestandstabellen
   wirklich gesetzt sind (Lektion aus 007).
2. **Gate-Schwellen** (8.3): `min_import_songs = 40`, Retention 0,85 / 0,60,
   `large_pool_threshold = 120` — passend zur tatsächlichen Spielpraxis?
3. **Aufteilung großer Importe**: Soll ein Job, dessen Bedarf das Restbudget
   übersteigt, in zwei Fenster aufgeteilt werden dürfen (Metadaten in zwei
   Etappen, Job bleibt über Stunden offen)? Aktuell nicht vorgesehen — der Job
   wartet komplett auf das nächste Fenster. Mit `import_cap = 220` betrifft das
   erst Playlists jenseits von ~215 eindeutigen, ungecachten Tracks; bei
   `max_playlist_entries = 200` also nur den Rand.
**In v4.0 erledigt und daher hier entfallen:** Queue-Überschuss unter
paralleler Last (globaler Queue-Lock, 4.11).

**Bereits in v3.1 erledigt:** Budget-Startwerte (jetzt
250/220/124 mit Begründung in 4.1), Realtime-vs-Polling (Realtime direkt auf der
Job-Tabelle, Polling nur als Fallback, 4.5), `og_meta`-Behandlung (hart
abgelehnt, 6.2).
