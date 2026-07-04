/**
 * PlayBackupButton - small header icon button that acts as a Play/Pause toggle
 * for the CURRENT song via Spotify.togglePlayback: fast path when the App Remote
 * is still connected, one full reconnect otherwise. Covers the two cases the
 * silent auto-play effects can't: an initial play that never arrived, and a
 * connection lost mid-game (host backgrounded the app etc.).
 *
 * Behaviour: resumes at the last position if paused (never a jarring restart),
 * pauses if playing, and only starts from the beginning when this card hasn't
 * been played yet this round. The icon (▶ vs ⏸) reflects the REAL playback
 * state: a live playerStateChanged subscription flips it the moment auto-play
 * starts a new card (no tap needed), and a one-shot probe on each card covers a
 * button rendered mid-song. Both are best-effort - if Spotify isn't reachable it
 * falls back to ▶. Taps update it optimistically from togglePlayback's result.
 * This works for every mode that renders the button (Hitster, Bingo,
 * Timeline-Quiz, Pass & Play), since the logic lives here, not per screen.
 *
 * Styled like the existing header iconBtns (OnlineGameScreen). Three states:
 * idle (▶/⏸), busy (spinner; double taps ignored), error (reported via onError
 * into the screen's existing error display - never silent).
 *
 * The uri prop is mirrored into a ref, so togglePlayback reads the CURRENT card
 * at action time - after a slow reconnect a stale card is never replayed.
 */
import { useEffect, useRef, useState } from 'react';
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
  const [playing, setPlaying] = useState(false);

  // Live icon sync: reflect the REAL playback state without needing a tap.
  // Subscribed once for the button's lifetime; the listener reads the CURRENT
  // uri via the ref, so it stays correct as cards change.
  useEffect(() => {
    const unsubscribe = Spotify.subscribePlaybackState(
      () => uriRef.current,
      (state) => setPlaying(state === 'playing')
    );
    return unsubscribe;
  }, []);

  // On each new card: default to ▶ immediately, then a best-effort probe
  // corrects it if that card is already playing (e.g. button rendered mid-song).
  // Auto-play's own start is caught by the subscription above. Guarded against a
  // late resolve landing after the card changed again.
  useEffect(() => {
    setPlaying(false);
    if (!uri) return;
    let cancelled = false;
    Spotify.probePlaybackState(uri).then((state) => {
      if (!cancelled && state) setPlaying(state === 'playing');
    });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  const onPress = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const state = await Spotify.togglePlayback(() => uriRef.current);
      setPlaying(state === 'playing');
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
        <Text style={styles.icon}>{playing ? '⏸' : '▶'}</Text>
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
