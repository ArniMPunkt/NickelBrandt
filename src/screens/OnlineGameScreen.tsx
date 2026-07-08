/**
 * OnlineGameScreen - synced round play with the distributed Hitster mechanism.
 *
 * Phase flow (all synced via game_state):
 *   card_drawn  -> active player places ([+])            -> placeCard
 *   hitster_window -> 5s; other players with Nickel may  -> callHitster (atomic)
 *   hitster_resolving -> caller places in active's       -> resolveHitsterPlacement
 *                        timeline (active's slot blocked)
 *   awaiting_host_confirmation -> card revealed; host     -> confirmGuess
 *                        answers "title+artist?"
 *   finished    -> result message; host draws next        -> drawNextCard
 *
 * The HOST owns the 5s window timeout (closeHitsterWindow). Only the host plays audio.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  AppState,
  Image,
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
import { STEAL_WINDOW_MS } from '../game/constants';
import { buildPlayerMatchStats } from '../game/stats';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FinalCardReveal } from '../components/FinalCardReveal';
import { VictoryCelebration } from '../components/VictoryCelebration';
import { HeaderMenu } from '../components/HeaderMenu';
import { PlayerStatsAccordion } from '../components/PlayerStatsAccordion';
import { ReportSongDialog } from '../components/ReportSongDialog';
import { PressableButton } from '../components/PressableButton';
import { TurnCountdown } from '../components/TurnCountdown';
import { useSpotifyReconnect } from '../hooks/useSpotifyReconnect';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import type { GameCard, Lobby, LobbyPlayer } from '../types/online';
import type { OnlineStackParamList } from '../types/navigation';

type Nav = NativeStackNavigationProp<OnlineStackParamList, 'OnlineGame'>;
type GameRoute = RouteProp<OnlineStackParamList, 'OnlineGame'>;

const STEAL_GRACE_MS = 700;

function TimelineStrip({
  timeline,
  onInsert,
  isSlotEnabled,
  markedInsertIndex,
  centerIndex,
}: {
  timeline: GameCard[];
  onInsert?: (i: number) => void;
  isSlotEnabled?: (i: number) => boolean;
  /** Read-only: show WHERE the active player inserted (a "????" placeholder card),
   *  without revealing the card or whether the placement was correct. */
  markedInsertIndex?: number | null;
  /** Interactive mode: slot index to auto-center on mount (e.g. the blocked slot
   *  during hitster_resolving, so the stealer immediately sees the placement). */
  centerIndex?: number | null;
}) {
  // Auto-center the marked/target item: measure its real position via onLayout
  // (no width arithmetic to keep in sync with the styles) and scroll so the item
  // sits mid-viewport. Both measurements arrive async in either order, so each
  // handler attempts the scroll once both are known.
  const scrollRef = useRef<ScrollView>(null);
  const viewportW = useRef(0);
  const targetCenterX = useRef<number | null>(null);
  const centerOnTarget = () => {
    if (targetCenterX.current == null || viewportW.current === 0) return;
    const x = Math.max(0, targetCenterX.current - viewportW.current / 2);
    scrollRef.current?.scrollTo({ x, animated: true });
  };
  const onViewportLayout = (e: { nativeEvent: { layout: { width: number } } }) => {
    viewportW.current = e.nativeEvent.layout.width;
    centerOnTarget();
  };
  const onTargetLayout = (e: { nativeEvent: { layout: { x: number; width: number } } }) => {
    targetCenterX.current = e.nativeEvent.layout.x + e.nativeEvent.layout.width / 2;
    centerOnTarget();
  };
  // Re-center when the target index changes but its layout position happens to be
  // identical (onLayout would not fire again then, e.g. after a manual scroll away).
  const effectiveTarget = markedInsertIndex ?? centerIndex ?? null;
  useEffect(() => {
    if (effectiveTarget == null) return;
    const raf = requestAnimationFrame(centerOnTarget);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTarget, timeline.length]);

  // Read-only timeline with a marked insertion slot (hitster_window for others).
  if (!onInsert && markedInsertIndex != null) {
    const display: Array<{ kind: 'card'; card: GameCard } | { kind: 'marker' }> = [];
    for (let i = 0; i <= timeline.length; i++) {
      if (i === markedInsertIndex) display.push({ kind: 'marker' });
      if (i < timeline.length) display.push({ kind: 'card', card: timeline[i] });
    }
    return (
      <ScrollView
        ref={scrollRef}
        onLayout={onViewportLayout}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.timelineRow}
      >
        {display.map((d, idx) => (
          <View key={`disp-${idx}`} style={styles.slotWrap} onLayout={d.kind === 'marker' ? onTargetLayout : undefined}>
            <View style={styles.insertSpacer} />
            {d.kind === 'card' ? (
              <View style={styles.tlCard}>
                <Text style={styles.tlYear}>{d.card.year}</Text>
                <Text style={styles.tlTitle} numberOfLines={2}>
                  {d.card.title}
                </Text>
              </View>
            ) : (
              <View style={[styles.tlCard, styles.tlCardMarked]}>
                <Text style={styles.tlYearMarked}>????</Text>
                <Text style={styles.tlTitleMarked} numberOfLines={2}>
                  neue Karte
                </Text>
              </View>
            )}
          </View>
        ))}
        <View style={styles.insertSpacer} />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      ref={scrollRef}
      onLayout={onViewportLayout}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.timelineRow}
    >
      {Array.from({ length: timeline.length + 1 }).map((_, slot) => {
        const enabled = isSlotEnabled ? isSlotEnabled(slot) : true;
        return (
          <View
            key={`slot-${slot}`}
            style={styles.slotWrap}
            onLayout={centerIndex != null && slot === centerIndex ? onTargetLayout : undefined}
          >
            {onInsert ? (
              <PressableButton
                style={[styles.insertBtn, !enabled && styles.insertBtnDisabled]}
                onPress={enabled ? () => onInsert(slot) : undefined}
                disabled={!enabled}
              >
                <Text style={styles.insertText}>+</Text>
              </PressableButton>
            ) : (
              <View style={styles.insertSpacer} />
            )}
            {slot < timeline.length && (
              <View style={styles.tlCard}>
                <Text style={styles.tlYear}>{timeline[slot].year}</Text>
                <Text style={styles.tlTitle} numberOfLines={2}>
                  {timeline[slot].title}
                </Text>
              </View>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

export default function OnlineGameScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { lobbyId } = useRoute<GameRoute>().params;

  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const myId = Online.getPlayerId();
  const barAnim = useRef(new Animated.Value(1)).current;
  // Handle a host-ended lobby exactly once.
  const endedRef = useRef(false);
  const [endConfirmVisible, setEndConfirmVisible] = useState(false);
  // Victory screen shows first when the game finishes (server-driven phase, so all
  // devices show it together); each player then taps through to the stats locally.
  const [showStats, setShowStats] = useState(false);
  // The automatic final-card interstitial runs BEFORE the celebration (per device).
  const [finaleDone, setFinaleDone] = useState(false);
  // "Song melden": snapshot of the revealed card taken when the dialog opens,
  // so an advancing round can never swap the reported song underneath it.
  const [reportCard, setReportCard] = useState<GameCard | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [lb, list] = await Promise.all([
        Online.getLobby(lobbyId),
        Online.getLobbyPlayers(lobbyId),
      ]);
      // Host ended the whole lobby -> everyone returns to the Online home with a
      // clear message. (endLobby() on the host sets endedRef first, so the host
      // who triggered it does not also get this alert.)
      if (lb.status === 'ended' && !endedRef.current) {
        endedRef.current = true;
        Online.clearLastLobbyId().catch(() => {});
        Alert.alert('Lobby beendet', 'Der Host hat die Lobby beendet.');
        navigation.navigate('OnlineHome');
        return;
      }
      setLobby(lb);
      setPlayers(list);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [lobbyId, navigation]);

  // Lifecycle: live game-state subscription + realtime-socket recovery + a
  // safety-net poll. Ported from LobbyScreen's proven resilience pattern so a
  // tab-switch / app-background no longer leaves the round on a dead socket.
  // NOTE: this cleanup deliberately does NOT call leaveLobby() - leaving the
  // lobby is exclusively the job of the explicit "Lobby verlassen" button.
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

    // Safety-net polling while in the game. A touch slower than the lobby's 5s
    // since live rounds carry more realtime traffic and the socket recovery
    // above is the primary path; this just covers any missed event.
    const poll = setInterval(refresh, 7000);

    // Returning from background: useFocusEffect does NOT fire if the screen was
    // already focused when the app was minimized, so refresh explicitly here.
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !disposed) {
        refresh();
      }
    });

    return () => {
      disposed = true;
      clearInterval(poll);
      appStateSub.remove();
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

  const gs = lobby?.game_state ?? null;
  const me = players.find((p) => p.player_id === myId);
  const isHost = !!me?.is_host;
  // Host plays audio -> silently reconnect Spotify after a background/foreground.
  useSpotifyReconnect(isHost);
  const phase = gs?.phase;
  const activePlayer = gs ? players.find((p) => p.player_id === gs.activePlayerId) : undefined;
  const isActive = !!gs && gs.activePlayerId === myId;
  const card = gs?.currentCard ?? null;
  const isRevealed = phase === 'awaiting_host_confirmation' || phase === 'finished';
  const concealed = !!gs?.hideCoverUntilRevealed && !isRevealed;
  const myTimeline = me?.timeline ?? [];
  const activeTimeline = activePlayer?.timeline ?? [];
  // Non-active players see the active player's timeline (read-only) the whole
  // round, so they have time to plan a possible steal. The card shrinks to fit.
  const showActiveTimeline =
    !isActive && (phase === 'card_drawn' || phase === 'hitster_window');
  const compactCard = showActiveTimeline;

  // Host-only audio. Start the track when a new card is drawn and let it keep
  // playing through the steal window, the reveal and the "Nickel?" decision. Only
  // pause when the GAME is over (winnerId set) — NOT on a normal round-end
  // ('finished' without a winner). 'finished' is the round-result phase entered
  // right after the host's Nickel decision (confirmGuess), so pausing on every
  // 'finished' stopped the song mid-round; the song should run continuously until
  // the next card's playUri replaces it.
  useEffect(() => {
    if (!isHost) return;
    if (phase === 'card_drawn' && card) {
      Spotify.playUriGuarded(card.trackUri).catch((e: any) => setError(e?.message ?? String(e)));
    }
    if (phase === 'finished' && gs?.winnerId) Spotify.pause().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id, phase, isHost, gs?.winnerId]);

  // Cosmetic countdown bar while the steal window is open (each device animates).
  useEffect(() => {
    if (phase === 'hitster_window') {
      barAnim.setValue(1);
      const anim = Animated.timing(barAnim, {
        toValue: 0,
        duration: STEAL_WINDOW_MS,
        useNativeDriver: false,
      });
      anim.start();
      return () => anim.stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, gs?.currentCard?.id]);

  // Music timer (HOST only - same authority pattern as the steal window): hard-
  // stop the song once turnStartedAt + timerSeconds is reached. Re-arms whenever
  // a new song starts (draw / skip / blind all write a fresh turnStartedAt).
  // Firing "late" (e.g. the host returns from background past the deadline)
  // still pauses - deliberate recovery. Disarmed once the game is over.
  useEffect(() => {
    if (!isHost || !gs?.timerEnabled || gs.turnStartedAt == null || !card) return;
    if (phase === 'finished' && gs.winnerId) return;
    const remaining = gs.turnStartedAt + (gs.timerSeconds ?? 60) * 1000 - Date.now();
    const t = setTimeout(() => Spotify.pause().catch(() => {}), Math.max(0, remaining));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, gs?.turnStartedAt, card?.id, gs?.timerEnabled, phase, gs?.winnerId]);

  // The HOST is the authority that closes the window after the timeout.
  useEffect(() => {
    if (!isHost || phase !== 'hitster_window') return;
    const t = setTimeout(() => {
      Online.closeHitsterWindow(lobbyId).catch((e: any) => setError(e?.message ?? String(e)));
    }, STEAL_WINDOW_MS + STEAL_GRACE_MS);
    return () => clearTimeout(t);
  }, [isHost, phase, lobbyId]);

  // Clear the transient notice when the round/phase moves on. Also re-arm the
  // final-card interstitial when a new card appears (fresh game on this screen).
  useEffect(() => {
    setNotice(null);
    if (phase !== 'finished') setFinaleDone(false);
  }, [phase, gs?.currentCard?.id]);

  // Stable playful line for the "both wrong" outcome, per card.
  const bothWrongMessage = useMemo(() => {
    const variants = [
      'Tja, das war wohl nix für beide! 🙈',
      'Daneben! Beide haben sich verzockt. 🎲',
      'Doppelt vorbei – die Karte fliegt raus! 😅',
    ];
    return variants[Math.floor(Math.random() * variants.length)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gs?.currentCard?.id]);

  if (!gs) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <Text style={styles.muted}>Lade Spielzustand…</Text>
        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    );
  }

  // --- Handlers ---
  const onPlace = (i: number) =>
    Online.placeCard(lobbyId, i).catch((e: any) => setError(e?.message ?? String(e)));
  const onHitster = async () => {
    setError(null);
    const won = await Online.callHitster(lobbyId, myId).catch((e: any) => {
      setError(e?.message ?? String(e));
      return false;
    });
    if (!won) setNotice('Jemand anderes war schneller beim Hitster-Ruf.');
  };
  const onPassHitster = () =>
    Online.passHitster(lobbyId, myId).catch((e: any) => setError(e?.message ?? String(e)));
  const onSkip = () =>
    Online.skipCard(lobbyId).catch((e: any) => setError(e?.message ?? String(e)));
  const onBlindDraw = () =>
    Online.blindDraw(lobbyId).catch((e: any) => setError(e?.message ?? String(e)));
  const onStealPlace = (i: number) =>
    Online.resolveHitsterPlacement(lobbyId, i).catch((e: any) => setError(e?.message ?? String(e)));
  const hostConfirm = (wasCorrect: boolean) =>
    Online.confirmGuess(lobbyId, wasCorrect).catch((e: any) => setError(e?.message ?? String(e)));
  const hostNext = () =>
    Online.drawNextCard(lobbyId).catch((e: any) => setError(e?.message ?? String(e)));

  // Host-only: end the running round for everyone (with a safety confirmation).
  const onEndLobby = () => setEndConfirmVisible(true);
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

  const hasPassed = !!gs.passedHitster?.includes(myId);

  // --- Reveal-derived values ---
  const steal = gs.hitsterCallerId
    ? { id: gs.hitsterCallerId, result: gs.stealResult }
    : null;
  const stealerName = steal ? players.find((p) => p.player_id === steal.id)?.player_name : undefined;
  const stealSuccess = !!steal && steal.result === 'correct';
  const kept = stealSuccess || (!stealSuccess && gs.lastResult === 'correct');

  let resultMsg = '';
  if (isRevealed) {
    if (stealSuccess) {
      resultMsg = `🎯 ${stealerName} hat geklaut!`;
    } else if (steal && steal.result === 'incorrect') {
      resultMsg = gs.stealEqualYear
        ? `🎵 Gleiches Jahr, beide Plätze richtig – die Karte bleibt bei ${activePlayer?.player_name}!`
        : gs.lastResult === 'correct'
          ? `${activePlayer?.player_name} hatte recht! Die Karte bleibt.`
          : bothWrongMessage;
    } else {
      resultMsg = gs.lastResult === 'correct' ? '✓  RICHTIG platziert' : '✕  FALSCH platziert';
    }
  }

  const barWidth = barAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  // ----- Finished: game over (winner) -----
  if (phase === 'finished' && gs.winnerId) {
    const winner = players.find((p) => p.player_id === gs.winnerId);
    // First the automatic interstitial: the final card flips open and drops into
    // the winner's timeline (covers both win paths - own placement and steal,
    // since both server writes land in this exact phase). Skipped defensively if
    // the card/winner data is not available.
    if (!finaleDone && gs.currentCard && winner) {
      return (
        <FinalCardReveal
          card={gs.currentCard}
          timeline={winner.timeline}
          ownerName={winner.player_name}
          onDone={() => setFinaleDone(true)}
        />
      );
    }
    // Celebration next (shown on every device when phase flips to 'finished'),
    // then the stats below once the player taps "Weiter zur Statistik".
    if (!showStats) {
      return (
        <VictoryCelebration
          winnerName={winner ? winner.player_name : '—'}
          onContinue={() => setShowStats(true)}
        />
      );
    }
    const statsHistory = gs.statsHistory ?? [];
    const nameOf = (playerId: string) =>
      players.find((p) => p.player_id === playerId)?.player_name ?? '—';
    return (
      <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingTop: insets.top + 24 }]}>
        <Text style={styles.trophy}>🏆</Text>
        <Text style={styles.winnerLabel}>GEWINNER</Text>
        <Text style={styles.winnerName}>{winner ? winner.player_name : '-'}</Text>
        <Text style={styles.sectionLabel}>ERGEBNIS</Text>
        {[...players]
          .sort((a, b) => b.score - a.score)
          .map((p) => (
            <PlayerStatsAccordion
              key={p.id}
              name={p.player_name}
              isWinner={p.player_id === gs.winnerId}
              headerRight={`${p.score} Pkt · 🔥 ${p.max_brandt_streak}er-Streak`}
              stats={buildPlayerMatchStats(statsHistory, p.player_id)}
              resolveName={nameOf}
            />
          ))}
        <PressableButton
          style={styles.primaryBtn}
          onPress={() => {
            Online.clearLastLobbyId().catch(() => {});
            navigation.navigate('OnlineHome');
          }}
        >
          <Text style={styles.primaryBtnText}>Zurück</Text>
        </PressableButton>
      </ScrollView>
    );
  }

  // ----- Playing -----
  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          {/* Two lines allowed + font shrink: long names must never truncate. */}
          <Text style={styles.activeName} numberOfLines={2} adjustsFontSizeToFit>
            {isActive ? 'Du bist dran' : `${activePlayer?.player_name ?? '—'} ist dran`}
          </Text>
          <Text style={styles.subLine}>{me ? `${me.score} Pkt · 🪙 ${me.chips}` : ''}</Text>
        </View>
        {/* Single overflow: Play/Pause (host), report, lobby code, deck count,
            end lobby. */}
        <HeaderMenu
          playback={isHost ? { uri: card?.trackUri ?? null, onError: setError } : undefined}
          report={
            isHost
              ? { enabled: isRevealed && !!card, onPress: () => setReportCard(card) }
              : undefined
          }
          code={lobby?.code ?? '—'}
          deckCount={gs.deck.length}
          action={
            isHost
              ? { label: 'Lobby beenden', destructive: true, onPress: onEndLobby }
              : undefined
          }
        />
      </View>

      {/* Card */}
      {card && (
        <View style={[styles.cardBox, compactCard && styles.cardBoxCompact]}>
          {concealed ? (
            <View style={[styles.cover, compactCard && styles.coverCompact, styles.coverFallback]}>
              <Text style={[styles.coverGlyph, compactCard && styles.coverGlyphCompact]}>💿</Text>
            </View>
          ) : card.coverUrl ? (
            <Image source={{ uri: card.coverUrl }} style={[styles.cover, compactCard && styles.coverCompact]} />
          ) : (
            <View style={[styles.cover, compactCard && styles.coverCompact, styles.coverFallback]}>
              <Text style={[styles.coverGlyph, compactCard && styles.coverGlyphCompact]}>♫</Text>
            </View>
          )}
          {!compactCard && (
            <>
              <Text style={styles.cardTitle} numberOfLines={2}>
                {concealed ? '????' : card.title}
              </Text>
              <Text style={styles.cardArtist} numberOfLines={1}>
                {concealed ? '????' : card.artist}
              </Text>
            </>
          )}
          <Text style={[styles.cardYear, compactCard && styles.cardYearCompact]}>
            {isRevealed ? card.year : '????'}
          </Text>
        </View>
      )}

      {/* Music-timer countdown: every device derives it locally from the synced
          turnStartedAt (cosmetic, like the steal bar - only the host pauses). */}
      {!!gs.timerEnabled && gs.turnStartedAt != null && card && !isRevealed && (
        <TurnCountdown deadlineMs={gs.turnStartedAt + (gs.timerSeconds ?? 60) * 1000} />
      )}

      {/* Reveal result */}
      {isRevealed && !!resultMsg && (
        <View
          style={[
            stealSuccess ? styles.brandtBox : styles.feedback,
            !stealSuccess && { backgroundColor: kept ? COLORS.correct : COLORS.incorrect },
          ]}
        >
          <Text style={stealSuccess ? styles.brandtText : styles.feedbackText}>{resultMsg}</Text>
        </View>
      )}

      {/* ---- card_drawn: active places; others watch both timelines ---- */}
      {phase === 'card_drawn' && (
        <>
          {isActive ? (
            <>
              <Text style={styles.sectionLabel}>DEINE ZEITLINIE</Text>
              <TimelineStrip timeline={myTimeline} onInsert={onPlace} />
              <Text style={styles.hint}>Tippe ein „+", um den Track einzuordnen.</Text>
              {/* Nickel actions: skip / blind draw (host settings, synced in gs).
                  Locked at match point (score >= cardsToWin - 1): no Nickel
                  assists on the potentially winning card. */}
              {(gs.skipEnabled || gs.blindEnabled) && (() => {
                const matchPoint = (me?.score ?? 0) >= gs.cardsToWin - 1;
                const skipBlocked =
                  (me?.chips ?? 0) < (gs.skipCost ?? 1) || gs.deck.length === 0 || matchPoint;
                const blindBlocked = (me?.chips ?? 0) < (gs.blindCost ?? 3) || matchPoint;
                return (
                  <View style={styles.turnActionsRow}>
                    {gs.skipEnabled && (
                      <PressableButton
                        style={[styles.turnActionBtn, skipBlocked && styles.turnActionBtnDisabled]}
                        onPress={onSkip}
                        disabled={skipBlocked}
                      >
                        <Text style={styles.turnActionText}>
                          Überspringen · {gs.skipCost ?? 1} 🪙
                        </Text>
                      </PressableButton>
                    )}
                    {gs.blindEnabled && (
                      <PressableButton
                        style={[styles.turnActionBtn, blindBlocked && styles.turnActionBtnDisabled]}
                        onPress={onBlindDraw}
                        disabled={blindBlocked}
                      >
                        <Text style={styles.turnActionText}>
                          Ohne Raten · {gs.blindCost ?? 3} 🪙
                        </Text>
                      </PressableButton>
                    )}
                  </View>
                );
              })()}
            </>
          ) : (
            <>
              <Text style={styles.sectionLabel}>
                ZEITLINIE VON {activePlayer?.player_name?.toUpperCase() ?? '—'}
              </Text>
              <TimelineStrip timeline={activeTimeline} />
              <Text style={styles.sectionLabel}>DEINE ZEITLINIE</Text>
              <TimelineStrip timeline={myTimeline} />
              <Text style={styles.hint}>{activePlayer?.player_name} ordnet gerade ein…</Text>
            </>
          )}
        </>
      )}

      {/* ---- hitster_window: 5s steal window ---- */}
      {phase === 'hitster_window' && (
        <>
          <View style={styles.stealBox}>
            <Text style={styles.stealTitle}>Karte eingeordnet!</Text>
            <View style={styles.barTrack}>
              <Animated.View style={[styles.barFill, { width: barWidth }]} />
            </View>
            {isActive ? (
              <Text style={styles.hint}>Mitspieler können jetzt „Hitster!" rufen…</Text>
            ) : me && me.chips >= 1 ? (
              hasPassed ? (
                <Text style={styles.hint}>Du hast „Kein Hitster" gewählt. ✓</Text>
              ) : (
                <>
                  <PressableButton style={styles.hitsterBtn} onPress={onHitster}>
                    <Text style={styles.hitsterText}>HITSTER! 🎯</Text>
                  </PressableButton>
                  <PressableButton style={styles.noHitsterBtn} onPress={onPassHitster}>
                    <Text style={styles.noHitsterText}>Kein Hitster</Text>
                  </PressableButton>
                </>
              )
            ) : (
              <Text style={styles.hint}>Du hast keine 🪙 zum Klauen.</Text>
            )}
          </View>
          {!isActive && (
            <>
              <Text style={styles.sectionLabel}>
                ZEITLINIE VON {activePlayer?.player_name?.toUpperCase() ?? '—'}
              </Text>
              <TimelineStrip timeline={activeTimeline} markedInsertIndex={gs.pendingInsertIndex} />
              <Text style={styles.hint}>
                „????" zeigt, wo {activePlayer?.player_name} die Karte eingeordnet hat.
              </Text>
            </>
          )}
        </>
      )}

      {/* ---- hitster_resolving: caller places in active's timeline ---- */}
      {phase === 'hitster_resolving' && (
        <View>
          {gs.hitsterCallerId === myId ? (
            <>
              <Text style={styles.sectionLabel}>
                {activePlayer?.player_name?.toUpperCase()} — WO GEHÖRT SIE HIN?
              </Text>
              <TimelineStrip
                timeline={activePlayer?.timeline ?? []}
                onInsert={onStealPlace}
                isSlotEnabled={(i) => i !== gs.pendingInsertIndex}
                centerIndex={gs.pendingInsertIndex}
              />
              <Text style={styles.hint}>
                Der bereits gewählte Slot ist gesperrt — 1 🪙 wird eingesetzt.
              </Text>
            </>
          ) : (
            <Text style={styles.hint}>
              {stealerName ?? 'Jemand'} versucht zu klauen…
            </Text>
          )}
        </View>
      )}

      {/* ---- awaiting_host_confirmation: reveal shown; host answers ---- */}
      {phase === 'awaiting_host_confirmation' &&
        (isHost ? (
          <View style={styles.hostBox}>
            <Text style={styles.hostTitle}>Titel + Interpret richtig erkannt?</Text>
            <View style={styles.hostRow}>
              <PressableButton style={[styles.hostBtn, styles.hostYes]} onPress={() => hostConfirm(true)}>
                <Text style={styles.hostYesText}>Ja, Nickel! 🪙</Text>
              </PressableButton>
              <PressableButton style={[styles.hostBtn, styles.hostNo]} onPress={() => hostConfirm(false)}>
                <Text style={styles.hostNoText}>Nein</Text>
              </PressableButton>
            </View>
          </View>
        ) : (
          <Text style={styles.hint}>Warte auf Host-Bestätigung…</Text>
        ))}

      {/* ---- finished (round, not game): host draws next ---- */}
      {phase === 'finished' &&
        (isHost ? (
          <PressableButton style={styles.primaryBtn} onPress={hostNext}>
            <Text style={styles.primaryBtnText}>Nächste Karte ziehen</Text>
          </PressableButton>
        ) : (
          <Text style={styles.hint}>Warte auf den Host…</Text>
        ))}

      {notice && <Text style={styles.notice}>{notice}</Text>}

      {/* Players */}
      <Text style={styles.sectionLabel}>SPIELER</Text>
      {players.map((p) => (
        <View
          key={p.id}
          style={[styles.scoreRow, p.player_id === gs.activePlayerId && styles.scoreRowActive]}
        >
          <Text style={styles.scoreName} numberOfLines={1}>
            {p.player_name}
            {p.player_id === gs.activePlayerId ? ' ▶' : ''}
            {p.player_id === myId ? ' (du)' : ''}
          </Text>
          <Text style={styles.scoreVal}>
            {p.score} Pkt · {p.timeline.length} Karten · 🪙 {p.chips}
          </Text>
        </View>
      ))}

      {error && <Text style={styles.error}>{error}</Text>}

      <ConfirmDialog
        visible={endConfirmVisible}
        title="Lobby beenden?"
        message="Alle Mitspieler werden sofort aus der laufenden Runde entfernt."
        confirmLabel="Beenden"
        isDestructive
        onConfirm={confirmEndLobby}
        onCancel={() => setEndConfirmVisible(false)}
      />

      <ReportSongDialog
        visible={reportCard != null}
        card={reportCard}
        onClose={() => setReportCard(null)}
        onSubmit={(reason) =>
          Online.reportSong({
            title: reportCard!.title,
            artist: reportCard!.artist,
            year: reportCard!.year,
            trackUri: reportCard!.trackUri,
            sourceId: gs.sourceId,
            sourceName: gs.sourceName,
            reason,
            mode: 'hitster',
            lobbyId,
          })
        }
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  content: { padding: 20, paddingBottom: 48, gap: 12 },
  muted: { color: COLORS.textMuted, fontSize: 16 },
  error: { color: COLORS.incorrect, fontSize: 13, fontWeight: '700' },
  notice: { color: COLORS.accent, fontSize: 14, fontWeight: '700', textAlign: 'center' },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  activeName: {
    fontSize: 26,
    fontWeight: '900',
    color: COLORS.primary,
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12,
  },
  subLine: { fontSize: 14, fontWeight: '700', color: COLORS.textMuted, marginTop: 2 },

  cardBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 24,
    padding: 20,
    alignItems: 'center',
    gap: 6,
    borderWidth: 2,
    borderColor: COLORS.primary,
    ...glow(COLORS.primary, { radius: 20, opacity: 0.7 }),
  },
  cardBoxCompact: { padding: 12, gap: 2 },
  cover: { width: 200, height: 200, borderRadius: 16, marginBottom: 8 },
  coverCompact: { width: 72, height: 72, borderRadius: 10, marginBottom: 0 },
  coverFallback: { backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },
  coverGlyph: { fontSize: 64, color: COLORS.border },
  coverGlyphCompact: { fontSize: 32 },
  cardYearCompact: { fontSize: 24, textShadowRadius: 8 },
  cardTitle: { fontSize: 22, fontWeight: '900', color: COLORS.text, textAlign: 'center' },
  cardArtist: { fontSize: 15, color: COLORS.textMuted, fontWeight: '600' },
  cardYear: {
    fontSize: 46,
    fontWeight: '900',
    color: COLORS.accent,
    marginTop: 4,
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 14,
  },

  feedback: { borderRadius: 16, paddingVertical: 14, paddingHorizontal: 12 },
  feedbackText: { color: COLORS.background, fontWeight: '900', fontSize: 17, textAlign: 'center', letterSpacing: 0.5 },
  brandtBox: {
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: COLORS.accent,
    backgroundColor: COLORS.backgroundAlt,
  },
  brandtText: {
    color: COLORS.accent,
    fontSize: 18,
    fontWeight: '900',
    textAlign: 'center',
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 14,
  },

  sectionLabel: { fontSize: 13, fontWeight: '800', color: COLORS.secondary, letterSpacing: 2, marginTop: 10 },
  hint: { color: COLORS.textMuted, fontSize: 14, fontStyle: 'italic' },

  timelineRow: { alignItems: 'center', paddingVertical: 8 },
  slotWrap: { flexDirection: 'row', alignItems: 'center' },
  insertBtn: {
    width: 48,
    height: 84,
    borderRadius: 14,
    backgroundColor: COLORS.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 5,
  },
  insertBtnDisabled: { backgroundColor: COLORS.border, opacity: 0.35 },
  insertText: { color: COLORS.background, fontSize: 30, fontWeight: '900' },
  insertSpacer: { width: 10 },
  tlCard: {
    width: 108,
    height: 96,
    borderRadius: 16,
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 2,
    borderColor: COLORS.accent,
    padding: 10,
    justifyContent: 'center',
  },
  tlYear: { color: COLORS.accent, fontSize: 26, fontWeight: '900' },
  tlTitle: { color: COLORS.textMuted, fontSize: 12, fontWeight: '600' },
  tlCardMarked: {
    borderColor: COLORS.primary,
    borderStyle: 'dashed',
    backgroundColor: COLORS.background,
    ...glow(COLORS.primary, { radius: 12, opacity: 0.7 }),
  },
  tlYearMarked: {
    color: COLORS.primary,
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 1,
  },
  tlTitleMarked: { color: COLORS.primary, fontSize: 12, fontWeight: '800' },

  turnActionsRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  turnActionBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: COLORS.accent,
    backgroundColor: COLORS.backgroundAlt,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  turnActionBtnDisabled: { borderColor: COLORS.border, opacity: 0.4 },
  turnActionText: { color: COLORS.accent, fontSize: 14, fontWeight: '900', textAlign: 'center' },

  stealBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: COLORS.secondary,
    padding: 20,
    alignItems: 'center',
    gap: 10,
  },
  stealTitle: { color: COLORS.text, fontSize: 20, fontWeight: '900' },
  barTrack: {
    width: '100%',
    height: 12,
    borderRadius: 999,
    backgroundColor: COLORS.background,
    overflow: 'hidden',
  },
  barFill: { height: '100%', backgroundColor: COLORS.secondary, borderRadius: 999 },
  hitsterBtn: {
    minHeight: 60,
    alignSelf: 'stretch',
    backgroundColor: COLORS.primary,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    ...glow(COLORS.primary, { radius: 16, opacity: 0.9 }),
  },
  hitsterText: { color: COLORS.text, fontSize: 22, fontWeight: '900', letterSpacing: 1 },
  noHitsterBtn: {
    alignSelf: 'stretch',
    minHeight: 42,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noHitsterText: { color: COLORS.textMuted, fontSize: 14, fontWeight: '800' },

  hostBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: COLORS.accent,
    padding: 16,
    gap: 12,
  },
  hostTitle: { color: COLORS.text, fontSize: 17, fontWeight: '900', textAlign: 'center' },
  hostRow: { flexDirection: 'row', gap: 12 },
  hostBtn: { flex: 1, minHeight: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  hostYes: { backgroundColor: COLORS.accent },
  hostYesText: { color: COLORS.background, fontSize: 15, fontWeight: '900' },
  hostNo: { backgroundColor: COLORS.background, borderWidth: 2, borderColor: COLORS.border },
  hostNoText: { color: COLORS.textMuted, fontSize: 16, fontWeight: '800' },

  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  // Active player gets a green neon glow border (matches the correct/green theme).
  scoreRowActive: {
    borderColor: COLORS.correct,
    borderWidth: 2,
    ...glow(COLORS.correct, { radius: 12, opacity: 0.6 }),
  },
  scoreName: { color: COLORS.text, fontWeight: '800', fontSize: 15, flexShrink: 1 },
  scoreVal: { color: COLORS.textMuted, fontWeight: '600', fontSize: 12 },

  trophy: { fontSize: 64, textAlign: 'center' },
  winnerLabel: { fontSize: 14, fontWeight: '800', color: COLORS.secondary, letterSpacing: 3, textAlign: 'center' },
  winnerName: {
    fontSize: 40,
    fontWeight: '900',
    color: COLORS.primary,
    textAlign: 'center',
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },

  primaryBtn: {
    marginTop: 16,
    minHeight: 58,
    backgroundColor: COLORS.secondary,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: { color: COLORS.background, fontSize: 18, fontWeight: '900', letterSpacing: 1 },
});
