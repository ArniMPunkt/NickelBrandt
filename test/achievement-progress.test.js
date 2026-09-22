'use strict';

/**
 * Guards the achievement DETAIL VIEW's progress readout against the catalog it
 * describes. The progress table in achievementDefinitions.ts repeats each
 * threshold that the corresponding `condition` uses (the conditions themselves
 * are deliberately left untouched), so the one real risk is the two drifting
 * apart - a detail view claiming "6 / 8" while the achievement actually fires
 * at 7 would be worse than showing nothing.
 *
 * Rather than re-implementing the conditions, this runs the REAL ones: the TS
 * module is compiled to CommonJS on the fly. It has no runtime imports of its
 * own (its only import is `import type`, which the compiler erases), so it
 * loads in plain node without React Native or AsyncStorage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SRC = path.join(REPO_ROOT, 'src/services/achievementDefinitions.ts');

function compileDefinitions() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-ach-'));
  // Run tsc's own entry script through this node binary instead of the `npx`
  // wrapper: node refuses to spawn a .cmd without a shell on Windows, and this
  // needs neither a shell nor a PATH lookup.
  execFileSync(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      SRC,
      '--outDir',
      outDir,
      '--module',
      'commonjs',
      '--target',
      'es2020',
      '--skipLibCheck',
      '--moduleResolution',
      'node',
      // The type-only import pulls the service graph in for typechecking
      // (never for emit); without this tsc stops at the first .tsx it meets.
      '--jsx',
      'react-jsx',
    ],
    { cwd: REPO_ROOT, stdio: 'pipe' }
  );
  // tsc mirrors the source tree under outDir.
  return require(path.join(outDir, 'services/achievementDefinitions.js'));
}

let defs;
try {
  defs = compileDefinitions();
} catch (e) {
  // tsc exits non-zero for unrelated files it pulls in via imports while still
  // emitting ours; only a missing emit is a real failure.
  const emitted = e.stdout ? String(e.stdout) : String(e.message);
  throw new Error('achievementDefinitions.ts konnte nicht kompiliert werden:\n' + emitted);
}

const { ACHIEVEMENTS, PROGRESS_TABLE, achievementProgress, buildGalleryTiles, SCOPE_LABEL } = defs;

const ALL_MODES = ['hitster_party', 'hitster_pnp', 'bingo', 'timeline_quiz'];

/** An empty stats object, with ONE progress source dialled to `value`. */
function statsWith(source, value) {
  const stats = {
    gamesPlayed: 0,
    gamesByMode: { hitster_party: 0, hitster_pnp: 0, bingo: 0, timeline_quiz: 0 },
    modesPlayed: [],
    maxParticipantsWon: 0,
    hitster: { maxStreakEver: 0, chipsPeakEver: 0, partyGamesWon: 0 },
    matchHistory: [],
    poolsCleared: [],
    songsReported: 0,
  };
  switch (source) {
    case 'gamesPlayed':
      stats.gamesPlayed = value;
      break;
    case 'maxStreakEver':
      stats.hitster.maxStreakEver = value;
      break;
    case 'chipsPeakEver':
      stats.hitster.chipsPeakEver = value;
      break;
    case 'maxParticipantsWon':
      stats.maxParticipantsWon = value;
      break;
    case 'modesPlayedCount':
      stats.modesPlayed = ALL_MODES.slice(0, Math.max(0, value));
      break;
    case 'songsReported':
      stats.songsReported = value;
      break;
    default:
      throw new Error('unbekannte ProgressSource: ' + source);
  }
  return stats;
}

const byId = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

test('every progress target names an achievement that actually exists', () => {
  for (const id of Object.keys(PROGRESS_TABLE)) {
    assert.ok(byId.has(id), `Fortschritts-Eintrag "${id}" hat keinen Erfolg im Katalog`);
  }
});

test('each condition flips exactly at the target the detail view shows', () => {
  for (const [id, entry] of Object.entries(PROGRESS_TABLE)) {
    const def = byId.get(id);
    assert.equal(
      def.condition(statsWith(entry.source, entry.target)),
      true,
      `"${def.name}" müsste bei ${entry.target} erfüllt sein, ist es aber nicht`
    );
    assert.equal(
      def.condition(statsWith(entry.source, entry.target - 1)),
      false,
      `"${def.name}" ist schon bei ${entry.target - 1} erfüllt - die angezeigte ` +
        `Zielzahl ${entry.target} stimmt nicht mit der Bedingung überein`
    );
  }
});

test('progress reads the current value straight off the stats', () => {
  for (const [id, entry] of Object.entries(PROGRESS_TABLE)) {
    const p = achievementProgress(id, statsWith(entry.source, 3));
    assert.equal(p.current, 3, `${id}: aktueller Stand wird nicht gelesen`);
    assert.equal(p.target, entry.target);
    assert.ok(p.label.length > 0, `${id}: Fortschritt ohne Beschriftung`);
  }
});

test('achievements without a progress entry return null instead of a made-up number', () => {
  const stats = statsWith('gamesPlayed', 0);
  for (const def of ACHIEVEMENTS) {
    if (PROGRESS_TABLE[def.id]) continue;
    assert.equal(
      achievementProgress(def.id, stats),
      null,
      `${def.id} liefert einen Fortschritt, hat aber keinen Tabelleneintrag`
    );
  }
});

test('every achievement carries a description, an icon and a known scope', () => {
  for (const def of ACHIEVEMENTS) {
    assert.ok(def.description.trim().length > 0, `${def.id}: keine Beschreibung`);
    assert.ok(def.icon.trim().length > 0, `${def.id}: kein Icon`);
    assert.ok(SCOPE_LABEL[def.scope], `${def.id}: unbekannter Scope "${def.scope}"`);
  }
});

test('gallery collapses the two families to one tile but keeps all three tiers', () => {
  const tiles = buildGalleryTiles(new Set());
  assert.equal(tiles.length, 27, 'Galerie soll 27 Kacheln zeigen (31 Erfolge, 2 Familien zu je 3)');
  assert.equal(
    tiles.reduce((n, t) => n + t.tiers.length, 0),
    ACHIEVEMENTS.length,
    'über alle Kacheln hinweg muss jeder Erfolg genau einmal vorkommen'
  );
  const families = tiles.filter((t) => t.tiers.length > 1);
  assert.equal(families.length, 2, 'genau zwei zusammengefasste Gruppen erwartet');
  for (const f of families) assert.equal(f.tiers.length, 3);
});

test('nothing unlocked: family tiles show their lowest tier', () => {
  const tiles = buildGalleryTiles(new Set());
  const nickel = tiles.find((t) => t.tiers.some((d) => d.id === 'nickelfarmer'));
  assert.equal(nickel.def.id, 'nickelfarmer');
  assert.deepEqual(
    nickel.tiers.map((d) => d.id),
    ['nickelfarmer', 'nickelmeister', 'nickelgott'],
    'Stufen müssen aufsteigend geliefert werden'
  );
});

test('partly unlocked family: the tile shows the HIGHEST unlocked tier', () => {
  const tiles = buildGalleryTiles(new Set(['nickelfarmer', 'nickelmeister']));
  const nickel = tiles.find((t) => t.tiers.some((d) => d.id === 'nickelfarmer'));
  assert.equal(nickel.def.id, 'nickelmeister');
  // ...and the detail view still gets all three, including the open top tier.
  assert.deepEqual(
    nickel.tiers.map((d) => d.id),
    ['nickelfarmer', 'nickelmeister', 'nickelgott']
  );
});

test('catalog order is preserved, so the "Offen" section keeps it', () => {
  const tiles = buildGalleryTiles(new Set());
  const firstIndexOf = (tile) =>
    ACHIEVEMENTS.findIndex((a) => a.id === tile.tiers[0].id);
  const order = tiles.map(firstIndexOf);
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    'Kachelreihenfolge weicht von der Katalogreihenfolge ab'
  );
});

// --- Galerie-Abschnitte "Errungen" / "Offen" ------------------------------

const { splitGalleryTiles } = defs;

/** Tiles for a given unlock map, the way the Profil tab builds them. */
function gallery(unlockedAt) {
  return splitGalleryTiles(buildGalleryTiles(new Set(Object.keys(unlockedAt))), unlockedAt);
}

test('nothing unlocked: everything sits under "Offen", nothing under "Errungen"', () => {
  const { earned, open } = gallery({});
  assert.equal(earned.length, 0);
  assert.equal(open.length, 27);
});

test('"Errungen" is sorted by unlock date, newest first', () => {
  const unlockedAt = {
    'erste-partie': '2026-01-05T10:00:00.000Z',
    'perfect-hit': '2026-03-20T21:30:00.000Z',
    'sad-bingo': '2026-02-11T18:00:00.000Z',
    'big-lobby-winner': '2026-09-01T12:00:00.000Z',
  };
  const { earned, open } = gallery(unlockedAt);
  assert.deepEqual(
    earned.map((t) => t.def.id),
    ['big-lobby-winner', 'perfect-hit', 'sad-bingo', 'erste-partie']
  );
  assert.equal(earned.length + open.length, 27, 'keine Kachel darf verloren gehen');
  assert.ok(open.every((t) => unlockedAt[t.def.id] == null));
});

test('achievements unlocked in the SAME match keep catalog order among themselves', () => {
  // recordMatchResult stamps everything one match unlocked with one instant.
  const sameInstant = '2026-05-05T20:00:00.000Z';
  const unlockedAt = {
    'perfect-hit': sameInstant,
    'insane-guess': sameInstant,
    'sad-bingo': sameInstant,
    'erste-partie': '2026-01-01T09:00:00.000Z',
  };
  const { earned } = gallery(unlockedAt);
  assert.deepEqual(
    earned.map((t) => t.def.id),
    // The three tied ones first (newer), in catalog order; the older one last.
    ['perfect-hit', 'insane-guess', 'sad-bingo', 'erste-partie']
  );
});

test('"Offen" keeps the catalog order', () => {
  const { open } = gallery({ 'perfect-hit': '2026-01-01T00:00:00.000Z' });
  const catalogIndex = (t) => ACHIEVEMENTS.findIndex((a) => a.id === t.tiers[0].id);
  const order = open.map(catalogIndex);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('half-finished family counts as "Errungen" and sorts by its newest tier', () => {
  const unlockedAt = {
    nickelfarmer: '2026-02-01T10:00:00.000Z',
    nickelmeister: '2026-08-15T10:00:00.000Z', // Nickelgott still open
    'erste-partie': '2026-05-01T10:00:00.000Z',
  };
  const { earned, open } = gallery(unlockedAt);
  assert.deepEqual(
    earned.map((t) => t.def.id),
    ['nickelmeister', 'erste-partie'],
    'die Gruppe muss nach ihrer JÜNGSTEN erreichten Stufe einsortiert werden'
  );
  // The family appears exactly once, and never additionally under "Offen".
  assert.ok(!open.some((t) => t.tiers.some((d) => d.id === 'nickelgott')));
  const family = earned.find((t) => t.tiers.length === 3);
  assert.equal(family.tiers.filter((d) => unlockedAt[d.id] != null).length, 2);
});

test('the Meilenstein family stays under "Offen" until its first tier lands', () => {
  const { earned, open } = gallery({ 'erste-partie': '2026-01-01T00:00:00.000Z' });
  const milestone = open.find((t) => t.tiers.some((d) => d.id === 'partyleiter'));
  assert.ok(milestone, 'Meilenstein-Gruppe muss offen sein');
  assert.equal(milestone.def.id, 'warmgespielt', 'Kachel zeigt die unterste Stufe');
  assert.ok(!earned.some((t) => t.tiers.some((d) => d.id === 'partyleiter')));
});

// --- Neue Erfolge ---------------------------------------------------------
// Alle Bedingungen laufen hier gegen den echten Katalog (siehe oben). Die
// Zeitstempel werden aus LOKALEN Date-Komponenten gebaut und per toISOString()
// nach UTC gedreht - genau der Weg, den recordMatchResult geht -, damit die
// Tests unabhängig von der Zeitzone der Maschine sind.

const emptyStats = () => statsWith('gamesPlayed', 0);

/** ISO-Stempel für einen lokalen Zeitpunkt. */
function localIso(y, m, d, hour, minute = 0) {
  return new Date(y, m - 1, d, hour, minute).toISOString();
}

function quizRecord({ playedAt, correctCount, wrongCount, won = true }) {
  return {
    mode: 'timeline_quiz',
    playedAt,
    won,
    participantCount: 3,
    correctCount,
    wrongCount,
  };
}

function partyRecord({
  playedAt = localIso(2026, 5, 5, 20),
  chipsEnabled = true,
  won = true,
  receivedNickel = false,
  events = [],
  playerId = 'me',
} = {}) {
  return {
    mode: 'hitster_party',
    playedAt,
    participantCount: 4,
    chipsEnabled,
    events,
    players: [
      { playerId, won, finalTimelineYears: [1990], maxStreak: 1, chipsPeak: 2, receivedNickel },
    ],
  };
}

const fires = (id, stats) => byId.get(id).condition(stats);

test('a brand-new profile unlocks nothing at all', () => {
  const stats = emptyStats();
  for (const def of ACHIEVEMENTS) {
    assert.equal(def.condition(stats), false, `${def.id} feuert auf einem leeren Profil`);
  }
});

// --- Nachtschwärmer -------------------------------------------------------

test('Nachtschwärmer: Partie zwischen 0 und 5 Uhr lokaler Zeit', () => {
  for (const hour of [0, 1, 3, 4]) {
    const stats = emptyStats();
    stats.matchHistory = [quizRecord({ playedAt: localIso(2026, 3, 7, hour, 30), correctCount: 1, wrongCount: 1 })];
    assert.equal(fires('nachtschwaermer', stats), true, `${hour} Uhr müsste zählen`);
  }
});

test('Nachtschwärmer: 5 Uhr und später zählt nicht mehr', () => {
  for (const hour of [5, 6, 12, 19, 23]) {
    const stats = emptyStats();
    stats.matchHistory = [quizRecord({ playedAt: localIso(2026, 3, 7, hour, 0), correctCount: 1, wrongCount: 1 })];
    assert.equal(fires('nachtschwaermer', stats), false, `${hour} Uhr darf nicht zählen`);
  }
});

test('Nachtschwärmer: kaputter Zeitstempel wird ignoriert statt zu werfen', () => {
  const stats = emptyStats();
  stats.matchHistory = [quizRecord({ playedAt: 'keine-zeit', correctCount: 1, wrongCount: 1 })];
  assert.equal(fires('nachtschwaermer', stats), false);
  assert.equal(fires('vielspieler-abend', stats), false);
});

// --- Vielspieler-Abend ----------------------------------------------------

test('Vielspieler-Abend: 5 Partien am selben lokalen Tag', () => {
  const stats = emptyStats();
  stats.matchHistory = [10, 12, 14, 16, 18].map((h) =>
    quizRecord({ playedAt: localIso(2026, 6, 13, h), correctCount: 1, wrongCount: 1 })
  );
  assert.equal(fires('vielspieler-abend', stats), true);
});

test('Vielspieler-Abend: 4 an einem Tag reichen nicht', () => {
  const stats = emptyStats();
  stats.matchHistory = [10, 12, 14, 16].map((h) =>
    quizRecord({ playedAt: localIso(2026, 6, 13, h), correctCount: 1, wrongCount: 1 })
  );
  assert.equal(fires('vielspieler-abend', stats), false);
});

test('Vielspieler-Abend: über mehrere Tage verteilt zählt nicht', () => {
  const stats = emptyStats();
  stats.matchHistory = [11, 12, 13, 14, 15].map((day) =>
    quizRecord({ playedAt: localIso(2026, 6, day, 20), correctCount: 1, wrongCount: 1 })
  );
  assert.equal(fires('vielspieler-abend', stats), false);
});

test('Vielspieler-Abend: über Mitternacht hinweg sind es zwei Tage', () => {
  const stats = emptyStats();
  stats.matchHistory = [
    ...[20, 21, 22].map((h) => quizRecord({ playedAt: localIso(2026, 6, 13, h), correctCount: 1, wrongCount: 1 })),
    ...[0, 1].map((h) => quizRecord({ playedAt: localIso(2026, 6, 14, h), correctCount: 1, wrongCount: 1 })),
  ];
  assert.equal(fires('vielspieler-abend', stats), false, '3 + 2 an zwei Tagen sind keine 5 an einem');
});

// --- Diszipliniert --------------------------------------------------------

test('Diszipliniert: Party-Sieg mit Nickeln an, ohne Nickel und ohne Klau', () => {
  const stats = emptyStats();
  stats.matchHistory = [partyRecord()];
  assert.equal(fires('diszipliniert', stats), true);
});

test('Diszipliniert: nicht, wenn das Nickel-System ausgeschaltet war', () => {
  const stats = emptyStats();
  stats.matchHistory = [partyRecord({ chipsEnabled: false })];
  assert.equal(fires('diszipliniert', stats), false);
});

test('Diszipliniert: nicht, wenn die Partie nicht gewonnen wurde', () => {
  const stats = emptyStats();
  stats.matchHistory = [partyRecord({ won: false })];
  assert.equal(fires('diszipliniert', stats), false);
});

test('Diszipliniert: nicht, wenn selbst ein Nickel kassiert wurde', () => {
  const stats = emptyStats();
  stats.matchHistory = [partyRecord({ receivedNickel: true })];
  assert.equal(fires('diszipliniert', stats), false);
});

test('Diszipliniert: nicht bei einem eigenen erfolgreichen Klau', () => {
  const stats = emptyStats();
  stats.matchHistory = [
    partyRecord({
      events: [
        { type: 'steal', playerId: 'me', correct: true, year: 1990, leftYear: null, rightYear: null },
      ],
    }),
  ];
  assert.equal(fires('diszipliniert', stats), false);
});

test('Diszipliniert: ein GESCHEITERTER eigener Klau ist erlaubt', () => {
  const stats = emptyStats();
  stats.matchHistory = [
    partyRecord({
      events: [
        { type: 'steal', playerId: 'me', correct: false, year: 1990, leftYear: null, rightYear: null },
      ],
    }),
  ];
  assert.equal(fires('diszipliniert', stats), true);
});

test('Diszipliniert: der Klau eines ANDEREN Spielers stört nicht', () => {
  const stats = emptyStats();
  stats.matchHistory = [
    partyRecord({
      events: [
        { type: 'steal', playerId: 'jemand-anders', correct: true, year: 1990, leftYear: null, rightYear: null },
      ],
    }),
  ];
  assert.equal(fires('diszipliniert', stats), true);
});

test('Diszipliniert: Pass & Play zählt nicht (kein eindeutiges "ich")', () => {
  const stats = emptyStats();
  const rec = partyRecord();
  rec.mode = 'hitster_pnp';
  stats.matchHistory = [rec];
  assert.equal(fires('diszipliniert', stats), false);
});

test('Diszipliniert: Altbestand ohne die neuen Felder zählt nicht als Beweis', () => {
  const stats = emptyStats();
  const rec = partyRecord();
  delete rec.chipsEnabled;
  delete rec.players[0].receivedNickel;
  stats.matchHistory = [rec];
  assert.equal(fires('diszipliniert', stats), false);
});

// --- Poolversenker --------------------------------------------------------

test('Poolversenker: ein durchgespielter Pool genügt', () => {
  const stats = emptyStats();
  stats.poolsCleared = ['pool-a'];
  assert.equal(fires('poolversenker', stats), true);
});

test('Poolversenker: Profil ohne das Feld (Altbestand) wirft nicht', () => {
  const stats = emptyStats();
  delete stats.poolsCleared;
  assert.equal(fires('poolversenker', stats), false);
});

// --- Punktlandung Marathon ------------------------------------------------

test('Punktlandung Marathon: fehlerfrei über die Schwelle', () => {
  const stats = emptyStats();
  stats.matchHistory = [
    quizRecord({ playedAt: localIso(2026, 7, 1, 20), correctCount: 20, wrongCount: 0 }),
  ];
  assert.equal(fires('punktlandung-marathon', stats), true);
  assert.equal(fires('perfect-timeline', stats), true, 'die leichtere Stufe muss mitgehen');
});

test('Punktlandung Marathon: eine Runde zu wenig reicht nicht', () => {
  const stats = emptyStats();
  stats.matchHistory = [
    quizRecord({ playedAt: localIso(2026, 7, 1, 20), correctCount: 19, wrongCount: 0 }),
  ];
  assert.equal(fires('punktlandung-marathon', stats), false);
  assert.equal(fires('perfect-timeline', stats), true, 'Perfect Timeline bleibt davon unberührt');
});

test('Punktlandung Marathon: ein einziger Fehler kippt es', () => {
  const stats = emptyStats();
  stats.matchHistory = [
    quizRecord({ playedAt: localIso(2026, 7, 1, 20), correctCount: 25, wrongCount: 1 }),
  ];
  assert.equal(fires('punktlandung-marathon', stats), false);
});

test('Punktlandung Marathon bleibt innerhalb der Lobby-Grenzen erreichbar', () => {
  // Der Kartenzahl-Slider der Lobby geht bis 30 - eine Schwelle darüber wäre
  // in keiner einstellbaren Partie zu schaffen.
  const lobby = io_readLobbyMax();
  const threshold = Number(
    require('node:fs')
      .readFileSync(path.join(REPO_ROOT, 'src/services/achievementDefinitions.ts'), 'utf8')
      .match(/QUIZ_MARATHON_ROUNDS = (\d+)/)[1]
  );
  assert.ok(threshold <= lobby, `Schwelle ${threshold} liegt über dem Maximum ${lobby} der Lobby`);
  assert.ok(threshold > 15, `Schwelle ${threshold} liegt nicht über einer Standardpartie (15)`);
});

/** Das Maximum des Kartenzahl-Sliders, direkt aus dem Lobby-Screen gelesen. */
function io_readLobbyMax() {
  const src = require('node:fs').readFileSync(
    path.join(REPO_ROOT, 'src/screens/LobbyScreen.tsx'),
    'utf8'
  );
  // <StepSlider value={quizCards} min={5} max={30} .../>
  const m = src.match(/value=\{quizCards\}[\s\S]*?max=\{(\d+)\}/);
  assert.ok(m, 'Kartenzahl-Slider im LobbyScreen nicht gefunden');
  return Number(m[1]);
}

// --- Regression -----------------------------------------------------------

test('die neuen Erfolge lassen die bestehenden unberührt', () => {
  // Ein Profil, das die neuen Bedingungen erfüllt, darf keinen alten Erfolg
  // NEBENBEI mit auslösen. Genau eine Ausnahme ist fachlich zwingend:
  // "Perfect Timeline" (fehlerfreie Partie) ist die schwächere Stufe von
  // "Punktlandung Marathon" (fehlerfrei über >= 20 Runden) - wer das eine
  // erfüllt, erfüllt das andere zwangsläufig mit. Die Liste unten ist
  // deshalb 5 neue + 1 alter, und der alte ist namentlich genannt.
  const stats = emptyStats();
  stats.poolsCleared = ['pool-a'];
  stats.matchHistory = [
    partyRecord({ playedAt: localIso(2026, 8, 2, 2) }),
    ...[10, 12, 14, 16].map((h) =>
      quizRecord({ playedAt: localIso(2026, 8, 2, h), correctCount: 20, wrongCount: 0 })
    ),
  ];
  const firing = ACHIEVEMENTS.filter((d) => d.condition(stats)).map((d) => d.id).sort();
  assert.deepEqual(firing, [
    'diszipliniert',
    'nachtschwaermer',
    'perfect-timeline',
    'poolversenker',
    'punktlandung-marathon',
    'vielspieler-abend',
  ]);
});

test('jeder neue Erfolg taucht genau einmal als eigene Kachel auf', () => {
  const tiles = buildGalleryTiles(new Set());
  for (const id of [
    'nachtschwaermer',
    'vielspieler-abend',
    'diszipliniert',
    'poolversenker',
    'punktlandung-marathon',
    'ehrenmann',
  ]) {
    const hits = tiles.filter((t) => t.tiers.some((d) => d.id === id));
    assert.equal(hits.length, 1, `${id} erscheint ${hits.length}x statt 1x`);
    assert.equal(hits[0].tiers.length, 1, `${id} darf nicht in eine Gruppe geraten`);
  }
});

// --- Ehrenmann/-frau (geräteweiter Melde-Zähler) --------------------------

test('Ehrenmann: Schwelle erreicht', () => {
  const threshold = PROGRESS_TABLE['ehrenmann'].target;
  const stats = emptyStats();
  stats.songsReported = threshold;
  assert.equal(fires('ehrenmann', stats), true);
});

test('Ehrenmann: eine Meldung unter der Schwelle reicht nicht', () => {
  const threshold = PROGRESS_TABLE['ehrenmann'].target;
  const stats = emptyStats();
  stats.songsReported = threshold - 1;
  assert.equal(fires('ehrenmann', stats), false);
});

test('Ehrenmann: mehr als die Schwelle bleibt erfüllt', () => {
  const stats = emptyStats();
  stats.songsReported = PROGRESS_TABLE['ehrenmann'].target + 40;
  assert.equal(fires('ehrenmann', stats), true);
});

test('Ehrenmann: Altbestand ohne das Feld zählt als 0 und wirft nicht', () => {
  const stats = emptyStats();
  delete stats.songsReported;
  assert.equal(fires('ehrenmann', stats), false);
  assert.equal(achievementProgress('ehrenmann', stats).current, 0);
});

test('Ehrenmann: Fortschritt zeigt den echten Zählerstand', () => {
  const stats = emptyStats();
  stats.songsReported = 3;
  const p = achievementProgress('ehrenmann', stats);
  assert.equal(p.current, 3);
  assert.equal(p.target, PROGRESS_TABLE['ehrenmann'].target);
});

test('Ehrenmann: Beschreibung nennt das Gerät, nicht die Person', () => {
  const def = byId.get('ehrenmann');
  assert.match(def.description, /diesem Gerät/, 'Text muss geräteweit formuliert sein');
  assert.doesNotMatch(def.description, /\bdu\b|\bdeine\b/i, 'kein personenbezogenes "du"');
});

test('Ehrenmann hängt an keiner Partie - Spielstatistik bleibt unberührt', () => {
  const stats = emptyStats();
  stats.songsReported = 99;
  const firing = ACHIEVEMENTS.filter((d) => d.condition(stats)).map((d) => d.id);
  assert.deepEqual(firing, ['ehrenmann'], 'Melden allein darf sonst nichts freischalten');
});

// --- Vollbild-Einblendung -------------------------------------------------

test('Punktlandung Marathon gehört zu den besonderen Erfolgen', () => {
  assert.ok(
    defs.SPECIAL_ACHIEVEMENT_IDS.has('punktlandung-marathon'),
    'fehlt in SPECIAL_ACHIEVEMENT_IDS'
  );
});

test('allein freigeschaltet bekommt Punktlandung Marathon das Vollbild', () => {
  const marathon = byId.get('punktlandung-marathon');
  assert.equal(defs.pickSpecialAchievement([marathon], 12).id, 'punktlandung-marathon');
});

test('zusammen mit Perfect Timeline gewinnt die Katalogreihenfolge', () => {
  // Dokumentiert das tatsächliche Verhalten: pickSpecialAchievement nimmt den
  // ERSTEN Treffer in Katalogreihenfolge, und Perfect Timeline steht davor.
  // Betrifft nur den seltenen Fall, dass beide in DERSELBEN Partie fallen.
  const both = ['perfect-timeline', 'punktlandung-marathon'].map((id) => byId.get(id));
  assert.equal(defs.pickSpecialAchievement(both, 12).id, 'perfect-timeline');
});

test('jeder besondere Erfolg existiert auch wirklich im Katalog', () => {
  for (const id of defs.SPECIAL_ACHIEVEMENT_IDS) {
    assert.ok(byId.has(id), `SPECIAL_ACHIEVEMENT_IDS nennt unbekannte id "${id}"`);
  }
});
