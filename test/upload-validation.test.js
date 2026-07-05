'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mapUploadRow } = require('../scripts/lib/upload/map-upload-row');
const {
  UPLOAD_READY_STATUSES,
  formatBlockedUploadRows,
  validateUploadRows,
} = require('../scripts/lib/upload/validate-upload-rows');

function row(overrides = {}) {
  return {
    title: 'Upload Song',
    artist: 'Upload Artist',
    status: 'auto_accepted_mb',
    final_year: '1984',
    mb_year: '1984',
    spotify_found: 'true',
    spotify_track_id: 'spotify-track-1',
    spotify_match_name: 'Spotify Upload Song',
    spotify_match_artist: 'Spotify Upload Artist',
    isrc: 'US1234567890',
    notes: 'debug note',
    chosen_candidate: '1984',
    listenbrainz_recommendation: 'likely_accept_existing_mb',
    listenbrainz_recording_mbid: 'recording-mbid',
    risk_flags: 'mb_uncertain',
    review_reason: 'lb_mb_confirmed',
    ...overrides,
  };
}

test('auto_accepted_mb_lb_confirmed with final_year is upload-ready', () => {
  const result = validateUploadRows([
    row({ status: 'auto_accepted_mb_lb_confirmed', final_year: '2000' }),
  ]);

  assert.equal(result.blockedRows.length, 0);
  assert.equal(result.uploadCandidates.length, 1);
  assert.equal(result.uploadCandidates[0].finalYear, 2000);
});

test('manual confirmed statuses with final_year are upload-ready', () => {
  const result = validateUploadRows([
    row({ status: 'manual_confirmed_mb', final_year: '1975', spotify_track_id: 'a' }),
    row({ status: 'manual_confirmed_spotify', final_year: '2012', spotify_track_id: 'b' }),
    row({ status: 'manual_confirmed_discogs', final_year: '1969', spotify_track_id: 'c' }),
    row({ status: 'manual_entered_year', final_year: '1988', spotify_track_id: 'd' }),
    row({ status: 'manual_confirmed_default', final_year: '1991', spotify_track_id: 'e' }),
  ]);

  assert.equal(result.blockedRows.length, 0);
  assert.deepEqual(result.uploadCandidates.map((item) => item.row.status), [
    'manual_confirmed_mb',
    'manual_confirmed_spotify',
    'manual_confirmed_discogs',
    'manual_entered_year',
    'manual_confirmed_default',
  ]);
});

test('LB->MB manual accept uses existing manual_confirmed_mb status, not a new status', () => {
  assert.equal(UPLOAD_READY_STATUSES.has('manual_confirmed_mb'), true);
  assert.equal(UPLOAD_READY_STATUSES.has('manual_confirmed_listenbrainz_musicbrainz'), false);
});

test('review_needed without final_year blocks upload', () => {
  const result = validateUploadRows([
    row({ status: 'review_needed', final_year: '' }),
  ]);

  assert.equal(result.uploadCandidates.length, 0);
  assert.equal(result.blockedRows.length, 1);
  assert.equal(result.blockedRows[0].reason, 'missing_final_year');
});

test('review_needed with final_year still blocks because status is not upload-ready', () => {
  const result = validateUploadRows([
    row({ status: 'review_needed', final_year: '1984' }),
  ]);

  assert.equal(result.uploadCandidates.length, 0);
  assert.equal(result.blockedRows.length, 1);
  assert.equal(result.blockedRows[0].reason, 'blocked_status:review_needed');
});

test('excluded_from_pool is skipped and not uploaded', () => {
  const result = validateUploadRows([
    row({ status: 'excluded_from_pool', final_year: '' }),
  ]);

  assert.equal(result.uploadCandidates.length, 0);
  assert.equal(result.blockedRows.length, 0);
  assert.equal(result.skippedExcluded.length, 1);
});

test('additional ListenBrainz and review columns are ignored by upload mapping', () => {
  const mapped = mapUploadRow(row({
    final_year: '1977',
    listenbrainz_match_status: 'ok',
    listenbrainz_mb_year: '1977',
    recommendation: 'debug',
    risk_flags: 'debug',
  }), 'pool-1');

  assert.deepEqual(mapped, {
    pool_id: 'pool-1',
    title: 'Spotify Upload Song',
    artist: 'Spotify Upload Artist',
    spotify_track_id: 'spotify-track-1',
    release_year: 1977,
    isrc: 'US1234567890',
  });
});

test('blocked upload error contains examples with titles and statuses', () => {
  const result = validateUploadRows([
    row({ title: 'Needs Review', artist: 'Artist A', status: 'review_needed', final_year: '' }),
    row({ title: 'Wrong Status', artist: 'Artist B', status: 'soft_discogs_pending', final_year: '1984' }),
  ]);
  const message = formatBlockedUploadRows(result.blockedRows);

  assert.match(message, /ABBRUCH: 2 nicht ausgeschlossene Zeile/);
  assert.match(message, /Needs Review - Artist A/);
  assert.match(message, /status="review_needed"/);
  assert.match(message, /Wrong Status - Artist B/);
  assert.match(message, /blocked_status:soft_discogs_pending/);
});
