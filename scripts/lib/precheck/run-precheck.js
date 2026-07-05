'use strict';

const path = require('path');
const { loadEnv, writeCsvObjects } = require('../util');
const { verifySongs } = require('../verify-songs');
const { buildReviewRow } = require('./build-review-row');
const { hydrateInputDeezerFromOutput, loadSmartInputCsv } = require('./load-smart-input-csv');
const { computeSummary, printSummary } = require('./report');
const { mergeResumeState } = require('./resume-state');
const {
  COLUMNS,
  COLUMNS_WITH_LISTENBRAINZ,
} = require('./review-schema');
const { compareRows, isOpenReview } = require('./review-queue');
const { runSoftDiscogsChecks } = require('./soft-discogs-checks');
const {
  enrichOpenReviewsWithListenBrainz,
} = require('./listenbrainz-review-enrichment');
const {
  applyListenBrainzAutoAccepts,
} = require('./apply-listenbrainz-auto-accepts');
const { runInteractiveReview } = require('./interactive-review');

const USAGE =
  'Usage: node scripts/precheck-song-pool.js <inputCsvPath> <outputCsvPath> [--interactive|--no-interactive] [--review-all] [--deezer=needed|full|off] [--discogs=needed|full|off] [--listenbrainz=needed|off] [--lb-auto-accept=safe|off] [--deep]';

function noStackError(message) {
  const error = new Error(message);
  error.stack = message;
  return error;
}

function usageError(message) {
  return noStackError(message ? `${message}\n${USAGE}` : USAGE);
}

function parsePrecheckArgs(argv) {
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
      if (!['needed', 'full', 'off'].includes(mode)) throw usageError(`Unknown Deezer mode: ${mode}`);
      args.deezerMode = mode;
    }
    else if (arg.startsWith('--discogs=')) {
      const mode = arg.slice('--discogs='.length);
      if (!['needed', 'full', 'off'].includes(mode)) throw usageError(`Unknown Discogs mode: ${mode}`);
      args.discogsMode = mode;
    }
    else if (arg.startsWith('--listenbrainz=')) {
      const mode = arg.slice('--listenbrainz='.length);
      if (!['needed', 'off'].includes(mode)) throw usageError(`Unknown ListenBrainz mode: ${mode}`);
      args.listenbrainzMode = mode;
    }
    else if (arg.startsWith('--lb-auto-accept=')) {
      const mode = arg.slice('--lb-auto-accept='.length);
      if (!['safe', 'off'].includes(mode)) throw usageError(`Unknown LB auto-accept mode: ${mode}`);
      args.lbAutoAcceptMode = mode;
    }
    else if (arg.startsWith('-')) throw usageError(`Unknown option: ${arg}`);
    else if (!args.inputCsv) args.inputCsv = arg;
    else if (!args.outputCsv) args.outputCsv = arg;
    else throw usageError(`Unknown argument: ${arg}`);
  }
  return args;
}

function resolveCsvPath(filePath) {
  return path.resolve(process.cwd(), filePath);
}

function assertDistinctPaths(inputCsv, outputCsv) {
  const inPath = resolveCsvPath(inputCsv);
  const outPath = resolveCsvPath(outputCsv);
  if (inPath.toLowerCase() === outPath.toLowerCase()) {
    throw noStackError(
      '\nABBRUCH: Input- und Output-CSV duerfen nicht identisch sein.\n' +
        `Input:  ${inputCsv}\n` +
        `Output: ${outputCsv}\n` +
        'Bitte eine neue Output-Datei nutzen, z. B. scripts/review_<name>_smart.csv.'
    );
  }
}

function validatePrecheckArgs(args) {
  if (!args.inputCsv || !args.outputCsv) throw usageError();
  assertDistinctPaths(args.inputCsv, args.outputCsv);
  if (args.lbAutoAcceptMode === 'safe' && args.listenbrainzMode !== 'needed') {
    throw noStackError('--lb-auto-accept=safe requires --listenbrainz=needed.');
  }
}

function clearTimer(timer) {
  if (timer) clearInterval(timer);
  return null;
}

function defaultListenBrainzStats() {
  return {
    mode: 'off',
    targetRows: 0,
    checked: 0,
    skippedNoToken: 0,
    errors: 0,
    recommendationCounts: {},
    yearSignalCounts: {},
  };
}

function defaultListenBrainzAutoAcceptStats() {
  return {
    mode: 'off',
    candidates: 0,
    accepted: 0,
    skipped: 0,
    skippedReasons: {},
  };
}

function defaultDeps() {
  return {
    applyListenBrainzAutoAccepts,
    buildReviewRow,
    compareRows,
    computeSummary,
    console,
    hydrateInputDeezerFromOutput,
    isOpenReview,
    loadEnv,
    loadSmartInputCsv,
    mergeResumeState,
    printSummary,
    runInteractiveReview,
    runSoftDiscogsChecks,
    enrichOpenReviewsWithListenBrainz,
    stdin: process.stdin,
    verifySongs,
    writeCsvObjects,
  };
}

function depsWithDefaults(overrides = {}) {
  return { ...defaultDeps(), ...overrides };
}

function saveRows(outputCsv, rows, columns = COLUMNS, deps = defaultDeps()) {
  deps.writeCsvObjects(outputCsv, columns, rows.slice().sort(deps.compareRows));
}

async function runPrecheck(options, dependencyOverrides = {}) {
  const args = { ...parsePrecheckArgs([]), ...options };
  validatePrecheckArgs(args);

  const deps = depsWithDefaults(dependencyOverrides);
  const log = (...parts) => deps.console.log(...parts);
  const tScript = Date.now();
  deps.loadEnv(path.join(__dirname, '..', '..', '.env'));

  const outputColumns = args.listenbrainzMode === 'needed' ? COLUMNS_WITH_LISTENBRAINZ : COLUMNS;

  if (args.interactive && !deps.stdin.isTTY) {
    log('Kein interaktives Terminal erkannt - laufe als --no-interactive.');
    args.interactive = false;
  }

  log('\nPhase 1/4: Spotify-Playlistdaten laden');
  const inputs = deps.loadSmartInputCsv(args.inputCsv);
  const hydratedDeezer = deps.hydrateInputDeezerFromOutput(inputs, args.outputCsv);
  log(`Geladen: ${inputs.length} Song-Zeile(n) aus ${args.inputCsv}`);
  log(
      `Modus: ${args.interactive ? 'interaktiv (Default)' : 'nicht-interaktiv'}${args.reviewAll ? ' + review-all' : ''}, ` +
      `Discogs=${args.discogsMode}, ListenBrainz=${args.listenbrainzMode}, LB-Auto=${args.lbAutoAcceptMode}${args.deep ? ', deep' : ''}`
  );
  if (args.deezerMode === 'off') log('Deezer: off');
  else log(`Deezer: optionaler Kompatibilitaetslauf (${args.deezerMode})${hydratedDeezer ? `, aus Output uebernommen: ${hydratedDeezer}` : ''}`);

  let verifyOut;
  let phaseTimer = null;
  let phaseStartedAt = 0;
  try {
    verifyOut = await deps.verifySongs(inputs, {
      onPhase: (event, info) => {
        if (event === 'credits-start') log(`Spotify-Resolver: ISRC-Kontext fuer ${info.total} Song(s) vorbereiten...`);
        else if (event === 'credits-progress') log(`  Resolver-Runde ${info.round}: ${info.resolved}/${info.total}`);
        else if (event === 'credits-done') log(`Spotify-Resolver vorbereitet: ${info.resolved}/${info.total}. Spotify-Abgleich startet.\n`);
        else if (event === 'years-start') {
          log('\nPhase 2/4: MusicBrainz pruefen');
          log(`MusicBrainz: pruefe Aufnahmejahre fuer ${info.total} Song(s).`);
          if ((info.deezerMode || args.deezerMode) === 'off') log('Deezer: off');
          else log(`Deezer: optionaler Kompatibilitaetslauf (${info.deezerMode || args.deezerMode}).`);
          phaseStartedAt = Date.now();
          phaseTimer = clearTimer(phaseTimer);
          phaseTimer = setInterval(() => {
            const seconds = Math.round((Date.now() - phaseStartedAt) / 1000);
            log(`  Noch in Phase 2: MusicBrainz prueft seit ${seconds}s ...`);
          }, 15000);
        } else if (event === 'years-done') {
          phaseTimer = clearTimer(phaseTimer);
          const dz = info.deezerStats || {};
          log(`MusicBrainz fertig: ${(info.mbMs / 1000).toFixed(1)}s.`);
          if ((info.deezerMode || args.deezerMode) === 'off') log('Deezer: off');
          else log(`Deezer optional fertig: ${(info.deezerMs / 1000).toFixed(1)}s (${dz.calls || 0} Calls, ${dz.cacheHits || 0} Cache, ${dz.skips || 0} Skips).`);
        } else if (event === 'discogs-plan') {
          const reasons = info.reasons || {};
          log('\nPhase 3/4: Discogs-Hard-Checks');
          log(`geplant: ${info.originallyPlanned != null ? info.originallyPlanned : info.total}`);
          if (info.capped) log(`ausgefuehrt in diesem Lauf: ${info.total} (begrenzt ${info.capped})`);
          log('Gruende:');
          log(`  - mb_no_match: ${reasons.mb_no_match || 0}`);
          log(`  - mb_uncertain: ${reasons.mb_uncertain || 0}`);
          log(`  - catalog_suspected_with_late_mb: ${reasons.catalog_suspected_with_late_mb || 0}`);
          log(`  - earlier_source_conflict: ${reasons.earlier_source_conflict || 0}`);
          log(`  - full_mode: ${reasons.full_mode || 0}`);
          if (info.warning) log(info.warning);
        } else if (event === 'discogs-start') {
          log(`Discogs-Hard-Checks: ${info.total} Call(s), ${info.skipped} uebersprungen.`);
        } else if (event === 'discogs-done') {
          log(`Discogs-Hard-Checks fertig: ${(info.discogsMs / 1000).toFixed(1)}s.`);
        }
      },
      onAnalyzeStart: (i, total, row) => {
        if (deps.stdout && deps.stdout.write) {
          deps.stdout.write(`[${i}/${total}] Analysiere: ${row.title} - ${row.artist} ... `);
        } else {
          process.stdout.write(`[${i}/${total}] Analysiere: ${row.title} - ${row.artist} ... `);
        }
      },
      onSpotify: (_i, _total, _row, r) => {
        const method = r.matchMethod || 'none';
        const score = r.similarityScore != null ? ` ~${r.similarityScore.toFixed(2)}` : '';
        const status = r.spotifyFound
          ? `ok [${method}${score}]`
          : r.failed
            ? 'fehlgeschlagen'
            : 'not found';
        log(status);
      },
      deezerMode: args.deezerMode,
      discogsMode: args.discogsMode,
      deepOriginalSearch: args.deep,
      reviewAll: args.reviewAll,
    });
  } catch (e) {
    phaseTimer = clearTimer(phaseTimer);
    if (e && e.penalty) {
      throw noStackError(`\n${e.message}\nEs wurde KEINE Review-CSV geschrieben. Pruefe mit "node scripts/check-spotify-token.js".`);
    }
    throw e;
  }
  phaseTimer = clearTimer(phaseTimer);

  const { results, stats } = verifyOut;
  log('\nPhase 4/4: Review-CSV bauen und Soft-Discogs pruefen');

  const rows = results.map(deps.buildReviewRow);
  const { resumed } = deps.mergeResumeState(rows, args.outputCsv);
  if (resumed > 0) log(`Resume: ${resumed} vorhandene Entscheidung(en)/Markierung(en) aus Output uebernommen.`);

  if (args.discogsMode !== 'off') {
    const softStats = await deps.runSoftDiscogsChecks(rows, { mode: args.discogsMode });
    stats.softDiscogs = softStats;
    if (softStats.softPendingBefore > 0) {
      log(
        `Soft-Discogs: pending vorher=${softStats.softPendingBefore}, geprueft=${softStats.checked}, ` +
          `freigegeben=${softStats.autoAcceptedSoftChecked}, review=${softStats.reviewNeededAfterDiscogs}, ` +
          `weiter pending=${softStats.stillPending}`
      );
      if (softStats.aborted) log('Soft-Discogs: wegen Rate-Limit abgebrochen; Rest bleibt pending.');
    }
  }

  if (args.listenbrainzMode === 'needed') {
    stats.listenBrainz = await deps.enrichOpenReviewsWithListenBrainz(rows, {
      mode: args.listenbrainzMode,
    });
  } else {
    stats.listenBrainz = defaultListenBrainzStats();
  }

  if (args.listenbrainzMode === 'needed' && args.lbAutoAcceptMode === 'safe') {
    stats.listenBrainzAutoAccept = deps.applyListenBrainzAutoAccepts(rows, {
      mode: args.lbAutoAcceptMode,
    });
  } else {
    stats.listenBrainzAutoAccept = defaultListenBrainzAutoAcceptStats();
  }

  saveRows(args.outputCsv, rows, outputColumns, deps);
  log(`Review-CSV geschrieben: ${args.outputCsv}`);

  const preReviewSummary = deps.computeSummary(rows);
  log(
    `Review-Status: upload-ready=${preReviewSummary.autoDecided}, offen=${preReviewSummary.manualReviewsOpen}, ` +
      `upload-blockiert=${preReviewSummary.uploadBlocked}`
  );

  if (args.interactive) {
    log('\nInteraktive Reviews');
    await deps.runInteractiveReview(rows, {
      save: () => saveRows(args.outputCsv, rows, outputColumns, deps),
    });
  } else {
    log('Interaktiver Review uebersprungen (--no-interactive).');
  }

  deps.printSummary({ rows, results, stats, inputs, outputCsv: args.outputCsv, tScript });
  const pending = rows.filter(deps.isOpenReview).length;
  if (pending > 0) {
    log(`Naechster Schritt: ${pending} offene Review-Zeile(n) spaeter weiter bearbeiten oder final_year manuell fuellen.`);
  } else {
    log('Naechster Schritt: upload-song-pool.js kann mit dieser Review-CSV arbeiten.');
  }

  return { args, inputs, outputColumns, results, rows, stats };
}

async function runPrecheckCli(argv, dependencyOverrides = {}) {
  const args = parsePrecheckArgs(argv);
  return runPrecheck(args, dependencyOverrides);
}

module.exports = {
  USAGE,
  assertDistinctPaths,
  defaultListenBrainzAutoAcceptStats,
  defaultListenBrainzStats,
  parsePrecheckArgs,
  runPrecheck,
  runPrecheckCli,
  saveRows,
  validatePrecheckArgs,
};
