# NickelBrandt – Übergabe-Doku für Folge-Chat
Stand: 30.06.2026

---

## Projekt-Kontext

**NickelBrandt** ist ein Hitster-Klon-Musikquiz (React Native / Expo SDK 54, Old Architecture, TypeScript), entwickelt von Arni (Product Owner + Alleinentwickler). Zwei Spielmodi: **Hot-Seat** (ein Gerät, lokal) und **Mit Freunden** (Online-Multiplayer via Supabase, Musik läuft nur beim Host). Spotify-Integration via `react-native-spotify-remote`. Repo: `github.com/ArniMPunkt/NickelBrandt` (privat, Branch: `main`).

**Setup**: Windows 10 (Ryzen 7 3700X) für Entwicklung via Claude Code, MacBook Air M1 ausschließlich für iOS-Builds. Arni führt alle Terminal-Befehle selbst aus, kein EAS (lokale Builds bevorzugt). Android-Signing via Config-Plugin.

---

## Aktueller Code-Stand (nach diesem Chat)

Alle Änderungen sind committed und auf `origin/main` gepusht. Beide Maschinen (Windows + Mac) sind synchron.

### Neu hinzugekommen in diesem Chat

#### Song-Pool-Pipeline (scripts/)
- **Drei-Stufen-Architektur**: `import-spotify-playlist.js` (Pre-Pre) → `precheck-song-pool.js` (Pre) → `upload-song-pool.js` (Upload)
- **`import-spotify-playlist.js`**: Liest öffentliche Spotify-Playlists via Authorization Code + PKCE (User-Login, lokaler Server auf `localhost:8888`). Token-Cache in `scripts/.spotify-user-token.json` (gitignored). Schreibt CSV mit `title,artist,estimated_year,spotify_track_id,isrc`. Nutzt `/playlists/{id}/items`-Endpunkt (Feb-2026-Migration). Playlist muss zuerst in eigenes Spotify-Profil kopiert werden (Spotify-Policy seit Nov 2024).
- **`precheck-song-pool.js`**: Fast-Path wenn `spotify_track_id` + `isrc` bekannt (nur MusicBrainz-Jahresprüfung, ~57s für 308 Songs). Volle Resolver-Kette (Credits.fm → Deezer → Spotify-Text-Fallback) nur für Custom-Listen ohne Track-ID.
- **Credits.fm-Integration**: Batch-ISRC-Auflösung, Async-Cache-Verhalten (Nachpoll-Runden nötig), kein API-Key erforderlich bei dieser Pool-Größe.
- **Fertige Pools in Supabase**: HITSTER Summer Party (308), HITSTER Original (308), Nu Metal vs. Classic Rock (207), Poland-Test (308).

#### iOS-Build & TestFlight
- **iOS-Spotify aktiviert**: `react-native-spotify-remote` war für iOS deaktiviert, jetzt aktiv. `withSpotifyRemote.js` Config-Plugin konfiguriert CFBundleURLTypes, LSApplicationQueriesSchemes, AppDelegate.swift Callback-Forwarding, Bridging Header.
- **Spotify-Auth iOS vs Android**: iOS nutzt `auth.authorize()` + `remote.connect(accessToken)`, Android nutzt `connectWithoutAuth()`.
- **Simulator-Problem (bekannt, ungelöst)**: `SpotifyiOS.framework` hat keinen arm64-iossimulator-Slice für iOS 26 Simulator auf M1 (kein Rosetta-Fallback mehr). Workaround: `EXCLUDED_ARCHS[sdk=iphonesimulator*]=arm64` in Plugin gesetzt, aber iOS 26 Simulator kann dann das x86_64-Binary nicht mehr installieren. **Device-Builds/TestFlight funktionieren einwandfrei.**
- **TestFlight Build 1 + Build 2**: Erfolgreich hochgeladen. App-ID `com.nickelbrandt.app` registriert. Interne Tester-Gruppe "NickelBrandt-Tester" aktiv. Manuelles Provisioning-Profil "NickelBrandt AppStore" erstellt.
- **Android Release-Signing**: `plugins/withAndroidReleaseSigning.js` Config-Plugin via `withAppBuildGradle`. Keystore `nickelbrandt.keystore` im Projekt-Root (gitignored). Credentials via Umgebungsvariablen (`NICKELBRANDT_KEYSTORE_PASSWORD`, `NICKELBRANDT_KEY_ALIAS`, `NICKELBRANDT_KEY_PASSWORD`).

#### App-Features (dieser Chat)
- **Onboarding-Screen**: 3 Slides, ScrollView pagingEnabled, AsyncStorage-Flag, Dot-Morphing-Animation.
- **Sieg-Screen (`VictoryCelebration.tsx`)**: Konfetti (28 Animated.View-Partikel), View-basierter Pokal (kein Emoji), freistehender Gewinnername mit Text-Glow, "WEITER ZUR STATISTIK"-Button. Online-Sync: Server-getrieben über `phase: 'finished'`.
- **`glow.ts`** in `src/theme/`: Plattformbewusst (iOS echte Glows, Android leere Objekte). 24 Stellen migriert. Android-Schatten-Bug behoben.
- **`PressableButton.tsx`**: Zentraler Wrapper, `opacity: 0.6` bei pressed. 48 von 50 Touch-Targets migriert (2 bewusst ausgeschlossen: ganzflächige Taps in IntroScreen/OnlineIntroScreen).
- **Tab-Bar-Fix**: `useSafeAreaInsets()` in `RootTabs`, `height: 64 + insets.bottom`. Heller Indikator-Strich schneidet nicht mehr durch Labels.
- **Spielername-Persistenz**: `@nickelbrandt/player_name` via AsyncStorage. Vorausgefüllt in `OnlineHomeScreen.tsx`, gespeichert nach erfolgreichem Lobby-Erstellen/-Beitreten.
- **Spotify-Nicht-Verbunden-Hinweis**: Vorab-Check in `PlaylistPickerScreen.tsx` vor API-Call. Cyan-Hinweis-Box statt roter Fehlertext. Klickbarer Button navigiert zu Einstellungen-Tab.
- **Cover-Art für Themen-Pools**: Neue `Spotify.addCoverArt(cards)` in `spotify.ts` (Batch `GET /v1/tracks?ids=…`). Eingehängt in `deck.ts loadDeckSource` nur für Pool-Pfad. Host reichert Karten an, alle Clients bekommen Cover-URLs mitsynchronisiert. Spotify-Playlist-Karten hatten Cover schon.
- **Grün-Markierung aktiver Spieler**: Online: `scoreRowActive` Style (grüner Rand + `glow(COLORS.correct)`), konditional auf `gs.activePlayerId`. Hot-Seat: `headerLeft`-Container mit grünem Glow-Rand.

#### Bugfixes (Live-Test 29.06.2026)
- **Song stoppt nach Nickel-Entscheidung** (kritisch, behoben): `OnlineGameScreen.tsx:259`: `if (phase === 'finished') Spotify.pause()` → `if (phase === 'finished' && gs?.winnerId) Spotify.pause()`. `finished` war doppelt genutzt für Rundenende UND Spielende.
- **Android-Spotify-Sackgasse** (behoben): `connect()` fängt "not authorized" ab, ruft `clearAuthState()` + einmaliger Retry. Self-Heal ohne manuelles Datenlöschen.
- **iOS-Endlos-Loading** (Timeout-Fallback): `withTimeout`-Wrapper (20s) um alle nativen App-Remote-Aufrufe. Klare Fehlermeldung statt stummem Spinner. Echte Ursache unklar (Dashboard-Redirect-URIs korrekt: beide vorhanden).

---

## Spotify Developer Dashboard

Redirect-URIs (alle korrekt eingetragen):
- `nickelbrandt://spotify-login-callback` ✅
- `nickelbrandt://spotify-web-callback` ✅
- `http://127.0.0.1:8888/callback` ✅ (für Node-Playlist-Import-Skript)

---

## Offener Backlog (Stand 30.06.2026)

### Kritisch / Online-Sync
- **(b)** Reconnect-Flow beim Spielstart: Spotify verbindet sich beim neuen Spiel nicht automatisch, "trennen und neu verbinden" hilft als Workaround
- **(d)** iOS-Spotify-Verbindung lädt einfach weiter trotz 20s-Timeout (noch nicht vom Tester bestätigt nach Build 2, Verifikation ausstehend)

### Gameplay / UI
- **(g)** Kartenstapel-Reihenfolge wird nicht lokal gemerkt (Hot-Seat-Kontext)
- **(h)** "Karten zum Gewinnen"-Anzeige fehlerhaft/fehlt
- **(i)** Automatischer Zoom/Scroll zur Lücke in der Zeitlinie, wenn Karte platziert wurde
- **(j)** Eine Karte wird nicht aufgedeckt (Kontext unklar, prüfen)
- **(k)** "Anmachen"-Button/Recovery-Mechanismus wenn irgendwas im Spielablauf hängt

### Datenqualität (Song-Pools)
- **(l)** Ein Song hatte falsches Jahr (1958 statt 1996) — welcher Pool? Prüfen
- **(m)** Celebration-Edition: Jahre vor 1980 prüfen (Verdacht auf systematische Fehler)
- Noch fehlende Pools: HITSTER Rock, Schlager, Celebration, Platinum, Deutschrap+HipHop (CSVs vorhanden in `scripts/`, precheck noch ausstehend)

### Design / Repo
- Tab-Bar-Design-Bug unten (teilweise behoben durch Safe-Area-Fix)
- `scripts/`-Ordner wird mit committed (nicht nötig, `.gitignore` anpassen)
- iOS-Simulator-Spotify wieder funktionsfähig (strukturelles Framework-Problem, kein einfacher Fix bekannt)
- Fehlertexte PlaylistPickerScreen für echte API-Fehler (429, Netzwerk, gesperrte Playlist) noch roh/technisch

### Ausstehend aus Live-Test (teils Kontext unklar, erst mit Arni klären)
- Wording "Mit Freunden" gefällt Arni nicht → Alternativvorschläge sammeln
- Host-Disconnect-Handling für Musikwiedergabe (Song bleibt hängen wenn Host die App verlässt)

---

## Wichtige Architektur-Entscheidungen

- **Lokale Builds bevorzugt** (Android Studio/Gradle, Xcode), kein EAS
- **Imported Spotify-Playlists**: kein Künstler-Limit — 1:1 übernommen
- **Künstler-Limit** gilt nur für KI-generierte Custom-Listen
- **CSV-/Song-Pool-Dateien** immer in `scripts/`-Ordner
- **`ios/` und `android/`** nicht committed (generiert via `expo prebuild`)
- **Migration `003_brandt_streak.sql`** muss in Supabase ausgeführt werden vor Online-Modus-Tests
- **MusicBrainz User-Agent** Placeholder-Email vor Wider-Distribution ersetzen

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
4. Xcode öffnen: `open ios/NickelBrandt.xcworkspace`
5. Ziel: "Any iOS Device (arm64)"
6. `Product → Archive`
7. Organizer → "Distribute App" → "App Store Connect" → "Upload"

### Song-Pool-Import-Workflow (für HITSTER-Editionen)
1. Playlist in eigenes Spotify-Profil kopieren (Spotify-Policy!)
2. `node scripts/import-spotify-playlist.js <playlistId|URL> scripts/raw_<name>.csv`
3. `node scripts/precheck-song-pool.js scripts/raw_<name>.csv scripts/review_<name>.csv`
4. Review-CSV analysieren (große diff-Werte prüfen: meist MB-Jahr korrekt, csv_year = Compilation-Jahr)
5. finale CSV erstellen (final_year setzen)
6. `node scripts/upload-song-pool.js scripts/<name>_final.csv "<Pool-Name>" "<Beschreibung>"`
