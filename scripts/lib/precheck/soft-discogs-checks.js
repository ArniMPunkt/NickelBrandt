'use strict';

const { getDiscogsCandidate } = require('../verify-songs');
const { appendNote, toIntYear, yearText } = require('./helpers');

const SOFT_PENDING_STATUS = 'soft_discogs_pending';
const SOFT_CHECKED_STATUS = 'auto_accepted_mb_soft_checked';
const REVIEW_AFTER_DISCOGS_STATUS = 'review_needed_after_discogs';

function isRateLimitError(error) {
  const message = String((error && error.message) || error || '').toLowerCase();
  return !!(error && (error.rateLimited || error.penalty || error.status === 429)) ||
    message.includes('429') ||
    message.includes('rate-limit') ||
    message.includes('rate limit');
}

function isTimeoutError(error) {
  const message = String((error && error.message) || error || '').toLowerCase();
  return !!(error && error.name === 'AbortError') || message.includes('timeout') || message.includes('timed out');
}

function classifyCandidateError(candidate) {
  const reason = String((candidate && candidate.reason) || '').toLowerCase();
  if (reason === 'rate_limited' || reason === 'rate_limit') return 'rate_limited';
  if (reason === 'timeout') return 'timeout';
  if (reason === 'error') return 'error';
  return '';
}

function createSoftDiscogsStats(rows, mode) {
  const softPendingBefore = rows.filter((row) => row.status === SOFT_PENDING_STATUS).length;
  return {
    mode,
    softPendingBefore,
    planned: softPendingBefore,
    checked: 0,
    calls: 0,
    cacheHits: 0,
    errors: 0,
    rateLimited: 0,
    timeouts: 0,
    skippedNonSoft: rows.length - softPendingBefore,
    autoAcceptedSoftChecked: 0,
    reviewNeededAfterDiscogs: 0,
    stillPending: softPendingBefore,
    aborted: false,
  };
}

function applyNoEarlierConflict(row, chosenYear, candidate) {
  if (candidate && candidate.year != null) row.discogs_year = yearText(candidate.year);
  if (candidate && candidate.rejectedYear != null) row.discogs_rejected_year = yearText(candidate.rejectedYear);
  if (candidate && candidate.reason) row.discogs_rejected_reason = candidate.reason;
  row.status = SOFT_CHECKED_STATUS;
  row.final_year = String(chosenYear);
  row.chosen_candidate = String(chosenYear);
  if (Object.prototype.hasOwnProperty.call(row, 'final_source')) row.final_source = 'musicbrainz';
  row.notes = appendNote(row.notes, 'soft Discogs check: no earlier conflict');
}

function applyEarlierConflict(row, chosenYear, candidate) {
  row.status = REVIEW_AFTER_DISCOGS_STATUS;
  row.final_year = '';
  row.discogs_year = yearText(candidate.year);
  row.chosen_candidate = String(chosenYear);
  row.notes = appendNote(row.notes, 'Discogs earlier than MusicBrainz; manual review required');
}

function keepPending(row, reason) {
  row.status = SOFT_PENDING_STATUS;
  row.final_year = '';
  row.notes = appendNote(row.notes, `soft Discogs check pending: ${reason}`);
}

async function runSoftDiscogsChecks(rows, options = {}) {
  const mode = options.mode || 'needed';
  const lookupCandidate = options.lookupCandidate || getDiscogsCandidate;
  const stats = createSoftDiscogsStats(rows, mode);
  if (mode === 'off') return stats;

  const targets = rows.filter((row) => row.status === SOFT_PENDING_STATUS);
  for (const row of targets) {
    const chosenYear = toIntYear(row.chosen_candidate);
    if (chosenYear == null) {
      stats.errors += 1;
      keepPending(row, 'missing chosen_candidate');
      continue;
    }

    let candidate;
    try {
      stats.calls += 1;
      candidate = await lookupCandidate(row.title, row.artist, row);
      if (candidate && (candidate.cacheHit || candidate.fromCache)) stats.cacheHits += 1;
    } catch (error) {
      stats.errors += 1;
      if (isTimeoutError(error)) stats.timeouts += 1;
      if (isRateLimitError(error)) {
        stats.rateLimited += 1;
        stats.aborted = true;
        keepPending(row, 'rate limited');
        break;
      }
      keepPending(row, isTimeoutError(error) ? 'timeout' : 'error');
      continue;
    }

    const candidateError = classifyCandidateError(candidate);
    if (candidateError) {
      stats.errors += 1;
      if (candidateError === 'timeout') stats.timeouts += 1;
      if (candidateError === 'rate_limited') {
        stats.rateLimited += 1;
        stats.aborted = true;
      }
      keepPending(row, candidateError);
      if (candidateError === 'rate_limited') break;
      continue;
    }

    stats.checked += 1;
    const discogsYear = toIntYear(candidate && candidate.year);
    if (discogsYear != null && chosenYear - discogsYear > 1) {
      applyEarlierConflict(row, chosenYear, { ...candidate, year: discogsYear });
      stats.reviewNeededAfterDiscogs += 1;
    } else {
      applyNoEarlierConflict(row, chosenYear, candidate);
      stats.autoAcceptedSoftChecked += 1;
    }
  }

  stats.stillPending = rows.filter((row) => row.status === SOFT_PENDING_STATUS).length;
  return stats;
}

module.exports = {
  REVIEW_AFTER_DISCOGS_STATUS,
  SOFT_CHECKED_STATUS,
  SOFT_PENDING_STATUS,
  createSoftDiscogsStats,
  runSoftDiscogsChecks,
};
