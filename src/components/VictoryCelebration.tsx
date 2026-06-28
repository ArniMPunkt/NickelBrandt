/**
 * VictoryCelebration - the shared, standalone victory screen shown BEFORE the
 * statistics page in both modes (Hot-Seat + "Mit Freunden"). Big pink-glow winner
 * name, neon confetti, and a "Weiter zur Statistik" button.
 *
 * Confetti uses the built-in React Native Animated API (no extra dependency).
 * Purely presentational: parents pass the winner name + an onContinue handler.
 */
import { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../theme/colors';

const CONFETTI_COLORS = [COLORS.primary, COLORS.secondary, COLORS.accent, COLORS.correct];
const PIECE_COUNT = 28;

type PieceCfg = {
  key: number;
  left: number;
  size: number;
  color: string;
  duration: number;
  sway: number;
  spins: number;
  phase: number; // 0..1 initial position so pieces are spread out (no startup gap)
};

function ConfettiPiece({ cfg, height }: { cfg: PieceCfg; height: number }) {
  const t = useRef(new Animated.Value(cfg.phase)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.timing(t, {
        toValue: 1,
        duration: cfg.duration,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    anim.start();
    return () => anim.stop();
  }, [t, cfg.duration]);

  const translateY = t.interpolate({ inputRange: [0, 1], outputRange: [-40, height + 40] });
  const translateX = t.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, cfg.sway, 0] });
  const rotate = t.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${cfg.spins * 360}deg`] });
  const opacity = t.interpolate({ inputRange: [0, 0.06, 0.9, 1], outputRange: [0, 1, 1, 0] });

  return (
    <Animated.View
      style={[
        styles.piece,
        {
          left: cfg.left,
          width: cfg.size,
          height: cfg.size * 0.55,
          backgroundColor: cfg.color,
          opacity,
          transform: [{ translateY }, { translateX }, { rotate }],
        },
      ]}
    />
  );
}

function Confetti() {
  const { width, height } = useWindowDimensions();
  const pieces = useMemo<PieceCfg[]>(
    () =>
      Array.from({ length: PIECE_COUNT }).map((_, i) => ({
        key: i,
        left: Math.random() * width,
        size: 8 + Math.random() * 8,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        duration: 2600 + Math.random() * 2400,
        sway: (Math.random() - 0.5) * 90,
        spins: 1 + Math.floor(Math.random() * 3),
        phase: Math.random(),
      })),
    [width]
  );
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {pieces.map((cfg) => (
        <ConfettiPiece key={cfg.key} cfg={cfg} height={height} />
      ))}
    </View>
  );
}

export function VictoryCelebration({
  winnerName,
  onContinue,
}: {
  winnerName: string;
  onContinue: () => void;
}) {
  const insets = useSafeAreaInsets();
  const pop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(pop, { toValue: 1, friction: 5, tension: 55, useNativeDriver: true }).start();
  }, [pop]);

  const scale = pop.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });
  const translateY = pop.interpolate({ inputRange: [0, 1], outputRange: [28, 0] });
  const glowOpacity = pop.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0.5, 0.85] });

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <Confetti />

      <View style={styles.center}>
        <Text style={styles.trophy}>🏆</Text>
        <Text style={styles.label}>GEWINNER</Text>
        <Animated.View style={[styles.nameWrap, { opacity: pop, transform: [{ scale }, { translateY }] }]}>
          <Animated.View style={[styles.nameGlow, { opacity: glowOpacity }]} />
          <Text style={styles.name} numberOfLines={2} adjustsFontSizeToFit>
            {winnerName}
          </Text>
        </Animated.View>
      </View>

      <Pressable style={styles.btn} onPress={onContinue}>
        <Text style={styles.btnText}>WEITER ZUR STATISTIK</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.background,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  piece: { position: 'absolute', top: 0, borderRadius: 2 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  trophy: { fontSize: 76, textAlign: 'center' },
  label: {
    fontSize: 14,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 4,
  },
  nameWrap: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  nameGlow: {
    position: 'absolute',
    width: 240,
    height: 120,
    borderRadius: 999,
    backgroundColor: COLORS.primary,
  },
  name: {
    fontSize: 52,
    lineHeight: 56,
    fontWeight: '900',
    color: COLORS.primary,
    textAlign: 'center',
    letterSpacing: 0.5,
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 24,
  },

  btn: {
    alignSelf: 'stretch',
    minHeight: 60,
    backgroundColor: COLORS.secondary,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.secondary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 16,
    elevation: 10,
  },
  btnText: { color: COLORS.background, fontSize: 18, fontWeight: '900', letterSpacing: 1 },
});
