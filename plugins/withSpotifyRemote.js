/**
 * Expo config plugin for react-native-spotify-remote.
 *
 * react-native-spotify-remote (v0.3.x) is a legacy bridge module with no
 * built-in Expo plugin. This plugin injects the native configuration that the
 * bundled Spotify SDKs need, so it survives `expo prebuild`.
 *
 * What it does:
 *  - Android: adds <queries> visibility for the Spotify app (com.spotify.music,
 *    required on Android 11+) and the two string resources the bundled
 *    spotify-auth AAR reads for its redirect intent-filter
 *    (com_spotify_sdk_redirect_scheme / com_spotify_sdk_redirect_host).
 *    The AAR already declares AuthCallbackActivity/LoginActivity itself — we
 *    only supply the scheme/host, so there is no activity class name to keep in
 *    sync.
 *  - iOS: registers the redirect URL schemes in CFBundleURLTypes, allows
 *    `canOpenURL` checks for the Spotify app, imports RNSpotifyRemoteAuth into
 *    the generated Swift bridging header, and forwards AppDelegate openURL
 *    callbacks to the Spotify SDK while preserving Expo/RN Linking.
 *
 * NOTE: this plugin used to inject an EXCLUDED_ARCHS[sdk=iphonesimulator*]
 * workaround because the bundled SpotifyiOS.framework v1.2.1 had no
 * arm64-simulator slice. That is obsolete: the SDK is now swapped for the
 * v5.0.1 SpotifyiOS.xcframework (see vendor/README.md), which ships a real
 * arm64-iossimulator slice, so Simulator builds link natively.
 *
 * Config: pass the redirect URI via the plugin props, e.g.
 *   plugins: [["./plugins/withSpotifyRemote", { redirectUri: "nickelbrandt://spotify-login-callback" }]]
 */

const {
  withAndroidManifest,
  withStringsXml,
  withInfoPlist,
  withAppDelegate,
  withDangerousMod,
  AndroidConfig,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SPOTIFY_PACKAGE = 'com.spotify.music';
const SPOTIFY_AUTH_BRIDGING_IMPORT =
  '#import <RNSpotifyRemote/RNSpotifyRemoteAuth.h>';
const SPOTIFY_OPEN_URL_CALL =
  'RNSpotifyRemoteAuth.sharedInstance()?.application(app, open: url, options: options) ?? false';

/**
 * Split a redirect URI "<scheme>://<host>" into its parts.
 */
function parseRedirectUri(redirectUri) {
  if (!redirectUri || !redirectUri.includes('://')) {
    throw new Error(
      `[withSpotifyRemote] Invalid redirectUri "${redirectUri}". ` +
        'Expected format "<scheme>://<host>", e.g. "nickelbrandt://spotify-login-callback".'
    );
  }
  const [scheme, rest] = redirectUri.split('://');
  // host is everything up to an optional path
  const host = rest.split('/')[0];
  return { scheme, host };
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Android: ensure <queries><package android:name="com.spotify.music"/></queries>
 */
function withSpotifyQueries(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.queries = manifest.queries || [];

    const alreadyPresent = manifest.queries.some((q) =>
      (q.package || []).some((p) => p?.$?.['android:name'] === SPOTIFY_PACKAGE)
    );
    if (!alreadyPresent) {
      manifest.queries.push({
        package: [{ $: { 'android:name': SPOTIFY_PACKAGE } }],
      });
    }
    return cfg;
  });
}

/**
 * Android: redirect scheme/host string resources read by the spotify-auth AAR.
 */
function withSpotifyRedirectStrings(config, { scheme, host }) {
  return withStringsXml(config, (cfg) => {
    cfg.modResults = AndroidConfig.Strings.setStringItem(
      [
        {
          $: { name: 'com_spotify_sdk_redirect_scheme', translatable: 'false' },
          _: scheme,
        },
        {
          $: { name: 'com_spotify_sdk_redirect_host', translatable: 'false' },
          _: host,
        },
      ],
      cfg.modResults
    );
    return cfg;
  });
}

/**
 * iOS: register URL/query schemes so auth callbacks and Spotify app detection work.
 */
function withSpotifyUrlScheme(config, { scheme }) {
  return withInfoPlist(config, (cfg) => {
    const urlTypes = cfg.modResults.CFBundleURLTypes || [];
    const requiredSchemes = unique([
      scheme,
      ...asArray(cfg.scheme),
      cfg.ios?.bundleIdentifier,
    ]);

    if (urlTypes.length === 0) {
      urlTypes.push({
        CFBundleURLName: 'spotify-auth',
        CFBundleURLSchemes: [],
      });
    }

    for (const requiredScheme of requiredSchemes) {
      const hasScheme = urlTypes.some((t) =>
        (t.CFBundleURLSchemes || []).includes(requiredScheme)
      );
      if (!hasScheme) {
        urlTypes[0].CFBundleURLSchemes = unique([
          ...(urlTypes[0].CFBundleURLSchemes || []),
          requiredScheme,
        ]);
      }
    }

    cfg.modResults.CFBundleURLTypes = urlTypes;
    cfg.modResults.LSApplicationQueriesSchemes = unique([
      ...(cfg.modResults.LSApplicationQueriesSchemes || []),
      'spotify',
    ]);
    return cfg;
  });
}

function findBridgingHeaderPath(iosProjectRoot) {
  for (const entry of fs.readdirSync(iosProjectRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(iosProjectRoot, entry.name);
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('-Bridging-Header.h')) {
        return path.join(dir, file);
      }
    }
  }
  return null;
}

function withSpotifyBridgingHeader(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const headerPath = findBridgingHeaderPath(cfg.modRequest.platformProjectRoot);
      if (!headerPath) {
        throw new Error(
          '[withSpotifyRemote] Could not find a Swift bridging header. ' +
            'RNSpotifyRemoteAuth is Objective-C, so the Swift AppDelegate needs ' +
            'the generated <Target>-Bridging-Header.h to import it.'
        );
      }

      let contents = fs.readFileSync(headerPath, 'utf8');
      if (!contents.includes(SPOTIFY_AUTH_BRIDGING_IMPORT)) {
        contents = `${contents.trimEnd()}\n${SPOTIFY_AUTH_BRIDGING_IMPORT}\n`;
        fs.writeFileSync(headerPath, contents);
      }
      return cfg;
    },
  ]);
}

function addSpotifyOpenUrlForwarding(contents) {
  if (contents.includes(SPOTIFY_OPEN_URL_CALL)) {
    return contents;
  }

  const existingReturn =
    'return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)';
  if (!contents.includes(existingReturn)) {
    throw new Error(
      '[withSpotifyRemote] Could not find the expected AppDelegate.swift openURL return. ' +
        'The generated AppDelegate structure may have changed.'
    );
  }

  const replacement = [
    `let spotifyHandled = ${SPOTIFY_OPEN_URL_CALL}`,
    'let expoHandled = super.application(app, open: url, options: options)',
    'let linkingHandled = RCTLinkingManager.application(app, open: url, options: options)',
    'return spotifyHandled || expoHandled || linkingHandled',
  ].join('\n    ');

  return contents.replace(existingReturn, replacement);
}

function withSpotifyAppDelegate(config) {
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error(
        `[withSpotifyRemote] Expected a Swift AppDelegate, got "${cfg.modResults.language}".`
      );
    }
    cfg.modResults.contents = addSpotifyOpenUrlForwarding(cfg.modResults.contents);
    return cfg;
  });
}

/**
 * @param {import('@expo/config-plugins').ExpoConfig} config
 * @param {{ redirectUri?: string }} props
 */
function withSpotifyRemote(config, props = {}) {
  const redirectUri =
    props.redirectUri || process.env.EXPO_PUBLIC_SPOTIFY_REDIRECT_URI;
  const { scheme, host } = parseRedirectUri(redirectUri);

  config = withSpotifyQueries(config);
  config = withSpotifyRedirectStrings(config, { scheme, host });
  config = withSpotifyUrlScheme(config, { scheme });
  config = withSpotifyBridgingHeader(config);
  config = withSpotifyAppDelegate(config);
  return config;
}

module.exports = withSpotifyRemote;
