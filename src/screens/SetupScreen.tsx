/**
 * SetupScreen - configure players, playlist and win condition, then start.
 *
 * On "Spiel starten" we load + shuffle the playlist into a deck, dispatch
 * START_GAME and hand off to the first player. (Spotify must already be
 * connected via the Spotify tab.) UI only - game logic unchanged.
 */
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useGame } from '../context/GameContext';
import { useSettings } from '../context/SettingsContext';
import * as Spotify from '../services/spotify';
import type { PlaylistSummary } from '../services/spotify';
import { PlaylistPicker } from './PlaylistPickerScreen';
import { PlaylistCheckModal } from './PlaylistCheckScreen';
import { COLORS } from '../theme/colors';
import type { GameStackParamList } from '../types/navigation';

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

type Nav = NativeStackNavigationProp<GameStackParamList, 'Setup'>;

export default function SetupScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { dispatch } = useGame();
  const { settings } = useSettings();

  const [names, setNames] = useState<string[]>(['', '']);
  const [playlist, setPlaylist] = useState<PlaylistSummary | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [checkVisible, setCheckVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  // Spotify Web-API auth gates "Spiel starten". Re-checked on focus, so connecting
  // in the Einstellungen tab and returning here enables the button automatically.
  const [spotifyAuthorized, setSpotifyAuthorized] = useState(Spotify.isWebApiAuthorized());

  useFocusEffect(
    useCallback(() => {
      setSpotifyAuthorized(Spotify.isWebApiAuthorized());
    }, [])
  );

  const setName = (i: number, value: string) =>
    setNames((prev) => prev.map((n, idx) => (idx === i ? value : n)));

  const addPlayer = () =>
    setNames((prev) => (prev.length < MAX_PLAYERS ? [...prev, ''] : prev));

  const removePlayer = (i: number) =>
    setNames((prev) =>
      prev.length > MIN_PLAYERS ? prev.filter((_, idx) => idx !== i) : prev
    );

  const startGame = async () => {
    setError(null);
    const trimmed = names.map((n) => n.trim());
    if (trimmed.some((n) => !n)) {
      setError('Bitte für jeden Spieler einen Namen eingeben.');
      return;
    }
    if (!playlist) {
      setError('Bitte eine Playlist auswählen.');
      return;
    }
    if (!Spotify.isReadyToPlay()) {
      setError(
        'Noch nicht mit Spotify verbunden. Bitte zuerst im Tab „Einstellungen" ' +
          'mit Spotify verbinden.'
      );
      return;
    }

    setLoading(true);
    try {
      const tracks = await Spotify.getPlaylistTracks(playlist.id);
      if (tracks.length < trimmed.length + 1) {
        setError(
          `Playlist hat nur ${tracks.length} verwendbare Tracks - zu wenige für ${trimmed.length} Spieler.`
        );
        return;
      }
      const deck = Spotify.shuffleDeck(tracks);
      dispatch({
        type: 'START_GAME',
        payload: {
          playerNames: trimmed,
          settings: {
            cardsToWin: settings.cardsToWin,
            playlistId: playlist.id,
            hideCoverUntilRevealed: settings.hideCoverUntilRevealed,
            chipsEnabled: settings.chipsEnabled,
          },
          deck,
        },
      });
      navigation.navigate('Intro');
    } catch (e: any) {
      const code = e?.code ? `[${e.code}] ` : '';
      setError(`${code}${e?.message ?? String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
   <View style={styles.root}>
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <Text style={styles.title}>NickelBrandt</Text>
        <Text style={styles.tagline}>● HOT-SEAT MUSIC PARTY ●</Text>
      </View>

      <Text style={styles.label}>SPIELER ({names.length})</Text>
      {names.map((name, i) => {
        const key = `player-${i}`;
        return (
          <View key={i} style={styles.playerRow}>
            <TextInput
              style={[styles.input, focused === key && styles.inputFocused]}
              placeholder={`Spieler ${i + 1}`}
              placeholderTextColor={COLORS.textMuted}
              value={name}
              onChangeText={(v) => setName(i, v)}
              onFocus={() => setFocused(key)}
              onBlur={() => setFocused(null)}
              maxLength={20}
            />
            {names.length > MIN_PLAYERS && (
              <Pressable
                style={styles.removeBtn}
                onPress={() => removePlayer(i)}
              >
                <Text style={styles.removeBtnText}>✕</Text>
              </Pressable>
            )}
          </View>
        );
      })}
      {names.length < MAX_PLAYERS && (
        <Pressable style={styles.addBtn} onPress={addPlayer}>
          <Text style={styles.addBtnText}>+  Spieler hinzufügen</Text>
        </Pressable>
      )}

      <Text style={styles.label}>PLAYLIST</Text>
      {playlist ? (
        <View style={styles.selectedCard}>
          {playlist.imageUrl ? (
            <Image source={{ uri: playlist.imageUrl }} style={styles.selectedCover} />
          ) : (
            <View style={[styles.selectedCover, styles.selectedCoverFallback]}>
              <Text style={styles.selectedGlyph}>💿</Text>
            </View>
          )}
          <View style={styles.selectedText}>
            <Text style={styles.selectedLabel}>Ausgewählt</Text>
            <Text style={styles.selectedName} numberOfLines={1}>
              {playlist.name}
            </Text>
            <Text style={styles.selectedMeta} numberOfLines={1}>
              {playlist.trackCount} Songs
            </Text>
          </View>
          <Pressable style={styles.changeBtn} onPress={() => setPickerVisible(true)}>
            <Text style={styles.changeBtnText}>Ändern</Text>
          </Pressable>
        </View>
      ) : null}
      {playlist && (
        <Pressable style={styles.checkBtn} onPress={() => setCheckVisible(true)}>
          <Text style={styles.checkBtnText}>🔍 Playlist prüfen (Jahre)</Text>
        </Pressable>
      )}
      {!playlist && (
        <Pressable style={styles.pickBtn} onPress={() => setPickerVisible(true)}>
          <Text style={styles.pickBtnText}>Playlist auswählen 🎵</Text>
        </Pressable>
      )}

      <Text style={styles.rulesNote}>
        Spielregeln (Karten zum Gewinnen, Varianten, Nickel) findest du im Tab
        „Einstellungen".
      </Text>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <Pressable
        style={[styles.startBtn, (loading || !spotifyAuthorized) && styles.startBtnDisabled]}
        onPress={startGame}
        disabled={loading || !spotifyAuthorized}
      >
        {loading ? (
          <ActivityIndicator color={COLORS.background} />
        ) : (
          <Text style={styles.startBtnText}>SPIEL STARTEN</Text>
        )}
      </Pressable>
      {!spotifyAuthorized && (
        <Text style={styles.spotifyGateHint}>
          Bitte zuerst mit Spotify verbinden (siehe Tab „Einstellungen").
        </Text>
      )}
    </ScrollView>
    <PlaylistPicker
      visible={pickerVisible}
      onClose={() => setPickerVisible(false)}
      onSelect={(p) => {
        setPlaylist(p);
        setError(null);
      }}
    />
    {playlist && (
      <PlaylistCheckModal
        visible={checkVisible}
        onClose={() => setCheckVisible(false)}
        playlistId={playlist.id}
        playlistName={playlist.name}
      />
    )}
   </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.background },
  screen: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 20, paddingBottom: 48, gap: 12 },

  header: { alignItems: 'center', marginTop: 16, marginBottom: 8 },
  title: {
    fontSize: 46,
    fontWeight: '900',
    color: COLORS.primary,
    letterSpacing: 0.5,
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },
  tagline: {
    marginTop: 4,
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 3,
  },

  label: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 2,
    marginTop: 16,
  },

  playerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: {
    flex: 1,
    minHeight: 52,
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.border,
    borderWidth: 2,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700',
  },
  inputFocused: {
    borderColor: COLORS.secondary,
    shadowColor: COLORS.secondary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 12,
    elevation: 8,
  },
  pickBtn: {
    minHeight: 60,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: COLORS.secondary,
    backgroundColor: COLORS.backgroundAlt,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.secondary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 12,
    elevation: 6,
  },
  pickBtnText: { color: COLORS.secondary, fontWeight: '900', fontSize: 17 },

  selectedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: COLORS.accent,
    padding: 12,
    shadowColor: COLORS.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 6,
  },
  selectedCover: { width: 52, height: 52, borderRadius: 10 },
  selectedCoverFallback: {
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedGlyph: { fontSize: 26, color: COLORS.border },
  selectedText: { flex: 1 },
  selectedLabel: {
    color: COLORS.accent,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
  },
  selectedName: { color: COLORS.text, fontSize: 17, fontWeight: '900' },
  selectedMeta: { color: COLORS.textMuted, fontSize: 12, fontWeight: '600' },
  changeBtn: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: COLORS.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  changeBtnText: { color: COLORS.secondary, fontWeight: '800', fontSize: 14 },

  checkBtn: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: COLORS.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  checkBtnText: { color: COLORS.textMuted, fontWeight: '800', fontSize: 14 },

  removeBtn: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: COLORS.incorrect,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeBtnText: { color: COLORS.text, fontWeight: '900', fontSize: 18 },

  addBtn: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: COLORS.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 18,
  },
  addBtnText: { color: COLORS.secondary, fontWeight: '800', fontSize: 15 },

  rulesNote: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 8,
    fontStyle: 'italic',
  },

  errorBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.incorrect,
    borderWidth: 2,
    borderRadius: 14,
    padding: 14,
  },
  errorText: { color: COLORS.incorrect, fontSize: 14, fontWeight: '700' },

  startBtn: {
    marginTop: 24,
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
  startBtnDisabled: { opacity: 0.5 },
  startBtnText: {
    color: COLORS.background,
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 1,
  },
  spotifyGateHint: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 8,
    fontStyle: 'italic',
  },
});
