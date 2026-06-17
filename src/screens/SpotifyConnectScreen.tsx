/**
 * SpotifyConnectScreen - connect / disconnect Spotify in the app's visual style.
 *
 * Replaces the old SpotifyTestScreen spike. Connecting here does the one-time
 * Remote + Web API login, so game start needs no browser popup. Uses only
 * existing spotify service exports (no changes to spotify.ts / game logic).
 */
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Spotify from '../services/spotify';
import { COLORS } from '../theme/colors';

// Spotify brand green (explicitly requested for the Spotify identity here).
const SPOTIFY_GREEN = '#1DB954';

export default function SpotifyConnectScreen() {
  const insets = useSafeAreaInsets();
  const [connected, setConnected] = useState(Spotify.isReadyToPlay());
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the display name when connected; clear it otherwise.
  const refreshName = useCallback(async (isConnected: boolean) => {
    if (!isConnected) {
      setDisplayName(null);
      return;
    }
    try {
      setDisplayName(await Spotify.getDisplayName());
    } catch {
      setDisplayName(null); // status still shows "Verbunden"
    }
  }, []);

  // Keep the status (and name) in sync when returning to this tab.
  useFocusEffect(
    useCallback(() => {
      const isConnected = Spotify.isReadyToPlay();
      setConnected(isConnected);
      refreshName(isConnected);
    }, [refreshName])
  );

  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await Spotify.connect();
      const isConnected = Spotify.isReadyToPlay();
      setConnected(isConnected);
      await refreshName(isConnected);
    } catch (e: any) {
      const code = e?.code ? `[${e.code}] ` : '';
      setError(`${code}${e?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await Spotify.disconnect();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setConnected(false);
      setDisplayName(null);
      setBusy(false);
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 32 }]}
    >
      <View style={styles.logoWrap}>
        <View style={styles.logoCircle}>
          <Text style={styles.logoGlyph}>♫</Text>
        </View>
        <Text style={styles.brand}>Spotify</Text>
      </View>

      <View
        style={[
          styles.statusCard,
          { borderColor: connected ? COLORS.correct : COLORS.border },
        ]}
      >
        <View
          style={[
            styles.statusDot,
            { backgroundColor: connected ? COLORS.correct : COLORS.textMuted },
          ]}
        />
        <Text style={styles.statusText} numberOfLines={1}>
          {connected
            ? displayName
              ? `Verbunden als ${displayName}`
              : 'Verbunden'
            : 'Nicht verbunden'}
        </Text>
      </View>

      <Text style={styles.hint}>
        {connected
          ? 'Du kannst jetzt ein Spiel starten.'
          : 'Verbinde dich, um Playlists zu laden und Tracks abzuspielen.'}
      </Text>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText} selectable>
            {error}
          </Text>
        </View>
      )}

      {!connected ? (
        <Pressable
          style={[styles.connectBtn, busy && styles.disabled]}
          onPress={handleConnect}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color={COLORS.text} />
          ) : (
            <Text style={styles.connectBtnText}>Mit Spotify verbinden</Text>
          )}
        </Pressable>
      ) : (
        <Pressable
          style={[styles.disconnectBtn, busy && styles.disabled]}
          onPress={handleDisconnect}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color={COLORS.incorrect} />
          ) : (
            <Text style={styles.disconnectBtnText}>Verbindung trennen</Text>
          )}
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 24, gap: 16, alignItems: 'center' },

  logoWrap: { alignItems: 'center', gap: 12, marginBottom: 8 },
  logoCircle: {
    width: 112,
    height: 112,
    borderRadius: 999,
    backgroundColor: SPOTIFY_GREEN,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: SPOTIFY_GREEN,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 20,
    elevation: 12,
  },
  logoGlyph: { fontSize: 56, color: COLORS.text, fontWeight: '900' },
  brand: { fontSize: 28, fontWeight: '900', color: COLORS.text },

  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 2,
    borderRadius: 16,
    paddingHorizontal: 20,
    paddingVertical: 16,
    alignSelf: 'stretch',
    justifyContent: 'center',
  },
  statusDot: { width: 14, height: 14, borderRadius: 999 },
  statusText: { color: COLORS.text, fontSize: 20, fontWeight: '900' },

  hint: {
    color: COLORS.textMuted,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },

  errorBox: {
    alignSelf: 'stretch',
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.incorrect,
    borderWidth: 2,
    borderRadius: 14,
    padding: 14,
  },
  errorText: { color: COLORS.incorrect, fontSize: 13, fontWeight: '700' },

  connectBtn: {
    alignSelf: 'stretch',
    minHeight: 60,
    backgroundColor: SPOTIFY_GREEN,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    shadowColor: SPOTIFY_GREEN,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 16,
    elevation: 10,
  },
  connectBtnText: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 0.5,
  },

  disconnectBtn: {
    alignSelf: 'stretch',
    minHeight: 56,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: COLORS.incorrect,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  disconnectBtnText: { color: COLORS.incorrect, fontSize: 16, fontWeight: '900' },

  disabled: { opacity: 0.6 },
});
