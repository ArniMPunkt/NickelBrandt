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

/**
 * Search a track by title + artist; returns the top match object or null.
 * 429s are handled by fetchWithRetry; the small outer loop only handles a 401
 * (expired token -> refresh once). `onRetry` is forwarded so the caller can count
 * songs that needed a rate-limit wait. Throws (with .rateLimited) if 429 persists.
 */
async function spotifySearch(title, artist, { onRetry } = {}) {
  const q = `track:"${spotifyClean(title)}" artist:"${spotifyClean(artist)}"`;
  const url = `https://api.spotify.com/v1/search?type=track&limit=5&q=${encodeURIComponent(q)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getSpotifyToken();
    const res = await fetchWithRetry(
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      { label: `${title} — ${artist}`, onRetry }
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

// ===========================================================================
// MusicBrainz year verification — slim copy of src/services/musicbrainz.ts
// ===========================================================================
const MB_BASE = 'https://musicbrainz.org/ws/2';
const MB_USER_AGENT = 'NickelBrandt-PoolImport/1.0 ( kontakt@beispiel.de )';
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
  const results = [];
  const stats = { retried: 0, failed: [] };
  for (let i = 0; i < inputs.length; i++) {
    const row = inputs[i];
    let track = null;
    let err = null;
    let retriedThisSong = false;
    try {
      track = await spotifySearch(row.title, row.artist, {
        onRetry: () => {
          retriedThisSong = true;
        },
      });
    } catch (e) {
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
        };
    results.push(r);
    onSpotify(i + 1, inputs.length, row, r, err, retriedThisSong);
    await sleep(SPOTIFY_STAGGER_MS);
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

module.exports = { readInputCsv, spotifySearch, mbVerifyYears, verifySongs, computeRetryWaitS };
