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
  version: '1.0.0',
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
  },
  android: {
    package: 'com.nickelbrandt.app',
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    favicon: './assets/favicon.png',
  },
  plugins: [
    ['./plugins/withSpotifyRemote', { redirectUri: SPOTIFY_REDIRECT_URI }],
    // Needed by expo-auth-session (PKCE Web-API auth) to complete the redirect.
    'expo-web-browser',
    // Encrypted storage for the Spotify refresh token + online player_id.
    'expo-secure-store',
  ],
});
