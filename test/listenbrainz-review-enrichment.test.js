'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  enrichOpenReviewsWithListenBrainz,
} = require('../scripts/lib/precheck/listenbrainz-review-enrichment');
const {
  COLUMNS,
  COLUMNS_WITH_LISTENBRAINZ,
  LISTENBRAINZ_COLUMNS,
} = require('../scripts/lib/precheck/review-schema');
const {
  buildAnalysisReport,
  computeSummary,
} = require('../scripts/lib/precheck/report');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rows() {
  return [
    {
      title: 'Auto Song',
      artist: 'Auto Artist',
      status: 'auto_accepted_mb',
      mb_year: '1984',
      estimated_year: '1984',
      final_year: '1984',
      chosen_candidate: '1984',
    },
    {
      title: 'Review Song',
      artist: 'Review Artist',
      status: 'review_needed',
      mb_year: '2008',
      estimated_year: '1975',
      discogs_year: '1975',
      final_year: '',
      chosen_candidate: '',
    },
    {
      title: 'After Discogs Song',
      artist: 'After Artist',
      status: 'review_needed_after_discogs',
      mb_year: '1986',
      estimated_year: '1968',
      discogs_year: '1967',
      final_year: '',
      chosen_candidate: '1986',
    },
    {
      title: 'Soft Pending Song',
      artist: 'Soft Artist',
      status: 'soft_discogs_pending',
      mb_year: '2017',
      estimated_year: '2017',
      final_year: '',
      chosen_candidate: '2017',
    },
  ];
}

function analysisFor(row) {
  if (row.title === 'Review Song') {
    return {
      listenbrainz_match_status: 'ok',
      listenbrainz_year_signal: 'alternative_earlier_than_current_mb',
      listenbrainz_context_flags: '',
      listenbrainz_version_flags: '',
      listenbrainz_recommendation: 'useful_alternative_mb_year',
      listenbrainz_mb_year: '1975',
      listenbrainz_mb_year_source: 'recording_first_release_date',
      listenbrainz_year_delta_vs_current_mb: '-33',
      listenbrainz_year_delta_vs_spotify: '0',
      listenbrainz_recording_mbid: 'recording-1',
      listenbrainz_recording_name: 'Review Song',
      listenbrainz_release_mbid: 'release-1',
      listenbrainz_release_name: 'Original Album',
    };
  }
  if (row.title === 'After Discogs Song') {
    return {
      listenbrainz_match_status: 'ok',
      listenbrainz_year_signal: 'confirms_current_mb',
      listenbrainz_context_flags: 'soundtrack_context+noisy_release_context',
      listenbrainz_version_flags: '',
      listenbrainz_recommendation: 'likely_accept_existing_mb_with_context_warning',
      listenbrainz_mb_year: '1986',
      listenbrainz_mb_year_source: 'recording_first_release_date',
      listenbrainz_year_delta_vs_current_mb: '0',
      listenbrainz_year_delta_vs_spotify: '18',
      listenbrainz_recording_mbid: 'recording-2',
      listenbrainz_recording_name: 'After Discogs Song',
      listenbrainz_release_mbid: 'release-2',
      listenbrainz_release_name: 'Soundtrack',
    };
  }
  return {
    listenbrainz_match_status: 'ok',
    listenbrainz_year_signal: 'confirms_current_mb_and_spotify',
    listenbrainz_context_flags: '',
    listenbrainz_version_flags: 'neuaufnahme',
    listenbrainz_recommendation: 'manual_version_risk',
    listenbrainz_mb_year: '2017',
    listenbrainz_mb_year_source: 'recording_first_release_date',
    listenbrainz_year_delta_vs_current_mb: '0',
    listenbrainz_year_delta_vs_spotify: '0',
    listenbrainz_recording_mbid: 'recording-3',
    listenbrainz_recording_name: 'Soft Pending Song',
    listenbrainz_release_mbid: 'release-3',
    listenbrainz_release_name: 'Single',
  };
}

test('listenbrainz=off leaves rows and base CSV columns unchanged', async () => {
  const inputRows = rows();
  const before = clone(inputRows);
  const stats = await enrichOpenReviewsWithListenBrainz(inputRows, { mode: 'off' });

  assert.deepEqual(inputRows, before);
  assert.equal(stats.checked, 0);
  assert.equal(COLUMNS.includes('listenbrainz_recommendation'), false);
  assert.equal(COLUMNS_WITH_LISTENBRAINZ.includes('listenbrainz_recommendation'), true);
});

test('listenbrainz=needed enriches only open review rows', async () => {
  const inputRows = rows();
  const beforeStatuses = inputRows.map((row) => row.status);
  const beforeFinalYears = inputRows.map((row) => row.final_year);
  const beforeSummary = computeSummary(inputRows);

  const stats = await enrichOpenReviewsWithListenBrainz(inputRows, {
    mode: 'needed',
    requireToken: false,
    analyzer: async (row) => analysisFor(row),
  });
  const afterSummary = computeSummary(inputRows);

  assert.equal(stats.checked, 3);
  assert.equal(stats.quicklyConfirmable, 1);
  assert.equal(stats.usefulAlternativeYears, 1);
  assert.equal(stats.manualReview, 1);
  assert.deepEqual(inputRows.map((row) => row.status), beforeStatuses);
  assert.deepEqual(inputRows.map((row) => row.final_year), beforeFinalYears);
  assert.deepEqual(afterSummary.statuses, beforeSummary.statuses);
  assert.equal(inputRows[0].listenbrainz_recommendation, undefined);
  assert.equal(inputRows[1].listenbrainz_recommendation, 'useful_alternative_mb_year');
  assert.equal(inputRows[2].listenbrainz_recommendation, 'likely_accept_existing_mb_with_context_warning');
  assert.equal(inputRows[3].listenbrainz_recommendation, 'manual_version_risk');
});

test('missing ListenBrainz token skips without crashing or changing rows', async () => {
  const oldToken = process.env.LISTENBRAINZ_USER_TOKEN;
  delete process.env.LISTENBRAINZ_USER_TOKEN;
  const inputRows = rows();
  const before = clone(inputRows);

  try {
    const stats = await enrichOpenReviewsWithListenBrainz(inputRows, {
      mode: 'needed',
      analyzer: async () => {
        throw new Error('analyzer should not run without token');
      },
    });

    assert.deepEqual(inputRows, before);
    assert.equal(stats.checked, 0);
    assert.equal(stats.skippedNoToken, 3);
    assert.equal(stats.errorOrSkipped, 3);
  } finally {
    if (oldToken == null) delete process.env.LISTENBRAINZ_USER_TOKEN;
    else process.env.LISTENBRAINZ_USER_TOKEN = oldToken;
  }
});

test('report contains ListenBrainz recommendation distribution', async () => {
  const inputRows = rows();
  const stats = await enrichOpenReviewsWithListenBrainz(inputRows, {
    mode: 'needed',
    requireToken: false,
    analyzer: async (row) => analysisFor(row),
  });
  const report = buildAnalysisReport(inputRows, computeSummary(inputRows), { listenBrainz: stats }, 0);

  assert.match(report, /ListenBrainz->MusicBrainz Review-Empfehlungen:/);
  assert.match(report, /Recommendation-Verteilung:/);
  assert.match(report, /useful_alternative_mb_year: 1/);
  assert.match(report, /likely_accept_existing_mb_with_context_warning: 1/);
  assert.match(report, /manual_version_risk: 1/);
});

test('all ListenBrainz columns are present in extended schema', () => {
  for (const column of LISTENBRAINZ_COLUMNS) {
    assert.equal(COLUMNS_WITH_LISTENBRAINZ.includes(column), true, column);
  }
});
