/**
 * CategoryWheel - the Bingo category draw as a real spinning wheel (replaces the
 * old 3x4 tile-chase "Discokugel"). A round disc of TWO segments per category -
 * so every category colour appears twice - spins under a fixed top pointer and
 * decelerates onto the PRE-DRAWN category.
 *
 * The disc is FLUNG BY FINGER (drag/swipe/flick on the disc itself); the tap
 * button in the screen is only the fallback for devices where the gesture
 * doesn't take. Gesture strength and direction shape the ANIMATION (direction,
 * number of turns, how fast it glides) - never the result:
 *
 *  - `startedAt` null  -> idle disc at rest (no result shown yet); when
 *    `interactive` is set, the disc can be dragged and flung here.
 *  - `startedAt` set   -> land on the result, driven DETERMINISTICALLY off the
 *    shared spinStartedAt timestamp so every client shows the same landing, and
 *    a late joiner mid-spin catches up (elapsed = serverNow() - startedAt).
 *  - `category`        -> the pre-drawn result; the wheel only visualises it
 *    (the draw itself is uniform 1/n, decided server-side - see bingo.ts). With
 *    two same-colour segments, WHICH one it lands on is derived from the shared
 *    startedAt (never a local random), so every client lands identically.
 *  - `onDone`          -> fired after the full spin window (incl. the result hold).
 *
 * WHY the landing still matches everywhere despite a per-device gesture: the
 * final rotation is only ever chosen from the angles CONGRUENT MOD 360 to the
 * result angle (see `landing`). Turn count and sign differ per device, the
 * segment under the pointer cannot.
 *
 * Responsiveness: the flinging device starts a local decay the instant the
 * finger leaves the glass and only then asks the server for the shared
 * timestamp - the wheel is already moving while that round trip is in flight
 * (it used to sit still through ~3 sequential network calls before the first
 * frame). When the timestamp arrives the decay is taken over mid-motion by the
 * timed landing, so the hand-off is invisible.
 *
 * Uses the built-in Animated API with useNativeDriver (the project standard - no
 * Reanimated/SVG dependency): the whole disc is ONE rotate transform on the
 * native driver, so it stays smooth on mid-range Android. Gesture handling is
 * PanResponder (also built in - the project has no gesture-handler dependency).
 * No SVG needed - border-triangles (apex at the centre, SEG_DEG apex angle)
 * inside a circular (overflow-hidden) disc render as exact sectors: each
 * triangle's straight sides are radial (the sector edges) and meet its
 * neighbours seamlessly, while the parts that overshoot the rim are clipped
 * away by the circular disc.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, PanResponder, StyleSheet, Text, View } from 'react-native';
// Shared server clock: spinStartedAt is compared against serverNow(), never the
// raw device clock - device clock skew (e.g. a drifted emulator) used to skip
// or stretch the animation by many seconds on individual devices.
import { serverNow } from '../services/supabase';
import { BINGO_CATEGORIES, BINGO_SPIN_MS } from '../game/bingo';
import { BINGO_CATEGORY_COLOR, COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import type { BingoCategoryType } from '../types/online';

const SIZE = 200;
const HUB = 46;
const DISC = SIZE - 8;
const R = DISC / 2;
// Two segments per category; the geometry below derives from this count, so
// the wheel adapts if the category set ever changes again.
const SEG_COUNT = BINGO_CATEGORIES.length * 2;
const SEG_DEG = 360 / SEG_COUNT;
// Sector triangle: height just past the rim (so the sector reaches the arc),
// half-base = height * tan(SEG_DEG/2) makes the apex angle exactly SEG_DEG.
const TRI_H = R + 4;
const TRI_HALF = TRI_H * Math.tan(Math.PI / SEG_COUNT);

/** The wheel holds glowing on the result this long before onDone fires. */
const SPIN_HOLD_MS = 600;
/** Full turns before landing when NOBODY flung locally (watchers, late
 *  joiners, the tap fallback): visual only, the result is fixed up front. */
const SPINS = 4;
/** Disc rests at 0°: segment 0's CENTRE (not a seam) sits under the pointer. */
const IDLE_DEG = 0;

// --- Gesture thresholds -----------------------------------------------------
/** Below this release speed (deg/ms) a flick doesn't count as a spin. */
const MIN_FLING_VEL = 0.3;
/** ...unless the disc was deliberately dragged at least this far (deg). */
const MIN_DRAG_DEG = 90;
/** Release speed that counts as "full power" for the bonus-turn scale. */
const MAX_FLING_VEL = 2.5;
/** Fling samples older than this don't count towards the release velocity -
 *  a finger that stops before lifting must read as a slow release, not a flick. */
const VEL_WINDOW_MS = 120;
/** Touches nearer than this to the hub give a hopelessly noisy angle. */
const DEAD_ZONE_PX = 24;
/** Glide decay while the server timestamp is still in flight. */
const DECAY_RATE = 0.996;
/** Minimum visible glide speed, so a slow-but-long drag still moves on release. */
const MIN_GLIDE_VEL = 0.6;
/** Re-arm the gesture if the spin request produced no shared timestamp in this
 *  time (write rejected/lost) - nobody may end up with a dead wheel. */
const REARM_AFTER_MS = 4000;
/** Fastest turn rate the landing animation is allowed to ask for (ms/turn);
 *  caps the bonus turns when little animation time is left (slow network). */
const MIN_MS_PER_TURN = 450;

// The segments, clockwise from the top pointer: the category rotation twice,
// so the two same-colour segments sit diametrically opposite (k and
// k + BINGO_CATEGORIES.length) and no two neighbours share a colour - maximum
// visible variance. Segment k is centred at k*SEG_DEG (segWrap k is statically
// pre-rotated by that; the disc's animated rotation spins them all together).
const SEGMENTS: BingoCategoryType[] = [...BINGO_CATEGORIES, ...BINGO_CATEGORIES];

/**
 * The applied rotation (deg, clockwise), REDUCED TO [0,360), that lands the
 * chosen segment's centre under the top pointer. The category owns two segments
 * - indices idx and idx + BINGO_CATEGORIES.length (idx = its position in
 * BINGO_CATEGORIES) - centred at their index*SEG_DEG. `pick` (0/1) selects
 * which; the screen angle of that centre is centreAngle + rotation, which we
 * want ≡ 0 (mod 360) at the pointer, so rotation ≡ -centreAngle.
 *
 * Every actually applied final rotation is this value plus a whole number of
 * turns - that is the invariant that keeps all devices on the same segment.
 */
function residueDeg(cat: BingoCategoryType, pick: 0 | 1): number {
  const idx = BINGO_CATEGORIES.indexOf(cat);
  const centreAngle = (idx + BINGO_CATEGORIES.length * pick) * SEG_DEG;
  return (((-centreAngle) % 360) + 360) % 360;
}

/**
 * The landing rotation: the nearest angle ≡ residue (mod 360) that is at least
 * `turns` full turns away from `from` in direction `dir` (+1 clockwise, -1
 * counter-clockwise). Choosing only from that residue class is what makes a
 * per-device gesture safe - the pointer always ends on the same segment.
 */
function landing(from: number, residue: number, dir: 1 | -1, turns: number): number {
  const base = from + dir * turns * 360;
  const k =
    dir > 0 ? Math.ceil((base - residue) / 360) : Math.floor((base - residue) / 360);
  return residue + k * 360;
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

/** What the local fling asked for; absent on every device that didn't fling. */
type FlingIntent = { dir: 1 | -1; turns: number };

export function CategoryWheel({
  startedAt,
  category,
  onDone,
  interactive = false,
  onFling,
}: {
  /** Shared trigger timestamp; null renders the wheel idle (pre-spin). */
  startedAt: number | null;
  category?: BingoCategoryType;
  onDone?: () => void;
  /** This device is allowed to trigger the spin -> the disc becomes draggable. */
  interactive?: boolean;
  /**
   * A valid fling was released. The screen triggers the shared spin here; a
   * REJECTED promise re-arms the gesture, so a failed write doesn't leave the
   * player with a dead wheel (the fallback button stays available either way).
   */
  onFling?: (power: number) => void | Promise<unknown>;
}) {
  const rot = useRef(new Animated.Value(IDLE_DEG)).current;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onFlingRef = useRef(onFling);
  onFlingRef.current = onFling;
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;

  // What this device's own fling asked for (null on watchers / tap fallback).
  const flingRef = useRef<FlingIntent | null>(null);
  // False from a valid fling until the round resets - blocks double spins from
  // a burst of short flicks while the request is in flight.
  const armedRef = useRef(true);
  // Live drag bookkeeping.
  const dragRef = useRef({
    base: IDLE_DEG, // rotation when the finger landed
    total: 0, // signed degrees turned since then
    lastAngle: 0, // last touch angle around the hub
    samples: [] as { t: number; total: number }[],
  });
  // Watchdog for a spin request that never produced a shared timestamp. It is
  // CLEARED the moment one arrives - otherwise it would fire in the middle of a
  // perfectly good landing (the window is shorter than the spin) and reset the
  // disc out from under the animation.
  const rearmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearRearm = () => {
    if (rearmTimerRef.current != null) {
      clearTimeout(rearmTimerRef.current);
      rearmTimerRef.current = null;
    }
  };

  /**
   * Put the disc back to rest after a spin request that went nowhere. The disc
   * looks identical at `current` and `current mod 360`, so it unwinds from the
   * equivalent small angle instead of visibly reeling back several turns.
   */
  const settleToIdle = useCallback(() => {
    rot.stopAnimation((current) => {
      const near = ((current % 360) + 360) % 360;
      rot.setValue(near > 180 ? near - 360 : near);
      Animated.timing(rot, {
        toValue: IDLE_DEG,
        duration: 450,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });
  }, [rot]);

  useEffect(() => {
    // ---- Idle: a fresh round resets the disc and re-opens the gesture ----
    if (startedAt == null || !category) {
      clearRearm();
      rot.stopAnimation();
      rot.setValue(IDLE_DEG);
      flingRef.current = null;
      armedRef.current = true;
      dragRef.current.total = 0;
      dragRef.current.base = IDLE_DEG;
      return;
    }

    // The shared timestamp is here - the request did land, so the watchdog has
    // nothing left to rescue.
    clearRearm();

    const residue = residueDeg(category, pickSegment(startedAt));
    const animMs = BINGO_SPIN_MS - SPIN_HOLD_MS;
    const elapsed = serverNow() - startedAt;
    const fling = flingRef.current;

    if (fling) {
      // This device flung: take the running decay over mid-motion, keeping the
      // player's direction and (time permitting) their power in the turn count.
      rot.stopAnimation((current) => {
        const remaining = animMs - elapsed;
        if (remaining <= 0) {
          rot.setValue(landing(current, residue, fling.dir, 0));
          return;
        }
        const turns = Math.max(
          1,
          Math.min(fling.turns, Math.floor(remaining / MIN_MS_PER_TURN))
        );
        Animated.timing(rot, {
          toValue: landing(current, residue, fling.dir, turns),
          duration: remaining,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start();
      });
    } else {
      // No local gesture (watchers, late joiners, tap fallback): the classic
      // deterministic replay from rest.
      const finalDeg = landing(IDLE_DEG, residue, 1, SPINS);
      if (elapsed >= animMs) {
        // Joined after the spin already finished -> hold on the result.
        rot.setValue(finalDeg);
      } else {
        // Pre-position proportionally so a mid-spin joiner doesn't snap back to
        // 0, then ease-out to the exact target over the remaining time.
        const startFrac = Math.max(0, elapsed / animMs);
        rot.setValue(IDLE_DEG + (finalDeg - IDLE_DEG) * startFrac);
        Animated.timing(rot, {
          toValue: finalDeg,
          duration: animMs - elapsed,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start();
      }
    }

    // Fire onDone after the FULL spin window (spin + result hold), matching the
    // old wheel. JS timer, independent of the visual so it never over/under-runs.
    const toDone = BINGO_SPIN_MS - elapsed;
    const t = setTimeout(() => onDoneRef.current?.(), Math.max(0, toDone));
    return () => clearTimeout(t);
  }, [startedAt, category, rot]);

  // ---- Finger control of the disc (idle stage only) ----
  const pan = useMemo(
    () =>
      PanResponder.create({
        // A plain tap must NOT capture the touch (the ScrollView and the
        // fallback button stay usable); only an actual drag takes over.
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g) =>
          interactiveRef.current &&
          armedRef.current &&
          (Math.abs(g.dx) > 3 || Math.abs(g.dy) > 3),
        // The disc sits inside a ScrollView: once the circular drag has begun,
        // neither the JS nor the native scroll responder may take the touch
        // away mid-throw (the second one matters on Android).
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,

        onPanResponderGrant: (e, g) => {
          // Kill a settle spring that may still be running; the disc's resting
          // rotation in the idle stage is always IDLE_DEG (a rejected drag
          // springs right back there), so the base needs no async read-back -
          // stopAnimation's callback would arrive a frame or two late over the
          // native-driver bridge and the first drag frames would jump.
          rot.stopAnimation();
          const d = dragRef.current;
          d.base = IDLE_DEG;
          d.total = 0;
          d.samples = [{ t: Date.now(), total: 0 }];
          // The overlay this responder sits on is the full SIZE×SIZE square
          // and has no children, so locationX/Y are its own coordinates.
          // Back out the few pixels already travelled to get the touch-down
          // point, so the first angle matches where the finger really landed.
          d.lastAngle = angleOf(
            e.nativeEvent.locationX - g.dx,
            e.nativeEvent.locationY - g.dy
          );
        },

        onPanResponderMove: (e) => {
          const d = dragRef.current;
          const x = e.nativeEvent.locationX;
          const y = e.nativeEvent.locationY;
          // Near the hub the angle is pure noise - ignore those samples rather
          // than letting the disc jitter.
          if (Math.hypot(x - SIZE / 2, y - SIZE / 2) < DEAD_ZONE_PX) return;
          const a = angleOf(x, y);
          let step = a - d.lastAngle;
          if (step > 180) step -= 360;
          else if (step < -180) step += 360;
          d.lastAngle = a;
          d.total += step;
          rot.setValue(d.base + d.total);
          d.samples.push({ t: Date.now(), total: d.total });
          if (d.samples.length > 8) d.samples.shift();
        },

        onPanResponderRelease: () => {
          const d = dragRef.current;
          const vel = releaseVelocity(d.samples);
          const travelled = Math.abs(d.total);
          const valid =
            armedRef.current &&
            interactiveRef.current &&
            (Math.abs(vel) >= MIN_FLING_VEL || travelled >= MIN_DRAG_DEG);

          if (!valid) {
            // Too weak to count: settle back to where the disc started, so the
            // "that wasn't a spin" feedback is unmistakable.
            Animated.spring(rot, {
              toValue: d.base,
              friction: 7,
              tension: 60,
              useNativeDriver: true,
            }).start();
            return;
          }

          const dir: 1 | -1 = (vel !== 0 ? Math.sign(vel) : Math.sign(d.total)) < 0 ? -1 : 1;
          const power = Math.max(
            0,
            Math.min(1, (Math.abs(vel) - MIN_FLING_VEL) / (MAX_FLING_VEL - MIN_FLING_VEL))
          );
          flingRef.current = { dir, turns: 1 + Math.round(power * 3) };
          armedRef.current = false;

          // Glide immediately - the shared timestamp is still a round trip away.
          Animated.decay(rot, {
            velocity: Math.abs(vel) >= MIN_GLIDE_VEL ? vel : dir * MIN_GLIDE_VEL,
            deceleration: DECAY_RATE,
            useNativeDriver: true,
          }).start();

          const giveBackTheDisc = () => {
            clearRearm();
            flingRef.current = null;
            armedRef.current = true;
            settleToIdle();
          };

          const result = onFlingRef.current?.(power);
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            (result as Promise<unknown>).catch(giveBackTheDisc);
          }
          // Safety net for a write that is silently refused (not your turn yet,
          // lost packet): without a shared timestamp the disc must become
          // throwable again instead of staying locked. Cancelled as soon as the
          // timestamp arrives (see the effect above).
          clearRearm();
          rearmTimerRef.current = setTimeout(giveBackTheDisc, REARM_AFTER_MS);
        },

        // Lost the touch without a release (system gesture, call, native
        // scroll winning anyway): treat it as "no spin" and put the disc back.
        onPanResponderTerminate: () => {
          if (!armedRef.current) return; // a fling already went out - leave it
          Animated.spring(rot, {
            toValue: dragRef.current.base,
            friction: 7,
            tension: 60,
            useNativeDriver: true,
          }).start();
        },
      }),
    [rot, settleToIdle]
  );

  // The watchdog outlives the spin effect's own cleanup, so it needs its own.
  useEffect(() => clearRearm, []);

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
            // and is pre-rotated k*SEG_DEG; its triangle points up (segment 0)
            // before that rotation, so it ends up centred at k*SEG_DEG.
            <View key={k} style={[styles.segWrap, { transform: [{ rotate: `${k * SEG_DEG}deg` }] }]}>
              <View style={[styles.tri, { borderTopColor: BINGO_CATEGORY_COLOR[seg] }]} />
            </View>
          ))}
        </Animated.View>
        <View style={styles.hub}>
          <Text style={styles.hubGlyph}>🪩</Text>
        </View>
      </View>
      {/* Childless full-size touch layer: keeps locationX/Y in ONE known
          coordinate system (see onPanResponderGrant) and scroll-independent. */}
      <View
        style={StyleSheet.absoluteFill}
        pointerEvents={interactive ? 'auto' : 'none'}
        {...pan.panHandlers}
      />
    </View>
  );
}

/** Touch angle around the hub, in degrees, growing clockwise (screen y is down,
 *  which is the same sense as a positive `rotate` transform). */
function angleOf(x: number, y: number): number {
  return (Math.atan2(y - SIZE / 2, x - SIZE / 2) * 180) / Math.PI;
}

/**
 * Release speed in deg/ms from the recent drag samples. Only the last
 * VEL_WINDOW_MS count, so a finger that slides and then STOPS before lifting
 * reads as ~0 (no spin) instead of inheriting the speed it had a moment ago.
 */
function releaseVelocity(samples: { t: number; total: number }[]): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  if (Date.now() - last.t > VEL_WINDOW_MS) return 0;
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > VEL_WINDOW_MS) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.total - first.total) / dt : 0;
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
  // SEG_DEG border-triangle, apex at the disc centre, pointing up (base at the
  // rim). The circular disc clips the overshoot into an exact SEG_DEG sector.
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
