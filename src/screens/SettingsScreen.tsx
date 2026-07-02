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
import { PressableButton } from '../components/PressableButton';
import { StepSlider } from '../components/StepSlider';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';

const APP_VERSION = 'v0.5.0';
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
          <PressableButton style={styles.dangerBtn} onPress={disconnect} disabled={busy}>
            {busy ? (
              <ActivityIndicator color={COLORS.incorrect} />
            ) : (
              <Text style={styles.dangerText}>Verbindung trennen</Text>
            )}
          </PressableButton>
        ) : (
          <PressableButton style={[styles.connectBtn, busy && styles.disabled]} onPress={connect} disabled={busy}>
            {busy ? (
              <ActivityIndicator color={COLORS.text} />
            ) : (
              <Text style={styles.connectBtnText}>Mit Spotify verbinden</Text>
            )}
          </PressableButton>
        )}
      </View>

      {/* ---- Game rules ---- */}
      <Text style={styles.section}>SPIELREGELN</Text>
      <View style={styles.card}>
        <View style={styles.winHeader}>
          <Text style={styles.ruleLabel}>Karten zum Gewinnen</Text>
          <Text style={styles.winValue}>{settings.cardsToWin}</Text>
        </View>
        <StepSlider
          value={settings.cardsToWin}
          min={5}
          max={20}
          milestones={[5, 10, 15, 20]}
          onChange={(v) => update({ cardsToWin: v })}
        />

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

        <View style={styles.ruleToggleRow}>
          <View style={styles.toggleTextWrap}>
            <Text style={styles.toggleTitle}>Karte überspringen</Text>
            <Text style={styles.toggleHint}>
              Aktuelle Karte gegen Nickel abwerfen und eine neue ziehen
            </Text>
          </View>
          <Switch
            value={settings.skipEnabled}
            onValueChange={(v) => update({ skipEnabled: v })}
            trackColor={{ false: COLORS.border, true: COLORS.primary }}
            thumbColor={COLORS.text}
            ios_backgroundColor={COLORS.border}
          />
        </View>
        {settings.skipEnabled && (
          <View style={styles.costBlock}>
            <View style={styles.winHeader}>
              <Text style={styles.costLabel}>Kosten pro Überspringen</Text>
              <Text style={styles.costValue}>{settings.skipCost} 🪙</Text>
            </View>
            <StepSlider
              value={settings.skipCost}
              min={1}
              max={3}
              milestones={[1, 2, 3]}
              onChange={(v) => update({ skipCost: v })}
            />
          </View>
        )}

        <View style={styles.ruleToggleRow}>
          <View style={styles.toggleTextWrap}>
            <Text style={styles.toggleTitle}>Karte ohne Raten ziehen</Text>
            <Text style={styles.toggleHint}>
              Karte wird gegen Nickel automatisch richtig einsortiert; Zug endet sofort
            </Text>
          </View>
          <Switch
            value={settings.blindEnabled}
            onValueChange={(v) => update({ blindEnabled: v })}
            trackColor={{ false: COLORS.border, true: COLORS.primary }}
            thumbColor={COLORS.text}
            ios_backgroundColor={COLORS.border}
          />
        </View>
        {settings.blindEnabled && (
          <View style={styles.costBlock}>
            <View style={styles.winHeader}>
              <Text style={styles.costLabel}>Kosten pro Blind-Zug</Text>
              <Text style={styles.costValue}>{settings.blindCost} 🪙</Text>
            </View>
            <StepSlider
              value={settings.blindCost}
              min={3}
              max={5}
              milestones={[3, 4, 5]}
              onChange={(v) => update({ blindCost: v })}
            />
          </View>
        )}
      </View>

      {/* ---- App info ---- */}
      <Text style={styles.section}>APP-INFO</Text>
      <View style={styles.card}>
        <Text style={styles.infoRow}>Version {APP_VERSION}</Text>
        <Text style={styles.about}>
          NickelBrandt — Musik-Party-Spiel. Errate das Jahr, sammle Nickel und klau dir
          Karten von Mitspielern. Aber passt auf, dass du dich am Ende nicht VerBrandt hast.
        </Text>
      </View>

      {/* ---- Data ---- */}
      <Text style={styles.section}>DATEN</Text>
      <View style={styles.card}>
        <PressableButton style={styles.placeholderBtn} onPress={resetStats}>
          <Text style={styles.placeholderText}>Spielstatistiken zurücksetzen</Text>
        </PressableButton>
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
  winHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  winValue: {
    color: COLORS.accent,
    fontSize: 24,
    fontWeight: '900',
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  ruleToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  toggleTextWrap: { flex: 1 },
  toggleTitle: { color: COLORS.text, fontSize: 15, fontWeight: '800' },
  toggleHint: { color: COLORS.textMuted, fontSize: 12, fontWeight: '600', marginTop: 2 },
  costBlock: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  costLabel: { color: COLORS.textMuted, fontSize: 13, fontWeight: '700' },
  costValue: { color: COLORS.accent, fontSize: 16, fontWeight: '900' },

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
