'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decideYear } = require('../scripts/lib/decision/decide-year');
const { detectRiskFlags } = require('../scripts/lib/decision/detect-risk-flags');
const { planDiscogsLookup } = require('../scripts/lib/decision/plan-discogs-lookup');

function baseInput(overrides = {}) {
  return {
    title: 'Clear Song',
    artist: 'Clear Artist',
    isrc: 'USRC17607839',
    spotify_album_name: 'Clear Song',
    spotify_album_type: 'single',
    spotify_album_release_date: '2024-01-05',
    mb_year: 2024,
    mb_year_source: 'mb_ok',
    mb_match_method: 'isrc',
    mb_score: 0.96,
    ...overrides,
  };
}

test('clear MusicBrainz ISRC match without risk is accepted automatically', () => {
  const input = baseInput();
  const flags = detectRiskFlags(input);
  const decision = decideYear(input, flags);
  const discogsPlan = planDiscogsLookup(input, flags);

  assert.deepEqual(flags, []);
  assert.equal(discogsPlan.should_lookup, false);
  assert.equal(decision.decision_status, 'accepted_auto');
  assert.equal(decision.final_year, 2024);
  assert.equal(decision.final_source, 'musicbrainz');
});

test('compilation context with MB year near Spotify album year needs review and Discogs plan', () => {
  const input = baseInput({
    title: 'Old Hit',
    spotify_album_name: 'Best Of The 90s',
    spotify_album_type: 'compilation',
    spotify_album_release_date: '1998-03-01',
    mb_year: 1998,
  });
  const flags = detectRiskFlags(input);
  const decision = decideYear(input, flags);
  const discogsPlan = planDiscogsLookup(input, flags);

  assert.equal(decision.decision_status, 'needs_review');
  assert.equal(decision.final_year, null);
  assert.equal(discogsPlan.should_lookup, true);
  assert.ok(flags.includes('compilation_context'));
  assert.ok(flags.includes('catalog_context'));
  assert.ok(flags.includes('mb_year_suspicious_late'));
});

test('missing MusicBrainz year needs review and Discogs plan', () => {
  const input = baseInput({
    mb_year: '',
    mb_year_source: 'mb_no_match',
    mb_match_method: '',
    mb_score: '',
  });
  const flags = detectRiskFlags(input);
  const decision = decideYear(input, flags);
  const discogsPlan = planDiscogsLookup(input, flags);

  assert.ok(flags.includes('mb_no_match'));
  assert.equal(discogsPlan.should_lookup, true);
  assert.equal(decision.decision_status, 'needs_review');
  assert.equal(decision.final_year, null);
});

test('MusicBrainz text-only match needs review and Discogs plan', () => {
  const input = baseInput({
    mb_year: 1984,
    mb_match_method: 'text',
    mb_score: 0.9,
  });
  const flags = detectRiskFlags(input);
  const decision = decideYear(input, flags);
  const discogsPlan = planDiscogsLookup(input, flags);

  assert.ok(flags.includes('mb_text_match_only'));
  assert.equal(discogsPlan.should_lookup, true);
  assert.equal(decision.decision_status, 'needs_review');
  assert.equal(decision.final_year, null);
});

test('Discogs earlier than MusicBrainz needs review and does not overwrite automatically', () => {
  const input = baseInput({
    mb_year: 1995,
    spotify_album_release_date: '1995-01-01',
    discogs_year: 1988,
  });
  const flags = detectRiskFlags(input);
  const decision = decideYear(input, flags);

  assert.ok(flags.includes('discogs_earlier_than_mb'));
  assert.equal(decision.decision_status, 'needs_review');
  assert.equal(decision.final_year, null);
  assert.equal(decision.final_source, null);
  assert.equal(decision.recommendation, 'manual_review_compare_musicbrainz_discogs');
});

test('existing year much earlier than MusicBrainz needs review', () => {
  const input = baseInput({
    mb_year: 1987,
    spotify_album_release_date: '1987-01-01',
    existing_year: 1984,
  });
  const flags = detectRiskFlags(input);
  const decision = decideYear(input, flags);
  const discogsPlan = planDiscogsLookup(input, flags);

  assert.ok(flags.includes('existing_year_conflict'));
  assert.ok(flags.includes('mb_year_suspicious_late'));
  assert.equal(discogsPlan.should_lookup, true);
  assert.equal(decision.decision_status, 'needs_review');
  assert.equal(decision.final_year, null);
});

test('Deezer fields do not influence decision status or final year', () => {
  const input = baseInput();
  const withDeezer = {
    ...input,
    deezer_year: 1965,
    deezer_status: 'ok',
    deezer_track_id: '123',
    deezer_invalid_year: 1964,
  };

  const decision = decideYear(input);
  const deezerDecision = decideYear(withDeezer);

  assert.deepEqual(detectRiskFlags(withDeezer), detectRiskFlags(input));
  assert.equal(deezerDecision.decision_status, decision.decision_status);
  assert.equal(deezerDecision.final_year, decision.final_year);
  assert.equal(deezerDecision.final_source, decision.final_source);
});
