'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LB_AUTO_ACCEPT_STATUS,
  applyListenBrainzAutoAccepts,
  safeAcceptBlockReason,
} = require('../scripts/lib/precheck/apply-listenbrainz-auto-accepts');
const {
  buildAnalysisReport,
  computeSummary,
} = require('../scripts/lib/precheck/report');

function row(overrides = {}) {
  return {
    title: 'Clean Song',
    artist: 'Clean Artist',
    status: 'review_needed',
    mb_year: '1984',
    listenbrainz_mb_year: '1984',
    listenbrainz_recommendation: 'likely_accept_existing_mb',
    listenbrainz_context_flags: '',
    listenbrainz_version_flags: '',
    notes: 'review_reason: mb_uncertain; risk_flags: mb_uncertain',
    final_year: '',
    chosen_candidate: '',
    ...overrides,
  };
}

test('safe off leaves rows unchanged', () => {
  const rows = [row()];
  const before = JSON.parse(JSON.stringify(rows));
  const stats = applyListenBrainzAutoAccepts(rows, { mode: 'off' });

  assert.deepEqual(rows, before);
  assert.equal(stats.mode, 'off');
  assert.equal(stats.candidates, 1);
  assert.equal(stats.accepted, 0);
});

test('safe on accepts clean likely_accept_existing_mb with matching MB and LB years', () => {
  const rows = [row()];
  const stats = applyListenBrainzAutoAccepts(rows, { mode: 'safe' });

  assert.equal(stats.accepted, 1);
  assert.equal(stats.skipped, 0);
  assert.equal(rows[0].status, LB_AUTO_ACCEPT_STATUS);
  assert.equal(rows[0].final_year, '1984');
  assert.equal(rows[0].final_source, 'musicbrainz');
  assert.equal(rows[0].chosen_candidate, '1984');
  assert.equal(rows[0].review_reason, 'lb_mb_confirmed');
  assert.match(rows[0].notes, /Auto accepted: ListenBrainz->MusicBrainz confirmed existing MusicBrainz year\./);
});

test('context warning is not accepted', () => {
  const rows = [row({
    listenbrainz_recommendation: 'likely_accept_existing_mb_with_context_warning',
    listenbrainz_context_flags: 'soundtrack_context+noisy_release_context',
  })];
  const stats = applyListenBrainzAutoAccepts(rows, { mode: 'safe' });

  assert.equal(stats.candidates, 0);
  assert.equal(stats.accepted, 0);
  assert.equal(rows[0].status, 'review_needed');
  assert.equal(rows[0].final_year, '');
});

test('useful alternative year is not accepted', () => {
  const rows = [row({
    listenbrainz_recommendation: 'useful_alternative_mb_year',
    listenbrainz_mb_year: '1975',
  })];
  const stats = applyListenBrainzAutoAccepts(rows, { mode: 'safe' });

  assert.equal(stats.candidates, 0);
  assert.equal(stats.accepted, 0);
  assert.equal(rows[0].status, 'review_needed');
  assert.equal(rows[0].final_year, '');
});

test('version flags block safe accept', () => {
  const rows = [row({ listenbrainz_version_flags: 'neuaufnahme' })];
  const stats = applyListenBrainzAutoAccepts(rows, { mode: 'safe' });

  assert.equal(stats.candidates, 1);
  assert.equal(stats.accepted, 0);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.skippedReasons.version_flags, 1);
  assert.equal(rows[0].status, 'review_needed');
  assert.equal(rows[0].final_year, '');
});

test('discogs_earlier_than_mb blocks safe accept', () => {
  const rows = [row({
    notes: 'review_reason: discogs_earlier_than_mb; risk_flags: discogs_earlier_than_mb+mb_year_suspicious_late',
  })];
  const stats = applyListenBrainzAutoAccepts(rows, { mode: 'safe' });

  assert.equal(stats.candidates, 1);
  assert.equal(stats.accepted, 0);
  assert.equal(stats.skippedReasons.discogs_earlier_than_mb, 1);
  assert.equal(rows[0].final_year, '');
});

test('matching recommendation still blocks when MB and LB years differ', () => {
  const rows = [row({ listenbrainz_mb_year: '1985' })];
  const stats = applyListenBrainzAutoAccepts(rows, { mode: 'safe' });

  assert.equal(safeAcceptBlockReason(rows[0]), 'mb_lb_year_mismatch');
  assert.equal(stats.accepted, 0);
  assert.equal(rows[0].final_year, '');
});

test('summary and report count lb confirmed status as upload-ready', () => {
  const rows = [
    row(),
    row({
      title: 'Context Song',
      listenbrainz_recommendation: 'likely_accept_existing_mb_with_context_warning',
      listenbrainz_context_flags: 'deluxe_context',
    }),
  ];
  const autoStats = applyListenBrainzAutoAccepts(rows, { mode: 'safe' });
  const summary = computeSummary(rows);
  const report = buildAnalysisReport(rows, summary, { listenBrainzAutoAccept: autoStats }, 0);

  assert.equal(summary.statuses.auto_accepted_mb_lb_confirmed, 1);
  assert.equal(summary.uploadReadyLbConfirmed, 1);
  assert.equal(summary.autoDecided, 1);
  assert.equal(summary.manualReviewsOpen, 1);
  assert.match(report, /LB Auto-Accepts:/);
  assert.match(report, /auto_accepted_mb_lb_confirmed: 1/);
  assert.match(report, /MusicBrainz \+ LB->MB bestaetigt: 1/);
});
