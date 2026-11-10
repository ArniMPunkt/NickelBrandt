#!/usr/bin/env node
'use strict';

/**
 * Release pipeline (shared standard with BeerTaste). One command, the machine
 * decides the platform:
 *
 *   npm run release           Windows: Android AAB + APK   macOS: iOS build + TestFlight upload
 *   npm run release:check     preflight only, no build
 *
 *   --aab-only       Windows: AAB only
 *   --skip-prebuild  Windows: reuse android/ (versions must match app.config.ts)
 *   --no-submit      macOS: build only, no upload
 *   --force          git problems only warn instead of aborting
 *
 * Preflight collects EVERY problem first and then aborts loudly. Fixed,
 * non-secret values live in scripts/release.config.json. Secrets are only ever
 * checked by NAME and passed on to child processes - never printed or written.
 * Git is only read here (fetch/status/rev-parse), never changed.
 *
 * Replaces scripts/build-android-release.ps1 and scripts/release-ios.js.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./release.config.json');
const h = require('./lib/release/helpers');

const ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, config.releaseDir);
const LAST_BUILD_FILE = path.join(RELEASE_DIR, '.last-build.json');
const ANDROID_DIR = path.join(ROOT, 'android');
const GRADLE_FILE = path.join(ANDROID_DIR, 'app', 'build.gradle');
const GRADLE_WRAPPER_JAR = path.join(ANDROID_DIR, 'gradle', 'wrapper', 'gradle-wrapper.jar');

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/** Run with inherited stdio; returns the exit status (null if it couldn't start). */
function run(cmd, args, opts = {}) {
  console.log(`\n▶ ${path.basename(cmd)} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (res.error) console.error(`  ${cmd} konnte nicht gestartet werden: ${res.error.message}`);
  return res.status;
}

/** Run silently and capture output (for probes). */
function capture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`, error: res.error };
}

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

// ---------------------------------------------------------------------------
// Report: every check prints one line, problems are collected for the end
// ---------------------------------------------------------------------------

function createReport() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    ok: (name, detail) => console.log(`  ✔ ${name}${detail ? `: ${detail}` : ''}`),
    warn: (name, detail) => {
      warnings.push(`${name}: ${detail}`);
      console.log(`  ⚠ ${name}: ${detail}`);
    },
    error: (name, detail) => {
      errors.push(`${name}: ${detail}`);
      console.log(`  ✖ ${name}: ${detail}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Preflight checks
// ---------------------------------------------------------------------------

function checkGit(report, force) {
  const remoteRef = `${config.remote}/${config.releaseBranch}`;
  const fetchOk = capture('git', ['fetch', '--quiet', config.remote, config.releaseBranch]).status === 0;
  const status = capture('git', ['status', '--porcelain']);
  const dirtyCount = status.out.split('\n').filter((l) => l.trim()).length;
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
  const head = capture('git', ['rev-parse', 'HEAD']).out.trim();
  const remote = capture('git', ['rev-parse', '--verify', '--quiet', remoteRef]);
  const problems = h.gitProblems({
    fetchOk,
    dirtyCount,
    branch,
    expectedBranch: config.releaseBranch,
    head,
    remoteHead: remote.status === 0 ? remote.out.trim() : null,
    remoteRef,
  });
  if (problems.length === 0) {
    report.ok('Git', `${branch} sauber, gleich ${remoteRef} (${head.slice(0, 7)})`);
  }
  for (const p of problems) (force ? report.warn : report.error)('Git', force ? `${p} (--force)` : p);
  return head;
}

function checkNode(report) {
  if (h.meetsMinimum(process.version, config.nodeMin)) {
    report.ok('Node', `${process.version} (mind. ${config.nodeMin})`);
  } else {
    report.error('Node', `${process.version}, benötigt mind. ${config.nodeMin}`);
  }
}

/** A dependency missing from node_modules only surfaces deep inside the build otherwise. */
function checkDependencies(report) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const missing = Object.keys(pkg.dependencies ?? {}).filter(
    (dep) => !fs.existsSync(path.join(ROOT, 'node_modules', dep, 'package.json'))
  );
  if (missing.length === 0) report.ok('Abhängigkeiten', 'alle installiert');
  else report.error('Abhängigkeiten', `fehlen in node_modules: ${missing.join(', ')} - npm install ausführen`);
}

/**
 * .env via @expo/env - the same loader expo prebuild / Metro use. Mutates
 * process.env on purpose: every child process (prebuild, Gradle's bundling
 * step, eas build --local) inherits the values from here. For iOS this is THE
 * way they reach the build: .env is gitignored, so it is never in the archive
 * eas build --local works from.
 */
function loadAppEnv(report) {
  process.env.NODE_ENV = process.env.NODE_ENV || 'production';
  try {
    require(require.resolve('@expo/env', { paths: [ROOT] })).load(ROOT, { silent: true });
  } catch (e) {
    report.error('Umgebung', `@expo/env nicht ladbar (${e.message}) - npm install ausführen`);
    return;
  }
  const missing = h.missingNames(config.requiredEnv, process.env);
  if (missing.length === 0) report.ok('Umgebung (.env)', `${config.requiredEnv.length} Pflichtvariablen gesetzt`);
  else report.error('Umgebung (.env)', `fehlend oder leer: ${missing.join(', ')}`);
}

/** Evaluated app config (app.config.ts) - the values the build will really use. */
function readAppConfig(report, target, options) {
  let exp;
  try {
    const { getConfig } = require(require.resolve('@expo/config', { paths: [ROOT] }));
    exp = getConfig(ROOT, { skipSDKVersionRequirement: true }).exp;
  } catch (e) {
    report.error('App-Konfiguration', `app.config.ts nicht auswertbar: ${e.message}`);
    return null;
  }

  const appId = target === 'android' ? exp.android?.package : exp.ios?.bundleIdentifier;
  if (appId === config.appId[target]) report.ok('App-ID', appId);
  else report.error('App-ID', `app.config.ts hat "${appId}", erwartet "${config.appId[target]}"`);

  const version = exp.version;
  const build = target === 'android' ? exp.android?.versionCode : exp.ios?.buildNumber;
  const buildLabel = target === 'android' ? 'versionCode' : 'buildNumber';
  if (!version || build == null) {
    report.error('Version', `version oder ${buildLabel} fehlt in app.config.ts`);
    return null;
  }
  report.ok('Version', `${version} · ${buildLabel} ${build} (wird nicht hochgezählt)`);

  const last = readLastBuilds()[target];
  if (h.isSameBuild(last, version, build)) {
    report.warn('Version', `${version} / ${build} wurde schon am ${last.builtAt} gebaut - Nummern erhöhen?`);
  }

  if (target === 'android' && options.skipPrebuild) {
    const mismatch = gradleVersionMismatch(version, build);
    if (mismatch) report.error('android/ (--skip-prebuild)', mismatch);
    else report.ok('android/ (--skip-prebuild)', 'Versionen passen zu app.config.ts');
  }
  return { version: String(version), build: String(build) };
}

/** null when android/ carries exactly these numbers, otherwise the reason. */
function gradleVersionMismatch(version, build) {
  if (!fs.existsSync(GRADLE_FILE)) return 'android/app/build.gradle fehlt - ohne --skip-prebuild bauen.';
  const gradle = h.parseGradleVersions(fs.readFileSync(GRADLE_FILE, 'utf8'));
  if (gradle.versionName === String(version) && String(gradle.versionCode) === String(build)) return null;
  return (
    `android/ steht auf ${gradle.versionName} / versionCode ${gradle.versionCode}, ` +
    `app.config.ts auf ${version} / ${build} - ohne --skip-prebuild bauen.`
  );
}

function readLastBuilds() {
  try {
    return JSON.parse(fs.readFileSync(LAST_BUILD_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeLastBuild(target, entry) {
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const all = readLastBuilds();
  all[target] = entry;
  fs.writeFileSync(LAST_BUILD_FILE, `${JSON.stringify(all, null, 2)}\n`);
}

// --- Windows / Android ---

/** JDK via JAVA_HOME, else Android Studio's bundled one - no user-specific paths. */
function findJdk(report) {
  const candidates = [
    process.env.JAVA_HOME && { home: process.env.JAVA_HOME, source: 'JAVA_HOME' },
    process.env.ProgramFiles && {
      home: path.join(process.env.ProgramFiles, 'Android', 'Android Studio', 'jbr'),
      source: 'Android Studio (jbr)',
    },
  ].filter(Boolean);
  const tried = [];
  for (const c of candidates) {
    const java = path.join(c.home, 'bin', exe('java'));
    if (!fs.existsSync(java)) {
      tried.push(`${c.source}: kein java`);
      continue;
    }
    const major = h.parseJavaMajor(capture(java, ['-version']).out);
    if (major != null && major >= config.android.minJavaMajor) {
      report.ok('JDK', `${major} aus ${c.source}`);
      return { home: c.home, java, keytool: path.join(c.home, 'bin', exe('keytool')) };
    }
    tried.push(`${c.source}: Java ${major ?? '?'}`);
  }
  report.error(
    'JDK',
    `kein JDK ${config.android.minJavaMajor}+ gefunden (${tried.join('; ') || 'JAVA_HOME nicht gesetzt'})`
  );
  return null;
}

/** Android SDK via ANDROID_HOME / ANDROID_SDK_ROOT, else the default under LOCALAPPDATA. */
function findAndroidSdk(report) {
  const candidates = [
    process.env.ANDROID_HOME && { dir: process.env.ANDROID_HOME, source: 'ANDROID_HOME' },
    process.env.ANDROID_SDK_ROOT && { dir: process.env.ANDROID_SDK_ROOT, source: 'ANDROID_SDK_ROOT' },
    process.env.LOCALAPPDATA && {
      dir: path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
      source: 'Standardort (LOCALAPPDATA)',
    },
  ].filter(Boolean);
  const sdk = candidates.find((c) => fs.existsSync(path.join(c.dir, 'platform-tools')));
  if (!sdk) {
    report.error('Android-SDK', 'nicht gefunden - ANDROID_HOME setzen');
    return null;
  }
  const buildToolsDir = path.join(sdk.dir, 'build-tools');
  const latest = fs.existsSync(buildToolsDir) ? h.latestVersionDir(fs.readdirSync(buildToolsDir)) : null;
  // keytool can't read the APK: AGP signs it with v2 only (no JAR signature).
  const apksigner = latest && path.join(buildToolsDir, latest, 'lib', 'apksigner.jar');
  if (!apksigner || !fs.existsSync(apksigner)) {
    report.error('Android-SDK', `${sdk.source}: keine build-tools mit apksigner`);
    return null;
  }
  report.ok('Android-SDK', `${sdk.source}, build-tools ${latest}`);
  return { dir: sdk.dir, apksigner };
}

function checkAndroidSigning(report) {
  const keystore = path.join(ROOT, config.android.keystore);
  if (fs.existsSync(keystore)) report.ok('Keystore', config.android.keystore);
  else report.error('Keystore', `${config.android.keystore} fehlt im Projektordner`);

  if (!h.normalizeFingerprint(config.android.expectedUploadCertSha256)) {
    report.error('Fingerabdruck', 'expectedUploadCertSha256 in release.config.json ist kein SHA-256');
  }

  const envFile = path.join(ROOT, config.android.signingEnvFile);
  if (!fs.existsSync(envFile)) {
    report.error(
      'Signing-Einträge',
      `${config.android.signingEnvFile} fehlt - Vorlage ${config.android.signingEnvFile}.example kopieren und ausfüllen`
    );
    return null;
  }
  const { values, invalidLines } = h.parseDotEnv(fs.readFileSync(envFile, 'utf8'));
  if (invalidLines.length > 0) {
    report.error('Signing-Einträge', `ungültige Zeile(n) ${invalidLines.join(', ')} in ${config.android.signingEnvFile}`);
  }
  const missing = h.missingNames(config.android.signingVars, values);
  if (missing.length === 0) report.ok('Signing-Einträge', config.android.signingVars.join(', '));
  else report.error('Signing-Einträge', `fehlend oder leer: ${missing.join(', ')}`);
  return values;
}

// --- macOS / iOS ---

function checkTool(report, name, cmd, args, parse = (out) => out.trim().split('\n')[0]) {
  const res = capture(cmd, args);
  if (res.status === 0) report.ok(name, parse(res.out));
  else report.error(name, `nicht gefunden oder nicht lauffähig (${cmd})`);
  return res.status === 0;
}

function checkIosTools(report) {
  checkTool(report, 'Xcode', 'xcodebuild', ['-version']);
  checkTool(report, 'CocoaPods', 'pod', ['--version']);
  checkTool(report, 'fastlane', 'fastlane', ['--version'], (out) => {
    const m = /fastlane (\d+\.\d+\.\d+)/.exec(out);
    return m ? m[1] : 'vorhanden';
  });
  if (checkTool(report, 'eas-cli', 'eas', ['--version'])) {
    // Only the status - the account name is not needed here.
    if (capture('eas', ['whoami']).status === 0) report.ok('eas whoami', 'angemeldet');
    else report.error('eas whoami', 'nicht angemeldet - eas login');
  }
  const credentials = path.join(ROOT, config.ios.credentialsFile);
  if (fs.existsSync(credentials)) report.ok('iOS-Credentials', `${config.ios.credentialsFile} vorhanden`);
  else report.error('iOS-Credentials', `${config.ios.credentialsFile} fehlt im Projektordner`);
}

function preflight(target, options) {
  console.log(`\n🔎 Vorab-Prüfungen (${target === 'android' ? 'Windows → Android' : 'macOS → iOS'})\n`);
  const report = createReport();
  const commit = checkGit(report, options.force);
  checkNode(report);
  checkDependencies(report);
  // Before the app config: app.config.ts reads EXPO_PUBLIC_SPOTIFY_REDIRECT_URI.
  loadAppEnv(report);
  const versions = readAppConfig(report, target, options);
  let platform = {};
  if (target === 'android') {
    platform = {
      jdk: findJdk(report),
      sdk: findAndroidSdk(report),
      signingEnv: checkAndroidSigning(report),
    };
  } else {
    checkIosTools(report);
  }

  if (report.warnings.length > 0) {
    console.log(`\n⚠ ${report.warnings.length} Warnung(en):`);
    for (const w of report.warnings) console.log(`   - ${w}`);
  }
  if (report.errors.length > 0) {
    console.error(`\n❌ ${report.errors.length} Problem(e), Release abgebrochen:`);
    for (const e of report.errors) console.error(`   - ${e}`);
    process.exit(1);
  }
  console.log('\n✅ Vorab-Prüfungen bestanden.');
  return { commit, ...versions, ...platform };
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

/**
 * Gradle via its wrapper jar on the JDK found in preflight (what gradlew.bat
 * does) - no shell, so arguments with spaces survive, and Gradle never falls
 * back to whatever `java` happens to be first on PATH.
 */
function gradle(ctx, args, env) {
  return run(ctx.jdk.java, ['-classpath', GRADLE_WRAPPER_JAR, 'org.gradle.wrapper.GradleWrapperMain', ...args], {
    cwd: ANDROID_DIR,
    env,
  });
}

function verifyFingerprint(label, fingerprints) {
  const expected = config.android.expectedUploadCertSha256;
  if (fingerprints.length === 1 && h.fingerprintsMatch(fingerprints[0], expected)) {
    console.log(`  ✔ ${label} signiert mit dem Upload-Schlüssel (${h.formatFingerprint(expected)})`);
    return;
  }
  const found = fingerprints.length ? fingerprints.map(h.formatFingerprint).join(', ') : 'keine Signatur gefunden';
  fail(`${label}: Signatur passt nicht zum Upload-Schlüssel.\n   erwartet: ${h.formatFingerprint(expected)}\n   gefunden: ${found}`);
}

function buildAndroid(ctx, options) {
  const started = Date.now();
  const env = {
    ...process.env,
    ...ctx.signingEnv,
    JAVA_HOME: ctx.jdk.home,
    ANDROID_HOME: ctx.sdk.dir,
  };

  if (fs.existsSync(GRADLE_WRAPPER_JAR)) {
    console.log('\nGradle-Daemon stoppen');
    if (gradle(ctx, ['--stop'], env) !== 0) console.warn('  ⚠ gradle --stop fehlgeschlagen, es geht trotzdem weiter.');
    sleep(2000);
  }

  if (!options.skipPrebuild) {
    const expoCli = require.resolve('expo/bin/cli', { paths: [ROOT] });
    if (run(process.execPath, [expoCli, 'prebuild', '--platform', 'android', '--clean'], { env }) !== 0) {
      fail('expo prebuild fehlgeschlagen.');
    }
  }
  // Also after a fresh prebuild: file names and .last-build.json must carry
  // the numbers that are really in the build.
  const mismatch = gradleVersionMismatch(ctx.version, ctx.build);
  if (mismatch) fail(mismatch);

  const tasks = options.aabOnly ? [':app:bundleRelease'] : [':app:bundleRelease', ':app:assembleRelease'];
  if (gradle(ctx, [`-Dorg.gradle.jvmargs=${config.android.gradleJvmArgs}`, ...tasks], env) !== 0) {
    fail('Gradle-Build fehlgeschlagen.');
  }

  const outputs = [
    {
      ext: 'aab',
      file: path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab'),
      fingerprints: (file) => h.parseKeytoolFingerprints(capture(ctx.jdk.keytool, ['-printcert', '-jarfile', file]).out),
    },
  ];
  if (!options.aabOnly) {
    outputs.push({
      ext: 'apk',
      file: path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
      fingerprints: (file) =>
        h.parseApksignerFingerprints(
          capture(ctx.jdk.java, ['-jar', ctx.sdk.apksigner, 'verify', '--print-certs', file]).out
        ),
    });
  }

  console.log('\n🔏 Signatur prüfen');
  for (const o of outputs) {
    if (!fs.existsSync(o.file)) fail(`${o.ext.toUpperCase()} nicht gefunden: ${o.file}`);
    verifyFingerprint(o.ext.toUpperCase(), o.fingerprints(o.file));
  }

  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const artifacts = outputs.map((o) => {
    const name = h.artifactFileName(config.appName, ctx.version, ctx.build, o.ext);
    fs.copyFileSync(o.file, path.join(RELEASE_DIR, name));
    return name;
  });
  writeLastBuild('android', {
    version: ctx.version,
    build: ctx.build,
    commit: ctx.commit,
    builtAt: new Date().toISOString(),
    artifacts,
  });

  console.log('\n✅ Android-Release fertig:');
  for (const name of artifacts) {
    const mb = (fs.statSync(path.join(RELEASE_DIR, name)).size / 1024 / 1024).toFixed(2);
    console.log(`   ${config.releaseDir}/${name} (${mb} MB)`);
  }
  console.log(`   Dauer: ${h.formatDuration(Date.now() - started)}`);
}

/**
 * No local prebuild: eas build --local works from a git copy of the project
 * that leaves gitignored files (ios/ included) out and runs prebuild itself
 * when ios/ is missing - a local ios/ would never reach the build. The
 * environment loaded in preflight is inherited by eas-cli and reaches the
 * temporary build directory from there.
 */
function buildIos(ctx, options) {
  const started = Date.now();
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const name = h.artifactFileName(config.appName, ctx.version, ctx.build, 'ipa');
  const ipa = path.join(RELEASE_DIR, name);
  fs.rmSync(ipa, { force: true });

  const buildArgs = ['build', '--platform', 'ios', '--local', '--profile', config.ios.easProfile, '--output', ipa];
  if (run('eas', buildArgs, { env: process.env }) !== 0) fail('eas build fehlgeschlagen.');
  if (!fs.existsSync(ipa)) fail(`IPA nicht gefunden: ${ipa}`);
  writeLastBuild('ios', {
    version: ctx.version,
    build: ctx.build,
    commit: ctx.commit,
    builtAt: new Date().toISOString(),
    artifacts: [name],
  });
  console.log(`\n✅ iOS-Build fertig: ${config.releaseDir}/${name} (${h.formatDuration(Date.now() - started)})`);

  if (options.noSubmit) {
    console.log('   Upload übersprungen (--no-submit).');
    return;
  }
  const submitStarted = Date.now();
  // stdio stays inherited: eas submit may ask interactive questions.
  if (run('eas', ['submit', '--platform', 'ios', '--path', ipa], { env: process.env }) !== 0) {
    fail('eas submit fehlgeschlagen - die IPA liegt weiterhin in release/.');
  }
  console.log(`\n✅ Upload zu TestFlight fertig (${h.formatDuration(Date.now() - submitStarted)}).`);
  console.log(`   Gesamtdauer: ${h.formatDuration(Date.now() - started)}`);
}

// ---------------------------------------------------------------------------

function main() {
  const target = h.releaseTarget(process.platform);
  if (!target) fail(`Release nur unter Windows (Android) oder macOS (iOS), nicht auf ${process.platform}.`);
  const { options, errors } = h.parseArgs(process.argv.slice(2), process.platform);
  if (errors.length > 0) fail(errors.join('\n   '));

  const ctx = preflight(target, options);
  if (options.check) return;
  if (target === 'android') buildAndroid(ctx, options);
  else buildIos(ctx, options);
}

main();
