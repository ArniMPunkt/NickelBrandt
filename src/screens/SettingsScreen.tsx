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
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  Settings,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Spotify from '../services/spotify';
import { PressableButton } from '../components/PressableButton';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';

const APP_VERSION = 'v0.6.0';
const SPOTIFY_GREEN = '#1DB954';

// iOS only: the native uncaught-exception handler (plugins/withCrashDiagnostics)
// persists the last fatal NSException (name/reason/stack) to NSUserDefaults -
// RN's Settings module reads the same store. Survives app updates, so a crash
// of a build that never got past startup is still readable here later.
const CRASH_RECORD_KEY = 'NBLastNativeCrash';

function readCrashRecord(): string | null {
  if (Platform.OS !== 'ios') return null;
  try {
    const v = Settings.get(CRASH_RECORD_KEY);
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const [connected, setConnected] = useState(Spotify.isReadyToPlay());
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [crashRecord, setCrashRecord] = useState<string | null>(readCrashRecord);

  const clearCrashRecord = () => {
    try {
      Settings.set({ [CRASH_RECORD_KEY]: '' });
    } catch {
      // best effort
    }
    setCrashRecord(null);
  };

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

  // Live status: react to connect/disconnect events (e.g. iOS dropping the App
  // Remote in the background) even while this tab is already open - not just on
  // focus. subscribeConnection fires immediately with the current value too.
  useEffect(() => {
    const unsub = Spotify.subscribeConnection(() => {
      refresh();
    });
    return unsub;
  }, [refresh]);

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

      {/* Spielregeln editing moved INLINE to where the rules apply: the Party
          lobby (host, hitster mode) and the Pass & Play setup - see
          components/GameRulesSection. This tab keeps Spotify + app info. */}

      {/* ---- App info ---- */}
      <Text style={styles.section}>APP-INFO</Text>
      <View style={styles.card}>
        <Text style={styles.infoRow}>Version {APP_VERSION}</Text>
        <Text style={styles.about}>
          NickelBrandt — Musik-Party-Spiel. Errate das Jahr, sammle Nickel und klau dir
          Karten von Mitspielern. Aber passt auf, dass du dich am Ende nicht VerBrandt hast.
        </Text>
      </View>

      {/* ---- Crash diagnostics (iOS): last recorded native exception ---- */}
      {crashRecord != null && (
        <>
          <Text style={styles.section}>LETZTER NATIVER CRASH</Text>
          <View style={[styles.card, styles.crashCard]}>
            <Text style={styles.crashText} selectable>
              {crashRecord}
            </Text>
            <PressableButton style={styles.placeholderBtn} onPress={clearCrashRecord}>
              <Text style={styles.placeholderText}>Eintrag verwerfen</Text>
            </PressableButton>
          </View>
        </>
      )}

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

  crashCard: { borderColor: COLORS.incorrect, borderWidth: 2 },
  crashText: {
    color: COLORS.text,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 15,
  },
});
