'use strict';

const fs = require('fs');
const { toIntYear } = require('./helpers');
const { hasFinalYear, isOpenReview } = require('./review-queue');

const PRIMARY_STATUSES = [
  'auto_accepted_mb',
  'auto_accepted_mb_soft_checked',
  'review_needed',
  'review_needed_after_discogs',
  'soft_discogs_pending',
];

function countStatus(rows, status) {
  return rows.filter((row) => row.status === status).length;
}

function statusDistribution(rows) {
  const out = {};
  for (const status of PRIMARY_STATUSES) out[status] = countStatus(rows, status);
  out.other = rows.filter((row) => !PRIMARY_STATUSES.includes(row.status || '')).length;
  return out;
}

function isUploadReady(row) {
  if (row.status === 'excluded_from_pool') return false;
  return hasFinalYear(row);
}

function computeSummary(rows) {
  const statuses = statusDistribution(rows);
  const uploadReadyDirect = statuses.auto_accepted_mb;
  const uploadReadySoftChecked = statuses.auto_accepted_mb_soft_checked;
  const manualReviewsOpen = statuses.review_needed + statuses.review_needed_after_discogs;
  const uploadBlocked = rows.filter((row) => row.status !== 'excluded_from_pool' && !hasFinalYear(row)).length;

  return {
    autoDecided: rows.filter(isUploadReady).length,
    existingConfirmed: rows.filter((r) => r.status === 'existing_year_confirmed').length,
    openReviews: rows.filter(isOpenReview).length,
    skipped: rows.filter((r) => r.status === 'manual_skipped').length,
    mbPlausible: rows.filter((r) => r.mb_year_source === 'mb_ok' && toIntYear(r.mb_year) != null).length,
    mbMissingOrUncertain: rows.filter((r) => r.status === 'mb_no_match' || r.status === 'mb_match_uncertain' || r.mb_year_source === 'mb_no_match' || r.mb_year_source === 'mb_match_uncertain').length,
    conflicts: manualReviewsOpen,
    statuses,
    uploadReadyDirect,
    uploadReadySoftChecked,
    manualReviewsOpen,
    uploadBlocked,
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

function notePart(row, label) {
  const match = String(row.notes || '').match(new RegExp(`${label}: ([^;]+)`));
  return match ? match[1].trim() : '';
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    const key = value || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function countLines(counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return ['  - keine'];
  return entries.map(([key, value]) => `  - ${key}: ${value}`);
}

function openReviewRows(rows) {
  return rows.filter((row) =>
    ['review_needed', 'review_needed_after_discogs', 'soft_discogs_pending'].includes(row.status)
  );
}

function topOpenReviewLines(rows) {
  const items = openReviewRows(rows);
  if (!items.length) return ['  - keine'];
  return items.slice(0, 20).map((row, i) => {
    const reason = notePart(row, 'review_reason') || row.status || 'unknown';
    const flags = notePart(row, 'risk_flags') || '-';
    return `  ${i + 1}. ${row.title} - ${row.artist} | ${row.status} | Grund ${reason} | Risk ${flags} | MB ${row.mb_year || '-'} | Discogs ${row.discogs_year || '-'}`;
  });
}

function resultLines(rows, summary) {
  return [
    'Ergebnis:',
    `  Songs gesamt: ${rows.length}`,
    `  Upload-ready automatisch: ${summary.uploadReadyDirect + summary.uploadReadySoftChecked}`,
    `    - MusicBrainz direkt: ${summary.uploadReadyDirect}`,
    `    - MusicBrainz + Soft-Discogs geprueft: ${summary.uploadReadySoftChecked}`,
    `  Manuelle Reviews offen: ${summary.manualReviewsOpen}`,
    `    - review_needed: ${summary.statuses.review_needed}`,
    `    - review_needed_after_discogs: ${summary.statuses.review_needed_after_discogs}`,
    `  Upload-blockiert: ${summary.uploadBlocked}`,
  ];
}

function statusLines(summary) {
  return [
    'Statusverteilung:',
    `  auto_accepted_mb: ${summary.statuses.auto_accepted_mb}`,
    `  auto_accepted_mb_soft_checked: ${summary.statuses.auto_accepted_mb_soft_checked}`,
    `  review_needed: ${summary.statuses.review_needed}`,
    `  review_needed_after_discogs: ${summary.statuses.review_needed_after_discogs}`,
    `  soft_discogs_pending: ${summary.statuses.soft_discogs_pending}`,
    `  sonstige: ${summary.statuses.other}`,
  ];
}

function musicBrainzLines(rows, summary) {
  const mbIsrcHits = rows.filter((row) => row.mb_year_source === 'mb_ok' && row.mb_match_method === 'isrc').length;
  const mbTextHits = rows.filter((row) => row.mb_year_source === 'mb_ok' && row.mb_match_method === 'text').length;
  const mbNoMatch = rows.filter((row) => row.status === 'mb_no_match' || row.mb_year_source === 'mb_no_match').length;
  const mbUncertain = rows.filter((row) => row.status === 'mb_match_uncertain' || row.mb_year_source === 'mb_match_uncertain').length;
  return [
    'MusicBrainz-Qualitaet:',
    `  plausibel mit Jahr: ${summary.mbPlausible}`,
    `  fehlend/unsicher: ${summary.mbMissingOrUncertain}`,
    `  ISRC-Treffer: ${mbIsrcHits}`,
    `  Text-Fallback-Treffer: ${mbTextHits}`,
    `  mb_no_match: ${mbNoMatch}`,
    `  mb_match_uncertain: ${mbUncertain}`,
  ];
}

function hardDiscogsLines(stats = {}) {
  const dc = stats.discogs || {};
  return [
    'Discogs-Hard-Checks:',
    `  geplant: ${dc.planned || 0}`,
    `  externe Calls: ${dc.calls || 0}`,
    `  Cache-Hits: ${dc.cacheHits || 0}`,
    `  uebersprungen: ${dc.skips || 0}`,
    `  begrenzt: ${dc.capped || 0}`,
  ];
}

function softDiscogsLines(rows, stats = {}) {
  const soft = stats.softDiscogs || null;
  return [
    'Soft-Discogs-Checks:',
    soft
      ? `  pending vorher: ${soft.softPendingBefore || 0}`
      : `  pending vorher: ${rows.filter((row) => row.status === 'soft_discogs_pending').length}`,
    `  geprueft: ${soft ? soft.checked || 0 : 0}`,
    `  freigegeben: ${rows.filter((row) => row.status === 'auto_accepted_mb_soft_checked').length}`,
    `  review nach Discogs: ${rows.filter((row) => row.status === 'review_needed_after_discogs').length}`,
    `  weiterhin pending: ${rows.filter((row) => row.status === 'soft_discogs_pending').length}`,
    `  externe Calls: ${soft ? soft.calls || 0 : 0}`,
    `  Cache-Hits: ${soft ? soft.cacheHits || 0 : 0}`,
    `  Fehler: ${soft ? soft.errors || 0 : 0}`,
    `  RateLimit: ${soft ? soft.rateLimited || 0 : 0}`,
    `  Timeouts: ${soft ? soft.timeouts || 0 : 0}`,
  ];
}

function listenBrainzLineItem(row) {
  const flags = [row.listenbrainz_context_flags, row.listenbrainz_version_flags]
    .filter(Boolean)
    .join(' | ') || '-';
  return `  - ${row.title} - ${row.artist} | MB ${row.mb_year || '-'} | Spotify ${row.estimated_year || row.csv_year || '-'} | Discogs ${row.discogs_year || '-'} | LB-MB ${row.listenbrainz_mb_year || '-'} | ${row.listenbrainz_year_signal || '-'} | ${flags}`;
}

function listenBrainzRows(rows) {
  return rows.filter((row) =>
    ['review_needed', 'review_needed_after_discogs', 'soft_discogs_pending'].includes(row.status) &&
    row.listenbrainz_recommendation
  );
}

function listenBrainzRecommendationList(rows, recommendation) {
  const items = listenBrainzRows(rows).filter((row) => row.listenbrainz_recommendation === recommendation);
  if (!items.length) return ['  - keine'];
  return items.map(listenBrainzLineItem);
}

function listenBrainzReviewLines(rows, stats = {}) {
  const lb = stats.listenBrainz || { mode: 'off' };
  const enrichedRows = listenBrainzRows(rows);
  const recommendationCounts = lb.recommendationCounts && Object.keys(lb.recommendationCounts).length
    ? lb.recommendationCounts
    : countBy(enrichedRows.map((row) => row.listenbrainz_recommendation));
  const yearSignalCounts = lb.yearSignalCounts && Object.keys(lb.yearSignalCounts).length
    ? lb.yearSignalCounts
    : countBy(enrichedRows.map((row) => row.listenbrainz_year_signal));

  const lines = [
    'ListenBrainz->MusicBrainz Review-Empfehlungen:',
    `  Modus: ${lb.mode || 'off'}`,
    `  offene Zielzeilen: ${lb.targetRows || 0}`,
    `  geprueft: ${lb.checked || 0}`,
    `  skipped/no token: ${lb.skippedNoToken || 0}`,
    `  errors: ${lb.errors || 0}`,
    '',
    '  Recommendation-Verteilung:',
    ...countLines(recommendationCounts),
    '',
    '  Year-Signal-Verteilung:',
    ...countLines(yearSignalCounts),
    '',
    '  useful_alternative_mb_year:',
    ...listenBrainzRecommendationList(rows, 'useful_alternative_mb_year'),
    '',
    '  likely_accept_existing_mb:',
    ...listenBrainzRecommendationList(rows, 'likely_accept_existing_mb'),
    '',
    '  likely_accept_existing_mb_with_context_warning:',
    ...listenBrainzRecommendationList(rows, 'likely_accept_existing_mb_with_context_warning'),
    '',
    '  manual_conflicting_years:',
    ...listenBrainzRecommendationList(rows, 'manual_conflicting_years'),
    '',
    '  manual_noisy_context:',
    ...listenBrainzRecommendationList(rows, 'manual_noisy_context'),
    '',
    '  manual_version_risk:',
    ...listenBrainzRecommendationList(rows, 'manual_version_risk'),
    '',
    '  unusable:',
    ...listenBrainzRecommendationList(rows, 'unusable'),
  ];

  return lines;
}

function reviewReasonLines(rows) {
  const openRows = openReviewRows(rows);
  const reasons = countBy(openRows.map((row) => notePart(row, 'review_reason') || row.status));
  const flags = countBy(
    openRows.flatMap((row) => {
      const value = notePart(row, 'risk_flags');
      if (!value || value === 'none') return [];
      return value.split('+').map((flag) => flag.trim()).filter(Boolean);
    })
  );
  return [
    'Offene Review-Gruende:',
    ...countLines(reasons),
    '',
    'Risk Flags in offenen Reviews:',
    ...countLines(flags),
  ];
}

function spotifyDeviationLines(rows) {
  const spotify = sourceDeviation(rows, 'estimated_year');
  return [
    'Spotify-vs-MusicBrainz-Abweichungen:',
    `  Abweichungen > 1 Jahr: ${spotify.length}`,
    `  Durchschnittliche Abweichung: ${averageAbsDiff(spotify)} Jahre`,
    ...topLines(spotify, 'Spotify'),
  ];
}

function deezerLines(rows, stats = {}, totalMs = 0) {
  const dz = stats.deezer || {};
  if ((dz.mode || 'needed') === 'off') return ['Deezer: off'];
  const timings = stats.timings || {};
  const deezerMs = timings.deezerMs || 0;
  const deezer = sourceDeviation(rows, 'deezer_year');
  const avgCallMs = dz.calls ? (dz.callMs / dz.calls).toFixed(0) : '0';
  const share = totalMs ? ((deezerMs / totalMs) * 100).toFixed(1) : '0.0';
  return [
    'Deezer (Kompatibilitaet, nicht entscheidend):',
    `  Modus: ${dz.mode || 'needed'}`,
    `  Calls: ${dz.calls || 0}`,
    `  Cache-Hits: ${dz.cacheHits || 0}`,
    `  Input-Wiederverwendung: ${dz.inputHits || 0}`,
    `  Skips: ${dz.skips || 0}`,
    `  Fehler/Timeouts: ${dz.errors || 0}/${dz.timeouts || 0}`,
    `  Laufzeit: ${(deezerMs / 1000).toFixed(1)}s (${share}% gesamt, ${avgCallMs}ms/Call)`,
    `  Abweichungen von MB > 1 Jahr: ${deezer.length}`,
    ...topLines(deezer, 'Deezer'),
  ];
}

function buildAnalysisReport(rows, summary, stats = {}, totalMs = 0) {
  return [
    'Precheck-Report',
    '===============',
    ...resultLines(rows, summary),
    '',
    ...statusLines(summary),
    '',
    ...musicBrainzLines(rows, summary),
    '',
    ...hardDiscogsLines(stats),
    '',
    ...softDiscogsLines(rows, stats),
    '',
    ...listenBrainzReviewLines(rows, stats),
    '',
    ...reviewReasonLines(rows),
    '',
    'Top offene Reviews:',
    ...topOpenReviewLines(rows),
    '',
    ...spotifyDeviationLines(rows),
    '',
    ...deezerLines(rows, stats, totalMs),
    '',
  ].join('\n');
}

function writeAnalysisReport(outputCsv, rows, summary, stats, totalMs) {
  const reportPath = `${outputCsv}.report.txt`;
  const report = buildAnalysisReport(rows, summary, stats, totalMs);
  fs.writeFileSync(reportPath, report, 'utf8');
  return { reportPath, report };
}

function printResolverSummary(results) {
  const byMethod = {};
  for (const r of results) {
    const mm = r.matchMethod || (r.spotifyFound ? 'unknown' : 'none');
    byMethod[mm] = (byMethod[mm] || 0) + 1;
  }
  const resolverTotal =
    (byMethod.creditsfm_isrc || 0) +
    (byMethod.deezer_isrc || 0) +
    (byMethod.strict || 0) +
    (byMethod.fallback_loose || 0) +
    (byMethod.fallback_first_artist || 0);
  if (resolverTotal === 0) return;
  console.log('Spotify-Resolver:');
  console.log(`  ISRC-Hilfe: ${byMethod.creditsfm_isrc || 0}`);
  console.log(`  Deezer-ISRC: ${byMethod.deezer_isrc || 0}`);
  console.log(`  Spotify strict: ${byMethod.strict || 0}`);
  console.log(`  Spotify loose: ${(byMethod.fallback_loose || 0) + (byMethod.fallback_first_artist || 0)}`);
}

function printSummary({ rows, results, stats, inputs, outputCsv, tScript }) {
  const summary = computeSummary(rows);
  const totalMs = Date.now() - tScript;
  const { reportPath } = writeAnalysisReport(outputCsv, rows, summary, stats, totalMs);
  const t = stats.timings || {};
  const line = '-'.repeat(64);
  const s1 = (ms) => ((ms || 0) / 1000).toFixed(1);

  console.log(`\n${line}\nERGEBNIS\n${line}`);
  for (const lineText of resultLines(rows, summary)) console.log(lineText);
  console.log('');
  for (const lineText of statusLines(summary)) console.log(lineText);
  console.log('');
  printResolverSummary(results);
  console.log(`MusicBrainz-Pruefung: ${s1(t.mbMs)}s`);
  if (((stats.deezer || {}).mode || 'needed') === 'off') {
    console.log('Deezer: off');
  } else if (stats.deezer) {
    console.log(`Deezer: optionaler Kompatibilitaetslauf, Calls ${stats.deezer.calls || 0}, Cache ${stats.deezer.cacheHits || 0}`);
  }
  console.log('Discogs-Hard-Checks:');
  console.log(`  geplant: ${(stats.discogs || {}).planned || 0}`);
  console.log(`  externe Calls: ${(stats.discogs || {}).calls || 0}`);
  console.log(`  Cache-Hits: ${(stats.discogs || {}).cacheHits || 0}`);
  console.log(`  uebersprungen: ${(stats.discogs || {}).skips || 0}`);
  console.log('Soft-Discogs-Checks:');
  const soft = stats.softDiscogs || {};
  console.log(`  pending vorher: ${soft.softPendingBefore || 0}`);
  console.log(`  geprueft: ${soft.checked || 0}`);
  console.log(`  freigegeben: ${soft.autoAcceptedSoftChecked || 0}`);
  console.log(`  review nach Discogs: ${soft.reviewNeededAfterDiscogs || 0}`);
  console.log(`  weiterhin pending: ${soft.stillPending || 0}`);
  if (stats.listenBrainz) {
    if (stats.listenBrainz.mode === 'off') {
      console.log('ListenBrainz->MusicBrainz: off');
    } else if (stats.listenBrainz.skippedNoToken > 0 && stats.listenBrainz.checked === 0) {
      console.log('ListenBrainz->MusicBrainz: skipped, no token');
    } else {
      console.log('ListenBrainz->MusicBrainz:');
      console.log(`  Modus: ${stats.listenBrainz.mode || 'off'}`);
      console.log(`  Geprueft: ${stats.listenBrainz.checked || 0}`);
      console.log(`  Schnell bestaetigbar: ${stats.listenBrainz.quicklyConfirmable || 0}`);
      console.log(`  Hilfreiches Alternativjahr: ${stats.listenBrainz.usefulAlternativeYears || 0}`);
      console.log(`  Manuell pruefen: ${stats.listenBrainz.manualReview || 0}`);
      console.log(`  Fehler/Skipped: ${stats.listenBrainz.errorOrSkipped || 0}`);
    }
  }
  console.log(`Laufzeit gesamt: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`Review-CSV geschrieben: ${outputCsv}`);
  console.log(`Analysebericht geschrieben: ${reportPath}`);
  console.log(line);

  void inputs;
}

module.exports = {
  buildAnalysisReport,
  computeSummary,
  listenBrainzReviewLines,
  printSummary,
  statusDistribution,
  writeAnalysisReport,
};
