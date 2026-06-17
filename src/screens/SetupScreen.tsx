/**
 * SetupScreen - configure players, playlist and win condition, then start.
 *
 * On "Spiel starten" we load + shuffle the playlist into a deck, dispatch
 * START_GAME and hand off to the first player. (Spotify must already be
 * connected via the Spotify tab.) UI only - game logic unchanged.
 */
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useGame } from '../context/GameContext';
import { useSettings } from '../context/SettingsContext';
import * as Spotify from '../services/spotify';
import { SettingsGear } from '../components/SettingsModal';
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
  const [playlist, setPlaylist] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  const setName = (i: number, value: string) =>
    setNames((prev) => prev.map((n, idx) => (idx === i ? value : n)));

  const addPlayer = () =>
    setNames((prev) => (prev.length < MAX_PLAYERS ? [...prev, ''] : prev));

  const removePlayer = (i: number) =>
    setNames((prev) =>
      prev.length > MIN_PLAYERS ? prev.filter((_, idx) => idx !== i) : prev
    );

  const pasteFromClipboard = async () => {
    setError(null);
    const text = (await Clipboard.getString())?.trim();
    if (!text) {
      setError('Zwischenablage ist leer.');
      return;
    }
    // Accept a Spotify URL/URI or a bare 22-char playlist id.
    const looksLikePlaylist =
      /spotify|playlist/i.test(text) || /^[A-Za-z0-9]{22}$/.test(text);
    if (!looksLikePlaylist) {
      setError('Zwischenablage enthält keinen Spotify-Playlist-Link.');
      return;
    }
    setPlaylist(text);
  };

  const startGame = async () => {
    setError(null);
    const trimmed = names.map((n) => n.trim());
    if (trimmed.some((n) => !n)) {
      setError('Bitte für jeden Spieler einen Namen eingeben.');
      return;
    }
    if (!playlist.trim()) {
      setError('Bitte eine Spotify-Playlist (URL oder ID) eingeben.');
      return;
    }
    if (!Spotify.isReadyToPlay()) {
      setError(
        'Noch nicht mit Spotify verbunden. Bitte zuerst im Spotify-Tab ' +
          '"Mit Spotify verbinden".'
      );
      return;
    }

    setLoading(true);
    try {
      const tracks = await Spotify.getPlaylistTracks(playlist);
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
            playlistId: Spotify.parsePlaylistId(playlist),
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

      <Text style={styles.label}>PLAYLIST (URL ODER ID)</Text>
      <TextInput
        style={[
          styles.input,
          styles.playlistInput,
          focused === 'playlist' && styles.inputFocused,
        ]}
        placeholder="https://open.spotify.com/playlist/…"
        placeholderTextColor={COLORS.textMuted}
        value={playlist}
        onChangeText={setPlaylist}
        onFocus={() => setFocused('playlist')}
        onBlur={() => setFocused(null)}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
      />
      <Pressable style={styles.pasteBtn} onPress={pasteFromClipboard}>
        <Text style={styles.pasteBtnText}>📋  Aus Zwischenablage einfügen</Text>
      </Pressable>

      <Text style={styles.rulesNote}>
        Spielregeln (Karten zum Gewinnen, Varianten, Nickel) findest du im ⚙️-Menü
        oben rechts.
      </Text>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <Pressable
        style={[styles.startBtn, loading && styles.startBtnDisabled]}
        onPress={startGame}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color={COLORS.background} />
        ) : (
          <Text style={styles.startBtnText}>SPIEL STARTEN</Text>
        )}
      </Pressable>
    </ScrollView>
    <SettingsGear />
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
  playlistInput: { minHeight: 64, fontSize: 15, fontWeight: '600' },

  pasteBtn: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: COLORS.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  pasteBtnText: { color: COLORS.secondary, fontWeight: '800', fontSize: 14 },

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
  startBtnDisabled: { opacity: 0.6 },
  startBtnText: {
    color: COLORS.background,
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 1,
  },
});
