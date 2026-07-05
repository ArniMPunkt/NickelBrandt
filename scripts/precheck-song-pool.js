/**
 * NickelBrandt - smart precheck/re-review (stage 2) for song-pool CSVs.
 *
 * One script for first review, resume, and re-review/audit:
 *   node scripts/precheck-song-pool.js <inputCsvPath> <outputCsvPath>
 *   node scripts/precheck-song-pool.js <inputCsvPath> <outputCsvPath> --no-interactive
 *   node scripts/precheck-song-pool.js <inputCsvPath> <outputCsvPath> --review-all
 *
 * Input and output must be different files. Spotify estimated_year is kept as
 * weak display context only; MusicBrainz remains the release-year anchor.
 */
'use strict';

const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { loadEnv, writeCsvObjects } = require('./lib/util');
const { verifySongs, mbYearFromManualUrl } = require('./lib/verify-songs');
const { appendNote, isCatalogSuspected, toIntYear } = require('./lib/precheck/helpers');
const { buildReviewRow } = require('./lib/precheck/build-review-row');
const { hydrateInputDeezerFromOutput, loadSmartInputCsv } = require('./lib/precheck/load-smart-input-csv');
const { computeSummary, printSummary } = require('./lib/precheck/report');
const { mergeResumeState } = require('./lib/precheck/resume-state');
const { COLUMNS, STRONG_EXISTING_SOURCES } = require('./lib/precheck/review-schema');
const { compareRows, hasFinalYear, isOpenReview } = require('./lib/precheck/review-queue');
const { runSoftDiscogsChecks } = require('./lib/precheck/soft-discogs-checks');

function parseArgs(argv) {
  const args = {
    inputCsv: null,
    outputCsv: null,
    interactive: true,
    reviewAll: false,
    deezerMode: 'needed',
    discogsMode: 'needed',
    deep: false,
  };
  for (const arg of argv) {
    if (arg === '--interactive') args.interactive = true;
    else if (arg === '--no-interactive') args.interactive = false;
    else if (arg === '--review-all') args.reviewAll = true;
    else if (arg === '--deep' || arg === '--deep-original-search') args.deep = true;
    else if (arg.startsWith('--deezer=')) {
      const mode = arg.slice('--deezer='.length);
      if (!['needed', 'full', 'off'].includes(mode)) throw new Error(`Unknown Deezer mode: ${mode}`);
      args.deezerMode = mode;
    }
    else if (arg.startsWith('--discogs=')) {
      const mode = arg.slice('--discogs='.length);
      if (!['needed', 'full', 'off'].includes(mode)) throw new Error(`Unknown Discogs mode: ${mode}`);
      args.discogsMode = mode;
    }
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!args.inputCsv) args.inputCsv = arg;
    else if (!args.outputCsv) args.outputCsv = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usageAndExit() {
  console.error(
    'Usage: node scripts/precheck-song-pool.js <inputCsvPath> <outputCsvPath> [--interactive|--no-interactive] [--review-all] [--deezer=needed|full|off] [--discogs=needed|full|off] [--deep]'
  );
  process.exit(1);
}

function resolveCsvPath(filePath) {
  return path.resolve(process.cwd(), filePath);
}

function assertDistinctPaths(inputCsv, outputCsv) {
  const inPath = resolveCsvPath(inputCsv);
  const outPath = resolveCsvPath(outputCsv);
  if (inPath.toLowerCase() === outPath.toLowerCase()) {
    console.error('\nABBRUCH: Input- und Output-CSV duerfen nicht identisch sein.');
    console.error(`Input:  ${inputCsv}`);
    console.error(`Output: ${outputCsv}`);
    console.error('Bitte eine neue Output-Datei nutzen, z. B. scripts/review_<name>_smart.csv.');
    process.exit(1);
  }
}

function clearTimer(timer) {
  if (timer) clearInterval(timer);
  return null;
}

function canUseSpotifyYear(row) {
  const spotifyYear = toIntYear(row.estimated_year);
  if (spotifyYear == null) return false;
  if (isCatalogSuspected(row)) return false;
  const mbUnclear = row.mb_year_source === 'mb_no_match' || row.mb_year_source === 'mb_match_uncertain';
  if (!mbUnclear) return false;
  const deezerYear = toIntYear(row.deezer_year);
  if (deezerYear != null && deezerYear < spotifyYear) return false;
  const discogsYear = toIntYear(row.discogs_year);
  if (discogsYear != null && Math.abs(discogsYear - spotifyYear) > 1) return false;
  return true;
}

function isStrongExisting(row) {
  return STRONG_EXISTING_SOURCES.has(row.existing_year_source);
}

function hasStrongExistingYear(row) {
  return toIntYear(row.existing_year) != null && isStrongExisting(row);
}

function saveRows(outputCsv, rows) {
  writeCsvObjects(outputCsv, COLUMNS, rows.slice().sort(compareRows));
}

function sourceConfidence(row) {
  if (row.mb_year_source === 'mb_ok') return 'plausibel';
  if (row.mb_year_source === 'mb_match_uncertain') return 'unsicher';
  if (row.mb_year_source === 'mb_no_match') return 'kein Treffer';
  return row.mb_year_source || 'unklar';
}

function discogsRejectReason(row) {
  if (row.discogs_rejected_reason) return row.discogs_rejected_reason;
  const m = String(row.notes || '').match(/discogs:([^;]+)/);
  return m ? m[1].trim() : '';
}

function printReview(row, index, total) {
  const discogsReject = discogsRejectReason(row);
  const discogsLine = row.discogs_year
    ? `${row.discogs_year}${discogsReject ? ` | verworfen: ${discogsReject}` : ''}`
    : row.discogs_rejected_year
      ? `${row.discogs_rejected_year} | verworfen: ${discogsReject || 'unklar'}`
      : discogsReject
        ? `- | verworfen: ${discogsReject}`
        : '-';

  console.log('\n------------------------------------------------------------');
  console.log(`Review ${index}/${total}\n`);
  console.log('Song:');
  console.log(`${row.title} - ${row.artist}`);
  console.log(`ISRC: ${row.isrc || '-'}`);
  console.log('\nBestehende Datei:');
  console.log(`existing_year: ${row.existing_year || '-'}`);
  console.log(`existing_year_source: ${row.existing_year_source || '-'}`);
  console.log(`existing_status: ${row.existing_status || '-'}`);
  console.log(`existing_notes: ${row.existing_notes || '-'}`);
  console.log('\nSpotify:');
  console.log(`estimated_year: ${row.estimated_year || row.csv_year || '-'}`);
  console.log(`album: ${row.spotify_album_name || '-'} | type: ${row.spotify_album_type || '-'} | release: ${row.spotify_album_release_date || '-'}`);
  console.log(`duration_ms: ${row.spotify_duration_ms || '-'} | album_artist: ${row.spotify_album_artist || '-'}`);
  console.log('Hinweis: Spotify-Jahr ist nur Album-/Kataloginfo, nicht fuehrend.');
  if (row.spotify_found !== 'true') console.log('Spotify Match: NICHT gefunden (Upload ueberspringt diese Zeile)');
  console.log('\nQuellen:');
  console.log(`MusicBrainz: ${row.mb_year || '-'} | ${sourceConfidence(row)} | ${row.mb_match_method || '-'}${row.mb_score ? ` score ${row.mb_score}` : ''}`);
  console.log(`Deezer:      ${row.deezer_year || '-'}${row.deezer_invalid_year ? ` | ungueltig/verdacht: ${row.deezer_invalid_year}` : ''}${row.deezer_status ? ` | ${row.deezer_status}` : ''}`);
  console.log(`Discogs:     ${discogsLine}`);
  console.log(`Discogs rejected year: ${row.discogs_rejected_year || '-'}`);
  console.log(`Discogs rejected reason: ${row.discogs_rejected_reason || '-'}`);
  console.log('\nStatus:');
  console.log(row.status || '-');
  console.log('\nNotes:');
  console.log(row.notes || '-');
  console.log('\nWas moechtest du tun?');
  if (hasStrongExistingYear(row)) console.log(`[b] bestehendes Jahr ${row.existing_year} behalten`);
  if (row.mb_year) console.log(`[m] MusicBrainz-Jahr ${row.mb_year} uebernehmen`);
  if (row.discogs_year && !discogsReject) console.log(`[g] Discogs-Jahr ${row.discogs_year} uebernehmen`);
  if (canUseSpotifyYear(row)) console.log(`[p] Spotify-Jahr ${row.estimated_year} uebernehmen`);
  console.log('[u] MusicBrainz-URL/MBID eingeben');
  console.log('[y] anderes Jahr manuell eingeben');
  console.log('[x] Song aus Pool ausschliessen');
  console.log('[s] skip / spaeter pruefen');
  console.log('[q] speichern und beenden');
}

async function askYear(rl) {
  for (;;) {
    const answer = (await rl.question('Jahr eingeben (YYYY): ')).trim();
    const year = toIntYear(answer);
    if (year != null) return year;
    console.log('Bitte ein vierstelliges Jahr eingeben, z. B. 1984.');
  }
}

async function askMusicBrainzUrl(rl) {
  const answer = (await rl.question('MusicBrainz-URL oder MBID eingeben: ')).trim();
  return mbYearFromManualUrl(answer);
}

async function askOptional(rl, prompt) {
  return (await rl.question(prompt)).trim();
}

function applyManualChoice(row, action, year, extra = {}) {
  if (action === 'b') {
    row.final_year = String(year);
    row.chosen_candidate = String(year);
    row.status = 'manual_kept_existing';
    row.notes = appendNote(row.notes, `manual: kept existing year ${year}`);
  } else if (action === 'm') {
    row.final_year = String(year);
    row.chosen_candidate = String(year);
    row.status = 'manual_confirmed_mb';
    row.notes = appendNote(row.notes, `manual: confirmed MusicBrainz year ${year}`);
  } else if (action === 'g') {
    row.final_year = String(year);
    row.chosen_candidate = String(year);
    row.status = 'manual_confirmed_discogs';
    row.notes = appendNote(row.notes, `manual: confirmed Discogs year ${year}`);
  } else if (action === 'p') {
    row.final_year = String(year);
    row.chosen_candidate = String(year);
    row.status = 'manual_confirmed_spotify';
    row.notes = appendNote(row.notes, 'manual: confirmed Spotify album year');
  } else if (action === 'y') {
    row.final_year = String(year);
    row.chosen_candidate = String(year);
    row.status = 'manual_entered_year';
    row.notes = appendNote(row.notes, `manual: entered ${year}`);
  } else if (action === 'u') {
    row.final_year = String(year);
    row.chosen_candidate = String(year);
    row.status = 'manual_musicbrainz_url';
    row.manual_source_url = extra.sourceUrl || '';
    row.notes = appendNote(row.notes, `manual MusicBrainz URL used${extra.type ? ` (${extra.type})` : ''}`);
  } else if (action === 'x') {
    row.final_year = '';
    row.chosen_candidate = '';
    row.status = 'excluded_from_pool';
    row.exclusion_reason = extra.reason || '';
    row.notes = appendNote(row.notes, extra.reason ? `manual: excluded from pool (${extra.reason})` : 'manual: excluded from pool');
  } else if (action === 's') {
    row.final_year = '';
    row.status = 'manual_skipped';
    row.notes = appendNote(row.notes, 'manual: skipped for later review');
  } else if (action === 'q') {
    row.status = 'manual_quit_pending';
    row.notes = appendNote(row.notes, 'manual: quit pending');
  }
}

async function runInteractiveReview(rows, outputCsv, { reviewAll }) {
  const reviewRows = reviewAll ? rows : rows.filter(isOpenReview);
  if (reviewRows.length === 0) {
    console.log('\nKeine offenen Reviews. Alle unauffaelligen final_year-Werte sind gesetzt.');
    return;
  }

  console.log(`\nInteraktiver Review: ${reviewRows.length} Zeile(n). Nach jeder Entscheidung wird gespeichert.`);
  const rl = readline.createInterface({ input, output });
  try {
    for (let i = 0; i < reviewRows.length; i++) {
      const row = reviewRows[i];

      for (;;) {
        printReview(row, i + 1, reviewRows.length);
        const answer = (await rl.question('Auswahl: ')).trim().toLowerCase();
        const action = answer[0];

        if (action === 'b' && hasStrongExistingYear(row)) {
          applyManualChoice(row, 'b', row.existing_year);
        } else if (action === 'm' && row.mb_year) {
          applyManualChoice(row, 'm', row.mb_year);
        } else if (action === 'g' && row.discogs_year && !discogsRejectReason(row)) {
          applyManualChoice(row, 'g', row.discogs_year);
        } else if (action === 'p' && canUseSpotifyYear(row)) {
          applyManualChoice(row, 'p', row.estimated_year);
        } else if (action === 'u') {
          try {
            const mb = await askMusicBrainzUrl(rl);
            console.log(`MusicBrainz ${mb.type} ${mb.mbid}: Jahr ${mb.year}${mb.title ? ` (${mb.title})` : ''}`);
            applyManualChoice(row, 'u', mb.year, mb);
          } catch (e) {
            console.log(`MusicBrainz-URL nicht uebernommen: ${e && e.message ? e.message : e}`);
            continue;
          }
        } else if (action === 'y') {
          applyManualChoice(row, 'y', await askYear(rl));
        } else if (action === 'x') {
          const reason = await askOptional(rl, 'Ausschlussgrund optional: ');
          applyManualChoice(row, 'x', null, { reason });
        } else if (action === 's') {
          applyManualChoice(row, 's');
        } else if (action === 'q') {
          applyManualChoice(row, 'q');
          saveRows(outputCsv, rows);
          console.log(`\nGespeichert: ${outputCsv}`);
          return;
        } else {
          console.log('Ungueltige Auswahl oder Quelle ohne Jahr. Bitte erneut waehlen.');
          continue;
        }

        saveRows(outputCsv, rows);
        console.log(`Gespeichert: ${outputCsv}`);
        break;
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const tScript = Date.now();
  loadEnv(path.join(__dirname, '.env'));

  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    usageAndExit();
  }
  if (!args.inputCsv || !args.outputCsv) usageAndExit();
  assertDistinctPaths(args.inputCsv, args.outputCsv);

  if (args.interactive && !process.stdin.isTTY) {
    console.log('Kein interaktives Terminal erkannt - laufe als --no-interactive.');
    args.interactive = false;
  }

  console.log('\nPhase 1/4: Spotify-Playlistdaten laden');
  const inputs = loadSmartInputCsv(args.inputCsv);
  const hydratedDeezer = hydrateInputDeezerFromOutput(inputs, args.outputCsv);
  console.log(`Geladen: ${inputs.length} Song-Zeile(n) aus ${args.inputCsv}`);
  console.log(
    `Modus: ${args.interactive ? 'interaktiv (Default)' : 'nicht-interaktiv'}${args.reviewAll ? ' + review-all' : ''}, ` +
      `Discogs=${args.discogsMode}${args.deep ? ', deep' : ''}`
  );
  if (args.deezerMode === 'off') console.log('Deezer: off');
  else console.log(`Deezer: optionaler Kompatibilitaetslauf (${args.deezerMode})${hydratedDeezer ? `, aus Output uebernommen: ${hydratedDeezer}` : ''}`);

  let verifyOut;
  let phaseTimer = null;
  let phaseStartedAt = 0;
  try {
    verifyOut = await verifySongs(inputs, {
      onPhase: (event, info) => {
        if (event === 'credits-start') console.log(`Spotify-Resolver: ISRC-Kontext fuer ${info.total} Song(s) vorbereiten...`);
        else if (event === 'credits-progress') console.log(`  Resolver-Runde ${info.round}: ${info.resolved}/${info.total}`);
        else if (event === 'credits-done') console.log(`Spotify-Resolver vorbereitet: ${info.resolved}/${info.total}. Spotify-Abgleich startet.\n`);
        else if (event === 'years-start') {
          console.log('\nPhase 2/4: MusicBrainz pruefen');
          console.log(`MusicBrainz: pruefe Aufnahmejahre fuer ${info.total} Song(s).`);
          if ((info.deezerMode || args.deezerMode) === 'off') console.log('Deezer: off');
          else console.log(`Deezer: optionaler Kompatibilitaetslauf (${info.deezerMode || args.deezerMode}).`);
          phaseStartedAt = Date.now();
          phaseTimer = clearTimer(phaseTimer);
          phaseTimer = setInterval(() => {
            const seconds = Math.round((Date.now() - phaseStartedAt) / 1000);
            console.log(`  Noch in Phase 2: MusicBrainz prueft seit ${seconds}s ...`);
          }, 15000);
        } else if (event === 'years-done') {
          phaseTimer = clearTimer(phaseTimer);
          const dz = info.deezerStats || {};
          console.log(`MusicBrainz fertig: ${(info.mbMs / 1000).toFixed(1)}s.`);
          if ((info.deezerMode || args.deezerMode) === 'off') console.log('Deezer: off');
          else console.log(`Deezer optional fertig: ${(info.deezerMs / 1000).toFixed(1)}s (${dz.calls || 0} Calls, ${dz.cacheHits || 0} Cache, ${dz.skips || 0} Skips).`);
        } else if (event === 'discogs-plan') {
          const reasons = info.reasons || {};
          console.log('\nPhase 3/4: Discogs-Hard-Checks');
          console.log(`geplant: ${info.originallyPlanned != null ? info.originallyPlanned : info.total}`);
          if (info.capped) console.log(`ausgefuehrt in diesem Lauf: ${info.total} (begrenzt ${info.capped})`);
          console.log('Gruende:');
          console.log(`  - mb_no_match: ${reasons.mb_no_match || 0}`);
          console.log(`  - mb_uncertain: ${reasons.mb_uncertain || 0}`);
          console.log(`  - catalog_suspected_with_late_mb: ${reasons.catalog_suspected_with_late_mb || 0}`);
          console.log(`  - earlier_source_conflict: ${reasons.earlier_source_conflict || 0}`);
          console.log(`  - full_mode: ${reasons.full_mode || 0}`);
          if (info.warning) console.log(info.warning);
        } else if (event === 'discogs-start') {
          console.log(`Discogs-Hard-Checks: ${info.total} Call(s), ${info.skipped} uebersprungen.`);
        } else if (event === 'discogs-done') {
          console.log(`Discogs-Hard-Checks fertig: ${(info.discogsMs / 1000).toFixed(1)}s.`);
        }
      },
      onAnalyzeStart: (i, total, row) => {
        process.stdout.write(`[${i}/${total}] Analysiere: ${row.title} - ${row.artist} ... `);
      },
      onSpotify: (_i, _total, _row, r) => {
        const method = r.matchMethod || 'none';
        const score = r.similarityScore != null ? ` ~${r.similarityScore.toFixed(2)}` : '';
        const status = r.spotifyFound
          ? `ok [${method}${score}]`
          : r.failed
            ? 'fehlgeschlagen'
            : 'not found';
        console.log(status);
      },
      deezerMode: args.deezerMode,
      discogsMode: args.discogsMode,
      deepOriginalSearch: args.deep,
      reviewAll: args.reviewAll,
    });
  } catch (e) {
    phaseTimer = clearTimer(phaseTimer);
    if (e && e.penalty) {
      console.error(`\n${e.message}`);
      console.error('Es wurde KEINE Review-CSV geschrieben. Pruefe mit "node scripts/check-spotify-token.js".');
      process.exit(1);
    }
    throw e;
  }
  phaseTimer = clearTimer(phaseTimer);

  const { results, stats } = verifyOut;
  console.log('\nPhase 4/4: Review-CSV bauen und Soft-Discogs pruefen');

  const rows = results.map(buildReviewRow);
  const { resumed } = mergeResumeState(rows, args.outputCsv);
  if (resumed > 0) console.log(`Resume: ${resumed} vorhandene Entscheidung(en)/Markierung(en) aus Output uebernommen.`);

  if (args.discogsMode !== 'off') {
    const softStats = await runSoftDiscogsChecks(rows, { mode: args.discogsMode });
    stats.softDiscogs = softStats;
    if (softStats.softPendingBefore > 0) {
      console.log(
        `Soft-Discogs: pending vorher=${softStats.softPendingBefore}, geprueft=${softStats.checked}, ` +
          `freigegeben=${softStats.autoAcceptedSoftChecked}, review=${softStats.reviewNeededAfterDiscogs}, ` +
          `weiter pending=${softStats.stillPending}`
      );
      if (softStats.aborted) console.log('Soft-Discogs: wegen Rate-Limit abgebrochen; Rest bleibt pending.');
    }
  }

  saveRows(args.outputCsv, rows);
  console.log(`Review-CSV geschrieben: ${args.outputCsv}`);

  const preReviewSummary = computeSummary(rows);
  console.log(
    `Review-Status: upload-ready=${preReviewSummary.autoDecided}, offen=${preReviewSummary.manualReviewsOpen}, ` +
      `upload-blockiert=${preReviewSummary.uploadBlocked}`
  );

  if (args.interactive) {
    console.log('\nInteraktive Reviews');
    await runInteractiveReview(rows, args.outputCsv, { reviewAll: args.reviewAll });
  } else {
    console.log('Interaktiver Review uebersprungen (--no-interactive).');
  }

  printSummary({ rows, results, stats, inputs, outputCsv: args.outputCsv, tScript });
  const pending = rows.filter(isOpenReview).length;
  if (pending > 0) {
    console.log(`Naechster Schritt: ${pending} offene Review-Zeile(n) spaeter weiter bearbeiten oder final_year manuell fuellen.`);
  } else {
    console.log('Naechster Schritt: upload-song-pool.js kann mit dieser Review-CSV arbeiten.');
  }
}

main().catch((e) => {
  console.error('\nFatal error:', e && e.message ? e.message : e);
  process.exit(1);
});
