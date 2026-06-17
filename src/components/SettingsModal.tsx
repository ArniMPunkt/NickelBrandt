/**
 * SettingsGear - a ⚙️ button (top-right) that opens an app-wide Settings modal.
 *
 * Rendered only on screens where it shouldn't distract (SetupScreen, Spotify
 * tab). The modal is a scaffold: Spotify status/disconnect, app info, and a
 * (not-yet-wired) data-reset placeholder. The bottom-nav Spotify tab is separate
 * and unchanged - this is for future app-wide options.
 */
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Spotify from '../services/spotify';
import { useSettings } from '../context/SettingsContext';
import { COLORS } from '../theme/colors';

const APP_VERSION = 'v0.1.0';
const WIN_OPTIONS = [5, 10, 15];

export function SettingsGear() {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        style={[styles.gear, { top: insets.top + 8 }]}
        onPress={() => setOpen(true)}
        hitSlop={12}
        accessibilityLabel="Einstellungen"
      >
        <Text style={styles.gearIcon}>⚙️</Text>
      </Pressable>
      <SettingsModal visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

function SettingsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { settings, update } = useSettings();
  const [connected, setConnected] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const isConnected = Spotify.isReadyToPlay();
    setConnected(isConnected);
    if (isConnected) {
      try {
        setName(await Spotify.getDisplayName());
      } catch {
        setName(null);
      }
    } else {
      setName(null);
    }
  }, []);

  const disconnect = async () => {
    setBusy(true);
    try {
      await Spotify.disconnect();
    } catch {
      // ignore - status will reflect disconnected
    } finally {
      setConnected(false);
      setName(null);
      setBusy(false);
    }
  };

  const resetStats = () => {
    // TODO: implement game-statistics reset once persistence exists.
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} onShow={refresh}>
      <View style={[styles.modal, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Einstellungen</Text>
          <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={12}>
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.section}>SPIELREGELN</Text>
          <View style={styles.card}>
            <Text style={styles.ruleLabel}>Karten zum Gewinnen</Text>
            <View style={styles.winRow}>
              {WIN_OPTIONS.map((opt) => {
                const active = settings.cardsToWin === opt;
                return (
                  <Pressable
                    key={opt}
                    style={[styles.winOpt, active && styles.winOptActive]}
                    onPress={() => update({ cardsToWin: opt })}
                  >
                    <Text style={[styles.winOptText, active && styles.winOptTextActive]}>
                      {opt}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.ruleToggleRow}>
              <View style={styles.toggleTextWrap}>
                <Text style={styles.toggleTitle}>Cover erst nach Aufdeckung zeigen</Text>
                <Text style={styles.toggleHint}>
                  Für Spielvarianten mit Titel/Interpret-Rätseln
                </Text>
              </View>
              <Switch
                value={settings.hideCoverUntilRevealed}
                onValueChange={(v) => update({ hideCoverUntilRevealed: v })}
                trackColor={{ false: COLORS.border, true: COLORS.primary }}
                thumbColor={COLORS.text}
                ios_backgroundColor={COLORS.border}
              />
            </View>

            <View style={styles.ruleToggleRow}>
              <View style={styles.toggleTextWrap}>
                <Text style={styles.toggleTitle}>Nickel & Hitster-Rufe aktivieren</Text>
                <Text style={styles.toggleHint}>
                  Nickel für richtig erratenen Titel + Interpret; „Hitster!" zum Klauen
                </Text>
              </View>
              <Switch
                value={settings.chipsEnabled}
                onValueChange={(v) => update({ chipsEnabled: v })}
                trackColor={{ false: COLORS.border, true: COLORS.primary }}
                thumbColor={COLORS.text}
                ios_backgroundColor={COLORS.border}
              />
            </View>

            <View style={styles.comingRow}>
              <Text style={styles.comingText}>Karte überspringen (1 Nickel)</Text>
              <View style={styles.comingBadge}>
                <Text style={styles.comingBadgeText}>Bald verfügbar</Text>
              </View>
            </View>
            <View style={styles.comingRow}>
              <Text style={styles.comingText}>Karte ohne Raten ziehen (3 Nickel)</Text>
              <View style={styles.comingBadge}>
                <Text style={styles.comingBadgeText}>Bald verfügbar</Text>
              </View>
            </View>
          </View>

          <Text style={styles.section}>SPOTIFY</Text>
          <View style={styles.card}>
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: connected ? COLORS.correct : COLORS.textMuted },
                ]}
              />
              <Text style={styles.statusText}>
                {connected ? (name ? `Verbunden als ${name}` : 'Verbunden') : 'Nicht verbunden'}
              </Text>
            </View>
            {connected && (
              <Pressable style={styles.dangerBtn} onPress={disconnect} disabled={busy}>
                {busy ? (
                  <ActivityIndicator color={COLORS.incorrect} />
                ) : (
                  <Text style={styles.dangerText}>Verbindung trennen</Text>
                )}
              </Pressable>
            )}
          </View>

          <Text style={styles.section}>APP-INFO</Text>
          <View style={styles.card}>
            <Text style={styles.infoRow}>Version {APP_VERSION}</Text>
            <Text style={styles.about}>
              NickelBrandt — Hot-Seat Musik-Party-Spiel. Errate das Jahr, sammle Nickel
              und mach einen Brandt, indem du Karten von Mitspielern klaust.
            </Text>
          </View>

          <Text style={styles.section}>DATEN</Text>
          <View style={styles.card}>
            <Pressable style={styles.placeholderBtn} onPress={resetStats}>
              <Text style={styles.placeholderText}>Spielstatistiken zurücksetzen</Text>
            </Pressable>
            <Text style={styles.placeholderHint}>Noch nicht verfügbar</Text>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  gear: {
    position: 'absolute',
    right: 12,
    zIndex: 10,
    width: 44,
    height: 44,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gearIcon: { fontSize: 24 },

  modal: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  title: { color: COLORS.primary, fontSize: 28, fontWeight: '900' },
  closeBtn: {
    width: 44,
    height: 44,
    borderRadius: 999,
    backgroundColor: COLORS.backgroundAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { color: COLORS.text, fontSize: 18, fontWeight: '900' },

  content: { padding: 20, gap: 10, paddingBottom: 48 },
  section: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 2,
    marginTop: 12,
  },
  card: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
    gap: 12,
  },
  ruleLabel: { color: COLORS.text, fontSize: 15, fontWeight: '800' },
  winRow: { flexDirection: 'row', gap: 10 },
  winOpt: {
    flex: 1,
    minHeight: 56,
    borderRadius: 14,
    backgroundColor: COLORS.background,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  winOptActive: { borderColor: COLORS.accent, backgroundColor: COLORS.accent },
  winOptText: { color: COLORS.text, fontSize: 22, fontWeight: '900' },
  winOptTextActive: { color: COLORS.background },
  ruleToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  toggleTextWrap: { flex: 1 },
  toggleTitle: { color: COLORS.text, fontSize: 15, fontWeight: '800' },
  toggleHint: { color: COLORS.textMuted, fontSize: 12, fontWeight: '600', marginTop: 2 },
  comingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: COLORS.background,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 44,
    opacity: 0.5,
  },
  comingText: { color: COLORS.textMuted, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  comingBadge: {
    backgroundColor: COLORS.border,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  comingBadgeText: { color: COLORS.text, fontSize: 11, fontWeight: '800' },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 12, height: 12, borderRadius: 999 },
  statusText: { color: COLORS.text, fontSize: 16, fontWeight: '800' },
  dangerBtn: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: COLORS.incorrect,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerText: { color: COLORS.incorrect, fontSize: 15, fontWeight: '900' },

  infoRow: { color: COLORS.text, fontSize: 16, fontWeight: '800' },
  about: { color: COLORS.textMuted, fontSize: 14, fontWeight: '600', lineHeight: 20 },

  placeholderBtn: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.6,
  },
  placeholderText: { color: COLORS.textMuted, fontSize: 15, fontWeight: '800' },
  placeholderHint: { color: COLORS.textMuted, fontSize: 12, fontWeight: '600', textAlign: 'center' },
});
