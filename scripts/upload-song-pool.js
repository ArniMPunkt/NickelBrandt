/**
 * NickelBrandt - Upload (stage 2 of 2) for a themed song pool.
 *
 * Takes the reviewed CSV from precheck-song-pool.js / review-song-pool.js and
 * writes upload-ready rows to Supabase (song_pools + pool_songs). It does not
 * call Spotify or MusicBrainz. final_year is the only year written.
 *
 * Usage:
 *   node scripts/upload-song-pool.js <reviewCsvPath> "<Pool Name>" "<Description>"
 *
 * Current standard flow:
 *   node scripts/precheck-song-pool.js scripts/raw_hitster_summer_v2.csv scripts/review.csv --no-interactive --deezer=off --discogs=needed --listenbrainz=needed --lb-auto-accept=safe
 *   node scripts/review-song-pool.js scripts/review.csv scripts/review_final.csv
 *   node scripts/upload-song-pool.js scripts/review_final.csv "Summer 2026"
 *
 * Secrets: scripts/.env -> SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { loadEnv, need, parseCsvObjects } = require('./lib/util');
const { finalYearDiffersFromMb, mapUploadRow } = require('./lib/upload/map-upload-row');
const { formatBlockedUploadRows, validateUploadRows } = require('./lib/upload/validate-upload-rows');

async function insertPoolSongs(supabase, rows) {
  if (rows.length === 0) return 0;
  const { data, error } = await supabase.from('pool_songs').insert(rows).select('id');
  if (!error) return data.length;
  console.warn(`  Bulk insert failed (${error.message}); retrying row-by-row...`);
  let n = 0;
  for (const r of rows) {
    const { error: e } = await supabase.from('pool_songs').insert(r);
    if (e) {
      if (e.code === '23505') continue; // unique (pool_id, spotify_track_id) -> skip
      console.warn(`  skip "${r.title}" - ${r.artist}: ${e.message}`);
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

  const validation = validateUploadRows(objects);
  if (validation.blockedRows.length > 0) {
    console.error(`\n${formatBlockedUploadRows(validation.blockedRows)}`);
    process.exit(1);
  }

  const skippedExcluded = validation.skippedExcluded.map((item) => item.row);
  const skippedNoSpotify = validation.skippedNoSpotify.map((item) => item.row);

  // Dedup by spotify_track_id (skip in-pool duplicates).
  const seen = new Set();
  const dedup = [];
  let dupSkipped = 0;
  for (const item of validation.uploadCandidates) {
    const trackId = item.row.spotify_track_id;
    if (seen.has(trackId)) {
      dupSkipped += 1;
      continue;
    }
    seen.add(trackId);
    dedup.push(item);
  }

  const supabase = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Name-collision check (no auto-overwrite/duplicate).
  const { data: existing, error: existErr } = await supabase
    .from('song_pools')
    .select('id')
    .eq('name', poolName);
  if (existErr) {
    console.error(`Konnte bestehende Pools nicht pruefen: ${existErr.message}`);
    process.exit(1);
  }
  if (existing && existing.length > 0) {
    console.error(
      `\nABBRUCH: Es existiert bereits ein Pool mit dem Namen "${poolName}" (id=${existing[0].id}).`
    );
    console.error('Kein automatisches Ueberschreiben/Duplizieren. Loesche den alten Pool oder waehle einen anderen Namen.');
    process.exit(1);
  }

  console.log('\nCreating pool...');
  const { data: pool, error: poolErr } = await supabase
    .from('song_pools')
    .insert({ name: poolName, description })
    .select()
    .single();
  if (poolErr) {
    console.error(`Failed to create pool: ${poolErr.message}`);
    process.exit(1);
  }

  const correctedFromMb = dedup.filter((item) => finalYearDiffersFromMb(item.row)).length;
  const rows = dedup.map((item) => mapUploadRow(item.row, pool.id));
  const written = await insertPoolSongs(supabase, rows);

  const line = '-'.repeat(60);
  console.log(`\n${line}\nUPLOAD ZUSAMMENFASSUNG\n${line}`);
  console.log(`Zeilen in Review-CSV insgesamt:        ${totalRows}`);
  console.log(`Uebersprungen (excluded_from_pool):    ${skippedExcluded.length}`);
  if (skippedExcluded.length) {
    for (const o of skippedExcluded) console.log(`   - ${o.title} - ${o.artist}`);
  }
  console.log(`Uebersprungen (kein Spotify-Treffer):  ${skippedNoSpotify.length}`);
  if (skippedNoSpotify.length) {
    for (const o of skippedNoSpotify) console.log(`   - ${o.title} - ${o.artist}`);
  }
  if (dupSkipped) console.log(`Doppelte Track-IDs (uebersprungen):    ${dupSkipped}`);
  console.log(`Tatsaechlich geschrieben:              ${written}`);
  console.log(`final_year != mb_year (im Review korrigiert): ${correctedFromMb}`);
  console.log(`Pool: "${poolName}"  (id=${pool.id})`);
  console.log(line);
}

main().catch((e) => {
  console.error('\nFatal error:', e && e.message ? e.message : e);
  process.exit(1);
});
