/**
 * StepSlider - JS-only horizontal slider (PanResponder, deliberately NO native
 * slider dependency so Metro reload suffices). Integer steps; `milestones` get
 * an emphasized tick + number label below the track.
 *
 * Touch handling: the outer touch area owns the responder and all visuals are
 * pointerEvents="none", so locationX is always relative to the touch area (a
 * touch landing on the thumb would otherwise report thumb-local coordinates).
 * Drags resist the surrounding vertical ScrollView via termination denial.
 */
import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';

const THUMB = 28;
const AREA_H = 44;
const TRACK_H = 8;
const TICK_H = 18;
const LABEL_W = 40;

export function StepSlider({
  value,
  min,
  max,
  step = 1,
  milestones = [],
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  /** Snap increment (default 1). (max - min) should be divisible by it. */
  step?: number;
  /** Values rendered as emphasized stops (tick + number label). */
  milestones?: number[];
  onChange: (v: number) => void;
}) {
  // Inner track width, measured; markers/thumb render only once known.
  const [trackW, setTrackW] = useState(0);

  // The PanResponder is created once, so it reads the latest values via refs.
  const trackWRef = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastEmitted = useRef<number | null>(null);
  const startX = useRef(0);

  const setFromX = (areaX: number) => {
    const w = trackWRef.current;
    if (w <= 0) return;
    const frac = Math.min(1, Math.max(0, (areaX - THUMB / 2) / w));
    const v = min + Math.round((frac * (max - min)) / step) * step;
    if (v !== lastEmitted.current) {
      lastEmitted.current = v;
      onChangeRef.current(v);
    }
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (evt) => {
        startX.current = evt.nativeEvent.locationX;
        lastEmitted.current = null; // tap always (re-)emits
        setFromX(startX.current);
      },
      onPanResponderMove: (_evt, g) => setFromX(startX.current + g.dx),
    })
  ).current;

  const frac = (value - min) / (max - min);

  return (
    <View>
      <View style={styles.touchArea} {...pan.panHandlers}>
        <View
          pointerEvents="none"
          style={styles.inner}
          onLayout={(e) => {
            trackWRef.current = e.nativeEvent.layout.width;
            setTrackW(e.nativeEvent.layout.width);
          }}
        >
          <View style={styles.track} />
          {trackW > 0 && (
            <>
              <View style={[styles.fill, { width: frac * trackW }]} />
              {milestones.map((m) => {
                const mf = (m - min) / (max - min);
                return (
                  <View
                    key={m}
                    style={[
                      styles.tick,
                      value === m && styles.tickActive,
                      { left: mf * trackW - 2 },
                    ]}
                  />
                );
              })}
              <View style={[styles.thumb, { left: frac * trackW - THUMB / 2 }]} />
            </>
          )}
        </View>
      </View>
      <View pointerEvents="none" style={styles.labelRow}>
        {trackW > 0 &&
          milestones.map((m) => {
            const mf = (m - min) / (max - min);
            return (
              <Text
                key={m}
                style={[
                  styles.tickLabel,
                  value === m && styles.tickLabelActive,
                  // Track is inset by THUMB/2 inside the touch area; labels sit in
                  // an un-inset row, so add the inset back before centering.
                  { left: THUMB / 2 + mf * trackW - LABEL_W / 2 },
                ]}
              >
                {m}
              </Text>
            );
          })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  touchArea: {
    height: AREA_H,
    paddingHorizontal: THUMB / 2,
    justifyContent: 'center',
  },
  inner: { height: AREA_H, justifyContent: 'center' },
  track: {
    height: TRACK_H,
    borderRadius: 999,
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: (AREA_H - TRACK_H) / 2,
    height: TRACK_H,
    borderRadius: 999,
    backgroundColor: COLORS.accent,
  },
  tick: {
    position: 'absolute',
    top: (AREA_H - TICK_H) / 2,
    width: 4,
    height: TICK_H,
    borderRadius: 2,
    backgroundColor: COLORS.border,
  },
  tickActive: {
    backgroundColor: COLORS.accent,
    ...glow(COLORS.accent, { radius: 8, opacity: 0.8 }),
  },
  thumb: {
    position: 'absolute',
    top: (AREA_H - THUMB) / 2,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: COLORS.accent,
    borderWidth: 2,
    borderColor: COLORS.text,
    ...glow(COLORS.accent, { radius: 10, opacity: 0.8 }),
  },
  labelRow: { height: 20 },
  tickLabel: {
    position: 'absolute',
    width: LABEL_W,
    textAlign: 'center',
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: '800',
  },
  tickLabelActive: { color: COLORS.accent },
});
