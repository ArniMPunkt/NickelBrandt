'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  mbCandidatesBatch,
  newMusicBrainzSearchStats,
} = require('../scripts/lib/verify-songs');

function tempCacheFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-search-cache-'));
  return path.join(dir, 'musicbrainz-search-cache.json');
}

function response(data) {
  return {
    status: 200,
    ok: true,
    json: async () => data,
  };
}

function recording(overrides = {}) {
  return {
    id: 'recording-1',
    title: 'Cache Song',
    'artist-credit': [{ name: 'Cache Artist' }],
    'first-release-date': '1984-01-01',
    isrcs: ['USRC18400001'],
    length: 180000,
    releases: [{ title: 'Cache Album', date: '1984-01-01' }],
    ...overrides,
  };
}

test('MusicBrainz ISRC cache avoids repeated external batch lookup', async () => {
  const originalFetch = globalThis.fetch;
  const cacheFile = tempCacheFile();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response({ recordings: [recording()] });
  };

  try {
    const tracks = [{ title: 'Cache Song', artist: 'Cache Artist', isrc: 'USRC18400001', durationMs: 180000 }];
    const firstStats = newMusicBrainzSearchStats(cacheFile);
    const first = await mbCandidatesBatch(tracks, { cacheFile, rateLimitMs: 0, stats: firstStats });

    assert.equal(first[0].status, 'mb_ok');
    assert.equal(calls, 1);
    assert.equal(firstStats.isrcBatchRequests, 1);
    assert.equal(firstStats.cacheWrites, 1);

    globalThis.fetch = async () => {
      throw new Error('unexpected network call');
    };
    const secondStats = newMusicBrainzSearchStats(cacheFile);
    const second = await mbCandidatesBatch(tracks, { cacheFile, rateLimitMs: 0, stats: secondStats });

    assert.equal(second[0].status, 'mb_ok');
    assert.equal(secondStats.isrcCacheHits, 1);
    assert.equal(secondStats.isrcBatchRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MusicBrainz text fallback cache avoids repeated text queries', async () => {
  const originalFetch = globalThis.fetch;
  const cacheFile = tempCacheFile();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response({ recordings: [recording()] });
  };

  try {
    const tracks = [{ title: 'Cache Song', artist: 'Cache Artist', isrc: '', durationMs: 180000 }];
    const firstStats = newMusicBrainzSearchStats(cacheFile);
    const first = await mbCandidatesBatch(tracks, { cacheFile, rateLimitMs: 0, stats: firstStats });

    assert.equal(first[0].status, 'mb_ok');
    assert.equal(calls, 1);
    assert.equal(firstStats.textQueries, 1);
    assert.equal(firstStats.cacheWrites, 1);

    globalThis.fetch = async () => {
      throw new Error('unexpected network call');
    };
    const secondStats = newMusicBrainzSearchStats(cacheFile);
    const second = await mbCandidatesBatch(tracks, { cacheFile, rateLimitMs: 0, stats: secondStats });

    assert.equal(second[0].status, 'mb_ok');
    assert.equal(secondStats.textCacheHits, 1);
    assert.equal(secondStats.textQueries, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
