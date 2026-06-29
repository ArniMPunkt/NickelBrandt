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
  const idx = hasHeader
    ? {
        title: header.indexOf('title'),
        artist: header.indexOf('artist'),
        year: header.findIndex((h) => h.includes('year')),
      }
    : { title: 0, artist: 1, year: 2 };
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const out = [];
  for (const r of dataRows) {
    const title = (r[idx.title] ?? '').trim();
    const artist = (r[idx.artist] ?? '').trim();
    const yearRaw = idx.year >= 0 ? (r[idx.year] ?? '').trim() : '';
    const estimatedYear = /^\d{4}$/.test(yearRaw) ? parseInt(yearRaw, 10) : null;
    if (!title || !artist) continue;
    out.push({ title, artist, estimatedYear });
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
const DEEZER_STAGGER_MS = 300; // ~3 req/s; Deezer tolerates ~50/5s. Own throttle.
let _deezerLast = 0;
async function deezerThrottle() {
  const wait = DEEZER_STAGGER_MS - (Date.now() - _deezerLast);
  if (wait > 0) await sleep(wait);
  _deezerLast = Date.now();
}

// Light, NON-aggressive handling (timeout + a couple of soft retries). Any
// failure returns null so the caller simply falls through to the Spotify text
// search — Deezer is a best-effort accelerator, never a hard dependency.
async function deezerFetch(url) {
  for (let attempt = 0; attempt <= 2; attempt++) {
    await deezerThrottle();
    let res;
    try {
      res = await fetchWithTimeout(url);
    } catch {
      if (attempt < 2) {
        await sleep(1500);
        continue;
      }
      return null;
    }
    if (res.status === 429) {
      if (attempt < 2) {
        await sleep(2000);
        continue;
      }
      return null;
    }
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }
  return null;
}

/**
 * Deezer (free, unauthenticated) ISRC source. /search returns `isrc` on each
 * track, so one request gives a cross-platform ISRC. We only trust a result that
 * passes the same similarity guard (artist + title). Returns the ISRC or null.
 */
async function getIsrcFromDeezer(title, artist) {
  const q = `${spotifyClean(title)} ${spotifyClean(artist)}`;
  const data = await deezerFetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=5`);
  const items = (data && data.data) || [];
  for (const it of items) {
    if (!it || !it.isrc) continue;
    const candArtists = [it.artist && it.artist.name].filter(Boolean);
    if (artistMatches(artist, candArtists) && titleMatch(title, it.title || '').ok) {
      return String(it.isrc).toUpperCase();
    }
  }
  return null;
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
  if (dz) {
    const hit = await spotifyByIsrc(dz, title, artist, 'deezer_isrc', onRetry);
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

const mbRequestTimes = [];
async function mbAcquireSlot() {
  for (;;) {
    const now = Date.now();
    while (mbRequestTimes.length && now - mbRequestTimes[0] >= MB_WINDOW_MS) {
      mbRequestTimes.shift();
    }
    if (mbRequestTimes.length < MB_MAX_PER_WINDOW) {
      mbRequestTimes.push(now);
      return;
    }
    await sleep(MB_WINDOW_MS - (now - mbRequestTimes[0]) + 20);
  }
}

async function mbFetch(url) {
  let lastErr;
  for (let attempt = 0; attempt <= MB_MAX_RETRIES; attempt++) {
    await mbAcquireSlot();
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
  const results = [];
  const stats = { retried: 0, failed: [] };

  // --- Phase A: Credits.fm batch ISRC pre-pass (primary source, no Spotify quota).
  onPhase('credits-start', { total: inputs.length });
  const creditsIsrc = await creditsBatchResolve(inputs, (resolved, total, round) =>
    onPhase('credits-progress', { resolved, total, round })
  );
  onPhase('credits-done', { resolved: creditsIsrc.filter(Boolean).length, total: inputs.length });

  // --- Phase B: per-song resolution (Credits ISRC -> Deezer ISRC -> Spotify text).
  for (let i = 0; i < inputs.length; i++) {
    const row = inputs[i];
    let track = null;
    let method = null;
    let score = null;
    let err = null;
    let retriedThisSong = false;
    try {
      const res = await resolveOne(row.title, row.artist, creditsIsrc[i], {
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
          failed,
          matchMethod: null,
          similarityScore: null,
        };
    results.push(r);
    onSpotify(i + 1, inputs.length, row, r, err, retriedThisSong);
    // Stagger now happens per attempt inside searchWithFallbacks (rate-limit aware).
  }

  // MusicBrainz year check for the Spotify-found rows.
  const foundIdx = results.map((r, i) => (r.spotifyFound ? i : -1)).filter((i) => i >= 0);
  const tracks = foundIdx.map((i) => ({
    title: results[i].spName || results[i].input.title,
    artist: results[i].spArtist || results[i].input.artist,
    isrc: results[i].isrc,
  }));
  const years = await mbVerifyYears(tracks);
  foundIdx.forEach((i, j) => {
    results[i].mbYear = years[j];
  });
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
};
