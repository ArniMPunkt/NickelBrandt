/**
 * Expo config plugin: iOS code signing for BOTH build configurations,
 * persisted across `expo prebuild --clean` (ios/ is never committed).
 *
 * The two configurations get deliberately different signing:
 *
 *  - DEBUG  -> Automatic signing (team 7J46UW9859). Local Build & Run on a
 *    physical iPhone needs a development provisioning profile (device UDID +
 *    get-task-allow for the debugger); with CODE_SIGN_STYLE = Automatic,
 *    Xcode creates that profile itself and registers the device on first run.
 *
 *  - RELEASE -> Manual signing pinned to "iPhone Distribution" +
 *    provisioning profile "NickelBrandt AppStore" for the Archive ->
 *    TestFlight path. Written as PLAIN (unconditional) keys in exactly the
 *    format EAS Build's CONFIGURE_XCODE_PROJECT phase writes
 *    (setProvisioningProfileForPbxproj), so an `eas build --local` with
 *    credentials.json overwrites them idempotently. Deliberately NOT the
 *    [sdk=iphoneos*]-bracketed form Xcode's UI writes: bracketed keys take
 *    precedence over plain keys and would silently shadow EAS's assignment
 *    if the provisioning profile ever changes.
 *
 * Each configuration is handled by its own apply* function below — when
 * editing, make sure you are in the function matching the configuration you
 * mean; the Debug/Release mix-up is the one real hazard in this file.
 *
 * Config: plugins: [["./plugins/withIosSigning", { teamId, releaseCodeSignIdentity, releaseProvisioningProfile }]]
 * (all props optional; defaults below are the NickelBrandt values).
 */

const { withXcodeProject } = require('@expo/config-plugins');

const DEFAULT_TEAM_ID = '7J46UW9859';
const DEFAULT_RELEASE_IDENTITY = 'iPhone Distribution';
const DEFAULT_RELEASE_PROFILE = 'NickelBrandt AppStore';
const APPLICATION_PRODUCT_TYPE = 'com.apple.product-type.application';

function unquote(value) {
  return typeof value === 'string' ? value.replace(/^"|"$/g, '') : value;
}

/** Wrap a value in literal quotes; node-xcode writes settings verbatim, so
 *  values (and keys) containing spaces/brackets must carry their own quotes,
 *  otherwise the written pbxproj would be corrupt. */
function quoted(value) {
  return `"${value}"`;
}

/**
 * Collect the XCBuildConfiguration ids belonging to application target(s)
 * (skips library/extension targets and the `_comment` entries the xcode
 * parser interleaves into every section).
 */
function getAppTargetBuildConfigurationIds(project) {
  const nativeTargets = project.pbxNativeTargetSection();
  const configLists = project.pbxXCConfigurationList();
  const ids = [];
  for (const [key, target] of Object.entries(nativeTargets)) {
    if (key.endsWith('_comment') || typeof target !== 'object') continue;
    if (unquote(target.productType) !== APPLICATION_PRODUCT_TYPE) continue;
    const list = configLists[target.buildConfigurationList];
    if (!list || !Array.isArray(list.buildConfigurations)) continue;
    for (const entry of list.buildConfigurations) {
      ids.push(entry.value);
    }
  }
  return ids;
}

/** Iterate the app target's build configurations with the given name. */
function* appConfigurationsNamed(project, configurationName) {
  const buildConfigs = project.pbxXCBuildConfigurationSection();
  for (const configId of getAppTargetBuildConfigurationIds(project)) {
    const config = buildConfigs[configId];
    if (!config || typeof config !== 'object' || !config.buildSettings) continue;
    if (unquote(config.name) !== configurationName) continue;
    yield config;
  }
}

/**
 * Remove every signing-related pin from a buildSettings object, including
 * the [sdk=iphoneos*]-bracketed variants (node-xcode keeps the surrounding
 * quotes as part of those keys, hence the strip before matching).
 */
function clearSigningSettings(settings) {
  for (const key of Object.keys(settings)) {
    const bare = key.replace(/"/g, '');
    if (
      bare === 'CODE_SIGN_STYLE' ||
      bare.startsWith('CODE_SIGN_IDENTITY') ||
      bare.startsWith('DEVELOPMENT_TEAM') ||
      bare.startsWith('PROVISIONING_PROFILE')
    ) {
      delete settings[key];
    }
  }
}

/**
 * >>> DEBUG configuration ONLY. <<<
 * Automatic signing so Xcode manages the development profile + device
 * registration for local Build & Run. Must never pin a provisioning profile.
 */
function applyDebugAutomaticSigning(project, { teamId }) {
  let touched = 0;
  for (const config of appConfigurationsNamed(project, 'Debug')) {
    const settings = config.buildSettings;
    clearSigningSettings(settings);
    settings.CODE_SIGN_STYLE = 'Automatic';
    settings.DEVELOPMENT_TEAM = teamId;
    settings.CODE_SIGN_IDENTITY = quoted('Apple Development');
    touched += 1;
  }
  return touched;
}

/**
 * >>> RELEASE configuration ONLY. <<<
 * Manual signing pinned to the App Store distribution identity/profile for
 * Archive -> TestFlight, as plain keys matching EAS Build's own format (see
 * file header).
 *
 * NOTE (intentional, not a bug): unlike the earlier [sdk=iphoneos*] form,
 * these plain keys also apply to Release builds for the SIMULATOR
 * (xcodebuild -showBuildSettings -sdk iphonesimulator resolves them). In
 * practice that is harmless: Xcode's build system does not apply
 * provisioning profiles on the simulator platform and ad-hoc-signs the
 * products, and this project's simulator workflow uses the Debug
 * configuration anyway. Should a Release-for-simulator build ever fail on
 * these settings, scope them back to [sdk=iphoneos*] — but then they MUST
 * be kept in sync with what EAS writes as plain keys (see file header).
 */
function applyReleaseManualSigning(project, { teamId, identity, profile }) {
  let touched = 0;
  for (const config of appConfigurationsNamed(project, 'Release')) {
    const settings = config.buildSettings;
    clearSigningSettings(settings);
    // Exactly the four keys/values EAS's setProvisioningProfileForPbxproj
    // writes (team quoted, style unquoted), so its overwrite is a no-op
    // as long as credentials.json points at the same profile.
    settings.CODE_SIGN_STYLE = 'Manual';
    settings.DEVELOPMENT_TEAM = quoted(teamId);
    settings.CODE_SIGN_IDENTITY = quoted(identity);
    settings.PROVISIONING_PROFILE_SPECIFIER = quoted(profile);
    touched += 1;
  }
  return touched;
}

/**
 * @param {import('@expo/config-plugins').ExpoConfig} config
 * @param {{ teamId?: string, releaseCodeSignIdentity?: string, releaseProvisioningProfile?: string }} props
 */
function withIosSigning(config, props = {}) {
  const teamId = props.teamId || DEFAULT_TEAM_ID;
  const identity = props.releaseCodeSignIdentity || DEFAULT_RELEASE_IDENTITY;
  const profile = props.releaseProvisioningProfile || DEFAULT_RELEASE_PROFILE;

  return withXcodeProject(config, (cfg) => {
    const debugTouched = applyDebugAutomaticSigning(cfg.modResults, { teamId });
    const releaseTouched = applyReleaseManualSigning(cfg.modResults, {
      teamId,
      identity,
      profile,
    });
    if (debugTouched === 0 || releaseTouched === 0) {
      throw new Error(
        `[withIosSigning] Expected both configurations on the app target, ` +
          `found Debug: ${debugTouched}, Release: ${releaseTouched}. ` +
          'The generated Xcode project structure may have changed.'
      );
    }
    return cfg;
  });
}

module.exports = withIosSigning;
module.exports.applyDebugAutomaticSigning = applyDebugAutomaticSigning;
module.exports.applyReleaseManualSigning = applyReleaseManualSigning;
