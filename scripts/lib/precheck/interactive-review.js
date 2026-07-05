'use strict';

const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { applyManualChoice } = require('./apply-manual-choice');
const { toIntYear } = require('./helpers');

const INTERACTIVE_REVIEW_STATUSES = new Set([
  'review_needed',
  'review_needed_after_discogs',
  'soft_discogs_pending',
]);
const DEFAULT_MB_CONTEXT_NOTE =
  'Manual accept: MB year accepted despite LB->MB context warning.';
const DEFAULT_LB_ALTERNATIVE_NOTE =
  'Manual accept: LB->MB alternative year accepted.';
const BLOCKING_DEFAULT_VERSION_FLAGS = new Set([
  're_recorded',
  'neuaufnahme',
  'live',
  'remix',
]);

function cleanText(value) {
  return value == null ? '' : String(value).trim();
}

function notePart(row, label) {
  const match = String((row && row.notes) || '').match(new RegExp(`${label}: ([^;]+)`));
  return match ? match[1].trim() : '';
}

function splitFlags(value) {
  return String(value || '')
    .split(/[+,]/)
    .map((flag) => flag.trim())
    .filter(Boolean)
    .filter((flag) => flag !== 'none');
}

function formatFlags(value) {
  const flags = splitFlags(value);
  return flags.length ? flags.join(', ') : '-';
}

function isInteractiveReviewTarget(row) {
  return INTERACTIVE_REVIEW_STATUSES.has(row && row.status);
}

function reviewQueue(rows) {
  return rows.filter(isInteractiveReviewTarget);
}

function hasBlockingVersionFlag(row) {
  return splitFlags(row.listenbrainz_version_flags).some((flag) =>
    BLOCKING_DEFAULT_VERSION_FLAGS.has(flag)
  );
}

function hasDiscogsEarlierThanMb(row) {
  return `${row.notes || ''}; ${row.listenbrainz_warning_flags || ''}`
    .toLowerCase()
    .includes('discogs_earlier_than_mb');
}

function canDefaultAcceptMbContextWarning(row) {
  return (
    row.listenbrainz_recommendation === 'likely_accept_existing_mb_with_context_warning' &&
    toIntYear(row.mb_year) != null &&
    !hasBlockingVersionFlag(row) &&
    !hasDiscogsEarlierThanMb(row)
  );
}

function canDefaultAcceptListenBrainzAlternative(row) {
  return (
    row.listenbrainz_recommendation === 'useful_alternative_mb_year' &&
    toIntYear(row.listenbrainz_mb_year) != null
  );
}

function defaultChoiceForRow(row) {
  if (canDefaultAcceptMbContextWarning(row)) {
    return {
      type: 'accept_mb',
      note: DEFAULT_MB_CONTEXT_NOTE,
      reason: 'lb_mb_context_warning_confirmed',
    };
  }
  if (canDefaultAcceptListenBrainzAlternative(row)) {
    return {
      type: 'accept_listenbrainz_mb',
      note: DEFAULT_LB_ALTERNATIVE_NOTE,
      reason: 'lb_mb_alternative_confirmed',
    };
  }
  return { type: 'skip' };
}

function choiceForKey(row, key) {
  const normalized = cleanText(key).toLowerCase();
  if (normalized === '') return defaultChoiceForRow(row);
  if (normalized === 'm' && toIntYear(row.mb_year) != null) return { type: 'accept_mb' };
  if (normalized === 'l' && toIntYear(row.listenbrainz_mb_year) != null) {
    return { type: 'accept_listenbrainz_mb' };
  }
  if (normalized === 'd' && toIntYear(row.discogs_year) != null) return { type: 'accept_discogs' };
  if (normalized === 's') return { type: 'skip' };
  if (normalized === 'q') return { type: 'quit' };
  return null;
}

function parseManualYear(value, currentYear = new Date().getFullYear()) {
  const text = cleanText(value);
  if (!/^\d{4}$/.test(text)) return null;
  const year = Number.parseInt(text, 10);
  const maxYear = currentYear + 1;
  return year >= 1900 && year <= maxYear ? year : null;
}

function recommendationLines(row) {
  if (row.listenbrainz_recommendation === 'likely_accept_existing_mb_with_context_warning') {
    return [
      'Empfehlung:',
      '  Kein sicherer Auto-Fall wegen Kontextwarnung.',
    ];
  }
  if (row.listenbrainz_recommendation === 'useful_alternative_mb_year') {
    return [
      'Empfehlung:',
      `  LB->MB schlaegt ${row.listenbrainz_mb_year || '-'} vor.`,
      `  Spotify: ${row.estimated_year || row.csv_year || '-'}`,
      `  Discogs: ${row.discogs_year || '-'}`,
      `  bisheriges MB: ${row.mb_year || '-'}`,
    ];
  }
  if (row.listenbrainz_recommendation) {
    return [
      'Empfehlung:',
      `  ${row.listenbrainz_recommendation}`,
    ];
  }
  return [
    'Empfehlung:',
    '  Keine LB->MB-Empfehlung vorhanden.',
  ];
}

function enterHint(row) {
  if (canDefaultAcceptMbContextWarning(row)) {
    return `ENTER = MusicBrainz-Jahr ${row.mb_year} trotz sichtbarer Kontextwarnung uebernehmen`;
  }
  if (canDefaultAcceptListenBrainzAlternative(row)) {
    return `ENTER = LB->MB Vorschlag ${row.listenbrainz_mb_year} uebernehmen`;
  }
  return 'ENTER = skip';
}

function helpLines(row) {
  const lines = [
    enterHint(row),
    toIntYear(row.mb_year) != null ? `m = MusicBrainz-Jahr ${row.mb_year} uebernehmen` : '',
    toIntYear(row.listenbrainz_mb_year) != null ? `l = LB->MB-Jahr ${row.listenbrainz_mb_year} uebernehmen` : '',
    toIntYear(row.discogs_year) != null ? `d = Discogs-Jahr ${row.discogs_year} uebernehmen` : '',
    's = skip / spaeter pruefen',
    'x = aus Pool ausschliessen',
    'y = manuelles Jahr eingeben',
    'q = speichern und beenden',
    '? = Hilfe anzeigen',
  ].filter(Boolean);
  return lines;
}

function formatReview(row, index, total) {
  const reason = notePart(row, 'review_reason') || row.review_reason || row.status || '-';
  const riskFlags = notePart(row, 'risk_flags') || '';
  return [
    '',
    '------------------------------------------------------------',
    `[${index}/${total}] ${row.title || '-'} - ${row.artist || '-'}`,
    '',
    `Status: ${row.status || '-'}`,
    `Grund: ${reason}`,
    `Risk Flags: ${formatFlags(riskFlags)}`,
    '',
    'Jahre:',
    `  Spotify estimated: ${row.estimated_year || row.csv_year || '-'}`,
    `  MusicBrainz:       ${row.mb_year || '-'}`,
    `  Discogs:           ${row.discogs_year || '-'}`,
    `  LB->MB:            ${row.listenbrainz_mb_year || '-'}`,
    '',
    'LB->MB:',
    `  Recommendation: ${row.listenbrainz_recommendation || '-'}`,
    `  Year signal: ${row.listenbrainz_year_signal || '-'}`,
    `  Context flags: ${formatFlags(row.listenbrainz_context_flags)}`,
    `  Version flags: ${formatFlags(row.listenbrainz_version_flags)}`,
    `  Release: ${row.listenbrainz_release_name || '-'}`,
    '',
    ...recommendationLines(row),
    '',
    ...helpLines(row),
  ].join('\n');
}

async function askManualYear(rl) {
  for (;;) {
    const answer = await rl.question('Jahr eingeben (YYYY): ');
    const year = parseManualYear(answer);
    if (year != null) return year;
    console.log('Bitte ein vierstelliges Jahr zwischen 1900 und naechstem Jahr eingeben.');
  }
}

async function applyAndSave({ row, rows, choice, save }) {
  const updated = applyManualChoice(row, choice);
  Object.assign(row, updated);
  if (save) await save(rows);
}

async function runInteractiveReview(rows, options = {}) {
  const queue = reviewQueue(rows);
  if (queue.length === 0) {
    console.log('\nKeine offenen Reviews. Alle unauffaelligen final_year-Werte sind gesetzt.');
    return;
  }

  console.log(`\nInteraktiver Review: ${queue.length} offene Review-Zeile(n). Nach jeder Entscheidung wird gespeichert.`);
  const rl = readline.createInterface({
    input: options.input || input,
    output: options.output || output,
  });

  try {
    for (let i = 0; i < queue.length; i++) {
      const row = queue[i];
      for (;;) {
        console.log(formatReview(row, i + 1, queue.length));
        const answer = await rl.question('Auswahl: ');
        const key = cleanText(answer).toLowerCase();

        if (key === '?') {
          console.log(helpLines(row).join('\n'));
          continue;
        }
        if (key === 'x') {
          const reason = cleanText(await rl.question('Ausschlussgrund optional: '));
          await applyAndSave({ row, rows, choice: { type: 'exclude', reason }, save: options.save });
          console.log('Gespeichert.');
          break;
        }
        if (key === 'y') {
          const year = await askManualYear(rl);
          await applyAndSave({
            row,
            rows,
            choice: { type: 'manual_year', year, source: 'manual' },
            save: options.save,
          });
          console.log('Gespeichert.');
          break;
        }

        const choice = choiceForKey(row, key);
        if (!choice) {
          console.log('Ungueltige Auswahl oder Kandidat fehlt. Mit ? Hilfe anzeigen.');
          continue;
        }
        await applyAndSave({ row, rows, choice, save: options.save });
        console.log('Gespeichert.');
        if (choice.type === 'quit') return;
        break;
      }
    }
  } finally {
    rl.close();
  }
}

module.exports = {
  BLOCKING_DEFAULT_VERSION_FLAGS,
  DEFAULT_LB_ALTERNATIVE_NOTE,
  DEFAULT_MB_CONTEXT_NOTE,
  INTERACTIVE_REVIEW_STATUSES,
  canDefaultAcceptListenBrainzAlternative,
  canDefaultAcceptMbContextWarning,
  choiceForKey,
  defaultChoiceForRow,
  formatReview,
  isInteractiveReviewTarget,
  parseManualYear,
  reviewQueue,
  runInteractiveReview,
  splitFlags,
};
