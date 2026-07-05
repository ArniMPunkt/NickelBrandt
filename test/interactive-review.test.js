'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyManualChoice } = require('../scripts/lib/precheck/apply-manual-choice');
const {
  BATCH_LB_ALTERNATIVE_NOTE,
  BATCH_MB_CONTEXT_NOTE,
  applyGroupAction,
  canDefaultAcceptListenBrainzAlternative,
  canDefaultAcceptMbContextWarning,
  choiceForKey,
  defaultChoiceForRow,
  formatGroup,
  getDefaultCandidate,
  groupReviewRows,
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
    listenbrainz_release_name: 'Review Release',
    estimated_year: '2018',
    csv_year: '',
    notes: 'review_reason: mb_year_suspicious_late; risk_flags: catalog_context+mb_year_suspicious_late',
    final_year: '',
    final_source: '',
    chosen_candidate: '',
    ...overrides,
  };
}

test('Enter accepts likely_accept_existing_mb_with_context_warning when MB year is visible default', () => {
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
    estimated_year: '2008',
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

test('Manual recommendation Enter accepts visible default instead of skipping', () => {
  const input = row({
    listenbrainz_recommendation: 'manual_conflicting_years',
    listenbrainz_context_flags: '',
    mb_year: '',
    discogs_year: '1975',
    estimated_year: '1975',
  });
  const candidate = getDefaultCandidate(input);
  assert.equal(candidate.groupKey, 'confirmed_same_year_discogs_spotify');
  assert.equal(candidate.year, '1975');

  const updated = applyManualChoice(input, defaultChoiceForRow(input));

  assert.equal(updated.status, 'manual_confirmed_discogs');
  assert.equal(updated.final_year, '1975');
});

test('Default priority falls back to Spotify estimated year when no external year exists', () => {
  const input = row({
    mb_year: '',
    discogs_year: '',
    listenbrainz_mb_year: '',
    listenbrainz_recommendation: '',
    estimated_year: '2012',
  });
  const candidate = getDefaultCandidate(input);

  assert.equal(candidate.groupKey, 'spotify_fallback_only');
  assert.equal(candidate.year, '2012');
  assert.equal(candidate.source, 'spotify');

  const updated = applyManualChoice(input, defaultChoiceForRow(input));
  assert.equal(updated.status, 'manual_confirmed_spotify');
  assert.equal(updated.final_year, '2012');
});

test('Enter without any available year has no choice and keeps row unchanged', () => {
  const input = row({
    mb_year: '',
    discogs_year: '',
    listenbrainz_mb_year: '',
    listenbrainz_recommendation: '',
    estimated_year: '',
    csv_year: '',
    spotify_album_release_date: '',
  });

  assert.equal(defaultChoiceForRow(input), null);
  assert.equal(choiceForKey(input, ''), null);

  const group = groupReviewRows([input])[0];
  const result = applyGroupAction(group, { type: 'accept_all' });

  assert.equal(result.noDefaultRows.length, 1);
  assert.equal(input.status, 'review_needed');
  assert.equal(input.final_year, '');
});

test('key m/l/d/s still map to explicit manual actions', () => {
  assert.equal(applyManualChoice(row(), choiceForKey(row(), 'm')).final_source, 'musicbrainz');
  assert.equal(applyManualChoice(row({ listenbrainz_mb_year: '1975' }), choiceForKey(row(), 'l')).final_source, 'listenbrainz_musicbrainz');
  assert.equal(applyManualChoice(row({ discogs_year: '1974' }), choiceForKey(row({ discogs_year: '1974' }), 'd')).final_source, 'discogs');

  const skipped = applyManualChoice(row(), choiceForKey(row(), 's'));
  assert.equal(skipped.status, 'manual_skipped');
  assert.equal(skipped.final_year, '');
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
    row({ status: 'excluded_from_pool', final_year: '' }),
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

test('open rows are grouped by ListenBrainz recommendation and default candidate', () => {
  const rows = [
    row({ listenbrainz_recommendation: 'likely_accept_existing_mb_with_context_warning' }),
    row({
      listenbrainz_recommendation: 'useful_alternative_mb_year',
      listenbrainz_mb_year: '1975',
    }),
    row({
      listenbrainz_recommendation: '',
      mb_year: '',
      discogs_year: '',
      listenbrainz_mb_year: '',
      estimated_year: '2012',
    }),
    row({
      listenbrainz_recommendation: 'manual_version_risk',
      listenbrainz_version_flags: 'live',
    }),
  ];

  const groups = groupReviewRows(rows);

  assert.deepEqual(groups.map((group) => group.key), [
    'likely_accept_existing_mb_with_context_warning',
    'useful_alternative_mb_year',
    'spotify_fallback_only',
    'manual_version_risk',
  ]);
});

test('likely_accept_existing_mb_with_context_warning can be batch accepted by Enter/a', () => {
  const rows = [row({ title: 'One' }), row({ title: 'Two', mb_year: '1999' })];
  const group = groupReviewRows(rows)[0];
  const result = applyGroupAction(group, { type: 'accept_all' });

  assert.equal(result.applied, 2);
  assert.equal(rows[0].status, 'manual_confirmed_mb');
  assert.equal(rows[0].final_year, '2018');
  assert.equal(rows[1].final_year, '1999');
  assert.match(rows[0].notes, new RegExp(BATCH_MB_CONTEXT_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('number selection accepts group except selected rows and defers them unchanged', () => {
  const rows = [
    row({ title: 'One' }),
    row({ title: 'Two', mb_year: '1999' }),
    row({ title: 'Three', mb_year: '2001' }),
  ];
  const group = groupReviewRows(rows)[0];
  const result = applyGroupAction(group, { type: 'accept_all_except', indexes: [2] });

  assert.equal(result.applied, 2);
  assert.deepEqual(result.deferredRows, [rows[1]]);
  assert.equal(rows[0].final_year, '2018');
  assert.equal(rows[1].status, 'review_needed');
  assert.equal(rows[1].final_year, '');
  assert.equal(rows[2].final_year, '2001');
});

test('useful_alternative_mb_year can be batch accepted', () => {
  const rows = [
    row({
      listenbrainz_recommendation: 'useful_alternative_mb_year',
      mb_year: '2008',
      listenbrainz_mb_year: '1975',
    }),
  ];
  const group = groupReviewRows(rows)[0];
  const result = applyGroupAction(group, { type: 'accept_all' });

  assert.equal(result.applied, 1);
  assert.equal(rows[0].final_year, '1975');
  assert.equal(rows[0].final_source, 'listenbrainz_musicbrainz');
  assert.match(rows[0].notes, new RegExp(BATCH_LB_ALTERNATIVE_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('spotify_fallback_only group shows warning and Enter accepts estimated_year', () => {
  const rows = [
    row({
      mb_year: '',
      discogs_year: '',
      listenbrainz_mb_year: '',
      listenbrainz_recommendation: '',
      estimated_year: '2012',
    }),
  ];
  const group = groupReviewRows(rows)[0];

  assert.equal(group.key, 'spotify_fallback_only');
  assert.match(formatGroup(group, 1, 1), /WARNUNG: Nur Spotify-Fallback/);

  const result = applyGroupAction(group, { type: 'accept_all' });
  assert.equal(result.applied, 1);
  assert.equal(rows[0].status, 'manual_confirmed_spotify');
  assert.equal(rows[0].final_year, '2012');
});

test('x excludes and y sets manual year in grouped review actions', () => {
  const rows = [row({ title: 'Exclude' }), row({ title: 'Manual' })];
  const group = groupReviewRows(rows)[0];

  const excluded = applyGroupAction(group, { type: 'exclude_one', index: 1, reason: 'duplicate' });
  assert.equal(excluded.excluded, 1);
  assert.equal(rows[0].status, 'excluded_from_pool');
  assert.equal(rows[0].final_year, '');

  const manual = applyGroupAction(group, { type: 'manual_one', index: 2, year: '1977' });
  assert.equal(manual.manual, 1);
  assert.equal(rows[1].status, 'manual_entered_year');
  assert.equal(rows[1].final_year, '1977');
});
