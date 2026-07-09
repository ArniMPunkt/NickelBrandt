/**
 * Spotify integration: App Remote playback (react-native-spotify-remote) +
 * Web API access via a PKCE token (playlists, display name).
 *
 * Playback connects app-to-app via connectWithoutAuth() (Android ignores the
 * token arg). Web API reads use a separate PKCE token (expo-auth-session),
 * persisted in SecureStore. No backend.
 */
// IMPORTANT: do NOT import react-native-spotify-remote at the top level.
//
// The library accesses NativeModules.RNSpotifyRemoteAuth at *module-load* time
// (SpotifyAuth.js reads `NativeModules.RNSpotifyRemoteAuth.authorize` to patch
// it). On the very first JS bundle load the native bridge can still be null,
// which throws "Cannot read property 'authorize' of null" during the import
// itself - before any screen renders. A type-only import is erased at runtime,
// and we require() the SDK lazily (on first use, well after startup) inside a
// try/catch, so an uninitialized bridge can never crash module load.
// NativeModules is RN core - always available, never touches the spotify SDK.
import { NativeModules, Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import * as SecureStore from 'expo-secure-store';
import type { GameCard } from '../types/game';
// Type-only import: erased at runtime, so it never touches the SDK's native
// bridge at module load (see the top-of-file note about lazy require()).
import type { PlayerState } from 'react-native-spotify-remote';

// Lets expo-auth-session finish the redirect when the browser returns.
WebBrowser.maybeCompleteAuthSession();

const SDK_NOT_READY =
  'Spotify SDK is still initializing. Please try again in a moment.';

/** Cached SDK module once it has loaded successfully. */
let sdk: typeof import('react-native-spotify-remote') | null = null;

/**
 * Lazily require the SDK, but ONLY once its native modules are registered.
 *
 * Why the NativeModules gate (fixes the inconsistent "2-3 cold starts" startup):
 * react-native-spotify-remote captures NativeModules.RNSpotifyRemoteAuth /
 * RNSpotifyRemoteAppRemote at *module-eval* time. If we require() the library
 * while the bridge is still initializing, it captures null singletons and Metro
 * caches that broken module for the ENTIRE session - so it never recovers ("SDK
 * not ready" forever). By checking NativeModules first (RN core, populated
 * synchronously once the bridge is up) we only evaluate the library when its
 * native modules already exist, so the very first successful require is also
 * correct and gets cached. If the bridge isn't ready yet we throw WITHOUT
 * requiring the library, leaving it un-evaluated so a later call can succeed.
 */
function getSDK(): typeof import('react-native-spotify-remote') {
  if (sdk) return sdk;
  const missingModules = [
    !NativeModules.RNSpotifyRemoteAuth && 'RNSpotifyRemoteAuth',
    !NativeModules.RNSpotifyRemoteAppRemote && 'RNSpotifyRemoteAppRemote',
  ].filter(Boolean);
  if (
    missingModules.length > 0
  ) {
    if (Platform.OS === 'ios') {
      throw new Error(
        `Spotify native module missing on iOS (${missingModules.join(', ')}). ` +
          'Rebuild the iOS app after enabling RNSpotifyRemote and test on a real device.'
      );
    }
    throw new Error(SDK_NOT_READY);
  }
  try {
    const loaded = require('react-native-spotify-remote');
    if (!loaded || !loaded.auth || !loaded.remote) {
      throw new Error(
        'Spotify SDK loaded but native modules are not available yet - bridge not ready'
      );
    }
    sdk = loaded;
  } catch (e) {
    console.error('Spotify SDK not available:', e);
    throw new Error(SDK_NOT_READY);
  }
  return sdk!;
}

/** Lazily resolve the auth singleton, guarding against an uninitialized SDK. */
function getAuth() {
  const auth = getSDK().auth;
  if (!auth) throw new Error(SDK_NOT_READY);
  return auth;
}

/** Lazily resolve the remote singleton, guarding against an uninitialized SDK. */
function getRemote() {
  const remote = getSDK().remote;
  if (!remote) throw new Error(SDK_NOT_READY);
  return remote;
}

const CLIENT_ID = process.env.EXPO_PUBLIC_SPOTIFY_CLIENT_ID ?? '';
const REDIRECT_URL = process.env.EXPO_PUBLIC_SPOTIFY_REDIRECT_URI ?? '';

/** True once we have authorized AND connected the App Remote at least once. */
let connected = false;
/**
 * iOS only: the App-Remote access token captured at the last authorize(). Reused
 * for a SILENT reconnect (remote.connect(token) attaches to the running Spotify
 * app without an interactive app switch - only authorize() switches apps).
 */
let iosAppRemoteToken: string | null = null;
/** Track ids already used this session, so the deck never repeats a track. */
const playedTrackIds = new Set<string>();

// ---------------------------------------------------------------------------
// Live connection status (Baustein a)
//
// The `connected` flag used to be purely optimistic - it never learned about a
// real drop (e.g. iOS tearing down the App Remote when we background). We now
// (1) subscribe to the native remoteConnected/remoteDisconnected events so the
// flag tracks reality, and (2) let UI subscribe to status changes so the connect
// button reflects them live instead of only on tab focus.
// ---------------------------------------------------------------------------

type ConnectionListener = (ready: boolean) => void;
const connectionListeners = new Set<ConnectionListener>();
let connectionListenersAttached = false;

/** Push the current readiness to all UI subscribers (setState is idempotent). */
function notifyConnection(): void {
  const ready = isReadyToPlay();
  connectionListeners.forEach((l) => {
    try {
      l(ready);
    } catch {
      // a listener throwing must not break the others / the caller
    }
  });
}

/** Update the connection flag AND notify subscribers. Single source of truth. */
function setConnected(next: boolean): void {
  connected = next;
  notifyConnection();
}

/**
 * Attach the native App-Remote connect/disconnect listeners once, so the flag
 * self-updates when iOS drops the session in the background (and when a silent
 * reconnect re-establishes it). Best-effort: if the SDK isn't ready yet it stays
 * unattached and a later call (connect / subscribeConnection) retries.
 */
function ensureConnectionListeners(): void {
  if (connectionListenersAttached) return;
  let remote: ReturnType<typeof getRemote>;
  try {
    remote = getRemote();
  } catch {
    return; // SDK not ready -> retry on the next connect/subscribe
  }
  try {
    remote.on('remoteConnected', () => setConnected(true));
    remote.on('remoteDisconnected', () => setConnected(false));
    connectionListenersAttached = true;
  } catch {
    // leave unattached; a later call retries
  }
}

/**
 * Subscribe to live connection-readiness changes (Baustein d). Fires with the
 * current value immediately, then on every change. Returns an unsubscribe.
 */
export function subscribeConnection(cb: ConnectionListener): () => void {
  ensureConnectionListeners();
  connectionListeners.add(cb);
  try {
    cb(isReadyToPlay());
  } catch {
    // ignore
  }
  return () => {
    connectionListeners.delete(cb);
  };
}

// Hard bound for the App Remote native calls. The interactive PKCE browser step
// settles on its own (cancel/dismiss); these native bridge calls can silently
// never return (seen on iOS when the redirect doesn't come back), so we time-box
// them rather than let the UI spin forever.
const APP_REMOTE_TIMEOUT_MS = 20000;

/**
 * Reject if `p` doesn't settle within `ms`. The underlying promise is left to
 * settle on its own; we simply stop waiting on it and surface a clear error.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${label}: Zeitüberschreitung nach ${Math.round(ms / 1000)}s. Stelle sicher, dass ` +
            'die Spotify-App installiert, geöffnet und eingeloggt ist, und versuche es erneut.'
        )
      );
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** The "stale App Remote authorization" error we can self-heal from. */
function isStaleAuthError(e: any): boolean {
  return `${e?.code ?? ''} ${e?.message ?? e}`.toLowerCase().includes('not authorized');
}

/**
 * iOS "Spotify couldn't be woken" class of connect failures
 * (SPTAppRemoteBackgroundWakeupFailedError / transport stream error /
 * connection refused). Happens when the Spotify app is not running or was
 * suspended by iOS right after the auth redirect returned - SPTAppRemote can
 * only attach to an ALIVE Spotify app. Self-healed in connectAppRemote via the
 * SDK's documented wakeup path (authorize with playURI).
 */
function isWakeupError(e: any): boolean {
  const raw = `${e?.code ?? ''} ${e?.message ?? e}`.toLowerCase();
  return (
    raw.includes('wakeup') ||
    raw.includes('connection attempt failed') ||
    raw.includes('stream error') ||
    raw.includes('connection refused')
  );
}

/** Map a raw connect failure to a friendly, actionable message. */
function mapConnectError(e: any): Error {
  const raw = `${e?.code ?? ''} ${e?.message ?? e}`.toLowerCase();
  if (
    raw.includes('couldnotfindspotifyapp') ||
    raw.includes('could not find') ||
    raw.includes('not installed')
  ) {
    return new Error(
      'Spotify app not found. Install the Spotify app and open it once, ' +
        'then try again (the App Remote SDK talks to the running Spotify app).'
    );
  }
  if (raw.includes('not authorized')) {
    // Android UserNotAuthorizedException: the SPOTIFY APP refused the app-to-app
    // connection. connect() self-heals (clears + re-consents) BEFORE this is
    // shown, so reaching here means even a FRESH web consent was refused - the
    // web/PKCE step is fine, the refusal is device-side. The two realistic
    // causes (verified against spotify/android-sdk#384): the Spotify app is
    // logged into a DIFFERENT account than the web consent, or this build's
    // signing fingerprint (package + SHA-1) is not registered in the Spotify
    // Developer Dashboard (debug and release builds have different prints; the
    // SDK then reports "not authorized" even though the user consented).
    return new Error(
      'Die Spotify-App auf diesem Gerät hat die Verbindung abgelehnt. Häufigste Ursachen: ' +
        '(1) Die Spotify-App ist mit einem ANDEREN Account eingeloggt als dem, mit dem du dich ' +
        'gerade im Browser angemeldet hast — bitte in beiden denselben Account verwenden. ' +
        '(2) Dieser App-Build ist nicht im Spotify Developer Dashboard registriert ' +
        '(Android-Package + SHA-1-Fingerprint; Debug- und Release-Build haben unterschiedliche ' +
        'Fingerprints und müssen beide eingetragen sein).'
    );
  }
  if (raw.includes('notloggedin') || raw.includes('not logged in')) {
    return new Error('Not logged in to the Spotify app. Log in there, then retry.');
  }
  if (isWakeupError(e)) {
    // Reached only when even the playURI wakeup retry failed (e.g. a brand-new
    // Spotify account with no "last track" to resume). Give a working manual
    // recovery instead of a dead-end - an app restart is NOT needed.
    return new Error(
      'Die Spotify-App konnte nicht im Hintergrund geweckt werden. Bitte öffne die ' +
        'Spotify-App kurz, spiele dort einen beliebigen Song 1–2 Sekunden an, wechsle ' +
        'zurück und tippe erneut auf „Mit Spotify verbinden".'
    );
  }
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * App Remote connection (step 2 of connect), app-to-app via the installed Spotify
 * app. Android exposes a patched connectWithoutAuth(); iOS uses the library's
 * native authorize() + connect(accessToken). Each native call is time-boxed.
 */
async function connectAppRemote(): Promise<void> {
  if (Platform.OS === 'ios') {
    // One native authorize() round trip. With `playURI` set, the SDK uses its
    // authorizeAndPlayURI wakeup path: Spotify is foregrounded AND starts
    // playback ('' = resume last track), so it stays alive as an audio app in
    // the background - the documented precondition for SPTAppRemote connect.
    const authorizeIos = async (playURI?: string): Promise<string> => {
      const session = await withTimeout(
        getAuth().authorize({
          clientID: CLIENT_ID,
          redirectURL: REDIRECT_URL,
          scopes: WEB_API_SCOPES as any,
          ...(playURI != null ? { playURI } : {}),
        } as any),
        APP_REMOTE_TIMEOUT_MS,
        'Spotify-Autorisierung'
      );
      if (!session?.accessToken) {
        throw new Error(
          'Spotify authorization did not return an access token. Check the iOS redirect callback.'
        );
      }
      // Keep the App-Remote token for a later silent reconnect (no app switch).
      iosAppRemoteToken = session.accessToken;
      return session.accessToken;
    };

    const token = await authorizeIos();
    try {
      await withTimeout(
        getRemote().connect(token),
        APP_REMOTE_TIMEOUT_MS,
        'Spotify-Verbindung'
      );
    } catch (e) {
      if (!isWakeupError(e)) throw e;
      // Known SpotifyiOS first-connect failure (BackgroundWakeupFailed /
      // stream error / connection refused): the Spotify app was suspended by
      // iOS right after the auth redirect, and every further connect() fails
      // deterministically because the native session manager now returns its
      // CACHED session without ever waking Spotify again (verified in
      // RNSpotifyRemoteAuth.m: the `_initialized && session` fast path skips
      // initiateSession). Recovery: drop that native session (endSession
      // resets _sessionManager) and re-authorize WITH playURI - the app
      // switch + playback wake Spotify for real, then connect sticks. The
      // consent was already granted, so the switch is a quick bounce.
      console.warn(
        `[spotify] iOS connect failed with a wakeup-class error -> retrying via authorize(playURI:'') wakeup: ${
          (e as any)?.message ?? e
        }`
      );
      try {
        await getAuth().endSession();
      } catch {
        // best-effort - a failed endSession still leaves the retry below valid
      }
      const wokenToken = await authorizeIos('');
      await withTimeout(
        getRemote().connect(wokenToken),
        APP_REMOTE_TIMEOUT_MS,
        'Spotify-Verbindung'
      );
      // The wakeup resumed the user's last track - stop that stray playback
      // again immediately (connecting must not blast music unprompted).
      pause().catch(() => {});
    }
    setConnected(true);
    ensureConnectionListeners();
    return;
  }

  // connectWithoutAuth is a native @ReactMethod not surfaced in the lib's TS
  // types, so we access it via the (guarded) Android remote singleton with a cast.
  const remote = getRemote() as unknown as {
    connectWithoutAuth: (token: string, clientId: string, redirectUri: string) => Promise<void>;
  };
  await withTimeout(
    remote.connectWithoutAuth('', CLIENT_ID, REDIRECT_URL),
    APP_REMOTE_TIMEOUT_MS,
    'Spotify-Verbindung'
  );
  setConnected(true);
  ensureConnectionListeners();
}

/** One connect attempt: Web API authorization + App Remote connection. */
async function connectInternal(): Promise<void> {
  // Web API authorization (Authorization Code + PKCE). Single browser step; also
  // pre-authorizes the playback scopes the App Remote needs below.
  await ensureWebApiAuthorized();
  await connectAppRemote();
}

/**
 * Connect to Spotify: PKCE Web API authorization + App Remote connection.
 *
 * Android avoids auth.authorize(): Spotify is phasing out the implicit/TOKEN
 * grant, and the Android App Remote path does not use that token. iOS still needs
 * the library's authorize() result because its native bridge only exposes
 * connect(accessToken), not connectWithoutAuth(). The PKCE token also powers the
 * Web API (playlists). Throws on missing config / cancel / Spotify app unreachable.
 *
 * SELF-HEAL (the Android dead-end): after an app restart the in-memory `connected`
 * flag is false while the persisted refresh token still exists, so the Settings
 * button shows "verbinden". Pressing it silently refreshes the OLD token (no new
 * consent), so the App Remote refuses with "not authorized" - and the previous
 * error told the user to "Verbindung trennen", which isn't even offered in that
 * state. So on exactly that error we clear ALL auth (endSession + drop the stored
 * token) and retry ONCE, forcing a fresh interactive consent that re-grants the
 * playback scopes. No manual disconnect / data-clear needed.
 */
export async function connect(): Promise<void> {
  if (!CLIENT_ID || !REDIRECT_URL) {
    throw new Error(
      'Missing Spotify config. Set EXPO_PUBLIC_SPOTIFY_CLIENT_ID and ' +
        'EXPO_PUBLIC_SPOTIFY_REDIRECT_URI in .env, then rebuild the dev client.'
    );
  }
  try {
    await connectInternal();
  } catch (e: any) {
    if (isStaleAuthError(e)) {
      await clearAuthState();
      try {
        await connectInternal();
        return;
      } catch (retryErr: any) {
        throw mapConnectError(retryErr);
      }
    }
    throw mapConnectError(e);
  }
}

/**
 * Clear ALL Spotify auth state: the SDK session (cookies) AND the PKCE Web-API
 * token (memory + encrypted storage), and reset the in-memory connected flag.
 * Used by both disconnect() and connect()'s self-heal retry, so a reconnect
 * always re-authorizes cleanly. Never throws (endSession failure is ignored).
 */
async function clearAuthState(): Promise<void> {
  try {
    await getAuth().endSession();
  } catch {
    // ignore - we still clear the local/persisted state below
  }
  iosAppRemoteToken = null;
  webApiToken = null;
  webApiRefreshToken = null;
  webApiTokenExpiresAt = 0;
  setConnected(false); // after clearing tokens, so readiness reflects the reset
  try {
    await SecureStore.deleteItemAsync(TOKEN_STORE_KEY);
  } catch {
    // ignore
  }
}

/**
 * End the Spotify session and reset local connection state. Required after
 * changing requested scopes: it forces the next connect() to do a fresh
 * authorize() so a new token with the new scopes is issued.
 */
export async function disconnect(): Promise<void> {
  await clearAuthState();
}

// ---------------------------------------------------------------------------
// Web API authorization (Authorization Code + PKCE)
//
// The App Remote login returns a playback-only token with NO Web API playlist
// scopes (grantedScope was undefined -> 403 on /v1/playlists). So playlist reads
// use a separate PKCE token obtained via expo-auth-session. PKCE needs no client
// secret, so there is still no backend. The App Remote / playback path is
// unchanged - this only powers getPlaylistTracks.
// ---------------------------------------------------------------------------

const SPOTIFY_DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.spotify.com/authorize',
  tokenEndpoint: 'https://accounts.spotify.com/api/token',
};

/** Must be registered EXACTLY in the Spotify Dashboard under Redirect URIs. */
const WEB_API_REDIRECT_URI = 'nickelbrandt://spotify-web-callback';

// Web API playlist reads + the playback scopes. Requesting app-remote-control /
// streaming here means the PKCE consent ALSO pre-authorizes the user for the App
// Remote connection (connectWithoutAuth requires prior authorization, since it
// can't show a consent dialog itself).
const WEB_API_SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'app-remote-control',
  'streaming',
];

let webApiToken: string | null = null;
let webApiRefreshToken: string | null = null;
let webApiTokenExpiresAt = 0; // epoch ms

// Encrypted persistence so the user stays logged in across app restarts. The
// refresh token is the important part - with it, ensure/getWebApiToken refresh
// silently (no browser). Cleared on disconnect().
const TOKEN_STORE_KEY = 'nb.spotify.webtoken';

async function persistToken(): Promise<void> {
  try {
    if (!webApiToken && !webApiRefreshToken) return;
    await SecureStore.setItemAsync(
      TOKEN_STORE_KEY,
      JSON.stringify({
        accessToken: webApiToken,
        refreshToken: webApiRefreshToken,
        expiresAt: webApiTokenExpiresAt,
      })
    );
  } catch {
    // SecureStore unavailable (e.g. before a rebuild) -> stay in-memory only.
  }
}

// One-time load of persisted tokens at startup (memoized).
let loadPromise: Promise<void> | null = null;
function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await SecureStore.getItemAsync(TOKEN_STORE_KEY);
        if (raw) {
          const t = JSON.parse(raw);
          // Don't clobber a token already obtained this session.
          if (!webApiToken && !webApiRefreshToken) {
            webApiToken = t.accessToken ?? null;
            webApiRefreshToken = t.refreshToken ?? null;
            webApiTokenExpiresAt = t.expiresAt ?? 0;
          }
        }
      } catch {
        // ignore - treat as no stored token
      }
    })();
  }
  return loadPromise;
}

/** Warm the persisted token load at app start (optional; ensure* also call it). */
export function initSpotifyAuth(): Promise<void> {
  return ensureLoaded();
}

function applyWebToken(token: AuthSession.TokenResponse): void {
  webApiToken = token.accessToken;
  if (token.refreshToken) webApiRefreshToken = token.refreshToken;
  // expiresIn is in seconds; refresh 60s early to avoid edge-of-expiry 401s.
  const ttl = (token.expiresIn ?? 3600) - 60;
  webApiTokenExpiresAt = Date.now() + Math.max(ttl, 0) * 1000;
  void persistToken(); // fire-and-forget encrypted save
}

export function isWebApiAuthorized(): boolean {
  return !!webApiToken && Date.now() < webApiTokenExpiresAt;
}

/**
 * True when the user has fully connected (App Remote + a Web API token that is
 * valid or refreshable). Game start requires this - it never logs in itself.
 */
export function isReadyToPlay(): boolean {
  return connected && (!!webApiToken || !!webApiRefreshToken);
}

/** Interactive PKCE login (opens a browser once) for Web API scopes. */
async function authorizeWebApi(): Promise<void> {
  const request = new AuthSession.AuthRequest({
    clientId: CLIENT_ID,
    scopes: WEB_API_SCOPES,
    redirectUri: WEB_API_REDIRECT_URI,
    usePKCE: true,
    responseType: AuthSession.ResponseType.Code,
  });
  // Builds the auth URL and generates the PKCE code_verifier/code_challenge.
  await request.makeAuthUrlAsync(SPOTIFY_DISCOVERY);
  // promptAsync uses an IN-APP auth session (Chrome Custom Tab on Android,
  // ASWebAuthenticationSession on iOS) - not a separate external browser app.
  // We pass an explicit custom-scheme redirect (WEB_API_REDIRECT_URI), so the
  // deprecated Expo auth proxy is NOT involved (effectively useProxy: false).
  // preferEphemeralSession keeps the iOS sheet private/in-app; on Android the
  // Custom Tab is already an in-app overlay. If the Spotify app is installed and
  // handles the accounts.spotify.com link, it takes over the login app-to-app.
  //
  // showInRecents (Android only, ignored on iOS): WITHOUT it the Custom Tab is
  // launched with FLAG_ACTIVITY_NO_HISTORY + EXCLUDE_FROM_RECENTS (verified in
  // expo-web-browser's WebBrowserModule.kt), so Android FINISHES the auth tab
  // the moment the user switches away - e.g. to the mail app for Spotify's
  // one-time login code. Returning then found the code window gone and
  // promptAsync resolved '(dismiss)', forcing a NEW code: a hard first-login
  // blocker. With true, the tab survives app switches and shows up in the
  // recents view so the user can switch straight back to it. iOS's
  // ASWebAuthenticationSession survives backgrounding natively either way.
  const result = await request.promptAsync(SPOTIFY_DISCOVERY, {
    preferEphemeralSession: true,
    showInRecents: true,
  });
  if (result.type !== 'success' || !result.params.code) {
    const reason =
      result.type === 'error'
        ? result.error?.message ?? 'error'
        : result.type;
    throw new Error(`Web-API-Autorisierung fehlgeschlagen (${reason}).`);
  }
  const token = await AuthSession.exchangeCodeAsync(
    {
      clientId: CLIENT_ID,
      code: result.params.code,
      redirectUri: WEB_API_REDIRECT_URI,
      extraParams: { code_verifier: request.codeVerifier ?? '' },
    },
    SPOTIFY_DISCOVERY
  );
  applyWebToken(token);
}

/** Silently refresh the Web API token via the stored refresh token. */
async function refreshWebApi(): Promise<void> {
  if (!webApiRefreshToken) throw new Error('No refresh token');
  const token = await AuthSession.refreshAsync(
    { clientId: CLIENT_ID, refreshToken: webApiRefreshToken },
    SPOTIFY_DISCOVERY
  );
  applyWebToken(token);
}

/**
 * Ensure a valid Web API token, doing the interactive PKCE login if needed.
 * Called from connect() (Spotify tab) so the browser popup happens only there.
 */
export async function ensureWebApiAuthorized(): Promise<void> {
  await ensureLoaded();
  if (isWebApiAuthorized()) return;
  if (webApiRefreshToken) {
    try {
      await refreshWebApi();
      if (isWebApiAuthorized()) return;
    } catch {
      // refresh failed -> fall through to interactive login
    }
  }
  await authorizeWebApi();
}

/**
 * Web API token WITHOUT an interactive login: returns the cached token, silently
 * refreshes it, or throws if neither is possible. Used at game start so loading
 * a playlist never triggers a browser popup.
 */
async function getWebApiToken(): Promise<string> {
  await ensureLoaded();
  if (isWebApiAuthorized()) return webApiToken!;
  if (webApiRefreshToken) {
    try {
      await refreshWebApi();
    } catch {
      // fall through to the error below
    }
    if (isWebApiAuthorized()) return webApiToken!;
  }
  throw new Error(
    'Spotify Web API nicht autorisiert. Bitte zuerst in den Einstellungen ' +
      '"Mit Spotify verbinden".'
  );
}

/**
 * The connected user's Spotify display name (falls back to the user id).
 * Returns null if no name is available. Uses the non-interactive Web API token.
 */
export async function getDisplayName(): Promise<string | null> {
  const token = await getWebApiToken();
  const res = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Spotify Web API ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data?.display_name ?? data?.id ?? null;
}

/** Play a Spotify URI, e.g. "spotify:track:<id>". Time-boxed: a dead App-Remote
 *  session can otherwise leave this promise pending forever (this was the one
 *  native call missing the withTimeout wrap). */
export function playUri(uri: string): Promise<void> {
  return withTimeout(getRemote().playUri(uri), APP_REMOTE_TIMEOUT_MS, 'Spotify-Wiedergabe');
}

export function pause(): Promise<void> {
  return getRemote().pause();
}

// Quick ground-truth probe; deliberately short - a dead session should fall
// through to the reconnect path fast, not after the full 20s app-remote box.
const STATUS_CHECK_TIMEOUT_MS = 3000;

/** Errors that mean the App-Remote session is gone (worth ONE reconnect). */
function isConnectionLostError(e: any): boolean {
  const raw = `${e?.code ?? ''} ${e?.message ?? e}`.toLowerCase();
  return (
    raw.includes('disconnect') ||
    raw.includes('not connected') ||
    raw.includes('connection') ||
    raw.includes('zeitüberschreitung')
  );
}

/** Resulting playback state after a togglePlayback() call, for the button icon. */
export type PlaybackState = 'playing' | 'paused';

/**
 * Play/pause decision when the App Remote is (believed to be) connected. Reads
 * the real player state so the manual button behaves like a Play/Pause toggle
 * instead of always restarting:
 *   - our current card is loaded & paused  -> resume (keeps the position)
 *   - our current card is loaded & playing -> pause
 *   - a DIFFERENT track (or none) is loaded -> first play of this card: playUri
 *     from the start.
 * A hung getPlayerState() surfaces as a timeout, which isConnectionLostError()
 * treats as a lost session, so the caller falls through to reconnect + playUri.
 */
async function toggleWhileConnected(uri: string): Promise<PlaybackState> {
  const state = await withTimeout(
    getRemote().getPlayerState(),
    STATUS_CHECK_TIMEOUT_MS,
    'Spotify-Status'
  );
  const sameTrack = !!state?.track?.uri && state.track.uri === uri;
  if (sameTrack) {
    if (state.isPaused) {
      await withTimeout(getRemote().resume(), APP_REMOTE_TIMEOUT_MS, 'Spotify-Wiedergabe');
      return 'playing';
    }
    await withTimeout(getRemote().pause(), APP_REMOTE_TIMEOUT_MS, 'Spotify-Wiedergabe');
    return 'paused';
  }
  // A different card (or nothing) is loaded -> this is the first play of this
  // card, so start it from the beginning rather than resuming whatever's loaded.
  await playUri(uri);
  return 'playing';
}

/**
 * Backup Play/Pause toggle for the CURRENT song, reconnecting first if the App
 * Remote session is gone. Used by the manual ▶/⏸ button (the auto-play effects
 * stay optimistic). Returns the resulting state so the button can show the right
 * icon. Behaviour (vs the old "always restart"):
 *   - nothing playing yet / paused -> resume at the last position (or start from
 *     0 if this card was never played this round)
 *   - already playing -> pause
 *
 * `getCurrentUri` is called at ACTION time, not captured at press time: a
 * reconnect can take seconds and the game may move on meanwhile - if the current
 * card changed during the reconnect, we abort silently instead of replaying a
 * stale song (the auto-play effect owns the new card).
 *
 * Flow: probe remote.isConnectedAsync() (ground truth - the in-memory
 * `connected` flag is optimistic and never learns about a real drop; we sync it
 * here) -> connected: toggle via player state, falling through to ONE reconnect
 * on a connection-lost error -> not connected: reuse connect() (full platform
 * flow incl. stale-auth self-heal) -> re-resolve the uri -> play. Errors are
 * THROWN, never swallowed - the button surfaces them.
 */
export async function togglePlayback(
  getCurrentUri: () => string | null
): Promise<PlaybackState> {
  const uriBefore = getCurrentUri();
  if (!uriBefore) throw new Error('Kein aktiver Song zum Abspielen.');

  let isConnected = false;
  try {
    isConnected = await withTimeout(
      getRemote().isConnectedAsync(),
      STATUS_CHECK_TIMEOUT_MS,
      'Spotify-Status'
    );
  } catch {
    isConnected = false; // SDK not ready / probe hung -> treat as disconnected
  }
  setConnected(isConnected);

  if (isConnected) {
    try {
      return await toggleWhileConnected(uriBefore);
    } catch (e) {
      if (!isConnectionLostError(e)) throw e;
      // Session died between probe and action -> one reconnect attempt below.
    }
  }

  await connect(); // sets `connected` again on success

  const uriAfter = getCurrentUri();
  if (!uriAfter || uriAfter !== uriBefore) {
    return 'paused'; // game moved on during the reconnect - never replay a stale card
  }
  await playUri(uriAfter);
  return 'playing';
}

/**
 * Best-effort snapshot of the current playback state for the manual button's
 * icon: 'playing'/'paused' ONLY when the App Remote is connected AND the given
 * card is the loaded track, else null. Never reconnects, never throws, and is
 * timeout-boxed so a hung SDK call can't block the UI - the button falls back to
 * the default ▶ on null. Covers the "button rendered mid-song" case that emits
 * no state-change event; live transitions come from subscribePlaybackState.
 */
export async function probePlaybackState(uri: string): Promise<PlaybackState | null> {
  try {
    const connectedNow = await withTimeout(
      getRemote().isConnectedAsync(),
      STATUS_CHECK_TIMEOUT_MS,
      'Spotify-Status'
    );
    setConnected(connectedNow); // fresh ground truth -> keep the UI status honest
    if (!connectedNow) return null;
    const state = await withTimeout(
      getRemote().getPlayerState(),
      STATUS_CHECK_TIMEOUT_MS,
      'Spotify-Status'
    );
    if (!state?.track?.uri || state.track.uri !== uri) return null;
    return state.isPaused ? 'paused' : 'playing';
  } catch {
    return null; // SDK not ready / probe hung / no state -> keep the default icon
  }
}

/**
 * Silent App Remote reconnect (Baustein b): reattach to the ALREADY-RUNNING
 * Spotify app WITHOUT the interactive authorize() app switch.
 *
 * Verified against the SDK/native bridge: remote.connect(token) maps to
 * SPTAppRemote's `connect` (RNSpotifyRemoteAppRemote.m), which attaches to the
 * running Spotify app and never foregrounds it - only auth.authorize() /
 * authorizeAndPlayURI do. Android's connectWithoutAuth likewise binds to the
 * Spotify service without a switch. So this is safe to run automatically.
 *
 * Uses a token we already hold (iOS: the token from the last authorize(); it can
 * expire after ~1h). Returns true on success. On failure (token stale, Spotify
 * not running) it returns false WITHOUT escalating to an interactive authorize()
 * - the caller surfaces the status and the user reconnects explicitly.
 */
async function reconnectSilently(): Promise<boolean> {
  try {
    if (Platform.OS === 'ios') {
      if (!iosAppRemoteToken) return false; // never authorized -> can't heal silently
      await withTimeout(
        getRemote().connect(iosAppRemoteToken),
        APP_REMOTE_TIMEOUT_MS,
        'Spotify-Verbindung'
      );
    } else {
      const remote = getRemote() as unknown as {
        connectWithoutAuth: (token: string, clientId: string, redirectUri: string) => Promise<void>;
      };
      await withTimeout(
        remote.connectWithoutAuth('', CLIENT_ID, REDIRECT_URL),
        APP_REMOTE_TIMEOUT_MS,
        'Spotify-Verbindung'
      );
    }
    setConnected(true);
    ensureConnectionListeners();
    return true;
  } catch {
    setConnected(false);
    return false;
  }
}

/**
 * On returning to the foreground (Baustein b): if the App Remote dropped while
 * backgrounded (expected on iOS - the OS tears it down when we're suspended),
 * silently reconnect. Only acts when we've connected before (a token exists) and
 * never triggers an interactive app switch, so it is safe to call on every
 * foreground. No-op if still connected. Status is pushed to subscribers either
 * way, so the connect button reflects a drop even if the silent heal fails.
 */
export async function reconnectIfDropped(): Promise<void> {
  if (!iosAppRemoteToken && !webApiToken && !webApiRefreshToken) return; // never connected
  let isConnected = false;
  try {
    isConnected = await withTimeout(
      getRemote().isConnectedAsync(),
      STATUS_CHECK_TIMEOUT_MS,
      'Spotify-Status'
    );
  } catch {
    isConnected = false;
  }
  if (isConnected) {
    setConnected(true);
    return;
  }
  await reconnectSilently();
}

/**
 * Game-start gate with self-healing: probe the real App Remote state and
 * silently reconnect a dropped session BEFORE deciding readiness. The App
 * Remote routinely drops between two Partien (Android unbinds the idle
 * Spotify service after the end-of-game pause; iOS tears the session down
 * whenever the app is suspended) - a plain isReadyToPlay() check then refuses
 * and forces a pointless manual reconnect, even though the silent reconnect
 * would succeed. Never triggers an interactive app switch; false means a real
 * (re-)connect in the settings is genuinely required.
 */
export async function ensureReadyToPlay(): Promise<boolean> {
  await reconnectIfDropped(); // no-op if never connected; never throws
  return isReadyToPlay();
}

/**
 * Guarded auto-play entry point for the game screens (Baustein c): play `uri`,
 * but make sure the App Remote is actually connected first, self-healing a silent
 * drop (e.g. iOS background). Mirrors togglePlayback's probe+reconnect, minus the
 * toggle, and reuses the SILENT reconnect (no app switch). THROWS on failure so
 * the auto-play call sites can surface it - they no longer swallow the error, so
 * "no music" never goes unnoticed.
 */
export async function playUriGuarded(uri: string): Promise<void> {
  let isConnected = false;
  try {
    isConnected = await withTimeout(
      getRemote().isConnectedAsync(),
      STATUS_CHECK_TIMEOUT_MS,
      'Spotify-Status'
    );
  } catch {
    isConnected = false;
  }
  setConnected(isConnected);

  if (!isConnected) {
    const ok = await reconnectSilently();
    if (!ok) {
      throw new Error(
        'Spotify-Verbindung verloren. Tippe auf ▶ oder verbinde dich in den Einstellungen neu.'
      );
    }
  }

  try {
    await playUri(uri);
  } catch (e) {
    if (!isConnectionLostError(e)) throw e;
    // Dropped between the probe and the play -> one silent reconnect, then retry.
    const ok = await reconnectSilently();
    if (!ok) throw e;
    await playUri(uri);
  }
}

/**
 * Subscribe to live player-state changes so the manual button's icon reflects
 * reality WITHOUT a tap - notably when auto-play starts a new card. `cb` fires
 * with 'playing'/'paused' whenever the CURRENT track (per getUri, read at event
 * time so it always compares against the card on screen) changes state; events
 * for any other track are ignored. Best-effort: returns a no-op unsubscribe if
 * the SDK isn't ready. Never throws. Using the SDK's own playerStateChanged
 * event (not a poll) avoids racing the auto-play playUri: the event fires when
 * playback actually starts.
 */
export function subscribePlaybackState(
  getUri: () => string | null,
  cb: (state: PlaybackState) => void
): () => void {
  let remote: ReturnType<typeof getRemote>;
  try {
    remote = getRemote();
  } catch {
    return () => {}; // SDK not ready -> tap-driven icon only
  }
  const listener = (state: PlayerState) => {
    const uri = getUri();
    if (!uri || state?.track?.uri !== uri) return;
    cb(state.isPaused ? 'paused' : 'playing');
  };
  try {
    remote.on('playerStateChanged', listener);
  } catch {
    return () => {};
  }
  return () => {
    try {
      remote.off('playerStateChanged', listener);
    } catch {
      // ignore - unsubscribing a dead emitter is harmless
    }
  };
}

/**
 * Machine-readable marker on Web-API 403 errors ("Zugriff verweigert" - e.g.
 * Spotify's Dev-Mode "user is not registered" / editorial-playlist refusal).
 * Lets UI surfaces show a friendly message for exactly this case without
 * matching on the message text (other errors keep their specific texts).
 */
export const WEB_API_403_CODE = 'spotify_web_api_403';

/** True when `e` is the 403 "access denied" class of Web-API failure. */
export function isWebApi403(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === WEB_API_403_CODE;
}

/** Build a readable error from an already-read Web API response body. */
function buildWebApiError(status: number, context: string, body: string): Error {
  if (status === 403) {
    const err = new Error(
      `Spotify Web API 403 (${context}): Zugriff verweigert. Häufigste Ursachen: ` +
        '(1) eine von Spotify erstellte/redaktionelle Playlist (Discover Weekly, ' +
        '"This Is…", Top-Charts) - über die Web API gesperrt; nutze eine selbst ' +
        'erstellte Playlist. (2) Der Token hat die Playlist-Scopes nicht - in den ' +
        'Einstellungen "Verbindung trennen" und neu verbinden. ' +
        `Server-Antwort: ${body}`
    ) as Error & { code?: string };
    err.code = WEB_API_403_CODE;
    return err;
  }
  if (status === 401) {
    return new Error(
      `Spotify Web API 401 (${context}): Token abgelaufen/ungültig. In den Einstellungen ` +
        `"Verbindung trennen" und neu verbinden. Server-Antwort: ${body}`
    );
  }
  return new Error(`Spotify Web API ${status} (${context}): ${body}`);
}

/** Read the body and build a readable error for a failed Web API response. */
async function webApiError(res: Response, context: string): Promise<Error> {
  const body = await res.text().catch(() => '');
  return buildWebApiError(res.status, context, body);
}

// ---------------------------------------------------------------------------
// Game helpers
// ---------------------------------------------------------------------------

/** Mark a track as played so it is not offered again (cross-game dedup). */
export function markTrackPlayed(trackId: string): void {
  playedTrackIds.add(trackId);
}

/**
 * Accepts a raw playlist id, a `spotify:playlist:<id>` uri, or an
 * `https://open.spotify.com/playlist/<id>?si=...` url and returns the bare id.
 */
export function parsePlaylistId(input: string): string {
  const s = input.trim();
  const match = s.match(/playlist[:/]([a-zA-Z0-9]+)/);
  return match ? match[1] : s;
}

/**
 * Load all playable tracks of a playlist as GameCards (paginated, max 500).
 * Skips local tracks, episodes, and tracks without a parseable release year.
 *
 * @param excludePlayed when true, omits tracks already marked as played.
 */
export async function getPlaylistTracks(
  playlistIdOrUrl: string,
  { excludePlayed = false }: { excludePlayed?: boolean } = {}
): Promise<GameCard[]> {
  // Playlist reads need the PKCE Web-API token (the remote token lacks scopes).
  const token = await getWebApiToken();
  const playlistId = parsePlaylistId(playlistIdOrUrl);
  const PAGE = 100;
  const MAX = 500;

  const seen = new Set<string>();
  const cards: GameCard[] = [];

  for (let offset = 0; offset < MAX; offset += PAGE) {
    // Spotify Feb 2026 migration: GET /playlists/{id}/tracks was disabled for
    // Development Mode apps (2026-03-09). The replacement is /playlists/{id}/items,
    // where each entry exposes the track under `.item` (was `.track`). The paging
    // object still has `.items` (the array) and `.next` (pagination).
    const url =
      `https://api.spotify.com/v1/playlists/${playlistId}/items` +
      `?limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw buildWebApiError(res.status, 'playlist', body);
    }
    const data = await res.json();
    const items: any[] = data?.items ?? [];

    for (const item of items) {
      // New /items endpoint nests the track under `.item` (was `.track`).
      const t = item?.item;
      if (!t || t.is_local || t.type !== 'track' || !t.uri) continue;
      if (seen.has(t.uri)) continue;
      if (excludePlayed && playedTrackIds.has(t.uri)) continue;

      const year = parseInt(String(t.album?.release_date ?? '').slice(0, 4), 10);
      if (!Number.isFinite(year) || year <= 0) continue;

      seen.add(t.uri);
      cards.push({
        id: t.uri,
        trackUri: t.uri,
        title: t.name ?? 'Unknown',
        artist: t.artists?.[0]?.name ?? 'Unknown',
        year,
        coverUrl: t.album?.images?.[0]?.url,
        // For the MusicBrainz year check (external_ids comes with the full track).
        isrc: t.external_ids?.isrc,
      });
    }

    if (items.length < PAGE || !data?.next) break;
  }

  return cards;
}

// ---------------------------------------------------------------------------
// Cover art for pool songs (the pool stores no cover art).
//
// Spotify Feb-2026 migration: the batch GET /v1/tracks?ids=... was REMOVED for
// Development-Mode apps, so covers cost one GET /v1/tracks/{id} per track. For a
// 300-card pool that is far too slow to block the "Spiel starten" button on, so
// cover loading is split in two:
//   - addCoverArtUrgent: the few cards needed IMMEDIATELY (start cards + first
//     playing card), awaited before game start. Small, bounded, breaker-guarded.
//   - startCoverArtPrefetch: everything else, fire-and-forget AFTER the game is
//     already running. Results land in a module-level cache; consumers pull them
//     via withCachedCover() at draw time (Online host) or get them dispatched
//     into the reducer (Pass & Play ADD_COVERS).
//
// Robustness:
//   - CIRCUIT BREAKER: a 429 with an unusually large Retry-After means an
//     API-wide hard rate limit (observed: ~2300-2480s). Retrying per card is
//     pointless then - after HARD_LIMIT_STRIKES such responses the whole batch
//     is abandoned for this run; cards keep their UI fallback.
//   - ABORT: all requests run on one shared AbortController per job. Starting a
//     new job replaces (aborts) the previous one, and abortCoverArtFetch() is
//     wired to the lobby lifecycle (leave/end), so no requests outlive the lobby.
//
// Non-fatal by design: no token (non-host device) / failures / breaker / abort
// all leave coverUrl undefined and the UI shows its fallback.
// ---------------------------------------------------------------------------

const COVER_PREFIX = 'spotify:track:';
const coverIdOf = (uri: string) => uri.slice(COVER_PREFIX.length);
const needsCover = (c: GameCard) => !c.coverUrl && !!c.trackUri?.startsWith(COVER_PREFIX);

/** Resolved covers by track id; survives across games (covers are immutable). */
const coverCache = new Map<string, string>();

/** A Retry-After this large (seconds) = API-wide hard limit, not a burst 429. */
const COVER_HARD_RETRY_AFTER_S = 30;
/** Hard-limit 429s before the whole batch run is abandoned. */
const COVER_HARD_LIMIT_STRIKES = 2;
const COVER_CONCURRENCY = 6;
/** Prefetch flush size: consumers get covers in batches of this many. */
const COVER_CHUNK = 24;

/** The currently running cover job's controller (single-flight). */
let coverJobAbort: AbortController | null = null;

/** Abort the running cover fetch (wired to lobby leave/end + job replacement). */
export function abortCoverArtFetch(): void {
  if (coverJobAbort && !coverJobAbort.signal.aborted) {
    console.warn('[coverArt] aborting cover fetch (lobby left / job replaced)');
    coverJobAbort.abort();
  }
  coverJobAbort = null;
}

/** Start a new single-flight cover job, aborting any previous one. */
function newCoverJob(): AbortController {
  abortCoverArtFetch();
  const ctrl = new AbortController();
  coverJobAbort = ctrl;
  return ctrl;
}

/** Cached cover for a card's track URI, if a previous fetch resolved it. */
export function cachedCoverUrl(trackUri: string): string | undefined {
  return trackUri?.startsWith(COVER_PREFIX)
    ? coverCache.get(coverIdOf(trackUri))
    : undefined;
}

/** Stamp a card with its cached cover (no-op when it has one / none cached). */
export function withCachedCover(card: GameCard): GameCard {
  if (!needsCover(card)) return card;
  const url = cachedCoverUrl(card.trackUri);
  return url ? { ...card, coverUrl: url } : card;
}

/** Shared per-batch state: error counters + the hard-limit circuit breaker. */
interface CoverBatchState {
  signal: AbortSignal;
  token: string;
  hardStrikes: number;
  broken: boolean;
  e403: number;
  e404: number;
  e429: number;
  eOther: number;
}

/**
 * Fetch covers for a set of track ids into the cache (bounded concurrency,
 * breaker- and abort-aware). Returns the covers resolved by THIS call.
 */
async function fetchCoverBatch(
  ids: string[],
  state: CoverBatchState
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const fetchOne = async (id: string): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (state.broken || state.signal.aborted) return;
      let res: Response;
      try {
        res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, {
          headers: { Authorization: `Bearer ${state.token}` },
          signal: state.signal,
        });
      } catch {
        if (!state.signal.aborted) state.eOther += 1; // network error
        return;
      }
      if (res.ok) {
        const t = await res.json().catch(() => null);
        const url = t?.album?.images?.[0]?.url;
        if (url && t?.id) {
          coverCache.set(t.id, url);
          found.set(t.id, url);
        } else {
          state.eOther += 1; // 200 but no cover image
        }
        return;
      }
      if (res.status === 429) {
        state.e429 += 1;
        const raw = res.headers.get('retry-after');
        const parsed = parseInt(raw ?? '', 10);
        // Hard limit: waiting minutes for ONE cover is pointless - strike, and
        // after enough strikes trip the breaker for the whole batch run.
        if (Number.isFinite(parsed) && parsed > COVER_HARD_RETRY_AFTER_S) {
          state.hardStrikes += 1;
          if (state.hardStrikes >= COVER_HARD_LIMIT_STRIKES && !state.broken) {
            state.broken = true;
            console.warn(
              `[coverArt] hard rate limit (Retry-After=${raw}s, strike ${state.hardStrikes}) ` +
                '-> circuit breaker: abandoning the remaining batch, cards keep their fallback'
            );
          }
          return;
        }
        // Burst 429: respect Retry-After with ONE short, capped backoff + retry.
        if (attempt === 0) {
          const waitS = Number.isFinite(parsed) ? Math.min(parsed, 5) : 1;
          console.warn(`[coverArt] 429 on ${id}; Retry-After=${raw ?? 'none'} -> wait ${waitS}s, one retry`);
          await sleep(waitS * 1000);
          continue;
        }
        return;
      }
      if (res.status === 403) state.e403 += 1;
      else if (res.status === 404) state.e404 += 1;
      else state.eOther += 1;
      return;
    }
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < ids.length && !state.broken && !state.signal.aborted) {
      const id = ids[cursor++];
      await fetchOne(id);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(COVER_CONCURRENCY, ids.length) }, worker)
  );
  return found;
}

/** Ids (deck order, deduped) of the first `limit` cards still missing a cover. */
function coverIdsFor(cards: GameCard[], limit: number): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const c of cards) {
    if (ids.length >= limit) break;
    if (!needsCover(c) || cachedCoverUrl(c.trackUri)) continue;
    const id = coverIdOf(c.trackUri);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Fetch covers for the FIRST `count` cover-less cards (deck order) - the ones
 * needed the moment the game starts (start cards + first playing card). Small
 * and bounded; still breaker-guarded so a hard rate limit can't stall the
 * start. Returns the cards with every cover known so far (fresh + cached)
 * stamped on. Never throws.
 */
export async function addCoverArtUrgent(
  cards: GameCard[],
  count: number
): Promise<GameCard[]> {
  const stampAll = () => cards.map(withCachedCover);
  const ids = coverIdsFor(cards, count);
  if (ids.length === 0) return stampAll();

  // Diagnostics use console.warn (not console.log): the project has no
  // transform-remove-console babel config, so console.* survives dev AND
  // release, but .warn is the more visible channel in Metro and device logs.
  let token: string;
  try {
    token = await getWebApiToken();
  } catch (e: any) {
    console.warn(
      `[coverArt] no Web API token -> skipping cover fetch for ${ids.length} card(s): ${e?.message ?? e}`
    );
    return stampAll(); // no token -> cached covers + fallbacks, never block game start
  }

  const ctrl = newCoverJob();
  const state: CoverBatchState = {
    signal: ctrl.signal,
    token,
    hardStrikes: 0,
    broken: false,
    e403: 0,
    e404: 0,
    e429: 0,
    eOther: 0,
  };
  console.warn(`[coverArt] urgent: fetching ${ids.length} start cover(s)`);
  const found = await fetchCoverBatch(ids, state);
  console.warn(
    `[coverArt] urgent: resolved ${found.size}/${ids.length} ` +
      `(errors: ${state.e403}x 403, ${state.e404}x 404, ${state.e429}x 429, ${state.eOther}x other)`
  );
  return stampAll();
}

/**
 * Fire-and-forget background fetch for every remaining cover-less card. Starts
 * AFTER the game is running - "Spiel starten" never waits on this. Covers land
 * in the module cache (Online host stamps them at draw time); `onCovers`
 * additionally delivers each resolved chunk as trackUri -> url (Pass & Play
 * dispatches it into the reducer so already-dealt cards update too).
 * Single-flight: starting a new prefetch aborts the previous one.
 */
export function startCoverArtPrefetch(
  cards: GameCard[],
  onCovers?: (covers: Record<string, string>) => void
): void {
  const ids = coverIdsFor(cards, Number.POSITIVE_INFINITY);
  if (ids.length === 0) return;

  const ctrl = newCoverJob();
  (async () => {
    let token: string;
    try {
      token = await getWebApiToken();
    } catch (e: any) {
      console.warn(
        `[coverArt] prefetch: no Web API token -> skipping ${ids.length} cover(s): ${e?.message ?? e}`
      );
      return;
    }
    const state: CoverBatchState = {
      signal: ctrl.signal,
      token,
      hardStrikes: 0,
      broken: false,
      e403: 0,
      e404: 0,
      e429: 0,
      eOther: 0,
    };
    console.warn(`[coverArt] prefetch: loading ${ids.length} cover(s) in the background`);
    let resolved = 0;
    // Chunked so consumers see covers progressively and an abort/breaker stops
    // between chunks; breaker state carries across chunks (one logical run).
    for (let i = 0; i < ids.length; i += COVER_CHUNK) {
      if (state.broken || ctrl.signal.aborted) break;
      const found = await fetchCoverBatch(ids.slice(i, i + COVER_CHUNK), state);
      resolved += found.size;
      if (found.size > 0 && onCovers && !ctrl.signal.aborted) {
        const byUri: Record<string, string> = {};
        found.forEach((url, id) => {
          byUri[`${COVER_PREFIX}${id}`] = url;
        });
        onCovers(byUri);
      }
    }
    console.warn(
      `[coverArt] prefetch: done, resolved ${resolved}/${ids.length} ` +
        `(aborted=${ctrl.signal.aborted}, breaker=${state.broken}, ` +
        `errors: ${state.e403}x 403, ${state.e404}x 404, ${state.e429}x 429, ${state.eOther}x other)`
    );
  })().catch((e: any) => {
    console.warn(`[coverArt] prefetch failed: ${e?.message ?? e}`);
  });
}

/** Summary of one of the user's playlists, for the in-app picker. */
export interface PlaylistSummary {
  id: string;
  name: string;
  imageUrl: string | null;
  trackCount: number;
  ownerName: string;
}

/**
 * Load the connected user's playlists (owned + followed/collaborative), paginated.
 * Reuses the PKCE Web API token. GET /me/playlists is known to work (200).
 */
export async function getUserPlaylists(): Promise<PlaylistSummary[]> {
  const token = await getWebApiToken();
  const PAGE = 50;
  const MAX = 300; // safety cap (6 pages)
  const out: PlaylistSummary[] = [];

  for (let offset = 0; offset < MAX; offset += PAGE) {
    const url = `https://api.spotify.com/v1/me/playlists?limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw await webApiError(res, 'playlists');
    }
    const data = await res.json();
    const items: any[] = data?.items ?? [];
    for (const pl of items) {
      if (!pl || !pl.id) continue;
      // Track count container: the Feb/Mar-2026 API migration renamed the
      // playlist-items container `tracks`->`items` (verified: `tracks` is now
      // undefined, `items.total` holds the count). `tracks.total` is kept as a
      // cheap guard in case Spotify reverts/varies the field again.
      const trackCount = pl.items?.total ?? pl.tracks?.total ?? 0;
      out.push({
        id: pl.id,
        name: pl.name ?? 'Unbenannte Playlist',
        imageUrl: pl.images?.[0]?.url ?? null,
        trackCount,
        ownerName: pl.owner?.display_name ?? '',
      });
    }
    if (items.length < PAGE || !data?.next) break;
  }
  return out;
}
