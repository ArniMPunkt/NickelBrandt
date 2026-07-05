'use strict';

const {
  analyzeListenBrainzMusicBrainzCandidate,
} = require('./listenbrainz-mb-analysis');
const { LISTENBRAINZ_COLUMNS } = require('./review-schema');

const LISTENBRAINZ_TARGET_STATUSES = new Set([
  'review_needed',
  'review_needed_after_discogs',
  'soft_discogs_pending',
]);

const FAST_RECOMMENDATIONS = new Set([
  'likely_accept_existing_mb',
  'likely_accept_existing_mb_with_context_warning',
]);

const MANUAL_RECOMMENDATIONS = new Set([
  'manual_conflicting_years',
  'manual_noisy_context',
  'manual_version_risk',
  'unusable',
]);

function countBy(values) {
  const counts = {};
  for (const value of values) {
    const key = value || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function isListenBrainzTarget(row) {
  return LISTENBRAINZ_TARGET_STATUSES.has(row.status);
}

function applyAnalysis(row, analysis) {
  for (const column of LISTENBRAINZ_COLUMNS) {
    row[column] = analysis && analysis[column] != null ? String(analysis[column]) : '';
  }
}

function createListenBrainzReviewStats(rows, mode) {
  const targetRows = rows.filter(isListenBrainzTarget);
  return {
    mode,
    targetRows: targetRows.length,
    checked: 0,
    skippedNoToken: 0,
    errors: 0,
    skippedNonOpen: rows.length - targetRows.length,
    recommendationCounts: {},
    yearSignalCounts: {},
    quicklyConfirmable: 0,
    usefulAlternativeYears: 0,
    manualReview: 0,
    errorOrSkipped: 0,
  };
}

function hasListenBrainzToken(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'token')) {
    return !!String(options.token || '').trim();
  }
  return !!String(process.env.LISTENBRAINZ_USER_TOKEN || '').trim();
}

function updateCounts(stats, rows) {
  const enriched = rows.filter((row) => isListenBrainzTarget(row) && row.listenbrainz_recommendation);
  stats.recommendationCounts = countBy(enriched.map((row) => row.listenbrainz_recommendation));
  stats.yearSignalCounts = countBy(enriched.map((row) => row.listenbrainz_year_signal));
  stats.quicklyConfirmable = enriched.filter((row) =>
    FAST_RECOMMENDATIONS.has(row.listenbrainz_recommendation)
  ).length;
  stats.usefulAlternativeYears = enriched.filter((row) =>
    row.listenbrainz_recommendation === 'useful_alternative_mb_year'
  ).length;
  stats.manualReview = enriched.filter((row) =>
    MANUAL_RECOMMENDATIONS.has(row.listenbrainz_recommendation)
  ).length;
  stats.errorOrSkipped = stats.skippedNoToken + stats.errors;
}

async function enrichOpenReviewsWithListenBrainz(rows, options = {}) {
  const mode = options.mode || 'off';
  const analyzer = options.analyzer || analyzeListenBrainzMusicBrainzCandidate;
  const stats = createListenBrainzReviewStats(rows, mode);

  if (mode === 'off') return stats;
  if (mode !== 'needed') throw new Error(`Unknown ListenBrainz mode: ${mode}`);

  const targets = rows.filter(isListenBrainzTarget);
  if (options.requireToken !== false && !hasListenBrainzToken(options)) {
    stats.skippedNoToken = targets.length;
    stats.errorOrSkipped = stats.skippedNoToken;
    return stats;
  }

  for (const row of targets) {
    try {
      const analysis = await analyzer(row);
      applyAnalysis(row, analysis);
      stats.checked += 1;
      if (row.listenbrainz_match_status === 'error') stats.errors += 1;
    } catch (error) {
      applyAnalysis(row, {
        listenbrainz_match_status: 'error',
        listenbrainz_year_signal: 'no_year',
        listenbrainz_recommendation: 'unusable',
        status: 'listenbrainz_analysis_error',
        error: error && error.message ? error.message : String(error || 'error'),
      });
      stats.checked += 1;
      stats.errors += 1;
    }
  }

  updateCounts(stats, rows);
  return stats;
}

module.exports = {
  FAST_RECOMMENDATIONS,
  LISTENBRAINZ_TARGET_STATUSES,
  MANUAL_RECOMMENDATIONS,
  applyAnalysis,
  createListenBrainzReviewStats,
  enrichOpenReviewsWithListenBrainz,
  isListenBrainzTarget,
};
