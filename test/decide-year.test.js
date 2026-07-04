'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decideYear } = require('../scripts/lib/decision/decide-year');
const { detectRiskFlags } = require('../scripts/lib/decision/detect-risk-flags');
const { mapVerificationResultToDecisionInput } = require('../scripts/lib/decision/map-verification-result');
const { planDiscogsLookup } = require('../scripts/lib/decision/plan-discogs-lookup');

// Decision input shape:
// - Direct result fields from verifySongs(): spName, spArtist, isrc, mbYear,
//   mbStatus, mbMatchMethod, mbScore, discogsYear.
// - Context fields from result.input: title, artist, spotifyAlbumName,
//   spotifyAlbumType, spotifyAlbumReleaseDate, spotifyAlbumArtist,
//   inputEstimatedYear/spotifyEstimatedYear, existingYear.
// The adapter flattens those into the snake_case fields consumed by
// detectRiskFlags(), planDiscogsLookup(), and decideYear().

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

test('song title with catalog words does not create catalog context when album context is clean', () => {
  const input = baseInput({
    title: 'Best Of My Love',
    spotify_album_name: 'Studio Album',
    spotify_album_type: 'album',
  });
  const flags = detectRiskFlags(input);
  const decision = decideYear(input, flags);
  const discogsPlan = planDiscogsLookup(input, flags);

  assert.equal(flags.includes('catalog_context'), false);
  assert.equal(flags.includes('compilation_context'), false);
  assert.equal(flags.includes('remaster_or_deluxe_context'), false);
  assert.equal(discogsPlan.should_lookup, false);
  assert.equal(decision.decision_status, 'accepted_auto');
});

test('plain catalog context gets soft auto accept without forcing Discogs lookup', () => {
  const input = baseInput({
    title: 'Old Hit',
    spotify_album_name: 'Classic Hits',
    spotify_album_type: 'compilation',
    spotify_album_release_date: '2020-01-01',
    mb_year: 1984,
  });
  const flags = detectRiskFlags(input);
  const decision = decideYear(input, flags);
  const discogsPlan = planDiscogsLookup(input, flags);

  assert.ok(flags.includes('catalog_context'));
  assert.ok(flags.includes('compilation_context'));
  assert.equal(flags.includes('mb_year_suspicious_late'), false);
  assert.equal(decision.decision_status, 'accepted_auto_soft');
  assert.equal(decision.final_year, 1984);
  assert.equal(decision.final_source, 'musicbrainz');
  assert.equal(decision.background_discogs_check, true);
  assert.equal(decision.post_accept_check, 'discogs_soft_flags');
  assert.equal(discogsPlan.should_lookup, false);
});

test('remaster context with early strong MB year gets soft auto accept', () => {
  const input = baseInput({
    title: 'Old Hit',
    spotify_album_name: 'Old Hit - 2019 Remaster',
    spotify_album_type: 'album',
    spotify_album_release_date: '2019-01-01',
    mb_year: 1984,
  });
  const flags = detectRiskFlags(input);
  const decision = decideYear(input, flags);
  const discogsPlan = planDiscogsLookup(input, flags);

  assert.ok(flags.includes('catalog_context'));
  assert.ok(flags.includes('remaster_or_deluxe_context'));
  assert.equal(flags.includes('mb_year_suspicious_late'), false);
  assert.equal(decision.decision_status, 'accepted_auto_soft');
  assert.equal(decision.final_year, 1984);
  assert.equal(decision.final_source, 'musicbrainz');
  assert.equal(decision.background_discogs_check, true);
  assert.equal(discogsPlan.should_lookup, false);
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

test('unrealistic years are ignored', () => {
  const input = baseInput({
    mb_year: 9999,
    spotify_album_release_date: '9999-01-01',
  });
  const flags = detectRiskFlags(input);
  const decision = decideYear(input, flags);

  assert.ok(flags.includes('mb_no_match'));
  assert.equal(decision.decision_status, 'needs_review');
  assert.equal(decision.final_year, null);
});

test('adapter maps typical verifySongs result and result.input context', () => {
  const mapped = mapVerificationResultToDecisionInput({
    input: {
      title: 'Input Title',
      artist: 'Input Artist',
      spotifyAlbumName: 'Original Album',
      spotifyAlbumType: 'album',
      spotifyAlbumReleaseDate: '1984-05-01',
      spotifyAlbumArtist: 'Input Artist',
      inputEstimatedYear: 1984,
      existingYear: 1984,
    },
    spName: 'Spotify Match Title',
    spArtist: 'Spotify Match Artist',
    isrc: 'USRC17607839',
    mbYear: 1984,
    mbStatus: 'mb_ok',
    mbMatchMethod: 'isrc',
    mbScore: 0.95,
    discogsYear: '',
    deezerYear: 1979,
  });

  assert.deepEqual(mapped, {
    title: 'Spotify Match Title',
    artist: 'Spotify Match Artist',
    isrc: 'USRC17607839',
    spotify_album_name: 'Original Album',
    spotify_album_type: 'album',
    spotify_album_release_date: '1984-05-01',
    spotify_album_artist: 'Input Artist',
    estimated_year: 1984,
    existing_year: 1984,
    mb_year: 1984,
    mb_status: 'mb_ok',
    mb_match_method: 'isrc',
    mb_score: 0.95,
    discogs_year: '',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'deezerYear'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'deezer_year'), false);
});

test('adapter accepts snake_case review CSV-like fields', () => {
  const mapped = mapVerificationResultToDecisionInput({
    title: 'CSV Title',
    artist: 'CSV Artist',
    isrc: 'GBAYE8400011',
    spotify_album_name: 'Greatest Hits',
    spotify_album_type: 'compilation',
    spotify_album_release_date: '2010-01-01',
    spotify_album_artist: 'CSV Artist',
    estimated_year: '2010',
    existing_year: '1984',
    mb_year: '1984',
    mb_year_source: 'mb_ok',
    mb_match_method: 'isrc',
    mb_score: '0.91',
    discogs_year: '1984',
    deezer_year: '2010',
  });

  assert.equal(mapped.title, 'CSV Title');
  assert.equal(mapped.artist, 'CSV Artist');
  assert.equal(mapped.spotify_album_name, 'Greatest Hits');
  assert.equal(mapped.mb_status, 'mb_ok');
  assert.equal(mapped.discogs_year, '1984');
  assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'deezer_year'), false);
});

test('adapter returns empty strings for missing optional fields', () => {
  const mapped = mapVerificationResultToDecisionInput({
    input: {
      title: 'Sparse Title',
      artist: 'Sparse Artist',
    },
  });

  assert.equal(mapped.title, 'Sparse Title');
  assert.equal(mapped.artist, 'Sparse Artist');
  assert.equal(mapped.isrc, '');
  assert.equal(mapped.spotify_album_name, '');
  assert.equal(mapped.spotify_album_type, '');
  assert.equal(mapped.spotify_album_release_date, '');
  assert.equal(mapped.spotify_album_artist, '');
  assert.equal(mapped.estimated_year, '');
  assert.equal(mapped.existing_year, '');
  assert.equal(mapped.mb_year, '');
  assert.equal(mapped.mb_status, '');
  assert.equal(mapped.mb_match_method, '');
  assert.equal(mapped.mb_score, '');
  assert.equal(mapped.discogs_year, '');
});

test('adapter output can be passed directly to risk detection and decision', () => {
  const mapped = mapVerificationResultToDecisionInput({
    input: {
      title: 'Old Hit',
      artist: 'Original Artist',
      spotifyAlbumName: 'Old Hit - 2019 Remaster',
      spotifyAlbumType: 'album',
      spotifyAlbumReleaseDate: '2019-01-01',
      spotifyAlbumArtist: 'Original Artist',
      inputEstimatedYear: 2019,
    },
    isrc: 'USRC17607839',
    mbYear: 1984,
    mbStatus: 'mb_ok',
    mbMatchMethod: 'isrc',
    mbScore: 0.96,
  });
  const flags = detectRiskFlags(mapped);
  const decision = decideYear(mapped, flags);

  assert.ok(flags.includes('remaster_or_deluxe_context'));
  assert.equal(decision.decision_status, 'accepted_auto_soft');
  assert.equal(decision.final_year, 1984);
  assert.equal(decision.final_source, 'musicbrainz');
});
