/**
 * CategoryWheel - the Bingo category draw as a real spinning wheel (replaces the
 * old 3x4 tile-chase "Discokugel"). A round disc of EIGHT equal 45° colour
 * segments - each of the four category colours appears twice - spins under a
 * fixed top pointer and decelerates onto the PRE-DRAWN category.
 *
 * Same contract as the tile wheel it replaces, so the screen swaps it in 1:1:
 *  - `startedAt` null  -> idle disc at rest (no result shown yet)
 *  - `startedAt` set   -> spin, driven DETERMINISTICALLY off the shared
 *    spinStartedAt timestamp so every client shows the same landing, and a late
 *    joiner mid-spin catches up (elapsed = Date.now() - startedAt).
 *  - `category`        -> the pre-drawn result; the wheel only visualises it
 *    (the draw itself is uniform 1/4, decided server-side - see bingo.ts). With
 *    two same-colour segments, WHICH one it lands on is derived from the shared
 *    startedAt (never a local random), so every client lands identically.
 *  - `onDone`          -> fired after the full spin window (incl. the result hold).
 *
 * Uses the built-in Animated API with useNativeDriver (the project standard - no
 * Reanimated/SVG dependency): the whole disc is ONE rotate transform on the
 * native driver, so it stays smooth on mid-range Android. No SVG needed - eight
 * border-triangles (apex at the centre, 45° apex angle) inside a circular
 * (overflow-hidden) disc render as exact 45° sectors: each triangle's straight
 * sides are radial (the sector edges) and meet its neighbours seamlessly, while
 * the parts that overshoot the rim are clipped away by the circular disc.
 */
import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { BINGO_CATEGORIES, BINGO_SPIN_MS } from '../game/bingo';
import { BINGO_CATEGORY_COLOR, COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import type { BingoCategoryType } from '../types/online';

const SIZE = 200;
const HUB = 46;
const DISC = SIZE - 8;
const R = DISC / 2;
// 45° apex triangle: height just past the rim (so the sector reaches the arc),
// half-base = height * tan(22.5°) makes the apex angle exactly 45°.
const TRI_H = R + 4;
const TRI_HALF = TRI_H * Math.tan(Math.PI / 8);

/** The wheel holds glowing on the result this long before onDone fires. */
const SPIN_HOLD_MS = 700;
/** Full turns before landing (visual only; the result is fixed up front). */
const SPINS = 5;
/** Disc rests at 0°: segment 0's CENTRE (not a seam) sits under the pointer. */
const IDLE_DEG = 0;

// The eight segments, clockwise from the top pointer. Each category colour twice,
// interleaved so the two same-colour segments sit diametrically opposite (k and
// k+4) and no two neighbours share a colour - maximum visible variance. Segment k
// is centred at k*45° (segWrap k is statically pre-rotated by that; the disc's
// animated rotation spins them all together).
const SEGMENTS: BingoCategoryType[] = [
  'decade', 'before_after_2000', 'year_guess', 'title_artist',
  'decade', 'before_after_2000', 'year_guess', 'title_artist',
];

/**
 * Final applied rotation (deg, clockwise) that lands the chosen segment's centre
 * under the top pointer. The category owns two segments - indices idx and idx+4
 * (idx = its position in BINGO_CATEGORIES) - centred at their index*45°. `pick`
 * (0/1) selects which; the screen angle of that centre is centreAngle + rotation,
 * which we want ≡ 0 (mod 360) at the pointer, so rotation ≡ -centreAngle, plus
 * SPINS full turns for the spin.
 */
function targetDeg(cat: BingoCategoryType, pick: 0 | 1): number {
  const idx = BINGO_CATEGORIES.indexOf(cat); // 0..3
  const centreAngle = (idx + 4 * pick) * 45; // one of the category's two segments
  const delta = (((-centreAngle) % 360) + 360) % 360;
  return IDLE_DEG + 360 * SPINS + delta;
}

/**
 * Which of the two same-colour segments to land on - DETERMINISTIC and identical
 * on every client, derived from the shared spinStartedAt (never Math.random,
 * which would differ per device). Parity of the start second alternates the
 * choice round to round for variety.
 */
function pickSegment(startedAt: number): 0 | 1 {
  return (Math.floor(startedAt / 1000) % 2 === 0 ? 0 : 1);
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
    const finalDeg = targetDeg(category, pickSegment(startedAt));
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
          {SEGMENTS.map((seg, k) => (
            // Each wrapper fills the disc (so it pivots around the disc centre)
            // and is pre-rotated k*45°; its triangle points up (segment 0) before
            // that rotation, so it ends up centred at k*45°.
            <View key={k} style={[styles.segWrap, { transform: [{ rotate: `${k * 45}deg` }] }]}>
              <View style={[styles.tri, { borderTopColor: BINGO_CATEGORY_COLOR[seg] }]} />
            </View>
          ))}
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
    width: DISC,
    height: DISC,
    borderRadius: DISC / 2,
    overflow: 'hidden',
  },
  // Full-disc layer, pivots around the disc centre when rotated.
  segWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: DISC,
    height: DISC,
  },
  // 45° border-triangle, apex at the disc centre, pointing up (base at the rim).
  // The circular disc clips the overshoot into an exact 45° sector.
  tri: {
    position: 'absolute',
    left: R - TRI_HALF,
    top: R - TRI_H,
    width: 0,
    height: 0,
    borderStyle: 'solid',
    borderLeftWidth: TRI_HALF,
    borderRightWidth: TRI_HALF,
    borderTopWidth: TRI_H,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
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
