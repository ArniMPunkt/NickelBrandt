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
import { glow } from '../theme/glow';

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

/**
 * A reduced trophy drawn as a thin gold OUTLINE from plain Views (no emoji, no
 * SVG dependency, no enclosing circle / halo) - the same approach as the
 * onboarding's TwoPhones. The cup is an outlined bowl with two open bracket
 * handles; the stem and stacked base are slim solid bars. It stands free on the
 * dark background; the "glow" is the iOS shadow plus a gentle breath pulse
 * (driven by the caller), so it pulses on its own without a dark backing disc.
 */
function Trophy() {
  return (
    <View style={styles.trophy}>
      <View style={styles.cupRow}>
        <View style={[styles.handle, styles.handleLeft]} />
        <View style={[styles.handle, styles.handleRight]} />
        <View style={styles.cup} />
      </View>
      <View style={styles.stem} />
      <View style={styles.baseTop} />
      <View style={styles.base} />
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
  // Staggered reveal: trophy lands first, then the label, then the name builds
  // in (its glow fades up with its opacity). The confetti underneath is ambient
  // and continuous, so it composes with the reveal without being touched.
  const trophyIn = useRef(new Animated.Value(0)).current;
  const labelIn = useRef(new Animated.Value(0)).current;
  const nameIn = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.spring(trophyIn, { toValue: 1, friction: 6, tension: 60, useNativeDriver: true }),
      Animated.timing(labelIn, {
        toValue: 1,
        duration: 260,
        delay: 60,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.spring(nameIn, {
        toValue: 1,
        friction: 5,
        tension: 55,
        delay: 40,
        useNativeDriver: true,
      }),
    ]).start();

    // Continuous, subtle breath - reads as a soft glow pulse, no halo needed.
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [trophyIn, labelIn, nameIn, pulse]);

  const trophyScale = trophyIn.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] });
  const pulseOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.82] });

  const labelTranslate = labelIn.interpolate({ inputRange: [0, 1], outputRange: [8, 0] });

  const nameScale = nameIn.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] });
  const nameTranslate = nameIn.interpolate({ inputRange: [0, 1], outputRange: [20, 0] });

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <Confetti />

      <View style={styles.center}>
        <Animated.View
          style={{
            opacity: Animated.multiply(trophyIn, pulseOpacity),
            transform: [{ scale: trophyScale }, { scale: pulseScale }],
          }}
        >
          <Trophy />
        </Animated.View>

        <Animated.Text
          style={[styles.label, { opacity: labelIn, transform: [{ translateY: labelTranslate }] }]}
        >
          GEWINNER
        </Animated.Text>

        <Animated.Text
          style={[
            styles.name,
            { opacity: nameIn, transform: [{ scale: nameScale }, { translateY: nameTranslate }] },
          ]}
          numberOfLines={2}
          adjustsFontSizeToFit
        >
          {winnerName}
        </Animated.Text>
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

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // --- Trophy: a free-standing gold outline (no circle, no halo) ---
  trophy: { alignItems: 'center', justifyContent: 'center', marginBottom: 34 },
  cupRow: { width: 60, alignItems: 'center', justifyContent: 'center' },
  cup: {
    width: 60,
    height: 46,
    backgroundColor: 'transparent',
    borderWidth: 3,
    borderColor: COLORS.accent,
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
    borderBottomLeftRadius: 26,
    borderBottomRightRadius: 26,
    ...glow(COLORS.accent, { radius: 12, opacity: 0.7 }),
  },
  // Open bracket handles ("(" / ")") hugging the cup sides - outline only.
  handle: {
    position: 'absolute',
    top: 6,
    width: 14,
    height: 26,
    borderColor: COLORS.accent,
    borderTopWidth: 3,
    borderBottomWidth: 3,
  },
  handleLeft: {
    left: -12,
    borderLeftWidth: 3,
    borderTopLeftRadius: 12,
    borderBottomLeftRadius: 12,
  },
  handleRight: {
    right: -12,
    borderRightWidth: 3,
    borderTopRightRadius: 12,
    borderBottomRightRadius: 12,
  },
  stem: { width: 7, height: 12, backgroundColor: COLORS.accent },
  baseTop: { width: 26, height: 6, borderRadius: 3, backgroundColor: COLORS.accent, marginTop: 1 },
  base: { width: 48, height: 9, borderRadius: 5, backgroundColor: COLORS.accent, marginTop: 3 },

  // --- Label: cyan, with clear separation above the free-standing name ---
  label: {
    fontSize: 14,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 6,
    marginBottom: 20,
  },

  // --- Winner name: free-standing text with a pink glow (wordmark style), no
  // container/pill. The glow fades up with the text's entrance opacity. ---
  name: {
    fontSize: 52,
    lineHeight: 56,
    fontWeight: '900',
    color: COLORS.primary,
    textAlign: 'center',
    letterSpacing: 0.5,
    paddingHorizontal: 8,
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 22,
  },

  btn: {
    alignSelf: 'stretch',
    minHeight: 60,
    backgroundColor: COLORS.secondary,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    ...glow(COLORS.secondary, { radius: 16, opacity: 0.8 }),
  },
  btnText: { color: COLORS.background, fontSize: 18, fontWeight: '900', letterSpacing: 1 },
});
