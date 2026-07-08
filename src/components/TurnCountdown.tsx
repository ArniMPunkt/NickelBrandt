/**
 * TurnCountdown - cosmetic music-timer display (shared Hot-Seat/Online). Each
 * device computes the remaining time locally from an absolute deadline (same
 * idea as the steal-window bar: no continuous sync needed). Hidden until the
 * last 10 seconds, then a red countdown pill; after expiry a muted static hint.
 * The actual Spotify.pause() is triggered elsewhere (Hot-Seat effect / Online
 * host timer) - this component never controls playback.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
// Shared server clock: the deadline is serverNow()-based (Online: turnStartedAt
// written by the host; Hot-Seat: musicDeadline created with serverNow() too, so
// the offset cancels). Comparing against the raw device clock would shift the
// display by the device's clock skew on Online clients.
import { serverNow } from '../services/supabase';
import { COLORS } from '../theme/colors';

const SHOW_LAST_S = 10;

export function TurnCountdown({ deadlineMs }: { deadlineMs: number }) {
  const [remaining, setRemaining] = useState(() =>
    Math.ceil((deadlineMs - serverNow()) / 1000)
  );

  useEffect(() => {
    const iv = setInterval(() => {
      const r = Math.ceil((deadlineMs - serverNow()) / 1000);
      setRemaining(r);
      if (r <= 0) clearInterval(iv);
    }, 250);
    setRemaining(Math.ceil((deadlineMs - serverNow()) / 1000));
    return () => clearInterval(iv);
  }, [deadlineMs]);

  if (remaining > SHOW_LAST_S) return null;
  if (remaining <= 0) {
    return <Text style={styles.stopped}>🔇 Musik gestoppt — raten geht weiter!</Text>;
  }
  return (
    <View style={styles.pill}>
      <Text style={styles.pillText}>🔇 Musik stoppt in {remaining}s</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'center',
    borderRadius: 999,
    borderWidth: 2,
    borderColor: COLORS.incorrect,
    backgroundColor: COLORS.backgroundAlt,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  pillText: { color: COLORS.incorrect, fontWeight: '900', fontSize: 15, letterSpacing: 0.5 },
  stopped: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: '700',
    fontStyle: 'italic',
    textAlign: 'center',
  },
});
