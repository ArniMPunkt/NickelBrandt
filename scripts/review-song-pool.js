'use strict';

const fs = require('fs');
const path = require('path');
const { parseCsvObjects, writeCsvObjects } = require('./lib/util');
const {
  formatGroupSummary,
  groupReviewRows,
  reviewQueue,
  runInteractiveReview,
} = require('./lib/precheck/interactive-review');

const REQUIRED_REVIEW_COLUMNS = [
  'status',
  'chosen_candidate',
  'notes',
  'exclusion_reason',
  'final_year',
  'final_source',
  'review_reason',
];

function resolveCsvPath(filePath) {
  return path.resolve(process.cwd(), filePath);
}

function assertDistinctPaths(inputCsv, outputCsv) {
  const inPath = resolveCsvPath(inputCsv);
  const outPath = resolveCsvPath(outputCsv);
  if (inPath.toLowerCase() === outPath.toLowerCase()) {
    throw new Error('Input- und Output-CSV duerfen im Review-only-Modus nicht identisch sein.');
  }
}

function ensureReviewColumns(columns) {
  const out = [...columns];
  for (const column of REQUIRED_REVIEW_COLUMNS) {
    if (!out.includes(column)) out.push(column);
  }
  return out;
}

function loadReviewCsv(inputCsv) {
  const parsed = parseCsvObjects(fs.readFileSync(inputCsv, 'utf8'));
  return {
    rows: parsed.objects,
    columns: ensureReviewColumns(parsed.keys),
    originalColumns: parsed.keys,
  };
}

function saveReviewCsv(outputCsv, rows, columns) {
  writeCsvObjects(outputCsv, columns, rows);
}

function countByStatus(rows) {
  const counts = {};
  for (const row of rows) {
    const status = row.status || '(leer)';
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function reviewOnlySummary(rows) {
  const openRows = reviewQueue(rows);
  const groups = groupReviewRows(rows);
  return {
    totalRows: rows.length,
    openRows: openRows.length,
    groups,
    statusCounts: countByStatus(rows),
  };
}

function printReviewOnlySummary(summary) {
  console.log('\nReview-only Modus');
  console.log(`Songs gesamt: ${summary.totalRows}`);
  if (summary.groups.length > 0) {
    console.log('');
    console.log(formatGroupSummary(summary.groups));
  } else {
    console.log('Offene Reviews: 0');
  }
}

async function runReviewOnly(inputCsv, outputCsv, options = {}) {
  assertDistinctPaths(inputCsv, outputCsv);
  const { rows, columns } = loadReviewCsv(inputCsv);
  const summaryBefore = reviewOnlySummary(rows);
  printReviewOnlySummary(summaryBefore);

  const runner = options.reviewRunner || runInteractiveReview;
  const shouldRunInteractive =
    options.interactive !== false && (options.reviewRunner || process.stdin.isTTY);

  const save = () => saveReviewCsv(outputCsv, rows, columns);
  if (shouldRunInteractive) {
    await runner(rows, { save });
  } else {
    console.log('Kein interaktives Terminal erkannt - CSV wird unveraendert gespeichert.');
  }

  save();
  const summaryAfter = reviewOnlySummary(rows);
  console.log(`\nReview-CSV geschrieben: ${outputCsv}`);
  console.log('Statusverteilung:');
  for (const [status, count] of Object.entries(summaryAfter.statusCounts).sort()) {
    console.log(`  ${status}: ${count}`);
  }
  console.log(`Offen/blockiert fuer Review-only: ${summaryAfter.openRows}`);
  return { rows, columns, summaryBefore, summaryAfter };
}

function usageAndExit() {
  console.error('Usage: node scripts/review-song-pool.js <input_review.csv> <output_review.csv>');
  process.exit(1);
}

async function main() {
  const [inputCsv, outputCsv, ...rest] = process.argv.slice(2);
  if (!inputCsv || !outputCsv || rest.length > 0) usageAndExit();

  try {
    await runReviewOnly(inputCsv, outputCsv);
  } catch (error) {
    console.error('\nFatal error:', error && error.message ? error.message : error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  assertDistinctPaths,
  countByStatus,
  ensureReviewColumns,
  loadReviewCsv,
  reviewOnlySummary,
  runReviewOnly,
  saveReviewCsv,
};
