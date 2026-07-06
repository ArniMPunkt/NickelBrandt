'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runSoftDiscogsChecks } = require('../scripts/lib/precheck/soft-discogs-checks');
const { discogsCacheKey } = require('../scripts/lib/verify-songs');

function softRow(overrides = {}) {
  return {
    title: 'Soft Song',
    artist: 'Soft Artist',
    status: 'soft_discogs_pending',
    chosen_candidate: '1984',
    final_year: '',
    notes: 'soft auto candidate; Discogs background check pending',
    discogs_year: '',
    ...overrides,
  };
}

test('soft pending without earlier Discogs conflict becomes upload-ready soft checked', async () => {
  const rows = [softRow()];
  const stats = await runSoftDiscogsChecks(rows, {
    lookupCandidate: async () => ({ year: 1984, reason: null }),
  });

  assert.equal(rows[0].status, 'auto_accepted_mb_soft_checked');
  assert.equal(rows[0].final_year, '1984');
  assert.equal(rows[0].chosen_candidate, '1984');
  assert.equal(rows[0].discogs_year, '1984');
  assert.match(rows[0].notes, /soft Discogs check: no earlier conflict/);
  assert.equal(stats.checked, 1);
  assert.equal(stats.autoAcceptedSoftChecked, 1);
  assert.equal(stats.stillPending, 0);
});

test('soft pending with earlier Discogs year becomes review and keeps final_year empty', async () => {
  const rows = [softRow()];
  const stats = await runSoftDiscogsChecks(rows, {
    lookupCandidate: async () => ({ year: 1979, reason: null }),
  });

  assert.equal(rows[0].status, 'review_needed_after_discogs');
  assert.equal(rows[0].final_year, '');
  assert.equal(rows[0].discogs_year, '1979');
  assert.match(rows[0].notes, /Discogs earlier than MusicBrainz; manual review required/);
  assert.equal(stats.reviewNeededAfterDiscogs, 1);
  assert.equal(stats.stillPending, 0);
});

test('soft pending with lookup error remains pending and upload-blocking', async () => {
  const rows = [softRow()];
  const stats = await runSoftDiscogsChecks(rows, {
    lookupCandidate: async () => {
      throw new Error('network error');
    },
  });

  assert.equal(rows[0].status, 'soft_discogs_pending');
  assert.equal(rows[0].final_year, '');
  assert.match(rows[0].notes, /soft Discogs check pending: error/);
  assert.equal(stats.errors, 1);
  assert.equal(stats.stillPending, 1);
});

test('soft pending with rate limit remains pending and aborts rest', async () => {
  const rows = [softRow(), softRow({ title: 'Second Soft Song' })];
  const stats = await runSoftDiscogsChecks(rows, {
    lookupCandidate: async () => {
      const error = new Error('429 rate limit');
      error.rateLimited = true;
      throw error;
    },
  });

  assert.equal(rows[0].status, 'soft_discogs_pending');
  assert.equal(rows[0].final_year, '');
  assert.equal(rows[1].status, 'soft_discogs_pending');
  assert.equal(rows[1].final_year, '');
  assert.equal(stats.rateLimited, 1);
  assert.equal(stats.aborted, true);
  assert.equal(stats.stillPending, 2);
});

test('auto accepted rows are not checked or changed', async () => {
  let calls = 0;
  const rows = [{
    title: 'Auto Song',
    artist: 'Auto Artist',
    status: 'auto_accepted_mb',
    chosen_candidate: '1984',
    final_year: '1984',
    notes: 'auto: MusicBrainz strong match',
  }];
  const stats = await runSoftDiscogsChecks(rows, {
    lookupCandidate: async () => {
      calls += 1;
      return { year: 1979, reason: null };
    },
  });

  assert.equal(calls, 0);
  assert.equal(rows[0].status, 'auto_accepted_mb');
  assert.equal(rows[0].final_year, '1984');
  assert.equal(stats.planned, 0);
});

test('review needed rows are not checked or changed', async () => {
  let calls = 0;
  const rows = [{
    title: 'Review Song',
    artist: 'Review Artist',
    status: 'review_needed',
    chosen_candidate: '',
    final_year: '',
    notes: 'review_reason: mb_no_match',
  }];
  const stats = await runSoftDiscogsChecks(rows, {
    lookupCandidate: async () => {
      calls += 1;
      return { year: 1979, reason: null };
    },
  });

  assert.equal(calls, 0);
  assert.equal(rows[0].status, 'review_needed');
  assert.equal(rows[0].final_year, '');
  assert.equal(stats.planned, 0);
});

test('soft pending uses shared Discogs cache and avoids external lookup on cache hit', async () => {
  let calls = 0;
  let writes = 0;
  const rows = [softRow()];
  const cache = {
    [discogsCacheKey(rows[0])]: { year: 1984, reason: null, timestamp: '2026-01-01T00:00:00.000Z' },
  };

  const stats = await runSoftDiscogsChecks(rows, {
    useDiscogsCache: true,
    discogsCache: cache,
    writeDiscogsCache: () => {
      writes += 1;
    },
    lookupCandidate: async () => {
      calls += 1;
      return { year: 1979, reason: null };
    },
  });

  assert.equal(calls, 0);
  assert.equal(writes, 0);
  assert.equal(rows[0].status, 'auto_accepted_mb_soft_checked');
  assert.equal(rows[0].final_year, '1984');
  assert.equal(stats.cacheHits, 1);
  assert.equal(stats.calls, 0);
});

test('soft pending writes shared Discogs cache after cache miss', async () => {
  let calls = 0;
  let writtenCache = null;
  const rows = [softRow()];
  const cache = {};

  const stats = await runSoftDiscogsChecks(rows, {
    useDiscogsCache: true,
    discogsCache: cache,
    writeDiscogsCache: (nextCache) => {
      writtenCache = nextCache;
    },
    lookupCandidate: async () => {
      calls += 1;
      return { year: 1984, reason: null };
    },
  });

  assert.equal(calls, 1);
  assert.equal(rows[0].status, 'auto_accepted_mb_soft_checked');
  assert.equal(rows[0].final_year, '1984');
  assert.equal(stats.calls, 1);
  assert.equal(stats.cacheHits, 0);
  assert.equal(writtenCache[discogsCacheKey(rows[0])].year, 1984);
});
