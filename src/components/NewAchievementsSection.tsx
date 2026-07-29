/**
 * NewAchievementsSection - "🏆 Neue Erfolge" banner shown once at the top of
 * a stats/result screen when recordMatchResult() surfaced newly unlocked
 * achievements this match. Compact badges (icon circle + name + "NEU" tag),
 * each popping in with a staggered scale+fade (~120ms offset per badge),
 * once on mount. Renders nothing when the list is empty - callers don't need
 * to gate it themselves.
 */
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import type { AchievementDefinition } from '../services/achievementDefinitions';

const STAGGER_MS = 120;

function Badge({ achievement, index }: { achievement: AchievementDefinition; index: number }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(anim, {
      toValue: 1,
      friction: 6,
      tension: 70,
      delay: index * STAGGER_MS,
      useNativeDriver: true,
    }).start();
    // Runs once on mount only - the stagger is a one-time entrance, not tied
    // to prop changes (the badge list itself never changes after mount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });

  return (
    <Animated.View style={[styles.badge, { opacity: anim, transform: [{ scale }] }]}>
      <View style={styles.iconCircle}>
        <Text style={styles.icon}>{achievement.icon}</Text>
      </View>
      <Text style={styles.name} numberOfLines={2}>
        {achievement.name}
      </Text>
      <View style={styles.newTag}>
        <Text style={styles.newTagText}>NEU</Text>
      </View>
    </Animated.View>
  );
}

export function NewAchievementsSection({
  achievements,
}: {
  achievements: AchievementDefinition[];
}) {
  if (achievements.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.title}>🏆 Neue Erfolge</Text>
      <View style={styles.row}>
        {achievements.map((a, i) => (
          <Badge key={a.id} achievement={a} index={i} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10, marginBottom: 4 },
  title: { color: COLORS.accent, fontSize: 16, fontWeight: '900', letterSpacing: 0.5 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  badge: {
    width: 92,
    alignItems: 'center',
    gap: 4,
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: 10,
    paddingHorizontal: 6,
  },
  iconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.background,
    borderWidth: 2,
    borderColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...glow(COLORS.accent, { radius: 10, opacity: 0.6 }),
  },
  icon: { fontSize: 24 },
  name: { color: COLORS.text, fontSize: 11, fontWeight: '800', textAlign: 'center' },
  newTag: {
    backgroundColor: COLORS.primary,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  newTagText: { color: COLORS.text, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
});
