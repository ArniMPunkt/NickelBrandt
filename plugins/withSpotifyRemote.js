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
 *  - iOS: registers the redirect URL scheme in CFBundleURLTypes.
 *    NOTE (iOS only, deferred): when you actually build for iOS you must also
 *    forward the auth callback in AppDelegate.swift, e.g. in
 *    `application(_:open:options:)` call
 *    `RNSpotifyRemoteAuth.sharedInstance().application(app, open: url, options: options)`.
 *    This is left as a manual step because SDK 54 uses a Swift AppDelegate.
 *
 * Config: pass the redirect URI via the plugin props, e.g.
 *   plugins: [["./plugins/withSpotifyRemote", { redirectUri: "nickelbrandt://spotify-login-callback" }]]
 */

const {
  withAndroidManifest,
  withStringsXml,
  withInfoPlist,
  AndroidConfig,
} = require('@expo/config-plugins');

const SPOTIFY_PACKAGE = 'com.spotify.music';

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
 * iOS: register the redirect URL scheme so the auth callback can return.
 */
function withSpotifyUrlScheme(config, { scheme }) {
  return withInfoPlist(config, (cfg) => {
    const urlTypes = cfg.modResults.CFBundleURLTypes || [];
    const hasScheme = urlTypes.some((t) =>
      (t.CFBundleURLSchemes || []).includes(scheme)
    );
    if (!hasScheme) {
      urlTypes.push({
        CFBundleURLName: 'spotify-auth',
        CFBundleURLSchemes: [scheme],
      });
    }
    cfg.modResults.CFBundleURLTypes = urlTypes;
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
  return config;
}

module.exports = withSpotifyRemote;
