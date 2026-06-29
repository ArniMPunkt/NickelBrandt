/**
 * Cross-platform neon glow for raised surfaces.
 *
 * Every "shadow" in this app is a soft COLOURED glow (offset 0/0, a neon
 * shadowColor) - never a directional drop shadow. iOS renders that faithfully
 * via shadowColor + shadowRadius. Android does NOT: it ignores shadowColor
 * below API 28 and only paints `elevation`, which is a hard, dark, directional
 * drop shadow. The result on Android is an ugly grey slab behind every neon
 * button instead of a glow.
 *
 * So `glow()` returns the real coloured shadow on iOS and nothing on Android -
 * the bright fills already pop against the dark purple background, and a missing
 * soft halo beats a wrong hard one. We deliberately do NOT remove glows in
 * general (iOS keeps them); we only drop the Android artefact.
 *
 * For OUTLINED / translucent surfaces that genuinely need a visible halo on
 * Android too (e.g. the victory trophy), render a `<GlowHalo>` view behind the
 * element instead - a real semi-transparent view glows on every platform.
 */
import { Platform, type ViewStyle } from 'react-native';
import { COLORS } from './colors';

type GlowOpts = {
  /** iOS shadow softness. Default 16. */
  radius?: number;
  /** iOS shadow strength 0..1. Default 0.8. */
  opacity?: number;
};

/** Neon glow style for a raised element (button, card, pill). */
export function glow(color: string = COLORS.secondary, opts: GlowOpts = {}): ViewStyle {
  const { radius = 16, opacity = 0.8 } = opts;
  if (Platform.OS === 'ios') {
    return {
      shadowColor: color,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: opacity,
      shadowRadius: radius,
    };
  }
  // Android (+ web): no elevation -> no hard dark slab.
  return {};
}

/**
 * Halo style: a soft, semi-transparent disc to place BEHIND an element so it
 * reads as glowing on every platform (used where the iOS-only `glow()` shadow
 * would leave Android flat). Spread onto an absolutely-positioned <View>; the
 * caller sets its size/position.
 */
export function haloStyle(color: string, opacity = 0.35): ViewStyle {
  return {
    position: 'absolute',
    borderRadius: 999,
    backgroundColor: color,
    opacity,
  };
}
