/**
 * AchievementUnlockedOverlay - the rare "besonderer Moment" fullscreen reveal
 * for a newly unlocked achievement: the player's very first achievement ever,
 * or a top-tier milestone (see SPECIAL_ACHIEVEMENT_IDS in
 * achievementDefinitions.ts). Every other unlock only shows in the compact
 * "Neue Erfolge" badge row on the stats screen - this is deliberately rare,
 * so it stays a moment rather than routine.
 *
 * Absolutely positioned on top of whatever the caller already renders (no
 * navigation route needed) - drop it in right before the stats view, gated
 * on a single achievement to show. Same visual language as VictoryCelebration
 * (dark background, neon glow) but shaped as a centered card, like
 * ConfirmDialog/ReportSongDialog, since this is a lighter/secondary moment
 * than winning the whole match. No sound (Spotify owns the audio session).
 * Tap anywhere to continue.
 */
import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import type { AchievementDefinition } from '../services/achievementDefinitions';

export function AchievementUnlockedOverlay({
  achievement,
  onContinue,
}: {
  achievement: AchievementDefinition;
  onContinue: () => void;
}) {
  const insets = useSafeAreaInsets();
  const scale = useRef(new Animated.Value(0.7)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, friction: 6, tension: 60, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }, [scale, opacity]);

  return (
    <Pressable
      style={[styles.backdrop, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
      onPress={onContinue}
    >
      <Animated.View style={[styles.card, { opacity, transform: [{ scale }] }]}>
        <Text style={styles.eyebrow}>NEUER ERFOLG</Text>
        <Text style={styles.icon}>{achievement.icon}</Text>
        <Text style={styles.name} numberOfLines={2}>
          {achievement.name}
        </Text>
        <Text style={styles.description}>{achievement.description}</Text>
        <Text style={styles.hint}>Antippen zum Fortfahren</Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    zIndex: 50,
    elevation: 50,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 2,
    borderColor: COLORS.accent,
    borderRadius: 24,
    paddingVertical: 32,
    paddingHorizontal: 24,
    alignItems: 'center',
    gap: 8,
    ...glow(COLORS.accent, { radius: 24, opacity: 0.8 }),
  },
  eyebrow: { color: COLORS.secondary, fontSize: 13, fontWeight: '800', letterSpacing: 4 },
  icon: { fontSize: 72, marginVertical: 8 },
  name: {
    fontSize: 26,
    fontWeight: '900',
    color: COLORS.text,
    textAlign: 'center',
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 16,
  },
  description: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textMuted,
    textAlign: 'center',
    marginTop: 2,
  },
  hint: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.textMuted,
    marginTop: 16,
    fontStyle: 'italic',
  },
});
