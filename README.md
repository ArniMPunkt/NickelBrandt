# NickelBrandt

React Native / Expo app. This commit is a **technical spike** to verify the
`react-native-spotify-remote` integration (OAuth login, play by URI,
pause/resume, track metadata) with a Spotify **Premium** account.

> ⚠️ The `SpotifyTestScreen` is throwaway verification code and will be removed
> once the spike is confirmed.

## Stack

- Expo **SDK 54** (TypeScript), **Development Build** — _not_ Expo Go.
- Old architecture (`newArchEnabled: false`) — required because
  `react-native-spotify-remote` (v0.3.x, 2021) is a legacy bridge module.
- React Navigation (Native Stack inside a Bottom Tab navigator, prepared).
- App: **NickelBrandt** · package / bundle id: **com.nickelbrandt.app**

## Project structure

```
/src
  /screens     SpotifyTestScreen (spike), PlaceholderScreen
  /services    spotify.ts  (auth + remote + Web API wrapper)
  /types       spotify.ts  (TrackMeta)
  /components /hooks /context   (empty, ready for later)
/plugins       withSpotifyRemote.js  (custom Expo config plugin)
/assets
App.tsx        navigation root
app.config.ts  app identity, newArch off, plugin registration
```

## One-time setup

### 1. Spotify Developer Dashboard
1. Create an app at https://developer.spotify.com/dashboard.
2. Copy the **Client ID**.
3. Under _Edit Settings → Redirect URIs_, add **both** (exactly):
   - `nickelbrandt://spotify-login-callback` — App Remote login (playback)
   - `nickelbrandt://spotify-web-callback` — Web API PKCE login (playlist reads)
4. Add your test device's Spotify account under _Users and Access_ (apps start
   in development mode).

> Why two logins: the App Remote SDK token is playback-only and lacks Web API
> playlist scopes, so playlist data is loaded with a separate PKCE token
> (Authorization Code + PKCE via `expo-auth-session`, no backend). Playback still
> uses the App Remote login.

### 2. Environment
Copy `.env.example` to `.env` and fill in the Client ID:
```
EXPO_PUBLIC_SPOTIFY_CLIENT_ID=<your client id>
EXPO_PUBLIC_SPOTIFY_REDIRECT_URI=nickelbrandt://spotify-login-callback
```
`.env` is git-ignored; `.env.example` is committed.

### 3. Test device requirements
- The **Spotify app must be installed** on the device/emulator (the App Remote
  SDK talks to it).
- The logged-in Spotify account must be **Premium**.

## Run (Android, on Windows)

```bash
npx expo prebuild -p android --clean   # regenerate native project + apply plugin
npx expo run:android                   # build & install the dev client
```

> iOS isn't built here (Windows host). The config plugin already registers the
> iOS URL scheme; when building iOS later you must also forward the auth
> callback in `AppDelegate.swift` — see the note in
> [plugins/withSpotifyRemote.js](plugins/withSpotifyRemote.js).

## What the spike verifies

On the **Spotify** tab:
1. **Mit Spotify verbinden** → Spotify login, returns to the app.
2. A hardcoded track (`spotify:track:4uLU6hMCjMI75M1A2tKUQC`) starts playing.
3. Title, artist, and release year (+ cover) are shown — year/cover come from
   the Spotify Web API (`GET /v1/tracks/{id}`), the rest from the Remote SDK.
4. The **Pause/Play** button toggles playback.

## Native patches (important)

`react-native-spotify-remote` (and its nested `react-native-events`) ship
RN-0.58/0.60-era `android/build.gradle` files that do **not** build with the
modern Android Gradle Plugin (they use the removed `maven` plugin and omit the
required `namespace`). They are fixed via [patch-package](https://www.npmjs.com/package/patch-package):

- Patches live in [patches/](patches/) and are applied automatically by the
  `postinstall` script on every `npm install` — no manual step.
- This is why `npm install` prints `patch-package … Applying patches…`. If you
  ever see a patch fail to apply (e.g. after bumping the library), regenerate it
  with `npx patch-package react-native-spotify-remote --include "build.gradle"`.

The Android debug build (`./gradlew :app:assembleDebug`) has been verified green
with these patches on Expo SDK 54 / RN 0.81.

## Notes / fallbacks

- **Auth flow:** backend-less TOKEN flow (no token-swap server). The access
  token lasts ~1h, which is enough for the spike. A persistent session would
  require a token-swap/refresh backend (out of scope).
- **Android redirect handling:** the bundled `spotify-auth` AAR declares its own
  `AuthCallbackActivity`; the config plugin only supplies the
  `com_spotify_sdk_redirect_scheme` / `_host` string resources plus the
  `<queries>` visibility for `com.spotify.music`.
- If the legacy module ever fails to build on a newer SDK, pin back to Expo
  SDK 53 (last resort).

## Release

One command for both platforms; the machine decides what gets built
(`scripts/release.js`, fixed values in `scripts/release.config.json`):

| Command / switch | Effect |
| --- | --- |
| `npm run release` | Windows: Android AAB + APK · Mac: iOS build + TestFlight upload |
| `npm run release:check` | preflight checks only, no build |
| `--aab-only` | Windows: AAB only (`npm run android:aab`) |
| `--skip-prebuild` | Windows: reuse `android/` (aborts if its versions differ from `app.config.ts`) |
| `--no-submit` | Mac: build only, no upload |
| `--force` | git problems only warn instead of aborting |

Pass switches after `--`, e.g. `npm run release -- --no-submit`. Artifacts land in
`release/NickelBrandt-<version>-<build>.{aab,apk,ipa}` (gitignored). Version numbers
are never bumped by the script: raise `version`, `ios.buildNumber` and
`android.versionCode` in `app.config.ts` yourself, then commit and push - the
preflight requires a clean `main` equal to `origin/main`.

### Setup per machine

Every machine: Node ≥ 20.19.4, `git clone`, `npm install`, and the project's
`.env` (see `.env.example`).

**Main PC (Windows) - Android**
- JDK 17+ via `JAVA_HOME` (or Android Studio's bundled `jbr`), Android SDK via
  `ANDROID_HOME` (or the default location under `%LOCALAPPDATA%\Android\Sdk`)
  with build-tools installed.
- `nickelbrandt.keystore` in the project folder and `.env.signing.local` filled
  from `.env.signing.local.example` (both gitignored, never commit).
- Gradle runs with 4 GB heap; the machine needs enough free RAM.

**Second Windows laptop - Android**
- Same as the main PC. Copy `nickelbrandt.keystore` and `.env.signing.local`
  over a private channel (USB stick, password manager) - never via git, chat or
  e-mail. The preflight checks the signature fingerprint of every build, so a
  wrong keystore is caught before an upload.

**MacBook - iOS**
- Xcode, CocoaPods, fastlane and `eas-cli` (`npm install -g eas-cli`), then
  `eas login`.
- `credentials.json` and the `credentials/` folder (certificate + provisioning
  profile) in the project folder, both gitignored.
- No local prebuild needed: `eas build --local` creates `ios/` itself.

## Songpool Scripts

Precheck:

```bash
node scripts/precheck-song-pool.js scripts/raw_hitster_summer_v2.csv scripts/review.csv --no-interactive --deezer=off --discogs=needed --listenbrainz=needed --lb-auto-accept=safe
```

Review-only:

```bash
node scripts/review-song-pool.js scripts/review.csv scripts/review_final.csv
```

Upload:

```bash
node scripts/upload-song-pool.js scripts/review_final.csv "<Pool Name>" "<Description>"
```
