'use strict';

const { detectRiskFlags } = require('./detect-risk-flags');

const DISCOGS_TRIGGER_FLAGS = [
  'mb_no_match',
  'mb_uncertain',
  'mb_text_match_only',
  'catalog_context',
  'remaster_or_deluxe_context',
  'compilation_context',
  'mb_year_suspicious_late',
  'existing_year_conflict',
];

function uniqueFlags(flags) {
  return Array.from(new Set(Array.isArray(flags) ? flags : []));
}

function planDiscogsLookup(input, riskFlags) {
  const flags = uniqueFlags(riskFlags || detectRiskFlags(input));
  const reasons = DISCOGS_TRIGGER_FLAGS.filter((flag) => flags.includes(flag));
  return {
    should_lookup: reasons.length > 0,
    reasons,
    risk_flags: flags,
  };
}

module.exports = { planDiscogsLookup, DISCOGS_TRIGGER_FLAGS };
