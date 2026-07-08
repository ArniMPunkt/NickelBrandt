/**
 * HeaderMenu - the single overflow button ("⋯") of the in-game top bars.
 * Replaces the three separate header icons (Play/Pause, ⓘ lobby code, ⋯ end
 * lobby) plus the deck-count pill with one anchored dropdown, so the top bar
 * keeps only the turn indicator and the score/Nickel line.
 *
 * Entries (each optional, so every mode/role renders exactly its controls):
 *   - playback: Play/Pause as the FIRST and most prominent row (a hanging song
 *     start is the most common mid-game fix) - one tap on ⋯, one tap on the
 *     row, no nesting. Behaviour ported from the former PlayBackupButton:
 *     resumes at the last position if paused (never a jarring restart), pauses
 *     if playing, only starts from the beginning when this card hasn't played
 *     yet. The icon reflects the REAL playback state (live playerStateChanged
 *     subscription + a one-shot probe per card) and taps update it
 *     optimistically from togglePlayback's result. The uri lives in a ref so a
 *     toggle after a slow reconnect never replays a stale card.
 *   - report: "Song melden" (host / device holder). Disabled with a hint
 *     until the current song is revealed - before the reveal it would be
 *     ambiguous which song is meant. Opens the screen's ReportSongDialog.
 *   - code: the lobby code (info row, formerly behind the ⓘ button)
 *   - deckCount: the "im Deck" counter (info row, formerly a header pill)
 *   - action: leave/end lobby (destructive row; the screen keeps its own
 *     confirm dialog - this only triggers it)
 */
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Spotify from '../services/spotify';
import { PressableButton } from './PressableButton';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';

export interface HeaderMenuPlayback {
  /** The current song's track uri (null while no card is active -> disabled). */
  uri: string | null;
  /** Surfaces failures in the screen's error display. */
  onError: (message: string) => void;
}

export interface HeaderMenuAction {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

export interface HeaderMenuReport {
  /** False until the current song is revealed (row shown but disabled). */
  enabled: boolean;
  onPress: () => void;
}

export function HeaderMenu({
  playback,
  report,
  code,
  deckCount,
  action,
}: {
  playback?: HeaderMenuPlayback;
  report?: HeaderMenuReport;
  code?: string | null;
  deckCount?: number;
  action?: HeaderMenuAction;
}) {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  // --- Play/Pause state (active only when a playback entry is rendered) ---
  const uriRef = useRef<string | null>(playback?.uri ?? null);
  uriRef.current = playback?.uri ?? null;
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const hasPlayback = !!playback;
  const uri = playback?.uri ?? null;

  // Live icon sync: reflect the real playback state without needing a tap
  // (auto-play starting a new card flips it via the SDK event).
  useEffect(() => {
    if (!hasPlayback) return;
    const unsubscribe = Spotify.subscribePlaybackState(
      () => uriRef.current,
      (state) => setPlaying(state === 'playing')
    );
    return unsubscribe;
  }, [hasPlayback]);

  // On each new card: default to ▶, then a best-effort probe corrects it if
  // that card is already playing (e.g. menu mounted mid-song). Guarded against
  // a late resolve landing after the card changed again.
  useEffect(() => {
    if (!hasPlayback) return;
    setPlaying(false);
    if (!uri) return;
    let cancelled = false;
    Spotify.probePlaybackState(uri).then((state) => {
      if (!cancelled && state) setPlaying(state === 'playing');
    });
    return () => {
      cancelled = true;
    };
  }, [hasPlayback, uri]);

  const onToggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const state = await Spotify.togglePlayback(() => uriRef.current);
      setPlaying(state === 'playing');
      setOpen(false);
    } catch (e: any) {
      setOpen(false);
      playback?.onError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const onAction = () => {
    setOpen(false);
    action?.onPress();
  };

  return (
    <>
      <PressableButton style={styles.trigger} onPress={() => setOpen(true)} hitSlop={8}>
        <Text style={styles.triggerText}>⋯</Text>
      </PressableButton>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          {/* Pressable without onPress swallows taps so the backdrop doesn't close. */}
          <Pressable style={[styles.menu, { marginTop: insets.top + 8 }]}>
            {playback && (
              <PressableButton
                style={[styles.playRow, !playback.uri && styles.rowDisabled]}
                onPress={onToggle}
                disabled={!playback.uri || busy}
              >
                {busy ? (
                  <ActivityIndicator size="small" color={COLORS.secondary} />
                ) : (
                  <>
                    <Text style={styles.playIcon}>{playing ? '⏸' : '▶'}</Text>
                    <Text style={styles.playText}>
                      {playing ? 'Song pausieren' : 'Song abspielen'}
                    </Text>
                  </>
                )}
              </PressableButton>
            )}

            {report && (
              <PressableButton
                style={[styles.reportRow, !report.enabled && styles.rowDisabled]}
                onPress={() => {
                  setOpen(false);
                  report.onPress();
                }}
                disabled={!report.enabled}
              >
                <Text style={styles.reportText}>🚩 Song melden</Text>
                {!report.enabled && (
                  <Text style={styles.reportHint}>erst nach Aufdeckung</Text>
                )}
              </PressableButton>
            )}

            {code != null && (
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Lobby-Code</Text>
                <Text style={styles.codeValue}>{code}</Text>
              </View>
            )}

            {deckCount != null && (
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Im Deck</Text>
                <Text style={styles.infoValue}>{deckCount} Karten</Text>
              </View>
            )}

            {action && (
              <PressableButton
                style={[styles.actionRow, action.destructive && styles.actionRowDestructive]}
                onPress={onAction}
              >
                <Text
                  style={[styles.actionText, action.destructive && styles.actionTextDestructive]}
                >
                  {action.label}
                </Text>
              </PressableButton>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  triggerText: { color: COLORS.textMuted, fontSize: 18, fontWeight: '900' },

  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'flex-end',
    paddingHorizontal: 16,
  },
  menu: {
    minWidth: 250,
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: COLORS.border,
    padding: 12,
    gap: 10,
    ...glow(COLORS.secondary, { radius: 14, opacity: 0.35 }),
  },

  // Play/Pause: the prominent first row (most-used mid-game fix).
  playRow: {
    minHeight: 56,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: COLORS.secondary,
    backgroundColor: COLORS.background,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 14,
    ...glow(COLORS.secondary, { radius: 10, opacity: 0.5 }),
  },
  rowDisabled: { opacity: 0.4 },
  playIcon: { color: COLORS.secondary, fontSize: 18, fontWeight: '900' },
  playText: { color: COLORS.secondary, fontSize: 16, fontWeight: '900' },

  reportRow: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: COLORS.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 12,
  },
  reportText: { color: COLORS.text, fontSize: 15, fontWeight: '800' },
  reportHint: { color: COLORS.textMuted, fontSize: 11, fontWeight: '700', fontStyle: 'italic' },

  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 40,
    paddingHorizontal: 6,
  },
  infoLabel: { color: COLORS.textMuted, fontSize: 13, fontWeight: '700' },
  infoValue: { color: COLORS.text, fontSize: 15, fontWeight: '900' },
  codeValue: {
    color: COLORS.primary,
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: 3,
  },

  actionRow: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionRowDestructive: { borderColor: COLORS.incorrect },
  actionText: { color: COLORS.text, fontSize: 15, fontWeight: '800' },
  actionTextDestructive: { color: COLORS.incorrect },
});
