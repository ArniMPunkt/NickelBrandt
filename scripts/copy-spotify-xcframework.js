/**
 * Copies the vendored SpotifyiOS.xcframework (v5.0.1, see vendor/README.md)
 * into react-native-spotify-remote's SpotifySDK directory and removes the
 * bundled v1.2.1 fat SpotifyiOS.framework it replaces.
 *
 * Runs from "postinstall" AFTER patch-package: the patched
 * RNSpotifyRemote.podspec references the xcframework this script provides.
 * patch-package cannot transport binary files, hence this extra step.
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const source = path.join(projectRoot, 'vendor', 'SpotifyiOS.xcframework');
const sdkDir = path.join(
  projectRoot,
  'node_modules',
  'react-native-spotify-remote',
  'ios',
  'external',
  'SpotifySDK'
);
const target = path.join(sdkDir, 'SpotifyiOS.xcframework');
const legacyFramework = path.join(sdkDir, 'SpotifyiOS.framework');

if (!fs.existsSync(source)) {
  console.error(`[copy-spotify-xcframework] Missing ${source} — was vendor/ checked out?`);
  process.exit(1);
}
if (!fs.existsSync(sdkDir)) {
  // react-native-spotify-remote not installed (e.g. pruned install); nothing to do.
  console.log('[copy-spotify-xcframework] react-native-spotify-remote not present, skipping.');
  process.exit(0);
}

// Fresh copy every run (idempotent, survives package reinstalls).
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });

// Drop the bundled v1.2.1 framework so its stale headers can never be picked
// up again (the patched podspec no longer references it).
fs.rmSync(legacyFramework, { recursive: true, force: true });

console.log('[copy-spotify-xcframework] SpotifyiOS.xcframework v5.0.1 in place.');
