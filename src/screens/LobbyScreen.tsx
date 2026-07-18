/**
 * LobbyScreen - waiting room. Shows the join code and the live player list.
 * Host connects Spotify + picks a themed pool, then starts the game; all devices
 * auto-navigate to OnlineGame once the lobby status becomes 'playing'.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { ConfirmDialog } from '../components/ConfirmDialog';
import { GameRulesSection } from '../components/GameRulesSection';
import { PoolIcon } from '../components/PoolIcon';
import { PressableButton } from '../components/PressableButton';
import { missingRequirements, StartRequirementsHint } from '../components/StartRequirements';
import { StepSlider } from '../components/StepSlider';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import type { OnlineStackParamList } from '../types/navigation';
import type { GameMode, Lobby, LobbyPlayer, ModeConfig } from '../types/online';
import {
  BINGO_ROUND_SECONDS,
  BINGO_SONG_SECONDS_MAX,
  BINGO_SONG_SECONDS_MIN,
} from '../game/bingo';
import { loadDeckSource, sourceId, sourceName, type DeckSource } from '../services/deck';

const MODES: Array<{ mode: GameMode; label: string }> = [
  { mode: 'hitster', label: 'Hitster' },
  { mode: 'bingo', label: 'Bingo' },
  { mode: 'timeline_quiz', label: 'Timeline-Quiz' },
];

const MODE_LABEL: Record<GameMode, string> = {
  hitster: 'Hitster',
  bingo: 'Bingo',
  timeline_quiz: 'Timeline-Quiz',
};

const DEFAULT_QUIZ_CARDS = 15;

/** Default mode config written when the host switches to a mode. */
function defaultConfigFor(mode: GameMode): ModeConfig {
  if (mode === 'bingo') {
    return {
      bingoGridSize: 4,
      bingoDifficulty: 'easy',
      bingoSongSeconds: BINGO_ROUND_SECONDS,
    };
  }
  if (mode === 'timeline_quiz') return { timelineCardCount: DEFAULT_QUIZ_CARDS };
  return {};
}

type Nav = NativeStackNavigationProp<OnlineStackParamList, 'Lobby'>;
type LobbyRoute = RouteProp<OnlineStackParamList, 'Lobby'>;

export default function LobbyScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { lobbyId, code } = useRoute<LobbyRoute>().params;
  const { settings } = useSettings();

  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [starting, setStarting] = useState(false);
  const [endConfirmVisible, setEndConfirmVisible] = useState(false);
  // The host's chosen deck source, picked BEFORE starting (visible in the
  // Songpool row). Local to the host device - only the host loads the deck.
  const [source, setSource] = useState<DeckSource | null>(null);
  // Local slider value for the timeline-quiz card count (written to the lobby
  // only on release, so dragging doesn't spam Supabase).
  const [quizCards, setQuizCards] = useState(DEFAULT_QUIZ_CARDS);
  // Same pattern for the bingo Song-Zeit slider.
  const [songSeconds, setSongSeconds] = useState(BINGO_ROUND_SECONDS);

  const myId = Online.getPlayerId();
  const me = players.find((p) => p.player_id === myId);
  const isHost = !!me?.is_host;

  // One-time server-clock sync while everyone waits: the game modes coordinate
  // via serverNow()-based timestamps (see services/supabase), so each device
  // corrects its own clock skew before the first round starts.
  useEffect(() => {
    Online.syncServerClock();
  }, []);
  // Navigate to the intro exactly once when the game starts (guards against the
  // realtime/poll re-firing and yanking the player back from Intro/Game).
  const navigatedRef = useRef(false);
  // Handle a host-ended lobby exactly once.
  const endedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [lobby, list] = await Promise.all([
        Online.getLobby(lobbyId),
        Online.getLobbyPlayers(lobbyId),
      ]);
      setPlayers(list);
      setLobby(lobby);
      // Host ended the lobby from the waiting room. Once the game has started
      // (navigatedRef set), OnlineGameScreen owns this transition instead.
      if (lobby.status === 'ended' && !endedRef.current && !navigatedRef.current) {
        endedRef.current = true;
        Online.clearLastLobbyId().catch(() => {});
        Alert.alert('Lobby beendet', 'Der Host hat die Lobby beendet.');
        navigation.navigate('OnlineHome');
        return;
      }
      // Rematch flow: the lobby was reopened ('waiting' again) - re-arm the
      // one-shot start navigation so the NEXT game start navigates again.
      if (lobby.status === 'waiting') {
        navigatedRef.current = false;
      }
      if (lobby.status === 'playing' && !navigatedRef.current) {
        navigatedRef.current = true;
        // Route by mode: the simultaneous modes have no start cards -> no intro.
        const mode = lobby.game_mode ?? 'hitster';
        if (mode === 'bingo') {
          navigation.navigate('BingoGame', { lobbyId });
        } else if (mode === 'timeline_quiz') {
          navigation.navigate('TimelineQuiz', { lobbyId });
        } else {
          navigation.navigate('OnlineIntro', { lobbyId });
        }
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [lobbyId, navigation]);

  useEffect(() => {
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
      refresh();
    }, [refresh])
  );

  const gameMode: GameMode = lobby?.game_mode ?? 'hitster';
  const modeConfig: ModeConfig = lobby?.mode_config ?? {};

  // Keep the local sliders in sync with the synced config (keyed on the synced
  // value, so they never fight an ongoing local drag).
  useEffect(() => {
    const synced = lobby?.mode_config?.timelineCardCount;
    if (synced != null) setQuizCards(synced);
  }, [lobby?.mode_config?.timelineCardCount]);
  useEffect(() => {
    const synced = lobby?.mode_config?.bingoSongSeconds;
    if (synced != null) setSongSeconds(synced);
  }, [lobby?.mode_config?.bingoSongSeconds]);

  // --- Host: mode selection (visible to everyone via the lobbies row) ---
  const writeMode = (mode: GameMode, config: ModeConfig) => {
    setError(null);
    Online.setLobbyMode(lobbyId, mode, config)
      .then(refresh)
      .catch((e: any) => setError(e?.message ?? String(e)));
  };
  const onSelectMode = (mode: GameMode) => {
    if (mode !== gameMode) writeMode(mode, defaultConfigFor(mode));
  };

  const leave = async () => {
    try {
      await Online.leaveLobby(lobbyId);
    } catch {
      // ignore - leaving anyway
    } finally {
      navigation.navigate('OnlineHome');
    }
  };

  // Host-only: end the whole lobby for everyone (with a safety confirmation).
  const endLobby = () => setEndConfirmVisible(true);
  const confirmEndLobby = async () => {
    setEndConfirmVisible(false);
    endedRef.current = true; // suppress our own "host ended" alert
    try {
      await Online.endLobby(lobbyId);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      navigation.navigate('OnlineHome');
    }
  };

  // Start prerequisites: the button stays DISABLED (with a quiet checklist
  // below it) until everything is fulfilled. Min players is 2 in all three
  // modes (mirrors the server-side checks in start{Game,BingoGame,TimelineQuiz});
  // bingo grid size / quiz card count always carry defaults, so they can never
  // block. Spotify is deliberately NOT gated statically here - it is checked
  // at press time via the self-healing ensureReadyToPlay gate below.
  const missing = missingRequirements({
    playerCount: players.length,
    minPlayers: 2,
    hasSource: !!source,
  });
  const canStart = missing.length === 0;

  const onStartPressed = async () => {
    setError(null);
    if (!canStart || !source) return; // defensive - the button is disabled then
    // Self-healing gate: probes the App Remote and silently reconnects a
    // dropped session (routine after a finished Partie) before refusing.
    // `starting` doubles as the busy indicator during the short probe.
    setStarting(true);
    let ready = false;
    try {
      ready = await Spotify.ensureReadyToPlay();
    } finally {
      setStarting(false);
    }
    if (!ready) {
      setError('Bitte zuerst im Tab „Einstellungen" mit Spotify verbinden (nur der Host braucht Spotify).');
      return;
    }
    void onSourceChosen(source);
  };

  const onSourceChosen = async (source: DeckSource) => {
    setStarting(true);
    setError(null);
    try {
      const cards = await loadDeckSource(source);
      // Deck-source snapshot for "Song melden" reports (written to game_state).
      const src = { sourceId: sourceId(source), sourceName: sourceName(source) };
      if (gameMode === 'bingo') {
        await Online.startBingoGame(lobbyId, cards, {
          bingoGridSize: modeConfig.bingoGridSize ?? 4,
          bingoDifficulty: modeConfig.bingoDifficulty ?? 'easy',
          bingoSongSeconds: modeConfig.bingoSongSeconds ?? BINGO_ROUND_SECONDS,
          ...src,
        });
      } else if (gameMode === 'timeline_quiz') {
        await Online.startTimelineQuiz(lobbyId, cards, {
          timelineCardCount: modeConfig.timelineCardCount ?? DEFAULT_QUIZ_CARDS,
          ...src,
        });
      } else {
        await Online.startGame(lobbyId, cards, {
          cardsToWin: settings.cardsToWin,
          hideCoverUntilRevealed: settings.hideCoverUntilRevealed,
          skipEnabled: settings.skipEnabled,
          skipCost: settings.skipCost,
          blindEnabled: settings.blindEnabled,
          blindCost: settings.blindCost,
          timerEnabled: settings.timerEnabled,
          timerSeconds: settings.timerSeconds,
          chipLimitEnabled: settings.chipLimitEnabled,
          chipLimit: settings.chipLimit,
          ...src,
        });
      }
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

      <Text style={styles.label}>SPIELMODUS</Text>
      {isHost ? (
        <>
          <View style={styles.modeRow}>
            {MODES.map(({ mode, label }) => {
              const active = gameMode === mode;
              return (
                <PressableButton
                  key={mode}
                  style={[styles.modeBtn, active && styles.modeBtnActive]}
                  onPress={() => onSelectMode(mode)}
                >
                  <Text style={[styles.modeBtnText, active && styles.modeBtnTextActive]}>
                    {label}
                  </Text>
                </PressableButton>
              );
            })}
          </View>
          {gameMode === 'hitster' && (
            <>
              <Text style={styles.label}>SPIELREGELN</Text>
              <GameRulesSection />
            </>
          )}
          {gameMode === 'bingo' && (
            <View style={styles.modeConfigBox}>
              <Text style={styles.modeConfigLabel}>Grid-Größe</Text>
              <View style={styles.modeRow}>
                {([4, 5] as const).map((size) => {
                  const active = (modeConfig.bingoGridSize ?? 4) === size;
                  return (
                    <PressableButton
                      key={size}
                      style={[styles.modeBtn, active && styles.modeBtnActive]}
                      onPress={() => writeMode('bingo', { ...modeConfig, bingoGridSize: size })}
                    >
                      <Text style={[styles.modeBtnText, active && styles.modeBtnTextActive]}>
                        {size}×{size}
                      </Text>
                    </PressableButton>
                  );
                })}
              </View>
              <Text style={styles.modeConfigLabel}>Schwierigkeit</Text>
              <View style={styles.modeRow}>
                {(['easy', 'hard'] as const).map((d) => {
                  const active = (modeConfig.bingoDifficulty ?? 'easy') === d;
                  return (
                    <PressableButton
                      key={d}
                      style={[styles.modeBtn, active && styles.modeBtnActive]}
                      onPress={() => writeMode('bingo', { ...modeConfig, bingoDifficulty: d })}
                    >
                      <Text style={[styles.modeBtnText, active && styles.modeBtnTextActive]}>
                        {d === 'easy' ? 'Easy' : 'Hard'}
                      </Text>
                    </PressableButton>
                  );
                })}
              </View>
              <View style={styles.modeConfigHeader}>
                <Text style={styles.modeConfigLabel}>Song-Zeit</Text>
                <Text style={styles.modeConfigValue}>{songSeconds}s</Text>
              </View>
              <StepSlider
                value={songSeconds}
                min={BINGO_SONG_SECONDS_MIN}
                max={BINGO_SONG_SECONDS_MAX}
                milestones={[BINGO_SONG_SECONDS_MIN, 45, 60, BINGO_SONG_SECONDS_MAX]}
                onChange={setSongSeconds}
                onRelease={(v) => writeMode('bingo', { ...modeConfig, bingoSongSeconds: v })}
              />
            </View>
          )}
          {gameMode === 'timeline_quiz' && (
            <View style={styles.modeConfigBox}>
              <View style={styles.modeConfigHeader}>
                <Text style={styles.modeConfigLabel}>Anzahl Karten</Text>
                <Text style={styles.modeConfigValue}>{quizCards}</Text>
              </View>
              <StepSlider
                value={quizCards}
                min={5}
                max={30}
                milestones={[5, 15, 30]}
                onChange={setQuizCards}
                onRelease={(v) => writeMode('timeline_quiz', { timelineCardCount: v })}
              />
            </View>
          )}
        </>
      ) : (
        <View style={styles.modeBadgeRow}>
          <Text style={styles.modeBadgeText}>
            {MODE_LABEL[gameMode]}
            {gameMode === 'bingo'
              ? ` · ${modeConfig.bingoGridSize ?? 4}×${modeConfig.bingoGridSize ?? 4}` +
                ` · ${(modeConfig.bingoDifficulty ?? 'easy') === 'hard' ? 'Hard' : 'Easy'}` +
                ` · ${modeConfig.bingoSongSeconds ?? BINGO_ROUND_SECONDS}s`
              : ''}
            {gameMode === 'timeline_quiz'
              ? ` · ${modeConfig.timelineCardCount ?? DEFAULT_QUIZ_CARDS} Karten`
              : ''}
          </Text>
        </View>
      )}

      {/* Songpool: always visible for the host, independent of the mode. Local
          to the host device (only the host loads the deck + plays audio). */}
      {isHost && (
        <>
          <Text style={styles.label}>SONGPOOL</Text>
          {source ? (
            <View style={styles.poolCard}>
              <PoolIcon iconUrl={source.pool.icon_url} size={52} />
              <View style={styles.poolText}>
                <Text style={styles.poolLabel}>Ausgewählt</Text>
                <Text style={styles.poolName} numberOfLines={1}>
                  {source.pool.name}
                </Text>
                <Text style={styles.poolMeta} numberOfLines={1}>
                  Themen-Pool
                </Text>
              </View>
              <PressableButton style={styles.changeBtn} onPress={() => setPickerVisible(true)}>
                <Text style={styles.changeBtnText}>Ändern</Text>
              </PressableButton>
            </View>
          ) : (
            <PressableButton style={styles.poolPickBtn} onPress={() => setPickerVisible(true)}>
              <Text style={styles.poolPickText}>Kein Songpool ausgewählt — antippen zum Wählen 🎵</Text>
            </PressableButton>
          )}
        </>
      )}

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
        <>
          <PressableButton
            style={[styles.startBtn, (starting || !canStart) && styles.disabled]}
            onPress={onStartPressed}
            disabled={starting || !canStart}
          >
            {starting ? (
              <ActivityIndicator color={COLORS.background} />
            ) : (
              <Text style={styles.startBtnText}>SPIEL STARTEN</Text>
            )}
          </PressableButton>
          <StartRequirementsHint missing={missing} />
        </>
      ) : (
        <Text style={styles.waitText}>Warte auf Host…</Text>
      )}

      {isHost ? (
        <PressableButton style={styles.endBtn} onPress={endLobby}>
          <Text style={styles.endBtnText}>Lobby beenden</Text>
        </PressableButton>
      ) : (
        <PressableButton style={styles.leaveBtn} onPress={leave}>
          <Text style={styles.leaveBtnText}>Lobby verlassen</Text>
        </PressableButton>
      )}

      <PlaylistPicker
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onSelect={(s) => {
          setSource(s);
          setError(null);
        }}
      />

      <ConfirmDialog
        visible={endConfirmVisible}
        title="Lobby beenden?"
        message="Alle Mitspieler werden sofort aus der Lobby entfernt."
        confirmLabel="Beenden"
        isDestructive
        onConfirm={confirmEndLobby}
        onCancel={() => setEndConfirmVisible(false)}
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
    ...glow(COLORS.primary, { radius: 16, opacity: 0.7 }),
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

  modeRow: { flexDirection: 'row', gap: 10 },
  modeBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  modeBtnActive: { borderColor: COLORS.accent, backgroundColor: COLORS.accent },
  modeBtnText: { color: COLORS.text, fontSize: 13, fontWeight: '900', textAlign: 'center' },
  modeBtnTextActive: { color: COLORS.background },

  // Songpool row (mirrors the Pass & Play setup's "MUSIK" card).
  poolCard: {
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
  poolText: { flex: 1 },
  poolLabel: { color: COLORS.accent, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  poolName: { color: COLORS.text, fontSize: 17, fontWeight: '900' },
  poolMeta: { color: COLORS.textMuted, fontSize: 12, fontWeight: '600' },
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
  poolPickBtn: {
    minHeight: 56,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: COLORS.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  poolPickText: { color: COLORS.textMuted, fontWeight: '800', fontSize: 14, textAlign: 'center' },
  modeConfigBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  modeConfigHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  modeConfigLabel: { color: COLORS.text, fontSize: 14, fontWeight: '800' },
  modeConfigValue: { color: COLORS.accent, fontSize: 18, fontWeight: '900' },
  modeBadgeRow: {
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  modeBadgeText: { color: COLORS.text, fontSize: 15, fontWeight: '800' },
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
    ...glow(COLORS.secondary, { radius: 16, opacity: 0.8 }),
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

  endBtn: {
    marginTop: 12,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: COLORS.incorrect,
    alignItems: 'center',
    justifyContent: 'center',
  },
  endBtnText: { color: COLORS.background, fontSize: 15, fontWeight: '900' },
});
