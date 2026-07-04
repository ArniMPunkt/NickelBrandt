/**
 * Expo config plugin: iOS crash diagnostics for the TestFlight launch crash.
 *
 * TestFlight/App Store Connect crash reports strip the NSException name and
 * reason - for a crash of the form "RCTModuleMethod invoke -> unhandled
 * exception -> RCTFatal" that is exactly the missing piece, because RCTFatal's
 * exception reason contains "Exception '<original>' was thrown while invoking
 * <method> on target <Module> with params <...>" - i.e. WHICH native module,
 * WHICH method and WHY.
 *
 * This plugin injects an NSSetUncaughtExceptionHandler into
 * AppDelegate.application(didFinishLaunchingWithOptions:) that persists the
 * exception (name, reason, first stack frames) to NSUserDefaults BEFORE the
 * process dies. On the next launch:
 *   - the stored record is NSLog'd immediately (visible in Console.app /
 *     Xcode with the device attached), and
 *   - the JS side (SettingsScreen) reads it via React Native's `Settings`
 *     module (same NSUserDefaults) and shows it in the Einstellungen tab.
 * UserDefaults survive app UPDATES, so even if the crashing build never gets
 * past startup, the record is readable in the first build that does.
 *
 * The handler is a NON-CAPTURING Swift closure (bridges to the required C
 * function pointer). iOS only; Android is untouched.
 */
const { withAppDelegate } = require('@expo/config-plugins');

const MARKER = 'NickelBrandt crash diagnostics';

const HANDLER_CODE = `
    // ${MARKER}: persist uncaught native exceptions so the next launch can
    // surface name/reason (TestFlight reports strip them). See
    // plugins/withCrashDiagnostics.js.
    if let last = UserDefaults.standard.string(forKey: "NBLastNativeCrash") {
      NSLog("[NickelBrandt] Letzter nativer Crash:\\n%@", last)
    }
    NSSetUncaughtExceptionHandler { exception in
      let stack = exception.callStackSymbols.prefix(15).joined(separator: "\\n")
      let record = "\\(Date())\\n\\(exception.name.rawValue): \\(exception.reason ?? "(kein Reason)")\\n\\(stack)"
      UserDefaults.standard.set(record, forKey: "NBLastNativeCrash")
      UserDefaults.standard.synchronize()
    }
`;

function addCrashHandler(contents) {
  if (contents.includes(MARKER)) return contents;

  // Anchor: the opening brace of didFinishLaunchingWithOptions. The generated
  // Expo AppDelegate.swift declares it across multiple lines, so match from
  // the parameter name to the first "-> Bool {".
  const anchor = /didFinishLaunchingWithOptions[\s\S]*?->\s*Bool\s*\{/;
  const match = contents.match(anchor);
  if (!match) {
    throw new Error(
      '[withCrashDiagnostics] Could not find application(didFinishLaunchingWithOptions:) ' +
        'in AppDelegate.swift - the generated AppDelegate structure may have changed.'
    );
  }
  const insertAt = match.index + match[0].length;
  return contents.slice(0, insertAt) + HANDLER_CODE + contents.slice(insertAt);
}

function withCrashDiagnostics(config) {
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error(
        `[withCrashDiagnostics] Expected a Swift AppDelegate, got "${cfg.modResults.language}".`
      );
    }
    cfg.modResults.contents = addCrashHandler(cfg.modResults.contents);
    return cfg;
  });
}

module.exports = withCrashDiagnostics;
