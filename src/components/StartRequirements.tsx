/**
 * StartRequirements - shared start-button gating for the Party lobby (all
 * three modes) and the Pass & Play setup.
 *
 * missingRequirements() is the single source of truth for "may the game
 * start?": it returns the list of unmet prerequisites (empty = start allowed).
 * StartRequirementsHint renders that list as a QUIET checklist under the
 * disabled start button - an unfinished setup is a normal in-between state,
 * not an error, so no red box (real failures keep the screens' error boxes).
 */
import { StyleSheet, Text, View } from 'react-native';
import { COLORS } from '../theme/colors';

export function missingRequirements(opts: {
  /** Players present (lobby roster) / fields with a non-empty name (setup). */
  playerCount: number;
  /** 2 in every current mode (hitster / bingo / timeline_quiz / Pass & Play). */
  minPlayers: number;
  /** Setup only: enough players, but some name fields are still empty. */
  unnamedPlayers?: boolean;
  hasSource: boolean;
  /**
   * Static Spotify gate (Pass & Play setup keeps one). The lobby deliberately
   * does NOT pass this: its check runs at press time via the self-healing
   * ensureReadyToPlay gate, so a stale "disconnected" flag never locks the
   * button even though a silent reconnect would succeed.
   */
  spotifyReady?: boolean;
}): string[] {
  const missing: string[] = [];
  if (opts.playerCount < opts.minPlayers) {
    missing.push(`Mindestens ${opts.minPlayers} Spieler`);
  } else if (opts.unnamedPlayers) {
    missing.push('Alle Spielernamen eingeben');
  }
  if (!opts.hasSource) missing.push('Songpool wählen');
  if (opts.spotifyReady === false) {
    missing.push('Mit Spotify verbinden (Tab „Einstellungen")');
  }
  return missing;
}

/** Quiet checklist of everything still missing before the game can start. */
export function StartRequirementsHint({ missing }: { missing: string[] }) {
  if (missing.length === 0) return null;
  return (
    <View style={styles.box}>
      <Text style={styles.title}>BEVOR ES LOSGEHT</Text>
      {missing.map((m) => (
        <Text key={m} style={styles.item}>
          ○  {m}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    marginTop: 10,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: COLORS.border,
    borderStyle: 'dashed',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 6,
  },
  title: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 2,
  },
  item: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
});
