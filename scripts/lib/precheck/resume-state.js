'use strict';

const fs = require('fs');
const { parseCsvObjects } = require('../util');
const { MANUAL_STATUSES } = require('./review-schema');
const { norm } = require('./helpers');
const { hasFinalYear } = require('./review-queue');

function rowKey(row) {
  const trackId = String(row.spotify_track_id || row.spotifyTrackId || '').trim();
  if (trackId) return `sp:${trackId}`;
  return `txt:${norm(row.title)}|${norm(row.artist)}`;
}

function loadExistingRows(outputCsv) {
  if (!fs.existsSync(outputCsv)) return new Map();
  const { objects } = parseCsvObjects(fs.readFileSync(outputCsv, 'utf8'));
  const existing = new Map();
  for (const row of objects) existing.set(rowKey(row), row);
  return existing;
}

function mergeResumeState(rows, outputCsv) {
  const existing = loadExistingRows(outputCsv);
  if (existing.size === 0) return { resumed: 0 };

  let resumed = 0;
  for (const row of rows) {
    const prev = existing.get(rowKey(row));
    if (!prev) continue;

    const prevStatus = String(prev.status || '');
    const keepState = hasFinalYear(prev) || MANUAL_STATUSES.has(prevStatus);
    if (!keepState) continue;

    for (const key of ['final_year', 'status', 'notes', 'chosen_candidate', 'manual_source_url', 'exclusion_reason']) {
      if (prev[key] != null && String(prev[key]).trim() !== '') row[key] = prev[key];
    }
    resumed += 1;
  }

  return { resumed };
}

module.exports = {
  loadExistingRows,
  mergeResumeState,
  rowKey,
};
