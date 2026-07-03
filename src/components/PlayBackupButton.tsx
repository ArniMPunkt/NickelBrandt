/**
 * PlayBackupButton - small header icon button (▶) that force-(re)starts the
 * CURRENT song via Spotify.ensurePlaying: fast path when the App Remote is
 * still connected, one full reconnect otherwise. Covers the two cases the
 * silent auto-play effects can't: an initial play that never arrived, and a
 * connection lost mid-game (host backgrounded the app etc.).
 *
 * Styled like the existing header iconBtns (OnlineGameScreen). Three states:
 * idle (▶), busy (spinner; double taps ignored), error (reported via onError
 * into the screen's existing error display - never silent).
 *
 * The uri prop is mirrored into a ref, so ensurePlaying reads the CURRENT card
 * at play time - after a slow reconnect a stale card is never replayed.
 */
import { useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';
import * as Spotify from '../services/spotify';
import { PressableButton } from './PressableButton';
import { COLORS } from '../theme/colors';

export function PlayBackupButton({
  uri,
  onError,
}: {
  /** The current song's track uri (null while no card is active -> disabled). */
  uri: string | null;
  /** Surfaces failures in the screen's error display. */
  onError: (message: string) => void;
}) {
  const uriRef = useRef(uri);
  uriRef.current = uri;
  const [busy, setBusy] = useState(false);

  const onPress = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await Spotify.ensurePlaying(() => uriRef.current);
    } catch (e: any) {
      onError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PressableButton
      style={[styles.btn, !uri && styles.disabled]}
      onPress={onPress}
      disabled={!uri || busy}
      hitSlop={8}
    >
      {busy ? (
        <ActivityIndicator size="small" color={COLORS.secondary} />
      ) : (
        <Text style={styles.icon}>▶</Text>
      )}
    </PressableButton>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.4 },
  icon: { color: COLORS.secondary, fontSize: 16, fontWeight: '900' },
});
