'use strict';

const { decideYear } = require('../decision/decide-year');
const { detectRiskFlags } = require('../decision/detect-risk-flags');
const { mapVerificationResultToDecisionInput } = require('../decision/map-verification-result');
const { planDiscogsLookup } = require('../decision/plan-discogs-lookup');
const { yearText } = require('./helpers');

function formatFlags(flags) {
  return Array.isArray(flags) && flags.length ? flags.join('+') : 'none';
}

function formatNotes(decision, discogsPlan) {
  if (decision.decision_status === 'accepted_auto') {
    return 'auto: MusicBrainz strong match';
  }
  if (decision.decision_status === 'accepted_auto_soft') {
    return [
      'soft auto candidate',
      'Discogs background check pending',
      `risk_flags: ${formatFlags(decision.risk_flags)}`,
      `post_accept_check: ${decision.post_accept_check || 'none'}`,
    ].join('; ');
  }
  return [
    `review_reason: ${decision.review_reason || 'unknown'}`,
    `risk_flags: ${formatFlags(decision.risk_flags)}`,
    `recommendation: ${decision.recommendation || 'manual_review'}`,
    discogsPlan.should_lookup ? `discogs_lookup: ${discogsPlan.reasons.join('+')}` : 'discogs_lookup: no',
  ].join('; ');
}

function statusForDecision(decision) {
  if (decision.decision_status === 'accepted_auto') return 'auto_accepted_mb';
  if (decision.decision_status === 'accepted_auto_soft') return 'soft_discogs_pending';
  return 'review_needed';
}

function finalYearForDecision(decision) {
  return decision.decision_status === 'accepted_auto' ? yearText(decision.final_year) : '';
}

function chosenCandidateForDecision(decision) {
  if (decision.decision_status === 'accepted_auto') return yearText(decision.final_year);
  if (decision.decision_status === 'accepted_auto_soft') return yearText(decision.final_year);
  return '';
}

function buildReviewRow(result = {}) {
  const input = result.input || {};
  const decisionInput = mapVerificationResultToDecisionInput(result);
  const riskFlags = detectRiskFlags(decisionInput);
  const discogsPlan = planDiscogsLookup(decisionInput, riskFlags);
  const decision = decideYear(decisionInput, riskFlags);
  const mbYear = decisionInput.mb_year || '';
  const existingYear = input.existingYear != null ? input.existingYear : input.existing_year;
  const discogsRejectedReason =
    result.discogsReason && result.discogsReason !== 'skipped_deezer_confirmed' && result.discogsReason !== 'no_result'
      ? result.discogsReason
      : input.inputDiscogsRejectedReason || '';

  return {
    title: input.title || result.title || '',
    artist: input.artist || result.artist || '',
    existing_year: yearText(existingYear),
    existing_year_source: input.existingYearSource || input.existing_year_source || '',
    existing_status: input.existingStatus || input.existing_status || '',
    existing_notes: input.existingNotes || input.existing_notes || '',
    csv_year: yearText(input.inputCsvYear != null ? input.inputCsvYear : input.spotifyEstimatedYear),
    estimated_year: yearText(input.inputEstimatedYear),
    spotify_album_name: input.spotifyAlbumName || input.spotify_album_name || '',
    spotify_album_type: input.spotifyAlbumType || input.spotify_album_type || '',
    spotify_album_release_date: input.spotifyAlbumReleaseDate || input.spotify_album_release_date || '',
    spotify_duration_ms: input.spotifyDurationMs || input.spotify_duration_ms || '',
    spotify_album_artist: input.spotifyAlbumArtist || input.spotify_album_artist || '',
    spotify_track_number: input.spotifyTrackNumber || input.spotify_track_number || '',
    spotify_disc_number: input.spotifyDiscNumber || input.spotify_disc_number || '',
    mb_year: yearText(mbYear),
    mb_year_source: result.spotifyFound ? decisionInput.mb_status || '' : 'spotify_not_found',
    mb_match_method: decisionInput.mb_match_method || '',
    mb_score: decisionInput.mb_score !== '' && decisionInput.mb_score != null ? Number(decisionInput.mb_score).toFixed(2) : '',
    deezer_year: yearText(result.deezerYear != null ? result.deezerYear : input.inputDeezerYear),
    deezer_invalid_year: yearText(result.deezerInvalidYear != null ? result.deezerInvalidYear : input.inputDeezerInvalidYear),
    deezer_status: result.deezerStatus || input.inputDeezerStatus || '',
    deezer_track_id: result.deezerTrackId || input.inputDeezerTrackId || '',
    discogs_year: yearText(result.discogsYear != null ? result.discogsYear : input.inputDiscogsYear),
    discogs_rejected_year: yearText(result.discogsRejectedYear != null ? result.discogsRejectedYear : input.inputDiscogsRejectedYear),
    discogs_rejected_reason: discogsRejectedReason,
    chosen_candidate: chosenCandidateForDecision(decision),
    status: statusForDecision(decision),
    notes: formatNotes(decision, discogsPlan),
    diff: existingYear != null && mbYear !== '' ? Math.abs(existingYear - Number(mbYear)) : '',
    spotify_track_id: result.trackId || input.spotifyTrackId || '',
    spotify_match_name: result.spName || '',
    spotify_match_artist: result.spArtist || '',
    match_method: result.matchMethod || '',
    similarity_score: result.similarityScore != null ? result.similarityScore.toFixed(2) : '',
    isrc: result.isrc || input.isrc || '',
    spotify_found: result.spotifyFound ? 'true' : 'false',
    manual_source_url: input.manualSourceUrl || input.manual_source_url || '',
    exclusion_reason: input.exclusionReason || input.exclusion_reason || '',
    final_year: finalYearForDecision(decision),
  };
}

module.exports = {
  buildReviewRow,
  chosenCandidateForDecision,
  finalYearForDecision,
  formatNotes,
  statusForDecision,
};
