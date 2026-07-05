'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyManualChoice } = require('../scripts/lib/precheck/apply-manual-choice');

function row(overrides = {}) {
  return {
    title: 'Review Song',
    artist: 'Review Artist',
    status: 'review_needed',
    mb_year: '1984',
    listenbrainz_mb_year: '1975',
    discogs_year: '1974',
    final_year: '',
    final_source: '',
    chosen_candidate: '',
    notes: 'review_reason: mb_year_suspicious_late',
    ...overrides,
  };
}

test('applyManualChoice returns a new row and accepts MB year', () => {
  const original = row();
  const updated = applyManualChoice(original, { type: 'accept_mb' });

  assert.notEqual(updated, original);
  assert.equal(original.final_year, '');
  assert.equal(updated.final_year, '1984');
  assert.equal(updated.final_source, 'musicbrainz');
  assert.equal(updated.chosen_candidate, '1984');
  assert.equal(updated.status, 'manual_confirmed_mb');
  assert.match(updated.notes, /manual: confirmed MusicBrainz year 1984/);
});

test('applyManualChoice accepts LB->MB alternative year', () => {
  const updated = applyManualChoice(row(), {
    type: 'accept_listenbrainz_mb',
    note: 'Manual accept: LB->MB alternative year accepted.',
  });

  assert.equal(updated.final_year, '1975');
  assert.equal(updated.final_source, 'listenbrainz_musicbrainz');
  assert.equal(updated.chosen_candidate, '1975');
  assert.equal(updated.status, 'manual_confirmed_mb');
  assert.match(updated.notes, /Manual accept: LB->MB alternative year accepted\./);
});

test('applyManualChoice accepts Discogs year', () => {
  const updated = applyManualChoice(row(), { type: 'accept_discogs' });

  assert.equal(updated.final_year, '1974');
  assert.equal(updated.final_source, 'discogs');
  assert.equal(updated.chosen_candidate, '1974');
  assert.equal(updated.status, 'manual_confirmed_discogs');
});

test('applyManualChoice accepts Spotify fallback year', () => {
  const updated = applyManualChoice(row({ estimated_year: '2012' }), {
    type: 'accept_spotify',
  });

  assert.equal(updated.final_year, '2012');
  assert.equal(updated.final_source, 'spotify');
  assert.equal(updated.chosen_candidate, '2012');
  assert.equal(updated.status, 'manual_confirmed_spotify');
});

test('applyManualChoice accepts computed default year', () => {
  const updated = applyManualChoice(row(), {
    type: 'accept_default',
    year: 1969,
    source: 'musicbrainz',
    status: 'manual_confirmed_mb',
    reason: 'default_candidate_confirmed',
  });

  assert.equal(updated.final_year, '1969');
  assert.equal(updated.final_source, 'musicbrainz');
  assert.equal(updated.chosen_candidate, '1969');
  assert.equal(updated.status, 'manual_confirmed_mb');
  assert.equal(updated.review_reason, 'default_candidate_confirmed');
});

test('applyManualChoice accepts manual year', () => {
  const updated = applyManualChoice(row(), {
    type: 'manual_year',
    year: 1967,
    source: 'manual',
  });

  assert.equal(updated.final_year, '1967');
  assert.equal(updated.final_source, 'manual');
  assert.equal(updated.chosen_candidate, '1967');
  assert.equal(updated.status, 'manual_entered_year');
});

test('applyManualChoice skip keeps row blocked without final_year', () => {
  const updated = applyManualChoice(row(), { type: 'skip' });

  assert.equal(updated.final_year, '');
  assert.equal(updated.status, 'manual_skipped');
  assert.match(updated.notes, /manual: skipped for later review/);
});

test('applyManualChoice exclude marks row excluded from pool', () => {
  const updated = applyManualChoice(row({ chosen_candidate: '1984' }), {
    type: 'exclude',
    reason: 'duplicate',
  });

  assert.equal(updated.final_year, '');
  assert.equal(updated.chosen_candidate, '');
  assert.equal(updated.status, 'excluded_from_pool');
  assert.equal(updated.exclusion_reason, 'duplicate');
  assert.match(updated.notes, /manual: excluded from pool \(duplicate\)/);
});
