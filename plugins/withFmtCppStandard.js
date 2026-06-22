/**
 * Config plugin: sets CLANG_CXX_LANGUAGE_STANDARD = 'c++17' on the `fmt` pod.
 *
 * Without this, Xcode/Clang rejects `consteval` in fmt's format-inl.h when
 * building with C++14 (the default). This is a known upstream issue:
 * https://github.com/facebook/react-native/issues/55601
 *
 * The fix is injected into the Podfile's post_install block after prebuild so
 * it survives `expo prebuild --clean`.
 */

const { withDangerousMod } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

const FMT_FIX = [
  '',
  '    # fmt pod requires C++17 for consteval (Xcode/Clang compatibility fix).',
  '    installer.pods_project.targets.each do |target|',
  "      if target.name == 'fmt'",
  '        target.build_configurations.each do |build_config|',
  "          build_config.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'",
  '        end',
  '      end',
  '    end',
].join('\n');

function withFmtCppStandard(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf8');

      if (contents.includes("target.name == 'fmt'")) {
        return cfg; // already patched (e.g. incremental prebuild)
      }

      // Inject just before the closing `end` of the post_install block.
      // Generated Podfile ends with:  ")\n  end\nend\n"
      //   `)` closes react_native_post_install(...)
      //   first `end` closes `post_install do |installer|`
      //   second `end` closes `target 'NickelBrandt' do`
      const patched = contents.replace(/(\n  end\nend\n?)$/, FMT_FIX + '$1');

      if (patched === contents) {
        throw new Error(
          '[withFmtCppStandard] Could not find expected Podfile tail to inject fmt fix. ' +
            'The generated Podfile structure may have changed.'
        );
      }

      fs.writeFileSync(podfilePath, patched);
      return cfg;
    },
  ]);
}

module.exports = withFmtCppStandard;
