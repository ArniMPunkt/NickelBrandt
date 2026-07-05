'use strict';

const { OPEN_STATUSES, SORT_RANK } = require('./review-schema');
const { toIntYear } = require('./helpers');

function hasFinalYear(row) {
  return toIntYear(row.final_year) != null;
}

function hasOpenHint(row) {
  const text = `${row.status || ''}; ${row.existing_status || ''}; ${row.existing_notes || ''}`.toLowerCase();
  return /review_needed|mb_no_match|mb_match_uncertain|manual_skipped|manual_quit_pending|existing_year_conflict|open_review|pending_review/.test(text);
}

function sortRank(row) {
  const rank = SORT_RANK[row.status || ''] != null ? SORT_RANK[row.status || ''] : 3;
  return hasFinalYear(row) ? rank : 100 + rank;
}

function compareRows(a, b) {
  const ar = sortRank(a);
  const br = sortRank(b);
  if (ar !== br) return br - ar;
  return `${a.artist} ${a.title}`.localeCompare(`${b.artist} ${b.title}`);
}

function isOpenReview(row) {
  if (row.status === 'excluded_from_pool') return false;
  if (OPEN_STATUSES.has(row.status)) return true;
  if (!hasFinalYear(row)) return true;
  if (!hasFinalYear(row) && hasOpenHint(row)) return true;
  return false;
}

module.exports = {
  compareRows,
  hasFinalYear,
  hasOpenHint,
  isOpenReview,
  sortRank,
};
