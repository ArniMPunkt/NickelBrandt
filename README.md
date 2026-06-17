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
