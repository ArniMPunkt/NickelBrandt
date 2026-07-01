/**
 * Shared song verification: Spotify track resolution + MusicBrainz year check.
 *
 * Ported 1:1 from the original scripts/import-song-pool.js (Spotify
 * Client-Credentials search + the musicbrainz.ts ISRC-batch / sliding-window
 * logic). Extracted here so the new two-stage scripts reuse it instead of
 * duplicating it. This module makes NO Supabase calls.
 *
 * Needs Node 18+ (global fetch). Reads Spotify creds from process.env
 * (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET) — load scripts/.env first.
 */
'use strict';
const { need, parseCSV } = require('./util');

if (typeof fetch === 'undefined') {
  console.error('This needs Node 18+ (global fetch is missing). Please upgrade Node.');
  process.exit(1);
}

// Prefer IPv4 first. A common cause of `fetch()` hanging on the very first
// connection is the host resolving to an IPv6 address that can't be routed;
// undici then waits a very long time. This makes connects reliable.
try {
  require('dns').setDefaultResultOrder('ipv4first');
} catch {
  // older Node without the API -> ignore
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HTTP_TIMEOUT_MS = 20000;

/** fetch() with a hard timeout, so a stalled request fails loudly instead of hanging. */
async function fetchWithTimeout(url, opts = {}, ms = HTTP_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`HTTP request timed out after ${ms}ms: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const MAX_RETRIES = 5; // attempts on HTTP 429 before giving up on this request
const DEFAULT_RETRY_AFTER_S = 5; // wait if a 429 has no / unparseable Retry-After
const MAX_RETRY_WAIT_S = 60; // hard upper bound per wait, regardless of the header
// A Retry-After above this is not a transient burst limit but a multi-minute/hour
// COOLDOWN penalty. Retrying every 60s would grind for ages, so we abort the whole
// run immediately instead. Normal transient 429s are ~1-30s.
const PENALTY_RETRY_AFTER_S = 120;

/**
 * Turn a raw Retry-After header into a sane wait (seconds). Retry-After is a
 * count of SECONDS; a non-numeric value (e.g. an HTTP-date) or missing header
 * falls back to the default. The result is CAPPED at MAX_RETRY_WAIT_S so a bogus
 * or punitive header value can never cause an hours-long wait.
 * Returns { waitS, reported, capped }.
 */
function computeRetryWaitS(rawHeader) {
  const parsed = parseInt(rawHeader || '', 10);
  const reported = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RETRY_AFTER_S;
  const capped = reported > MAX_RETRY_WAIT_S;
  return { waitS: capped ? MAX_RETRY_WAIT_S : reported, reported, capped };
}

/**
 * fetch() with timeout AND automatic retry on HTTP 429 (Too Many Requests):
 * reads Retry-After (capped), waits, retries up to MAX_RETRIES. Returns the
 * Response for any non-429 status (incl. 401/4xx/5xx — the caller decides). After
 * MAX_RETRIES of 429s it throws an Error with `.rateLimited = true` so the caller
 * can mark just THIS item as failed and continue. `label` is used in the wait
 * log; `onRetry()` fires once per wait (so callers can count "needed a retry").
 */
async function fetchWithRetry(url, opts = {}, { label = '', onRetry } = {}) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetchWithTimeout(url, opts);
    if (res.status !== 429) return res;
    const rawHeader = res.headers.get('retry-after');
    const { waitS, reported, capped } = computeRetryWaitS(rawHeader);
    // Penalty-level Retry-After -> a real cooldown. Don't retry for ages; abort.
    if (reported > PENALTY_RETRY_AFTER_S) {
      const e = new Error(
        `Spotify-Cooldown aktiv (Retry-After ${reported}s ≈ ${Math.round(reported / 60)} min). ` +
          'Das ist kein Code-Fehler – bitte später erneut versuchen.'
      );
      e.penalty = true;
      e.retryAfterS = reported;
      throw e;
    }
    if (attempt >= MAX_RETRIES) break;
    if (onRetry) onRetry(attempt, waitS);
    const note = capped ? ` (Spotify nennt ${reported}s, begrenze auf ${MAX_RETRY_WAIT_S}s)` : '';
    console.log(
      `[429] ${label || url}: Rate-Limit – Retry-After roh="${rawHeader}" → warte ${waitS}s${note}, dann erneut (Versuch ${attempt}/${MAX_RETRIES})…`
    );
    await sleep(waitS * 1000);
  }
  const e = new Error(`Rate-limit (429) nach ${MAX_RETRIES} Versuchen: ${label || url}`);
  e.rateLimited = true;
  throw e;
}

// ---------------------------------------------------------------------------
// Reusable sliding-window rate limiter (extracted from the MusicBrainz slot
// logic so every API source can have its own instance). Each limiter keeps its
// own timestamp array: acquire() blocks until a slot is free within the window.
// ---------------------------------------------------------------------------
function createRateLimiter(windowMs, maxPerWindow) {
  const times = [];
  return {
    async acquire() {
      for (;;) {
        const now = Date.now();
        while (times.length && now - times[0] >= windowMs) times.shift();
        if (times.length < maxPerWindow) {
          times.push(now);
          return;
        }
        await sleep(windowMs - (now - times[0]) + 20);
      }
    },
  };
}

/**
 * Source-agnostic fetch: fetchWithTimeout + an optional rate-limiter slot + a
 * simple backoff retry on 429/503/network errors. Returns the Response (caller
 * checks res.ok / parses); throws after `maxRetries` exhausted. Modeled on the
 * MusicBrainz mbFetch pattern but not tied to any one API.
 */
async function fetchSource(url, opts = {}, { rateLimiter = null, maxRetries = 2, backoffMs = 2000, label = '' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (rateLimiter) await rateLimiter.acquire();
    let res;
    try {
      res = await fetchWithTimeout(url, opts);
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        await sleep(backoffMs);
        continue;
      }
      throw lastErr;
    }
    if (res.status === 429 || res.status === 503) {
      lastErr = new Error(`${label || url}: HTTP ${res.status}`);
      if (attempt < maxRetries) {
        await sleep(backoffMs);
        continue;
      }
      throw lastErr;
    }
    return res;
  }
  throw lastErr ?? new Error(`${label || url}: request failed`);
}

// ---------------------------------------------------------------------------
// Input CSV (title,artist,estimated_year)
// ---------------------------------------------------------------------------
function readInputCsv(csvPath, fs = require('fs')) {
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    process.exit(1);
  }
  const rows = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  if (rows.length === 0) {
    console.error('CSV is empty.');
    process.exit(1);
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const hasHeader = header.includes('title') || header.includes('artist');
  // spotify_track_id + isrc are OPTIONAL extra columns (present in playlist
  // exports, absent in hand-written custom lists). When both are filled the
  // precheck takes a fast-path; otherwise these stay null and nothing changes.
  const idx = hasHeader
    ? {
        title: header.indexOf('title'),
        artist: header.indexOf('artist'),
        year: header.findIndex((h) => h.includes('year')),
        trackId: header.findIndex((h) => h === 'spotify_track_id' || h === 'track_id'),
        isrc: header.indexOf('isrc'),
      }
    : { title: 0, artist: 1, year: 2, trackId: -1, isrc: -1 };
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const out = [];
  for (const r of dataRows) {
    const title = (r[idx.title] ?? '').trim();
    const artist = (r[idx.artist] ?? '').trim();
    const yearRaw = idx.year >= 0 ? (r[idx.year] ?? '').trim() : '';
    const estimatedYear = /^\d{4}$/.test(yearRaw) ? parseInt(yearRaw, 10) : null;
    const trackId = idx.trackId >= 0 ? (r[idx.trackId] ?? '').trim() : '';
    const isrc = idx.isrc >= 0 ? (r[idx.isrc] ?? '').trim() : '';
    if (!title || !artist) continue;
    out.push({ title, artist, estimatedYear, spotifyTrackId: trackId || null, isrc: isrc || null });
  }
  return out;
}

// ===========================================================================
// Spotify — Client Credentials flow (server-to-server, no user login)
// ===========================================================================
// ~4 requests/s. Spotify's limit is a rolling ~30s window; a slower stagger
// reduces how often we hit 429 on 200+ song lists (the retry wrapper covers the
// rest). The extra time is modest (~1s per 4 songs).
const SPOTIFY_STAGGER_MS = 250;

let _tok = { value: null, exp: 0 };
async function getSpotifyToken() {
  if (_tok.value && Date.now() < _tok.exp - 60000) return _tok.value;
  const id = need('SPOTIFY_CLIENT_ID');
  const secret = need('SPOTIFY_CLIENT_SECRET');
  const res = await fetchWithRetry(
    'https://accounts.spotify.com/api/token',
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    },
    { label: 'Token-Abruf' }
  );
  if (!res.ok) throw new Error(`Spotify token request failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  _tok = { value: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return _tok.value;
}

const spotifyClean = (s) => s.replace(/"/g, ' ').trim();

// Multi-artist separators per the spec: &, und, feat. (+ ft./featuring). The
// word-separators require surrounding whitespace so they don't match inside a
// name ("feature", "Fundbüro"); `,` and `/` are deliberately NOT separators to
// avoid breaking single artists like "Tyler, The Creator" or "AC/DC".
const ARTIST_SEP = /\s+(?:feat\.?|ft\.?|featuring|und)\s+|\s*&\s*/i;
const hasMultiArtist = (artist) => ARTIST_SEP.test(artist);
const firstArtist = (artist) => artist.split(ARTIST_SEP)[0].trim();
const splitArtists = (artist) => artist.split(ARTIST_SEP).map((s) => s.trim()).filter(Boolean);

// --- Fallback similarity guard ---------------------------------------------
// Free-text fallback searches almost always return SOMETHING — often the wrong
// song. A fallback hit is only accepted if BOTH the artist and the title
// plausibly match. Small + dependency-free.
const TITLE_SIM_THRESHOLD = 0.6; // lenient: substring/exact already cover suffixes

/** Lowercase, strip diacritics, drop punctuation, collapse whitespace. */
function normalize(s) {
  const decomposed = String(s ?? '').toLowerCase().normalize('NFD');
  let out = '';
  for (const ch of decomposed) {
    const c = ch.codePointAt(0);
    if (c >= 0x300 && c <= 0x36f) continue; // skip combining diacritics (ä->a, é->e)
    out += ch;
  }
  return out.replace(/[^a-z0-9]+/g, ' ').trim(); // punctuation -> space
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/** 0..1 string similarity (1 = identical). */
function simRatio(a, b) {
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
}

/** At least one query artist matches a candidate artist (exact or substring). */
function artistMatches(queryArtist, candidateNames) {
  const qs = splitArtists(queryArtist).map(normalize).filter(Boolean);
  const cs = candidateNames.map(normalize).filter(Boolean);
  for (const q of qs) {
    for (const c of cs) {
      if (q === c || q.includes(c) || c.includes(q)) return true;
    }
  }
  return false;
}

/** Title match: exact, substring containment, or Levenshtein >= threshold. */
function titleMatch(queryTitle, candidateTitle) {
  const a = normalize(queryTitle);
  const b = normalize(candidateTitle);
  if (!a || !b) return { ok: false, score: 0 };
  if (a === b) return { ok: true, score: 1 };
  if (a.includes(b) || b.includes(a)) return { ok: true, score: 0.9 }; // "MfG" vs "MfG Unplugged"
  const score = simRatio(a, b);
  return { ok: score >= TITLE_SIM_THRESHOLD, score };
}

/**
 * Decide whether a FALLBACK candidate is a plausible match. Returns
 * { ok, score } where score is the title similarity (0..1).
 */
function fallbackAccept(queryTitle, queryArtist, track) {
  const candNames = (track.artists || []).map((x) => x.name);
  const artistOk = artistMatches(queryArtist, candNames);
  const t = titleMatch(queryTitle, track.name);
  return { ok: artistOk && t.ok, score: t.score };
}

/**
 * Run ONE Spotify search for a raw query string `q`; returns the top track or
 * null. 429s are handled by fetchWithRetry; the small loop only handles a 401
 * (expired token -> refresh once). Throws (with .rateLimited) if 429 persists.
 */
async function spotifySearchQuery(q, { label, onRetry } = {}) {
  const url = `https://api.spotify.com/v1/search?type=track&limit=5&q=${encodeURIComponent(q)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getSpotifyToken();
    const res = await fetchWithRetry(
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      { label, onRetry }
    );
    if (res.status === 401) {
      _tok = { value: null, exp: 0 }; // expired -> refresh + retry once
      continue;
    }
    if (!res.ok) throw new Error(`Spotify search failed ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data?.tracks?.items ?? [])[0] ?? null;
  }
  throw new Error('Spotify search failed (401 after token refresh).');
}

/**
 * Search with progressively looser fallbacks. Returns { track, method, score }:
 *   - 'strict'                : track:"T" artist:"A"  (exact field filters; trusted)
 *   - 'fallback_loose'        : free text  "T A"       (if strict found nothing)
 *   - 'fallback_first_artist' : free text  "T <first>" (only if A contains a
 *                               multi-artist separator &/und/feat.)
 * STRICT hits are accepted as-is. FALLBACK hits must pass the similarity guard
 * (artist + title), otherwise the candidate is rejected and the next stage tried;
 * if none pass we honestly return "not found". `score` is the title similarity for
 * a fallback hit (null for strict / not found). Each stage is one staggered HTTP
 * request. Throws on hard errors.
 */
async function searchWithFallbacks(title, artist, { onRetry } = {}) {
  const label = `${title} — ${artist}`;
  const t = spotifyClean(title);
  const a = spotifyClean(artist);

  const stages = [
    { method: 'strict', q: `track:"${t}" artist:"${a}"` },
    { method: 'fallback_loose', q: `${t} ${a}` },
  ];
  if (hasMultiArtist(artist)) {
    const first = spotifyClean(firstArtist(artist));
    if (first && first.toLowerCase() !== a.toLowerCase()) {
      stages.push({ method: 'fallback_first_artist', q: `${t} ${first}` });
    }
  }

  for (const stage of stages) {
    await sleep(SPOTIFY_STAGGER_MS); // stagger per attempt (one request per stage)
    const track = await spotifySearchQuery(stage.q, { label, onRetry });
    if (!track) continue;
    if (stage.method === 'strict') return { track, method: 'strict', score: null };
    // Fallback: guard against the wrong song slipping through.
    const acc = fallbackAccept(title, artist, track);
    if (acc.ok) return { track, method: stage.method, score: acc.score };
    // rejected -> try the next, looser stage
  }
  return { track: null, method: null, score: null };
}

// ===========================================================================
// ISRC pre-stage: get a cross-platform ISRC for free (no Spotify quota), then
// query Spotify by exact ISRC instead of fuzzy text -> more precise + fewer
// Spotify text searches on the hard songs.
//
// NOTE on iTunes: the iTunes Search API does NOT return an ISRC (verified live on
// guaranteed-present tracks), so it is deliberately NOT used as an ISRC source —
// it would cost one request per song for zero ISRC gain. Deezer's /search returns
// the `isrc` directly (undocumented but stable), so it is the one we use.
// ===========================================================================
// Deezer has NO documented rate limit, so we throttle conservatively via the
// shared sliding-window limiter (~2 req/s). This is deliberately slower per song
// than before, because we now make a SECOND call per matched track to fetch its
// release_date (verified live: /search returns `isrc` but NOT release_date; that
// lives on /track/{id}). "Lieber zu langsam als zu schnell."
const DEEZER_WINDOW_MS = 1000;
const DEEZER_MAX_PER_WINDOW = 2;
const DEEZER_CONCURRENCY = 5; // limiter serializes the actual rate anyway
const deezerLimiter = createRateLimiter(DEEZER_WINDOW_MS, DEEZER_MAX_PER_WINDOW);

// Light, NON-aggressive handling (timeout + rate-limiter + soft retries via the
// shared fetchSource). Any failure returns null so the caller simply falls
// through — Deezer is a best-effort accelerator, never a hard dependency.
async function deezerFetch(url) {
  try {
    const res = await fetchSource(url, {}, {
      rateLimiter: deezerLimiter,
      maxRetries: 2,
      backoffMs: 1500,
      label: 'Deezer',
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

/** Release year for a Deezer track id via /track/{id} (album.release_date). */
async function deezerYearForTrack(trackId) {
  if (!trackId) return null;
  const data = await deezerFetch(`https://api.deezer.com/track/${trackId}`);
  const date = (data && (data.release_date || (data.album && data.album.release_date))) || null;
  if (!date) return null;
  const y = parseInt(String(date).slice(0, 4), 10);
  return Number.isFinite(y) && y > 0 ? y : null;
}

/**
 * Deezer (free, unauthenticated) lookup. /search returns `isrc` per track; we
 * only trust a result that passes the similarity guard (artist + title), then do
 * a second /track/{id} call for the release year. Returns { isrc, year } or null.
 * (Extended from ISRC-only: it now also carries the year, analogous to mbYear.)
 */
async function getIsrcFromDeezer(title, artist) {
  const q = `${spotifyClean(title)} ${spotifyClean(artist)}`;
  const data = await deezerFetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=5`);
  const items = (data && data.data) || [];
  for (const it of items) {
    if (!it || !it.isrc) continue;
    const candArtists = [it.artist && it.artist.name].filter(Boolean);
    if (artistMatches(artist, candArtists) && titleMatch(title, it.title || '').ok) {
      const isrc = String(it.isrc).toUpperCase();
      const year = await deezerYearForTrack(it.id);
      return { isrc, year };
    }
  }
  return null;
}

/** tracks: [{title, artist}] -> (number|null)[] Deezer release year, for display. */
async function deezerVerifyYears(tracks) {
  const years = new Array(tracks.length).fill(null);
  for (let g = 0; g < tracks.length; g += DEEZER_CONCURRENCY) {
    const group = tracks.slice(g, g + DEEZER_CONCURRENCY).map((t, k) => ({ t, i: g + k }));
    await Promise.all(
      group.map(async ({ t, i }) => {
        const r = await getIsrcFromDeezer(t.title, t.artist).catch(() => null);
        years[i] = r ? r.year : null;
      })
    );
  }
  return years;
}

// ===========================================================================
// Discogs — third year source. Master-release `year` = earliest known release
// year (collector-curated), like MusicBrainz' first-release-date. Verified from
// the Discogs API docs: auth header is `Authorization: Discogs token=<TOKEN>`, a
// descriptive User-Agent is REQUIRED (else 403 risk), and /database/search takes
// type=master + artist + track. Optional source: no token -> silently skipped.
// Rate limit: 60/min authenticated -> we stay under at 50/min.
// ===========================================================================
const DISCOGS_BASE = 'https://api.discogs.com';
const DISCOGS_USER_AGENT = 'NickelBrandt-PoolImport/1.0 (+https://github.com/ArniMPunkt/NickelBrandt)';
const DISCOGS_CONCURRENCY = 5; // limiter serializes the actual rate
const discogsLimiter = createRateLimiter(60000, 50);

/**
 * Discogs master-release year for a song via GET /database/search
 * (type=master, artist, track). Takes the year of the first result that has one
 * (results are relevance-ordered). No similarity check, no type=release fallback
 * in this step. Returns the year or null (also null when DISCOGS_TOKEN is unset).
 */
/**
 * Discogs master candidate + artist plausibility. A master search result's
 * `title` is usually "Artist - Album" (no track title is exposed on master
 * results), so we artist-match on its leading part. Returns { year, reason }:
 * reason is null (ok), 'no_result', or 'artist_mismatch'. Uses DISCOGS_TOKEN if
 * set (60/min); otherwise unauthenticated (lower limit, but currently works).
 */
async function getDiscogsCandidate(title, artist) {
  const token = process.env.DISCOGS_TOKEN;
  const headers = { 'User-Agent': DISCOGS_USER_AGENT, Accept: 'application/json' };
  if (token) headers.Authorization = `Discogs token=${token}`;
  const params = new URLSearchParams({ type: 'master', artist, track: title, per_page: '5' });
  try {
    const res = await fetchSource(
      `${DISCOGS_BASE}/database/search?${params.toString()}`,
      { headers },
      { rateLimiter: discogsLimiter, maxRetries: 2, backoffMs: 2000, label: 'Discogs' }
    );
    if (!res.ok) return { year: null, reason: 'no_result' };
    const data = await res.json().catch(() => null);
    const results = (data && data.results) || [];
    let sawYear = false;
    for (const r of results) {
      const y = r && r.year != null ? parseInt(String(r.year).slice(0, 4), 10) : NaN;
      if (!(Number.isFinite(y) && y > 0)) continue;
      sawYear = true;
      const candArtist = String(r.title || '').split(' - ')[0]; // "Artist - Album"
      if (artistMatches(artist, [candArtist])) return { year: y, reason: null };
    }
    return { year: null, reason: sawYear ? 'artist_mismatch' : 'no_result' };
  } catch {
    return { year: null, reason: 'no_result' };
  }
}

/** Discogs master year (artist-plausibility-filtered) or null. */
async function getDiscogsYear(title, artist) {
  return (await getDiscogsCandidate(title, artist)).year;
}

/** tracks: [{title, artist}] -> (number|null)[] Discogs master year, for display. */
async function discogsVerifyYears(tracks) {
  const years = new Array(tracks.length).fill(null);
  for (let g = 0; g < tracks.length; g += DISCOGS_CONCURRENCY) {
    const group = tracks.slice(g, g + DISCOGS_CONCURRENCY).map((t, k) => ({ t, i: g + k }));
    await Promise.all(
      group.map(async ({ t, i }) => {
        years[i] = await getDiscogsYear(t.title, t.artist).catch(() => null);
      })
    );
  }
  return years;
}

// ===========================================================================
// MusicBrainz-first year consensus (TEST-ONLY prep — NOT wired into final_year).
// MB is the primary trust anchor when its match is PLAUSIBLE (right artist/title,
// not a live/remaster/cover/karaoke/tribute variant). Deezer/Discogs only confirm
// or WARN: a plausible source more than 1 year EARLIER than MB flags a review;
// they never overrule MB. ±1 year is treated as agreement.
// ===========================================================================
// NOTE: deliberately NOT "edit"/"single version"/"radio edit" — those are the same
// release year as the original, so excluding them only creates false review cases.
const MB_VARIANT_RE =
  /\b(live|remaster(ed)?|karaoke|tribute|cover|acoustic|instrumental|demo|re-?recorded|rerecord(ed)?|made famous by|session)\b/i;
function hasVariantMarker(text) {
  return MB_VARIANT_RE.test(String(text || ''));
}

/**
 * MusicBrainz candidate WITH plausibility. Prefers the ISRC lookup (returns the
 * exact recording), falling back to a title/artist text search when no ISRC —
 * the text search is noisy for heavily-bootlegged songs (see the SLTS diagnosis:
 * its top results are almost all live recordings, and the studio original may not
 * even appear). Plausibility = artist-credit matches, title matches, and neither
 * title nor disambiguation carries a live/remaster/cover/karaoke/tribute marker.
 *
 * Returns { status, year, recordingId, artistCredit, title, firstReleaseDate,
 * disambiguation, reason }. status: 'mb_ok' | 'mb_match_uncertain' | 'mb_no_match'.
 */
function recToCand(rec) {
  return {
    recordingId: rec.id,
    title: rec.title || '',
    artistCredit: (rec['artist-credit'] || []).map((a) => a.name).join(', '),
    firstReleaseDate: rec['first-release-date'] || '',
    year: mbYearFromDate(rec['first-release-date']),
    disambiguation: rec.disambiguation || '',
  };
}

/** Apply the plausibility filter to a set of MB recordings -> candidate result. */
function pickPlausible(title, artist, recs) {
  if (!recs || !recs.length) return { status: 'mb_no_match', year: null, reason: 'no_recording' };
  const cands = recs.map(recToCand);
  const artistTitleOk = (c) => artistMatches(artist, [c.artistCredit]) && titleMatch(title, c.title).ok;
  const plausible = cands.filter(
    (c) => artistTitleOk(c) && !hasVariantMarker(`${c.title} ${c.disambiguation}`)
  );
  if (!plausible.length) {
    return {
      status: 'mb_match_uncertain',
      ...cands[0],
      reason: cands.some(artistTitleOk) ? 'live_or_variant_only' : 'artist_or_title_mismatch',
    };
  }
  const withYear = plausible.filter((c) => c.year != null);
  if (!withYear.length) return { status: 'mb_match_uncertain', ...plausible[0], reason: 'no_year' };
  // Earliest first-release-date among plausible = the original.
  const chosen = withYear.sort((a, b) => a.year - b.year)[0];
  return { status: 'mb_ok', ...chosen, reason: null };
}

/** Single-song candidate (ISRC or text). Used for one-off lookups (e.g. tests). */
async function mbCandidate(title, artist, isrc) {
  let recs = [];
  if (isrc) {
    const d = await mbFetch(
      `${MB_BASE}/recording?query=isrc:${encodeURIComponent(isrc)}&fmt=json&limit=10`
    ).catch(() => null);
    recs = (d && d.recordings) || [];
  }
  if (!recs.length) {
    const q = `recording:"${mbEscapeLucene(title)}" AND artist:"${mbEscapeLucene(artist)}"`;
    const d = await mbFetch(
      `${MB_BASE}/recording?query=${encodeURIComponent(q)}&fmt=json&limit=15`
    ).catch(() => null);
    recs = (d && d.recordings) || [];
  }
  return pickPlausible(title, artist, recs);
}

/** ISRCs -> Map(ISRC -> recording), earliest first-release-date wins per ISRC. */
async function mbIsrcRecordingBatch(isrcs) {
  const out = new Map();
  if (!isrcs.length) return out;
  const wanted = new Set(isrcs.map((s) => s.toUpperCase()));
  const q = isrcs.map((c) => `isrc:${c}`).join(' OR ');
  let data;
  try {
    data = await mbFetch(`${MB_BASE}/recording?query=${encodeURIComponent(q)}&fmt=json&limit=100`);
  } catch {
    return out;
  }
  for (const rec of (data && data.recordings) || []) {
    for (const isrc of rec.isrcs || []) {
      const key = String(isrc).toUpperCase();
      if (!wanted.has(key)) continue;
      const prev = out.get(key);
      if (!prev) out.set(key, rec);
      else {
        const py = mbYearFromDate(prev['first-release-date']);
        const cy = mbYearFromDate(rec['first-release-date']);
        if (cy != null && (py == null || cy < py)) out.set(key, rec);
      }
    }
  }
  return out;
}

/**
 * Batch MB candidate pass — restores the fast path. ISRC rows go through batched
 * OR-queries (MB_ISRC_BATCH per request, MB_CONCURRENCY in parallel); the
 * plausibility fields (artist-credit, title, disambiguation, first-release-date)
 * all come back IN the batch response (verified), so no per-song follow-up. Only
 * no-ISRC / ISRC-miss rows fall back to a per-song text search.
 */
async function mbCandidatesBatch(tracks) {
  const out = new Array(tracks.length).fill(null);
  const withIsrc = [];
  const withoutIsrc = [];
  tracks.forEach((t, i) => (t.isrc ? withIsrc : withoutIsrc).push(i));

  const batches = [];
  for (let k = 0; k < withIsrc.length; k += MB_ISRC_BATCH) batches.push(withIsrc.slice(k, k + MB_ISRC_BATCH));
  const isrcMisses = [];
  for (let g = 0; g < batches.length; g += MB_CONCURRENCY) {
    const group = batches.slice(g, g + MB_CONCURRENCY);
    await Promise.all(
      group.map(async (idxs) => {
        const recMap = await mbIsrcRecordingBatch(idxs.map((i) => tracks[i].isrc));
        for (const i of idxs) {
          const rec = recMap.get(String(tracks[i].isrc).toUpperCase());
          if (!rec) {
            isrcMisses.push(i);
            continue;
          }
          out[i] = pickPlausible(tracks[i].title, tracks[i].artist, [rec]);
        }
      })
    );
  }

  const fallback = [...withoutIsrc, ...isrcMisses];
  for (let s = 0; s < fallback.length; s += MB_CONCURRENCY) {
    const group = fallback.slice(s, s + MB_CONCURRENCY);
    await Promise.all(
      group.map(async (i) => {
        out[i] = await mbCandidate(tracks[i].title, tracks[i].artist, null);
      })
    );
  }
  return out;
}

/**
 * MB-first consensus over the already-plausibility-filtered years. mbStatus comes
 * from mbCandidate; deezerYear/discogsYear are null when their own plausibility
 * filter rejected the match. Returns { status, chosen, earlier? }.
 *   mb_no_match / mb_match_uncertain        -> chosen null (always a review case)
 *   any other source >1yr earlier than MB   -> review_needed_other_source_earlier
 *   MB earliest-or-equal to both            -> mb_anchor_ok, chosen = mbYear
 *   only a ±1 difference, no >1yr-earlier    -> minor_difference, chosen = mbYear
 */
function yearConsensus({ mbStatus, mbYear, deezerYear, discogsYear }) {
  if (mbStatus === 'mb_no_match') return { status: 'mb_no_match', chosen: null };
  if (mbStatus === 'mb_match_uncertain') return { status: 'mb_match_uncertain', chosen: null };
  const others = [
    ['deezer', deezerYear],
    ['discogs', discogsYear],
  ].filter(([, y]) => y != null);
  const earlier = others.filter(([, y]) => mbYear - y > 1);
  if (earlier.length) {
    return {
      status: 'review_needed_other_source_earlier',
      chosen: null,
      earlier: earlier.map(([s]) => s),
    };
  }
  if (others.every(([, y]) => y >= mbYear)) return { status: 'mb_anchor_ok', chosen: mbYear };
  return { status: 'minor_difference', chosen: mbYear };
}

/** Human-readable notes for the review CSV, from the per-source outcomes. */
function buildNotes(mb, deezerYear, discogsYear, discogsReason, con) {
  const n = [];
  if (mb.status === 'mb_no_match') n.push('mb_no_match');
  else if (mb.status === 'mb_match_uncertain') n.push(mb.reason || 'mb_match_uncertain');
  if (deezerYear == null) n.push('deezer:no_year');
  if (discogsReason === 'skipped_deezer_confirmed') n.push('discogs skipped (deezer confirmed)');
  else if (discogsReason) n.push(`discogs:${discogsReason}`);
  if (con.earlier) n.push(`earlier:${con.earlier.join('+')}`);
  return n.join('; ');
}

// ===========================================================================
// Credits.fm — PRIMARY ISRC source (free, no auth). POST /v1/resolve/batch with
// {tracks:[{name,artist}]} (NOTE: input key is `name`, not `title`). Response:
// {total,resolved,results:[{credits_id,name,artist,isrc,credits_url}]}, positional.
//
// VERIFIED LIVE — Credits.fm resolves ASYNCHRONOUSLY: the first request for an
// unseen track returns isrc:null and kicks off a background lookup; a re-query a
// few seconds later returns the cached ISRC. So we warm up + RE-POLL the still-
// unresolved subset for a few rounds. Each accepted ISRC is similarity-checked.
//
// Rate limit: 30/min without a key. We batch 50/request + stagger, so even a
// 250-song pool needs only ~10-15 requests -> well under the cap. (A free key
// raises this to 300/min; not needed at this scale — see summary.)
// ===========================================================================
const CREDITS_URL = 'https://api.credits.fm/v1/resolve/batch';
const CREDITS_BATCH = 50;
const CREDITS_STAGGER_MS = 2200; // <= ~27 req/min, under the 30/min no-key cap
const CREDITS_RETRY_ROUNDS = 3; // async cache: re-poll unresolved tracks
const CREDITS_RETRY_DELAY_MS = 3000;

let _creditsLast = 0;
async function creditsThrottle() {
  const wait = CREDITS_STAGGER_MS - (Date.now() - _creditsLast);
  if (wait > 0) await sleep(wait);
  _creditsLast = Date.now();
}

/** POST one batch (<=50 {name,artist}); returns the positional results array or null. */
async function creditsFetchBatch(tracks) {
  for (let attempt = 0; attempt <= 2; attempt++) {
    await creditsThrottle();
    let res;
    try {
      res = await fetchWithTimeout(CREDITS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks }),
      });
    } catch {
      if (attempt < 2) {
        await sleep(2000);
        continue;
      }
      return null;
    }
    if (res.status === 429) {
      if (attempt < 2) {
        await sleep(5000);
        continue;
      }
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return (data && data.results) || null;
  }
  return null;
}

/**
 * Batch-resolve ISRCs for all inputs via Credits.fm. Returns an array
 * index -> ISRC (or null). Re-polls the unresolved subset for a few rounds to
 * handle the async-cache behaviour. Every accepted ISRC passes the similarity
 * guard (Credits.fm aggregates multiple sources; an ISRC can be ambiguous).
 */
async function creditsBatchResolve(inputs, onProgress) {
  const isrcByIndex = new Array(inputs.length).fill(null);
  let pending = inputs.map((_, i) => i);
  for (let round = 0; round <= CREDITS_RETRY_ROUNDS && pending.length; round++) {
    if (round > 0) await sleep(CREDITS_RETRY_DELAY_MS); // let background lookups finish
    const next = [];
    for (let s = 0; s < pending.length; s += CREDITS_BATCH) {
      const chunk = pending.slice(s, s + CREDITS_BATCH);
      const tracks = chunk.map((i) => ({ name: inputs[i].title, artist: inputs[i].artist }));
      const results = await creditsFetchBatch(tracks);
      if (!results) {
        next.push(...chunk); // hard fail -> retry in a later round
        continue;
      }
      chunk.forEach((i, k) => {
        const r = results[k];
        if (r && r.isrc) {
          if (
            artistMatches(inputs[i].artist, [r.artist].filter(Boolean)) &&
            titleMatch(inputs[i].title, r.name || '').ok
          ) {
            isrcByIndex[i] = String(r.isrc).toUpperCase(); // accepted
          }
          // resolved but failed similarity -> reject silently (don't re-poll)
        } else {
          next.push(i); // not resolved yet -> re-poll next round
        }
      });
    }
    pending = next;
    if (onProgress) onProgress(isrcByIndex.filter(Boolean).length, inputs.length, round);
  }
  return isrcByIndex;
}

/** Look up a Spotify track by exact ISRC; similarity-checked. -> {track,method,score} or null. */
async function spotifyByIsrc(isrc, title, artist, method, onRetry) {
  await sleep(SPOTIFY_STAGGER_MS);
  const track = await spotifySearchQuery(`isrc:${isrc}`, {
    label: `${title} — ${artist} [${method}]`,
    onRetry,
  });
  if (track) {
    const acc = fallbackAccept(title, artist, track); // safety net (ISRCs can be ambiguous)
    if (acc.ok) return { track, method, score: acc.score };
  }
  return null;
}

/**
 * Resolve ONE song to a Spotify match via a clear, sequential chain:
 *   1) Credits.fm ISRC (from the batch pre-pass) -> Spotify by ISRC  [creditsfm_isrc]
 *   2) Deezer ISRC (per song)                    -> Spotify by ISRC  [deezer_isrc]
 *   3) Spotify text search (strict -> loose -> first_artist)         [last resort]
 * Each ISRC route is similarity-checked; on a miss we fall to the next step.
 */
async function resolveOne(title, artist, creditsfmIsrc, { onRetry } = {}) {
  if (creditsfmIsrc) {
    const hit = await spotifyByIsrc(creditsfmIsrc, title, artist, 'creditsfm_isrc', onRetry);
    if (hit) return hit;
  }
  let dz = null;
  try {
    dz = await getIsrcFromDeezer(title, artist);
  } catch {
    dz = null; // Deezer hiccup -> fall through, never block the run
  }
  if (dz && dz.isrc) {
    const hit = await spotifyByIsrc(dz.isrc, title, artist, 'deezer_isrc', onRetry);
    if (hit) return hit;
  }
  return searchWithFallbacks(title, artist, { onRetry });
}

// ===========================================================================
// MusicBrainz year verification — slim copy of src/services/musicbrainz.ts
// ===========================================================================
const MB_BASE = 'https://musicbrainz.org/ws/2';
// TODO(contact): swap the GitHub URL for a monitored contact email before wider use.
const MB_USER_AGENT = 'NickelBrandt-PoolImport/1.0 ( https://github.com/ArniMPunkt/NickelBrandt )';
const MB_WINDOW_MS = 18000;
const MB_MAX_PER_WINDOW = 13; // ~13% under the official 15/18s
const MB_CONCURRENCY = 5;
const MB_ISRC_BATCH = 12;
const MB_MAX_RETRIES = 2;
const MB_BACKOFF_MS = 2500;

const mbLimiter = createRateLimiter(MB_WINDOW_MS, MB_MAX_PER_WINDOW);

async function mbFetch(url) {
  let lastErr;
  for (let attempt = 0; attempt <= MB_MAX_RETRIES; attempt++) {
    await mbLimiter.acquire();
    let res;
    try {
      res = await fetchWithTimeout(url, { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } });
    } catch (e) {
      lastErr = e;
      if (attempt < MB_MAX_RETRIES) {
        await sleep(MB_BACKOFF_MS);
        continue;
      }
      throw lastErr;
    }
    if (res.status === 503) {
      lastErr = new Error('MusicBrainz 503');
      if (attempt < MB_MAX_RETRIES) {
        await sleep(MB_BACKOFF_MS);
        continue;
      }
      throw lastErr;
    }
    if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
    return res.json();
  }
  throw lastErr ?? new Error('MusicBrainz request failed');
}

function mbYearFromDate(date) {
  if (!date) return null;
  const y = parseInt(String(date).slice(0, 4), 10);
  return Number.isFinite(y) && y > 0 ? y : null;
}

function mbEarliestYear(recordings) {
  let best = null;
  for (const rec of recordings ?? []) {
    const y = mbYearFromDate(rec && rec['first-release-date']);
    if (y != null && (best == null || y < best)) best = y;
  }
  return best;
}

const mbEscapeLucene = (s) => s.replace(/["\\]/g, ' ').trim();

async function mbIsrcBatch(isrcs) {
  const out = new Map();
  if (isrcs.length === 0) return out;
  const wanted = new Set(isrcs.map((s) => s.toUpperCase()));
  const q = isrcs.map((c) => `isrc:${c}`).join(' OR ');
  let data;
  try {
    data = await mbFetch(`${MB_BASE}/recording?query=${encodeURIComponent(q)}&fmt=json&limit=100`);
  } catch {
    return out;
  }
  for (const rec of (data && data.recordings) ?? []) {
    const y = mbYearFromDate(rec && rec['first-release-date']);
    if (y == null) continue;
    for (const isrc of (rec && rec.isrcs) ?? []) {
      const key = String(isrc).toUpperCase();
      if (!wanted.has(key)) continue;
      const prev = out.get(key);
      if (prev == null || y < prev) out.set(key, y);
    }
  }
  return out;
}

async function mbResolveByTitleArtist(title, artist) {
  try {
    const q = `recording:"${mbEscapeLucene(title)}" AND artist:"${mbEscapeLucene(artist)}"`;
    const data = await mbFetch(`${MB_BASE}/recording?query=${encodeURIComponent(q)}&fmt=json&limit=10`);
    return mbEarliestYear(data && data.recordings);
  } catch {
    return null;
  }
}

/** tracks: [{title, artist, isrc}] -> (number|null)[] (raw MusicBrainz year). */
async function mbVerifyYears(tracks) {
  const years = new Array(tracks.length).fill(null);
  const withIsrc = [];
  const withoutIsrc = [];
  tracks.forEach((t, i) => (t.isrc ? withIsrc : withoutIsrc).push(i));

  const batches = [];
  for (let k = 0; k < withIsrc.length; k += MB_ISRC_BATCH) {
    batches.push(withIsrc.slice(k, k + MB_ISRC_BATCH));
  }
  const isrcMisses = [];
  for (let g = 0; g < batches.length; g += MB_CONCURRENCY) {
    const group = batches.slice(g, g + MB_CONCURRENCY);
    await Promise.all(
      group.map(async (idxs) => {
        const map = await mbIsrcBatch(idxs.map((i) => tracks[i].isrc));
        for (const i of idxs) {
          const y = map.get(String(tracks[i].isrc).toUpperCase());
          if (y != null) years[i] = y;
          else isrcMisses.push(i);
        }
      })
    );
  }

  const fallback = [...withoutIsrc, ...isrcMisses];
  for (let s = 0; s < fallback.length; s += MB_CONCURRENCY) {
    const group = fallback.slice(s, s + MB_CONCURRENCY);
    await Promise.all(
      group.map(async (i) => {
        years[i] = await mbResolveByTitleArtist(tracks[i].title, tracks[i].artist);
      })
    );
  }
  return years;
}

// ===========================================================================
// High-level orchestration: Spotify search (sequential) + MusicBrainz years
// ===========================================================================
/**
 * Verify a list of {title, artist, estimatedYear} inputs.
 * Returns { results, stats }:
 *   results[]: { input, spotifyFound, trackId, spName, spArtist, isrc, mbYear, failed }
 *     - mbYear: RAW MusicBrainz year (number) or null (no MB hit).
 *     - failed: true when the Spotify request itself errored (e.g. 429 after all
 *       retries / network) — distinct from "found no match". No dedup; every input
 *       is kept.
 *   stats: { retried, failed[] } for the summary.
 */
async function verifySongs(inputs, opts = {}) {
  const onSpotify = opts.onSpotify || (() => {});
  const onPhase = opts.onPhase || (() => {});
  const results = new Array(inputs.length);
  const stats = { retried: 0, failed: [] };
  const tResolveStart = Date.now();

  // Fast-path rows already carry BOTH a Spotify track id and an ISRC (playlist
  // imports). They skip the whole resolver chain (no Credits.fm / Deezer / Spotify
  // search, no similarity check) and trust the given id+ISRC. The MusicBrainz year
  // check below still runs for them, so the year is verified, not blindly taken.
  const isFast = inputs.map((row) => !!(row.spotifyTrackId && row.isrc));
  const fullPositions = [];
  inputs.forEach((_, i) => {
    if (!isFast[i]) fullPositions.push(i);
  });
  const fullInputs = fullPositions.map((i) => inputs[i]);
  const origToFull = new Map(fullPositions.map((origI, k) => [origI, k]));

  // --- Phase A: Credits.fm batch ISRC pre-pass — ONLY for full-chain rows.
  let creditsIsrcFull = [];
  if (fullInputs.length > 0) {
    onPhase('credits-start', { total: fullInputs.length });
    creditsIsrcFull = await creditsBatchResolve(fullInputs, (resolved, total, round) =>
      onPhase('credits-progress', { resolved, total, round })
    );
    onPhase('credits-done', { resolved: creditsIsrcFull.filter(Boolean).length, total: fullInputs.length });
  }

  // --- Phase B: per-song. Fast-path rows are filled directly; the rest run the
  //     full chain (Credits ISRC -> Deezer ISRC -> Spotify text).
  for (let i = 0; i < inputs.length; i++) {
    const row = inputs[i];

    if (isFast[i]) {
      const r = {
        input: row,
        spotifyFound: true,
        trackId: row.spotifyTrackId,
        spName: row.title,
        spArtist: row.artist,
        isrc: row.isrc,
        mbYear: null,
        deezerYear: null,
        discogsYear: null,
        failed: false,
        matchMethod: 'playlist_import',
        similarityScore: null,
      };
      results[i] = r;
      onSpotify(i + 1, inputs.length, row, r, null, false);
      continue;
    }

    let track = null;
    let method = null;
    let score = null;
    let err = null;
    let retriedThisSong = false;
    try {
      const res = await resolveOne(row.title, row.artist, creditsIsrcFull[origToFull.get(i)], {
        onRetry: () => {
          retriedThisSong = true;
        },
      });
      track = res.track;
      method = res.method;
      score = res.score;
    } catch (e) {
      if (e && e.penalty) throw e; // hard cooldown -> abort the whole run
      err = e;
    }
    if (retriedThisSong) stats.retried += 1;
    const failed = !!err; // request failed (couldn't verify), not just "no match"
    if (failed) stats.failed.push({ title: row.title, artist: row.artist });

    const r = track
      ? {
          input: row,
          spotifyFound: true,
          trackId: track.id,
          spName: track.name,
          spArtist: track.artists && track.artists[0] ? track.artists[0].name : row.artist,
          isrc: (track.external_ids && track.external_ids.isrc) || null,
          mbYear: null,
          deezerYear: null,
          discogsYear: null,
          failed: false,
          matchMethod: method,
          similarityScore: score,
        }
      : {
          input: row,
          spotifyFound: false,
          trackId: null,
          spName: null,
          spArtist: null,
          isrc: null,
          mbYear: null,
          deezerYear: null,
          discogsYear: null,
          failed,
          matchMethod: null,
          similarityScore: null,
        };
    results[i] = r;
    onSpotify(i + 1, inputs.length, row, r, err, retriedThisSong);
    // Stagger now happens per attempt inside searchWithFallbacks (rate-limit aware).
  }

  const resolveMs = Date.now() - tResolveStart;

  // ===== Year consensus (MusicBrainz-anchored) for the Spotify-found rows =====
  const foundIdx = results.map((r, i) => (r.spotifyFound ? i : -1)).filter((i) => i >= 0);
  const tracks = foundIdx.map((i) => ({
    title: results[i].spName || results[i].input.title,
    artist: results[i].spArtist || results[i].input.artist,
    isrc: results[i].isrc,
  }));

  // MB-batch pass + Deezer pass run CONCURRENTLY (own rate limiters), so neither
  // waits for the other to fully finish. Each is timed independently (they overlap,
  // so the wall-clock cost of this stage is ~max(mbMs, deezerMs), not the sum).
  let mbMs = 0;
  let deezerMs = 0;
  const [mbCands, dzYears] = await Promise.all([
    (async () => {
      const s = Date.now();
      const r = await mbCandidatesBatch(tracks);
      mbMs = Date.now() - s;
      return r;
    })(),
    (async () => {
      const s = Date.now();
      const r = await deezerVerifyYears(tracks);
      deezerMs = Date.now() - s;
      return r;
    })(),
  ]);

  // Discogs ONLY when Deezer doesn't already settle it: MB plausible AND
  // (Deezer missing OR Deezer >1yr earlier than MB). Otherwise skip (Deezer
  // confirms MB / equal / later). mb-not-ok rows are review cases regardless.
  const dcYear = new Array(tracks.length).fill(null);
  const dcReason = new Array(tracks.length).fill(null);
  const needIdx = [];
  tracks.forEach((_, j) => {
    const mb = mbCands[j] || { status: 'mb_no_match' };
    if (mb.status !== 'mb_ok' || mb.year == null) return;
    const dz = dzYears[j];
    if (dz != null && mb.year - dz <= 1) {
      dcReason[j] = 'skipped_deezer_confirmed';
      return;
    }
    needIdx.push(j);
  });
  const tDc = Date.now();
  for (let s = 0; s < needIdx.length; s += DISCOGS_CONCURRENCY) {
    const grp = needIdx.slice(s, s + DISCOGS_CONCURRENCY);
    await Promise.all(
      grp.map(async (j) => {
        const c = await getDiscogsCandidate(tracks[j].title, tracks[j].artist).catch(() => ({ year: null, reason: 'no_result' }));
        dcYear[j] = c.year;
        dcReason[j] = c.reason;
      })
    );
  }
  const discogsMs = Date.now() - tDc;

  // Consensus + notes per found row.
  foundIdx.forEach((i, j) => {
    const mb = mbCands[j] || { status: 'mb_no_match', year: null, reason: 'no_recording' };
    const dz = dzYears[j];
    const dc = dcYear[j];
    const con = yearConsensus({ mbStatus: mb.status, mbYear: mb.year, deezerYear: dz, discogsYear: dc });
    results[i].mbYear = mb.year != null ? mb.year : null;
    results[i].mbStatus = mb.status;
    results[i].mbRecordingId = mb.recordingId || null;
    results[i].mbDisambiguation = mb.disambiguation || '';
    results[i].deezerYear = dz;
    results[i].discogsYear = dc;
    results[i].consensusStatus = con.status;
    results[i].chosenYear = con.chosen;
    results[i].notes = buildNotes(mb, dz, dc, dcReason[j], con);
  });

  stats.timings = {
    resolveMs,
    mbMs,
    deezerMs,
    discogsMs,
    discogsCalls: needIdx.length,
    discogsSkipped: tracks.length - needIdx.length,
  };
  return { results, stats };
}

module.exports = {
  readInputCsv,
  resolveOne,
  searchWithFallbacks,
  getIsrcFromDeezer,
  creditsBatchResolve,
  mbVerifyYears,
  verifySongs,
  computeRetryWaitS,
  fetchWithRetry,
  // Year-consensus prep (test-only; not wired into final_year yet):
  mbCandidate,
  getDiscogsCandidate,
  getDiscogsYear,
  hasVariantMarker,
  yearConsensus,
};
