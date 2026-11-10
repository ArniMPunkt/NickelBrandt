'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../scripts/lib/release/helpers');
const { applyReleaseSigning } = require('../plugins/withAndroidReleaseSigning');

const FP = '70:3C:D0:C1:F1:B5:CE:43:AA:CE:F1:A6:EC:73:53:27:F7:64:57:15:6C:43:54:04:83:76:95:3E:3A:7F:B7:3B';

// --- switches ---------------------------------------------------------------

test('Schalter: Plattform aus process.platform', () => {
  assert.equal(h.releaseTarget('win32'), 'android');
  assert.equal(h.releaseTarget('darwin'), 'ios');
  assert.equal(h.releaseTarget('linux'), null);
});

test('Schalter: gültige Kombinationen je Plattform', () => {
  const win = h.parseArgs(['--aab-only', '--skip-prebuild', '--force'], 'win32');
  assert.deepEqual(win.errors, []);
  assert.deepEqual(win.options, { check: false, force: true, aabOnly: true, skipPrebuild: true, noSubmit: false });

  const mac = h.parseArgs(['--no-submit', '--check'], 'darwin');
  assert.deepEqual(mac.errors, []);
  assert.equal(mac.options.noSubmit, true);
  assert.equal(mac.options.check, true);
});

test('Schalter: unbekannte und plattformfremde führen zu Fehlern', () => {
  assert.equal(h.parseArgs(['--aab'], 'win32').errors.length, 1);
  assert.equal(h.parseArgs(['--no-submit'], 'win32').errors.length, 1);
  assert.equal(h.parseArgs(['--aab-only', '--skip-prebuild'], 'darwin').errors.length, 2);
  assert.equal(h.parseArgs(['aab-only'], 'win32').errors.length, 1);
});

// --- versions ---------------------------------------------------------------

test('Versionsvergleich numerisch, nicht als String', () => {
  assert.ok(h.compareVersions('1.1.10', '1.1.9') > 0);
  assert.ok(h.compareVersions('20.19.4', '20.19.10') < 0);
  assert.equal(h.compareVersions('v24.15.0', '24.15.0'), 0);
  assert.ok(h.meetsMinimum('v24.15.0', '20.19.4'));
  assert.ok(h.meetsMinimum('v20.19.4', '>= 20.19.4'));
  assert.ok(!h.meetsMinimum('v20.19.3', '20.19.4'));
  assert.ok(!h.meetsMinimum('v18.20.0', '20.19.4'));
});

test('Java-Version aus java -version', () => {
  assert.equal(h.parseJavaMajor('openjdk version "17.0.20" 2025-07-15'), 17);
  assert.equal(h.parseJavaMajor('java version "1.8.0_451"'), 8);
  assert.equal(h.parseJavaMajor('openjdk version "21" 2023-09-19'), 21);
  assert.equal(h.parseJavaMajor('nichts'), null);
});

test('Neueste build-tools', () => {
  assert.equal(h.latestVersionDir(['35.0.0', '36.0.0', '34.0.0']), '36.0.0');
  assert.equal(h.latestVersionDir(['9.0.0', '10.0.0']), '10.0.0');
  assert.equal(h.latestVersionDir([]), null);
});

test('Versionen aus android/app/build.gradle', () => {
  const gradle = 'defaultConfig {\n        versionCode 14\n        versionName "1.1.6"\n    }';
  assert.deepEqual(h.parseGradleVersions(gradle), { versionCode: 14, versionName: '1.1.6' });
  assert.deepEqual(h.parseGradleVersions('nichts'), { versionCode: null, versionName: null });
});

test('Duplikat-Erkennung über .last-build.json', () => {
  const last = { version: '1.1.8', build: '16', builtAt: '2026-11-10T10:00:00Z' };
  assert.ok(h.isSameBuild(last, '1.1.8', 16));
  assert.ok(!h.isSameBuild(last, '1.1.8', 17));
  assert.ok(!h.isSameBuild(last, '1.1.9', 16));
  assert.ok(!h.isSameBuild(undefined, '1.1.8', 16));
});

test('Dateiname enthält Version und Build', () => {
  assert.equal(h.artifactFileName('NickelBrandt', '1.1.8', '16', 'aab'), 'NickelBrandt-1.1.8-16.aab');
});

// --- fingerprints ---------------------------------------------------------

test('Fingerabdruck: Schreibweisen werden gleich behandelt', () => {
  const plain = FP.replace(/:/g, '').toLowerCase();
  assert.ok(h.fingerprintsMatch(FP, plain));
  assert.equal(h.formatFingerprint(plain), FP);
  assert.ok(!h.fingerprintsMatch(FP, FP.replace('70:3C', '70:3D')));
  assert.ok(!h.fingerprintsMatch('', ''));
  assert.equal(h.normalizeFingerprint('70:3C'), null);
});

test('Fingerabdruck aus keytool (deutsch und englisch)', () => {
  const de = `Signaturgeber #1:\n\nZertifikat #1:\nEigentümer: CN=X\nZertifikatsfingerprints:\n\t SHA1: AA:BB\n\t SHA256: ${FP}\n`;
  const en = `Signer #1:\n\nCertificate #1:\nCertificate fingerprints:\n\t SHA-256: ${FP}\n`;
  assert.deepEqual(h.parseKeytoolFingerprints(de), [FP.replace(/:/g, '')]);
  assert.deepEqual(h.parseKeytoolFingerprints(en), [FP.replace(/:/g, '')]);
  assert.deepEqual(h.parseKeytoolFingerprints('Keine signierte JAR-Datei'), []);
});

test('Fingerabdruck aus apksigner', () => {
  const out =
    'Verified using v2 scheme (APK Signature Scheme v2): true\nNumber of signers: 1\n' +
    `Signer #1 certificate SHA-256 digest: ${FP.replace(/:/g, '').toLowerCase()}\n` +
    'Signer #1 public key SHA-256 digest: 2c84e8697fb96c895e01816914544ec2403721a2b9db389b2c27bec4626a7cc9\n';
  const found = h.parseApksignerFingerprints(out);
  assert.equal(found.length, 1);
  assert.ok(h.fingerprintsMatch(found[0], FP));
});

// --- env files + git -------------------------------------------------------

test('.env.signing.local: Regeln wie das alte PowerShell-Skript', () => {
  const { values, invalidLines } = h.parseDotEnv(
    '# Kommentar\n\nexport A=1\nB="zwei"\nC=\'drei\'\nkaputt\nD=\n'
  );
  assert.deepEqual(values, { A: '1', B: 'zwei', C: 'drei', D: '' });
  assert.deepEqual(invalidLines, [6]);
  assert.deepEqual(h.missingNames(['A', 'D', 'E'], values), ['D', 'E']);
});

test('Git: sauber und gleich Remote -> keine Probleme', () => {
  const base = { fetchOk: true, dirtyCount: 0, branch: 'main', expectedBranch: 'main', head: 'abc1234', remoteHead: 'abc1234', remoteRef: 'origin/main' };
  assert.deepEqual(h.gitProblems(base), []);
  assert.equal(h.gitProblems({ ...base, dirtyCount: 2 }).length, 1);
  assert.equal(h.gitProblems({ ...base, branch: 'feature' }).length, 1);
  assert.equal(h.gitProblems({ ...base, remoteHead: 'def5678' }).length, 1);
  assert.equal(h.gitProblems({ ...base, fetchOk: false }).length, 1);
  assert.equal(h.gitProblems({ ...base, dirtyCount: 1, branch: 'x', fetchOk: false }).length, 3);
});

test('Dauer lesbar', () => {
  assert.equal(h.formatDuration(42_000), '42 s');
  assert.equal(h.formatDuration(185_000), '3 min 05 s');
});

// --- Android signing plugin ------------------------------------------------

const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
}
`;

test('Signing-Plugin: Release signiert mit eigenem Schlüssel, Debug unverändert', () => {
  const out = applyReleaseSigning(TEMPLATE);
  assert.match(out, /release \{\n\s+signingConfig signingConfigs\.release/);
  assert.match(out, /debug \{\n\s+signingConfig signingConfigs\.debug/);
  assert.match(out, /storePassword System\.getenv\('NICKELBRANDT_KEYSTORE_PASSWORD'\)/);
});

test('Signing-Plugin: Release-Guard bricht nur bei Release-Tasks ab, idempotent', () => {
  const out = applyReleaseSigning(TEMPLATE);
  assert.match(out, /gradle\.taskGraph\.whenReady/);
  assert.match(out, /it\.name\.contains\('Release'\) \}\) return/);
  assert.match(out, /throw new GradleException/);
  for (const v of ['NICKELBRANDT_KEYSTORE_PASSWORD', 'NICKELBRANDT_KEY_ALIAS', 'NICKELBRANDT_KEY_PASSWORD']) {
    assert.match(out, new RegExp(`'${v}'`));
  }
  assert.match(out, /\$\{missing\.join\(', '\)\}/);
  assert.equal(applyReleaseSigning(out), out);
});
