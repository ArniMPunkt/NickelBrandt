'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildReviewRow } = require('../scripts/lib/precheck/build-review-row');
const { mergeResumeState } = require('../scripts/lib/precheck/resume-state');

function result(overrides = {}) {
  return {
    input: {
      title: 'Clear Song',
      artist: 'Clear Artist',
      inputEstimatedYear: 1984,
      spotifyEstimatedYear: 1984,
      spotifyAlbumName: 'Clear Album',
      spotifyAlbumType: 'album',
      spotifyAlbumReleaseDate: '1984-01-01',
      spotifyAlbumArtist: 'Clear Artist',
      spotifyTrackId: 'spotify-track-1',
      existingYear: null,
      existingYearSource: '',
    },
    spotifyFound: true,
    trackId: 'spotify-track-1',
    spName: 'Clear Song',
    spArtist: 'Clear Artist',
    isrc: 'USRC17607839',
    mbYear: 1984,
    mbStatus: 'mb_ok',
    mbMatchMethod: 'isrc',
    mbScore: 0.96,
    matchMethod: 'playlist_import',
    similarityScore: null,
    ...overrides,
  };
}

test('buildReviewRow maps accepted_auto to upload-ready MusicBrainz row', () => {
  const row = buildReviewRow(result());

  assert.equal(row.status, 'auto_accepted_mb');
  assert.equal(row.final_year, '1984');
  assert.equal(row.chosen_candidate, '1984');
  assert.equal(row.notes, 'auto: MusicBrainz strong match');
  assert.equal(row.mb_year_source, 'mb_ok');
});

test('buildReviewRow maps accepted_auto_soft to upload-blocking soft Discogs pending row', () => {
  const row = buildReviewRow(result({
    input: {
      ...result().input,
      spotifyAlbumName: 'Classic Hits',
      spotifyAlbumType: 'compilation',
      spotifyAlbumReleaseDate: '2020-01-01',
      inputEstimatedYear: 2020,
      spotifyEstimatedYear: 2020,
    },
  }));

  assert.equal(row.status, 'soft_discogs_pending');
  assert.equal(row.final_year, '');
  assert.equal(row.chosen_candidate, '1984');
  assert.match(row.notes, /soft auto candidate/);
  assert.match(row.notes, /Discogs background check pending/);
  assert.match(row.notes, /risk_flags: catalog_context\+compilation_context/);
});

test('buildReviewRow maps needs_review to row without final_year', () => {
  const row = buildReviewRow(result({
    isrc: '',
    mbYear: null,
    mbStatus: 'mb_no_match',
    mbMatchMethod: '',
    mbScore: null,
  }));

  assert.equal(row.status, 'review_needed');
  assert.equal(row.final_year, '');
  assert.equal(row.chosen_candidate, '');
  assert.match(row.notes, /review_reason: mb_no_match/);
  assert.match(row.notes, /risk_flags: no_isrc\+mb_no_match/);
});

test('buildReviewRow keeps Discogs earlier than MB as review and never overwrites final_year', () => {
  const row = buildReviewRow(result({
    mbYear: 1995,
    discogsYear: 1988,
  }));

  assert.equal(row.status, 'review_needed');
  assert.equal(row.final_year, '');
  assert.equal(row.discogs_year, '1988');
  assert.match(row.notes, /review_reason: discogs_earlier_than_mb/);
});

test('Deezer fields do not influence built decision fields', () => {
  const base = buildReviewRow(result());
  const withDeezer = buildReviewRow(result({
    deezerYear: 1965,
    deezerInvalidYear: 1964,
    deezerStatus: 'ok',
    deezerTrackId: 'deezer-1',
  }));

  assert.equal(withDeezer.status, base.status);
  assert.equal(withDeezer.final_year, base.final_year);
  assert.equal(withDeezer.chosen_candidate, base.chosen_candidate);
  assert.equal(withDeezer.notes, base.notes);
});

test('mergeResumeState keeps excluded_from_pool rows done', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-resume-'));
  const outputCsv = path.join(dir, 'review.csv');
  fs.writeFileSync(
    outputCsv,
    [
      'title,artist,spotify_track_id,status,final_year,notes,chosen_candidate,manual_source_url,exclusion_reason',
      'Clear Song,Clear Artist,spotify-track-1,excluded_from_pool,,manual: excluded from pool,,,duplicate',
      '',
    ].join('\n'),
    'utf8'
  );

  const rows = [buildReviewRow(result())];
  const outcome = mergeResumeState(rows, outputCsv);

  assert.equal(outcome.resumed, 1);
  assert.equal(rows[0].status, 'excluded_from_pool');
  assert.equal(rows[0].exclusion_reason, 'duplicate');
});
