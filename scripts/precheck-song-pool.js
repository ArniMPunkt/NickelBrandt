/**
 * NickelBrandt - smart precheck/re-review (stage 2) for song-pool CSVs.
 *
 * One script for first review, resume, and re-review/audit:
 *   node scripts/precheck-song-pool.js <inputCsvPath> <outputCsvPath>
 *   node scripts/precheck-song-pool.js <inputCsvPath> <outputCsvPath> --no-interactive
 *   node scripts/precheck-song-pool.js <inputCsvPath> <outputCsvPath> --review-all
 *
 * Input and output must be different files. Spotify estimated_year is kept as
 * weak display context only; MusicBrainz remains the release-year anchor.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { loadEnv, parseCSV, parseCsvObjects, writeCsvObjects } = require('./lib/util');
const { verifySongs, mbYearFromManualUrl } = require('./lib/verify-songs');

const COLUMNS = [
  'title',
  'artist',
  'existing_year',
  'existing_year_source',
  'existing_status',
  'existing_notes',
  'csv_year',
  'estimated_year',
  'spotify_album_name',
  'spotify_album_type',
  'spotify_album_release_date',
  'spotify_duration_ms',
  'spotify_album_artist',
  'spotify_track_number',
  'spotify_disc_number',
  'mb_year',
  'mb_year_source',
  'mb_match_method',
  'mb_score',
  'deezer_year',
  'deezer_invalid_year',
  'deezer_status',
  'deezer_track_id',
  'discogs_year',
  'discogs_rejected_year',
  'discogs_rejected_reason',
  'chosen_candidate',
  'status',
  'notes',
  'diff',
  'spotify_track_id',
  'spotify_match_name',
  'spotify_match_artist',
  'match_method',
  'similarity_score',
  'isrc',
  'spotify_found',
  'manual_source_url',
  'exclusion_reason',
  'final_year',
];

const STRONG_EXISTING_SOURCES = new Set(['final_year', 'release_year', 'csv_year']);
const OPEN_STATUSES = new Set([
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
const MANUAL_FINAL_STATUSES = new Set([
  'manual_kept_existing',
  'manual_confirmed_mb',
  'manual_confirmed_deezer',
  'manual_confirmed_discogs',
  'manual_confirmed_spotify',
  'manual_entered_year',
  'manual_musicbrainz_url',
]);
const MANUAL_STATUSES = new Set([
  ...MANUAL_FINAL_STATUSES,
  'manual_skipped',
  'manual_quit_pending',
  'excluded_from_pool',
]);
const SORT_RANK = {
  spotify_not_found: 7,
  manual_quit_pending: 7,
  manual_skipped: 6,
  mb_no_match: 5,
  mb_match_uncertain: 4,
  review_needed_other_source_earlier: 3,
  review_needed_catalog_year_suspected: 4,
  review_needed_discogs_earlier_than_mb: 4,
  review_needed_spotify_earlier: 3,
  review_needed_spotify_deezer_agree_against_mb: 3,
  existing_year_conflict: 2,
  minor_difference: 1,
  mb_uncertain_but_year_consensus: 0,
  mb_anchor_ok: 0,
  existing_year_confirmed: 0,
  manual_kept_existing: 0,
  manual_confirmed_mb: 0,
  manual_confirmed_deezer: 0,
  manual_confirmed_discogs: 0,
  manual_confirmed_spotify: 0,
  manual_entered_year: 0,
  manual_musicbrainz_url: 0,
  excluded_from_pool: 0,
};

function parseArgs(argv) {
  const args = { inputCsv: null, outputCsv: null, interactive: true, reviewAll: false, deezerMode: 'needed' };
  for (const arg of argv) {
    if (arg === '--interactive') args.interactive = true;
    else if (arg === '--no-interactive') args.interactive = false;
    else if (arg === '--review-all') args.reviewAll = true;
    else if (arg.startsWith('--deezer=')) {
      const mode = arg.slice('--deezer='.length);
      if (!['needed', 'full', 'off'].includes(mode)) throw new Error(`Unknown Deezer mode: ${mode}`);
      args.deezerMode = mode;
    }
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!args.inputCsv) args.inputCsv = arg;
    else if (!args.outputCsv) args.outputCsv = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usageAndExit() {
  console.error(
    'Usage: node scripts/precheck-song-pool.js <inputCsvPath> <outputCsvPath> [--interactive|--no-interactive] [--review-all] [--deezer=needed|full|off]'
  );
  process.exit(1);
}

function resolveCsvPath(filePath) {
  return path.resolve(process.cwd(), filePath);
}

function assertDistinctPaths(inputCsv, outputCsv) {
  const inPath = resolveCsvPath(inputCsv);
  const outPath = resolveCsvPath(outputCsv);
  if (inPath.toLowerCase() === outPath.toLowerCase()) {
    console.error('\nABBRUCH: Input- und Output-CSV duerfen nicht identisch sein.');
    console.error(`Input:  ${inputCsv}`);
    console.error(`Output: ${outputCsv}`);
    console.error('Bitte eine neue Output-Datei nutzen, z. B. scripts/review_<name>_smart.csv.');
    process.exit(1);
  }
}

function toIntYear(v) {
  return /^\d{4}$/.test(String(v || '').trim()) ? parseInt(v, 10) : null;
}

function yearText(year) {
  return year == null ? '' : String(year);
}

function norm(v) {
  return String(v || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function rowKey(row) {
  const trackId = String(row.spotify_track_id || row.spotifyTrackId || '').trim();
  if (trackId) return `sp:${trackId}`;
  return `txt:${norm(row.title)}|${norm(row.artist)}`;
}

function appendNote(notes, text) {
  const clean = String(notes || '').trim();
  return clean ? `${clean}; ${text}` : text;
}

function clearTimer(timer) {
  if (timer) clearInterval(timer);
  return null;
}

function inputValue(row, names) {
  for (const name of names) {
    const v = row[name];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

const CATALOG_ALBUM_RE =
  /\b(best of|greatest hits|collection|anthology|gold|platinum|remaster|deluxe|anniversary|essentials|hits|original|the collection)\b/i;

function isCatalogSuspected(row) {
  const albumType = String(row.spotifyAlbumType || row.spotify_album_type || '').toLowerCase();
  const albumName = String(row.spotifyAlbumName || row.spotify_album_name || '');
  return albumType === 'compilation' || CATALOG_ALBUM_RE.test(albumName);
}

function canUseSpotifyYear(row) {
  const spotifyYear = toIntYear(row.estimated_year);
  if (spotifyYear == null) return false;
  if (isCatalogSuspected(row)) return false;
  const mbUnclear = row.mb_year_source === 'mb_no_match' || row.mb_year_source === 'mb_match_uncertain';
  if (!mbUnclear) return false;
  const deezerYear = toIntYear(row.deezer_year);
  if (deezerYear != null && deezerYear < spotifyYear) return false;
  const discogsYear = toIntYear(row.discogs_year);
  if (discogsYear != null && Math.abs(discogsYear - spotifyYear) > 1) return false;
  return true;
}

function detectExistingYear(row) {
  const candidates = [
    ['final_year', inputValue(row, ['final_year'])],
    ['release_year', inputValue(row, ['release_year'])],
    ['csv_year', inputValue(row, ['csv_year'])],
  ];
  for (const [source, raw] of candidates) {
    const year = toIntYear(raw);
    if (year != null) return { year, source };
  }
  return { year: null, source: '' };
}

function hasHeader(rows) {
  if (!rows.length) return false;
  const h = rows[0].map((x) => norm(x).replace(/\s+/g, '_'));
  return h.includes('title') && h.includes('artist');
}

function objectFromPositionalRow(row) {
  return {
    title: row[0] || '',
    artist: row[1] || '',
    estimated_year: row[2] || '',
  };
}

function loadSmartInputCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    process.exit(1);
  }
  const text = fs.readFileSync(csvPath, 'utf8');
  const rawRows = parseCSV(text);
  if (!rawRows.length) {
    console.error('CSV is empty.');
    process.exit(1);
  }

  const objects = hasHeader(rawRows)
    ? parseCsvObjects(text).objects
    : rawRows.map(objectFromPositionalRow);

  const out = [];
  for (const row of objects) {
    const title = inputValue(row, ['title', 'spotify_match_name']);
    const artist = inputValue(row, ['artist', 'spotify_match_artist']);
    if (!title || !artist) continue;

    const estimatedYear = toIntYear(inputValue(row, ['estimated_year']));
    const csvYear = toIntYear(inputValue(row, ['csv_year']));
    const spotifyEstimatedYear = estimatedYear != null ? estimatedYear : csvYear;
    const existing = detectExistingYear(row);

    out.push({
      title,
      artist,
      estimatedYear: spotifyEstimatedYear,
      spotifyEstimatedYear,
      inputEstimatedYear: estimatedYear,
      inputCsvYear: csvYear,
      existingYear: existing.year,
      existingYearSource: existing.source,
      existingStatus: inputValue(row, ['status']),
      existingNotes: inputValue(row, ['notes']),
      spotifyTrackId: inputValue(row, ['spotify_track_id', 'track_id']),
      isrc: inputValue(row, ['isrc']) || null,
      spotifyAlbumName: inputValue(row, ['spotify_album_name']),
      spotifyAlbumType: inputValue(row, ['spotify_album_type']),
      spotifyAlbumReleaseDate: inputValue(row, ['spotify_album_release_date']),
      spotifyDurationMs: inputValue(row, ['spotify_duration_ms']),
      spotifyAlbumArtist: inputValue(row, ['spotify_album_artist']),
      spotifyTrackNumber: inputValue(row, ['spotify_track_number']),
      spotifyDiscNumber: inputValue(row, ['spotify_disc_number']),
      manualSourceUrl: inputValue(row, ['manual_source_url']),
      exclusionReason: inputValue(row, ['exclusion_reason']),
      inputDeezerYear: toIntYear(inputValue(row, ['deezer_year'])),
      inputDeezerInvalidYear: toIntYear(inputValue(row, ['deezer_invalid_year'])),
      inputDeezerStatus: inputValue(row, ['deezer_status']),
      inputDeezerTrackId: inputValue(row, ['deezer_track_id']),
      inputDiscogsYear: toIntYear(inputValue(row, ['discogs_year'])),
      inputDiscogsRejectedYear: toIntYear(inputValue(row, ['discogs_rejected_year'])),
      inputDiscogsRejectedReason: inputValue(row, ['discogs_rejected_reason']),
    });
  }
  return out;
}

function hasDeezerInput(row) {
  return row.inputDeezerYear != null || row.inputDeezerInvalidYear != null || !!row.inputDeezerStatus;
}

function deezerRowKeys(row) {
  const keys = [];
  const isrc = String(row.isrc || '').trim().toUpperCase();
  const trackId = String(row.spotify_track_id || row.spotifyTrackId || '').trim();
  const title = row.title || '';
  const artist = row.artist || '';
  if (isrc) keys.push(`isrc:${isrc}`);
  if (trackId) keys.push(`sp:${trackId}`);
  keys.push(`txt:${norm(title)}|${norm(artist)}`);
  return keys;
}

function hydrateInputDeezerFromOutput(inputs, outputCsv) {
  if (!fs.existsSync(outputCsv)) return 0;
  const { objects } = parseCsvObjects(fs.readFileSync(outputCsv, 'utf8'));
  const byKey = new Map();
  for (const row of objects) {
    if (!row.deezer_year && !row.deezer_invalid_year && !row.deezer_status) continue;
    for (const key of deezerRowKeys(row)) {
      if (!byKey.has(key)) byKey.set(key, row);
    }
  }
  let hydrated = 0;
  for (const input of inputs) {
    if (hasDeezerInput(input)) continue;
    let prev = null;
    for (const key of deezerRowKeys(input)) {
      prev = byKey.get(key);
      if (prev) break;
    }
    if (!prev) continue;
    input.inputDeezerYear = toIntYear(prev.deezer_year);
    input.inputDeezerInvalidYear = toIntYear(prev.deezer_invalid_year);
    input.inputDeezerStatus = inputValue(prev, ['deezer_status']) || 'from_output';
    input.inputDeezerTrackId = inputValue(prev, ['deezer_track_id']);
    hydrated += 1;
  }
  return hydrated;
}

function isStrongExisting(row) {
  return STRONG_EXISTING_SOURCES.has(row.existing_year_source);
}

function hasStrongExistingYear(row) {
  return toIntYear(row.existing_year) != null && isStrongExisting(row);
}

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

function saveRows(outputCsv, rows) {
  writeCsvObjects(outputCsv, COLUMNS, rows.slice().sort(compareRows));
}

function buildRows(results) {
  return results.map((r) => {
    const input = r.input;
    const mbYear = r.mbYear != null ? r.mbYear : null;
    const baseStatus = r.spotifyFound ? r.consensusStatus || 'mb_no_match' : 'spotify_not_found';
    const mbAutoOk = baseStatus === 'mb_anchor_ok' || baseStatus === 'minor_difference';
    const existingYear = input.existingYear;
    const strongExisting = input.existingYearSource ? isStrongExisting({ existing_year_source: input.existingYearSource }) : false;
    const strongExistingYear = strongExisting ? existingYear : null;
    const existingCloseToMb = strongExistingYear != null && mbYear != null && Math.abs(strongExistingYear - mbYear) <= 1;
    const existingConflict = strongExistingYear != null && mbYear != null && Math.abs(strongExistingYear - mbYear) > 1;
    const spotifyYear = input.inputEstimatedYear;
    const spotifyEarlierThanMb = spotifyYear != null && mbYear != null && mbYear - spotifyYear > 1;
    const catalogSuspected = isCatalogSuspected(input);
    const discogsEarlierThanMb = r.discogsYear != null && mbYear != null && mbYear - r.discogsYear > 5;
    const spotifyAndDeezerAgreeAgainstMb =
      spotifyYear != null &&
      r.deezerYear != null &&
      mbYear != null &&
      Math.abs(spotifyYear - r.deezerYear) <= 1 &&
      mbYear - spotifyYear > 1;
    const mbUncertainButYearConsensus =
      baseStatus === 'mb_match_uncertain' &&
      mbYear != null &&
      spotifyYear != null &&
      r.deezerYear != null &&
      spotifyYear === mbYear &&
      r.deezerYear === mbYear;
    const discogsRejectedReason =
      r.discogsReason && r.discogsReason !== 'skipped_deezer_confirmed' && r.discogsReason !== 'no_result'
        ? r.discogsReason
        : input.inputDiscogsRejectedReason || '';

    let status = baseStatus;
    let finalYear = '';
    let chosenCandidate = r.chosenYear != null ? r.chosenYear : '';
    let notes = r.notes || '';

    if (discogsEarlierThanMb) {
      status = 'review_needed_discogs_earlier_than_mb';
      notes = appendNote(notes, `review: Discogs ${r.discogsYear} is ${mbYear - r.discogsYear} years earlier than MusicBrainz ${mbYear}`);
    } else if (mbUncertainButYearConsensus) {
      status = 'mb_uncertain_but_year_consensus';
      finalYear = String(mbYear);
      chosenCandidate = mbYear;
      notes = appendNote(notes, `MusicBrainz uncertain, but MB/Spotify/Deezer agree on ${mbYear}`);
    } else if (
      catalogSuspected &&
      (baseStatus === 'mb_no_match' || baseStatus === 'mb_match_uncertain' || spotifyAndDeezerAgreeAgainstMb)
    ) {
      status = 'review_needed_catalog_year_suspected';
      notes = appendNote(notes, 'spotify/deezer year likely compilation/catalog year');
    } else if (baseStatus === 'review_needed_other_source_earlier') {
      status = baseStatus;
      notes = appendNote(notes, 'review: Deezer earlier than MusicBrainz');
    } else if (existingConflict) {
      status = 'existing_year_conflict';
      notes = appendNote(notes, `existing_year ${strongExistingYear} (${input.existingYearSource}) differs from MusicBrainz ${mbYear}`);
    } else if (spotifyAndDeezerAgreeAgainstMb) {
      status = 'review_needed_spotify_deezer_agree_against_mb';
      notes = appendNote(notes, `review: Spotify estimated_year ${spotifyYear} and Deezer ${r.deezerYear} agree against MusicBrainz ${mbYear}`);
    } else if (spotifyEarlierThanMb) {
      status = 'review_needed_spotify_earlier';
      notes = appendNote(notes, `review: Spotify estimated_year ${spotifyYear} is earlier than MusicBrainz ${mbYear}`);
    } else if (mbAutoOk && r.chosenYear != null) {
      if (strongExisting && existingCloseToMb) {
        status = 'existing_year_confirmed';
        finalYear = String(strongExistingYear);
        chosenCandidate = strongExistingYear;
        notes = appendNote(notes, `existing_year confirmed within +/-1 year (${input.existingYearSource})`);
      } else {
        finalYear = String(r.chosenYear);
      }
    }

    return {
      title: input.title,
      artist: input.artist,
      existing_year: yearText(existingYear),
      existing_year_source: input.existingYearSource || '',
      existing_status: input.existingStatus || '',
      existing_notes: input.existingNotes || '',
      csv_year: yearText(input.inputCsvYear != null ? input.inputCsvYear : input.spotifyEstimatedYear),
      estimated_year: yearText(input.inputEstimatedYear),
      spotify_album_name: input.spotifyAlbumName || '',
      spotify_album_type: input.spotifyAlbumType || '',
      spotify_album_release_date: input.spotifyAlbumReleaseDate || '',
      spotify_duration_ms: input.spotifyDurationMs || '',
      spotify_album_artist: input.spotifyAlbumArtist || '',
      spotify_track_number: input.spotifyTrackNumber || '',
      spotify_disc_number: input.spotifyDiscNumber || '',
      mb_year: yearText(mbYear),
      mb_year_source: r.spotifyFound ? r.mbStatus || '' : 'spotify_not_found',
      mb_match_method: r.mbMatchMethod || '',
      mb_score: r.mbScore != null ? r.mbScore.toFixed(2) : '',
      deezer_year: yearText(r.deezerYear != null ? r.deezerYear : input.inputDeezerYear),
      deezer_invalid_year: yearText(r.deezerInvalidYear != null ? r.deezerInvalidYear : input.inputDeezerInvalidYear),
      deezer_status: r.deezerStatus || input.inputDeezerStatus || '',
      deezer_track_id: r.deezerTrackId || input.inputDeezerTrackId || '',
      discogs_year: yearText(r.discogsYear != null ? r.discogsYear : input.inputDiscogsYear),
      discogs_rejected_year: yearText(r.discogsRejectedYear != null ? r.discogsRejectedYear : input.inputDiscogsRejectedYear),
      discogs_rejected_reason: discogsRejectedReason,
      chosen_candidate: yearText(chosenCandidate),
      status,
      notes,
      diff: existingYear != null && mbYear != null ? Math.abs(existingYear - mbYear) : '',
      spotify_track_id: r.trackId || '',
      spotify_match_name: r.spName || '',
      spotify_match_artist: r.spArtist || '',
      match_method: r.matchMethod || '',
      similarity_score: r.similarityScore != null ? r.similarityScore.toFixed(2) : '',
      isrc: r.isrc || '',
      spotify_found: r.spotifyFound ? 'true' : 'false',
      manual_source_url: input.manualSourceUrl || '',
      exclusion_reason: input.exclusionReason || '',
      final_year: finalYear,
    };
  });
}

function loadExistingRows(outputCsv) {
  if (!fs.existsSync(outputCsv)) return new Map();
  const { objects } = parseCsvObjects(fs.readFileSync(outputCsv, 'utf8'));
  const existing = new Map();
  for (const row of objects) existing.set(rowKey(row), row);
  return existing;
}

function mergeResumeState(rows, outputCsv) {
  const existing = loadExistingRows(outputCsv);
  if (existing.size === 0) return { resumed: 0 };

  let resumed = 0;
  for (const row of rows) {
    const prev = existing.get(rowKey(row));
    if (!prev) continue;

    const prevStatus = String(prev.status || '');
    const keepState = hasFinalYear(prev) || MANUAL_STATUSES.has(prevStatus);
    if (!keepState) continue;

    for (const key of ['final_year', 'status', 'notes', 'chosen_candidate', 'manual_source_url', 'exclusion_reason']) {
      if (prev[key] != null && String(prev[key]).trim() !== '') row[key] = prev[key];
    }
    resumed += 1;
  }

  return { resumed };
}

function isOpenReview(row) {
  if (row.status === 'excluded_from_pool') return false;
  if (OPEN_STATUSES.has(row.status)) return true;
  if (!hasFinalYear(row)) return true;
  if (!hasFinalYear(row) && hasOpenHint(row)) return true;
  return false;
}

function sourceConfidence(row) {
  if (row.mb_year_source === 'mb_ok') return 'plausibel';
  if (row.mb_year_source === 'mb_match_uncertain') return 'unsicher';
  if (row.mb_year_source === 'mb_no_match') return 'kein Treffer';
  return row.mb_year_source || 'unklar';
}

function discogsRejectReason(row) {
  if (row.discogs_rejected_reason) return row.discogs_rejected_reason;
  const m = String(row.notes || '').match(/discogs:([^;]+)/);
  return m ? m[1].trim() : '';
}

function printReview(row, index, total) {
  const discogsReject = discogsRejectReason(row);
  const discogsLine = row.discogs_year
    ? `${row.discogs_year}${discogsReject ? ` | verworfen: ${discogsReject}` : ''}`
    : row.discogs_rejected_year
      ? `${row.discogs_rejected_year} | verworfen: ${discogsReject || 'unklar'}`
      : discogsReject
        ? `- | verworfen: ${discogsReject}`
        : '-';

  console.log('\n------------------------------------------------------------');
  console.log(`Review ${index}/${total}\n`);
  console.log('Song:');
  console.log(`${row.title} - ${row.artist}`);
  console.log(`ISRC: ${row.isrc || '-'}`);
  console.log('\nBestehende Datei:');
  console.log(`existing_year: ${row.existing_year || '-'}`);
  console.log(`existing_year_source: ${row.existing_year_source || '-'}`);
  console.log(`existing_status: ${row.existing_status || '-'}`);
  console.log(`existing_notes: ${row.existing_notes || '-'}`);
  console.log('\nSpotify:');
  console.log(`estimated_year: ${row.estimated_year || row.csv_year || '-'}`);
  console.log(`album: ${row.spotify_album_name || '-'} | type: ${row.spotify_album_type || '-'} | release: ${row.spotify_album_release_date || '-'}`);
  console.log(`duration_ms: ${row.spotify_duration_ms || '-'} | album_artist: ${row.spotify_album_artist || '-'}`);
  console.log('Hinweis: Spotify-Jahr ist nur Album-/Kataloginfo, nicht fuehrend.');
  if (row.spotify_found !== 'true') console.log('Spotify Match: NICHT gefunden (Upload ueberspringt diese Zeile)');
  console.log('\nQuellen:');
  console.log(`MusicBrainz: ${row.mb_year || '-'} | ${sourceConfidence(row)} | ${row.mb_match_method || '-'}${row.mb_score ? ` score ${row.mb_score}` : ''}`);
  console.log(`Deezer:      ${row.deezer_year || '-'}${row.deezer_invalid_year ? ` | ungueltig/verdacht: ${row.deezer_invalid_year}` : ''}${row.deezer_status ? ` | ${row.deezer_status}` : ''}`);
  console.log(`Discogs:     ${discogsLine}`);
  console.log(`Discogs rejected year: ${row.discogs_rejected_year || '-'}`);
  console.log(`Discogs rejected reason: ${row.discogs_rejected_reason || '-'}`);
  console.log('\nStatus:');
  console.log(row.status || '-');
  console.log('\nNotes:');
  console.log(row.notes || '-');
  console.log('\nWas moechtest du tun?');
  if (hasStrongExistingYear(row)) console.log(`[b] bestehendes Jahr ${row.existing_year} behalten`);
  if (row.mb_year) console.log(`[m] MusicBrainz-Jahr ${row.mb_year} uebernehmen`);
  if (row.deezer_year) console.log(`[d] Deezer-Jahr ${row.deezer_year} uebernehmen`);
  if (row.discogs_year && !discogsReject) console.log(`[g] Discogs-Jahr ${row.discogs_year} uebernehmen`);
  if (canUseSpotifyYear(row)) console.log(`[p] Spotify-Jahr ${row.estimated_year} uebernehmen`);
  console.log('[u] MusicBrainz-URL/MBID eingeben');
  console.log('[y] anderes Jahr manuell eingeben');
  console.log('[x] Song aus Pool ausschliessen');
  console.log('[s] skip / spaeter pruefen');
  console.log('[q] speichern und beenden');
}

async function askYear(rl) {
  for (;;) {
    const answer = (await rl.question('Jahr eingeben (YYYY): ')).trim();
    const year = toIntYear(answer);
    if (year != null) return year;
    console.log('Bitte ein vierstelliges Jahr eingeben, z. B. 1984.');
  }
}

async function askMusicBrainzUrl(rl) {
  const answer = (await rl.question('MusicBrainz-URL oder MBID eingeben: ')).trim();
  return mbYearFromManualUrl(answer);
}

async function askOptional(rl, prompt) {
  return (await rl.question(prompt)).trim();
}

function applyManualChoice(row, action, year, extra = {}) {
  if (action === 'b') {
    row.final_year = String(year);
    row.chosen_candidate = String(year);
    row.status = 'manual_kept_existing';
    row.notes = appendNote(row.notes, `manual: kept existing year ${year}`);
  } else if (action === 'm') {
    row.final_year = String(year);
    row.chosen_candidate = String(year);
    row.status = 'manual_confirmed_mb';
    row.notes = appendNote(row.notes, `manual: confirmed MusicBrainz year ${year}`);
  } else if (action === 'd') {
    row.final_year = String(year);
    row.chosen_candidate = String(year);
    row.status = 'manual_confirmed_deezer';
    row.notes = appendNote(row.notes, `manual: confirmed Deezer year ${year}`);
  } else if (action === 'g') {
    row.final_year = String(year);
    row.chosen_candidate = String(year);
    row.status = 'manual_confirmed_discogs';
    row.notes = appendNote(row.notes, `manual: confirmed Discogs year ${year}`);
  } else if (action === 'p') {
    row.final_year = String(year);
    row.chosen_candidate = String(year);
    row.status = 'manual_confirmed_spotify';
    row.notes = appendNote(row.notes, 'manual: confirmed Spotify album year');
  } else if (action === 'y') {
    row.final_year = String(year);
    row.chosen_candidate = String(year);
    row.status = 'manual_entered_year';
    row.notes = appendNote(row.notes, `manual: entered ${year}`);
  } else if (action === 'u') {
    row.final_year = String(year);
    row.chosen_candidate = String(year);
    row.status = 'manual_musicbrainz_url';
    row.manual_source_url = extra.sourceUrl || '';
    row.notes = appendNote(row.notes, `manual MusicBrainz URL used${extra.type ? ` (${extra.type})` : ''}`);
  } else if (action === 'x') {
    row.final_year = '';
    row.chosen_candidate = '';
    row.status = 'excluded_from_pool';
    row.exclusion_reason = extra.reason || '';
    row.notes = appendNote(row.notes, extra.reason ? `manual: excluded from pool (${extra.reason})` : 'manual: excluded from pool');
  } else if (action === 's') {
    row.final_year = '';
    row.status = 'manual_skipped';
    row.notes = appendNote(row.notes, 'manual: skipped for later review');
  } else if (action === 'q') {
    row.status = 'manual_quit_pending';
    row.notes = appendNote(row.notes, 'manual: quit pending');
  }
}

async function runInteractiveReview(rows, outputCsv, { reviewAll }) {
  const reviewRows = reviewAll ? rows : rows.filter(isOpenReview);
  if (reviewRows.length === 0) {
    console.log('\nKeine offenen Reviews. Alle unauffaelligen final_year-Werte sind gesetzt.');
    return;
  }

  console.log(`\nInteraktiver Review: ${reviewRows.length} Zeile(n). Nach jeder Entscheidung wird gespeichert.`);
  const rl = readline.createInterface({ input, output });
  try {
    for (let i = 0; i < reviewRows.length; i++) {
      const row = reviewRows[i];

      for (;;) {
        printReview(row, i + 1, reviewRows.length);
        const answer = (await rl.question('Auswahl: ')).trim().toLowerCase();
        const action = answer[0];

        if (action === 'b' && hasStrongExistingYear(row)) {
          applyManualChoice(row, 'b', row.existing_year);
        } else if (action === 'm' && row.mb_year) {
          applyManualChoice(row, 'm', row.mb_year);
        } else if (action === 'd' && row.deezer_year) {
          applyManualChoice(row, 'd', row.deezer_year);
        } else if (action === 'g' && row.discogs_year && !discogsRejectReason(row)) {
          applyManualChoice(row, 'g', row.discogs_year);
        } else if (action === 'p' && canUseSpotifyYear(row)) {
          applyManualChoice(row, 'p', row.estimated_year);
        } else if (action === 'u') {
          try {
            const mb = await askMusicBrainzUrl(rl);
            console.log(`MusicBrainz ${mb.type} ${mb.mbid}: Jahr ${mb.year}${mb.title ? ` (${mb.title})` : ''}`);
            applyManualChoice(row, 'u', mb.year, mb);
          } catch (e) {
            console.log(`MusicBrainz-URL nicht uebernommen: ${e && e.message ? e.message : e}`);
            continue;
          }
        } else if (action === 'y') {
          applyManualChoice(row, 'y', await askYear(rl));
        } else if (action === 'x') {
          const reason = await askOptional(rl, 'Ausschlussgrund optional: ');
          applyManualChoice(row, 'x', null, { reason });
        } else if (action === 's') {
          applyManualChoice(row, 's');
        } else if (action === 'q') {
          applyManualChoice(row, 'q');
          saveRows(outputCsv, rows);
          console.log(`\nGespeichert: ${outputCsv}`);
          return;
        } else {
          console.log('Ungueltige Auswahl oder Quelle ohne Jahr. Bitte erneut waehlen.');
          continue;
        }

        saveRows(outputCsv, rows);
        console.log(`Gespeichert: ${outputCsv}`);
        break;
      }
    }
  } finally {
    rl.close();
  }
}

function computeSummary(rows) {
  return {
    autoDecided: rows.filter((r) => ['mb_anchor_ok', 'minor_difference', 'mb_uncertain_but_year_consensus'].includes(r.status) && hasFinalYear(r)).length,
    existingConfirmed: rows.filter((r) => r.status === 'existing_year_confirmed').length,
    openReviews: rows.filter(isOpenReview).length,
    skipped: rows.filter((r) => r.status === 'manual_skipped').length,
    mbPlausible: rows.filter((r) => r.mb_year_source === 'mb_ok' && toIntYear(r.mb_year) != null).length,
    mbMissingOrUncertain: rows.filter((r) => r.status === 'mb_no_match' || r.status === 'mb_match_uncertain' || r.mb_year_source === 'mb_no_match' || r.mb_year_source === 'mb_match_uncertain').length,
    conflicts: rows.filter((r) => [
      'review_needed_other_source_earlier',
      'review_needed_catalog_year_suspected',
      'review_needed_discogs_earlier_than_mb',
      'review_needed_spotify_earlier',
      'review_needed_spotify_deezer_agree_against_mb',
      'existing_year_conflict',
    ].includes(r.status)).length,
  };
}

function sourceDeviation(rows, sourceKey) {
  const out = [];
  for (const row of rows) {
    const mbYear = toIntYear(row.mb_year);
    const sourceYear = toIntYear(row[sourceKey]);
    if (mbYear == null || sourceYear == null) continue;
    const diff = sourceYear - mbYear;
    if (Math.abs(diff) > 1) {
      out.push({
        title: row.title,
        artist: row.artist,
        mbYear,
        sourceYear,
        diff,
        abs: Math.abs(diff),
      });
    }
  }
  out.sort((a, b) => b.abs - a.abs);
  return out;
}

function averageAbsDiff(items) {
  if (!items.length) return '0.0';
  return (items.reduce((sum, item) => sum + item.abs, 0) / items.length).toFixed(1);
}

function topLines(items, sourceLabel) {
  if (!items.length) return ['  - keine'];
  return items.slice(0, 10).map((item, i) =>
    `  ${i + 1}. ${item.title} - ${item.artist}: MB ${item.mbYear}, ${sourceLabel} ${item.sourceYear}, diff ${item.diff > 0 ? '+' : ''}${item.diff}`
  );
}

function topNoMatchLines(rows) {
  const items = rows.filter((row) => row.status === 'mb_no_match' || row.mb_year_source === 'mb_no_match');
  if (!items.length) return ['  - keine'];
  return items.slice(0, 20).map((row, i) =>
    `  ${i + 1}. ${row.title} - ${row.artist} | ISRC ${row.isrc || '-'} | Album ${row.spotify_album_name || '-'} | Type ${row.spotify_album_type || '-'} | Dauer ${row.spotify_duration_ms || '-'}`
  );
}

function buildAnalysisReport(rows, summary, stats = {}, totalMs = 0) {
  const spotify = sourceDeviation(rows, 'estimated_year');
  const deezer = sourceDeviation(rows, 'deezer_year');
  const discogs = sourceDeviation(rows, 'discogs_year');
  const deezerLater = deezer.filter((x) => x.diff > 1).length;
  const spotifyLater = spotify.filter((x) => x.diff > 1).length;
  const spotifyDeezerEarlierThanMb = rows.filter((row) => {
    const mbYear = toIntYear(row.mb_year);
    const spotifyYear = toIntYear(row.estimated_year);
    const deezerYear = toIntYear(row.deezer_year);
    return mbYear != null && spotifyYear != null && deezerYear != null &&
      Math.abs(spotifyYear - deezerYear) <= 1 &&
      mbYear - spotifyYear > 1;
  }).length;
  const spotifyDeezerLaterThanMb = rows.filter((row) => {
    const mbYear = toIntYear(row.mb_year);
    const spotifyYear = toIntYear(row.estimated_year);
    const deezerYear = toIntYear(row.deezer_year);
    return mbYear != null && spotifyYear != null && deezerYear != null &&
      Math.abs(spotifyYear - deezerYear) <= 1 &&
      spotifyYear - mbYear > 1;
  }).length;
  const discogsRejected = rows.filter((row) => row.discogs_rejected_year || row.discogs_rejected_reason).length;
  const mbIsrcHits = rows.filter((row) => row.mb_year_source === 'mb_ok' && row.mb_match_method === 'isrc').length;
  const mbTextHits = rows.filter((row) => row.mb_year_source === 'mb_ok' && row.mb_match_method === 'text').length;
  const mbNoMatch = rows.filter((row) => row.status === 'mb_no_match' || row.mb_year_source === 'mb_no_match').length;
  const mbUncertain = rows.filter((row) => row.status === 'mb_match_uncertain' || row.mb_year_source === 'mb_match_uncertain').length;
  const discogsEarlierWarnings = rows.filter((row) => row.status === 'review_needed_discogs_earlier_than_mb').length;
  const catalogSuspected = rows.filter(isCatalogSuspected).length;
  const deezerInvalid = rows.filter((row) => row.deezer_invalid_year).length;
  const excluded = rows.filter((row) => row.status === 'excluded_from_pool').length;
  const dzStats = stats.deezer || {};
  const timings = stats.timings || {};
  const deezerMs = timings.deezerMs || 0;
  const avgDeezerCallMs = dzStats.calls ? (dzStats.callMs / dzStats.calls).toFixed(0) : '0';
  const deezerShare = totalMs ? ((deezerMs / totalMs) * 100).toFixed(1) : '0.0';

  return [
    'Analysebericht',
    '==============',
    `Gesamtzahl Songs: ${rows.length}`,
    `Automatisch entschieden: ${summary.autoDecided}`,
    `Bestehende starke Jahre bestaetigt: ${summary.existingConfirmed}`,
    `Offene Reviews: ${summary.openReviews}`,
    `MusicBrainz plausibel: ${summary.mbPlausible}`,
    `MusicBrainz fehlend/unsicher: ${summary.mbMissingOrUncertain}`,
    `MB-ISRC-Treffer: ${mbIsrcHits}`,
    `MB-Fallback-Texttreffer: ${mbTextHits}`,
    `Weiterhin mb_no_match: ${mbNoMatch}`,
    `mb_match_uncertain: ${mbUncertain}`,
    `MB-Falschmatch-Warnungen durch Discogs-frueher: ${discogsEarlierWarnings}`,
    `Compilation-/Katalogverdacht-Faelle: ${catalogSuspected}`,
    `Deezer ungueltig/verdaechtig: ${deezerInvalid}`,
    `Ausgeschlossen: ${excluded}`,
    'Hinweis: upload-song-pool.js muss excluded_from_pool spaeter ueberspringen, bevor diese Zeilen hochgeladen werden.',
    '',
    'Deezer-Laufzeit',
    `  Modus: ${dzStats.mode || 'needed'}`,
    `  Calls ausgefuehrt: ${dzStats.calls || 0}`,
    `  Tracks abgefragt: ${dzStats.queriedTracks || 0}`,
    `  Input-Wiederverwendung: ${dzStats.inputHits || 0}`,
    `  Cache-Hits: ${dzStats.cacheHits || 0}`,
    `  Skips: ${dzStats.skips || 0}`,
    `  Timeouts: ${dzStats.timeouts || 0}`,
    `  Fehler: ${dzStats.errors || 0}`,
    `  Laufzeit Deezer-Pass: ${(deezerMs / 1000).toFixed(1)}s`,
    `  Ø Zeit pro Deezer-Call: ${avgDeezerCallMs}ms`,
    `  Anteil an Gesamtzeit: ${deezerShare}%`,
    '',
    `Spotify estimated_year abweichend von MB: ${spotify.length}`,
    `  Durchschnittliche Abweichung: ${averageAbsDiff(spotify)} Jahre`,
    `  Spotify estimated_year spaeter als MB: ${spotifyLater}`,
    ...topLines(spotify, 'Spotify'),
    '',
    `Deezer abweichend von MB: ${deezer.length}`,
    `  Durchschnittliche Abweichung: ${averageAbsDiff(deezer)} Jahre`,
    `  Deezer spaeter als MB: ${deezerLater}`,
    ...topLines(deezer, 'Deezer'),
    '',
    `Discogs abweichend von MB: ${discogs.length}`,
    `  Verworfene Discogs-Treffer: ${discogsRejected}`,
    `  Durchschnittliche Abweichung: ${averageAbsDiff(discogs)} Jahre`,
    ...topLines(discogs, 'Discogs'),
    '',
    `Spotify/Deezer gemeinsam frueher als MB: ${spotifyDeezerEarlierThanMb}`,
    `Spotify/Deezer gemeinsam spaeter als MB: ${spotifyDeezerLaterThanMb}`,
    '',
    'Top 20 mb_no_match',
    ...topNoMatchLines(rows),
    '',
  ].join('\n');
}

function writeAnalysisReport(outputCsv, rows, summary, stats, totalMs) {
  const reportPath = `${outputCsv}.report.txt`;
  const report = buildAnalysisReport(rows, summary, stats, totalMs);
  fs.writeFileSync(reportPath, report, 'utf8');
  return { reportPath, report };
}

function printSummary({ rows, results, stats, inputs, outputCsv, tScript }) {
  const byMethod = {};
  for (const r of results) {
    const mm = r.matchMethod || (r.spotifyFound ? 'unknown' : 'none');
    byMethod[mm] = (byMethod[mm] || 0) + 1;
  }
  const m = (k) => byMethod[k] || 0;
  const fastPath = results.filter((r) => r.matchMethod === 'playlist_import').length;
  const fullChain = inputs.length - fastPath;
  const summary = computeSummary(rows);
  const totalMs = Date.now() - tScript;
  const { reportPath, report } = writeAnalysisReport(outputCsv, rows, summary, stats, totalMs);
  const t = stats.timings || {};
  const s1 = (ms) => ((ms || 0) / 1000).toFixed(1);
  const totalS = (totalMs / 1000).toFixed(1);
  const line = '-'.repeat(64);

  console.log(`\n${line}\nPRE-CHECK ZUSAMMENFASSUNG\n${line}`);
  console.log(`Eingabe-Songs:  ${inputs.length}   (Fast-Path ${fastPath} | volle Kette ${fullChain})`);
  console.log(
    `Quelle je Treffer:  Credits ${m('creditsfm_isrc')} | Deezer ${m('deezer_isrc')} | ` +
      `Spotify strict ${m('strict')} | loose ${m('fallback_loose') + m('fallback_first_artist')}`
  );
  console.log(`Automatisch entschieden:        ${summary.autoDecided}`);
  console.log(`Bestehende Jahre bestaetigt:    ${summary.existingConfirmed}`);
  console.log(`Offene Reviews:                 ${summary.openReviews}`);
  console.log(`Skipped:                        ${summary.skipped}`);
  console.log(`MusicBrainz plausibel:          ${summary.mbPlausible}`);
  console.log(`MusicBrainz fehlend/unsicher:    ${summary.mbMissingOrUncertain}`);
  console.log(`Konflikte:                      ${summary.conflicts}`);
  console.log(`Rate-Limit-Retries: ${stats.retried} | endgueltig fehlgeschlagen: ${stats.failed.length}`);
  console.log(line);
  console.log(`Laufzeit gesamt: ${totalS}s`);
  console.log(`   Resolver (Spotify/Credits/Deezer-ISRC):   ${s1(t.resolveMs)}s`);
  console.log(`   Jahres-Paesse MB + Deezer:               MB ${s1(t.mbMs)}s, Deezer ${s1(t.deezerMs)}s`);
  if (stats.deezer) {
    console.log(
      `   Deezer-Modus ${stats.deezer.mode}: Calls ${stats.deezer.calls}, Cache ${stats.deezer.cacheHits}, ` +
        `Input ${stats.deezer.inputHits}, Skips ${stats.deezer.skips}, Fehler ${stats.deezer.errors}, Timeouts ${stats.deezer.timeouts}`
    );
  }
  console.log(`   Discogs (nur bei Bedarf):                 ${s1(t.discogsMs)}s (${t.discogsCalls || 0} Calls)`);
  console.log(`Review-CSV geschrieben: ${outputCsv}`);
  console.log(`Analysebericht geschrieben: ${reportPath}`);
  console.log(line);
  console.log(report);
}

async function main() {
  const tScript = Date.now();
  loadEnv(path.join(__dirname, '.env'));

  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    usageAndExit();
  }
  if (!args.inputCsv || !args.outputCsv) usageAndExit();
  assertDistinctPaths(args.inputCsv, args.outputCsv);

  if (args.interactive && !process.stdin.isTTY) {
    console.log('Kein interaktives Terminal erkannt - laufe als --no-interactive.');
    args.interactive = false;
  }

  const inputs = loadSmartInputCsv(args.inputCsv);
  const hydratedDeezer = hydrateInputDeezerFromOutput(inputs, args.outputCsv);
  console.log(`\nLoaded ${inputs.length} song row(s) from ${args.inputCsv}`);
  console.log(
    `Modus: ${args.interactive ? 'interaktiv (Default)' : 'nicht-interaktiv'}${args.reviewAll ? ' + review-all' : ''}, ` +
      `Deezer=${args.deezerMode}${hydratedDeezer ? `, Deezer aus Output uebernommen: ${hydratedDeezer}` : ''}\n`
  );
  console.log('Phase 1/3: CSV/Spotify-Daten vorbereiten');

  let verifyOut;
  let phaseTimer = null;
  let phaseStartedAt = 0;
  try {
    verifyOut = await verifySongs(inputs, {
      onPhase: (event, info) => {
        if (event === 'credits-start') console.log(`Credits.fm: ISRCs fuer ${info.total} Song(s) aufloesen...`);
        else if (event === 'credits-progress') console.log(`  Credits.fm Runde ${info.round}: ${info.resolved}/${info.total}`);
        else if (event === 'credits-done') console.log(`Credits.fm fertig: ${info.resolved}/${info.total}. Spotify-Aufloesung startet.\n`);
        else if (event === 'years-start') {
          console.log('\nPhase 2/3: MusicBrainz/Deezer/Discogs abfragen');
          console.log(`Frage MusicBrainz ab; Deezer-Modus: ${info.deezerMode || args.deezerMode}.`);
          phaseStartedAt = Date.now();
          phaseTimer = clearTimer(phaseTimer);
          phaseTimer = setInterval(() => {
            const seconds = Math.round((Date.now() - phaseStartedAt) / 1000);
            console.log(`  Noch in Phase 2: MusicBrainz/Deezer laufen seit ${seconds}s ...`);
          }, 15000);
        } else if (event === 'years-done') {
          phaseTimer = clearTimer(phaseTimer);
          const dz = info.deezerStats || {};
          console.log(
            `MusicBrainz/Deezer fertig: MB ${(info.mbMs / 1000).toFixed(1)}s, ` +
              `Deezer ${(info.deezerMs / 1000).toFixed(1)}s (${dz.calls || 0} Calls, ${dz.cacheHits || 0} Cache, ${dz.skips || 0} Skips).`
          );
        } else if (event === 'discogs-start') {
          console.log(`Discogs: ${info.total} Call(s), ${info.skipped} uebersprungen.`);
        } else if (event === 'discogs-done') {
          console.log(`Discogs fertig: ${(info.discogsMs / 1000).toFixed(1)}s.`);
        }
      },
      onAnalyzeStart: (i, total, row) => {
        process.stdout.write(`[${i}/${total}] Analysiere: ${row.title} - ${row.artist} ... `);
      },
      onSpotify: (_i, _total, _row, r) => {
        const method = r.matchMethod || 'none';
        const score = r.similarityScore != null ? ` ~${r.similarityScore.toFixed(2)}` : '';
        const status = r.spotifyFound
          ? `ok [${method}${score}]`
          : r.failed
            ? 'fehlgeschlagen'
            : 'not found';
        console.log(status);
      },
      deezerMode: args.deezerMode,
      reviewAll: args.reviewAll,
    });
  } catch (e) {
    phaseTimer = clearTimer(phaseTimer);
    if (e && e.penalty) {
      console.error(`\n${e.message}`);
      console.error('Es wurde KEINE Review-CSV geschrieben. Pruefe mit "node scripts/check-spotify-token.js".');
      process.exit(1);
    }
    throw e;
  }
  phaseTimer = clearTimer(phaseTimer);

  const { results, stats } = verifyOut;
  console.log('\nJahres-Konsens (MusicBrainz-Anker) gebildet. Baue Smart-Review-CSV...');

  const rows = buildRows(results);
  const { resumed } = mergeResumeState(rows, args.outputCsv);
  if (resumed > 0) console.log(`Resume: ${resumed} vorhandene Entscheidung(en)/Markierung(en) aus Output uebernommen.`);

  saveRows(args.outputCsv, rows);
  console.log(`Review-CSV geschrieben: ${args.outputCsv}`);

  const preReviewSummary = computeSummary(rows);
  console.log(
    `Nach Analyse: automatisch=${preReviewSummary.autoDecided}, existing_confirmed=${preReviewSummary.existingConfirmed}, ` +
      `offen=${preReviewSummary.openReviews}, skipped=${preReviewSummary.skipped}, ` +
      `mb_fehlend_unsicher=${preReviewSummary.mbMissingOrUncertain}, konflikte=${preReviewSummary.conflicts}`
  );

  if (args.interactive) {
    console.log('\nPhase 3/3: Interaktive Reviews');
    await runInteractiveReview(rows, args.outputCsv, { reviewAll: args.reviewAll });
  } else {
    console.log('Interaktiver Review uebersprungen (--no-interactive).');
  }

  printSummary({ rows, results, stats, inputs, outputCsv: args.outputCsv, tScript });
  const pending = rows.filter(isOpenReview).length;
  if (pending > 0) {
    console.log(`Naechster Schritt: ${pending} offene Review-Zeile(n) spaeter weiter bearbeiten oder final_year manuell fuellen.`);
  } else {
    console.log('Naechster Schritt: upload-song-pool.js kann mit dieser Review-CSV arbeiten.');
  }
}

main().catch((e) => {
  console.error('\nFatal error:', e && e.message ? e.message : e);
  process.exit(1);
});
