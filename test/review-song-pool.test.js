'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseCsvObjects } = require('../scripts/lib/util');
const { reviewQueue } = require('../scripts/lib/precheck/interactive-review');
const {
  loadReviewCsv,
  reviewOnlySummary,
  runReviewOnly,
} = require('../scripts/review-song-pool');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-song-pool-'));
}

function writeCsv(filePath, text) {
  fs.writeFileSync(filePath, text.trim() + '\n', 'utf8');
}

test('review-only script does not import verification or source lookup modules', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'review-song-pool.js'),
    'utf8'
  );

  assert.doesNotMatch(source, /verify-songs|verifySongs/);
  assert.doesNotMatch(source, /sources\/listenbrainz|musicbrainz-recording|soft-discogs/);
});

test('review-only loads existing Review CSV, preserves columns, and saves manual changes', async () => {
  const dir = tempDir();
  const input = path.join(dir, 'input.csv');
  const output = path.join(dir, 'output.csv');

  writeCsv(input, `
title,artist,status,mb_year,estimated_year,listenbrainz_recommendation,listenbrainz_mb_year,listenbrainz_context_flags,final_year,notes,custom_column
Open Song,Open Artist,review_needed,1975,1975,likely_accept_existing_mb_with_context_warning,1975,,,"old note",keep-me
Ready Song,Ready Artist,auto_accepted_mb,1984,1984,,, ,1984,"ready note",keep-ready
`);

  const result = await runReviewOnly(input, output, {
    reviewRunner: async (rows, { save }) => {
      const open = reviewQueue(rows);
      assert.equal(open.length, 1);
      open[0].status = 'manual_confirmed_mb';
      open[0].final_year = '1975';
      open[0].final_source = 'musicbrainz';
      await save();
    },
  });

  assert.equal(result.summaryBefore.openRows, 1);
  assert.equal(result.summaryAfter.openRows, 0);

  const parsed = parseCsvObjects(fs.readFileSync(output, 'utf8'));
  assert.ok(parsed.keys.includes('listenbrainz_recommendation'));
  assert.ok(parsed.keys.includes('custom_column'));
  assert.ok(parsed.keys.includes('final_source'));

  assert.equal(parsed.objects[0].status, 'manual_confirmed_mb');
  assert.equal(parsed.objects[0].final_year, '1975');
  assert.equal(parsed.objects[0].custom_column, 'keep-me');
  assert.equal(parsed.objects[1].status, 'auto_accepted_mb');
  assert.equal(parsed.objects[1].final_year, '1984');
  assert.equal(parsed.objects[1].custom_column, 'keep-ready');
});

test('review-only summary skips upload-ready rows and groups only open statuses', () => {
  const rows = [
    { status: 'auto_accepted_mb', final_year: '1984' },
    { status: 'auto_accepted_mb_soft_checked', final_year: '1985' },
    { status: 'auto_accepted_mb_lb_confirmed', final_year: '1986' },
    { status: 'manual_confirmed_mb', final_year: '1987' },
    { status: 'excluded_from_pool', final_year: '' },
    {
      status: 'review_needed',
      title: 'Open',
      artist: 'Artist',
      mb_year: '1975',
      estimated_year: '1975',
    },
    {
      status: 'soft_discogs_pending',
      title: 'Soft',
      artist: 'Artist',
      estimated_year: '2012',
    },
  ];

  const summary = reviewOnlySummary(rows);

  assert.equal(summary.openRows, 2);
  assert.deepEqual(summary.groups.map((group) => group.key), [
    'confirmed_same_year_mb_spotify',
    'spotify_fallback_only',
  ]);
});

test('loadReviewCsv returns empty strings for missing added review columns without dropping existing columns', () => {
  const dir = tempDir();
  const input = path.join(dir, 'input.csv');
  writeCsv(input, `
title,artist,status,listenbrainz_recommendation
Song,Artist,review_needed,useful_alternative_mb_year
`);

  const loaded = loadReviewCsv(input);

  assert.ok(loaded.columns.includes('listenbrainz_recommendation'));
  assert.ok(loaded.columns.includes('final_year'));
  assert.ok(loaded.columns.includes('final_source'));
  assert.equal(loaded.rows[0].title, 'Song');
});
