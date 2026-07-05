'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { csvEscape, loadEnv, parseCsvObjects } = require('./lib/util');
const { lookupListenBrainzMetadata } = require('./lib/sources/listenbrainz');

const OPEN_REVIEW_STATUSES = new Set(['review_needed', 'review_needed_after_discogs']);
const OUTPUT_HEADERS = [
  'title',
  'artist',
  'current_mb_year',
  'spotify_year',
  'discogs_year',
  'listenbrainz_recording_mbid',
  'listenbrainz_recording_name',
  'listenbrainz_release_mbid',
  'listenbrainz_release_name',
  'status',
  'error',
];

function parseArgs(argv) {
  const options = {
    format: 'jsonl',
    inputPath: '',
    outputPath: '',
    limit: null,
  };

  for (const arg of argv) {
    if (arg.startsWith('--format=')) {
      options.format = arg.slice('--format='.length).trim().toLowerCase();
    } else if (arg.startsWith('--limit=')) {
      const n = Number.parseInt(arg.slice('--limit='.length), 10);
      options.limit = Number.isFinite(n) && n >= 0 ? n : null;
    } else if (!options.inputPath) {
      options.inputPath = arg;
    } else if (!options.outputPath) {
      options.outputPath = arg;
    }
  }

  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/debug-listenbrainz-open-reviews.js <review.csv> [output-file] [--format=jsonl|csv] [--limit=N]',
    '',
    'Reads only review_needed and review_needed_after_discogs rows.',
  ].join('\n');
}

function yearFromDate(value) {
  const match = String(value || '').match(/^(\d{4})/);
  return match ? match[1] : '';
}

function spotifyYear(row) {
  return row.estimated_year || row.csv_year || yearFromDate(row.spotify_album_release_date);
}

function toOutputRow(row, result) {
  return {
    title: row.title || row.spotify_match_name || '',
    artist: row.artist || row.spotify_match_artist || '',
    current_mb_year: row.mb_year || '',
    spotify_year: spotifyYear(row),
    discogs_year: row.discogs_year || '',
    listenbrainz_recording_mbid: result.recording_mbid || '',
    listenbrainz_recording_name: result.recording_name || '',
    listenbrainz_release_mbid: result.release_mbid || '',
    listenbrainz_release_name: result.release_name || '',
    status: result.status || '',
    error: result.error || '',
  };
}

function renderJsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
}

function renderCsv(rows) {
  const lines = [OUTPUT_HEADERS.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(OUTPUT_HEADERS.map((header) => csvEscape(row[header])).join(','));
  }
  return lines.join('\n') + '\n';
}

async function buildListenBrainzReviewOutput(reviewCsvPath, options = {}) {
  const text = fs.readFileSync(reviewCsvPath, 'utf8');
  const { objects } = parseCsvObjects(text);
  let rows = objects.filter((row) => OPEN_REVIEW_STATUSES.has(row.status));

  if (Number.isFinite(options.limit)) {
    rows = rows.slice(0, options.limit);
  }

  const output = [];
  for (const row of rows) {
    const result = await lookupListenBrainzMetadata({
      title: row.title || row.spotify_match_name || '',
      artist: row.artist || row.spotify_match_artist || '',
      releaseName: row.spotify_album_name || '',
    });
    output.push(toOutputRow(row, result));
  }

  return output;
}

async function main() {
  loadEnv(path.join(__dirname, '.env'));

  const options = parseArgs(process.argv.slice(2));
  if (!options.inputPath || !['jsonl', 'csv'].includes(options.format)) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const rows = await buildListenBrainzReviewOutput(options.inputPath, options);
  const rendered = options.format === 'csv' ? renderCsv(rows) : renderJsonl(rows);

  if (options.outputPath) {
    fs.writeFileSync(options.outputPath, rendered, 'utf8');
    console.error(`Wrote ${rows.length} ListenBrainz review lookup rows to ${options.outputPath}`);
  } else {
    process.stdout.write(rendered);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = {
  OPEN_REVIEW_STATUSES,
  OUTPUT_HEADERS,
  buildListenBrainzReviewOutput,
  parseArgs,
  renderCsv,
  renderJsonl,
  toOutputRow,
};
