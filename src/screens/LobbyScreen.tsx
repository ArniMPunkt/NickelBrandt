/**
 * LobbyScreen - waiting room. Shows the join code and the live player list.
 * Host connects Spotify + picks a playlist, then starts the game; all devices
 * auto-navigate to OnlineGame once the lobby status becomes 'playing'.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Online from '../services/supabase';
import * as Spotify from '../services/spotify';
import { useSettings } from '../context/SettingsContext';
import { PlaylistPicker } from './PlaylistPickerScreen';
import { COLORS } from '../theme/colors';
import type { OnlineStackParamList } from '../types/navigation';
import type { LobbyPlayer } from '../types/online';
import type { PlaylistSummary } from '../services/spotify';

type Nav = NativeStackNavigationProp<OnlineStackParamList, 'Lobby'>;
type LobbyRoute = RouteProp<OnlineStackParamList, 'Lobby'>;

export default function LobbyScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { lobbyId, code } = useRoute<LobbyRoute>().params;
  const { settings } = useSettings();

  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [starting, setStarting] = useState(false);

  const myId = Online.getPlayerId();
  const me = players.find((p) => p.player_id === myId);
  const isHost = !!me?.is_host;

  const refresh = useCallback(async () => {
    try {
      const [lobby, list] = await Promise.all([
        Online.getLobby(lobbyId),
        Online.getLobbyPlayers(lobbyId),
      ]);
      setPlayers(list);
      if (lobby.status === 'playing') {
        navigation.navigate('OnlineGame', { lobbyId });
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [lobbyId, navigation]);

  useEffect(() => {
    console.log(`[LobbyDebug] LobbyScreen MOUNT lobbyId=${lobbyId} myId=${myId}`);
    let disposed = false;
    let unsub: (() => void) | null = null;
    let reconnecting = false; // suppress the CLOSED we cause when tearing down
    let reconnectScheduled = false;

    // Recover from a stale realtime socket: re-fetch now, then re-subscribe.
    const handleStatus = (status: string) => {
      if (disposed) return;
      const bad =
        status === 'CLOSED' || status === 'TIMED_OUT' || status === 'CHANNEL_ERROR';
      if (!bad || reconnecting) return;
      console.log('[LobbyDebug] bad channel status -> refetch + resubscribe:', status);
      refresh();
      if (reconnectScheduled) return;
      reconnectScheduled = true;
      setTimeout(() => {
        reconnectScheduled = false;
        if (disposed) return;
        reconnecting = true;
        unsub?.();
        unsub = Online.subscribeToGameState(lobbyId, refresh, handleStatus);
        setTimeout(() => {
          reconnecting = false;
        }, 600);
        refresh();
      }, 1500);
    };

    refresh();
    unsub = Online.subscribeToGameState(lobbyId, refresh, handleStatus);

    // Safety-net polling while in the lobby (covers any missed realtime event).
    const poll = setInterval(refresh, 5000);

    return () => {
      console.log(`[LobbyDebug] LobbyScreen UNMOUNT lobbyId=${lobbyId}`);
      disposed = true;
      clearInterval(poll);
      unsub?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobbyId, refresh]);

  // Re-entering the Online tab re-fetches (tab screens stay mounted, so the
  // mount effect above does NOT re-run on focus).
  useFocusEffect(
    useCallback(() => {
      console.log('[LobbyDebug] LobbyScreen FOCUSED -> refresh');
      refresh();
    }, [refresh])
  );

  const leave = async () => {
    try {
      await Online.leaveLobby(lobbyId);
    } catch {
      // ignore - leaving anyway
    } finally {
      navigation.navigate('OnlineHome');
    }
  };

  const onStartPressed = () => {
    setError(null);
    if (players.length < 2) {
      setError('Mindestens 2 Spieler nötig.');
      return;
    }
    if (!Spotify.isReadyToPlay()) {
      setError('Bitte zuerst im Spotify-Tab verbinden (nur der Host braucht Spotify).');
      return;
    }
    setPickerVisible(true);
  };

  const onPlaylistChosen = async (playlist: PlaylistSummary) => {
    setStarting(true);
    setError(null);
    try {
      const cards = await Spotify.getPlaylistTracks(playlist.id);
      await Online.startGame(lobbyId, cards, {
        cardsToWin: settings.cardsToWin,
        hideCoverUntilRevealed: settings.hideCoverUntilRevealed,
      });
      // Navigation happens via the realtime subscription (status -> 'playing').
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 24 }]}
    >
      <Text style={styles.label}>LOBBY-CODE</Text>
      <View style={styles.codeBox}>
        <Text style={styles.codeText}>{code}</Text>
      </View>
      <Text style={styles.codeHint}>Teile diesen Code mit deinen Freunden.</Text>

      <Text style={styles.label}>SPIELER ({players.length})</Text>
      {players.length === 0 ? (
        <Text style={styles.muted}>Lade Spieler…</Text>
      ) : (
        players.map((p) => (
          <View key={p.id} style={styles.playerRow}>
            <Text style={styles.playerName} numberOfLines={1}>
              {p.player_name}
              {p.player_id === myId ? ' (du)' : ''}
            </Text>
            {p.is_host && (
              <View style={styles.hostBadge}>
                <Text style={styles.hostBadgeText}>HOST</Text>
              </View>
            )}
          </View>
        ))
      )}

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {isHost ? (
        <Pressable
          style={[styles.startBtn, starting && styles.disabled]}
          onPress={onStartPressed}
          disabled={starting}
        >
          {starting ? (
            <ActivityIndicator color={COLORS.background} />
          ) : (
            <Text style={styles.startBtnText}>SPIEL STARTEN</Text>
          )}
        </Pressable>
      ) : (
        <Text style={styles.waitText}>Warte auf Host…</Text>
      )}

      <Pressable style={styles.leaveBtn} onPress={leave}>
        <Text style={styles.leaveBtnText}>Lobby verlassen</Text>
      </Pressable>

      <PlaylistPicker
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onSelect={onPlaylistChosen}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 24, gap: 10 },

  label: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 2,
    marginTop: 12,
  },
  codeBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.primary,
    borderWidth: 2,
    borderRadius: 18,
    paddingVertical: 18,
    alignItems: 'center',
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 16,
    elevation: 8,
  },
  codeText: {
    color: COLORS.primary,
    fontSize: 44,
    fontWeight: '900',
    letterSpacing: 10,
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 16,
  },
  codeHint: { color: COLORS.textMuted, fontSize: 13, fontWeight: '600', textAlign: 'center' },

  muted: { color: COLORS.textMuted, fontSize: 15, fontWeight: '600' },
  playerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 52,
  },
  playerName: { color: COLORS.text, fontSize: 17, fontWeight: '800', flexShrink: 1 },
  hostBadge: {
    backgroundColor: COLORS.accent,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  hostBadgeText: { color: COLORS.background, fontSize: 11, fontWeight: '900', letterSpacing: 1 },

  errorBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.incorrect,
    borderWidth: 2,
    borderRadius: 14,
    padding: 14,
  },
  errorText: { color: COLORS.incorrect, fontSize: 14, fontWeight: '700' },

  startBtn: {
    marginTop: 20,
    minHeight: 60,
    backgroundColor: COLORS.secondary,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.secondary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 16,
    elevation: 10,
  },
  startBtnText: { color: COLORS.background, fontSize: 20, fontWeight: '900', letterSpacing: 1 },
  waitText: {
    marginTop: 20,
    color: COLORS.textMuted,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    fontStyle: 'italic',
  },

  disabled: { opacity: 0.6 },

  leaveBtn: {
    marginTop: 12,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: COLORS.incorrect,
    alignItems: 'center',
    justifyContent: 'center',
  },
  leaveBtnText: { color: COLORS.incorrect, fontSize: 15, fontWeight: '900' },
});
