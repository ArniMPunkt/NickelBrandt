'use strict';

const MB_OK_STATUSES = new Set(['mb_ok', 'ok', 'accepted', 'strong']);
const MB_UNCERTAIN_STATUSES = new Set(['mb_match_uncertain', 'uncertain', 'low_confidence']);

const COMPILATION_RE =
  /\b(compilation|various artists|best of|greatest hits|collection|anthology|hits|singles|essentials?)\b/i;
const REMASTER_DELUXE_RE =
  /\b(remaster(?:ed)?|deluxe|anniversary|reissue|expanded|special edition|legacy edition|bonus tracks?)\b/i;
const MIN_RELEASE_YEAR = 1900;

function firstValue(input, names) {
  for (const name of names) {
    const value = input && input[name];
    if (value != null && String(value).trim() !== '') return value;
  }
  return null;
}

function parseYear(value, currentYear = new Date().getFullYear()) {
  if (value == null) return null;
  const maxReleaseYear = currentYear + 1;
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_RELEASE_YEAR &&
    value <= maxReleaseYear
  ) {
    return value;
  }
  const match = String(value).trim().match(/^(\d{4})/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  return Number.isFinite(year) && year >= MIN_RELEASE_YEAR && year <= maxReleaseYear ? year : null;
}

function parseScore(value) {
  if (value == null || String(value).trim() === '') return null;
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

function getIsrc(input) {
  return String(firstValue(input, ['isrc', 'ISRC']) || '').trim();
}

function getMusicBrainzYear(input) {
  return parseYear(firstValue(input, ['mb_year', 'mbYear', 'musicbrainz_year', 'musicBrainzYear']));
}

function getMusicBrainzStatus(input) {
  return String(firstValue(input, ['mb_status', 'mbStatus', 'mb_year_source', 'mbYearSource']) || '')
    .trim()
    .toLowerCase();
}

function getMusicBrainzMatchMethod(input) {
  return String(firstValue(input, ['mb_match_method', 'mbMatchMethod']) || '')
    .trim()
    .toLowerCase();
}

function getMusicBrainzScore(input) {
  return parseScore(firstValue(input, ['mb_score', 'mbScore']));
}

function getSpotifyAlbumYear(input) {
  return parseYear(
    firstValue(input, [
      'spotify_album_year',
      'spotifyAlbumYear',
      'spotify_album_release_date',
      'spotifyAlbumReleaseDate',
      'estimated_year',
      'estimatedYear',
      'spotifyEstimatedYear',
    ])
  );
}

function getExistingYear(input) {
  return parseYear(firstValue(input, ['existing_year', 'existingYear']));
}

function getDiscogsYear(input) {
  return parseYear(firstValue(input, ['discogs_year', 'discogsYear']));
}

function contextText(input) {
  return [
    firstValue(input, ['spotify_album_name', 'spotifyAlbumName', 'album_name', 'albumName']),
    firstValue(input, ['spotify_album_artist', 'spotifyAlbumArtist', 'album_artist', 'albumArtist']),
  ]
    .filter(Boolean)
    .join(' ');
}

function hasCompilationContext(input) {
  const albumType = String(firstValue(input, ['spotify_album_type', 'spotifyAlbumType']) || '')
    .trim()
    .toLowerCase();
  return albumType === 'compilation' || COMPILATION_RE.test(contextText(input));
}

function hasRemasterOrDeluxeContext(input) {
  return REMASTER_DELUXE_RE.test(contextText(input));
}

function add(flags, flag) {
  if (!flags.includes(flag)) flags.push(flag);
}

function detectRiskFlags(input) {
  const flags = [];
  const mbYear = getMusicBrainzYear(input);
  const mbStatus = getMusicBrainzStatus(input);
  const mbMethod = getMusicBrainzMatchMethod(input);
  const existingYear = getExistingYear(input);
  const discogsYear = getDiscogsYear(input);
  const spotifyAlbumYear = getSpotifyAlbumYear(input);
  const compilationContext = hasCompilationContext(input);
  const remasterOrDeluxeContext = hasRemasterOrDeluxeContext(input);
  const catalogContext = compilationContext || remasterOrDeluxeContext;

  if (!getIsrc(input)) add(flags, 'no_isrc');

  if (mbStatus === 'mb_no_match' || mbYear == null) add(flags, 'mb_no_match');
  if (
    MB_UNCERTAIN_STATUSES.has(mbStatus) ||
    (mbYear != null && mbStatus && !MB_OK_STATUSES.has(mbStatus))
  ) {
    add(flags, 'mb_uncertain');
  }

  if (mbMethod.startsWith('text')) add(flags, 'mb_text_match_only');
  if (catalogContext) add(flags, 'catalog_context');
  if (remasterOrDeluxeContext) add(flags, 'remaster_or_deluxe_context');
  if (compilationContext) add(flags, 'compilation_context');

  if (existingYear != null && mbYear != null && Math.abs(existingYear - mbYear) > 1) {
    add(flags, 'existing_year_conflict');
  }

  if (discogsYear != null && mbYear != null && mbYear - discogsYear > 1) {
    add(flags, 'discogs_earlier_than_mb');
  }

  const mbNearSpotifyAlbumYear =
    mbYear != null && spotifyAlbumYear != null && Math.abs(mbYear - spotifyAlbumYear) <= 1;
  const mbLaterThanExisting = existingYear != null && mbYear != null && mbYear - existingYear > 1;
  const mbLaterThanDiscogs = discogsYear != null && mbYear != null && mbYear - discogsYear > 1;
  if ((catalogContext && mbNearSpotifyAlbumYear) || mbLaterThanExisting || mbLaterThanDiscogs) {
    add(flags, 'mb_year_suspicious_late');
  }

  return flags;
}

module.exports = {
  detectRiskFlags,
  parseYear,
  getDiscogsYear,
  getExistingYear,
  getIsrc,
  getMusicBrainzMatchMethod,
  getMusicBrainzScore,
  getMusicBrainzStatus,
  getMusicBrainzYear,
  getSpotifyAlbumYear,
};
