'use strict';

const { appendNote, toIntYear } = require('./helpers');

function yearOrThrow(value, label) {
  const year = toIntYear(value);
  if (year == null) throw new Error(`Missing or invalid ${label}.`);
  return String(year);
}

function clearBlockingFields(row) {
  row.final_year = '';
  if (Object.prototype.hasOwnProperty.call(row, 'final_source')) row.final_source = '';
  if (Object.prototype.hasOwnProperty.call(row, 'review_reason')) row.review_reason = '';
}

function applyAccept(row, { year, status, source, candidate, note, reason }) {
  row.final_year = year;
  row.final_source = source;
  row.chosen_candidate = candidate || year;
  row.status = status;
  row.review_reason = reason || '';
  row.notes = appendNote(row.notes, note);
}

function applyManualChoice(inputRow, choice = {}) {
  const row = { ...(inputRow || {}) };
  const type = choice.type || 'skip';

  if (type === 'accept_mb') {
    const year = yearOrThrow(row.mb_year, 'mb_year');
    applyAccept(row, {
      year,
      status: 'manual_confirmed_mb',
      source: 'musicbrainz',
      note: choice.note || `manual: confirmed MusicBrainz year ${year}`,
      reason: choice.reason || 'manual_confirmed_mb',
    });
  } else if (type === 'accept_listenbrainz_mb') {
    const year = yearOrThrow(row.listenbrainz_mb_year, 'listenbrainz_mb_year');
    applyAccept(row, {
      year,
      status: 'manual_confirmed_mb',
      source: 'listenbrainz_musicbrainz',
      note: choice.note || 'Manual accept: LB->MB alternative year accepted.',
      reason: choice.reason || 'manual_confirmed_listenbrainz_musicbrainz',
    });
  } else if (type === 'accept_discogs') {
    const year = yearOrThrow(row.discogs_year, 'discogs_year');
    applyAccept(row, {
      year,
      status: 'manual_confirmed_discogs',
      source: 'discogs',
      note: choice.note || `manual: confirmed Discogs year ${year}`,
      reason: choice.reason || 'manual_confirmed_discogs',
    });
  } else if (type === 'accept_spotify') {
    const year = yearOrThrow(
      choice.year || row.estimated_year || row.spotify_year || row.csv_year,
      'Spotify fallback year'
    );
    applyAccept(row, {
      year,
      status: 'manual_confirmed_spotify',
      source: 'spotify',
      note: choice.note || `manual: confirmed Spotify fallback year ${year}`,
      reason: choice.reason || 'manual_confirmed_spotify',
    });
  } else if (type === 'accept_default') {
    const year = yearOrThrow(choice.year, 'default year');
    applyAccept(row, {
      year,
      status: choice.status || 'manual_confirmed_default',
      source: choice.source || 'manual',
      candidate: choice.candidate || year,
      note: choice.note || `manual: confirmed default year ${year}`,
      reason: choice.reason || 'manual_confirmed_default',
    });
  } else if (type === 'manual_year') {
    const year = yearOrThrow(choice.year, 'manual year');
    applyAccept(row, {
      year,
      status: 'manual_entered_year',
      source: choice.source || 'manual',
      note: choice.note || `manual: entered ${year}`,
      reason: choice.reason || 'manual_entered_year',
    });
  } else if (type === 'exclude') {
    clearBlockingFields(row);
    row.chosen_candidate = '';
    row.status = 'excluded_from_pool';
    row.exclusion_reason = choice.reason || row.exclusion_reason || '';
    row.notes = appendNote(
      row.notes,
      row.exclusion_reason
        ? `manual: excluded from pool (${row.exclusion_reason})`
        : 'manual: excluded from pool'
    );
  } else if (type === 'quit') {
    clearBlockingFields(row);
    row.status = 'manual_quit_pending';
    row.notes = appendNote(row.notes, 'manual: quit pending');
  } else {
    clearBlockingFields(row);
    row.status = 'manual_skipped';
    row.notes = appendNote(row.notes, choice.note || 'manual: skipped for later review');
  }

  return row;
}

module.exports = {
  applyManualChoice,
};
