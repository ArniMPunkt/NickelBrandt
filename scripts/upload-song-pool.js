/**
 * NickelBrandt — Upload (stage 2 of 2) for a themed song pool.
 *
 * Takes the REVIEWED CSV from precheck-song-pool.js (with `final_year` filled in)
 * and writes it to Supabase (song_pools + pool_songs). It does NOT call Spotify
 * or MusicBrainz — all verification already happened in stage 1. `final_year` is
 * the only source of truth for the year written.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 *   node scripts/upload-song-pool.js <reviewCsvPath> "<Pool Name>" "<Description>"
 *
 *   e.g.
 *   node scripts/upload-song-pool.js ./scripts/pop70-90.review.csv "Pop 70er-90er" "Pop-Hits 1970–1999"
 *
 * SECRETS: scripts/.env -> SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (service-role
 * key bypasses RLS; never logged). Needs the already-installed @supabase/supabase-js.
 * ---------------------------------------------------------------------------
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { loadEnv, need, parseCsvObjects } = require('./lib/util');

function toIntYear(v) {
  return /^\d{1,4}$/.test(String(v).trim()) ? parseInt(v, 10) : null;
}

async function insertPoolSongs(supabase, rows) {
  if (rows.length === 0) return 0;
  const { data, error } = await supabase.from('pool_songs').insert(rows).select('id');
  if (!error) return data.length;
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

async function main() {
  loadEnv(path.join(__dirname, '.env'));

  const [reviewCsv, poolName, poolDesc] = process.argv.slice(2);
  if (!reviewCsv || !poolName) {
    console.error('Usage: node scripts/upload-song-pool.js <reviewCsvPath> "<Pool Name>" "<Description>"');
    process.exit(1);
  }
  const description = poolDesc ?? '';

  if (!fs.existsSync(reviewCsv)) {
    console.error(`Review CSV not found: ${reviewCsv}`);
    process.exit(1);
  }
  const { objects } = parseCsvObjects(fs.readFileSync(reviewCsv, 'utf8'));
  if (objects.length === 0) {
    console.error('Review CSV has no data rows.');
    process.exit(1);
  }
  const totalRows = objects.length;

  // --- Partition rows ---
  const skippedNoSpotify = [];
  const candidates = []; // spotify_found === true
  for (const o of objects) {
    if (String(o.spotify_found).toLowerCase() === 'true') candidates.push(o);
    else skippedNoSpotify.push(o);
  }

  // --- Validate: every Spotify-found row MUST have a valid final_year ---
  const missingFinal = candidates.filter((o) => toIntYear(o.final_year) == null);
  if (missingFinal.length > 0) {
    console.error(
      `\nABBRUCH: ${missingFinal.length} Zeile(n) mit spotify_found=true haben kein gültiges final_year.`
    );
    console.error('Der Review-Schritt ist nicht vollständig. Betroffene Titel:');
    for (const o of missingFinal) console.error(`   ✗ ${o.title} — ${o.artist}  (final_year="${o.final_year}")`);
    console.error('\nBitte final_year für diese Zeilen befüllen und erneut ausführen. Es wurde NICHTS geschrieben.');
    process.exit(1);
  }

  // --- Dedup by spotify_track_id (skip in-pool duplicates) ---
  const seen = new Set();
  const dedup = [];
  let dupSkipped = 0;
  for (const o of candidates) {
    if (seen.has(o.spotify_track_id)) {
      dupSkipped += 1;
      continue;
    }
    seen.add(o.spotify_track_id);
    dedup.push(o);
  }

  // --- Supabase (service-role) ---
  const supabase = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Name-collision check (no auto-overwrite/duplicate).
  const { data: existing, error: existErr } = await supabase
    .from('song_pools')
    .select('id')
    .eq('name', poolName);
  if (existErr) {
    console.error(`Konnte bestehende Pools nicht prüfen: ${existErr.message}`);
    process.exit(1);
  }
  if (existing && existing.length > 0) {
    console.error(
      `\nABBRUCH: Es existiert bereits ein Pool mit dem Namen "${poolName}" (id=${existing[0].id}).`
    );
    console.error('Kein automatisches Überschreiben/Duplizieren. Lösche den alten Pool oder wähle einen anderen Namen.');
    process.exit(1);
  }

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

  // --- Build rows (release_year = final_year, the single source of truth) ---
  let correctedFromMb = 0;
  const rows = dedup.map((o) => {
    const finalYear = toIntYear(o.final_year);
    const mbYear = toIntYear(o.mb_year);
    if (mbYear != null && finalYear !== mbYear) correctedFromMb += 1;
    return {
      pool_id: pool.id,
      title: o.spotify_match_name || o.title,
      artist: o.spotify_match_artist || o.artist,
      spotify_track_id: o.spotify_track_id,
      release_year: finalYear,
      isrc: o.isrc || null,
    };
  });

  const written = await insertPoolSongs(supabase, rows);

  // --- Summary ---
  const line = '─'.repeat(60);
  console.log(`\n${line}\nUPLOAD ZUSAMMENFASSUNG\n${line}`);
  console.log(`Zeilen in Review-CSV insgesamt:        ${totalRows}`);
  console.log(`Übersprungen (kein Spotify-Treffer):   ${skippedNoSpotify.length}`);
  if (skippedNoSpotify.length) {
    for (const o of skippedNoSpotify) console.log(`   ✗ ${o.title} — ${o.artist}`);
  }
  if (dupSkipped) console.log(`Doppelte Track-IDs (übersprungen):     ${dupSkipped}`);
  console.log(`Tatsächlich geschrieben:               ${written}`);
  console.log(`final_year != mb_year (im Review korrigiert): ${correctedFromMb}`);
  console.log(`Pool: "${poolName}"  (id=${pool.id})`);
  console.log(line);
}

main().catch((e) => {
  console.error('\nFatal error:', e && e.message ? e.message : e);
  process.exit(1);
});
