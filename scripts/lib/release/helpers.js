'use strict';

/**
 * Pure helpers for scripts/release.js (no IO, no child processes), so the
 * decisions that gate a release - switches, versions, fingerprints, git state -
 * are covered by test/release-helpers.test.js.
 */

/** Switch -> the platform it is valid on ('all' = both). */
const FLAGS = {
  '--check': 'all',
  '--force': 'all',
  '--aab-only': 'win32',
  '--skip-prebuild': 'win32',
  '--no-submit': 'darwin',
};

const PLATFORM_LABEL = { win32: 'Windows', darwin: 'macOS' };

/** win32 -> android, darwin -> ios, anything else -> null (not a release machine). */
function releaseTarget(platform) {
  if (platform === 'win32') return 'android';
  if (platform === 'darwin') return 'ios';
  return null;
}

/** Unknown switches and switches for the other platform are errors, never ignored. */
function parseArgs(argv, platform) {
  const options = { check: false, force: false, aabOnly: false, skipPrebuild: false, noSubmit: false };
  const errors = [];
  for (const arg of argv) {
    const scope = FLAGS[arg];
    if (!scope) {
      errors.push(`Unbekannter Schalter: ${arg} (erlaubt: ${Object.keys(FLAGS).join(', ')})`);
      continue;
    }
    if (scope !== 'all' && scope !== platform) {
      errors.push(`${arg} gilt nur unter ${PLATFORM_LABEL[scope]}.`);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    options[key] = true;
  }
  return { options, errors };
}

/** "v24.15.0" / ">= 20.19.4" / "20.19" -> [24, 15, 0]; null if no number at all. */
function parseVersion(text) {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(text ?? ''));
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** Numeric compare of dotted versions: <0, 0, >0. Unparsable sorts lowest. */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function meetsMinimum(actual, minimum) {
  return parseVersion(actual) != null && compareVersions(actual, minimum) >= 0;
}

/** Major version from `java -version` output ("1.8.0_x" -> 8, "17.0.20" -> 17). */
function parseJavaMajor(output) {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(String(output ?? ''));
  if (!m) return null;
  const first = Number(m[1]);
  return first === 1 && m[2] != null ? Number(m[2]) : first;
}

/** Highest build-tools version directory name, e.g. ["35.0.0", "36.0.0"] -> "36.0.0". */
function latestVersionDir(names) {
  return [...names].filter((n) => parseVersion(n)).sort(compareVersions).pop() ?? null;
}

/** "70:3c:..." / "703C..." -> "703C..." (64 hex chars), or null if not a SHA-256. */
function normalizeFingerprint(text) {
  const hex = String(text ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex.length === 64 ? hex : null;
}

function fingerprintsMatch(a, b) {
  const na = normalizeFingerprint(a);
  return na != null && na === normalizeFingerprint(b);
}

/** "703C..." -> "70:3C:..." (the keytool/Play Console spelling). */
function formatFingerprint(text) {
  const hex = normalizeFingerprint(text);
  return hex ? hex.match(/../g).join(':') : String(text);
}

/** Every certificate SHA-256 in `keytool -printcert -jarfile` output (any locale). */
function parseKeytoolFingerprints(output) {
  const found = [];
  for (const m of String(output ?? '').matchAll(/SHA-?256:\s*([0-9A-Fa-f:]{95})/g)) {
    found.push(normalizeFingerprint(m[1]));
  }
  return [...new Set(found)];
}

/** Signer certificate SHA-256s from `apksigner verify --print-certs` output. */
function parseApksignerFingerprints(output) {
  const found = [];
  for (const m of String(output ?? '').matchAll(/certificate SHA-256 digest:\s*([0-9a-fA-F]{64})/g)) {
    found.push(normalizeFingerprint(m[1]));
  }
  return [...new Set(found)];
}

/** versionCode / versionName from a generated android/app/build.gradle. */
function parseGradleVersions(buildGradle) {
  const code = /^\s*versionCode\s+(\d+)\s*$/m.exec(buildGradle);
  const name = /^\s*versionName\s+["']([^"']+)["']\s*$/m.exec(buildGradle);
  return { versionCode: code ? Number(code[1]) : null, versionName: name ? name[1] : null };
}

/**
 * KEY=value file (same rules as the old build-android-release.ps1: blank lines
 * and # comments skipped, optional `export `, one pair of surrounding quotes
 * stripped). Invalid lines are reported by NUMBER only - a malformed line may
 * still hold a secret.
 */
function parseDotEnv(text) {
  const values = {};
  const invalidLines = [];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      let line = raw.trim();
      if (line.length === 0 || line.startsWith('#')) return;
      if (line.startsWith('export ')) line = line.slice(7).trim();
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!m) {
        invalidLines.push(i + 1);
        return;
      }
      let value = m[2].trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      values[m[1]] = value;
    });
  return { values, invalidLines };
}

/** Names from `required` that are missing or empty in `env` (values never returned). */
function missingNames(required, env) {
  return required.filter((name) => !String(env[name] ?? '').trim());
}

/**
 * Release git state -> problems (empty = fine). Pure: the caller runs the git
 * commands and passes their results in.
 */
function gitProblems({ fetchOk, dirtyCount, branch, expectedBranch, head, remoteHead, remoteRef }) {
  const problems = [];
  if (!fetchOk) problems.push(`git fetch fehlgeschlagen - Remote-Stand von ${remoteRef} unbekannt.`);
  if (dirtyCount > 0) {
    problems.push(`Arbeitsverzeichnis nicht sauber (${dirtyCount} geänderte/neue Datei(en)).`);
  }
  if (branch !== expectedBranch) {
    problems.push(`Auf Branch "${branch}", Release-Branch ist "${expectedBranch}".`);
  } else if (fetchOk && (!remoteHead || head !== remoteHead)) {
    problems.push(`${branch} entspricht nicht ${remoteRef} (lokal ${short(head)}, remote ${short(remoteHead)}).`);
  }
  return problems;
}

function short(sha) {
  return sha ? String(sha).slice(0, 7) : '-';
}

/** release/<App>-<version>-<build>.<ext> */
function artifactFileName(appName, version, build, ext) {
  return `${appName}-${version}-${build}.${ext}`;
}

/** True when `last` (from release/.last-build.json) has exactly these numbers. */
function isSameBuild(last, version, build) {
  return !!last && String(last.version) === String(version) && String(last.build) === String(build);
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} min ${String(s).padStart(2, '0')} s` : `${s} s`;
}

module.exports = {
  FLAGS,
  artifactFileName,
  compareVersions,
  fingerprintsMatch,
  formatDuration,
  formatFingerprint,
  gitProblems,
  isSameBuild,
  latestVersionDir,
  meetsMinimum,
  missingNames,
  normalizeFingerprint,
  parseApksignerFingerprints,
  parseArgs,
  parseDotEnv,
  parseGradleVersions,
  parseJavaMajor,
  parseKeytoolFingerprints,
  parseVersion,
  releaseTarget,
};
