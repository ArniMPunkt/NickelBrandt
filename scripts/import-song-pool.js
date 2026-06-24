/**
 * NickelBrandt — one-off song-pool import / verification script.
 *
 * ⚠️ DEPRECATED / DO NOT USE FOR NEW POOLS. This single-pass script verifies AND
 * writes to the DB in one go, which proved too unsafe (wrong years slipped in
 * before they could be reviewed). It is superseded by the two-stage process:
 *   1) scripts/precheck-song-pool.js  -> verify only, write a local review CSV
 *   2) scripts/upload-song-pool.js    -> upload the reviewed CSV to the DB
 * Kept here only for reference. Use the two scripts above instead.
 *
 * Takes a CSV of rough song suggestions, verifies each against Spotify (does the
 * track exist? what is its id + ISRC?), re-checks the real release year against
 * MusicBrainz, and writes the verified rows into Supabase (song_pools +
 * pool_songs). Run locally by hand, once per new themed pool. It is NOT part of
 * the app bundle and has no app-runtime integration.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 *   node scripts/import-song-pool.js <csvPath> "<Pool Name>" "<Description>"
 *
 *   e.g.
 *   node scripts/import-song-pool.js ./scripts/pop70-90.csv "Pop 70er-90er" "Pop-Hits von 1970 bis 1999"
 *
 * CSV columns (header row optional; if absent, positional order is assumed):
 *   title,artist,estimated_year
 *
 * SECRETS: copy scripts/.env.example -> scripts/.env and fill it in. That file is
 * git-ignored and is SEPARATE from the app .env (which holds only EXPO_PUBLIC_*).
 * Required: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY (the service-role key bypasses RLS so inserts work).
 *
 * Requirements: Node 18+ (uses global fetch) and the already-installed
 * @supabase/supabase-js. No extra dependencies.
 *
 * NOTE on MusicBrainz logic: the year-verification below is a faithful, slim COPY
 * of src/services/musicbrainz.ts (ISRC-batch queries + 13/18s sliding-window
 * limiter + title/artist fallback). It is copied rather than imported because
 * that module is TypeScript/ESM wired for the React Native app; a plain node
 * script would need a TS loader to import it. The copy keeps this script runnable
 * with bare `node` and no new dependencies.
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

if (typeof fetch === 'undefined') {
  console.error('This script needs Node 18+ (global fetch is missing). Please upgrade Node.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tiny .env loader (avoids a dotenv dependency)
// ---------------------------------------------------------------------------
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue; // skips blank lines and "# comments"
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(
      `Missing ${name}. Add it to scripts/.env (copy scripts/.env.example and fill it in).`
    );
    process.exit(1);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Minimal CSV parser (handles quoted fields with commas / embedded quotes)
// ---------------------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function readInputCsv(csvPath) {
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
    if (!title || !artist) continue; // skip malformed lines
    out.push({ title, artist, estimatedYear });
  }
  return out;
}

// ===========================================================================
// Spotify — Client Credentials flow (server-to-server, no user login)
// ===========================================================================
const SPOTIFY_STAGGER_MS = 150; // small delay between searches (be polite)

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
  if (!res.ok) {
    throw new Error(`Spotify token request failed ${res.status}: ${await res.text()}`);
  }
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
      _tok = { value: null, exp: 0 }; // token expired -> refresh + retry
      continue;
    }
    if (res.status === 429) {
      const ra = parseInt(res.headers.get('retry-after') || '2', 10);
      await sleep((ra + 1) * 1000);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Spotify search failed ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return (data?.tracks?.items ?? [])[0] ?? null;
  }
  throw new Error('Spotify search failed after retries (rate limit / auth).');
}

// ===========================================================================
// MusicBrainz year verification — slim copy of src/services/musicbrainz.ts
// ===========================================================================
const MB_BASE = 'https://musicbrainz.org/ws/2';
// REQUIRED by MusicBrainz. Replace the contact with your own before heavy use.
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
      res = await fetch(url, {
        headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
      });
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

/** One `isrc:A OR isrc:B ...` request -> map UPPER(ISRC) -> earliest year. */
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

/**
 * Verify release years for tracks: [{ title, artist, isrc }] -> number|null[].
 * Phase 1: batched ISRC. Phase 2: title+artist fallback (no ISRC / ISRC miss).
 */
async function mbVerifyYears(tracks) {
  const years = new Array(tracks.length).fill(null);
  const withIsrc = [];
  const withoutIsrc = [];
  tracks.forEach((t, i) => (t.isrc ? withIsrc : withoutIsrc).push(i));

  // Phase 1: ISRC batches, a few in flight under the rate cap.
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

  // Phase 2: title+artist fallback.
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
// Supabase insert (service-role key — bypasses RLS)
// ===========================================================================
async function insertPoolSongs(supabase, rows) {
  if (rows.length === 0) return 0;
  const { data, error } = await supabase.from('pool_songs').insert(rows).select('id');
  if (!error) return data.length;
  // Bulk failed (e.g. a stray duplicate) -> insert row-by-row, skipping conflicts.
  console.warn(`  Bulk insert failed (${error.message}); retrying row-by-row…`);
  let n = 0;
  for (const r of rows) {
    const { error: e } = await supabase.from('pool_songs').insert(r);
    if (e) {
      if (e.code === '23505') continue; // unique (pool_id, spotify_track_id) -> skip
      console.warn(`  skip "${r.title}" — ${r.artist}: ${e.message}`);
      continue;
    }
    n += 1;
  }
  return n;
}

// ===========================================================================
// Main
// ===========================================================================
async function main() {
  loadEnv(path.join(__dirname, '.env'));

  // TEMP DIAGNOSTIC (remove after the key/grant issue is resolved). Verifies the
  // service-role key arrives WITHOUT ever printing it in full.
  {
    const k = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const fmt = k.startsWith('sb_secret_')
      ? 'NEW secret key (service_role)'
      : k.startsWith('sb_publishable_')
        ? 'NEW publishable key (anon — WRONG kind!)'
        : k.startsWith('eyJ')
          ? 'legacy JWT'
          : '(empty / unknown)';
    console.log(`[KeyDiag] service key: len=${k.length} prefix=${JSON.stringify(k.slice(0, 12))} format=${fmt}`);
    if (k.startsWith('eyJ')) {
      try {
        const seg = k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const role = JSON.parse(Buffer.from(seg, 'base64').toString()).role;
        console.log(`[KeyDiag] JWT role claim = ${role}${role === 'service_role' ? ' ✓' : ' ✗ (needs service_role)'}`);
      } catch {
        console.log('[KeyDiag] could not decode JWT payload');
      }
    }
  }

  const [csvPath, poolName, poolDesc] = process.argv.slice(2);
  if (!csvPath || !poolName) {
    console.error(
      'Usage: node scripts/import-song-pool.js <csvPath> "<Pool Name>" "<Description>"'
    );
    process.exit(1);
  }
  const description = poolDesc ?? '';

  const inputs = readInputCsv(csvPath);
  console.log(`\nLoaded ${inputs.length} song suggestion(s) from ${csvPath}\n`);

  // --- Spotify verification (sequential + small stagger) ---
  const found = [];
  const notFound = [];
  for (let i = 0; i < inputs.length; i++) {
    const row = inputs[i];
    process.stdout.write(`Spotify ${i + 1}/${inputs.length}: ${row.title} — ${row.artist} … `);
    let track = null;
    try {
      track = await spotifySearch(row.title, row.artist);
    } catch (e) {
      console.log(`error (${e.message})`);
    }
    if (!track) {
      console.log('NOT FOUND');
      notFound.push(row);
    } else {
      const spName = track.name;
      const spArtist = track.artists && track.artists[0] ? track.artists[0].name : row.artist;
      console.log(`ok -> ${spName} — ${spArtist} (${track.id})`);
      found.push({
        ...row,
        trackId: track.id,
        spName,
        spArtist,
        isrc: (track.external_ids && track.external_ids.isrc) || null,
      });
    }
    await sleep(SPOTIFY_STAGGER_MS);
  }

  // --- Dedup tracks that resolved to the same Spotify id ---
  const seen = new Set();
  const dedup = [];
  let dupSkipped = 0;
  for (const f of found) {
    if (seen.has(f.trackId)) {
      dupSkipped += 1;
      continue;
    }
    seen.add(f.trackId);
    dedup.push(f);
  }

  // --- MusicBrainz year verification ---
  console.log(`\nVerifying release years via MusicBrainz for ${dedup.length} track(s)…`);
  const years = await mbVerifyYears(
    dedup.map((f) => ({ title: f.spName || f.title, artist: f.spArtist || f.artist, isrc: f.isrc }))
  );

  const deviations = [];
  const noYear = [];
  let fellBack = 0;
  const toInsert = [];
  dedup.forEach((f, i) => {
    const mbYear = years[i];
    const est = f.estimatedYear;
    if (mbYear == null) fellBack += 1;
    if (mbYear != null && est != null && mbYear !== est) {
      deviations.push({ name: `${f.spName} — ${f.spArtist}`, est, mbYear });
    }
    const finalYear = mbYear != null ? mbYear : est;
    if (finalYear == null) {
      noYear.push(f); // no MB hit AND no CSV estimate -> cannot satisfy NOT NULL
      return;
    }
    toInsert.push({
      title: f.spName || f.title,
      artist: f.spArtist || f.artist,
      spotify_track_id: f.trackId,
      release_year: finalYear,
      isrc: f.isrc,
    });
  });

  // --- Write to Supabase ---
  const supabase = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log('\nCreating pool…');
  const { data: pool, error: poolErr } = await supabase
    .from('song_pools')
    .insert({ name: poolName, description })
    .select()
    .single();
  if (poolErr) {
    console.error(`Failed to create pool: ${poolErr.message}`);
    process.exit(1);
  }

  const rows = toInsert.map((r) => ({ ...r, pool_id: pool.id }));
  const written = await insertPoolSongs(supabase, rows);

  // --- Summary ---
  const line = '─'.repeat(60);
  console.log(`\n${line}\nZUSAMMENFASSUNG\n${line}`);
  console.log(`Eingabe-Songs (CSV):              ${inputs.length}`);
  console.log(`Bei Spotify gefunden:             ${found.length}`);
  console.log(`Bei Spotify NICHT gefunden:       ${notFound.length}`);
  if (notFound.length) {
    for (const r of notFound) console.log(`   ✗ ${r.title} — ${r.artist}`);
  }
  if (dupSkipped) {
    console.log(`Doppelte Treffer (gleiche Track-ID, übersprungen): ${dupSkipped}`);
  }
  console.log(`MB-Jahr weicht von CSV-Schätzung ab: ${deviations.length}`);
  if (deviations.length) {
    for (const d of deviations) console.log(`   ~ ${d.name}: CSV ${d.est} -> MB ${d.mbYear}`);
  }
  console.log(`Auf CSV-Schätzung zurückgefallen (kein MB-Treffer): ${fellBack}`);
  if (noYear.length) {
    console.log(`Ohne jegliches Jahr (übersprungen, nicht geschrieben): ${noYear.length}`);
    for (const f of noYear) console.log(`   ✗ ${f.spName || f.title} — ${f.spArtist || f.artist}`);
  }
  console.log(`In pool_songs geschrieben:        ${written}`);
  console.log(`Pool: "${poolName}"  (id=${pool.id})`);
  console.log(line);
}

main().catch((e) => {
  console.error('\nFatal error:', e && e.message ? e.message : e);
  process.exit(1);
});
