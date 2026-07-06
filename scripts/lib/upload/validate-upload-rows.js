'use strict';

const UPLOAD_READY_STATUSES = new Set([
  'auto_accepted_mb',
  'auto_accepted_mb_soft_checked',
  'auto_accepted_mb_lb_confirmed',
  'manual_confirmed_mb',
  'manual_confirmed_spotify',
  'manual_confirmed_discogs',
  'manual_confirmed_default',
  'manual_entered_year',
  // Legacy statuses still present in review-schema / older review CSVs.
  'existing_year_confirmed',
  'mb_anchor_ok',
  'manual_kept_existing',
  'manual_confirmed_deezer',
  'manual_musicbrainz_url',
]);

const BLOCKING_STATUSES = new Set([
  'review_needed',
  'review_needed_after_discogs',
  'soft_discogs_pending',
  'spotify_not_found',
  'mb_no_match',
  'mb_match_uncertain',
  'review_needed_other_source_earlier',
  'review_needed_catalog_year_suspected',
  'review_needed_discogs_earlier_than_mb',
  'review_needed_spotify_earlier',
  'review_needed_spotify_deezer_agree_against_mb',
  'manual_skipped',
  'manual_quit_pending',
  'existing_year_conflict',
]);

function cleanText(value) {
  return value == null ? '' : String(value).trim();
}

function parseUploadYear(value, currentYear = new Date().getFullYear()) {
  const text = cleanText(value);
  if (!/^\d{4}$/.test(text)) return null;
  const year = Number.parseInt(text, 10);
  return year >= 1850 && year <= currentYear + 1 ? year : null;
}

function normalizedStatus(row) {
  return cleanText(row && row.status);
}

function isTruthy(value) {
  return ['true', '1', 'yes', 'y'].includes(cleanText(value).toLowerCase());
}

function isExcludedFromPool(row) {
  return normalizedStatus(row) === 'excluded_from_pool' || isTruthy(row && row.excluded_from_pool);
}

function hasSpotifyTarget(row) {
  return isTruthy(row && row.spotify_found) && cleanText(row && row.spotify_track_id) !== '';
}

function isUploadReadyStatus(status) {
  return UPLOAD_READY_STATUSES.has(cleanText(status));
}

function blockedReason(row) {
  const status = normalizedStatus(row);
  const finalYear = parseUploadYear(row && row.final_year);
  if (finalYear == null) return 'missing_final_year';
  if (!isUploadReadyStatus(status)) {
    return BLOCKING_STATUSES.has(status) ? `blocked_status:${status}` : `status_not_upload_ready:${status || '(empty)'}`;
  }
  return '';
}

function validateUploadRows(rows) {
  const skippedExcluded = [];
  const skippedNoSpotify = [];
  const uploadCandidates = [];
  const blockedRows = [];

  rows.forEach((row, index) => {
    if (isExcludedFromPool(row)) {
      skippedExcluded.push({ row, index });
      return;
    }

    const reason = blockedReason(row);
    if (reason) {
      blockedRows.push({ row, index, reason });
      return;
    }

    if (!hasSpotifyTarget(row)) {
      skippedNoSpotify.push({ row, index });
      return;
    }

    uploadCandidates.push({
      row,
      index,
      finalYear: parseUploadYear(row.final_year),
    });
  });

  return {
    blockedRows,
    skippedExcluded,
    skippedNoSpotify,
    uploadCandidates,
  };
}

function formatBlockedExample(item) {
  const row = item.row || {};
  return `   - #${item.index + 2}: ${row.title || '-'} - ${row.artist || '-'} | status="${row.status || ''}" | final_year="${row.final_year || ''}" | ${item.reason}`;
}

function formatBlockedUploadRows(blockedRows, options = {}) {
  const limit = options.limit || 10;
  const lines = [
    `ABBRUCH: ${blockedRows.length} nicht ausgeschlossene Zeile(n) sind nicht upload-ready.`,
    'Upload-ready erfordert: upload-ready status + gueltiges final_year + nicht excluded_from_pool.',
    'Beispiele:',
    ...blockedRows.slice(0, limit).map(formatBlockedExample),
  ];
  if (blockedRows.length > limit) {
    lines.push(`   ... ${blockedRows.length - limit} weitere`);
  }
  lines.push('Bitte offene Reviews abschliessen oder Zeilen explizit excluded_from_pool setzen. Es wurde NICHTS geschrieben.');
  return lines.join('\n');
}

module.exports = {
  BLOCKING_STATUSES,
  UPLOAD_READY_STATUSES,
  blockedReason,
  formatBlockedUploadRows,
  hasSpotifyTarget,
  isExcludedFromPool,
  isUploadReadyStatus,
  parseUploadYear,
  validateUploadRows,
};
