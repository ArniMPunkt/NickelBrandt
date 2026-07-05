'use strict';

const CATALOG_ALBUM_RE =
  /\b(best of|greatest hits|collection|anthology|gold|platinum|remaster|deluxe|anniversary|essentials|hits|original|the collection)\b/i;

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

function appendNote(notes, text) {
  const clean = String(notes || '').trim();
  return clean ? `${clean}; ${text}` : text;
}

function inputValue(row, names) {
  for (const name of names) {
    const v = row[name];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function isCatalogSuspected(row) {
  const albumType = String(row.spotifyAlbumType || row.spotify_album_type || '').toLowerCase();
  const albumName = String(row.spotifyAlbumName || row.spotify_album_name || '');
  return albumType === 'compilation' || CATALOG_ALBUM_RE.test(albumName);
}

module.exports = {
  appendNote,
  inputValue,
  isCatalogSuspected,
  norm,
  toIntYear,
  yearText,
};
