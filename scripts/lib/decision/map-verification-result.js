'use strict';

function firstValue(...values) {
  for (const value of values) {
    if (value != null && String(value).trim() !== '') return value;
  }
  return '';
}

function mapVerificationResultToDecisionInput(result = {}) {
  const input = result.input || {};

  return {
    title: firstValue(result.spName, input.title, result.title),
    artist: firstValue(result.spArtist, input.artist, result.artist),
    isrc: firstValue(input.isrc, result.isrc),

    spotify_album_name: firstValue(input.spotifyAlbumName, input.spotify_album_name, result.spotify_album_name),
    spotify_album_type: firstValue(input.spotifyAlbumType, input.spotify_album_type, result.spotify_album_type),
    spotify_album_release_date: firstValue(
      input.spotifyAlbumReleaseDate,
      input.spotify_album_release_date,
      result.spotify_album_release_date
    ),
    spotify_album_artist: firstValue(input.spotifyAlbumArtist, input.spotify_album_artist, result.spotify_album_artist),
    estimated_year: firstValue(
      input.inputEstimatedYear,
      input.spotifyEstimatedYear,
      input.estimatedYear,
      input.estimated_year,
      result.estimated_year
    ),

    existing_year: firstValue(input.existingYear, input.existing_year, result.existing_year),

    mb_year: firstValue(result.mbYear, result.mb_year),
    mb_status: firstValue(result.mbStatus, result.mb_status, result.mb_year_source, result.consensusStatus),
    mb_match_method: firstValue(result.mbMatchMethod, result.mb_match_method),
    mb_score: firstValue(result.mbScore, result.mb_score),

    discogs_year: firstValue(result.discogsYear, result.discogs_year),
  };
}

module.exports = { mapVerificationResultToDecisionInput };
