'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOOKUP_URL = 'https://api.listenbrainz.org/1/metadata/lookup/';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_FILE = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '.cache',
  'listenbrainz-cache.json'
);

function cleanText(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeCachePart(value) {
  return cleanText(value).toLowerCase().replace(/\s+/g, ' ');
}

function buildCacheKey({ title, artist, releaseName }) {
  return [
    normalizeCachePart(artist),
    normalizeCachePart(title),
    normalizeCachePart(releaseName),
  ].join('|');
}

function readCache(cacheFile = DEFAULT_CACHE_FILE) {
  try {
    if (!fs.existsSync(cacheFile)) return {};
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(cache, cacheFile = DEFAULT_CACHE_FILE) {
  const dir = path.dirname(cacheFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + '\n', 'utf8');
}

function getHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return cleanText(headers.get(name));
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return cleanText(value);
  }
  return '';
}

function readRateLimit(headers) {
  return {
    retry_after: getHeader(headers, 'retry-after'),
    limit: getHeader(headers, 'x-ratelimit-limit'),
    remaining: getHeader(headers, 'x-ratelimit-remaining'),
    reset: getHeader(headers, 'x-ratelimit-reset'),
  };
}

function extractLookupPayload(data) {
  const payload = data && typeof data === 'object' && data.payload ? data.payload : data;
  if (!payload || typeof payload !== 'object') return {};

  return {
    recording_mbid: cleanText(payload.recording_mbid),
    recording_name: cleanText(payload.recording_name),
    release_mbid: cleanText(payload.release_mbid),
    release_name: cleanText(payload.release_name),
    artist_credit_name: cleanText(payload.artist_credit_name),
    artist_mbids: Array.isArray(payload.artist_mbids) ? payload.artist_mbids : [],
  };
}

async function readResponseJson(response) {
  if (typeof response.json === 'function') return response.json();
  if (typeof response.text === 'function') return JSON.parse(await response.text());
  return {};
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller ? controller.signal : undefined,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cacheableStatus(status) {
  return status === 'ok' || status === 'no_match';
}

async function lookupListenBrainzMetadata(query = {}, options = {}) {
  const title = cleanText(query.title || query.recordingName || query.recording_name);
  const artist = cleanText(query.artist || query.artistName || query.artist_name);
  const releaseName = cleanText(query.releaseName || query.release_name);
  const normalizedQuery = { title, artist, releaseName };

  if (!title || !artist) {
    return {
      status: 'skipped_missing_input',
      query: normalizedQuery,
      cache_hit: false,
    };
  }

  const token = Object.prototype.hasOwnProperty.call(options, 'token')
    ? options.token
    : process.env.LISTENBRAINZ_USER_TOKEN;

  if (!cleanText(token)) {
    return {
      status: 'skipped_no_token',
      query: normalizedQuery,
      cache_hit: false,
    };
  }

  const cacheFile = options.cacheFile || DEFAULT_CACHE_FILE;
  const useCache = options.cache !== false;
  const key = buildCacheKey(normalizedQuery);
  const cache = useCache ? readCache(cacheFile) : {};

  if (useCache && cache[key]) {
    return {
      ...cache[key],
      query: normalizedQuery,
      cache_hit: true,
    };
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      status: 'error',
      error: 'fetch_unavailable',
      query: normalizedQuery,
      cache_hit: false,
    };
  }

  const url = new URL(LOOKUP_URL);
  url.searchParams.set('artist_name', artist);
  url.searchParams.set('recording_name', title);
  if (releaseName) url.searchParams.set('release_name', releaseName);

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      url,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Token ${cleanText(token)}`,
        },
      },
      options.timeoutMs || DEFAULT_TIMEOUT_MS
    );
    const rate_limit = readRateLimit(response.headers);

    if (response.status === 429) {
      return {
        status: 'rate_limited',
        error: 'http_429',
        query: normalizedQuery,
        cache_hit: false,
        rate_limit,
      };
    }

    if (!response.ok) {
      return {
        status: 'error',
        error: `http_${response.status || 'unknown'}`,
        query: normalizedQuery,
        cache_hit: false,
        rate_limit,
      };
    }

    let data;
    try {
      data = await readResponseJson(response);
    } catch {
      return {
        status: 'error',
        error: 'invalid_json',
        query: normalizedQuery,
        cache_hit: false,
        rate_limit,
      };
    }

    const lookup = extractLookupPayload(data);
    const status = lookup.recording_mbid || lookup.release_mbid ? 'ok' : 'no_match';
    const result = {
      status,
      query: normalizedQuery,
      cache_hit: false,
      rate_limit,
      ...lookup,
    };

    if (useCache && cacheableStatus(status)) {
      cache[key] = result;
      writeCache(cache, cacheFile);
    }

    return result;
  } catch (error) {
    const isAbort = error && error.name === 'AbortError';
    return {
      status: isAbort ? 'timeout' : 'error',
      error: isAbort ? 'timeout' : cleanText(error && error.message) || 'fetch_failed',
      query: normalizedQuery,
      cache_hit: false,
    };
  }
}

module.exports = {
  DEFAULT_CACHE_FILE,
  DEFAULT_TIMEOUT_MS,
  LOOKUP_URL,
  buildCacheKey,
  extractLookupPayload,
  lookupListenBrainzMetadata,
  readCache,
  readRateLimit,
  writeCache,
};
