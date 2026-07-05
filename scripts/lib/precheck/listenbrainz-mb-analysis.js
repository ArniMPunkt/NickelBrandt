'use strict';

const { lookupListenBrainzMetadata } = require('../sources/listenbrainz');
const {
  fetchMusicBrainzRecordingByMbid,
  fetchMusicBrainzReleaseByMbid,
  parseYear,
} = require('../sources/musicbrainz-recording');

const CONTEXT_PATTERNS = [
  ['various_artists_context', /\b(various artists|various)\b/i],
  ['soundtrack_context', /\b(soundtrack|motion picture|dreamworks|trolls|original soundtrack)\b/i],
  ['live_context', /\b(live|live from|in concert)\b/i],
  ['best_of_context', /\b(best of|greatest hits|hits|singles|essentials?|gold|platinum)\b/i],
  ['compilation_context', /\b(compilation|collection|anthology|chartshow|charts?|now that'?s what i call|winter anthems|katalog|sammlung)\b/i],
  ['deluxe_context', /\b(deluxe|expanded|anniversary|special edition|bonus tracks?)\b/i],
];

const VERSION_PATTERNS = [
  ['re_recorded', /\b(re[-\s]?record(?:ed|ing)?|new recording)\b/i],
  ['neuaufnahme', /\bneuaufnahme\b/i],
  ['live', /\blive\b/i],
  ['remix', /\b(remix|mix)\b/i],
  ['radio_edit', /\bradio edit\b/i],
  ['single_version', /\bsingle version\b/i],
  ['remastered', /\bremaster(?:ed)?\b/i],
  ['original_version_year_hint', /\boriginal(?: version)?\s*(?:19|20)\d{2}\b/i],
];

const TECHNICAL_ERROR_STATUSES = new Set([
  'error',
  'timeout',
  'rate_limited',
  'skipped_no_token',
  'skipped_missing_input',
]);

function cleanText(value) {
  return value == null ? '' : String(value).trim();
}

function compact(values) {
  return values.map(cleanText).filter(Boolean);
}

function addFlag(flags, flag) {
  if (flag && !flags.includes(flag)) flags.push(flag);
}

function normalizeText(value) {
  return cleanText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, ' ')
    .replace(/\bfeat(?:uring)?\.?\b/g, ' ')
    .replace(/\bthe\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bsummer\s*time\b/g, 'summertime')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return normalizeText(value).split(' ').filter(Boolean);
}

function tokenScore(expected, actual) {
  const expectedTokens = tokens(expected);
  const actualTokens = tokens(actual);
  if (!expectedTokens.length || !actualTokens.length) return 0;

  const expectedSet = new Set(expectedTokens);
  const actualSet = new Set(actualTokens);
  let overlap = 0;
  for (const token of expectedSet) {
    if (actualSet.has(token)) overlap++;
  }

  return overlap / Math.max(expectedSet.size, actualSet.size);
}

function plausibleTitle(expected, actual) {
  const expectedNorm = normalizeText(expected);
  const actualNorm = normalizeText(actual);
  if (!expectedNorm || !actualNorm) return false;
  return (
    expectedNorm === actualNorm ||
    expectedNorm.includes(actualNorm) ||
    actualNorm.includes(expectedNorm) ||
    tokenScore(expectedNorm, actualNorm) >= 0.62
  );
}

function plausibleArtist(expected, actual) {
  const expectedNorm = normalizeText(expected);
  const actualNorm = normalizeText(actual);
  if (!expectedNorm || !actualNorm) return false;
  return (
    expectedNorm === actualNorm ||
    expectedNorm.includes(actualNorm) ||
    actualNorm.includes(expectedNorm) ||
    tokenScore(expectedNorm, actualNorm) >= 0.45
  );
}

function spotifyYear(row) {
  return parseYear(
    row.spotify_year ||
      row.estimated_year ||
      row.csv_year ||
      row.spotify_album_release_date ||
      row.inputEstimatedYear ||
      row.spotifyEstimatedYear
  );
}

function currentMbYear(row) {
  return parseYear(row.current_mb_year || row.mb_year || row.mbYear);
}

function discogsYear(row) {
  return parseYear(row.discogs_year || row.discogsYear);
}

function titleFromRow(row) {
  return cleanText(row.title || row.spotify_match_name || row.spName);
}

function artistFromRow(row) {
  return cleanText(row.artist || row.spotify_match_artist || row.spArtist);
}

function releaseGroupText(release) {
  const group = release && release.release_group;
  if (!group) return '';
  return compact([
    group.title,
    group.primary_type,
    ...(Array.isArray(group.secondary_types) ? group.secondary_types : []),
  ]).join(' ');
}

function contextTexts({ row, listenBrainz, recording, release }) {
  return compact([
    row && row.title,
    row && row.spotify_album_name,
    row && row.notes,
    listenBrainz && listenBrainz.release_name,
    recording && recording.disambiguation,
    release && release.title,
    release && release.disambiguation,
    release && release.artist_credit_name,
    releaseGroupText(release),
  ]);
}

function detectContextFlags(input) {
  const flags = [];
  const texts = contextTexts(input);

  for (const text of texts) {
    for (const [flag, pattern] of CONTEXT_PATTERNS) {
      if (pattern.test(text)) addFlag(flags, flag);
    }
  }

  if (flags.length) addFlag(flags, 'noisy_release_context');
  return flags;
}

function detectVersionFlags({ row, listenBrainz }) {
  const flags = [];
  const text = compact([
    row && row.title,
    listenBrainz && listenBrainz.recording_name,
    listenBrainz && listenBrainz.release_name,
  ]).join(' ');

  for (const [flag, pattern] of VERSION_PATTERNS) {
    if (pattern.test(text)) addFlag(flags, flag);
  }

  return flags;
}

function delta(value, reference) {
  return value != null && reference != null ? value - reference : '';
}

function sameYear(a, b) {
  return a != null && b != null && Math.abs(a - b) <= 1;
}

function yearSignal(candidateYear, currentYear, spotify) {
  if (candidateYear == null) return 'no_year';
  const confirmsCurrent = sameYear(candidateYear, currentYear);
  const confirmsSpotify = sameYear(candidateYear, spotify);
  if (confirmsCurrent && confirmsSpotify) return 'confirms_current_mb_and_spotify';
  if (currentYear != null && currentYear - candidateYear > 1) {
    return 'alternative_earlier_than_current_mb';
  }
  if (currentYear != null && candidateYear - currentYear > 1) {
    return 'alternative_later_than_current_mb';
  }
  if (confirmsCurrent) return 'confirms_current_mb';
  if (confirmsSpotify) return 'confirms_spotify';
  return 'no_year';
}

function hasEarlierSourceSupport(candidateYear, currentYear, spotify, discogs) {
  if (candidateYear == null || currentYear == null || currentYear - candidateYear <= 1) {
    return false;
  }

  return [spotify, discogs].some(
    (year) => year != null && currentYear - year > 1 && Math.abs(year - candidateYear) <= 2
  );
}

function hasDiscogsConflict(candidateYear, discogs) {
  return candidateYear != null && discogs != null && Math.abs(candidateYear - discogs) > 2;
}

function hasHardVersionRisk(versionFlags) {
  return versionFlags.some((flag) =>
    ['re_recorded', 'neuaufnahme', 'live', 'remix', 'remastered'].includes(flag)
  );
}

function matchStatusFromListenBrainz(listenBrainz) {
  if (!listenBrainz) return 'error';
  if (listenBrainz.status === 'no_match') return 'no_match';
  if (TECHNICAL_ERROR_STATUSES.has(listenBrainz.status)) return 'error';
  if (listenBrainz.status !== 'ok') return 'error';
  if (!listenBrainz.recording_mbid) return 'no_mbid';
  return 'ok';
}

function recommendationFor({
  matchStatus,
  signal,
  contextFlags,
  versionFlags,
  candidateYear,
  currentYear,
  spotify,
  discogs,
}) {
  if (['no_match', 'error', 'no_mbid', 'no_musicbrainz_year'].includes(matchStatus)) {
    return 'unusable';
  }

  if (versionFlags.includes('original_version_year_hint') && !sameYear(candidateYear, spotify)) {
    return 'manual_conflicting_years';
  }

  if (hasHardVersionRisk(versionFlags)) return 'manual_version_risk';

  if (contextFlags.includes('title_mismatch') || contextFlags.includes('artist_mismatch')) {
    return 'manual_noisy_context';
  }

  if (
    signal === 'alternative_earlier_than_current_mb' &&
    hasEarlierSourceSupport(candidateYear, currentYear, spotify, discogs)
  ) {
    return 'useful_alternative_mb_year';
  }

  if (signal === 'alternative_earlier_than_current_mb' || signal === 'alternative_later_than_current_mb') {
    return 'manual_conflicting_years';
  }

  if (hasDiscogsConflict(candidateYear, discogs)) return 'manual_conflicting_years';

  if (contextFlags.length) {
    if (
      signal === 'confirms_current_mb' ||
      signal === 'confirms_spotify' ||
      signal === 'confirms_current_mb_and_spotify'
    ) {
      return 'likely_accept_existing_mb_with_context_warning';
    }
    return 'manual_noisy_context';
  }

  if (
    signal === 'confirms_current_mb' ||
    signal === 'confirms_spotify' ||
    signal === 'confirms_current_mb_and_spotify'
  ) {
    return 'likely_accept_existing_mb';
  }

  return 'manual_conflicting_years';
}

function legacyQualityFor(recommendation, matchStatus) {
  if (matchStatus !== 'ok') return 'no_match_or_error';
  if (recommendation === 'useful_alternative_mb_year') return 'useful_conflict_candidate';
  if (recommendation === 'likely_accept_existing_mb') return 'strong_candidate';
  if (recommendation === 'likely_accept_existing_mb_with_context_warning') return 'context_warning_candidate';
  return 'review_candidate';
}

function emptyAnalysis(row, overrides = {}) {
  const title = titleFromRow(row);
  const artist = artistFromRow(row);
  const current = currentMbYear(row);
  const spotify = spotifyYear(row);
  const discogs = discogsYear(row);
  return {
    title,
    artist,
    current_mb_year: current == null ? '' : current,
    spotify_year: spotify == null ? '' : spotify,
    discogs_year: discogs == null ? '' : discogs,
    listenbrainz_recording_mbid: '',
    listenbrainz_recording_name: '',
    listenbrainz_release_mbid: '',
    listenbrainz_release_name: '',
    listenbrainz_mb_year: '',
    listenbrainz_mb_year_source: '',
    listenbrainz_year_delta_vs_current_mb: '',
    listenbrainz_year_delta_vs_spotify: '',
    listenbrainz_match_status: 'error',
    listenbrainz_year_signal: 'no_year',
    listenbrainz_context_flags: '',
    listenbrainz_version_flags: '',
    listenbrainz_candidate_quality: 'no_match_or_error',
    listenbrainz_warning_flags: '',
    listenbrainz_recommendation: 'unusable',
    status: '',
    error: '',
    ...overrides,
  };
}

function listenBrainzFromRow(row) {
  if (
    !row ||
    !(
      row.listenbrainz_recording_mbid ||
      row.listenbrainz_release_mbid ||
      row.listenbrainz_lookup_status
    )
  ) {
    return null;
  }

  const status = cleanText(row.listenbrainz_lookup_status) ||
    (row.listenbrainz_recording_mbid || row.listenbrainz_release_mbid ? 'ok' : 'no_match');

  return {
    status,
    error: row.listenbrainz_lookup_error || row.error || '',
    recording_mbid: cleanText(row.listenbrainz_recording_mbid),
    recording_name: cleanText(row.listenbrainz_recording_name),
    release_mbid: cleanText(row.listenbrainz_release_mbid),
    release_name: cleanText(row.listenbrainz_release_name),
  };
}

async function resolveListenBrainz(row, title, artist, options) {
  const fromRow = listenBrainzFromRow(row);
  if (fromRow) return fromRow;

  const listenBrainzLookup = options.listenBrainzLookup || lookupListenBrainzMetadata;
  return listenBrainzLookup(
    {
      title,
      artist,
      releaseName: row.spotify_album_name || row.release_name || '',
    },
    options.listenBrainzOptions || {}
  );
}

async function analyzeListenBrainzMusicBrainzCandidate(row = {}, options = {}) {
  const title = titleFromRow(row);
  const artist = artistFromRow(row);
  const current = currentMbYear(row);
  const spotify = spotifyYear(row);
  const discogs = discogsYear(row);
  const fetchRecording = options.fetchRecording || fetchMusicBrainzRecordingByMbid;
  const fetchRelease = options.fetchRelease || fetchMusicBrainzReleaseByMbid;

  let listenBrainz;
  try {
    listenBrainz = await resolveListenBrainz(row, title, artist, options);
  } catch (error) {
    return emptyAnalysis(row, {
      listenbrainz_match_status: 'error',
      status: 'listenbrainz_error',
      error: cleanText(error && error.message) || 'listenbrainz_failed',
    });
  }

  const base = emptyAnalysis(row, {
    listenbrainz_recording_mbid: cleanText(listenBrainz && listenBrainz.recording_mbid),
    listenbrainz_recording_name: cleanText(listenBrainz && listenBrainz.recording_name),
    listenbrainz_release_mbid: cleanText(listenBrainz && listenBrainz.release_mbid),
    listenbrainz_release_name: cleanText(listenBrainz && listenBrainz.release_name),
    listenbrainz_match_status: matchStatusFromListenBrainz(listenBrainz),
    status: listenBrainz && listenBrainz.status ? `listenbrainz_${listenBrainz.status}` : '',
    error: cleanText(listenBrainz && listenBrainz.error),
  });

  if (!listenBrainz || listenBrainz.status !== 'ok' || base.listenbrainz_match_status !== 'ok') {
    return base;
  }

  const contextFlags = [];
  const versionFlags = detectVersionFlags({ row, listenBrainz });
  let recording = null;
  let release = null;

  const recordingResult = await fetchRecording(
    listenBrainz.recording_mbid,
    options.musicBrainzOptions || {}
  );
  if (!recordingResult || recordingResult.status !== 'ok') {
    return {
      ...base,
      listenbrainz_match_status: 'error',
      listenbrainz_recommendation: 'unusable',
      status: recordingResult && recordingResult.status
        ? `musicbrainz_recording_${recordingResult.status}`
        : 'musicbrainz_recording_error',
      error: cleanText(recordingResult && recordingResult.error),
    };
  }
  recording = recordingResult;

  if (listenBrainz.release_mbid) {
    const releaseResult = await fetchRelease(
      listenBrainz.release_mbid,
      options.musicBrainzOptions || {}
    );
    if (releaseResult && releaseResult.status === 'ok') {
      release = releaseResult;
    } else if (releaseResult && releaseResult.status) {
      addFlag(contextFlags, `musicbrainz_release_${releaseResult.status}`);
    }
  }

  for (const flag of detectContextFlags({ row, listenBrainz, recording, release })) {
    addFlag(contextFlags, flag);
  }

  const candidateYear = parseYear(recording.year);
  let matchStatus = 'ok';
  if (candidateYear == null) matchStatus = 'no_musicbrainz_year';

  const recordingTitle = cleanText(recording.title || listenBrainz.recording_name);
  const recordingArtist = cleanText(recording.artist_credit_name || listenBrainz.artist_credit_name);
  if (!plausibleTitle(title, recordingTitle)) addFlag(contextFlags, 'title_mismatch');
  if (!plausibleArtist(artist, recordingArtist)) addFlag(contextFlags, 'artist_mismatch');

  const signal = yearSignal(candidateYear, current, spotify);
  const recommendation = recommendationFor({
    matchStatus,
    signal,
    contextFlags,
    versionFlags,
    candidateYear,
    currentYear: current,
    spotify,
    discogs,
  });
  const quality = legacyQualityFor(recommendation, matchStatus);

  return {
    ...base,
    listenbrainz_recording_name: recordingTitle || base.listenbrainz_recording_name,
    listenbrainz_mb_year: candidateYear == null ? '' : candidateYear,
    listenbrainz_mb_year_source: cleanText(recording.year_source),
    listenbrainz_year_delta_vs_current_mb: delta(candidateYear, current),
    listenbrainz_year_delta_vs_spotify: delta(candidateYear, spotify),
    listenbrainz_match_status: matchStatus,
    listenbrainz_year_signal: signal,
    listenbrainz_context_flags: contextFlags.join('+'),
    listenbrainz_version_flags: versionFlags.join('+'),
    listenbrainz_candidate_quality: quality,
    listenbrainz_warning_flags: [...contextFlags, ...versionFlags].join('+'),
    listenbrainz_recommendation: recommendation,
    status: 'ok',
    error: '',
  };
}

module.exports = {
  CONTEXT_PATTERNS,
  VERSION_PATTERNS,
  analyzeListenBrainzMusicBrainzCandidate,
  detectContextFlags,
  detectVersionFlags,
  legacyQualityFor,
  normalizeText,
  plausibleArtist,
  plausibleTitle,
  recommendationFor,
  spotifyYear,
  yearSignal,
};
