// Keep react-native-spotify-remote autolinked on both Android and iOS.
//
// iOS Spotify Remote validation must happen on a real device/TestFlight build:
// the bundled SpotifyiOS.framework is known to be device-oriented, so simulator
// linker issues are not a reason to globally disable iOS autolinking again.
//
// The package's own react-native.config.js only declares Android, so we provide
// the iOS podspec path here to make RNSpotifyRemote show up in generated iOS
// autolinking output.
module.exports = {
  dependencies: {
    'react-native-spotify-remote': {
      platforms: {
        ios: {
          podspecPath:
            'node_modules/react-native-spotify-remote/RNSpotifyRemote.podspec',
        },
      },
    },
  },
};
