/**
 * PoolIcon - a themed pool's icon (song_pools.icon_url, maintained manually in
 * the Supabase dashboard) with the app's classic 🎵 glyph as fallback. Used by
 * every surface that shows a pool thumbnail (picker row, "Ausgewählt" cards in
 * Setup/Lobby).
 *
 * Fallback covers all three cases identically: no icon_url yet (every existing
 * pool until Arni adds icons), a broken/unreachable URL (Image onError - never
 * a broken-image placeholder), and the moment before a URL loads.
 */
import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { COLORS } from '../theme/colors';

export function PoolIcon({
  iconUrl,
  size = 56,
}: {
  iconUrl?: string | null;
  /** Square edge length in dp (picker: 56, selected cards: 52). */
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  // A changed URL (e.g. corrected in the dashboard) gets a fresh attempt.
  useEffect(() => setFailed(false), [iconUrl]);

  const box = { width: size, height: size, borderRadius: 10 };
  if (iconUrl && !failed) {
    return (
      <Image source={{ uri: iconUrl }} style={box} onError={() => setFailed(true)} />
    );
  }
  return (
    <View style={[box, styles.fallback]}>
      <Text style={[styles.glyph, { fontSize: Math.round(size / 2) }]}>🎵</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { color: COLORS.border },
});
