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
/** Track ids already used this session, so the deck never repeats a track. */
const playedTrackIds = new Set<string>();

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
    // Deliberately no "Verbindung trennen" hint: in the dead-end state the
    // Settings button shows "verbinden" (there is no disconnect to tap). connect()
    // self-heals (clears + re-consents) BEFORE this is shown, so reaching here
    // means even a fresh consent was refused.
    return new Error(
      'Spotify-Berechtigung konnte nicht erteilt werden. Bitte stelle sicher, dass du in ' +
        'der Spotify-App eingeloggt bist, und versuche es erneut.'
    );
  }
  if (raw.includes('notloggedin') || raw.includes('not logged in')) {
    return new Error('Not logged in to the Spotify app. Log in there, then retry.');
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
    const session = await withTimeout(
      getAuth().authorize({
        clientID: CLIENT_ID,
        redirectURL: REDIRECT_URL,
        scopes: WEB_API_SCOPES as any,
      }),
      APP_REMOTE_TIMEOUT_MS,
      'Spotify-Autorisierung'
    );
    if (!session?.accessToken) {
      throw new Error(
        'Spotify authorization did not return an access token. Check the iOS redirect callback.'
      );
    }
    await withTimeout(
      getRemote().connect(session.accessToken),
      APP_REMOTE_TIMEOUT_MS,
      'Spotify-Verbindung'
    );
    connected = true;
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
  connected = true;
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
  connected = false;
  webApiToken = null;
  webApiRefreshToken = null;
  webApiTokenExpiresAt = 0;
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
  const result = await request.promptAsync(SPOTIFY_DISCOVERY, {
    preferEphemeralSession: true,
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

/** Play a Spotify URI, e.g. "spotify:track:<id>". */
export function playUri(uri: string): Promise<void> {
  return getRemote().playUri(uri);
}

export function pause(): Promise<void> {
  return getRemote().pause();
}

/** Build a readable error from an already-read Web API response body. */
function buildWebApiError(status: number, context: string, body: string): Error {
  if (status === 403) {
    return new Error(
      `Spotify Web API 403 (${context}): Zugriff verweigert. Häufigste Ursachen: ` +
        '(1) eine von Spotify erstellte/redaktionelle Playlist (Discover Weekly, ' +
        '"This Is…", Top-Charts) - über die Web API gesperrt; nutze eine selbst ' +
        'erstellte Playlist. (2) Der Token hat die Playlist-Scopes nicht - in den ' +
        'Einstellungen "Verbindung trennen" und neu verbinden. ' +
        `Server-Antwort: ${body}`
    );
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

/**
 * Fill in missing cover art for cards that have a `spotify:track:<id>` URI but no
 * coverUrl - i.e. pool songs (the pool stores no cover). Fetches one
 * GET /v1/tracks/{id} per track (the batch endpoint was removed for Dev-Mode apps
 * in the Feb-2026 migration) with bounded concurrency, and maps album.images[0].
 *
 * Non-fatal by design: if there is no token (e.g. a non-host device) or requests
 * fail, the affected cards keep coverUrl undefined and the UI shows its fallback.
 * Runs on the deck-building device (Hot-Seat device / Online host); for Online the
 * enriched cards are written into game_state, so every client gets the covers too.
 */
export async function addCoverArt(cards: GameCard[]): Promise<GameCard[]> {
  const PREFIX = 'spotify:track:';
  const idOf = (uri: string) => uri.slice(PREFIX.length);
  const need = cards.filter((c) => !c.coverUrl && c.trackUri?.startsWith(PREFIX));
  if (need.length === 0) return cards;

  // Diagnostics use console.warn (not console.log): the project has no
  // transform-remove-console babel config, so console.* survives dev AND release,
  // but .warn is the more visible/prominent channel in Metro and device logs.
  let token: string;
  try {
    token = await getWebApiToken();
  } catch (e: any) {
    console.warn(
      `[addCoverArt] no Web API token -> skipping cover fetch for ${need.length} card(s): ${e?.message ?? e}`
    );
    return cards; // no token -> keep fallbacks, never block deck loading
  }
  console.warn(`[addCoverArt] token present; fetching covers for ${need.length} pool card(s)`);

  // Spotify Feb-2026 migration: the batch GET /v1/tracks?ids=... was REMOVED for
  // Development-Mode apps (returned 403 on every batch). The replacement is one
  // GET /v1/tracks/{id} per track. To avoid firing 300+ requests at once we use a
  // small fixed concurrency (workers pull from a shared cursor). The `linked_from`
  // relinking field was also removed in the same migration, so we key purely by t.id.
  const ids = [...new Set(need.map((c) => idOf(c.trackUri)))];
  const coverById = new Map<string, string>();
  let e403 = 0;
  let e404 = 0;
  let e429 = 0;
  let eOther = 0;
  const CONCURRENCY = 6;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const fetchOne = async (id: string): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        eOther += 1; // network error
        return;
      }
      if (res.ok) {
        const t = await res.json().catch(() => null);
        const url = t?.album?.images?.[0]?.url;
        if (url && t?.id) coverById.set(t.id, url);
        else eOther += 1; // 200 but no cover image
        return;
      }
      // 429: respect Retry-After with ONE short, capped backoff, then retry once.
      // Never blindly hammer on - if 429s persist they are counted and surfaced.
      if (res.status === 429 && attempt === 0) {
        const raw = res.headers.get('retry-after');
        const parsed = parseInt(raw ?? '', 10);
        const waitS = Number.isFinite(parsed) ? Math.min(parsed, 5) : 1;
        console.warn(`[addCoverArt] 429 on ${id}; Retry-After=${raw ?? 'none'} -> wait ${waitS}s, one retry`);
        await sleep(waitS * 1000);
        continue;
      }
      if (res.status === 403) e403 += 1;
      else if (res.status === 404) e404 += 1;
      else if (res.status === 429) e429 += 1;
      else eOther += 1;
      return;
    }
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      await fetchOne(id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));

  console.warn(
    `[addCoverArt] resolved ${coverById.size}/${ids.length} cover(s) ` +
      `(errors: ${e403}x 403, ${e404}x 404, ${e429}x 429, ${eOther}x other)`
  );
  if (coverById.size === 0) return cards;

  return cards.map((c) =>
    !c.coverUrl && c.trackUri?.startsWith(PREFIX)
      ? { ...c, coverUrl: coverById.get(idOf(c.trackUri)) ?? c.coverUrl }
      : c
  );
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
