/**
 * BingoCountdown - the 3-2-1 "get ready" beat between the category wheel landing
 * and the round's song starting. Shows the just-revealed category, then a big
 * pulsing 3 -> 2 -> 1.
 *
 * Deterministic + cosmetic: driven off the shared start time (spinStartedAt +
 * BINGO_SPIN_MS) so every client counts together and a late joiner lands on the
 * right number. It does NOT control audio - the host starts the song when the
 * countdown ends (that trigger lives in BingoGameScreen). onDone lets the screen
 * advance to the answer UI. Same 3-2-1 UI/timing runs on round 1 too (just over
 * silence, since there is no previous song).
 *
 * Built with the built-in Animated API + useNativeDriver (project standard, no
 * Reanimated): each number pops via a native-driver scale/opacity spring.
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
// Shared server clock (see CategoryWheel): device clock skew must not shift
// the countdown relative to the other devices.
import { serverNow } from '../services/supabase';
import { bingoCategoryLabel, BINGO_COUNTDOWN_MS } from '../game/bingo';
import { BINGO_CATEGORY_COLOR, COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import type { BingoCategoryType, BingoDifficulty } from '../types/online';

const secondsLeft = (startAt: number) =>
  Math.max(0, Math.ceil((startAt + BINGO_COUNTDOWN_MS - serverNow()) / 1000));

export function BingoCountdown({
  startAt,
  category,
  difficulty,
  onDone,
}: {
  /** Absolute ms when the countdown began (spinStartedAt + BINGO_SPIN_MS). */
  startAt: number;
  category: BingoCategoryType;
  /** Game difficulty - two categories label differently in 'hard'. */
  difficulty?: BingoDifficulty;
  onDone?: () => void;
}) {
  const [remaining, setRemaining] = useState(() => secondsLeft(startAt));
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let done = false;
    const iv = setInterval(() => {
      const msLeft = startAt + BINGO_COUNTDOWN_MS - serverNow();
      setRemaining(Math.max(0, Math.ceil(msLeft / 1000)));
      if (msLeft <= 0 && !done) {
        done = true;
        clearInterval(iv);
        onDoneRef.current?.();
      }
    }, 100);
    return () => clearInterval(iv);
  }, [startAt]);

  // Clamp to the visible 3..1 range (0 is the instant we hand off to the song).
  const num = Math.min(3, Math.max(1, remaining));

  // Pop each new number: reset small + transparent, spring to full.
  const pop = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    pop.setValue(0.4);
    Animated.spring(pop, {
      toValue: 1,
      friction: 4,
      tension: 140,
      useNativeDriver: true,
    }).start();
  }, [num, pop]);

  const color = BINGO_CATEGORY_COLOR[category];
  const opacity = pop.interpolate({ inputRange: [0.4, 1], outputRange: [0, 1] });

  return (
    <View style={styles.wrap}>
      <Text style={styles.ready}>GLEICH GEHT'S LOS</Text>
      <View style={[styles.categoryPill, { borderColor: color }, glow(color, { radius: 12, opacity: 0.7 })]}>
        <Text style={[styles.categoryText, { color }]}>{bingoCategoryLabel(category, difficulty)}</Text>
      </View>
      <Animated.Text
        style={[
          styles.number,
          // Neon halo via textShadow (works on Android too, unlike the iOS-only
          // view glow()). Colour matches the category.
          { color, textShadowColor: color, opacity, transform: [{ scale: pop }] },
        ]}
      >
        {num}
      </Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', gap: 14, paddingVertical: 8 },
  ready: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 3,
  },
  categoryPill: {
    borderWidth: 2,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 8,
    backgroundColor: COLORS.backgroundAlt,
  },
  categoryText: { fontSize: 18, fontWeight: '900', letterSpacing: 0.5 },
  number: {
    fontSize: 96,
    fontWeight: '900',
    lineHeight: 108,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },
});
