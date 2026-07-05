'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MB_BASE = 'https://musicbrainz.org/ws/2';
const MB_USER_AGENT = 'NickelBrandt-PoolImport/1.0 ( https://github.com/ArniMPunkt/NickelBrandt )';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RATE_LIMIT_MS = 1_200;
const DEFAULT_CACHE_FILE = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '.cache',
  'musicbrainz-recording-cache.json'
);
const MIN_YEAR = 1850;
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let nextAllowedRequestAt = 0;

function cleanText(value) {
  return value == null ? '' : String(value).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseYear(value, currentYear = new Date().getFullYear()) {
  if (value == null) return null;
  const maxYear = currentYear + 1;
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_YEAR &&
    value <= maxYear
  ) {
    return value;
  }
  const match = String(value).trim().match(/^(\d{4})/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  return Number.isFinite(year) && year >= MIN_YEAR && year <= maxYear ? year : null;
}

function normalizeMbid(mbid) {
  const normalized = cleanText(mbid).toLowerCase();
  return MBID_RE.test(normalized) ? normalized : '';
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

function artistCreditName(entity) {
  const credit = entity && entity['artist-credit'];
  if (!Array.isArray(credit)) return '';
  return credit
    .map((part) => {
      const name = cleanText(part && (part.name || (part.artist && part.artist.name)));
      const joinphrase = cleanText(part && part.joinphrase);
      return `${name}${joinphrase}`;
    })
    .join('')
    .trim();
}

function normalizeReleaseGroup(group) {
  if (!group || typeof group !== 'object') return null;
  return {
    id: cleanText(group.id),
    title: cleanText(group.title),
    primary_type: cleanText(group['primary-type'] || group.primary_type),
    secondary_types: Array.isArray(group['secondary-types'])
      ? group['secondary-types'].map(cleanText).filter(Boolean)
      : [],
    first_release_date: cleanText(group['first-release-date'] || group.first_release_date),
    year: parseYear(group['first-release-date'] || group.first_release_date),
  };
}

function normalizeRelease(release) {
  if (!release || typeof release !== 'object') return null;
  const group = normalizeReleaseGroup(release['release-group'] || release.release_group);
  return {
    id: cleanText(release.id),
    title: cleanText(release.title),
    date: cleanText(release.date),
    year: parseYear(release.date),
    release_status: cleanText(release.status),
    country: cleanText(release.country),
    disambiguation: cleanText(release.disambiguation),
    artist_credit_name: artistCreditName(release),
    release_group: group,
  };
}

function earliestYearFromRecordingData(recording) {
  const candidates = [];
  const recordingYear = parseYear(recording && recording['first-release-date']);
  if (recordingYear != null) {
    candidates.push({
      year: recordingYear,
      source: 'recording_first_release_date',
    });
  }

  for (const release of (recording && recording.releases) || []) {
    const normalized = normalizeRelease(release);
    if (!normalized) continue;
    if (normalized.year != null) {
      candidates.push({
        year: normalized.year,
        source: `recording_release_date:${normalized.id}`,
      });
    }
    if (normalized.release_group && normalized.release_group.year != null) {
      candidates.push({
        year: normalized.release_group.year,
        source: `recording_release_group_first_release_date:${normalized.release_group.id}`,
      });
    }
  }

  candidates.sort((a, b) => a.year - b.year);
  return candidates[0] || { year: null, source: '' };
}

function yearFromReleaseData(release) {
  const normalized = normalizeRelease(release);
  if (!normalized) return { year: null, source: '' };
  if (normalized.release_group && normalized.release_group.year != null) {
    return {
      year: normalized.release_group.year,
      source: 'release_group_first_release_date',
    };
  }
  if (normalized.year != null) {
    return {
      year: normalized.year,
      source: 'release_date',
    };
  }
  return { year: null, source: '' };
}

function normalizeRecording(recording) {
  const yearInfo = earliestYearFromRecordingData(recording);
  return {
    id: cleanText(recording && recording.id),
    title: cleanText(recording && recording.title),
    artist_credit_name: artistCreditName(recording),
    first_release_date: cleanText(recording && recording['first-release-date']),
    disambiguation: cleanText(recording && recording.disambiguation),
    length: recording && recording.length ? recording.length : null,
    releases: ((recording && recording.releases) || []).map(normalizeRelease).filter(Boolean),
    year: yearInfo.year,
    year_source: yearInfo.source,
  };
}

function normalizeReleaseDetails(release) {
  const normalized = normalizeRelease(release);
  const yearInfo = yearFromReleaseData(release);
  return {
    ...(normalized || {}),
    year: yearInfo.year,
    year_source: yearInfo.source,
  };
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

async function acquireRateLimit(options = {}) {
  if (options.rateLimit === false) return;
  const intervalMs = options.rateLimitMs || DEFAULT_RATE_LIMIT_MS;
  const now = Date.now();
  const waitMs = Math.max(0, nextAllowedRequestAt - now);
  nextAllowedRequestAt = Math.max(now, nextAllowedRequestAt) + intervalMs;
  if (waitMs > 0) await sleep(waitMs);
}

async function fetchMusicBrainzJson(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      status: 'error',
      error: 'fetch_unavailable',
    };
  }

  try {
    await acquireRateLimit(options);
    const response = await fetchWithTimeout(
      fetchImpl,
      url,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': MB_USER_AGENT,
        },
      },
      options.timeoutMs || DEFAULT_TIMEOUT_MS
    );
    const rate_limit = readRateLimit(response.headers);

    if (response.status === 429) {
      return {
        status: 'rate_limited',
        error: 'http_429',
        rate_limit,
      };
    }

    if (!response.ok) {
      return {
        status: 'error',
        error: `http_${response.status || 'unknown'}`,
        rate_limit,
      };
    }

    try {
      return {
        status: 'ok',
        data: await response.json(),
        rate_limit,
      };
    } catch {
      return {
        status: 'error',
        error: 'invalid_json',
        rate_limit,
      };
    }
  } catch (error) {
    const isAbort = error && error.name === 'AbortError';
    return {
      status: isAbort ? 'timeout' : 'error',
      error: isAbort ? 'timeout' : cleanText(error && error.message) || 'fetch_failed',
    };
  }
}

async function fetchCachedEntity(type, mbid, url, normalize, options = {}) {
  const normalizedMbid = normalizeMbid(mbid);
  if (!normalizedMbid) {
    return {
      status: 'skipped_invalid_mbid',
      error: 'invalid_mbid',
      cache_hit: false,
    };
  }

  const cacheFile = options.cacheFile || DEFAULT_CACHE_FILE;
  const useCache = options.cache !== false;
  const cacheKey = `${type}:${normalizedMbid}`;
  const cache = useCache ? readCache(cacheFile) : {};

  if (useCache && cache[cacheKey]) {
    return {
      ...cache[cacheKey],
      cache_hit: true,
    };
  }

  const fetched = await fetchMusicBrainzJson(url(normalizedMbid), options);
  if (fetched.status !== 'ok') {
    return {
      status: fetched.status,
      error: fetched.error || fetched.status,
      cache_hit: false,
      rate_limit: fetched.rate_limit,
    };
  }

  const result = {
    status: 'ok',
    cache_hit: false,
    rate_limit: fetched.rate_limit,
    ...normalize(fetched.data),
  };

  if (useCache) {
    cache[cacheKey] = result;
    writeCache(cache, cacheFile);
  }

  return result;
}

async function fetchMusicBrainzRecordingByMbid(mbid, options = {}) {
  return fetchCachedEntity(
    'recording',
    mbid,
    (id) => `${MB_BASE}/recording/${id}?fmt=json&inc=releases+artist-credits+isrcs+release-groups`,
    normalizeRecording,
    options
  );
}

async function fetchMusicBrainzReleaseByMbid(mbid, options = {}) {
  return fetchCachedEntity(
    'release',
    mbid,
    (id) => `${MB_BASE}/release/${id}?fmt=json&inc=artist-credits+release-groups`,
    normalizeReleaseDetails,
    options
  );
}

module.exports = {
  DEFAULT_CACHE_FILE,
  DEFAULT_RATE_LIMIT_MS,
  DEFAULT_TIMEOUT_MS,
  MB_BASE,
  fetchMusicBrainzJson,
  fetchMusicBrainzRecordingByMbid,
  fetchMusicBrainzReleaseByMbid,
  normalizeRecording,
  normalizeRelease,
  normalizeReleaseDetails,
  parseYear,
  readCache,
  writeCache,
};
