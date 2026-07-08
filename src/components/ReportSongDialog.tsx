/**
 * ReportSongDialog - "Song melden" popup (opened from the header overflow
 * menu once a song is revealed). Same design vocabulary as ConfirmDialog
 * (dark centered card, glowing accent border, fade backdrop).
 *
 * Single-select from four FIXED reasons - deliberately no free text
 * (privacy/security). Submit writes one snapshot row via the injected
 * onSubmit (Online.reportSong); success shows a short non-blocking "Danke"
 * beat and auto-closes, failure (e.g. offline) shows a retryable inline
 * message - no offline queueing by design.
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, View } from 'react-native';
import type { SongReportReason } from '../services/supabase';
import { PressableButton } from './PressableButton';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';

const REASONS: Array<{ key: SongReportReason; label: string }> = [
  { key: 'wrong_year', label: 'Falsches Jahr' },
  { key: 'wrong_title_artist', label: 'Falscher Titel/Interpret' },
  { key: 'not_in_pool', label: 'Song passt nicht in den Pool' },
  { key: 'other', label: 'Sonstiges' },
];

/** How long the "Danke" confirmation stays before the dialog auto-closes. */
const SUCCESS_CLOSE_MS = 1200;

export interface ReportSongCard {
  title: string;
  artist: string;
  year: number;
}

/**
 * Full snapshot the screens keep in state while the dialog is open: the
 * display fields plus the uri needed for the song_reports insert. GameCard
 * (live report) and a StatsSong with uri (stats report) both satisfy it.
 */
export interface ReportSongTarget extends ReportSongCard {
  trackUri: string;
}

export function ReportSongDialog({
  visible,
  card,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  /** Snapshot of the revealed song taken when the dialog was opened. */
  card: ReportSongCard | null;
  onClose: () => void;
  /** Persists the report (throws on failure, e.g. offline). */
  onSubmit: (reason: SongReportReason) => Promise<void>;
}) {
  const [reason, setReason] = useState<SongReportReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fresh state on every open; never leak a pending auto-close across opens.
  useEffect(() => {
    if (visible) {
      setReason(null);
      setBusy(false);
      setDone(false);
      setError(null);
    }
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [visible]);

  const submit = async () => {
    if (!reason || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason);
      setDone(true);
      closeTimer.current = setTimeout(onClose, SUCCESS_CLOSE_MS);
    } catch {
      setError('Meldung fehlgeschlagen — keine Verbindung? Versuche es erneut.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {done ? (
            <View style={styles.doneWrap}>
              <Text style={styles.doneGlyph}>✓</Text>
              <Text style={styles.doneText}>Danke für die Meldung!</Text>
            </View>
          ) : (
            <>
              <Text style={styles.title}>🚩 Song melden</Text>
              {card && (
                <Text style={styles.songLine} numberOfLines={2}>
                  {card.title} — {card.artist} ({card.year})
                </Text>
              )}

              {REASONS.map(({ key, label }) => {
                const active = reason === key;
                return (
                  <PressableButton
                    key={key}
                    style={[styles.reasonRow, active && styles.reasonRowActive]}
                    onPress={() => setReason(key)}
                  >
                    <Text style={[styles.radio, active && styles.radioActive]}>
                      {active ? '●' : '○'}
                    </Text>
                    <Text style={[styles.reasonText, active && styles.reasonTextActive]}>
                      {label}
                    </Text>
                  </PressableButton>
                );
              })}

              {error && <Text style={styles.errorText}>{error}</Text>}

              <View style={styles.buttonRow}>
                <PressableButton style={styles.cancelBtn} onPress={onClose} disabled={busy}>
                  <Text style={styles.cancelText}>Abbrechen</Text>
                </PressableButton>
                <PressableButton
                  style={[styles.confirmBtn, (!reason || busy) && styles.confirmBtnDisabled]}
                  onPress={submit}
                  disabled={!reason || busy}
                >
                  {busy ? (
                    <ActivityIndicator color={COLORS.background} />
                  ) : (
                    <Text style={styles.confirmText}>Melden</Text>
                  )}
                </PressableButton>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 2,
    borderColor: COLORS.secondary,
    borderRadius: 20,
    padding: 20,
    gap: 10,
    ...glow(COLORS.secondary, { radius: 18, opacity: 0.7 }),
  },
  title: { color: COLORS.text, fontSize: 20, fontWeight: '900', letterSpacing: 0.5 },
  songLine: {
    color: COLORS.textMuted,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
  },

  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
    paddingHorizontal: 14,
  },
  reasonRowActive: { borderColor: COLORS.secondary },
  radio: { color: COLORS.textMuted, fontSize: 16, fontWeight: '900' },
  radioActive: { color: COLORS.secondary },
  reasonText: { color: COLORS.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  reasonTextActive: { color: COLORS.secondary },

  errorText: { color: COLORS.incorrect, fontSize: 13, fontWeight: '700' },

  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  cancelBtn: {
    flex: 1,
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: COLORS.background,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  cancelText: { color: COLORS.text, fontSize: 16, fontWeight: '800' },
  confirmBtn: {
    flex: 1,
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: COLORS.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  confirmBtnDisabled: { opacity: 0.4 },
  confirmText: { color: COLORS.background, fontSize: 16, fontWeight: '900' },

  doneWrap: { alignItems: 'center', paddingVertical: 18, gap: 8 },
  doneGlyph: { color: COLORS.correct, fontSize: 42, fontWeight: '900' },
  doneText: { color: COLORS.text, fontSize: 17, fontWeight: '800' },
});
