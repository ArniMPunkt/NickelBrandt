/**
 * Generic, network-free helpers shared by the song-pool scripts:
 *   - .env loading (no dotenv dependency)
 *   - required-var lookup
 *   - CSV read / parse (rows + header-keyed objects) and CSV write
 *
 * Deliberately contains NO Spotify / MusicBrainz / Supabase code, so any script
 * (including the upload script, which must not touch the verify logic) can use it.
 */
'use strict';
const fs = require('fs');

/** Minimal .env loader (skips blanks + "# comments"). Does not overwrite existing env. */
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}

/** Return a required env var or exit with a clear message. */
function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(
      `Missing ${name}. Add it to scripts/.env (copy scripts/.env.example and fill it in).`
    );
    process.exit(1);
  }
  return v;
}

/** Parse CSV text into rows of string fields (handles quoted fields/commas/quotes). */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/**
 * Parse CSV with a header row into objects keyed by the LOWERCASED header names.
 * Returns { header (original), keys (lowercased), objects }.
 */
function parseCsvObjects(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) return { header: [], keys: [], objects: [] };
  const header = rows[0].map((h) => h.trim());
  const keys = header.map((h) => h.toLowerCase());
  const objects = rows.slice(1).map((r) => {
    const o = {};
    keys.forEach((k, i) => (o[k] = (r[i] ?? '').trim()));
    return o;
  });
  return { header, keys, objects };
}

/** Quote a CSV field if it contains a comma, quote, or newline. */
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Write objects to a CSV file. `headers` are the column names (also the object keys). */
function writeCsvObjects(filePath, headers, objRows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const o of objRows) {
    lines.push(headers.map((h) => csvEscape(o[h])).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

module.exports = { loadEnv, need, parseCSV, parseCsvObjects, csvEscape, writeCsvObjects };
