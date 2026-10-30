'use strict';

/**
 * Guards the configurable Feldwahl-Zeit (mode_config.bingoPickSeconds): missing
 * values must behave like the old fixed 10s, and the configured value must reach
 * both the deadline and the nextBingoRound gate.
 *
 * Runs the REAL helpers: game/bingo.ts is compiled to CommonJS on the fly (its
 * only runtime import is the equally pure game/cards.ts). supabase.ts itself
 * needs React Native, so its wiring is checked on the source text below.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SRC = path.join(REPO_ROOT, 'src/game/bingo.ts');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-bingo-'));
test.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

// Same direct tsc invocation as achievement-progress.test.js (no .cmd wrapper).
execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    SRC,
    '--outDir',
    outDir,
    '--rootDir',
    path.join(REPO_ROOT, 'src'),
    '--module',
    'commonjs',
    '--target',
    'es2020',
    '--skipLibCheck',
    '--moduleResolution',
    'node',
    '--jsx',
    'react-jsx',
  ],
  { cwd: REPO_ROOT, stdio: 'pipe' }
);
const bingo = require(path.join(outDir, 'game/bingo.js'));

const NOW = 1_000_000;

test('fehlender Wert bedeutet 10 s', () => {
  assert.equal(bingo.BINGO_PICK_SECONDS, 10);
  for (const config of [undefined, null, {}, { bingoPickSeconds: undefined }, { bingoPickSeconds: null }]) {
    assert.equal(bingo.bingoPickSeconds(config), 10);
    assert.equal(bingo.bingoPickDeadline(NOW, config), NOW + 10_000);
  }
});

test('10/15/20 s wirken auf die Deadline', () => {
  for (const seconds of [10, 15, 20]) {
    const config = { bingoPickSeconds: seconds };
    assert.equal(bingo.bingoPickSeconds(config), seconds);
    assert.equal(bingo.bingoPickDeadline(NOW, config), NOW + seconds * 1000);
  }
});

test('der Slider erreicht mit seiner Schrittweite genau 10/15/20', () => {
  const { BINGO_PICK_SECONDS_MIN: min, BINGO_PICK_SECONDS_MAX: max, BINGO_PICK_SECONDS_STEP: step } = bingo;
  const stops = [];
  for (let v = min; v <= max; v += step) stops.push(v);
  assert.deepEqual(stops, [10, 15, 20]);
  assert.equal((max - min) % step, 0);
});

test('Guard hält die Runde bis zur konfigurierten Deadline, nicht länger', () => {
  for (const seconds of [10, 15, 20]) {
    const deadline = bingo.bingoPickDeadline(NOW, { bingoPickSeconds: seconds });
    assert.equal(bingo.bingoPickWindowHoldsRound(false, deadline, deadline - 1), true);
    assert.equal(bingo.bingoPickWindowHoldsRound(false, deadline, deadline), false);
    assert.equal(bingo.bingoPickWindowHoldsRound(false, deadline, deadline + 1), false);
  }
});

test('Guard lässt 20-s-Fenster nach 10 s noch nicht durch', () => {
  const deadline = bingo.bingoPickDeadline(NOW, { bingoPickSeconds: 20 });
  assert.equal(bingo.bingoPickWindowHoldsRound(false, deadline, NOW + 10_000), true);
});

test('Guard: alle haben gewählt oder keine Deadline gesetzt -> Runde läuft weiter', () => {
  const deadline = bingo.bingoPickDeadline(NOW, { bingoPickSeconds: 20 });
  assert.equal(bingo.bingoPickWindowHoldsRound(true, deadline, NOW), false);
  assert.equal(bingo.bingoPickWindowHoldsRound(false, null, NOW), false);
  assert.equal(bingo.bingoPickWindowHoldsRound(false, undefined, NOW), false);
});

test('supabase.ts rechnet die Feldwahl-Zeit nur über die Helfer', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src/services/supabase.ts'), 'utf8');
  assert.doesNotMatch(src, /BINGO_PICK_SECONDS/);
  assert.match(src, /pickDeadline: bingoPickDeadline\(serverNow\(\), gs\.modeConfig\)/);
  assert.match(src, /bingoPickWindowHoldsRound\(allPicked, gs\.pickDeadline, serverNow\(\)\)/);
  // The game_state snapshot at start must carry the value (the whitelist there
  // would silently drop it otherwise, and every round would fall back to 10 s).
  assert.match(src, /bingoPickSeconds: config\.bingoPickSeconds/);
});
