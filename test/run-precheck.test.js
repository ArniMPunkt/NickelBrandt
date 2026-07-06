'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  parsePrecheckArgs,
  runPrecheckCli,
} = require('../scripts/lib/precheck/run-precheck');

function makeDeps(overrides = {}) {
  const calls = {
    applyListenBrainzAutoAccepts: 0,
    enrichOpenReviewsWithListenBrainz: 0,
    loadEnv: 0,
    printSummary: 0,
    runInteractiveReview: 0,
    runSoftDiscogsChecks: 0,
    verifyOptions: null,
    writeCsv: null,
  };
  const deps = {
    applyListenBrainzAutoAccepts: (rows, options) => {
      calls.applyListenBrainzAutoAccepts += 1;
      return {
        mode: options.mode,
        candidates: 1,
        accepted: 1,
        skipped: 0,
        skippedReasons: {},
      };
    },
    buildReviewRow: (result) => ({
      title: result.title,
      artist: result.artist,
      status: 'auto_accepted_mb',
      final_year: '1984',
      mb_year: '1984',
      notes: '',
    }),
    compareRows: () => 0,
    computeSummary: () => ({
      autoDecided: 1,
      manualReviewsOpen: 0,
      uploadBlocked: 0,
    }),
    console: {
      log: () => {},
      error: () => {},
    },
    hydrateInputDeezerFromOutput: () => 0,
    isOpenReview: (row) => ['review_needed', 'review_needed_after_discogs', 'soft_discogs_pending'].includes(row.status),
    loadEnv: () => {
      calls.loadEnv += 1;
    },
    loadSmartInputCsv: () => [{ title: 'Song', artist: 'Artist' }],
    mergeResumeState: () => ({ resumed: 0 }),
    printSummary: (summary) => {
      calls.printSummary += 1;
      calls.printSummaryArgs = summary;
    },
    runInteractiveReview: async () => {
      calls.runInteractiveReview += 1;
    },
    runSoftDiscogsChecks: async () => {
      calls.runSoftDiscogsChecks += 1;
      return {
        softPendingBefore: 0,
        checked: 0,
        autoAcceptedSoftChecked: 0,
        reviewNeededAfterDiscogs: 0,
        stillPending: 0,
      };
    },
    enrichOpenReviewsWithListenBrainz: async (rows, options) => {
      calls.enrichOpenReviewsWithListenBrainz += 1;
      return {
        mode: options.mode,
        targetRows: 1,
        checked: 1,
        skippedNoToken: 0,
        errors: 0,
        recommendationCounts: { likely_accept_existing_mb: 1 },
        yearSignalCounts: { same_year: 1 },
      };
    },
    stdin: { isTTY: false },
    verifySongs: async (_inputs, options) => {
      calls.verifyOptions = options;
      return {
        results: [{ title: 'Song', artist: 'Artist' }],
        stats: {
          deezer: { mode: options.deezerMode },
          discogs: { planned: 0 },
          timings: {},
        },
      };
    },
    writeCsvObjects: (filePath, headers, rows) => {
      calls.writeCsv = { filePath, headers, rows };
    },
    ...overrides,
  };
  deps.calls = calls;
  return deps;
}

test('precheck-song-pool.js is a thin CLI entry', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'precheck-song-pool.js'),
    'utf8'
  );
  const meaningfulLines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  assert.match(source, /^#!\/usr\/bin\/env node/);
  assert.match(source, /runPrecheckCli\(process\.argv\.slice\(2\)\)/);
  assert.doesNotMatch(source, /verifySongs|buildReviewRow|loadSmartInputCsv|runSoftDiscogsChecks/);
  assert.ok(meaningfulLines.length <= 8);
});

test('runPrecheckCli validates missing arguments with usage text', async () => {
  await assert.rejects(
    () => runPrecheckCli([], makeDeps()),
    /Usage: node scripts\/precheck-song-pool\.js/
  );
});

test('parsePrecheckArgs supports current CLI flags', () => {
  const args = parsePrecheckArgs([
    'input.csv',
    'output.csv',
    '--deezer=off',
    '--discogs=needed',
    '--listenbrainz=needed',
    '--lb-auto-accept=safe',
    '--no-interactive',
  ]);

  assert.equal(args.inputCsv, 'input.csv');
  assert.equal(args.outputCsv, 'output.csv');
  assert.equal(args.deezerMode, 'off');
  assert.equal(args.discogsMode, 'needed');
  assert.equal(args.listenbrainzMode, 'needed');
  assert.equal(args.lbAutoAcceptMode, 'safe');
  assert.equal(args.interactive, false);
});

test('parsePrecheckArgs keeps ListenBrainz and LB auto-accept off by default', () => {
  const args = parsePrecheckArgs(['input.csv', 'output.csv']);

  assert.equal(args.listenbrainzMode, 'off');
  assert.equal(args.lbAutoAcceptMode, 'off');
});

test('runPrecheckCli forwards parsed options without executing real source modules', async () => {
  const deps = makeDeps();
  const result = await runPrecheckCli([
    'input.csv',
    'output.csv',
    '--no-interactive',
    '--deezer=off',
    '--discogs=needed',
    '--listenbrainz=needed',
    '--lb-auto-accept=safe',
  ], deps);

  assert.equal(result.args.deezerMode, 'off');
  assert.equal(result.args.discogsMode, 'needed');
  assert.equal(result.args.listenbrainzMode, 'needed');
  assert.equal(result.args.lbAutoAcceptMode, 'safe');
  assert.equal(deps.calls.verifyOptions.deezerMode, 'off');
  assert.equal(deps.calls.verifyOptions.discogsMode, 'needed');
  assert.equal(deps.calls.verifyOptions.reviewAll, false);
  assert.equal(deps.calls.runSoftDiscogsChecks, 1);
  assert.equal(deps.calls.enrichOpenReviewsWithListenBrainz, 1);
  assert.equal(deps.calls.applyListenBrainzAutoAccepts, 1);
  assert.equal(deps.calls.runInteractiveReview, 0);
  assert.equal(deps.calls.writeCsv.filePath, 'output.csv');
});

test('listenbrainz=off does not call LB enrichment or LB auto-accept implementation', async () => {
  const deps = makeDeps();
  const result = await runPrecheckCli([
    'input.csv',
    'output.csv',
    '--no-interactive',
    '--discogs=off',
  ], deps);

  assert.equal(result.args.listenbrainzMode, 'off');
  assert.equal(result.args.lbAutoAcceptMode, 'off');
  assert.equal(deps.calls.enrichOpenReviewsWithListenBrainz, 0);
  assert.equal(deps.calls.applyListenBrainzAutoAccepts, 0);
  assert.equal(result.stats.listenBrainz.mode, 'off');
  assert.equal(result.stats.listenBrainzAutoAccept.mode, 'off');
});

test('lb-auto-accept=off does not apply LB auto accepts even when ListenBrainz enrichment runs', async () => {
  const deps = makeDeps();
  const result = await runPrecheckCli([
    'input.csv',
    'output.csv',
    '--no-interactive',
    '--discogs=off',
    '--listenbrainz=needed',
    '--lb-auto-accept=off',
  ], deps);

  assert.equal(deps.calls.enrichOpenReviewsWithListenBrainz, 1);
  assert.equal(deps.calls.applyListenBrainzAutoAccepts, 0);
  assert.equal(result.stats.listenBrainz.mode, 'needed');
  assert.equal(result.stats.listenBrainzAutoAccept.mode, 'off');
});

test('review-song-pool.js remains independent from run-precheck', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'review-song-pool.js'),
    'utf8'
  );

  assert.doesNotMatch(source, /run-precheck|runPrecheck/);
});
