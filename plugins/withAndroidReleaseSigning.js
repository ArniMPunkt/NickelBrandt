/**
 * Expo config plugin: Android release signing.
 *
 * The default Expo/React Native `android/app/build.gradle` signs the RELEASE
 * build with the DEBUG keystore (`signingConfig signingConfigs.debug` in the
 * release buildType) — fine for prebuild scaffolding, wrong for a real release.
 * `android/` is regenerated on every `expo prebuild` and is NOT committed, so
 * this is fixed via a config plugin (like withSpotifyRemote), never by editing
 * the generated folder by hand.
 *
 * What it does, idempotently (guarded by marker comments):
 *  - adds a `release { ... }` entry to the existing `signingConfigs` block (the
 *    `debug` block is left completely untouched), and
 *  - switches `buildTypes.release.signingConfig` from `signingConfigs.debug` to
 *    `signingConfigs.release`.
 *
 * SECRETS — the store password, key alias and key password are NEVER hard-coded.
 * They are read at BUILD TIME from environment variables via Groovy's
 * `System.getenv(...)`. This is deliberate: Gradle (unlike Node) does NOT load
 * environment variables automatically, so the generated build.gradle must call
 * `System.getenv()` explicitly. The alternative — `gradle.properties` — would
 * mean writing the secrets into a file (committed by default, or an extra
 * untracked file to manage); env vars keep secrets out of every file in the
 * repo. The keystore itself stays at the project root (gitignored via
 * `*.keystore`) and is referenced by a relative path, never copied or generated.
 *
 * Required environment variables (set before `gradlew(.bat) bundleRelease`):
 *   NICKELBRANDT_KEYSTORE_PASSWORD  - the keystore (store) password
 *   NICKELBRANDT_KEY_ALIAS          - the key alias inside the keystore
 *   NICKELBRANDT_KEY_PASSWORD       - the key password
 *
 * If these are unset, only RELEASE signing fails (with a clear Gradle error);
 * debug builds and Gradle configuration are unaffected, because System.getenv()
 * simply returns null at configuration time and is only validated when the
 * release signing task actually runs.
 */
const { withAppBuildGradle } = require('@expo/config-plugins');

const MARKER = '// >>> withAndroidReleaseSigning';
const END_MARKER = '// <<< withAndroidReleaseSigning';

// Inserted into the signingConfigs block, next to the untouched debug block.
const RELEASE_SIGNING_BLOCK = [
  `        ${MARKER} (values from env at build time; see plugins/withAndroidReleaseSigning.js)`,
  '        release {',
  "            storeFile file('../../nickelbrandt.keystore')",
  "            storePassword System.getenv('NICKELBRANDT_KEYSTORE_PASSWORD')",
  "            keyAlias System.getenv('NICKELBRANDT_KEY_ALIAS')",
  "            keyPassword System.getenv('NICKELBRANDT_KEY_PASSWORD')",
  '        }',
  `        ${END_MARKER}`,
].join('\n');

/**
 * Pure string transform (exported for testing). Throws if the expected default
 * structure isn't found, so a template change fails loudly instead of silently
 * leaving the release build debug-signed.
 */
function applyReleaseSigning(contents) {
  if (contents.includes(MARKER)) return contents; // already applied -> idempotent

  // 1) Flip ONLY buildTypes.release's signingConfig (buildTypes.debug stays
  //    debug). Done before step 2 so the only `release {` present is the
  //    buildType, keeping this match unambiguous.
  const releaseTypeRe =
    /(buildTypes\s*\{[\s\S]*?\brelease\s*\{[\s\S]*?\bsigningConfig\s+)signingConfigs\.debug/;
  if (!releaseTypeRe.test(contents)) {
    throw new Error(
      '[withAndroidReleaseSigning] Could not find buildTypes.release using ' +
        '`signingConfig signingConfigs.debug`. The generated build.gradle structure may have changed.'
    );
  }
  contents = contents.replace(releaseTypeRe, '$1signingConfigs.release');

  // 2) Add the release signingConfig alongside the existing debug one.
  const signingConfigsRe = /signingConfigs\s*\{[ \t]*\n/;
  if (!signingConfigsRe.test(contents)) {
    throw new Error(
      '[withAndroidReleaseSigning] Could not find the `signingConfigs {` block to extend.'
    );
  }
  contents = contents.replace(signingConfigsRe, (m) => `${m}${RELEASE_SIGNING_BLOCK}\n`);

  return contents;
}

function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error(
        `[withAndroidReleaseSigning] Expected a Groovy build.gradle, got "${cfg.modResults.language}".`
      );
    }
    cfg.modResults.contents = applyReleaseSigning(cfg.modResults.contents);
    return cfg;
  });
}

module.exports = withAndroidReleaseSigning;
module.exports.applyReleaseSigning = applyReleaseSigning;
