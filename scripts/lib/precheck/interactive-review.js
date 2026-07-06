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
const BATCH_MB_CONTEXT_NOTE =
  'Manual batch accept: MB year accepted despite LB->MB context warning.';
const DEFAULT_LB_ALTERNATIVE_NOTE =
  'Manual accept: LB->MB alternative year accepted.';
const BATCH_LB_ALTERNATIVE_NOTE =
  'Manual batch accept: LB->MB alternative year accepted.';
const SPOTIFY_FALLBACK_NOTE =
  'Manual accept: Spotify fallback year accepted.';

const MANUAL_RECOMMENDATIONS = new Set([
  'manual_conflicting_years',
  'manual_noisy_context',
  'manual_version_risk',
  'unusable',
]);

const FAST_RECOMMENDATIONS = new Set([
  'likely_accept_existing_mb_with_context_warning',
  'useful_alternative_mb_year',
]);

const GROUP_ORDER = [
  'likely_accept_existing_mb_with_context_warning',
  'useful_alternative_mb_year',
  'confirmed_same_year_mb_discogs',
  'confirmed_same_year_mb_spotify',
  'confirmed_same_year_discogs_spotify',
  'single_source_mb',
  'single_source_discogs',
  'spotify_fallback_only',
  'manual_conflicting_years',
  'manual_version_risk',
  'manual_noisy_context',
  'unusable',
  'no_listenbrainz_recommendation',
  'no_default_year',
];

const GROUP_META = {
  likely_accept_existing_mb_with_context_warning: {
    category: 'Schnell bestaetigbar',
    label: 'likely_accept_existing_mb_with_context_warning',
  },
  useful_alternative_mb_year: {
    category: 'Schnell bestaetigbar',
    label: 'useful_alternative_mb_year',
  },
  confirmed_same_year_mb_discogs: {
    category: 'Schnell bestaetigbar',
    label: 'confirmed_same_year_mb_discogs',
  },
  confirmed_same_year_mb_spotify: {
    category: 'Schnell bestaetigbar',
    label: 'confirmed_same_year_mb_spotify',
  },
  confirmed_same_year_discogs_spotify: {
    category: 'Schnell bestaetigbar',
    label: 'confirmed_same_year_discogs_spotify',
  },
  single_source_mb: {
    category: 'Weitere Defaults',
    label: 'single_source_mb',
  },
  single_source_discogs: {
    category: 'Weitere Defaults',
    label: 'single_source_discogs',
  },
  spotify_fallback_only: {
    category: 'Schwache Fallbacks',
    label: 'spotify_fallback_only',
    warning: 'WARNUNG: Nur Spotify-Fallback, keine externe Bestaetigung.',
  },
  manual_conflicting_years: {
    category: 'Manuell auffaellig',
    label: 'manual_conflicting_years',
    warning: 'WARNUNG: manual_conflicting_years',
  },
  manual_version_risk: {
    category: 'Manuell auffaellig',
    label: 'manual_version_risk',
    warning: 'WARNUNG: manual_version_risk',
  },
  manual_noisy_context: {
    category: 'Manuell auffaellig',
    label: 'manual_noisy_context',
    warning: 'WARNUNG: manual_noisy_context',
  },
  unusable: {
    category: 'Manuell auffaellig',
    label: 'unusable',
    warning: 'WARNUNG: unusable',
  },
  no_listenbrainz_recommendation: {
    category: 'Manuell auffaellig',
    label: 'keine Empfehlung',
    warning: 'WARNUNG: keine ListenBrainz->MusicBrainz-Empfehlung',
  },
  no_default_year: {
    category: 'Manuell auffaellig',
    label: 'no_default_year',
    warning: 'WARNUNG: kein Default-Jahr vorhanden.',
  },
};

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

function validYear(value, currentYear = new Date().getFullYear()) {
  const text = cleanText(value);
  if (!/^\d{4}$/.test(text)) return null;
  const year = toIntYear(text);
  const maxYear = currentYear + 1;
  return year >= 1900 && year <= maxYear ? year : null;
}

function yearText(value) {
  const year = validYear(value);
  return year == null ? '' : String(year);
}

function spotifyFallbackYear(row) {
  const direct = yearText(row.estimated_year || row.spotify_year || row.csv_year);
  if (direct) return direct;
  const releaseDate = cleanText(row.spotify_album_release_date);
  const match = releaseDate.match(/^(\d{4})/);
  return match ? yearText(match[1]) : '';
}

function yearsForRow(row) {
  return {
    mb: yearText(row.mb_year),
    listenbrainzMb: yearText(row.listenbrainz_mb_year),
    discogs: yearText(row.discogs_year),
    spotify: spotifyFallbackYear(row),
  };
}

function isInteractiveReviewTarget(row) {
  return INTERACTIVE_REVIEW_STATUSES.has(row && row.status);
}

function reviewQueue(rows) {
  return rows.filter(isInteractiveReviewTarget);
}

function sameYear(a, b) {
  return a !== '' && b !== '' && a === b;
}

function makeCandidate(row, attrs) {
  const candidate = {
    year: attrs.year,
    source: attrs.source,
    sourceLabel: attrs.sourceLabel,
    confidence: attrs.confidence,
    groupKey: attrs.groupKey,
    label: attrs.label,
    warning: attrs.warning || '',
    note: attrs.note || '',
    reason: attrs.reason || '',
  };
  candidate.choice = choiceForCandidate(row, candidate);
  return candidate;
}

function getDefaultCandidate(row) {
  const years = yearsForRow(row);
  const recommendation = cleanText(row.listenbrainz_recommendation);

  if (recommendation === 'likely_accept_existing_mb_with_context_warning' && years.mb) {
    return makeCandidate(row, {
      year: years.mb,
      source: 'musicbrainz',
      sourceLabel: 'MusicBrainz',
      confidence: 'LB->MB Kontextwarnung',
      groupKey: recommendation,
      label: 'MB-Jahr',
      note: DEFAULT_MB_CONTEXT_NOTE,
      reason: 'lb_mb_context_warning_confirmed',
    });
  }

  if (recommendation === 'useful_alternative_mb_year' && years.listenbrainzMb) {
    return makeCandidate(row, {
      year: years.listenbrainzMb,
      source: 'listenbrainz_musicbrainz',
      sourceLabel: 'LB->MB',
      confidence: 'hilfreiches Alternativjahr',
      groupKey: recommendation,
      label: 'LB->MB-Vorschlag',
      note: DEFAULT_LB_ALTERNATIVE_NOTE,
      reason: 'lb_mb_alternative_confirmed',
    });
  }

  if (sameYear(years.mb, years.discogs)) {
    return makeCandidate(row, {
      year: years.mb,
      source: 'musicbrainz',
      sourceLabel: 'MusicBrainz/Discogs',
      confidence: 'bestaetigt',
      groupKey: 'confirmed_same_year_mb_discogs',
      label: 'MB-Jahr',
    });
  }

  if (sameYear(years.mb, years.spotify)) {
    return makeCandidate(row, {
      year: years.mb,
      source: 'musicbrainz',
      sourceLabel: 'MusicBrainz/Spotify',
      confidence: 'bestaetigt',
      groupKey: 'confirmed_same_year_mb_spotify',
      label: 'MB-Jahr',
    });
  }

  if (sameYear(years.discogs, years.spotify)) {
    return makeCandidate(row, {
      year: years.discogs,
      source: 'discogs',
      sourceLabel: 'Discogs/Spotify',
      confidence: 'bestaetigt',
      groupKey: 'confirmed_same_year_discogs_spotify',
      label: 'Discogs-Jahr',
    });
  }

  if (years.mb) {
    return makeCandidate(row, {
      year: years.mb,
      source: 'musicbrainz',
      sourceLabel: 'MusicBrainz',
      confidence: 'single source',
      groupKey: 'single_source_mb',
      label: 'MB-Jahr',
    });
  }

  if (years.discogs) {
    return makeCandidate(row, {
      year: years.discogs,
      source: 'discogs',
      sourceLabel: 'Discogs',
      confidence: 'single source',
      groupKey: 'single_source_discogs',
      label: 'Discogs-Jahr',
    });
  }

  if (years.spotify) {
    return makeCandidate(row, {
      year: years.spotify,
      source: 'spotify',
      sourceLabel: 'Spotify',
      confidence: 'schwach, keine Bestaetigung',
      groupKey: 'spotify_fallback_only',
      label: 'Spotify-Fallback',
      warning: GROUP_META.spotify_fallback_only.warning,
      note: SPOTIFY_FALLBACK_NOTE,
      reason: 'manual_confirmed_spotify_fallback',
    });
  }

  return {
    year: '',
    source: '',
    sourceLabel: '',
    confidence: 'kein Jahr vorhanden',
    groupKey: 'no_default_year',
    label: 'kein Default',
    warning: GROUP_META.no_default_year.warning,
    note: '',
    reason: '',
    choice: null,
  };
}

function canDefaultAcceptMbContextWarning(row) {
  const candidate = getDefaultCandidate(row);
  return (
    row.listenbrainz_recommendation === 'likely_accept_existing_mb_with_context_warning' &&
    candidate.source === 'musicbrainz' &&
    candidate.year !== ''
  );
}

function canDefaultAcceptListenBrainzAlternative(row) {
  const candidate = getDefaultCandidate(row);
  return (
    row.listenbrainz_recommendation === 'useful_alternative_mb_year' &&
    candidate.source === 'listenbrainz_musicbrainz' &&
    candidate.year !== ''
  );
}

function choiceForCandidate(row, candidate, options = {}) {
  if (!candidate || !candidate.year) return null;
  if (candidate.source === 'musicbrainz') {
    const isContextWarning =
      candidate.groupKey === 'likely_accept_existing_mb_with_context_warning';
    return {
      type: 'accept_mb',
      note: isContextWarning && options.batch ? BATCH_MB_CONTEXT_NOTE : candidate.note,
      reason: isContextWarning && options.batch
        ? 'manual_batch_lb_context_warning_confirmed'
        : candidate.reason,
    };
  }
  if (candidate.source === 'listenbrainz_musicbrainz') {
    const isAlternative = candidate.groupKey === 'useful_alternative_mb_year';
    return {
      type: 'accept_listenbrainz_mb',
      note: isAlternative && options.batch ? BATCH_LB_ALTERNATIVE_NOTE : candidate.note,
      reason: isAlternative && options.batch
        ? 'manual_batch_listenbrainz_musicbrainz_confirmed'
        : candidate.reason,
    };
  }
  if (candidate.source === 'discogs') {
    return { type: 'accept_discogs', note: candidate.note, reason: candidate.reason };
  }
  if (candidate.source === 'spotify') {
    return {
      type: 'accept_spotify',
      year: candidate.year,
      note: candidate.note || SPOTIFY_FALLBACK_NOTE,
      reason: candidate.reason || 'manual_confirmed_spotify_fallback',
    };
  }
  return {
    type: 'accept_default',
    year: candidate.year,
    source: candidate.source || 'manual',
    note: candidate.note,
    reason: candidate.reason,
  };
}

function defaultChoiceForRow(row) {
  const candidate = getDefaultCandidate(row);
  return choiceForCandidate(row, candidate);
}

function choiceForSource(row, sourceKey) {
  const normalized = cleanText(sourceKey).toLowerCase();
  if ((normalized === 'm' || normalized === 'mb') && yearText(row.mb_year)) {
    return { type: 'accept_mb' };
  }
  if (
    (normalized === 'l' || normalized === 'lb' || normalized === 'listenbrainz') &&
    yearText(row.listenbrainz_mb_year)
  ) {
    return { type: 'accept_listenbrainz_mb' };
  }
  if ((normalized === 'd' || normalized === 'discogs') && yearText(row.discogs_year)) {
    return { type: 'accept_discogs' };
  }
  if ((normalized === 'sp' || normalized === 'spotify') && spotifyFallbackYear(row)) {
    return {
      type: 'accept_spotify',
      year: spotifyFallbackYear(row),
      note: SPOTIFY_FALLBACK_NOTE,
      reason: 'manual_confirmed_spotify_fallback',
    };
  }
  return null;
}

function choiceForKey(row, key) {
  const normalized = cleanText(key).toLowerCase();
  if (normalized === '') return defaultChoiceForRow(row);
  if (normalized === 'm') return choiceForSource(row, 'm');
  if (normalized === 'l') return choiceForSource(row, 'l');
  if (normalized === 'd') return choiceForSource(row, 'd');
  if (normalized === 's') return { type: 'skip' };
  if (normalized === 'q') return { type: 'quit' };
  return null;
}

function parseManualYear(value, currentYear = new Date().getFullYear()) {
  return validYear(value, currentYear);
}

function groupKeyForRow(row, candidate) {
  const recommendation = cleanText(row.listenbrainz_recommendation);
  if (FAST_RECOMMENDATIONS.has(recommendation) || MANUAL_RECOMMENDATIONS.has(recommendation)) {
    return recommendation;
  }
  if (!recommendation) return candidate.groupKey || 'no_listenbrainz_recommendation';
  return candidate.groupKey || 'no_listenbrainz_recommendation';
}

function groupReviewRows(rows) {
  const groups = new Map();
  for (const row of reviewQueue(rows)) {
    const candidate = getDefaultCandidate(row);
    const key = groupKeyForRow(row, candidate);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        meta: GROUP_META[key] || {
          category: 'Weitere Defaults',
          label: key,
        },
        items: [],
      });
    }
    groups.get(key).items.push({ row, candidate });
  }
  return Array.from(groups.values()).sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(a.key);
    const bi = GROUP_ORDER.indexOf(b.key);
    const ar = ai === -1 ? GROUP_ORDER.length : ai;
    const br = bi === -1 ? GROUP_ORDER.length : bi;
    if (ar !== br) return ar - br;
    return a.key.localeCompare(b.key);
  });
}

function letterForIndex(index) {
  const code = 'A'.charCodeAt(0) + index;
  return code <= 'Z'.charCodeAt(0) ? String.fromCharCode(code) : String(index + 1);
}

function formatGroupSummary(groups) {
  const lines = [];
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  lines.push(`Offene Reviews: ${total}`);
  const categories = ['Schnell bestaetigbar', 'Weitere Defaults', 'Schwache Fallbacks', 'Manuell auffaellig'];
  let letter = 0;
  for (const category of categories) {
    const categoryGroups = groups.filter((group) => group.meta.category === category);
    if (categoryGroups.length === 0) continue;
    lines.push('');
    lines.push(`${category}:`);
    for (const group of categoryGroups) {
      lines.push(`  ${letterForIndex(letter)} ${group.meta.label}: ${group.items.length}`);
      letter += 1;
    }
  }
  return lines.join('\n');
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

function formatEnterHint(row) {
  const candidate = getDefaultCandidate(row);
  if (!candidate.choice) {
    return 'ENTER = kein Default vorhanden; bitte y fuer manuelles Jahr nutzen';
  }
  return `ENTER = Default uebernehmen: ${candidate.year} (${candidate.sourceLabel}, ${candidate.confidence})`;
}

function helpLines(row) {
  return [
    formatEnterHint(row),
    yearText(row.mb_year) ? `m = MusicBrainz-Jahr ${yearText(row.mb_year)} uebernehmen` : '',
    yearText(row.listenbrainz_mb_year)
      ? `l = LB->MB-Jahr ${yearText(row.listenbrainz_mb_year)} uebernehmen`
      : '',
    yearText(row.discogs_year) ? `d = Discogs-Jahr ${yearText(row.discogs_year)} uebernehmen` : '',
    's = skip / spaeter pruefen',
    'x = aus Pool ausschliessen',
    'y = manuelles Jahr eingeben',
    'q = speichern und beenden',
  ].filter(Boolean);
}

function formatReview(row, index, total) {
  const reason = notePart(row, 'review_reason') || row.review_reason || row.status || '-';
  const riskFlags = notePart(row, 'risk_flags') || row.risk_flags || '';
  const candidate = getDefaultCandidate(row);
  return [
    '',
    '------------------------------------------------------------',
    `[${index}/${total}] ${row.title || '-'} - ${row.artist || '-'}`,
    '',
    `Status: ${row.status || '-'}`,
    `Grund: ${reason}`,
    `Risk Flags: ${formatFlags(riskFlags)}`,
    candidate.warning ? candidate.warning : '',
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
  ].filter((line) => line !== '').join('\n');
}

function formatGroupItem(item, index) {
  const row = item.row;
  const candidate = item.candidate;
  return [
    `${index}. ${row.title || '-'} - ${row.artist || '-'}`,
    `   Vorschlag: ${candidate.year || '-'} (${candidate.sourceLabel || '-'}, ${candidate.confidence})`,
    `   Spotify: ${row.estimated_year || row.csv_year || '-'} | MB: ${row.mb_year || '-'} | Discogs: ${row.discogs_year || '-'} | LB->MB: ${row.listenbrainz_mb_year || '-'}`,
    `   Context: ${formatFlags(row.listenbrainz_context_flags)} | Version: ${formatFlags(row.listenbrainz_version_flags)}`,
    `   Release: ${row.listenbrainz_release_name || row.spotify_album_name || '-'}`,
  ].join('\n');
}

function groupActionLines(group) {
  if (group.key === 'useful_alternative_mb_year') {
    return [
      'ENTER/a = alle LB->MB-Vorschlaege uebernehmen',
      '3 oder 3,7 = diese Nummern ausnehmen und spaeter einzeln pruefen',
      'd3 = bei Nummer 3 Discogs-Jahr uebernehmen',
      'm3 = bei Nummer 3 MB-Jahr uebernehmen',
      'y3 = Nummer 3 manuell korrigieren',
      'x3 = Nummer 3 ausschliessen',
      's = ganze Gruppe skippen',
      'q = speichern und beenden',
    ];
  }
  return [
    'ENTER/a = alle sichtbaren Defaults uebernehmen',
    '3 oder 3,7 = diese Nummern ausnehmen und spaeter einzeln pruefen',
    'm3/l3/d3 = Nummer 3 mit MB/LB->MB/Discogs uebernehmen',
    'y3 = Nummer 3 manuell korrigieren',
    'x3 = Nummer 3 ausschliessen',
    's = ganze Gruppe skippen',
    'q = speichern und beenden',
  ];
}

function formatGroup(group, index, total) {
  const lines = [
    '',
    '============================================================',
    `Gruppe ${index}/${total}: ${group.meta.label} (${group.items.length})`,
  ];
  if (group.meta.warning) lines.push(group.meta.warning);
  if (group.key === 'spotify_fallback_only') {
    lines.push('ENTER uebernimmt trotzdem Spotify-Jahr, weil der Nutzer bewusst bestaetigt.');
  }
  lines.push('');
  group.items.forEach((item, itemIndex) => {
    lines.push(formatGroupItem(item, itemIndex + 1));
  });
  lines.push('');
  lines.push(...groupActionLines(group));
  return lines.join('\n');
}

function parseIndexList(text) {
  if (!/^\d+(,\d+)*$/.test(text)) return null;
  return text.split(',').map((part) => Number.parseInt(part, 10));
}

function parseGroupAction(inputValue) {
  const text = cleanText(inputValue).toLowerCase();
  if (text === '' || text === 'a') return { type: 'accept_all' };
  if (text === 's') return { type: 'skip_group' };
  if (text === 'q') return { type: 'quit' };

  const numbers = parseIndexList(text);
  if (numbers) return { type: 'accept_all_except', indexes: numbers };

  const keyed = text.match(/^([xymld])(\d+)$/);
  if (keyed) {
    const key = keyed[1];
    const index = Number.parseInt(keyed[2], 10);
    if (key === 'x') return { type: 'exclude_one', index };
    if (key === 'y') return { type: 'manual_one', index };
    return { type: 'accept_one', index, source: key };
  }

  return null;
}

function itemForIndex(group, index) {
  if (!Number.isInteger(index) || index < 1 || index > group.items.length) return null;
  return group.items[index - 1];
}

function assignManualChoice(row, choice) {
  const updated = applyManualChoice(row, choice);
  Object.assign(row, updated);
  return row;
}

function applyCandidate(row, candidate, options = {}) {
  const choice = choiceForCandidate(row, candidate, options);
  if (!choice) return false;
  assignManualChoice(row, choice);
  return true;
}

function applyGroupAction(group, action = {}) {
  const result = {
    applied: 0,
    skipped: 0,
    excluded: 0,
    manual: 0,
    deferredRows: [],
    noDefaultRows: [],
    quit: false,
    invalid: '',
    needsManualIndex: null,
  };

  if (action.type === 'quit') {
    result.quit = true;
    return result;
  }

  if (action.type === 'skip_group') {
    for (const item of group.items) {
      assignManualChoice(item.row, { type: 'skip' });
      result.skipped += 1;
    }
    return result;
  }

  if (action.type === 'accept_all' || action.type === 'accept_all_except') {
    const except = new Set((action.indexes || []).filter((index) => itemForIndex(group, index)));
    for (let i = 0; i < group.items.length; i++) {
      const item = group.items[i];
      const itemNumber = i + 1;
      if (except.has(itemNumber)) {
        result.deferredRows.push(item.row);
        continue;
      }
      const candidate = getDefaultCandidate(item.row);
      if (!applyCandidate(item.row, candidate, { batch: true })) {
        result.noDefaultRows.push(item.row);
        result.deferredRows.push(item.row);
        continue;
      }
      result.applied += 1;
    }
    return result;
  }

  if (action.type === 'exclude_one') {
    const item = itemForIndex(group, action.index);
    if (!item) {
      result.invalid = 'Nummer nicht in dieser Gruppe.';
      return result;
    }
    assignManualChoice(item.row, { type: 'exclude', reason: action.reason || '' });
    result.excluded = 1;
    return result;
  }

  if (action.type === 'manual_one') {
    const item = itemForIndex(group, action.index);
    if (!item) {
      result.invalid = 'Nummer nicht in dieser Gruppe.';
      return result;
    }
    if (parseManualYear(action.year) == null) {
      result.needsManualIndex = action.index;
      return result;
    }
    assignManualChoice(item.row, {
      type: 'manual_year',
      year: action.year,
      source: 'manual',
    });
    result.manual = 1;
    return result;
  }

  if (action.type === 'accept_one') {
    const item = itemForIndex(group, action.index);
    if (!item) {
      result.invalid = 'Nummer nicht in dieser Gruppe.';
      return result;
    }
    const choice = choiceForSource(item.row, action.source);
    if (!choice) {
      result.invalid = 'Quelle fuer diese Nummer nicht verfuegbar.';
      return result;
    }
    assignManualChoice(item.row, choice);
    result.applied = 1;
    return result;
  }

  result.invalid = 'Ungueltige Auswahl.';
  return result;
}

async function askManualYear(rl) {
  for (;;) {
    const answer = await rl.question('Jahr eingeben (YYYY): ');
    const year = parseManualYear(answer);
    if (year != null) return year;
    console.log('Bitte ein vierstelliges Jahr zwischen 1900 und naechstem Jahr eingeben.');
  }
}

async function saveIfNeeded(save, rows) {
  if (save) await save(rows);
}

async function runIndividualReview(rows, options, rl) {
  const queue = rows.filter(isInteractiveReviewTarget);
  if (queue.length === 0) return false;

  console.log(`\nEinzelpruefung: ${queue.length} ausgenommene Review-Zeile(n).`);
  for (let i = 0; i < queue.length; i++) {
    const row = queue[i];
    for (;;) {
      console.log(formatReview(row, i + 1, queue.length));
      const answer = await rl.question('Auswahl: ');
      const key = cleanText(answer).toLowerCase();

      if (key === 'x') {
        const reason = cleanText(await rl.question('Ausschlussgrund optional: '));
        assignManualChoice(row, { type: 'exclude', reason });
        await saveIfNeeded(options.save, options.allRows || rows);
        console.log('Gespeichert.');
        break;
      }
      if (key === 'y') {
        const year = await askManualYear(rl);
        assignManualChoice(row, { type: 'manual_year', year, source: 'manual' });
        await saveIfNeeded(options.save, options.allRows || rows);
        console.log('Gespeichert.');
        break;
      }

      const choice = choiceForKey(row, key);
      if (!choice) {
        console.log('Kein gueltiger Kandidat. Bitte m/l/d, y, x, s oder q nutzen.');
        continue;
      }
      assignManualChoice(row, choice);
      await saveIfNeeded(options.save, options.allRows || rows);
      console.log('Gespeichert.');
      if (choice.type === 'quit') return true;
      break;
    }
  }
  return false;
}

function uniqueRows(rows) {
  return Array.from(new Set(rows));
}

async function runInteractiveReview(rows, options = {}) {
  const initialQueue = reviewQueue(rows);
  if (initialQueue.length === 0) {
    console.log('\nKeine offenen Reviews. Alle unauffaelligen final_year-Werte sind gesetzt.');
    return;
  }

  const groups = groupReviewRows(rows);
  console.log('');
  console.log(formatGroupSummary(groups));
  console.log('\nNach jeder Gruppenentscheidung wird gespeichert.');

  const rl = readline.createInterface({
    input: options.input || input,
    output: options.output || output,
  });
  const deferredRows = [];

  try {
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      for (;;) {
        const activeItems = group.items.filter((item) => isInteractiveReviewTarget(item.row));
        if (activeItems.length === 0) break;
        const activeGroup = { ...group, items: activeItems };
        console.log(formatGroup(activeGroup, groupIndex + 1, groups.length));
        const answer = await rl.question('Auswahl: ');
        let action = parseGroupAction(answer);

        if (!action) {
          console.log('Ungueltige Auswahl. Die verfuegbaren Aktionen stehen direkt ueber der Eingabe.');
          continue;
        }
        if (action.type === 'manual_one' && parseManualYear(action.year) == null) {
          const year = await askManualYear(rl);
          action = { ...action, year };
        }
        if (action.type === 'exclude_one' && action.reason == null) {
          const reason = cleanText(await rl.question('Ausschlussgrund optional: '));
          action = { ...action, reason };
        }

        const result = applyGroupAction(activeGroup, action);
        if (result.invalid) {
          console.log(result.invalid);
          continue;
        }
        if (result.noDefaultRows.length > 0) {
          console.log('Mindestens eine Zeile hat kein Default-Jahr und wird einzeln geprueft.');
        }
        deferredRows.push(...result.deferredRows);
        await saveIfNeeded(options.save, rows);
        console.log('Gespeichert.');

        if (result.quit) return;
        if (['accept_all', 'accept_all_except', 'skip_group'].includes(action.type)) break;
      }
    }

    const quit = await runIndividualReview(uniqueRows(deferredRows), { ...options, allRows: rows }, rl);
    if (quit) return;
  } finally {
    rl.close();
  }
}

module.exports = {
  BATCH_LB_ALTERNATIVE_NOTE,
  BATCH_MB_CONTEXT_NOTE,
  DEFAULT_LB_ALTERNATIVE_NOTE,
  DEFAULT_MB_CONTEXT_NOTE,
  GROUP_META,
  GROUP_ORDER,
  INTERACTIVE_REVIEW_STATUSES,
  SPOTIFY_FALLBACK_NOTE,
  applyGroupAction,
  canDefaultAcceptListenBrainzAlternative,
  canDefaultAcceptMbContextWarning,
  choiceForKey,
  defaultChoiceForRow,
  formatEnterHint,
  formatGroup,
  formatGroupSummary,
  formatReview,
  getDefaultCandidate,
  groupReviewRows,
  isInteractiveReviewTarget,
  parseGroupAction,
  parseManualYear,
  reviewQueue,
  runInteractiveReview,
  splitFlags,
};
