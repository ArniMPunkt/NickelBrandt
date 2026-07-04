/**
 * Expo config plugin: iOS crash diagnostics for TestFlight launch crashes.
 *
 * TestFlight/App Store Connect crash reports strip the NSException name and
 * reason - for a crash of the form "RCTModuleMethod invoke -> unhandled
 * exception -> RCTFatal" that is exactly the missing piece, because RCTFatal's
 * exception reason contains "Exception '<original>' was thrown while invoking
 * <method> on target <Module> with params <...>" - i.e. WHICH native module,
 * WHICH method and WHY.
 *
 * This plugin injects an NSSetUncaughtExceptionHandler into
 * AppDelegate.application(didFinishLaunchingWithOptions:) that, BEFORE the
 * process aborts:
 *   1. persists the exception (name, reason, first stack frames) to
 *      NSUserDefaults (read by SettingsScreen via RN `Settings` - only useful
 *      when the app still reaches the UI, kept as secondary channel), and
 *   2. uploads the same record SYNCHRONOUSLY to the project's Supabase
 *      instance (INSERT into crash_reports via PostgREST, see migration 008).
 *      An uncaught-exception handler runs to completion before abort(), so a
 *      blocking wait is legitimate here: URLSession works on its own
 *      background queue while the crashing thread parks on a semaphore with a
 *      hard 5s cap (request itself capped at 4s). Every step is optional-
 *      guarded / try? so the handler can never throw or hang itself - a lost
 *      report is acceptable, a secondary crash is not. `Prefer: return=minimal`
 *      keeps the INSERT valid without any SELECT grant.
 *
 * The handler is a NON-CAPTURING Swift closure (bridges to the required C
 * function pointer) - Supabase URL/key are baked in as string LITERALS at
 * prebuild time from EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY (the same values
 * already shipped inside the JS bundle, so no new exposure). If the env vars
 * are missing at prebuild, the upload part is skipped with a loud warning and
 * only the UserDefaults handler is injected.
 *
 * iOS only; Android is untouched. Apple's own crash reporting is Mach/signal
 * level and unaffected by NSSetUncaughtExceptionHandler.
 */
const { withAppDelegate } = require('@expo/config-plugins');

const MARKER = 'NickelBrandt crash diagnostics';

/** Swift string literal (JSON escaping is a compatible subset). */
function swiftString(value) {
  return JSON.stringify(String(value));
}

function buildHandlerCode(supabaseUrl, anonKey) {
  const hasUpload = !!(supabaseUrl && anonKey);
  const endpoint = hasUpload
    ? swiftString(`${String(supabaseUrl).replace(/\/+$/, '')}/rest/v1/crash_reports`)
    : null;
  const key = hasUpload ? swiftString(anonKey) : null;

  const uploadBlock = hasUpload
    ? `
      // 2) Synchronous upload to Supabase BEFORE the process aborts. Literals
      //    only - the closure must stay capture-free (C function pointer).
      if let url = URL(string: ${endpoint}) {
        var model = utsname()
        uname(&model)
        let machine = withUnsafeBytes(of: &model.machine) { raw -> String in
          guard let base = raw.baseAddress else { return "unknown" }
          return String(cString: base.assumingMemoryBound(to: CChar.self))
        }
        let info = Bundle.main.infoDictionary
        let payload: [String: String] = [
          "app_version": (info?["CFBundleShortVersionString"] as? String) ?? "?",
          "build_number": (info?["CFBundleVersion"] as? String) ?? "?",
          "device_model": machine,
          "os_version": UIDevice.current.systemVersion,
          "exception_name": exception.name.rawValue,
          "exception_reason": exception.reason ?? "(kein Reason)",
          "stack_trace": stack,
        ]
        if let body = try? JSONSerialization.data(withJSONObject: payload) {
          var req = URLRequest(url: url, timeoutInterval: 4)
          req.httpMethod = "POST"
          req.httpBody = body
          req.setValue("application/json", forHTTPHeaderField: "Content-Type")
          req.setValue(${key}, forHTTPHeaderField: "apikey")
          req.setValue("Bearer " + ${key}, forHTTPHeaderField: "Authorization")
          req.setValue("return=minimal", forHTTPHeaderField: "Prefer")
          let sem = DispatchSemaphore(value: 0)
          URLSession.shared.dataTask(with: req) { _, _, _ in sem.signal() }.resume()
          // Hard cap: report delivered or dropped - never a hang on top of a crash.
          _ = sem.wait(timeout: .now() + 5)
        }
      }
`
    : '';

  return `
    // ${MARKER}: persist + upload uncaught native exceptions so the crash
    // cause (name/reason) is readable even when the app never reaches the UI
    // again (TestFlight reports strip it). See plugins/withCrashDiagnostics.js.
    if let last = UserDefaults.standard.string(forKey: "NBLastNativeCrash") {
      NSLog("[NickelBrandt] Letzter nativer Crash:\\n%@", last)
    }
    NSSetUncaughtExceptionHandler { exception in
      let stack = exception.callStackSymbols.prefix(25).joined(separator: "\\n")
      // 1) Local record first (fast, synchronous) - secondary channel.
      let record = "\\(Date())\\n\\(exception.name.rawValue): \\(exception.reason ?? "(kein Reason)")\\n\\(stack)"
      UserDefaults.standard.set(record, forKey: "NBLastNativeCrash")
      UserDefaults.standard.synchronize()
${uploadBlock}    }
`;
}

function ensureUIKitImport(contents) {
  if (/^\s*import UIKit\s*$/m.test(contents)) return contents;
  // Insert after the first import line.
  return contents.replace(/^import .*$/m, (line) => `${line}\nimport UIKit`);
}

function addCrashHandler(contents, handlerCode) {
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
  return contents.slice(0, insertAt) + handlerCode + contents.slice(insertAt);
}

function withCrashDiagnostics(config) {
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error(
        `[withCrashDiagnostics] Expected a Swift AppDelegate, got "${cfg.modResults.language}".`
      );
    }
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      console.warn(
        '[withCrashDiagnostics] EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY not set at ' +
          'prebuild time - crash reports will only be stored locally, NOT uploaded. ' +
          'Run prebuild with the .env loaded to enable the Supabase upload.'
      );
    }
    cfg.modResults.contents = ensureUIKitImport(cfg.modResults.contents);
    cfg.modResults.contents = addCrashHandler(
      cfg.modResults.contents,
      buildHandlerCode(supabaseUrl, anonKey)
    );
    return cfg;
  });
}

module.exports = withCrashDiagnostics;
