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
const { loadEnv, writeCsvObjects } = require('./lib/util');
const { verifySongs } = require('./lib/verify-songs');
const { buildReviewRow } = require('./lib/precheck/build-review-row');
const { hydrateInputDeezerFromOutput, loadSmartInputCsv } = require('./lib/precheck/load-smart-input-csv');
const { computeSummary, printSummary } = require('./lib/precheck/report');
const { mergeResumeState } = require('./lib/precheck/resume-state');
const {
  COLUMNS,
  COLUMNS_WITH_LISTENBRAINZ,
} = require('./lib/precheck/review-schema');
const { compareRows, isOpenReview } = require('./lib/precheck/review-queue');
const { runSoftDiscogsChecks } = require('./lib/precheck/soft-discogs-checks');
const {
  enrichOpenReviewsWithListenBrainz,
} = require('./lib/precheck/listenbrainz-review-enrichment');
const {
  applyListenBrainzAutoAccepts,
} = require('./lib/precheck/apply-listenbrainz-auto-accepts');
const { runInteractiveReview } = require('./lib/precheck/interactive-review');

function parseArgs(argv) {
  const args = {
    inputCsv: null,
    outputCsv: null,
    interactive: true,
    reviewAll: false,
    deezerMode: 'needed',
    discogsMode: 'needed',
    listenbrainzMode: 'off',
    lbAutoAcceptMode: 'off',
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
    else if (arg.startsWith('--listenbrainz=')) {
      const mode = arg.slice('--listenbrainz='.length);
      if (!['needed', 'off'].includes(mode)) throw new Error(`Unknown ListenBrainz mode: ${mode}`);
      args.listenbrainzMode = mode;
    }
    else if (arg.startsWith('--lb-auto-accept=')) {
      const mode = arg.slice('--lb-auto-accept='.length);
      if (!['safe', 'off'].includes(mode)) throw new Error(`Unknown LB auto-accept mode: ${mode}`);
      args.lbAutoAcceptMode = mode;
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
    'Usage: node scripts/precheck-song-pool.js <inputCsvPath> <outputCsvPath> [--interactive|--no-interactive] [--review-all] [--deezer=needed|full|off] [--discogs=needed|full|off] [--listenbrainz=needed|off] [--lb-auto-accept=safe|off] [--deep]'
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

function saveRows(outputCsv, rows, columns = COLUMNS) {
  writeCsvObjects(outputCsv, columns, rows.slice().sort(compareRows));
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
  if (args.lbAutoAcceptMode === 'safe' && args.listenbrainzMode !== 'needed') {
    console.error('--lb-auto-accept=safe requires --listenbrainz=needed.');
    process.exit(1);
  }
  const outputColumns = args.listenbrainzMode === 'needed' ? COLUMNS_WITH_LISTENBRAINZ : COLUMNS;

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
      `Discogs=${args.discogsMode}, ListenBrainz=${args.listenbrainzMode}, LB-Auto=${args.lbAutoAcceptMode}${args.deep ? ', deep' : ''}`
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

  stats.listenBrainz = await enrichOpenReviewsWithListenBrainz(rows, {
    mode: args.listenbrainzMode,
  });
  stats.listenBrainzAutoAccept = applyListenBrainzAutoAccepts(rows, {
    mode: args.listenbrainzMode === 'needed' ? args.lbAutoAcceptMode : 'off',
  });

  saveRows(args.outputCsv, rows, outputColumns);
  console.log(`Review-CSV geschrieben: ${args.outputCsv}`);

  const preReviewSummary = computeSummary(rows);
  console.log(
    `Review-Status: upload-ready=${preReviewSummary.autoDecided}, offen=${preReviewSummary.manualReviewsOpen}, ` +
      `upload-blockiert=${preReviewSummary.uploadBlocked}`
  );

  if (args.interactive) {
    console.log('\nInteraktive Reviews');
    await runInteractiveReview(rows, {
      save: () => saveRows(args.outputCsv, rows, outputColumns),
    });
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
