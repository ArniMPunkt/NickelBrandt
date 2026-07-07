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
  Alert,
  Image,
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
import { loadDeckSource, sourceId, type DeckSource } from '../services/deck';
import * as PoolProgress from '../services/poolProgress';
import { shuffle } from '../game/cards';
import { PlaylistPicker } from './PlaylistPickerScreen';
import { PlaylistCheckModal } from './PlaylistCheckScreen';
import { PressableButton } from '../components/PressableButton';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
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
  const [source, setSource] = useState<DeckSource | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [checkVisible, setCheckVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  // "Spiel starten" is gated on the FULL Spotify readiness (Web-API token AND a
  // confirmed App-Remote connection), not just the web authorization: on a
  // failed connect the PKCE web step may have succeeded while the app-to-app
  // connection was refused - the button must stay locked then. Re-checked on
  // focus, so connecting in the Einstellungen tab and returning enables it.
  const [spotifyAuthorized, setSpotifyAuthorized] = useState(Spotify.isReadyToPlay());

  useFocusEffect(
    useCallback(() => {
      setSpotifyAuthorized(Spotify.isReadyToPlay());
      // Between-games heal: the App Remote routinely drops after a finished
      // Partie (idle unbind / background teardown). Probe + silently reconnect
      // so the screen doesn't demand a manual reconnect; no-op if never
      // connected, never an interactive app switch.
      Spotify.ensureReadyToPlay()
        .then((ready) => setSpotifyAuthorized(ready))
        .catch(() => {});
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
    if (!source) {
      setError('Bitte eine Playlist oder einen Themen-Pool auswählen.');
      return;
    }
    setLoading(true);
    try {
      // Self-healing gate: probes the App Remote and silently reconnects a
      // dropped session (routine after a finished Partie) before refusing.
      if (!(await Spotify.ensureReadyToPlay())) {
        setError(
          'Noch nicht mit Spotify verbunden. Bitte zuerst im Tab „Einstellungen" ' +
            'mit Spotify verbinden.'
        );
        return;
      }
      let tracks = await loadDeckSource(source);
      if (tracks.length < trimmed.length + 1) {
        setError(
          `${source.kind === 'pool' ? 'Pool' : 'Playlist'} hat nur ${tracks.length} verwendbare Tracks - zu wenige für ${trimmed.length} Spieler.`
        );
        return;
      }

      // Pool progress: prefer songs never drawn on this device. If too few
      // fresh songs remain for a playable game, auto-reset THIS pool (clear +
      // notice) instead of silently mixing played songs back in - "der Pool ist
      // einmal durch" is understandable; invisible repeats are not.
      let poolWasReset = false;
      if (source.kind === 'pool') {
        const played = await PoolProgress.getPlayedIds(source.pool.id);
        const fresh = tracks.filter((t) => !played.has(t.id));
        if (fresh.length >= trimmed.length + 1) {
          tracks = fresh;
        } else if (played.size > 0) {
          await PoolProgress.resetPlayed(source.pool.id);
          poolWasReset = true;
        }
      }

      // Covers (pool decks only; playlists already carry them): fetch ONLY what
      // the game needs immediately - one start card per player + the first
      // playing card (+ a small buffer). Everything else loads in the
      // background below; "Spiel starten" never waits on the full pool.
      const deck = await Spotify.addCoverArtUrgent(shuffle(tracks), trimmed.length + 3);
      // The dealt start cards count as drawn immediately (aborted games too).
      if (source.kind === 'pool') {
        PoolProgress.addPlayedIds(
          source.pool.id,
          deck.slice(0, trimmed.length).map((c) => c.id)
        ).catch(() => {});
      }
      if (poolWasReset) {
        Alert.alert(
          'Pool durchgespielt 🎉',
          'Fast alle Songs dieses Pools waren schon dran — der Fortschritt wurde zurückgesetzt, alle Songs sind wieder im Rennen.'
        );
      }
      dispatch({
        type: 'START_GAME',
        payload: {
          playerNames: trimmed,
          settings: {
            cardsToWin: settings.cardsToWin,
            playlistId: sourceId(source),
            hideCoverUntilRevealed: settings.hideCoverUntilRevealed,
            chipsEnabled: settings.chipsEnabled,
            skipEnabled: settings.skipEnabled,
            skipCost: settings.skipCost,
            blindEnabled: settings.blindEnabled,
            blindCost: settings.blindCost,
            timerEnabled: settings.timerEnabled,
            timerSeconds: settings.timerSeconds,
          },
          deck,
        },
      });
      // Remaining covers load in the background while the game runs; each
      // resolved chunk is merged into the reducer state (pure ADD_COVERS).
      // dispatch stays valid after navigation (provider lives at app level).
      Spotify.startCoverArtPrefetch(deck, (covers) =>
        dispatch({ type: 'ADD_COVERS', payload: { covers } })
      );
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
      {/* The big "NickelBrandt" headline moved to the Party home screen (the
          app's main mode); this mode keeps a compact title of its own. */}
      <View style={styles.header}>
        <Text style={styles.title}>Pass & Play</Text>
        <Text style={styles.tagline}>● EIN GERÄT · REIHUM RATEN ●</Text>
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
              <PressableButton
                style={styles.removeBtn}
                onPress={() => removePlayer(i)}
              >
                <Text style={styles.removeBtnText}>✕</Text>
              </PressableButton>
            )}
          </View>
        );
      })}
      {names.length < MAX_PLAYERS && (
        <PressableButton style={styles.addBtn} onPress={addPlayer}>
          <Text style={styles.addBtnText}>+  Spieler hinzufügen</Text>
        </PressableButton>
      )}

      <Text style={styles.label}>MUSIK</Text>
      {source ? (
        <View style={styles.selectedCard}>
          {source.kind === 'playlist' && source.playlist.imageUrl ? (
            <Image source={{ uri: source.playlist.imageUrl }} style={styles.selectedCover} />
          ) : (
            <View style={[styles.selectedCover, styles.selectedCoverFallback]}>
              <Text style={styles.selectedGlyph}>{source.kind === 'pool' ? '🎵' : '💿'}</Text>
            </View>
          )}
          <View style={styles.selectedText}>
            <Text style={styles.selectedLabel}>Ausgewählt</Text>
            <Text style={styles.selectedName} numberOfLines={1}>
              {source.kind === 'playlist' ? source.playlist.name : source.pool.name}
            </Text>
            <Text style={styles.selectedMeta} numberOfLines={1}>
              {source.kind === 'playlist' ? `${source.playlist.trackCount} Songs` : 'Themen-Pool'}
            </Text>
          </View>
          <PressableButton style={styles.changeBtn} onPress={() => setPickerVisible(true)}>
            <Text style={styles.changeBtnText}>Ändern</Text>
          </PressableButton>
        </View>
      ) : null}
      {source?.kind === 'playlist' && (
        <PressableButton style={styles.checkBtn} onPress={() => setCheckVisible(true)}>
          <Text style={styles.checkBtnText}>🔍 Playlist prüfen (Jahre)</Text>
        </PressableButton>
      )}
      {!source && (
        <PressableButton style={styles.pickBtn} onPress={() => setPickerVisible(true)}>
          <Text style={styles.pickBtnText}>Playlist oder Pool wählen 🎵</Text>
        </PressableButton>
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

      <PressableButton
        style={[styles.startBtn, (loading || !spotifyAuthorized) && styles.startBtnDisabled]}
        onPress={startGame}
        disabled={loading || !spotifyAuthorized}
      >
        {loading ? (
          <ActivityIndicator color={COLORS.background} />
        ) : (
          <Text style={styles.startBtnText}>SPIEL STARTEN</Text>
        )}
      </PressableButton>
      {!spotifyAuthorized && (
        <Text style={styles.spotifyGateHint}>
          Bitte zuerst mit Spotify verbinden (siehe Tab „Einstellungen").
        </Text>
      )}
    </ScrollView>
    <PlaylistPicker
      visible={pickerVisible}
      onClose={() => setPickerVisible(false)}
      showPoolProgress
      onSelect={(s) => {
        setSource(s);
        setError(null);
      }}
    />
    {source?.kind === 'playlist' && (
      <PlaylistCheckModal
        visible={checkVisible}
        onClose={() => setCheckVisible(false)}
        playlistId={source.playlist.id}
        playlistName={source.playlist.name}
      />
    )}
   </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.background },
  screen: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 20, paddingBottom: 48, gap: 12 },

  header: { alignItems: 'flex-start', marginTop: 8, marginBottom: 8 },
  title: {
    fontSize: 34,
    fontWeight: '900',
    color: COLORS.primary,
    letterSpacing: 0.5,
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12,
  },
  tagline: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 2,
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
    ...glow(COLORS.secondary, { radius: 12, opacity: 0.9 }),
  },
  pickBtn: {
    minHeight: 60,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: COLORS.secondary,
    backgroundColor: COLORS.backgroundAlt,
    alignItems: 'center',
    justifyContent: 'center',
    ...glow(COLORS.secondary, { radius: 12, opacity: 0.6 }),
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
    ...glow(COLORS.accent, { radius: 12, opacity: 0.5 }),
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
    ...glow(COLORS.secondary, { radius: 16, opacity: 0.8 }),
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
