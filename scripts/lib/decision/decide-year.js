'use strict';

const {
  detectRiskFlags,
  getMusicBrainzMatchMethod,
  getMusicBrainzScore,
  getMusicBrainzStatus,
  getMusicBrainzYear,
} = require('./detect-risk-flags');
const { planDiscogsLookup } = require('./plan-discogs-lookup');

const MB_OK_STATUSES = new Set(['', 'mb_ok', 'ok', 'accepted', 'strong']);
const STRONG_MB_SCORE = 0.72;

const HARD_FLAGS = [
  'mb_no_match',
  'mb_uncertain',
  'mb_text_match_only',
  'existing_year_conflict',
  'discogs_earlier_than_mb',
  'mb_year_suspicious_late',
];

const SOFT_FLAGS = [
  'catalog_context',
  'compilation_context',
  'remaster_or_deluxe_context',
];

const REVIEW_REASON_PRIORITY = [
  'mb_no_match',
  'mb_uncertain',
  'discogs_earlier_than_mb',
  'existing_year_conflict',
  'mb_year_suspicious_late',
  'mb_text_match_only',
  'compilation_context',
  'remaster_or_deluxe_context',
  'catalog_context',
  'no_isrc',
];

function uniqueFlags(flags) {
  return Array.from(new Set(Array.isArray(flags) ? flags : []));
}

function hasFlag(flags, flag) {
  return flags.includes(flag);
}

function matchingFlags(flags, candidates) {
  return candidates.filter((flag) => flags.includes(flag));
}

function isStrongMusicBrainzMatch(input, riskFlags) {
  const mbYear = getMusicBrainzYear(input);
  if (mbYear == null) return false;
  if (
    hasFlag(riskFlags, 'no_isrc') ||
    hasFlag(riskFlags, 'mb_no_match') ||
    hasFlag(riskFlags, 'mb_uncertain') ||
    hasFlag(riskFlags, 'mb_text_match_only')
  ) {
    return false;
  }

  const status = getMusicBrainzStatus(input);
  if (!MB_OK_STATUSES.has(status)) return false;

  const method = getMusicBrainzMatchMethod(input);
  if (method && !method.includes('isrc')) return false;
  if (!method) return false;

  const score = getMusicBrainzScore(input);
  if (score != null && score < STRONG_MB_SCORE) return false;

  return true;
}

function firstReviewReason(flags, strongMbMatch) {
  for (const flag of REVIEW_REASON_PRIORITY) {
    if (flags.includes(flag)) return flag;
  }
  return strongMbMatch ? 'manual_review_required' : 'mb_match_not_strong';
}

function recommendationFor(reason, discogsPlan) {
  if (reason === 'discogs_earlier_than_mb') return 'manual_review_compare_musicbrainz_discogs';
  if (discogsPlan.should_lookup) return 'run_targeted_discogs_lookup';
  if (reason === 'mb_no_match') return 'manual_review_find_year';
  return 'manual_review';
}

function decideYear(input, riskFlags) {
  const flags = uniqueFlags(riskFlags || detectRiskFlags(input));
  const mbYear = getMusicBrainzYear(input);
  const strongMbMatch = isStrongMusicBrainzMatch(input, flags);
  const discogsPlan = planDiscogsLookup(input, flags);
  const hardFlags = matchingFlags(flags, HARD_FLAGS);
  const softFlags = matchingFlags(flags, SOFT_FLAGS);

  if (mbYear != null && strongMbMatch && hardFlags.length === 0 && softFlags.length === 0) {
    return {
      decision_status: 'accepted_auto',
      final_year: mbYear,
      final_source: 'musicbrainz',
      review_reason: null,
      recommendation: 'accept_musicbrainz_year',
      risk_flags: flags,
      debug_notes: ['musicbrainz_strong_isrc_match'],
      background_discogs_check: false,
      post_accept_check: null,
    };
  }

  if (mbYear != null && strongMbMatch && hardFlags.length === 0 && softFlags.length > 0) {
    return {
      decision_status: 'accepted_auto_soft',
      final_year: mbYear,
      final_source: 'musicbrainz',
      review_reason: null,
      recommendation: 'accept_musicbrainz_year_with_soft_context_check',
      risk_flags: flags,
      debug_notes: ['musicbrainz_strong_isrc_match', `soft_flags:${softFlags.join('+')}`],
      background_discogs_check: true,
      post_accept_check: 'discogs_soft_flags',
    };
  }

  const reviewReason = firstReviewReason(flags, strongMbMatch);
  const debugNotes = [];
  if (mbYear == null) debugNotes.push('no_valid_musicbrainz_year');
  if (!strongMbMatch) debugNotes.push('musicbrainz_match_not_strong');
  if (discogsPlan.should_lookup) debugNotes.push(`discogs_lookup_planned:${discogsPlan.reasons.join('+')}`);

  return {
    decision_status: 'needs_review',
    final_year: null,
    final_source: null,
    review_reason: reviewReason,
    recommendation: recommendationFor(reviewReason, discogsPlan),
    risk_flags: flags,
    debug_notes: debugNotes,
    background_discogs_check: false,
    post_accept_check: null,
  };
}

module.exports = { decideYear, isStrongMusicBrainzMatch, HARD_FLAGS, SOFT_FLAGS };
