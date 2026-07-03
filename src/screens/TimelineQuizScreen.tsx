/**
 * TimelineQuizScreen - the Timeline-Quiz mode (simultaneous rounds on the
 * round_answers foundation). ONE shared timeline for everyone: base year slots
 * that grow by the real song each round. Every round a mystery song plays
 * (host device only) and each player independently taps the gap where they
 * think it belongs. Resolution runs on ANY client (deadline timer everywhere +
 * "all answered"; the atomic claim dedupes). Correct slot = +1 point; highest
 * score after the fixed round count wins (ties share the win).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
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
import type { QuizAnswer } from '../game/timelineQuiz';
import { VictoryCelebration } from '../components/VictoryCelebration';
import { PlayBackupButton } from '../components/PlayBackupButton';
import { PressableButton } from '../components/PressableButton';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import type {
  Lobby,
  LobbyPlayer,
  QuizTimelineEntry,
  RoundAnswer,
} from '../types/online';
import type { OnlineStackParamList } from '../types/navigation';

type Nav = NativeStackNavigationProp<OnlineStackParamList, 'TimelineQuiz'>;
type QuizRoute = RouteProp<OnlineStackParamList, 'TimelineQuiz'>;

/** Grace before any client fires the deadline resolve (absorbs clock skew). */
const RESOLVE_GRACE_MS = 1000;

/**
 * The shared timeline strip. While collecting, the gaps between entries are
 * tappable (pick where the mystery song belongs); the picked gap shows a ✓.
 * In the resolved view `centerIndex` highlights the freshly inserted song and
 * auto-centers it (measured onLayout, same technique as the hitster strips).
 */
function QuizTimelineStrip({
  timeline,
  onPick,
  pickedSlot,
  centerIndex,
}: {
  timeline: QuizTimelineEntry[];
  onPick?: (slot: number) => void;
  pickedSlot?: number | null;
  centerIndex?: number | null;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const viewportW = useRef(0);
  const targetCenterX = useRef<number | null>(null);
  const centerOnTarget = () => {
    if (targetCenterX.current == null || viewportW.current === 0) return;
    const x = Math.max(0, targetCenterX.current - viewportW.current / 2);
    scrollRef.current?.scrollTo({ x, animated: true });
  };

  const gap = (slot: number) => {
    if (onPick) {
      const picked = pickedSlot === slot;
      return (
        <PressableButton
          style={[styles.gapBtn, picked && styles.gapBtnPicked]}
          onPress={() => onPick(slot)}
        >
          <Text style={[styles.gapText, picked && styles.gapTextPicked]}>
            {picked ? '✓' : '+'}
          </Text>
        </PressableButton>
      );
    }
    if (pickedSlot === slot) {
      return (
        <View style={[styles.gapBtn, styles.gapBtnPicked]}>
          <Text style={[styles.gapText, styles.gapTextPicked]}>✓</Text>
        </View>
      );
    }
    return <View style={styles.gapSpacer} />;
  };

  return (
    <ScrollView
      ref={scrollRef}
      onLayout={(e) => {
        viewportW.current = e.nativeEvent.layout.width;
        centerOnTarget();
      }}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.tlRow}
    >
      {timeline.map((entry, i) => (
        <View
          key={`entry-${i}`}
          style={styles.tlSlotWrap}
          onLayout={
            centerIndex === i
              ? (e) => {
                  targetCenterX.current =
                    e.nativeEvent.layout.x + e.nativeEvent.layout.width / 2;
                  centerOnTarget();
                }
              : undefined
          }
        >
          {gap(i)}
          <View
            style={[
              styles.tlEntry,
              entry.title != null && styles.tlEntrySong,
              centerIndex === i && styles.tlEntryNew,
            ]}
          >
            <Text style={[styles.tlYear, centerIndex === i && styles.tlYearNew]}>
              {entry.year}
            </Text>
            {entry.title != null && (
              <Text style={styles.tlTitle} numberOfLines={1}>
                {entry.title}
              </Text>
            )}
          </View>
        </View>
      ))}
      <View style={styles.tlSlotWrap}>{gap(timeline.length)}</View>
    </ScrollView>
  );
}

/** Local per-second countdown from the synced round deadline (cosmetic). */
function RoundCountdown({ deadlineMs }: { deadlineMs: number }) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000))
  );
  useEffect(() => {
    const iv = setInterval(() => {
      const r = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
      setRemaining(r);
      if (r <= 0) clearInterval(iv);
    }, 250);
    setRemaining(Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)));
    return () => clearInterval(iv);
  }, [deadlineMs]);

  const urgent = remaining <= 5;
  return (
    <Text style={[styles.countdown, urgent && styles.countdownUrgent]}>
      ⏱ {remaining}s
    </Text>
  );
}

export default function TimelineQuizScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { lobbyId } = useRoute<QuizRoute>().params;

  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [answers, setAnswers] = useState<RoundAnswer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [endedHandled, setEndedHandled] = useState(false);

  const myId = Online.getPlayerId();

  const refresh = useCallback(async () => {
    try {
      const [lb, list] = await Promise.all([
        Online.getLobby(lobbyId),
        Online.getLobbyPlayers(lobbyId),
      ]);
      setLobby(lb);
      if (lb.status === 'ended') return; // ended handling in the effect below
      setPlayers(list);
      const round = lb.game_state?.roundNumber;
      if (round != null) {
        setAnswers(await Online.getRoundAnswers(lobbyId, round));
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [lobbyId]);

  // Lifecycle: realtime subscription + socket recovery + safety-net poll
  // (same pattern as OnlineGameScreen / BingoGameScreen).
  useEffect(() => {
    let disposed = false;
    let unsub: (() => void) | null = null;
    let reconnecting = false;
    let reconnectScheduled = false;

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
    const poll = setInterval(refresh, 7000);
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !disposed) refresh();
    });

    return () => {
      disposed = true;
      clearInterval(poll);
      appStateSub.remove();
      unsub?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobbyId, refresh]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  const gs = lobby?.game_state ?? null;
  const me = players.find((p) => p.player_id === myId);
  const isHost = !!me?.is_host;
  const card = gs?.currentCard ?? null;
  const roundPhase = gs?.roundPhase ?? null;
  const timeline = gs?.quizTimeline ?? [];
  const totalRounds = gs?.quizTotalRounds ?? gs?.modeConfig?.timelineCardCount ?? 0;
  const myAnswer = answers.find((a) => a.player_id === myId);
  const iAnswered = !!myAnswer;
  const mySlot =
    typeof (myAnswer?.answer as { slot?: unknown } | null)?.slot === 'number'
      ? ((myAnswer!.answer as { slot: number }).slot)
      : null;
  const winnerIds = gs?.winnerIds ?? (gs?.winnerId ? [gs.winnerId] : []);
  const winnerNames = players
    .filter((p) => winnerIds.includes(p.player_id))
    .map((p) => p.player_name)
    .join(' & ');
  const isLastRound =
    gs?.roundNumber != null && (gs.roundNumber >= totalRounds || gs.deck.length === 0);
  // The freshly inserted song in the resolved view (for highlight + centering).
  const newEntryIndex =
    roundPhase === 'resolved' && card
      ? timeline.findIndex((e) => e.title === card.title && e.year === card.year)
      : -1;

  // Host ended the lobby -> everyone returns home (once).
  useEffect(() => {
    if (lobby?.status !== 'ended' || endedHandled) return;
    setEndedHandled(true);
    Online.clearLastLobbyId().catch(() => {});
    Alert.alert('Lobby beendet', 'Der Host hat die Lobby beendet.');
    navigation.navigate('OnlineHome');
  }, [lobby?.status, endedHandled, navigation]);

  // Host-only audio: new round card -> play; game over -> pause.
  useEffect(() => {
    if (!isHost) return;
    if (gs?.phase === 'finished') {
      Spotify.pause().catch(() => {});
    } else if (card && roundPhase === 'collecting') {
      Spotify.playUri(card.trackUri).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id, roundPhase === 'collecting', gs?.phase, isHost]);

  // Deadline resolve trigger - armed on ALL clients (host disconnect must
  // never strand the round; the claim dedupes).
  useEffect(() => {
    if (roundPhase !== 'collecting' || gs?.roundDeadline == null) return;
    const wait = Math.max(0, gs.roundDeadline + RESOLVE_GRACE_MS - Date.now());
    const t = setTimeout(() => {
      Online.resolveTimelineQuizRound(lobbyId).catch((e: any) =>
        setError(e?.message ?? String(e))
      );
    }, wait);
    return () => clearTimeout(t);
  }, [roundPhase, gs?.roundDeadline, gs?.roundNumber, lobbyId]);

  // Early resolve as soon as EVERYONE answered (any client may fire; deduped).
  useEffect(() => {
    if (roundPhase !== 'collecting' || players.length === 0) return;
    if (answers.length >= players.length) {
      Online.resolveTimelineQuizRound(lobbyId).catch((e: any) =>
        setError(e?.message ?? String(e))
      );
    }
  }, [roundPhase, answers.length, players.length, lobbyId]);

  const onPick = (slot: number) => {
    if (iAnswered) return;
    setError(null);
    Online.submitRoundAnswer(lobbyId, myId, { slot } satisfies QuizAnswer)
      .then(() => refresh())
      .catch((e: any) => setError(e?.message ?? String(e)));
  };

  const onNext = () =>
    Online.nextTimelineQuizRound(lobbyId).catch((e: any) =>
      setError(e?.message ?? String(e))
    );

  if (!gs) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <Text style={styles.muted}>Lade Spielzustand…</Text>
        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    );
  }

  // ----- Game over -----
  if (gs.phase === 'finished') {
    if (gs.winnerId && !showStats) {
      return (
        <VictoryCelebration
          winnerName={winnerNames || '—'}
          onContinue={() => setShowStats(true)}
        />
      );
    }
    return (
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 24 }]}
      >
        <Text style={styles.trophy}>🏆</Text>
        <Text style={styles.sectionLabel}>
          {winnerIds.length > 1 ? 'GETEILTER SIEG' : 'GEWINNER'}
        </Text>
        <Text style={styles.winnerName}>{winnerNames || '—'}</Text>
        <Text style={styles.sectionLabel}>PUNKTE</Text>
        {[...players]
          .sort((a, b) => b.score - a.score)
          .map((p) => (
            <View key={p.id} style={styles.scoreRow}>
              <Text style={styles.scoreName} numberOfLines={1}>
                {winnerIds.includes(p.player_id) ? '🏆 ' : ''}
                {p.player_name}
                {p.player_id === myId ? ' (du)' : ''}
              </Text>
              <Text style={styles.scoreVal}>
                {p.score} / {totalRounds} richtig
              </Text>
            </View>
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

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <Text style={styles.title}>TIMELINE-QUIZ</Text>
        <View style={styles.roundPill}>
          <Text style={styles.roundPillText}>
            Runde {gs.roundNumber ?? 1}/{totalRounds}
          </Text>
        </View>
        {/* Backup play: only the host's device plays audio. */}
        {isHost && <PlayBackupButton uri={card?.trackUri ?? null} onError={setError} />}
      </View>

      {/* ---- collecting: mystery song + shared timeline with tap gaps ---- */}
      {roundPhase === 'collecting' && (
        <>
          <View style={styles.mysteryBox}>
            <Text style={styles.mysteryGlyph}>💿</Text>
            <Text style={styles.mysteryText}>
              {iAnswered
                ? 'Antwort gespeichert ✓ — warte auf die anderen…'
                : 'Song läuft… wo gehört er hin?'}
            </Text>
            {gs.roundDeadline != null && <RoundCountdown deadlineMs={gs.roundDeadline} />}
          </View>

          <Text style={styles.sectionLabel}>GEMEINSAME ZEITLINIE</Text>
          <QuizTimelineStrip
            timeline={timeline}
            onPick={iAnswered ? undefined : onPick}
            pickedSlot={mySlot}
          />
          {!iAnswered && (
            <Text style={styles.hint}>Tippe ein „+", um den Song einzuordnen.</Text>
          )}

          <Text style={styles.answeredCount}>
            {answers.length}/{players.length} haben geantwortet
          </Text>
        </>
      )}

      {/* ---- resolving (transient) ---- */}
      {roundPhase === 'resolving' && <Text style={styles.hint}>Runde wird aufgelöst…</Text>}

      {/* ---- resolved: reveal + grown timeline + outcomes + host next ---- */}
      {roundPhase === 'resolved' && card && (
        <>
          <View style={styles.revealBox}>
            {card.coverUrl ? (
              <Image source={{ uri: card.coverUrl }} style={styles.cover} />
            ) : (
              <View style={[styles.cover, styles.coverFallback]}>
                <Text style={styles.mysteryGlyph}>♫</Text>
              </View>
            )}
            <Text style={styles.revealTitle} numberOfLines={2}>
              {card.title}
            </Text>
            <Text style={styles.revealArtist} numberOfLines={1}>
              {card.artist}
            </Text>
            <Text style={styles.revealYear}>{card.year}</Text>
          </View>

          <Text style={styles.sectionLabel}>GEMEINSAME ZEITLINIE</Text>
          <QuizTimelineStrip
            timeline={timeline}
            pickedSlot={null}
            centerIndex={newEntryIndex >= 0 ? newEntryIndex : undefined}
          />

          <Text style={styles.sectionLabel}>ERGEBNIS</Text>
          {players.map((p) => {
            const outcome = gs.roundResults?.[p.player_id] ?? 'missed';
            const label =
              outcome === 'correct'
                ? '✓ richtig'
                : outcome === 'incorrect'
                  ? '✕ falsch'
                  : '— keine Antwort';
            const color =
              outcome === 'correct'
                ? COLORS.correct
                : outcome === 'incorrect'
                  ? COLORS.incorrect
                  : COLORS.textMuted;
            return (
              <View key={p.id} style={styles.scoreRow}>
                <Text style={styles.scoreName} numberOfLines={1}>
                  {p.player_name}
                  {p.player_id === myId ? ' (du)' : ''}
                </Text>
                <Text style={[styles.scoreVal, { color }]}>{label}</Text>
              </View>
            );
          })}

          {isHost ? (
            <PressableButton style={styles.primaryBtn} onPress={onNext}>
              <Text style={styles.primaryBtnText}>
                {isLastRound ? 'Ergebnis anzeigen' : 'Nächste Runde'}
              </Text>
            </PressableButton>
          ) : (
            <Text style={styles.hint}>Warte auf den Host…</Text>
          )}
        </>
      )}

      {/* ---- running scores ---- */}
      <Text style={styles.sectionLabel}>PUNKTE</Text>
      {[...players]
        .sort((a, b) => b.score - a.score)
        .map((p) => (
          <View key={p.id} style={styles.scoreRow}>
            <Text style={styles.scoreName} numberOfLines={1}>
              {p.player_name}
              {p.player_id === myId ? ' (du)' : ''}
            </Text>
            <Text style={styles.scoreVal}>{p.score} Punkte</Text>
          </View>
        ))}

      {error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  content: { padding: 20, paddingBottom: 48, gap: 12 },
  muted: { color: COLORS.textMuted, fontSize: 16 },
  error: { color: COLORS.incorrect, fontSize: 13, fontWeight: '700' },
  hint: { color: COLORS.textMuted, fontSize: 14, fontStyle: 'italic' },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: {
    flex: 1,
    fontSize: 24,
    fontWeight: '900',
    color: COLORS.primary,
    letterSpacing: 1,
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12,
  },
  roundPill: {
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.border,
    borderWidth: 2,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  roundPillText: { color: COLORS.text, fontWeight: '900', fontSize: 14 },

  mysteryBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: COLORS.primary,
    padding: 16,
    alignItems: 'center',
    gap: 6,
    ...glow(COLORS.primary, { radius: 16, opacity: 0.6 }),
  },
  mysteryGlyph: { fontSize: 44, color: COLORS.border },
  mysteryText: { color: COLORS.textMuted, fontSize: 14, fontWeight: '700', textAlign: 'center' },
  countdown: { color: COLORS.secondary, fontSize: 22, fontWeight: '900' },
  countdownUrgent: { color: COLORS.incorrect },

  tlRow: { alignItems: 'center', paddingVertical: 8 },
  tlSlotWrap: { flexDirection: 'row', alignItems: 'center' },
  gapBtn: {
    width: 44,
    height: 72,
    borderRadius: 12,
    backgroundColor: COLORS.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 4,
  },
  gapBtnPicked: {
    backgroundColor: COLORS.correct,
    ...glow(COLORS.correct, { radius: 10, opacity: 0.8 }),
  },
  gapText: { color: COLORS.background, fontSize: 26, fontWeight: '900' },
  gapTextPicked: { fontSize: 22 },
  gapSpacer: { width: 8 },
  tlEntry: {
    minWidth: 76,
    height: 80,
    borderRadius: 14,
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 2,
    borderColor: COLORS.border,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  tlEntrySong: { borderColor: COLORS.accent },
  tlEntryNew: {
    borderColor: COLORS.primary,
    ...glow(COLORS.primary, { radius: 12, opacity: 0.8 }),
  },
  tlYear: { color: COLORS.accent, fontSize: 22, fontWeight: '900' },
  tlYearNew: { color: COLORS.primary },
  tlTitle: { color: COLORS.textMuted, fontSize: 10, fontWeight: '600', maxWidth: 90 },

  answeredCount: {
    color: COLORS.secondary,
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: 1,
  },

  revealBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: COLORS.accent,
    padding: 16,
    alignItems: 'center',
    gap: 4,
  },
  cover: { width: 120, height: 120, borderRadius: 14, marginBottom: 6 },
  coverFallback: { backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },
  revealTitle: { color: COLORS.text, fontSize: 20, fontWeight: '900', textAlign: 'center' },
  revealArtist: { color: COLORS.textMuted, fontSize: 14, fontWeight: '600' },
  revealYear: {
    color: COLORS.accent,
    fontSize: 32,
    fontWeight: '900',
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12,
  },

  sectionLabel: { fontSize: 13, fontWeight: '800', color: COLORS.secondary, letterSpacing: 2, marginTop: 10 },

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
  scoreName: { color: COLORS.text, fontWeight: '800', fontSize: 15, flexShrink: 1 },
  scoreVal: { color: COLORS.textMuted, fontWeight: '700', fontSize: 13 },

  trophy: { fontSize: 56, textAlign: 'center' },
  winnerName: {
    fontSize: 34,
    fontWeight: '900',
    color: COLORS.primary,
    textAlign: 'center',
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 16,
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
