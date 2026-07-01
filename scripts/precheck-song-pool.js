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
 *   Optional: spotify_track_id,isrc — if BOTH are filled for a row (e.g. from a
 *   playlist export) that row takes a fast-path: the id+ISRC are trusted as-is
 *   (no Spotify search / similarity check), only the MusicBrainz year is still
 *   verified. Rows without them use the full resolver chain as before. Mixed
 *   CSVs are handled row by row.
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
  'deezer_year',
  'discogs_year',
  'chosen_candidate',
  'status',
  'notes',
  'diff',
  'spotify_track_id',
  'spotify_match_name',
  'spotify_match_artist',
  'match_method',
  'similarity_score',
  'isrc',
  'spotify_found',
  'final_year',
];

async function main() {
  const tScript = Date.now();
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
      onPhase: (event, info) => {
        if (event === 'credits-start') console.log(`Credits.fm: löse ISRCs für ${info.total} Songs (Batch, async)…`);
        else if (event === 'credits-progress') console.log(`  Credits.fm Runde ${info.round}: ${info.resolved}/${info.total} ISRCs`);
        else if (event === 'credits-done') console.log(`Credits.fm fertig: ${info.resolved}/${info.total} ISRCs. Jetzt Spotify-Auflösung…\n`);
      },
      onSpotify: (i, total, row, r) => {
        const tag =
          r.matchMethod + (r.similarityScore != null ? ` ~${r.similarityScore.toFixed(2)}` : '');
        const status = r.spotifyFound
          ? `ok [${tag}] -> ${r.spName} — ${r.spArtist}`
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
  console.log(`\nJahres-Konsens (MusicBrainz-Anker) gebildet. Baue Review-CSV…`);

  // Higher = more urgent -> sorted to the top. Review-needing statuses above the
  // auto-accepted ones (status-based, replacing the old |csv-mb| diff sort).
  const SORT_RANK = {
    spotify_not_found: 5,
    mb_no_match: 4,
    mb_match_uncertain: 3,
    review_needed_other_source_earlier: 2,
    minor_difference: 1,
    mb_anchor_ok: 0,
  };

  const rows = results.map((r) => {
    const csvYear = r.input.estimatedYear; // may be null
    const status = r.spotifyFound ? r.consensusStatus || 'mb_no_match' : 'spotify_not_found';
    const autoAccept = status === 'mb_anchor_ok' || status === 'minor_difference';
    const finalYear = autoAccept && r.chosenYear != null ? r.chosenYear : '';
    const diff = csvYear != null && r.mbYear != null ? Math.abs(csvYear - r.mbYear) : '';
    const sortKey = SORT_RANK[status] != null ? SORT_RANK[status] : 3;

    return {
      _sortKey: sortKey,
      row: {
        title: r.input.title,
        artist: r.input.artist,
        csv_year: csvYear != null ? csvYear : '',
        mb_year: r.mbYear != null ? r.mbYear : '',
        mb_year_source: r.spotifyFound ? r.mbStatus || '' : 'spotify_not_found',
        deezer_year: r.deezerYear != null ? r.deezerYear : '',
        discogs_year: r.discogsYear != null ? r.discogsYear : '',
        chosen_candidate: r.chosenYear != null ? r.chosenYear : '',
        status,
        notes: r.notes || '',
        diff,
        spotify_track_id: r.trackId || '',
        spotify_match_name: r.spName || '',
        spotify_match_artist: r.spArtist || '',
        match_method: r.matchMethod || '',
        similarity_score: r.similarityScore != null ? r.similarityScore.toFixed(2) : '',
        isrc: r.isrc || '',
        spotify_found: r.spotifyFound ? 'true' : 'false',
        final_year: finalYear,
      },
    };
  });

  // Review-needing statuses first, auto-accepted at the bottom.
  rows.sort((a, b) => b._sortKey - a._sortKey);

  writeCsvObjects(outputCsv, COLUMNS, rows.map((r) => r.row));

  // --- Summary ---
  const autoFilled = rows.filter((r) => r.row.final_year !== '').length;

  // Konsens-Status-Tally.
  const tally = {};
  for (const r of rows) tally[r.row.status] = (tally[r.row.status] || 0) + 1;

  // Trefferquote je Quelle (welcher Resolver-Schritt griff).
  const byMethod = {};
  for (const r of results) {
    const mm = r.matchMethod || (r.spotifyFound ? 'unknown' : 'none');
    byMethod[mm] = (byMethod[mm] || 0) + 1;
  }
  const m = (k) => byMethod[k] || 0;

  const fastPath = results.filter((r) => r.matchMethod === 'playlist_import').length;
  const fullChain = inputs.length - fastPath;

  const t = stats.timings || {};
  const s1 = (ms) => ((ms || 0) / 1000).toFixed(1);
  const totalS = ((Date.now() - tScript) / 1000).toFixed(1);

  const line = '─'.repeat(64);
  console.log(`\n${line}\nPRE-CHECK ZUSAMMENFASSUNG\n${line}`);
  console.log(`Eingabe-Songs:  ${inputs.length}   (Fast-Path ${fastPath} | volle Kette ${fullChain})`);
  console.log(
    `Quelle je Treffer:  Credits ${m('creditsfm_isrc')} | Deezer ${m('deezer_isrc')} | ` +
      `Spotify strict ${m('strict')} | loose ${m('fallback_loose') + m('fallback_first_artist')}`
  );
  console.log(`Konsens-Status:`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${k.padEnd(38)} ${v}`);
  }
  console.log(`final_year automatisch gesetzt (mb_anchor_ok / minor_difference): ${autoFilled}`);
  console.log(`Rest = Review nötig:                                              ${inputs.length - autoFilled}`);
  console.log(`Rate-Limit-Retries: ${stats.retried} | endgültig fehlgeschlagen: ${stats.failed.length}`);
  if (stats.failed.length) {
    for (const f of stats.failed) console.log(`   ✗ ${f.title} — ${f.artist}`);
  }
  console.log(line);
  console.log(`Laufzeit gesamt: ${totalS}s`);
  console.log(`   Resolver (Spotify/Credits/Deezer-ISRC):   ${s1(t.resolveMs)}s`);
  console.log(`   Jahres-Pässe MB + Deezer (nebenläufig):   MB ${s1(t.mbMs)}s, Deezer ${s1(t.deezerMs)}s  (~max zählt)`);
  console.log(
    `   Discogs (nur bei Bedarf):                 ${s1(t.discogsMs)}s  ` +
      `(${t.discogsCalls || 0} Calls, ${t.discogsSkipped || 0} übersprungen)`
  );
  console.log(`Review-CSV geschrieben: ${outputCsv}`);
  console.log(line);
  console.log('Nächster Schritt: Review-Zeilen (Status oben) prüfen, final_year füllen, dann upload-song-pool.js.');
}

main().catch((e) => {
  console.error('\nFatal error:', e && e.message ? e.message : e);
  process.exit(1);
});
