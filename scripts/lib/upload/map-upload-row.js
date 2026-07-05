'use strict';

const { parseUploadYear } = require('./validate-upload-rows');

function cleanText(value) {
  return value == null ? '' : String(value).trim();
}

function mapUploadRow(row, poolId) {
  const finalYear = parseUploadYear(row && row.final_year);
  if (finalYear == null) throw new Error(`Invalid final_year for "${(row && row.title) || '-'}".`);

  return {
    pool_id: poolId,
    title: cleanText(row.spotify_match_name) || cleanText(row.title),
    artist: cleanText(row.spotify_match_artist) || cleanText(row.artist),
    spotify_track_id: cleanText(row.spotify_track_id),
    release_year: finalYear,
    isrc: cleanText(row.isrc) || null,
  };
}

function finalYearDiffersFromMb(row) {
  const finalYear = parseUploadYear(row && row.final_year);
  const mbYear = parseUploadYear(row && row.mb_year);
  return finalYear != null && mbYear != null && finalYear !== mbYear;
}

module.exports = {
  finalYearDiffersFromMb,
  mapUploadRow,
};
