'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyManualChoice } = require('../scripts/lib/precheck/apply-manual-choice');
const {
  canDefaultAcceptListenBrainzAlternative,
  canDefaultAcceptMbContextWarning,
  choiceForKey,
  defaultChoiceForRow,
  parseManualYear,
  reviewQueue,
} = require('../scripts/lib/precheck/interactive-review');

function row(overrides = {}) {
  return {
    title: 'Review Song',
    artist: 'Review Artist',
    status: 'review_needed',
    mb_year: '2018',
    discogs_year: '',
    listenbrainz_mb_year: '2018',
    listenbrainz_recommendation: 'likely_accept_existing_mb_with_context_warning',
    listenbrainz_context_flags: 'soundtrack_context',
    listenbrainz_version_flags: '',
    notes: 'review_reason: mb_year_suspicious_late; risk_flags: catalog_context+mb_year_suspicious_late',
    final_year: '',
    final_source: '',
    chosen_candidate: '',
    ...overrides,
  };
}

test('Enter accepts likely_accept_existing_mb_with_context_warning when safe for manual confirmation', () => {
  const input = row();
  assert.equal(canDefaultAcceptMbContextWarning(input), true);

  const updated = applyManualChoice(input, defaultChoiceForRow(input));

  assert.equal(updated.final_year, '2018');
  assert.equal(updated.final_source, 'musicbrainz');
  assert.equal(updated.chosen_candidate, '2018');
  assert.equal(updated.status, 'manual_confirmed_mb');
  assert.match(updated.notes, /Manual accept: MB year accepted despite LB->MB context warning\./);
});

test('Enter accepts useful_alternative_mb_year with LB->MB year', () => {
  const input = row({
    mb_year: '2008',
    listenbrainz_mb_year: '1975',
    listenbrainz_recommendation: 'useful_alternative_mb_year',
    listenbrainz_context_flags: '',
  });
  assert.equal(canDefaultAcceptListenBrainzAlternative(input), true);

  const updated = applyManualChoice(input, defaultChoiceForRow(input));

  assert.equal(updated.final_year, '1975');
  assert.equal(updated.final_source, 'listenbrainz_musicbrainz');
  assert.equal(updated.chosen_candidate, '1975');
  assert.equal(updated.status, 'manual_confirmed_mb');
  assert.match(updated.notes, /Manual accept: LB->MB alternative year accepted\./);
});

test('Enter skips manual_conflicting_years without final_year', () => {
  const input = row({
    listenbrainz_recommendation: 'manual_conflicting_years',
    listenbrainz_context_flags: '',
  });
  const updated = applyManualChoice(input, defaultChoiceForRow(input));

  assert.equal(updated.status, 'manual_skipped');
  assert.equal(updated.final_year, '');
});

test('Enter skips manual_version_risk without final_year', () => {
  const input = row({
    listenbrainz_recommendation: 'manual_version_risk',
    listenbrainz_version_flags: 'neuaufnahme',
  });
  const updated = applyManualChoice(input, defaultChoiceForRow(input));

  assert.equal(updated.status, 'manual_skipped');
  assert.equal(updated.final_year, '');
});

test('key m accepts MusicBrainz year', () => {
  const updated = applyManualChoice(row(), choiceForKey(row(), 'm'));

  assert.equal(updated.final_year, '2018');
  assert.equal(updated.final_source, 'musicbrainz');
});

test('key l accepts LB->MB year', () => {
  const input = row({ listenbrainz_mb_year: '1975' });
  const updated = applyManualChoice(input, choiceForKey(input, 'l'));

  assert.equal(updated.final_year, '1975');
  assert.equal(updated.final_source, 'listenbrainz_musicbrainz');
});

test('key d accepts Discogs year', () => {
  const input = row({ discogs_year: '1975' });
  const updated = applyManualChoice(input, choiceForKey(input, 'd'));

  assert.equal(updated.final_year, '1975');
  assert.equal(updated.final_source, 'discogs');
});

test('manual year parser accepts plausible four-digit years and rejects invalid values', () => {
  assert.equal(parseManualYear('1975', 2026), 1975);
  assert.equal(parseManualYear('1899', 2026), null);
  assert.equal(parseManualYear('2028', 2026), null);
  assert.equal(parseManualYear('75', 2026), null);
  assert.equal(parseManualYear('9999', 2026), null);
});

test('upload-ready rows are not in interactive review queue', () => {
  const queue = reviewQueue([
    row({ status: 'auto_accepted_mb', final_year: '1984' }),
    row({ status: 'auto_accepted_mb_soft_checked', final_year: '1984' }),
    row({ status: 'auto_accepted_mb_lb_confirmed', final_year: '1984' }),
    row({ status: 'manual_confirmed_mb', final_year: '1984' }),
    row({ status: 'review_needed' }),
    row({ status: 'review_needed_after_discogs' }),
    row({ status: 'soft_discogs_pending' }),
  ]);

  assert.deepEqual(queue.map((item) => item.status), [
    'review_needed',
    'review_needed_after_discogs',
    'soft_discogs_pending',
  ]);
});
