'use strict';

const fs = require('fs');
const { parseCSV, parseCsvObjects } = require('../util');
const { inputValue, norm, toIntYear } = require('./helpers');

function detectExistingYear(row) {
  const candidates = [
    ['final_year', inputValue(row, ['final_year'])],
    ['release_year', inputValue(row, ['release_year'])],
    ['csv_year', inputValue(row, ['csv_year'])],
  ];
  for (const [source, raw] of candidates) {
    const year = toIntYear(raw);
    if (year != null) return { year, source };
  }
  return { year: null, source: '' };
}

function hasHeader(rows) {
  if (!rows.length) return false;
  const h = rows[0].map((x) => norm(x).replace(/\s+/g, '_'));
  return h.includes('title') && h.includes('artist');
}

function objectFromPositionalRow(row) {
  return {
    title: row[0] || '',
    artist: row[1] || '',
    estimated_year: row[2] || '',
  };
}

function loadSmartInputCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    process.exit(1);
  }
  const text = fs.readFileSync(csvPath, 'utf8');
  const rawRows = parseCSV(text);
  if (!rawRows.length) {
    console.error('CSV is empty.');
    process.exit(1);
  }

  const objects = hasHeader(rawRows)
    ? parseCsvObjects(text).objects
    : rawRows.map(objectFromPositionalRow);

  const out = [];
  for (const row of objects) {
    const title = inputValue(row, ['title', 'spotify_match_name']);
    const artist = inputValue(row, ['artist', 'spotify_match_artist']);
    if (!title || !artist) continue;

    const estimatedYear = toIntYear(inputValue(row, ['estimated_year']));
    const csvYear = toIntYear(inputValue(row, ['csv_year']));
    const spotifyEstimatedYear = estimatedYear != null ? estimatedYear : csvYear;
    const existing = detectExistingYear(row);

    out.push({
      title,
      artist,
      estimatedYear: spotifyEstimatedYear,
      spotifyEstimatedYear,
      inputEstimatedYear: estimatedYear,
      inputCsvYear: csvYear,
      existingYear: existing.year,
      existingYearSource: existing.source,
      existingStatus: inputValue(row, ['status']),
      existingNotes: inputValue(row, ['notes']),
      spotifyTrackId: inputValue(row, ['spotify_track_id', 'track_id']),
      isrc: inputValue(row, ['isrc']) || null,
      spotifyAlbumName: inputValue(row, ['spotify_album_name']),
      spotifyAlbumType: inputValue(row, ['spotify_album_type']),
      spotifyAlbumReleaseDate: inputValue(row, ['spotify_album_release_date']),
      spotifyDurationMs: inputValue(row, ['spotify_duration_ms']),
      spotifyAlbumArtist: inputValue(row, ['spotify_album_artist']),
      spotifyTrackNumber: inputValue(row, ['spotify_track_number']),
      spotifyDiscNumber: inputValue(row, ['spotify_disc_number']),
      manualSourceUrl: inputValue(row, ['manual_source_url']),
      exclusionReason: inputValue(row, ['exclusion_reason']),
      inputDeezerYear: toIntYear(inputValue(row, ['deezer_year'])),
      inputDeezerInvalidYear: toIntYear(inputValue(row, ['deezer_invalid_year'])),
      inputDeezerStatus: inputValue(row, ['deezer_status']),
      inputDeezerTrackId: inputValue(row, ['deezer_track_id']),
      inputDiscogsYear: toIntYear(inputValue(row, ['discogs_year'])),
      inputDiscogsRejectedYear: toIntYear(inputValue(row, ['discogs_rejected_year'])),
      inputDiscogsRejectedReason: inputValue(row, ['discogs_rejected_reason']),
    });
  }
  return out;
}

function hasDeezerInput(row) {
  return row.inputDeezerYear != null || row.inputDeezerInvalidYear != null || !!row.inputDeezerStatus;
}

function deezerRowKeys(row) {
  const keys = [];
  const isrc = String(row.isrc || '').trim().toUpperCase();
  const trackId = String(row.spotify_track_id || row.spotifyTrackId || '').trim();
  const title = row.title || '';
  const artist = row.artist || '';
  if (isrc) keys.push(`isrc:${isrc}`);
  if (trackId) keys.push(`sp:${trackId}`);
  keys.push(`txt:${norm(title)}|${norm(artist)}`);
  return keys;
}

function hydrateInputDeezerFromOutput(inputs, outputCsv) {
  if (!fs.existsSync(outputCsv)) return 0;
  const { objects } = parseCsvObjects(fs.readFileSync(outputCsv, 'utf8'));
  const byKey = new Map();
  for (const row of objects) {
    if (!row.deezer_year && !row.deezer_invalid_year && !row.deezer_status) continue;
    for (const key of deezerRowKeys(row)) {
      if (!byKey.has(key)) byKey.set(key, row);
    }
  }
  let hydrated = 0;
  for (const input of inputs) {
    if (hasDeezerInput(input)) continue;
    let prev = null;
    for (const key of deezerRowKeys(input)) {
      prev = byKey.get(key);
      if (prev) break;
    }
    if (!prev) continue;
    input.inputDeezerYear = toIntYear(prev.deezer_year);
    input.inputDeezerInvalidYear = toIntYear(prev.deezer_invalid_year);
    input.inputDeezerStatus = inputValue(prev, ['deezer_status']) || 'from_output';
    input.inputDeezerTrackId = inputValue(prev, ['deezer_track_id']);
    hydrated += 1;
  }
  return hydrated;
}

module.exports = {
  hydrateInputDeezerFromOutput,
  loadSmartInputCsv,
};
