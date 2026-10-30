'use strict';

/**
 * Guards the Bingo autoscroll decision (game/scrollReveal.ts): regular screens
 * must not move at all, small ones just far enough. Runs the REAL function,
 * compiled to CommonJS on the fly like achievement-progress.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-scroll-'));
test.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    path.join(REPO_ROOT, 'src/game/scrollReveal.ts'),
    '--outDir',
    outDir,
    '--module',
    'commonjs',
    '--target',
    'es2020',
  ],
  { cwd: REPO_ROOT, stdio: 'pipe' }
);
const { revealScrollTarget } = require(path.join(outDir, 'scrollReveal.js'));

const MARGIN = 12;

function viewport(overrides = {}) {
  return { scrollY: 0, height: 600, contentHeight: 1600, topInset: 40, bottomInset: 0, ...overrides };
}

test('Grid komplett sichtbar: kein Scroll', () => {
  const target = { y: 200, height: 300 };
  assert.equal(revealScrollTarget({ target, keepVisible: { y: 100, height: 40 }, viewport: viewport() }), null);
});

test('Grid exakt bündig am Rand zählt als sichtbar', () => {
  assert.equal(revealScrollTarget({ target: { y: 40, height: 560 }, viewport: viewport() }), null);
});

test('Grid sichtbar, Countdown außerhalb: trotzdem kein Scroll', () => {
  const v = viewport({ scrollY: 300 });
  assert.equal(revealScrollTarget({ target: { y: 400, height: 300 }, keepVisible: { y: 100, height: 40 }, viewport: v }), null);
});

test('Grid unten teilweise verdeckt: minimal scrollen, nicht ans Seitenende', () => {
  const y = revealScrollTarget({
    target: { y: 500, height: 300 },
    keepVisible: { y: 420, height: 40 },
    viewport: viewport(),
  });
  assert.equal(y, 800 - 600 + MARGIN);
  assert.ok(y < 1600 - 600);
});

test('Grid komplett unterhalb: Countdown bleibt nach dem Scrollen im Bild', () => {
  const countdown = { y: 700, height: 40 };
  const y = revealScrollTarget({ target: { y: 900, height: 300 }, keepVisible: countdown, viewport: viewport() });
  assert.equal(y, 1200 - 600 + MARGIN);
  assert.ok(countdown.y >= y + 40, 'Countdown unter der Statusleiste');
});

test('Spanne passt knapp: Rand drückt den Countdown nicht unter die Statusleiste', () => {
  // Span 560 = exactly the visible height; the margin must give way.
  const y = revealScrollTarget({
    target: { y: 760, height: 300 },
    keepVisible: { y: 500, height: 40 },
    viewport: viewport(),
  });
  assert.equal(y, 460);
});

test('Grid höher als der sichtbare Bereich: Countdown oben, Grid direkt darunter', () => {
  const countdown = { y: 500, height: 40 };
  const target = { y: 600, height: 900 };
  const y = revealScrollTarget({ target, keepVisible: countdown, viewport: viewport() });
  assert.equal(y, 500 - 40 - MARGIN);
  assert.ok(target.y > countdown.y + countdown.height);
});

test('Grid plus Countdown passen nicht zusammen: Countdown hat Vorrang', () => {
  const countdown = { y: 200, height: 40 };
  const y = revealScrollTarget({ target: { y: 450, height: 500 }, keepVisible: countdown, viewport: viewport() });
  assert.equal(y, 200 - 40 - MARGIN);
});

test('Grid oberhalb (Spieler ist vorbeigescrollt): minimal zurück, Countdown einrechnen', () => {
  const y = revealScrollTarget({
    target: { y: 300, height: 200 },
    keepVisible: { y: 240, height: 40 },
    viewport: viewport({ scrollY: 500 }),
  });
  assert.equal(y, 240 - 40 - MARGIN);
});

test('Tastatur verkleinert den sichtbaren Bereich', () => {
  const target = { y: 300, height: 200 };
  assert.equal(revealScrollTarget({ target, viewport: viewport() }), null);
  assert.equal(revealScrollTarget({ target, viewport: viewport({ bottomInset: 250 }) }), 500 - 350 + MARGIN);
});

test('Ziel wird auf den gültigen Scroll-Bereich begrenzt', () => {
  const end = viewport({ contentHeight: 800 });
  assert.equal(revealScrollTarget({ target: { y: 500, height: 299 }, viewport: end }), 200);
  assert.equal(
    revealScrollTarget({ target: { y: 20, height: 100 }, viewport: viewport({ scrollY: 300 }) }),
    0
  );
});

test('Kein Scroll, wenn das begrenzte Ziel der aktuellen Position entspricht', () => {
  const atEnd = viewport({ scrollY: 200, contentHeight: 800 });
  assert.equal(revealScrollTarget({ target: { y: 700, height: 200 }, viewport: atEnd }), null);
});

test('Antwortbereich ohne Countdown (Rückkehr zur nächsten Runde)', () => {
  const v = viewport({ scrollY: 400 });
  assert.equal(revealScrollTarget({ target: { y: 80, height: 300 }, viewport: v }), 80 - 40 - MARGIN);
  assert.equal(revealScrollTarget({ target: { y: 80, height: 300 }, viewport: viewport() }), null);
});
