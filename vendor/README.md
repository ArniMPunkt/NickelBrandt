# vendor/

## SpotifyiOS.xcframework

Official Spotify iOS SDK **v5.0.1** (https://github.com/spotify/ios-sdk,
tag `v5.0.1`), vendored because react-native-spotify-remote@0.3.10 bundles
the ancient v1.2.1 fat `SpotifyiOS.framework`, which has no
arm64-iossimulator slice and therefore cannot link Simulator builds on
Apple Silicon (the old EXCLUDED_ARCHS/Rosetta workaround stopped working
with the iOS 26 simulator, which no longer installs x86_64 binaries).

How it gets used:
- `scripts/copy-spotify-xcframework.js` (run from `postinstall`) copies this
  xcframework into `node_modules/react-native-spotify-remote/ios/external/SpotifySDK/`
  and deletes the bundled v1.2.1 `SpotifyiOS.framework`. patch-package cannot
  carry binaries, hence the copy script.
- `patches/react-native-spotify-remote+0.3.10.patch` points the podspec's
  `vendored_frameworks` at the xcframework and adapts the Objective-C bridge
  to the v5.x API (`initiateSessionWithScope:options:campaign:`,
  framework-style `#import <SpotifyiOS/SpotifyiOS.h>` imports).

Updating: download a newer release tag from the repo above, replace the
`SpotifyiOS.xcframework` directory, verify the simulator slice with
`lipo -info vendor/SpotifyiOS.xcframework/ios-arm64_x86_64-simulator/SpotifyiOS.framework/SpotifyiOS`,
then rebuild (`npm install && npx expo prebuild --clean -p ios`).
