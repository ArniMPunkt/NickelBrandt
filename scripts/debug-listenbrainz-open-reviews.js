'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { csvEscape, loadEnv, parseCsvObjects } = require('./lib/util');
const {
  analyzeListenBrainzMusicBrainzCandidate,
} = require('./lib/precheck/listenbrainz-mb-analysis');

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
  'listenbrainz_mb_year',
  'listenbrainz_mb_year_source',
  'listenbrainz_year_delta_vs_current_mb',
  'listenbrainz_year_delta_vs_spotify',
  'listenbrainz_match_status',
  'listenbrainz_year_signal',
  'listenbrainz_context_flags',
  'listenbrainz_version_flags',
  'listenbrainz_candidate_quality',
  'listenbrainz_warning_flags',
  'listenbrainz_recommendation',
  'status',
  'error',
];

function parseArgs(argv) {
  const options = {
    format: 'jsonl',
    inputPath: '',
    outputPath: '',
    limit: null,
    listenBrainzResultsPath: '',
  };

  for (const arg of argv) {
    if (arg.startsWith('--format=')) {
      options.format = arg.slice('--format='.length).trim().toLowerCase();
    } else if (arg.startsWith('--limit=')) {
      const n = Number.parseInt(arg.slice('--limit='.length), 10);
      options.limit = Number.isFinite(n) && n >= 0 ? n : null;
    } else if (arg.startsWith('--listenbrainz-results=')) {
      options.listenBrainzResultsPath = arg.slice('--listenbrainz-results='.length).trim();
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
    '  node scripts/debug-listenbrainz-open-reviews.js <review.csv> [output-file] [--format=jsonl|csv] [--limit=N] [--listenbrainz-results=lb.csv]',
    '',
    'Reads only review_needed and review_needed_after_discogs rows.',
  ].join('\n');
}

function normalizeKeyPart(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function rowKey(row) {
  return `${normalizeKeyPart(row.title)}|${normalizeKeyPart(row.artist)}`;
}

function loadListenBrainzResults(filePath) {
  if (!filePath) return new Map();
  const text = fs.readFileSync(filePath, 'utf8');
  const { objects } = parseCsvObjects(text);
  const byKey = new Map();

  for (const row of objects) {
    byKey.set(rowKey(row), row);
  }

  return byKey;
}

function mergeListenBrainzResult(row, listenBrainzResults) {
  if (!listenBrainzResults || listenBrainzResults.size === 0) return row;
  const found = listenBrainzResults.get(rowKey(row));
  if (!found) return row;

  return {
    ...row,
    listenbrainz_lookup_status: found.status || found.listenbrainz_lookup_status || '',
    listenbrainz_lookup_error: found.error || found.listenbrainz_lookup_error || '',
    listenbrainz_recording_mbid: found.listenbrainz_recording_mbid || '',
    listenbrainz_recording_name: found.listenbrainz_recording_name || '',
    listenbrainz_release_mbid: found.listenbrainz_release_mbid || '',
    listenbrainz_release_name: found.listenbrainz_release_name || '',
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

  const listenBrainzResults = loadListenBrainzResults(options.listenBrainzResultsPath);
  const output = [];
  for (const row of rows) {
    output.push(await analyzeListenBrainzMusicBrainzCandidate(
      mergeListenBrainzResult(row, listenBrainzResults)
    ));
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
  loadListenBrainzResults,
  mergeListenBrainzResult,
};
