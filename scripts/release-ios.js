/**
 * iOS-Release-Pipeline mit Env-Guard (ersetzt die reine npm-Befehlskette).
 *
 * Warum ein Wrapper-Script statt `check && build`-Kette:
 * `eas build --local` packt das Projekt als git-Archiv — die gitignorte .env
 * landet NIE im Build-Arbeitsverzeichnis. Der EAS-Lokalbuild erbt stattdessen
 * die Prozess-Umgebung von eas-cli (verifiziert: eas-cli-local-build-plugin
 * spreadet `...process.env`). eas-cli selbst laedt keine .env. Ohne diesen
 * Wrapper wuerden die EXPO_PUBLIC_*-Werte beim Metro-Bundling im
 * Temp-Arbeitsverzeichnis fehlen und als undefined ins Production-Bundle
 * eingebacken -> stiller, halb-funktionierender Build (Supabase/Spotify tot).
 *
 * Dieses Script:
 *  1. laedt .env mit @expo/env (exakt derselbe Loader wie `expo prebuild`,
 *     inkl. .env.local-Praezedenz) in process.env,
 *  2. bricht LAUT ab, wenn eine Pflichtvariable fehlt oder leer ist,
 *  3. fuehrt erst dann prebuild -> eas build --local -> eas submit aus,
 *     jeweils mit der angereicherten Umgebung (stdio inherit, d.h. die
 *     interaktiven Prompts von eas submit funktionieren unveraendert).
 *
 * Aufruf: npm run release:ios   (nur Check: node scripts/release-ios.js --check)
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const IPA = 'NickelBrandt.ipa';

// Pflichtvariablen aus .env — muessen zum Bundle-Zeitpunkt gesetzt sein.
// Bei neuen EXPO_PUBLIC_*-Variablen hier ergaenzen.
const REQUIRED_ENV_VARS = [
  'EXPO_PUBLIC_SPOTIFY_CLIENT_ID',
  'EXPO_PUBLIC_SPOTIFY_REDIRECT_URI',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
];

// 1) .env laden — mutiert process.env, loggt "env: load .env".
//    NODE_ENV=production: gleiche Env-Datei-Auswahl wie das Release-Bundling
//    (wuerde auch eine kuenftige .env.production korrekt beruecksichtigen).
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
require(path.join(projectRoot, 'node_modules', '@expo/env')).load(projectRoot);

// 2) Pflichtvariablen pruefen (Werte nie ausgeben, nur Namen).
const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error('\n❌ RELEASE ABGEBROCHEN — fehlende/leere Pflicht-Env-Variablen:\n');
  for (const name of missing) console.error(`   - ${name}`);
  console.error(
    '\nDiese Werte werden beim Bundling fest ins JS-Bundle eingebacken.' +
      '\nBitte in .env im Projekt-Root eintragen und erneut starten.\n'
  );
  process.exit(1);
}
console.log(`✅ Env-Check OK (${REQUIRED_ENV_VARS.length} Pflichtvariablen gesetzt).`);

if (process.argv.includes('--check')) process.exit(0);

// 3) Pipeline — bricht beim ersten Fehler ab. Kinder erben die angereicherte
//    Umgebung; eas build --local reicht sie bis ins Temp-Arbeitsverzeichnis
//    durch (prebuild + expo export:embed sehen die EXPO_PUBLIC_*-Werte).
fs.rmSync(path.join(projectRoot, IPA), { force: true });

const steps = [
  ['npx', ['expo', 'prebuild', '--platform', 'ios', '--clean']],
  ['eas', ['build', '--platform', 'ios', '--local', '--profile', 'production', '--output', `./${IPA}`]],
  ['eas', ['submit', '--platform', 'ios', '--path', `./${IPA}`]],
];

for (const [cmd, args] of steps) {
  console.log(`\n▶ ${cmd} ${args.join(' ')}`);
  const { status, error } = spawnSync(cmd, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (error) {
    console.error(`❌ ${cmd} konnte nicht gestartet werden: ${error.message}`);
    process.exit(1);
  }
  if (status !== 0) {
    console.error(`❌ Schritt fehlgeschlagen (Exit ${status}) — Release abgebrochen.`);
    process.exit(status ?? 1);
  }
}

console.log('\n✅ Release-Pipeline vollständig durchgelaufen.');
