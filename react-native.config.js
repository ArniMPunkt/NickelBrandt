module.exports = {
  dependencies: {
    // SpotifyiOS.framework is a device-only binary (no simulator slices).
    // Spotify playback on iOS is deferred; exclude the native module from iOS
    // autolinking entirely so simulator builds don't fail at the linker step.
    // Android autolinking is unaffected by this entry.
    'react-native-spotify-remote': {
      platforms: {
        ios: null,
      },
    },
  },
};
