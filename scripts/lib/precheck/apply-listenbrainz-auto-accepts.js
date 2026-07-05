'use strict';

const { appendNote, toIntYear } = require('./helpers');

const LB_AUTO_ACCEPT_STATUS = 'auto_accepted_mb_lb_confirmed';
const TARGET_STATUSES = new Set([
  'review_needed',
  'review_needed_after_discogs',
  'soft_discogs_pending',
]);
const SAFE_RECOMMENDATION = 'likely_accept_existing_mb';
const BLOCKING_RECOMMENDATIONS = new Set([
  'likely_accept_existing_mb_with_context_warning',
  'useful_alternative_mb_year',
  'manual_conflicting_years',
  'manual_noisy_context',
  'manual_version_risk',
  'unusable',
]);

function cleanText(value) {
  return value == null ? '' : String(value).trim();
}

function hasAnyFlags(value) {
  const text = cleanText(value);
  return text !== '' && text !== 'none';
}

function hasDiscogsEarlierThanMb(row) {
  const text = `${row.notes || ''}; ${row.listenbrainz_warning_flags || ''}`.toLowerCase();
  return text.includes('discogs_earlier_than_mb');
}

function createLbAutoAcceptStats(rows, mode) {
  const candidates = rows.filter((row) =>
    TARGET_STATUSES.has(row.status) &&
    row.listenbrainz_recommendation === SAFE_RECOMMENDATION
  ).length;
  return {
    mode,
    candidates,
    accepted: 0,
    skipped: 0,
    skippedReasons: {},
  };
}

function skip(stats, reason) {
  stats.skipped += 1;
  stats.skippedReasons[reason] = (stats.skippedReasons[reason] || 0) + 1;
}

function safeAcceptBlockReason(row) {
  if (!TARGET_STATUSES.has(row.status)) return 'not_open_review_status';
  if (row.listenbrainz_recommendation !== SAFE_RECOMMENDATION) {
    return BLOCKING_RECOMMENDATIONS.has(row.listenbrainz_recommendation)
      ? row.listenbrainz_recommendation
      : 'not_safe_recommendation';
  }

  const mbYear = toIntYear(row.mb_year);
  const lbYear = toIntYear(row.listenbrainz_mb_year);
  if (mbYear == null) return 'missing_mb_year';
  if (lbYear == null) return 'missing_listenbrainz_mb_year';
  if (mbYear !== lbYear) return 'mb_lb_year_mismatch';
  if (hasAnyFlags(row.listenbrainz_version_flags)) return 'version_flags';
  if (hasAnyFlags(row.listenbrainz_context_flags)) return 'context_flags';
  if (hasDiscogsEarlierThanMb(row)) return 'discogs_earlier_than_mb';

  return '';
}

function applyLbConfirmedAccept(row) {
  const mbYear = String(toIntYear(row.mb_year));
  row.status = LB_AUTO_ACCEPT_STATUS;
  row.final_year = mbYear;
  row.final_source = 'musicbrainz';
  row.chosen_candidate = mbYear;
  row.review_reason = 'lb_mb_confirmed';
  row.notes = appendNote(
    row.notes,
    'Auto accepted: ListenBrainz->MusicBrainz confirmed existing MusicBrainz year.'
  );
}

function applyListenBrainzAutoAccepts(rows, options = {}) {
  const mode = options.mode || 'off';
  const stats = createLbAutoAcceptStats(rows, mode);

  if (mode === 'off') return stats;
  if (mode !== 'safe') throw new Error(`Unknown LB auto-accept mode: ${mode}`);

  for (const row of rows) {
    if (row.listenbrainz_recommendation !== SAFE_RECOMMENDATION) continue;
    const reason = safeAcceptBlockReason(row);
    if (reason) {
      skip(stats, reason);
      continue;
    }
    applyLbConfirmedAccept(row);
    stats.accepted += 1;
  }

  return stats;
}

module.exports = {
  LB_AUTO_ACCEPT_STATUS,
  SAFE_RECOMMENDATION,
  TARGET_STATUSES,
  applyLbConfirmedAccept,
  applyListenBrainzAutoAccepts,
  createLbAutoAcceptStats,
  safeAcceptBlockReason,
};
