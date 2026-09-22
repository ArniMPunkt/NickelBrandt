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
  assert.equal(tiles.length, 21, 'Galerie soll 21 Kacheln zeigen (25 Erfolge, 2 Familien zu je 3)');
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
  assert.equal(open.length, 21);
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
  assert.equal(earned.length + open.length, 21, 'keine Kachel darf verloren gehen');
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
