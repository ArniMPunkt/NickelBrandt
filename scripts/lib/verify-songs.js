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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const SPOTIFY_STAGGER_MS = 150;

let _tok = { value: null, exp: 0 };
async function getSpotifyToken() {
  if (_tok.value && Date.now() < _tok.exp - 60000) return _tok.value;
  const id = need('SPOTIFY_CLIENT_ID');
  const secret = need('SPOTIFY_CLIENT_SECRET');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify token request failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  _tok = { value: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return _tok.value;
}

const spotifyClean = (s) => s.replace(/"/g, ' ').trim();

/** Search a track by title + artist; returns the top match object or null. */
async function spotifySearch(title, artist) {
  const q = `track:"${spotifyClean(title)}" artist:"${spotifyClean(artist)}"`;
  const url = `https://api.spotify.com/v1/search?type=track&limit=5&q=${encodeURIComponent(q)}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = await getSpotifyToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      _tok = { value: null, exp: 0 };
      continue;
    }
    if (res.status === 429) {
      const ra = parseInt(res.headers.get('retry-after') || '2', 10);
      await sleep((ra + 1) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Spotify search failed ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data?.tracks?.items ?? [])[0] ?? null;
  }
  throw new Error('Spotify search failed after retries (rate limit / auth).');
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
      res = await fetch(url, { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } });
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
 * Returns one result per input (order preserved):
 *   { input, spotifyFound, trackId, spName, spArtist, isrc, mbYear }
 * where mbYear is the RAW MusicBrainz year (number) or null (no MB hit). The
 * caller decides any csv-estimate fallback. No dedup here — every input is kept.
 */
async function verifySongs(inputs, opts = {}) {
  const onSpotify = opts.onSpotify || (() => {});
  const results = [];
  for (let i = 0; i < inputs.length; i++) {
    const row = inputs[i];
    let track = null;
    let err = null;
    try {
      track = await spotifySearch(row.title, row.artist);
    } catch (e) {
      err = e;
    }
    const r = track
      ? {
          input: row,
          spotifyFound: true,
          trackId: track.id,
          spName: track.name,
          spArtist: track.artists && track.artists[0] ? track.artists[0].name : row.artist,
          isrc: (track.external_ids && track.external_ids.isrc) || null,
          mbYear: null,
        }
      : { input: row, spotifyFound: false, trackId: null, spName: null, spArtist: null, isrc: null, mbYear: null };
    results.push(r);
    onSpotify(i + 1, inputs.length, row, r, err);
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
  return results;
}

module.exports = { readInputCsv, spotifySearch, mbVerifyYears, verifySongs };
