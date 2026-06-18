/**
 * Thin wrapper around react-native-spotify-remote for the technical spike.
 *
 * Auth strategy: backend-less TOKEN flow (no tokenSwapURL / tokenRefreshURL).
 * `auth.authorize` returns a session with a ~1h access token, which is enough to
 * connect the App Remote, control playback, and call the Spotify Web API.
 *
 * Track metadata: title/artist come from the Remote PlayerState, but release
 * year and album cover URL are not in the Remote SDK, so we fetch them from the
 * Web API (GET /v1/tracks/{id}) using the same access token.
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
import { NativeModules } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import * as SecureStore from 'expo-secure-store';
import type { ApiConfig } from 'react-native-spotify-remote';
import type { TrackMeta } from '../types/spotify';
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
  if (
    !NativeModules.RNSpotifyRemoteAuth ||
    !NativeModules.RNSpotifyRemoteAppRemote
  ) {
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

/** True if the native SDK is loaded and ready to authorize. */
export function isSdkReady(): boolean {
  try {
    return !!getSDK().auth;
  } catch {
    return false;
  }
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

const spotifyConfig: ApiConfig = {
  clientID: CLIENT_ID,
  redirectURL: REDIRECT_URL,
  // TOKEN = one-time login, no backend token swap needed (Android honours this).
  authType: 'TOKEN',
  // IMPORTANT: the Android native module reads this with ReadableMap.getBoolean(),
  // which throws NoSuchKeyException (a hard native crash, NOT a catchable promise
  // rejection) if the key is absent. Always pass it explicitly.
  showDialog: false,
  // Scopes must cover both Web API playlist reads (otherwise getPlaylistTracks
  // returns 403) and playback. Plain string literals (equal to the ApiScope enum
  // values) so we don't need a runtime import of the SDK here - see the lazy
  // require note above. app-remote-control is kept because the App Remote
  // connection (playUri etc.) requires it; the rest fix the playlist 403.
  scopes: [
    'playlist-read-private',
    'playlist-read-collaborative',
    'streaming',
    'user-read-playback-state',
    'user-modify-playback-state',
    'app-remote-control',
  ] as unknown as ApiConfig['scopes'],
};

/** In-memory access token from the most recent authorize() call. */
let accessToken: string | null = null;
/** True once we have authorized AND connected the App Remote at least once. */
let connected = false;
/** Track ids already used this session, so the deck never repeats a track. */
const playedTrackIds = new Set<string>();

/**
 * Connect to Spotify: PKCE Web API authorization + App Remote connection.
 *
 * Why no auth.authorize() here anymore: Spotify is phasing out the implicit/TOKEN
 * grant, which made the old auth.authorize() fall back to a browser email/OTP
 * login. On Android the App Remote does NOT use that token anyway - it
 * authenticates app-to-app via the installed Spotify app (clientId + redirectUri).
 * So we:
 *   1) run the modern Authorization Code + PKCE flow (also gets the user's
 *      consent for app-remote-control / streaming, pre-authorizing the remote), and
 *   2) connect the App Remote via connectWithoutAuth (no deprecated SSO).
 * The PKCE token also powers the Web API (playlists). Throws on missing config /
 * cancel / Spotify app not reachable.
 */
export async function connect(): Promise<void> {
  if (!CLIENT_ID || !REDIRECT_URL) {
    throw new Error(
      'Missing Spotify config. Set EXPO_PUBLIC_SPOTIFY_CLIENT_ID and ' +
        'EXPO_PUBLIC_SPOTIFY_REDIRECT_URI in .env, then rebuild the dev client.'
    );
  }

  // 1) Web API authorization (Authorization Code + PKCE). Single browser step;
  //    also pre-authorizes the playback scopes used by the App Remote below.
  await ensureWebApiAuthorized();

  // 2) App Remote, app-to-app via the installed Spotify app. The token arg is
  //    ignored by the Android module (it builds ConnectionParams from
  //    clientId + redirectUri); we pass '' on purpose. This avoids the
  //    deprecated implicit-grant auth.authorize() path entirely.
  try {
    // connectWithoutAuth is a native @ReactMethod not surfaced in the lib's TS
    // types, so we access it via the (guarded) remote singleton with a cast.
    const remote = getRemote() as unknown as {
      connectWithoutAuth: (
        token: string,
        clientId: string,
        redirectUri: string
      ) => Promise<void>;
    };
    await remote.connectWithoutAuth('', CLIENT_ID, REDIRECT_URL);
    connected = true;
  } catch (e: any) {
    const raw = `${e?.code ?? ''} ${e?.message ?? e}`.toLowerCase();
    if (
      raw.includes('couldnotfindspotifyapp') ||
      raw.includes('could not find') ||
      raw.includes('not installed')
    ) {
      throw new Error(
        'Spotify app not found. Install the Spotify app and open it once, ' +
          'then try again (the App Remote SDK talks to the running Spotify app).'
      );
    }
    if (raw.includes('not authorized')) {
      throw new Error(
        'Spotify-Berechtigung fehlt. Im Spotify-Tab "Verbindung trennen" und neu ' +
          'verbinden, damit die Wiedergabe-Berechtigung erteilt wird.'
      );
    }
    if (raw.includes('notloggedin') || raw.includes('not logged in')) {
      throw new Error('Not logged in to the Spotify app. Log in there, then retry.');
    }
    throw e;
  }

  // --- Legacy fallback (deprecated implicit/TOKEN flow) ----------------------
  // If a device's Spotify app is too old to support connectWithoutAuth, the
  // previous path was (kept here for reference; Spotify is deprecating TOKEN):
  //
  //   const session = await getAuth().authorize(spotifyConfig);
  //   accessToken = session.accessToken;
  //   await getRemote().connect(session.accessToken);
  //   connected = true;
  //   await ensureWebApiAuthorized();
}

/**
 * End the Spotify session (clears cookies) and reset local connection state.
 * Required after changing requested scopes: it forces the next connect() to do a
 * fresh authorize() so a new token with the new scopes is issued, instead of the
 * cached one with the old scopes.
 */
export async function disconnect(): Promise<void> {
  try {
    await getAuth().endSession();
  } finally {
    accessToken = null;
    connected = false;
    // Also drop the PKCE Web-API token (memory + encrypted storage) so a
    // reconnect re-authorizes cleanly.
    webApiToken = null;
    webApiRefreshToken = null;
    webApiTokenExpiresAt = 0;
    try {
      await SecureStore.deleteItemAsync(TOKEN_STORE_KEY);
    } catch {
      // ignore
    }
  }
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
    'Spotify Web API nicht autorisiert. Bitte zuerst im Spotify-Tab ' +
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

export function resume(): Promise<void> {
  return getRemote().resume();
}

/** Whether playback is currently paused (from the live player state). */
export async function isPaused(): Promise<boolean> {
  const state = await getRemote().getPlayerState();
  return state.isPaused;
}

/**
 * Subscribe to player state changes (used to keep the play/pause button in sync).
 * Returns an unsubscribe function.
 */
export function onPlayerStateChanged(
  cb: (isPausedNow: boolean) => void
): () => void {
  const handler = (state: { isPaused: boolean }) => cb(state.isPaused);
  getRemote().addListener('playerStateChanged', handler);
  return () => {
    getRemote().removeListener('playerStateChanged', handler);
  };
}

/** Extract the bare track id from "spotify:track:<id>" or a raw id. */
function trackIdFromUri(uriOrId: string): string {
  const parts = uriOrId.split(':');
  return parts[parts.length - 1];
}

/**
 * The access token to use for Web API calls.
 *
 * Source of truth is the SDK's live session (getAuth().getSession()), i.e. the
 * EXACT same token the App Remote was connected with. We fall back to the token
 * captured during connect(). This guarantees Web API and playback never use a
 * different/stale token.
 */
async function getApiToken(): Promise<string> {
  try {
    const session = await getAuth().getSession();
    if (session?.accessToken) {
      accessToken = session.accessToken;
    }
  } catch {
    // getSession may be unavailable before connect(); fall back to cached token.
  }
  if (!accessToken) {
    throw new Error('Not authorized yet - connect to Spotify first.');
  }
  return accessToken;
}

/** Build a readable error from an already-read Web API response body. */
function buildWebApiError(status: number, context: string, body: string): Error {
  if (status === 403) {
    return new Error(
      `Spotify Web API 403 (${context}): Zugriff verweigert. Häufigste Ursachen: ` +
        '(1) eine von Spotify erstellte/redaktionelle Playlist (Discover Weekly, ' +
        '"This Is…", Top-Charts) - über die Web API gesperrt; nutze eine selbst ' +
        'erstellte Playlist. (2) Der Token hat die Playlist-Scopes nicht - im ' +
        'Spotify-Tab "Verbindung trennen" und neu verbinden. ' +
        `Server-Antwort: ${body}`
    );
  }
  if (status === 401) {
    return new Error(
      `Spotify Web API 401 (${context}): Token abgelaufen/ungültig. Im Spotify-Tab ` +
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

/**
 * Fetch title / artist / release year / cover URL for a track via the Web API.
 * Requires a prior connect() so we have an access token.
 */
export async function getTrackMeta(uriOrId: string): Promise<TrackMeta> {
  const token = await getApiToken();
  const id = trackIdFromUri(uriOrId);
  const res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw await webApiError(res, 'track');
  }
  const data = await res.json();
  const releaseDate: string = data?.album?.release_date ?? '';
  const images: Array<{ url: string }> = data?.album?.images ?? [];
  return {
    title: data?.name ?? 'Unknown',
    artist: data?.artists?.[0]?.name ?? 'Unknown',
    // Spotify returns "YYYY", "YYYY-MM" or "YYYY-MM-DD" - take the year.
    year: releaseDate.substring(0, 4),
    coverUrl: images[0]?.url,
  };
}

// ---------------------------------------------------------------------------
// Game helpers
// ---------------------------------------------------------------------------

/** True if authorize()+connect() has already succeeded this session. */
export function isConnected(): boolean {
  return connected;
}

/**
 * Authorize + connect the App Remote only if not already connected.
 * Safe to call before loading a playlist / starting a game.
 */
export async function ensureConnected(): Promise<void> {
  if (connected) return;
  await connect();
}

/** Mark a track as played so it is not offered again (cross-game dedup). */
export function markTrackPlayed(trackId: string): void {
  playedTrackIds.add(trackId);
}

export function isTrackPlayed(trackId: string): boolean {
  return playedTrackIds.has(trackId);
}

/** Clear the played-track history (e.g. when explicitly starting fresh). */
export function resetPlayedTracks(): void {
  playedTrackIds.clear();
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
      });
    }

    if (items.length < PAGE || !data?.next) break;
  }

  return cards;
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
      out.push({
        id: pl.id,
        name: pl.name ?? 'Unbenannte Playlist',
        imageUrl: pl.images?.[0]?.url ?? null,
        trackCount: pl.tracks?.total ?? 0,
        ownerName: pl.owner?.display_name ?? '',
      });
    }
    if (items.length < PAGE || !data?.next) break;
  }
  return out;
}

/** Fisher-Yates shuffle returning a new array (does not mutate the input). */
export function shuffleDeck<T>(tracks: T[]): T[] {
  const out = tracks.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
