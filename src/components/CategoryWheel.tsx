/**
 * CategoryWheel - the Bingo category draw as a real spinning wheel (replaces the
 * old 3x4 tile-chase "Discokugel"). A round disc of four equal 90° colour
 * segments (one per category) spins under a fixed top pointer and decelerates
 * onto the PRE-DRAWN category.
 *
 * Same contract as the tile wheel it replaces, so the screen swaps it in 1:1:
 *  - `startedAt` null  -> idle disc at rest (no result shown yet)
 *  - `startedAt` set   -> spin, driven DETERMINISTICALLY off the shared
 *    spinStartedAt timestamp so every client shows the same landing, and a late
 *    joiner mid-spin catches up (elapsed = Date.now() - startedAt).
 *  - `category`        -> the pre-drawn result; the wheel only visualises it
 *    (the draw itself is uniform 1/4, decided server-side - see bingo.ts).
 *  - `onDone`          -> fired after the full spin window (incl. the result hold).
 *
 * Uses the built-in Animated API with useNativeDriver (the project standard - no
 * Reanimated/SVG dependency): the whole disc is ONE rotate transform on the
 * native driver, so it stays smooth on mid-range Android. No SVG needed - four
 * corner squares inside a circular (overflow-hidden) disc render as exact 90°
 * sectors.
 */
import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { BINGO_SPIN_MS } from '../game/bingo';
import { BINGO_CATEGORY_COLOR, COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import type { BingoCategoryType } from '../types/online';

const SIZE = 200;
const HUB = 46;

/** The wheel holds glowing on the result this long before onDone fires. */
const SPIN_HOLD_MS = 700;
/** Full turns before landing (visual only; the result is fixed up front). */
const SPINS = 5;
/** Idle offset: -45° puts a segment CENTRE (not a seam) under the pointer. */
const IDLE_DEG = -45;

// Each category owns one quadrant; the centre of that quadrant sits at this
// clockwise angle from the top (12 o'clock). These four fixed positions are what
// the landing maths targets. The quadrant->corner mapping in the JSX matches:
// 45=top-right, 135=bottom-right, 225=bottom-left, 315=top-left.
const CENTER_ANGLE: Record<BingoCategoryType, number> = {
  decade: 45,
  before_after_2000: 135,
  year_guess: 225,
  title_artist: 315,
};

/**
 * Final applied rotation (deg, clockwise) that lands `cat`'s segment centre under
 * the top pointer: SPINS full turns plus the offset that carries the idle
 * position to this category's centre. Derivation: screen angle of the centre is
 * CENTER_ANGLE[cat] + rotation; we want it ≡ 0 (mod 360) at the pointer, and the
 * disc rests at IDLE_DEG, so the extra travel is ((45 - CENTER_ANGLE) mod 360).
 */
function targetDeg(cat: BingoCategoryType): number {
  const delta = (((45 - CENTER_ANGLE[cat]) % 360) + 360) % 360;
  return IDLE_DEG + 360 * SPINS + delta;
}

export function CategoryWheel({
  startedAt,
  category,
  onDone,
}: {
  /** Shared trigger timestamp; null renders the wheel idle (pre-spin). */
  startedAt: number | null;
  category?: BingoCategoryType;
  onDone?: () => void;
}) {
  const rot = useRef(new Animated.Value(IDLE_DEG)).current;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (startedAt == null || !category) {
      rot.stopAnimation();
      rot.setValue(IDLE_DEG);
      return;
    }
    const finalDeg = targetDeg(category);
    const animMs = BINGO_SPIN_MS - SPIN_HOLD_MS;
    const elapsed = Date.now() - startedAt;

    if (elapsed >= animMs) {
      // Joined after the spin already finished -> hold on the result.
      rot.setValue(finalDeg);
    } else {
      // Pre-position proportionally so a mid-spin joiner doesn't snap back to 0,
      // then ease-out to the exact target over the remaining time.
      const startFrac = Math.max(0, elapsed / animMs);
      rot.setValue(IDLE_DEG + (finalDeg - IDLE_DEG) * startFrac);
      Animated.timing(rot, {
        toValue: finalDeg,
        duration: animMs - elapsed,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }

    // Fire onDone after the FULL spin window (spin + result hold), matching the
    // old wheel. JS timer, independent of the visual so it never over/under-runs.
    const toDone = BINGO_SPIN_MS - elapsed;
    const t = setTimeout(() => onDoneRef.current?.(), Math.max(0, toDone));
    return () => clearTimeout(t);
  }, [startedAt, category, rot]);

  const spin = rot.interpolate({
    inputRange: [0, 360],
    outputRange: ['0deg', '360deg'], // extrapolates past the range -> any angle
  });

  return (
    <View style={styles.wrap}>
      <View style={styles.pointer} />
      <View style={[styles.ring, glow(COLORS.primary, { radius: 16, opacity: 0.55 })]}>
        <Animated.View style={[styles.disc, { transform: [{ rotate: spin }] }]}>
          <View style={[styles.quad, styles.qTR, { backgroundColor: BINGO_CATEGORY_COLOR.decade }]} />
          <View style={[styles.quad, styles.qBR, { backgroundColor: BINGO_CATEGORY_COLOR.before_after_2000 }]} />
          <View style={[styles.quad, styles.qBL, { backgroundColor: BINGO_CATEGORY_COLOR.year_guess }]} />
          <View style={[styles.quad, styles.qTL, { backgroundColor: BINGO_CATEGORY_COLOR.title_artist }]} />
        </Animated.View>
        <View style={styles.hub}>
          <Text style={styles.hubGlyph}>🪩</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: SIZE,
    height: SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Downward triangle pinned to the top, tip touching the rim.
  pointer: {
    position: 'absolute',
    top: -4,
    zIndex: 3,
    width: 0,
    height: 0,
    borderLeftWidth: 12,
    borderRightWidth: 12,
    borderTopWidth: 20,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: COLORS.text,
  },
  ring: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: 4,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.backgroundAlt,
  },
  // Circular clip is rotation-invariant, so the disc stays round while spinning.
  disc: {
    width: SIZE - 8,
    height: SIZE - 8,
    borderRadius: (SIZE - 8) / 2,
    overflow: 'hidden',
  },
  // Each square fills one quadrant; the circular clip turns it into a 90° sector.
  // The 1px seam colour draws the two interior diameters (the outer edges fall
  // outside the circle and are clipped away).
  quad: {
    position: 'absolute',
    width: (SIZE - 8) / 2,
    height: (SIZE - 8) / 2,
    borderWidth: 1,
    borderColor: COLORS.background,
  },
  qTR: { top: 0, right: 0 },
  qBR: { bottom: 0, right: 0 },
  qBL: { bottom: 0, left: 0 },
  qTL: { top: 0, left: 0 },
  // Static centre hub (sits above the spinning disc, does not rotate).
  hub: {
    position: 'absolute',
    width: HUB,
    height: HUB,
    borderRadius: HUB / 2,
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 3,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hubGlyph: { fontSize: 22 },
});
