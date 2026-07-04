/**
 * Read a PUBLIC Spotify playlist directly into a song-pool raw list.
 *
 * Unlike the AI-memory raw lists, every row here comes straight from Spotify's
 * playlist API, so the title/artist/track-id/ISRC are guaranteed to exist and
 * match each other - no text search, no rate-mismatch. This is a READ-ONLY
 * script: it never touches Supabase and never writes to the DB.
 *
 * Usage:
 *   node scripts/import-spotify-playlist.js <playlistId|URL> <outputCsvPath>
 *
 * Examples (HITSTER "Deutsch" playlist, ~308 tracks):
 *   node scripts/import-spotify-playlist.js 26zIHVncgI9HmHlgYWwnDi scripts/raw_hitster_deutsch.csv
 *   node scripts/import-spotify-playlist.js \
 *     "https://open.spotify.com/playlist/26zIHVncgI9HmHlgYWwnDi?si=abc" scripts/raw.csv
 *   node scripts/import-spotify-playlist.js spotify:playlist:26zIHVncgI9HmHlgYWwnDi scripts/raw.csv
 *
 * Output CSV columns: title,artist,estimated_year,spotify_track_id,isrc,
 * spotify_album_name,spotify_album_type,spotify_album_release_date,
 * spotify_duration_ms,spotify_album_artist,spotify_track_number,
 * spotify_disc_number
 *   - estimated_year is album.release_date's year ONLY as a rough hint; the
 *     precheck step still verifies the year via MusicBrainz.
 *
 * AUTH — this script uses an interactive USER login (Authorization Code flow with
 * PKCE), NOT Client-Credentials. Reason: Spotify forbids reading playlist
 * contents with a Client-Credentials token; a logged-in user is allowed. (The
 * OTHER scripts stay on Client-Credentials — only this one changed.)
 *
 * ENDPOINT (Feb 2026 Web API change): reads GET /playlists/{id}/items (the old
 * /playlists/{id}/tracks was removed; migration deadline 9 Mar 2026). Playlist
 * contents are returned ONLY for your own or collaborative playlists — for a
 * foreign playlist the `items` field is absent and the script aborts with a
 * clear message (copy the playlist into your own profile first).
 *
 * On first run the script starts a short-lived local HTTP server, prints a login
 * URL to open in your browser, catches the redirect, swaps the code for tokens
 * and caches them (access + refresh) in a gitignored file. Later runs reuse the
 * cached access token, or silently refresh it — no repeated login.
 *
 * MANUAL ONE-TIME STEP: register the redirect URI in the Spotify Developer
 * Dashboard (App → Settings → Redirect URIs):  http://127.0.0.1:8888/callback
 * (override the port/URI via SPOTIFY_PLAYLIST_REDIRECT_URI if needed; it must
 * match the Dashboard value EXACTLY). Only SPOTIFY_CLIENT_ID is required in
 * scripts/.env for PKCE (no client secret).
 *
 * Needs Node 18+ (global fetch).
 */
'use strict';
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { loadEnv, writeCsvObjects, need } = require('./lib/util');
const { fetchWithRetry } = require('./lib/verify-songs');

loadEnv(path.join(__dirname, '.env'));

const COLUMNS = [
  'title',
  'artist',
  'estimated_year',
  'spotify_track_id',
  'isrc',
  'spotify_album_name',
  'spotify_album_type',
  'spotify_album_release_date',
  'spotify_duration_ms',
  'spotify_album_artist',
  'spotify_track_number',
  'spotify_disc_number',
];

// --- User-login (Authorization Code + PKCE) config -------------------------
const REDIRECT_URI = process.env.SPOTIFY_PLAYLIST_REDIRECT_URI || 'http://127.0.0.1:8888/callback';
// Reading a public playlist's tracks needs no scope, but private playlists do;
// we request the read scopes so the same login also covers the user's own /
// collaborative lists. (Verified live: public reads work with this scope set.)
const SCOPES = 'playlist-read-private playlist-read-collaborative';
const TOKEN_FILE = path.join(__dirname, '.spotify-user-token.json');
const AUTH_BASE = 'https://accounts.spotify.com';

/**
 * Extract the 22-char base-62 playlist id from a raw id, an open.spotify.com URL
 * or a spotify:playlist: URI. Returns null if nothing usable is found.
 */
function parsePlaylistId(input) {
  const s = String(input || '').trim();
  // Matches ".../playlist/<id>" (URL) and "playlist:<id>" (URI).
  const m = s.match(/playlist[/:]([A-Za-z0-9]+)/);
  if (m) return m[1];
  // Bare id (no decoration).
  if (/^[A-Za-z0-9]+$/.test(s)) return s;
  return null;
}

/** Year from a Spotify release_date ("2019", "2019-05", "2019-05-31"). */
function yearOf(releaseDate) {
  const m = String(releaseDate || '').match(/^(\d{4})/);
  return m ? m[1] : '';
}

/** Empty accumulator for {@link accumulatePage}. */
function newAcc() {
  return {
    rows: [],
    skipped: { nullTrack: 0, local: 0, incomplete: 0 },
    seen: 0,
    withoutIsrc: 0,
  };
}

/**
 * Fold one playlist-tracks page (its `items` array) into `acc`. Null tracks and
 * local files are skipped + counted (never crash). Pure + side-effect-free apart
 * from mutating `acc`, so it can be unit-tested without the network.
 */
function accumulatePage(items, acc) {
  for (const item of Array.isArray(items) ? items : []) {
    acc.seen++;
    // The /items endpoint (Feb 2026) renames the wrapper's `track` field to
    // `item`. Read `item` first, fall back to `track` so we keep working during
    // the migration window (both shapes may appear until 9 Mar 2026).
    const t = item && (item.item || item.track);
    // Null entry = removed/region-unavailable. Local file = not a Spotify track.
    if (!t) {
      acc.skipped.nullTrack++;
      continue;
    }
    if (item.is_local || t.is_local || !t.id) {
      acc.skipped.local++;
      continue;
    }
    const title = (t.name || '').trim();
    const artist = (t.artists || [])
      .map((a) => (a && a.name ? a.name.trim() : ''))
      .filter(Boolean)
      .join(', ');
    if (!title || !artist) {
      acc.skipped.incomplete++;
      continue;
    }
    const album = t.album || {};
    const isrc = (t.external_ids && t.external_ids.isrc) || '';
    const albumArtist = (album.artists || [])
      .map((a) => (a && a.name ? a.name.trim() : ''))
      .filter(Boolean)
      .join(', ');
    if (!isrc) acc.withoutIsrc++;
    acc.rows.push({
      title,
      artist,
      estimated_year: yearOf(album.release_date),
      spotify_track_id: t.id,
      isrc,
      spotify_album_name: album.name || '',
      spotify_album_type: album.album_type || '',
      spotify_album_release_date: album.release_date || '',
      spotify_duration_ms: t.duration_ms || '',
      spotify_album_artist: albumArtist,
      spotify_track_number: t.track_number || '',
      spotify_disc_number: t.disc_number || '',
    });
  }
  return acc;
}

// ===========================================================================
// Spotify USER auth — Authorization Code flow with PKCE (no client secret)
// ===========================================================================

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** PKCE pair: a random verifier and its S256 challenge. */
function makePkce() {
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Build the Spotify consent URL the user opens in the browser. */
function buildAuthUrl({ clientId, redirectUri, scope, challenge, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });
  return `${AUTH_BASE}/authorize?${q.toString()}`;
}

/** A short-lived HTTP server that resolves with the ?code once the redirect lands. */
function captureRedirect({ redirectUri, expectedState }) {
  const u = new URL(redirectUri);
  const port = Number(u.port) || 80;
  const wantPath = u.pathname || '/callback';
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://${u.host}`);
      if (reqUrl.pathname !== wantPath) {
        res.writeHead(404).end('Not found');
        return;
      }
      const err = reqUrl.searchParams.get('error');
      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');
      const done = (msg) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body style="font-family:sans-serif;background:#1A0F3C;color:#fff;text-align:center;padding-top:60px">
          <h2>${msg}</h2><p>Du kannst dieses Fenster jetzt schließen.</p></body></html>`);
      };
      if (err) {
        done('Login abgebrochen.');
        server.close(() => reject(new Error(`Spotify-Login abgelehnt: ${err}`)));
      } else if (!code || state !== expectedState) {
        done('Ungültige Antwort.');
        server.close(() => reject(new Error('Ungültiger State/Code in der Redirect-Antwort.')));
      } else {
        done('Login erfolgreich ✓');
        server.close(() => resolve(code));
      }
    });
    server.on('error', reject);
    server.listen(port, u.hostname);
  });
}

/** POST to the token endpoint; returns the parsed token JSON or throws. */
async function tokenRequest(params) {
  const res = await fetchWithRetry(
    `${AUTH_BASE}/api/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    },
    { label: 'Token-Tausch' }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token-Endpoint ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

/** Persist tokens to the gitignored cache, computing an absolute expiry. */
function saveTokens(tok, prevRefresh) {
  const out = {
    access_token: tok.access_token,
    // A refresh response may omit refresh_token -> keep the previous one.
    refresh_token: tok.refresh_token || prevRefresh || null,
    expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000,
    scope: tok.scope || SCOPES,
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(out, null, 2), 'utf8');
  return out;
}

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Full interactive login: server up, print URL, capture code, exchange. */
async function interactiveLogin(clientId) {
  const { verifier, challenge } = makePkce();
  const state = b64url(crypto.randomBytes(16));
  const url = buildAuthUrl({ clientId, redirectUri: REDIRECT_URI, scope: SCOPES, challenge, state });
  const codePromise = captureRedirect({ redirectUri: REDIRECT_URI, expectedState: state });

  console.log('\n┌─ Spotify-Login erforderlich ───────────────────────────────');
  console.log('│ Öffne diese URL im Browser und bestätige den Zugriff:');
  console.log('│');
  console.log(`│   ${url}`);
  console.log('│');
  console.log(`│ Warte auf Redirect (${REDIRECT_URI})…`);
  console.log('└────────────────────────────────────────────────────────────\n');

  const code = await codePromise;
  const tok = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  return saveTokens(tok, null);
}

/**
 * Return a valid USER access token, reusing the cache when possible:
 *   1. cached + not expired  -> use as-is (no network)
 *   2. cached + refresh_token -> silent refresh
 *   3. otherwise             -> one interactive browser login
 */
async function getUserAccessToken() {
  const clientId = need('SPOTIFY_CLIENT_ID');
  const cached = loadTokens();
  if (cached && cached.access_token && Date.now() < cached.expires_at - 60000) {
    return cached.access_token;
  }
  if (cached && cached.refresh_token) {
    try {
      const tok = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: cached.refresh_token,
        client_id: clientId,
      });
      console.log('Spotify-Token via Refresh erneuert (kein erneuter Login nötig).');
      return saveTokens(tok, cached.refresh_token).access_token;
    } catch (e) {
      console.log(`Refresh fehlgeschlagen (${e.message}) – neuer Login folgt.`);
    }
  }
  const fresh = await interactiveLogin(clientId);
  return fresh.access_token;
}

async function fetchPage(url, token, label) {
  const res = await fetchWithRetry(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    { label }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Spotify ${res.status} bei ${label}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function main() {
  const [, , rawId, outPath] = process.argv;
  if (!rawId || !outPath) {
    console.error('Aufruf: node scripts/import-spotify-playlist.js <playlistId|URL> <outputCsvPath>');
    process.exit(1);
  }
  const id = parsePlaylistId(rawId);
  if (!id) {
    console.error(`Konnte keine Playlist-ID aus "${rawId}" lesen.`);
    process.exit(1);
  }

  const token = await getUserAccessToken();

  // Feb 2026 Web API change: GET /playlists/{id}/tracks was removed and replaced
  // by GET /playlists/{id}/items. Each page element is now `{ is_local, item }`
  // (was `{ is_local, track }`). `next` is a full URL carrying the offset; even
  // if it dropped the field filter our parser reads the full object anyway.
  const fields =
    'items(is_local,item(name,id,is_local,duration_ms,track_number,disc_number,artists(name),external_ids(isrc),album(name,album_type,release_date,artists(name)))),next,total';
  let url =
    `https://api.spotify.com/v1/playlists/${id}/items` +
    `?limit=100&fields=${encodeURIComponent(fields)}`;

  const acc = newAcc();
  let total = null;
  let page = 0;

  while (url) {
    page++;
    const data = await fetchPage(url, token, `Playlist-Seite ${page}`);
    // Foreign playlists return NO `items` field at all (Feb 2026 rule: contents
    // only for own/collaborative playlists). Fail clearly instead of writing an
    // empty CSV or crashing on undefined.
    if (page === 1 && !Array.isArray(data.items)) {
      throw new Error(
        `Spotify liefert keine "items" für Playlist ${id}. Seit den Februar-2026-` +
          'Dev-Mode-Änderungen werden Playlist-Inhalte nur für DEINE EIGENEN oder ' +
          'kollaborative Playlists zurückgegeben. Kopiere die Playlist in dein eigenes ' +
          'Spotify-Profil und nutze die ID der Kopie.'
      );
    }
    if (total === null && typeof data.total === 'number') total = data.total;
    accumulatePage(data.items, acc);
    url = data.next || null;
  }

  writeCsvObjects(outPath, COLUMNS, acc.rows);

  const { rows, skipped, seen, withoutIsrc } = acc;
  const line = '─'.repeat(60);
  console.log(`\n${line}\nSPOTIFY-PLAYLIST → ROHLISTE\n${line}`);
  console.log(`Playlist-ID:                 ${id}`);
  console.log(`Tracks in der Playlist:      ${total ?? seen} (gelesen: ${seen}, Seiten: ${page})`);
  console.log(`Exportiert:                  ${rows.length}`);
  console.log(`Übersprungen:                ${skipped.nullTrack + skipped.local + skipped.incomplete}`);
  console.log(`   – Null-/entfernte Tracks:  ${skipped.nullTrack}`);
  console.log(`   – Lokale Dateien:          ${skipped.local}`);
  console.log(`   – Ohne Titel/Künstler:     ${skipped.incomplete}`);
  console.log(`Exportiert, aber ohne ISRC:  ${withoutIsrc}`);
  console.log(`Output-CSV:                  ${outPath}\n`);
}

// Only run when invoked directly; required as a module (tests) it just exports.
if (require.main === module) {
  main().catch((err) => {
    if (err && err.penalty) {
      console.error(`\nAbbruch: ${err.message}`);
    } else {
      console.error(`\nFehler: ${err && err.message ? err.message : err}`);
    }
    process.exit(1);
  });
}

module.exports = {
  parsePlaylistId,
  yearOf,
  newAcc,
  accumulatePage,
  makePkce,
  buildAuthUrl,
  captureRedirect,
};
