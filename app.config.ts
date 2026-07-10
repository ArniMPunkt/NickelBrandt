import type { ExpoConfig, ConfigContext } from 'expo/config';

/**
 * NickelBrandt app config.
 *
 * Using app.config.ts (instead of app.json) so the Spotify config plugin can
 * read the redirect URI from the environment at prebuild time.
 *
 * The redirect URI MUST match what is registered in the Spotify Developer
 * Dashboard. Format: <scheme>://<host>, e.g. nickelbrandt://spotify-login-callback
 */
const SPOTIFY_REDIRECT_URI =
  process.env.EXPO_PUBLIC_SPOTIFY_REDIRECT_URI ?? 'nickelbrandt://spotify-login-callback';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'NickelBrandt',
  slug: 'nickelbrandt',
  version: '1.1.3',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  // App-level deep-link scheme (also used by the Spotify auth redirect).
  scheme: 'nickelbrandt',
  // react-native-spotify-remote is a legacy bridge module; keep the old
  // architecture so it loads reliably (SDK 54 is the last SDK allowing this).
  newArchEnabled: false,
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.nickelbrandt.app',
    icon: './assets/icon.png',
    // iOS build number (CFBundleVersion). Bump on every TestFlight/App Store build.
    buildNumber: '13',
    infoPlist: {
      // Only standard TLS/HTTPS (Supabase, Spotify SDK, Expo) — no custom
      // crypto. Answers App Store Connect's export-compliance question
      // automatically, so builds no longer sit in "Missing Compliance".
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: 'com.nickelbrandt.app',
    // Android build number (versionCode). Bump on every Play/release build.
    versionCode: 11,
    adaptiveIcon: {
      // Solid logo-purple background behind the masked foreground. NOTE: a
      // backgroundImage would override backgroundColor, so it is intentionally
      // omitted here (was ./assets/android-icon-background.png).
      //
      // Android-specific foreground with ~19% safe-zone padding so launcher
      // masks (circle/squircle/square) don't clip the logo. iOS / the top-level
      // icon keep ./assets/icon.png, which doesn't need this extra padding.
      foregroundImage: './assets/icon-android-final.png',
      backgroundColor: '#1A0F3C',
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    favicon: './assets/favicon.png',
  },
  extra: {
    ...config.extra,
    eas: {
      ...config.extra?.eas,
      // EAS project linkage (@brunss/nickelbrandt). `eas init` cannot write
      // into a dynamic config, so this is maintained by hand.
      projectId: '43771d65-13bb-4f53-a3d0-503367bf52e6',
    },
  },
  plugins: [
    ['./plugins/withSpotifyRemote', { redirectUri: SPOTIFY_REDIRECT_URI }],
    // Signs the Android RELEASE build with the project's own keystore (the RN
    // template otherwise release-signs with the debug key). Reads passwords/alias
    // from env at build time; see the plugin header.
    './plugins/withAndroidReleaseSigning',
    // Sets C++17 on the fmt pod to fix consteval errors with newer Xcode/Clang.
    './plugins/withFmtCppStandard',
    // iOS: persists uncaught native exceptions (name/reason) to UserDefaults so
    // the Einstellungen tab can show them - TestFlight reports strip exactly
    // that. Diagnoses the 100% launch crash of build 5.
    './plugins/withCrashDiagnostics',
    // iOS signing for both configurations, survives prebuild --clean:
    // Debug = Automatic signing (device Build & Run), Release = manual
    // "iPhone Distribution" + "NickelBrandt AppStore" (Archive/TestFlight).
    './plugins/withIosSigning',
    // Needed by expo-auth-session (PKCE Web-API auth) to complete the redirect.
    'expo-web-browser',
    // Encrypted storage for the Spotify refresh token + online player_id.
    'expo-secure-store',
    // Startup splash: centered logo on the app's purple, consistent on iOS +
    // Android. `contain` + a modest imageWidth shows the logo small (the image
    // already includes the #1A0F3C surround), instead of stretching full-screen.
    [
      'expo-splash-screen',
      {
        image: './assets/icon.png',
        backgroundColor: '#1A0F3C',
        imageWidth: 200,
        resizeMode: 'contain',
      },
    ],
  ],
});
