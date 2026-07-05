'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lookupListenBrainzMetadata,
} = require('../scripts/lib/sources/listenbrainz');

function tempCacheFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listenbrainz-cache-'));
  return path.join(dir, 'cache.json');
}

function response({ status = 200, body = {}, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
  };
}

test('lookupListenBrainzMetadata returns skipped_no_token without fetching', async () => {
  let fetchCalls = 0;
  const result = await lookupListenBrainzMetadata(
    { title: 'Open Song', artist: 'Open Artist' },
    {
      token: '',
      cacheFile: tempCacheFile(),
      fetchImpl: async () => {
        fetchCalls++;
        throw new Error('should not fetch');
      },
    }
  );

  assert.equal(result.status, 'skipped_no_token');
  assert.equal(result.cache_hit, false);
  assert.equal(fetchCalls, 0);
});

test('lookupListenBrainzMetadata can be mocked and maps successful lookup', async () => {
  const seen = {};
  const result = await lookupListenBrainzMetadata(
    {
      title: 'Open Song',
      artist: 'Open Artist',
      releaseName: 'Open Album',
    },
    {
      token: 'test-token',
      cacheFile: tempCacheFile(),
      fetchImpl: async (url, options) => {
        seen.url = url;
        seen.options = options;
        return response({
          headers: {
            'x-ratelimit-remaining': '42',
          },
          body: {
            recording_mbid: 'recording-mbid-1',
            recording_name: 'Open Song',
            release_mbid: 'release-mbid-1',
            release_name: 'Open Album',
            artist_credit_name: 'Open Artist',
            artist_mbids: ['artist-mbid-1'],
          },
        });
      },
    }
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.recording_mbid, 'recording-mbid-1');
  assert.equal(result.recording_name, 'Open Song');
  assert.equal(result.release_mbid, 'release-mbid-1');
  assert.equal(result.release_name, 'Open Album');
  assert.equal(result.artist_credit_name, 'Open Artist');
  assert.deepEqual(result.artist_mbids, ['artist-mbid-1']);
  assert.equal(result.cache_hit, false);
  assert.equal(result.rate_limit.remaining, '42');

  const url = new URL(String(seen.url));
  assert.equal(url.searchParams.get('artist_name'), 'Open Artist');
  assert.equal(url.searchParams.get('recording_name'), 'Open Song');
  assert.equal(url.searchParams.get('release_name'), 'Open Album');
  assert.equal(seen.options.headers.Authorization, 'Token test-token');
});

test('lookupListenBrainzMetadata returns rate limit and error states without throwing', async () => {
  const rateLimited = await lookupListenBrainzMetadata(
    { title: 'Limited Song', artist: 'Limited Artist' },
    {
      token: 'test-token',
      cacheFile: tempCacheFile(),
      fetchImpl: async () => response({
        status: 429,
        headers: {
          'retry-after': '120',
          'x-ratelimit-remaining': '0',
        },
      }),
    }
  );

  assert.equal(rateLimited.status, 'rate_limited');
  assert.equal(rateLimited.error, 'http_429');
  assert.equal(rateLimited.rate_limit.retry_after, '120');
  assert.equal(rateLimited.rate_limit.remaining, '0');

  const failed = await lookupListenBrainzMetadata(
    { title: 'Broken Song', artist: 'Broken Artist' },
    {
      token: 'test-token',
      cacheFile: tempCacheFile(),
      fetchImpl: async () => {
        throw new Error('network down');
      },
    }
  );

  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'network down');
});

test('lookupListenBrainzMetadata cache hit avoids fetch', async () => {
  const cacheFile = tempCacheFile();
  let fetchCalls = 0;

  const first = await lookupListenBrainzMetadata(
    { title: 'Cached Song', artist: 'Cached Artist', releaseName: 'Cached Album' },
    {
      token: 'test-token',
      cacheFile,
      fetchImpl: async () => {
        fetchCalls++;
        return response({
          body: {
            recording_mbid: 'cached-recording-mbid',
            recording_name: 'Cached Song',
            release_mbid: 'cached-release-mbid',
            release_name: 'Cached Album',
          },
        });
      },
    }
  );

  const second = await lookupListenBrainzMetadata(
    { title: 'Cached Song', artist: 'Cached Artist', releaseName: 'Cached Album' },
    {
      token: 'test-token',
      cacheFile,
      fetchImpl: async () => {
        fetchCalls++;
        throw new Error('cache miss');
      },
    }
  );

  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'ok');
  assert.equal(second.cache_hit, true);
  assert.equal(second.recording_mbid, 'cached-recording-mbid');
  assert.equal(fetchCalls, 1);
});
