/**
 * SettingsScreen - the "Einstellungen" tab. Single home for everything that used
 * to live in the two gear modals + the old Spotify tab:
 *   - Spotify connection status + connect / disconnect
 *   - Game rules (cards to win, cover delay, Nickel/Hitster) via SettingsContext
 *   - App info (version / about)
 *   - Data section (reset placeholder)
 *
 * Game logic is untouched; this only reads/writes SettingsContext and calls the
 * existing Spotify service. Status refreshes on focus, so connecting here and
 * switching tabs updates the gated start/create buttons automatically.
 */
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Spotify from '../services/spotify';
import { useSettings } from '../context/SettingsContext';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';

const APP_VERSION = 'v0.1.0';
const WIN_OPTIONS = [5, 10, 15];
const SPOTIFY_GREEN = '#1DB954';

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { settings, update } = useSettings();
  const [connected, setConnected] = useState(Spotify.isReadyToPlay());
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Keep the status in sync whenever the tab regains focus.
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await Spotify.connect();
      await refresh();
    } catch (e: any) {
      const code = e?.code ? `[${e.code}] ` : '';
      setError(`${code}${e?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
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
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
    >
      <Text style={styles.title}>Einstellungen</Text>

      {/* ---- Spotify ---- */}
      <Text style={styles.section}>SPOTIFY</Text>
      <View style={styles.card}>
        <View style={styles.statusRow}>
          <View
            style={[styles.dot, { backgroundColor: connected ? COLORS.correct : COLORS.textMuted }]}
          />
          <Text style={styles.statusText}>
            {connected ? (name ? `Verbunden als ${name}` : 'Verbunden') : 'Nicht verbunden'}
          </Text>
        </View>
        <Text style={styles.spotifyHint}>
          {connected
            ? 'Du kannst jetzt ein Spiel starten oder eine Lobby erstellen.'
            : 'Verbinde dich, um Playlists zu laden und Tracks abzuspielen. Nötig zum Starten eines Hot-Seat-Spiels und zum Erstellen einer Online-Lobby.'}
        </Text>
        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText} selectable>
              {error}
            </Text>
          </View>
        )}
        {connected ? (
          <Pressable style={styles.dangerBtn} onPress={disconnect} disabled={busy}>
            {busy ? (
              <ActivityIndicator color={COLORS.incorrect} />
            ) : (
              <Text style={styles.dangerText}>Verbindung trennen</Text>
            )}
          </Pressable>
        ) : (
          <Pressable style={[styles.connectBtn, busy && styles.disabled]} onPress={connect} disabled={busy}>
            {busy ? (
              <ActivityIndicator color={COLORS.text} />
            ) : (
              <Text style={styles.connectBtnText}>Mit Spotify verbinden</Text>
            )}
          </Pressable>
        )}
      </View>

      {/* ---- Game rules ---- */}
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
                <Text style={[styles.winOptText, active && styles.winOptTextActive]}>{opt}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.ruleToggleRow}>
          <View style={styles.toggleTextWrap}>
            <Text style={styles.toggleTitle}>Cover erst nach Aufdeckung zeigen</Text>
            <Text style={styles.toggleHint}>Für Spielvarianten mit Titel/Interpret-Rätseln</Text>
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

      {/* ---- App info ---- */}
      <Text style={styles.section}>APP-INFO</Text>
      <View style={styles.card}>
        <Text style={styles.infoRow}>Version {APP_VERSION}</Text>
        <Text style={styles.about}>
          NickelBrandt — Musik-Party-Spiel. Errate das Jahr, sammle Nickel und klau dir
          Karten von Mitspielern. Platziere mehrere Karten in Folge richtig für einen Brandt
          (Hot-Streak).
        </Text>
      </View>

      {/* ---- Data ---- */}
      <Text style={styles.section}>DATEN</Text>
      <View style={styles.card}>
        <Pressable style={styles.placeholderBtn} onPress={resetStats}>
          <Text style={styles.placeholderText}>Spielstatistiken zurücksetzen</Text>
        </Pressable>
        <Text style={styles.placeholderHint}>Noch nicht verfügbar</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 20, gap: 10, paddingBottom: 48 },
  title: { color: COLORS.primary, fontSize: 34, fontWeight: '900', marginBottom: 4 },
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
  spotifyHint: { color: COLORS.textMuted, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  connectBtn: {
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: SPOTIFY_GREEN,
    alignItems: 'center',
    justifyContent: 'center',
    ...glow(SPOTIFY_GREEN, { radius: 12, opacity: 0.6 }),
  },
  connectBtnText: { color: COLORS.text, fontSize: 16, fontWeight: '900', letterSpacing: 0.5 },
  dangerBtn: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: COLORS.incorrect,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerText: { color: COLORS.incorrect, fontSize: 15, fontWeight: '900' },
  disabled: { opacity: 0.6 },
  errorBox: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.incorrect,
    borderWidth: 2,
    borderRadius: 12,
    padding: 12,
  },
  errorText: { color: COLORS.incorrect, fontSize: 13, fontWeight: '700' },

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
