/**
 * NickelBrandt — Pre-check (stage 1 of 2) for a themed song pool.
 *
 * Does Spotify search + MusicBrainz year verification (same logic as the old
 * import script) but writes the result ONLY to a local review CSV — it does NOT
 * touch Supabase at all. Safe to run as often as you like. Arni + Claude then go
 * through the review CSV, fill in the `final_year` column where needed, and a
 * SEPARATE upload script (upload-song-pool.js) writes the finished list to the DB.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 *   node scripts/precheck-song-pool.js <inputCsvPath> <outputReviewCsvPath>
 *
 *   e.g.
 *   node scripts/precheck-song-pool.js ./scripts/pop70-90.csv ./scripts/pop70-90.review.csv
 *
 * Input CSV columns: title,artist,estimated_year   (header optional)
 *
 * SECRETS: uses scripts/.env for SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET only.
 * The Supabase variables in that file are NOT used here (no DB access).
 * Needs Node 18+ (global fetch) and the already-installed deps.
 * ---------------------------------------------------------------------------
 */
'use strict';
const path = require('path');
const { loadEnv, writeCsvObjects } = require('./lib/util');
const { readInputCsv, verifySongs } = require('./lib/verify-songs');

const COLUMNS = [
  'title',
  'artist',
  'csv_year',
  'mb_year',
  'mb_year_source',
  'diff',
  'spotify_track_id',
  'spotify_match_name',
  'spotify_match_artist',
  'isrc',
  'spotify_found',
  'final_year',
];

async function main() {
  loadEnv(path.join(__dirname, '.env'));

  const [inputCsv, outputCsv] = process.argv.slice(2);
  if (!inputCsv || !outputCsv) {
    console.error('Usage: node scripts/precheck-song-pool.js <inputCsvPath> <outputReviewCsvPath>');
    process.exit(1);
  }

  const inputs = readInputCsv(inputCsv);
  console.log(`\nLoaded ${inputs.length} song suggestion(s) from ${inputCsv}\n`);

  let verifyOut;
  try {
    verifyOut = await verifySongs(inputs, {
      onSpotify: (i, total, row, r) => {
        const status = r.spotifyFound
          ? `ok -> ${r.spName} — ${r.spArtist}`
          : r.failed
            ? 'FEHLGESCHLAGEN (Anfrage, nach Retries)'
            : 'NOT FOUND';
        console.log(`Spotify ${i}/${total}: ${row.title} — ${row.artist} … ${status}`);
      },
    });
  } catch (e) {
    if (e && e.penalty) {
      console.error(`\n⛔ ${e.message}`);
      console.error(
        'Es wurde KEINE Review-CSV geschrieben. Prüfe mit "node scripts/check-spotify-token.js", ' +
          'ob der Cooldown vorbei ist, und starte dann erneut.'
      );
      process.exit(1);
    }
    throw e;
  }
  const { results, stats } = verifyOut;
  console.log(`\nVerified release years via MusicBrainz. Building review CSV…`);

  // Build review rows + a numeric sort key.
  const rows = results.map((r) => {
    const csvYear = r.input.estimatedYear; // may be null
    let mbYear = '';
    let source = '';
    let diff = '';
    let finalYear = '';
    let sortKey; // higher = needs attention sooner

    if (!r.spotifyFound) {
      sortKey = Number.MAX_SAFE_INTEGER; // not-found rows go to the very top
    } else if (r.mbYear != null) {
      mbYear = r.mbYear;
      source = 'musicbrainz';
      if (csvYear != null) {
        const d = Math.abs(csvYear - r.mbYear);
        diff = d;
        sortKey = d;
        if (d === 0) finalYear = r.mbYear; // unambiguous -> pre-fill
      } else {
        diff = ''; // no estimate to compare against -> needs a look
        sortKey = Number.MAX_SAFE_INTEGER - 2;
      }
    } else {
      // Spotify found, but no MusicBrainz hit -> fall back to the CSV estimate.
      source = 'fallback';
      if (csvYear != null) {
        mbYear = csvYear;
        diff = 0; // mb_year == csv_year by construction
        sortKey = Number.MAX_SAFE_INTEGER - 1; // still worth a glance (unverified)
      } else {
        diff = '';
        sortKey = Number.MAX_SAFE_INTEGER - 1;
      }
    }

    return {
      _sortKey: sortKey,
      _spotifyFound: r.spotifyFound,
      row: {
        title: r.input.title,
        artist: r.input.artist,
        csv_year: csvYear != null ? csvYear : '',
        mb_year: mbYear,
        mb_year_source: source,
        diff,
        spotify_track_id: r.trackId || '',
        spotify_match_name: r.spName || '',
        spotify_match_artist: r.spArtist || '',
        isrc: r.isrc || '',
        spotify_found: r.spotifyFound ? 'true' : 'false',
        final_year: finalYear,
      },
    };
  });

  // Sort: biggest review need first (not-found + large diffs on top; diff=0 found
  // at the bottom). Tiebreak: not-found before found.
  rows.sort((a, b) => {
    if (b._sortKey !== a._sortKey) return b._sortKey - a._sortKey;
    if (a._spotifyFound !== b._spotifyFound) return a._spotifyFound ? 1 : -1;
    return 0;
  });

  writeCsvObjects(outputCsv, COLUMNS, rows.map((r) => r.row));

  // --- Summary ---
  const notFound = results.filter((r) => !r.spotifyFound).length;
  const autoFilled = rows.filter((r) => r.row.spotify_found === 'true' && r.row.final_year !== '').length;
  const needsReview = rows.filter((r) => r.row.spotify_found === 'true' && r.row.final_year === '').length;

  const line = '─'.repeat(60);
  console.log(`\n${line}\nPRE-CHECK ZUSAMMENFASSUNG\n${line}`);
  console.log(`Eingabe-Songs:                          ${inputs.length}`);
  console.log(`diff = 0 (auto-befüllt, ohne Rückfrage übernehmbar): ${autoFilled}`);
  console.log(`diff >= 1 / unbestimmt (im Review anzuschauen):       ${needsReview}`);
  console.log(`Nicht bei Spotify gefunden (übersprungen beim Upload): ${notFound}`);
  console.log(`Songs mit Rate-Limit-Retry (429, letztlich egal ob ok): ${stats.retried}`);
  console.log(`Endgültig fehlgeschlagen nach ${5} Versuchen:           ${stats.failed.length}`);
  if (stats.failed.length) {
    for (const f of stats.failed) console.log(`   ✗ ${f.title} — ${f.artist}`);
    console.log('   (diese erneut laufen lassen, sobald das Rate-Limit abgeklungen ist)');
  }
  console.log(`Review-CSV geschrieben:                 ${outputCsv}`);
  console.log(line);
  console.log('Nächster Schritt: final_year-Spalte im Review prüfen/befüllen, dann upload-song-pool.js.');
}

main().catch((e) => {
  console.error('\nFatal error:', e && e.message ? e.message : e);
  process.exit(1);
});
