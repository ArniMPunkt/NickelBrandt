# NickelBrandt – Übergabe-Doku für Folge-Chat
Stand: 30.06.2026

---

## Projekt-Kontext

**NickelBrandt** ist ein Hitster-Klon-Musikquiz (React Native / Expo SDK 54, Old Architecture, TypeScript), entwickelt von Arni (Product Owner + Alleinentwickler). Zwei Spielmodi: **Hot-Seat** (ein Gerät, lokal) und **Mit Freunden** (Online-Multiplayer via Supabase, Musik läuft nur beim Host). Spotify-Integration via `react-native-spotify-remote`. Repo: `github.com/ArniMPunkt/NickelBrandt` (privat, Branch: `main`).

**Setup**: Windows 10 (Ryzen 7 3700X) für Entwicklung via Claude Code, MacBook Air M1 ausschließlich für iOS-Builds. Arni führt alle Terminal-Befehle selbst aus, kein EAS (lokale Builds bevorzugt). Android-Signing via Config-Plugin.

---

## Arbeitsweise (WICHTIG)

1. Claude (im Chat) schreibt strukturierte Prompts für Claude Code — kein Code direkt, sondern klare Anforderungen
2. Arni führt alle Terminal-Befehle selbst aus — Prompts an Claude Code beschreiben nur Anforderungen, keine Shell-Befehle als Anweisung
3. Bei Bugs: zuerst Ursache analysieren und erklären lassen, bevor Code geändert wird
4. Bei technischen Unsicherheiten (Spotify-API, Supabase, etc.): vorher recherchieren, nicht aus dem Gedächtnis raten
5. JS-only bevorzugt: Änderungen wenn möglich ohne nativen Rebuild (Metro-Reload reicht), Rebuild-Bedarf klar kennzeichnen

---

## Aktueller Code-Stand (nach diesem Chat)

Alle Änderungen committed und auf `origin/main` gepusht. Beide Maschinen (Windows + Mac) synchron.

### Song-Pool-Pipeline (scripts/)
- **Drei-Stufen-Architektur**: `import-spotify-playlist.js` (Pre-Pre) → `precheck-song-pool.js` (Pre) → `upload-song-pool.js` (Upload)
- **`import-spotify-playlist.js`**: Liest Spotify-Playlists via Authorization Code + PKCE (User-Login, lokaler Server auf `localhost:8888`). Token-Cache in `scripts/.spotify-user-token.json` (gitignored). Schreibt CSV mit `title,artist,estimated_year,spotify_track_id,isrc`. Nutzt `/playlists/{id}/items`-Endpunkt (Feb-2026-Migration). Playlist muss zuerst in eigenes Spotify-Profil kopiert werden (Spotify-Policy seit Nov 2024)
- **`precheck-song-pool.js`**: Fast-Path wenn `spotify_track_id` + `isrc` bekannt (nur MusicBrainz-Jahresprüfung, ~57s für 308 Songs). Volle Resolver-Kette (Credits.fm → Deezer → Spotify-Text-Fallback) nur für Custom-Listen ohne Track-ID
- **Credits.fm-Integration**: Batch-ISRC-Auflösung, Async-Cache-Verhalten (Nachpoll-Runden nötig), kein API-Key erforderlich bei dieser Pool-Größe
- **Fertige Pools in Supabase**: HITSTER Summer Party (308), HITSTER Original (308), Nu Metal vs. Classic Rock (207), Poland-Test (308)

### iOS-Build & TestFlight
- **iOS-Spotify aktiviert**: `withSpotifyRemote.js` Config-Plugin konfiguriert CFBundleURLTypes, LSApplicationQueriesSchemes, AppDelegate.swift Callback-Forwarding, Bridging Header
- **Spotify-Auth**: iOS nutzt `auth.authorize()` + `remote.connect(accessToken)`, Android nutzt `connectWithoutAuth()`
- **Simulator-Problem (bekannt, ungelöst)**: `SpotifyiOS.framework` hat keinen arm64-iossimulator-Slice für iOS 26 Simulator auf M1. Workaround: `EXCLUDED_ARCHS[sdk=iphonesimulator*]=arm64` in Plugin gesetzt, aber iOS 26 Simulator kann das x86_64-Binary nicht mehr installieren. Device-Builds/TestFlight funktionieren einwandfrei
- **TestFlight Build 2 aktiv**: App-ID `com.nickelbrandt.app`, interne Tester-Gruppe "NickelBrandt-Tester", Provisioning-Profil "NickelBrandt AppStore"
- **Android Release-Signing**: `plugins/withAndroidReleaseSigning.js` via `withAppBuildGradle`. Keystore `nickelbrandt.keystore` im Projekt-Root (gitignored). Credentials via Umgebungsvariablen (`NICKELBRANDT_KEYSTORE_PASSWORD`, `NICKELBRANDT_KEY_ALIAS`, `NICKELBRANDT_KEY_PASSWORD`)

### App-Features (dieser Chat)
- **Onboarding-Screen**: 3 Slides, ScrollView pagingEnabled, AsyncStorage-Flag, Dot-Morphing-Animation
- **Sieg-Screen (`VictoryCelebration.tsx`)**: Konfetti (28 Animated.View-Partikel), View-basierter Pokal, freistehender Gewinnername mit Text-Glow. Online-Sync: Server-getrieben über `phase: 'finished'`
- **`glow.ts`** in `src/theme/`: Plattformbewusst (iOS echte Glows, Android leere Objekte). 24 Stellen migriert, Android-Schatten-Bug behoben
- **`PressableButton.tsx`**: Zentraler Wrapper, `opacity: 0.6` bei pressed. 48 von 50 Touch-Targets migriert (2 ausgeschlossen: ganzflächige Taps in IntroScreen/OnlineIntroScreen)
- **Tab-Bar-Fix**: `useSafeAreaInsets()` in `RootTabs`, `height: 64 + insets.bottom`
- **Spielername-Persistenz**: `@nickelbrandt/player_name` via AsyncStorage, vorausgefüllt in `OnlineHomeScreen.tsx`
- **Spotify-Nicht-Verbunden-Hinweis**: Vorab-Check in `PlaylistPickerScreen.tsx`, Cyan-Hinweis-Box + Navigation zu Einstellungen
- **Cover-Art für Themen-Pools**: `Spotify.addCoverArt(cards)` in `spotify.ts` (Batch `GET /v1/tracks?ids=…`), eingehängt in `deck.ts loadDeckSource` nur für Pool-Pfad. Host reichert Karten an, alle Clients bekommen Cover-URLs synchronisiert
- **Grün-Markierung aktiver Spieler**: Online: `scoreRowActive` Style (grüner Rand + `glow(COLORS.correct)`), konditional auf `gs.activePlayerId`. Hot-Seat: `headerLeft`-Container mit grünem Glow-Rand

### Bugfixes (Live-Test 29.06.2026)
- **Song stoppt nach Nickel-Entscheidung** (behoben): `OnlineGameScreen.tsx:259`: `if (phase === 'finished')` → `if (phase === 'finished' && gs?.winnerId)`. `finished` war doppelt genutzt für Rundenende UND Spielende
- **Android-Spotify-Sackgasse** (behoben): `connect()` fängt "not authorized" ab, ruft `clearAuthState()` + einmaliger Retry
- **iOS-Endlos-Loading** (Timeout-Fallback): `withTimeout`-Wrapper (20s) um alle nativen App-Remote-Aufrufe

---

## Spotify Developer Dashboard

Redirect-URIs (alle korrekt eingetragen):
- `nickelbrandt://spotify-login-callback` ✅
- `nickelbrandt://spotify-web-callback` ✅
- `http://127.0.0.1:8888/callback` ✅ (für Node-Playlist-Import-Skript)

---

## Offener Backlog (Stand 30.06.2026)

### Online/Sync
- Reconnect-Flow beim Spielstart: Spotify verbindet sich beim neuen Spiel nicht automatisch
- iOS-Spotify-Verbindung: Verifikation nach Build 2 noch ausstehend (Tester hat noch nicht gemeldet)
- Host-Disconnect-Handling: Song bleibt hängen wenn Host die App verlässt

### Gameplay / UI
- "Karten zum Gewinnen"-Anzeige fehlerhaft/fehlt
- Automatischer Zoom/Scroll zur Lücke in der Zeitlinie nach Kartenplatzierung
- Eine Karte wird nicht aufgedeckt (Kontext unklar, erst mit Arni klären)
- "Anmachen"-Button/Recovery-Mechanismus wenn Spielablauf hängt
- Kartenstapel-Reihenfolge wird nicht lokal gemerkt (Hot-Seat)
- Wording "Mit Freunden" gefällt Arni nicht

### Datenqualität (Song-Pools)
- Ein Song hatte falsches Jahr (1958 statt 1996) — welcher Pool?
- Celebration-Edition: Jahre vor 1980 prüfen
- Noch fehlende Pools: HITSTER Rock, Schlager, Celebration, Platinum, Deutschrap+HipHop (CSVs in `scripts/`, precheck ausstehend)

### Design / Repo
- `scripts/`-Ordner wird mit committed (`.gitignore` anpassen)
- iOS-Simulator-Spotify wieder funktionsfähig (strukturelles Framework-Problem)
- Fehlertexte PlaylistPickerScreen für echte API-Fehler (429, Netzwerk, gesperrte Playlist) noch roh

---

## Wichtige Architektur-Entscheidungen

- **Lokale Builds** bevorzugt (kein EAS)
- **Imported Spotify-Playlists**: kein Künstler-Limit — 1:1 übernommen. Künstler-Limit gilt nur für KI-generierte Custom-Listen
- **CSV-/Song-Pool-Dateien** immer in `scripts/`-Ordner
- **`ios/` und `android/`** nicht committed. Alle dauerhaften nativen Anpassungen müssen als Config-Plugins (`plugins/*.js`) verankert sein — nie direkt im generierten Ordner editieren (geht bei `prebuild --clean` verloren)
- **`GameContext`-Reinheits-Prinzip**: Hot-Seat-Reducer ist pur (keine Navigation, keine Seiteneffekte) — bewusste Architektur-Entscheidung
- **Hot-Seat und Online** sind komplett getrennte Code-Welten (eigene Screens, eigener State) — nur Typen und einzelne Logik-Funktionen geteilt
- **Migration `003_brandt_streak.sql`** muss in Supabase ausgeführt werden vor Online-Modus-Tests
- **MusicBrainz User-Agent**: Placeholder-Email (`kontakt@beispiel.de`) in `musicbrainz.ts` vor Wider-Distribution ersetzen
- **RLS-Policies** bewusst offen für Freundeskreis-Maßstab
- **`.env`-Dateien** gitignored, auf jedem Rechner manuell anlegen (`EXPO_PUBLIC_SPOTIFY_CLIENT_ID`, `EXPO_PUBLIC_SPOTIFY_REDIRECT_URI`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`)
- **Bei jedem `npm install`**: `postinstall` → `patch-package` wendet Spotify-Patches erneut an

## Bewusst zurückgestellte Punkte (kein akuter Handlungsbedarf)

- **Skip/Blind-Buy-Nickel**: "Bald verfügbar"-Platzhalter in `SettingsScreen.tsx`, nie implementiert
- **"Spielstatistiken zurücksetzen"**: UI-Platzhalter ohne Funktion in `SettingsScreen.tsx`
- **Hot-Seat-Einstellungen**: nur In-Memory, nicht persistent über App-Neustarts
- **Verwaiste Assets**: `assets/android-icon-{background,foreground,monochrome}.png`, `assets/splash-icon.png` — unreferenziert
- **`[MBTiming]`/`[MusicBrainz]`-Debug-Logs**: ~16 Stellen in `musicbrainz.ts`, Aufräum-Kandidat

---

## Build-Befehle (zur Referenz)

### Android Release-AAB (lokal, Windows)
```powershell
$env:NICKELBRANDT_KEYSTORE_PASSWORD = "..."
$env:NICKELBRANDT_KEY_ALIAS         = "nickelbrandt"
$env:NICKELBRANDT_KEY_PASSWORD      = "..."

npx expo prebuild --platform android --clean
cd android
.\gradlew.bat --stop
.\gradlew.bat bundleRelease
cd ..
```
Output: `android/app/build/outputs/bundle/release/app-release.aab`

### iOS-Build (lokal, Mac)
1. `git pull`
2. `npx expo prebuild --platform ios --clean`
3. `cd ios && pod install`
4. `open ios/NickelBrandt.xcworkspace`
5. Ziel: "Any iOS Device (arm64)" → `Product → Archive`
6. Organizer → "Distribute App" → "App Store Connect" → "Upload"

### Song-Pool-Import-Workflow (HITSTER-Editionen)
1. Playlist in eigenes Spotify-Profil kopieren (Spotify-Policy!)
2. `node scripts/import-spotify-playlist.js <playlistId|URL> scripts/raw_<name>.csv`
3. `node scripts/precheck-song-pool.js scripts/raw_<name>.csv scripts/review_<name>.csv`
4. Review-CSV analysieren (große diff-Werte: meist MB-Jahr korrekt, csv_year = Compilation-Jahr)
5. finale CSV erstellen (final_year setzen)
6. `node scripts/upload-song-pool.js scripts/<name>_final.csv "<Pool-Name>" "<Beschreibung>"`
