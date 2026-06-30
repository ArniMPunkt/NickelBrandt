/**
 * PressableButton - the app's single tappable wrapper, so every button gives
 * IMMEDIATE press feedback.
 *
 * The app had no central button component; all touch targets were bare
 * <Pressable>s with static styles, so a tap showed nothing until the (sometimes
 * delayed) action ran - making buttons feel unresponsive while something loads
 * in the background. This wraps Pressable and dims it on touch-DOWN (Pressable's
 * `pressed` flips on pressIn, before onPress fires on release), independent of
 * how long the action behind it takes. Simple + robust (just opacity), matching
 * the neon-on-dark style.
 *
 * Drop-in for <Pressable>: same props (style/onPress/disabled/hitSlop/children).
 * Disabled buttons get no press feedback. Tune the dim via `activeOpacity`.
 */
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

export type PressableButtonProps = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  /** Opacity applied while pressed (touch-down). Default 0.6. */
  activeOpacity?: number;
};

export function PressableButton({
  style,
  activeOpacity = 0.6,
  disabled,
  ...rest
}: PressableButtonProps) {
  return (
    <Pressable
      disabled={disabled}
      style={({ pressed }) => [style, pressed && !disabled ? { opacity: activeOpacity } : null]}
      {...rest}
    />
  );
}
