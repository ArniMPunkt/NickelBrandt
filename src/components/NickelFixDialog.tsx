/**
 * NickelFixDialog - "Nickel korrigieren" popup (host / device holder only,
 * opened from the header overflow menu). Compact roster of the running match
 * with the live Nickel count and a +/- stepper per player, for manual
 * corrections (forgotten award, mistaken award).
 *
 * Pure number fix by design: NOT tied to a card/round, so it must never write
 * a "nickel" stats event (those carry the song they were earned on) - only
 * the chip count changes, through the injected onAdjust (Party: guarded
 * lobby_players write; Pass & Play: reducer dispatch). Bounds mirror the
 * regular award paths: 0 below, the configured Nickel-Obergrenze above
 * (limit null = unbegrenzt).
 *
 * Same design vocabulary as ReportSongDialog (dark centered card, glowing
 * accent border, fade backdrop).
 */
import { useEffect, useState } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import { PressableButton } from './PressableButton';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';

export interface NickelFixPlayer {
  /** Stable row key + onAdjust target (Party: lobby_players.id; P&P: Player.id). */
  id: string;
  name: string;
  chips: number;
}

export function NickelFixDialog({
  visible,
  players,
  limit,
  onAdjust,
  onClose,
}: {
  visible: boolean;
  /** Live roster - counts update through the screen's normal state flow. */
  players: NickelFixPlayer[];
  /** Upper bound for "+" (the Nickel-Obergrenze); null = unbegrenzt. */
  limit: number | null;
  /** Applies ±1 to one player; a rejection surfaces as the inline error. */
  onAdjust: (playerId: string, delta: 1 | -1) => Promise<void>;
  onClose: () => void;
}) {
  // One tap at a time: serializes the guarded Party writes so two quick taps
  // can never race each other with the same stale base count.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setBusy(false);
      setError(null);
    }
  }, [visible]);

  const tap = (playerId: string, delta: 1 | -1) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    onAdjust(playerId, delta)
      .catch((e: any) => setError(e?.message ?? String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>🪙 Nickel korrigieren</Text>
          <Text style={styles.subline}>
            Nur der Stand ändert sich — ohne Song-Bezug, daher kein Eintrag in
            der Statistik.
          </Text>

          {players.map((p) => {
            const minusOff = busy || p.chips <= 0;
            const plusOff = busy || (limit != null && p.chips >= limit);
            return (
              <View key={p.id} style={styles.row}>
                <Text style={styles.name} numberOfLines={1}>
                  {p.name}
                </Text>
                <View style={styles.stepper}>
                  <PressableButton
                    style={[styles.stepBtn, minusOff && styles.stepBtnDisabled]}
                    onPress={() => tap(p.id, -1)}
                    disabled={minusOff}
                    hitSlop={4}
                  >
                    <Text style={styles.stepBtnText}>−</Text>
                  </PressableButton>
                  <Text style={styles.count}>🪙 {p.chips}</Text>
                  <PressableButton
                    style={[styles.stepBtn, plusOff && styles.stepBtnDisabled]}
                    onPress={() => tap(p.id, 1)}
                    disabled={plusOff}
                    hitSlop={4}
                  >
                    <Text style={styles.stepBtnText}>+</Text>
                  </PressableButton>
                </View>
              </View>
            );
          })}

          {limit != null && <Text style={styles.limitLine}>Obergrenze: {limit}</Text>}
          {error && <Text style={styles.errorText}>{error}</Text>}

          <PressableButton style={styles.doneBtn} onPress={onClose}>
            <Text style={styles.doneText}>Fertig</Text>
          </PressableButton>
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
    borderColor: COLORS.accent,
    borderRadius: 20,
    padding: 20,
    gap: 10,
    ...glow(COLORS.accent, { radius: 18, opacity: 0.6 }),
  },
  title: { color: COLORS.text, fontSize: 20, fontWeight: '900', letterSpacing: 0.5 },
  subline: { color: COLORS.textMuted, fontSize: 13, fontWeight: '700', marginBottom: 4 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    minHeight: 52,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
    paddingHorizontal: 12,
  },
  name: { color: COLORS.text, fontSize: 15, fontWeight: '800', flex: 1 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnDisabled: { opacity: 0.3 },
  stepBtnText: { color: COLORS.accent, fontSize: 20, fontWeight: '900', lineHeight: 24 },
  // Fixed min width so the row doesn't jiggle when the count changes digits.
  count: { color: COLORS.text, fontSize: 15, fontWeight: '900', minWidth: 48, textAlign: 'center' },

  limitLine: { color: COLORS.textMuted, fontSize: 12, fontWeight: '700', fontStyle: 'italic' },
  errorText: { color: COLORS.incorrect, fontSize: 13, fontWeight: '700' },

  doneBtn: {
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: COLORS.background,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  doneText: { color: COLORS.text, fontSize: 16, fontWeight: '800' },
});
