/**
 * BingoGameScreen - the Bingo mode (simultaneous rounds on the round_answers
 * foundation). Every round: a mystery song plays (host device only), the spun
 * category is shown with its matching input control, everyone answers within
 * the deadline. Resolution runs on ANY client (deadline timer armed everywhere
 * + "all answered" trigger; the atomic claim in resolveBingoRound dedupes) -
 * the known host-disconnect hangs of the hitster flow can't stall a round.
 * Correct answers mark a random free cell of the category's color; a full
 * row/column/diagonal wins (phase 'finished' + winnerId, like hitster).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Online from '../services/supabase';
import * as Spotify from '../services/spotify';
import {
  BINGO_CATEGORY_LABEL,
  BINGO_YEAR_MAX,
  BINGO_YEAR_MIN,
  BINGO_SPIN_MS,
  BINGO_SPIN_OPEN_ALL_MS,
  countMarked,
  freeCellIndices,
  hasBingo,
  titleAnswerText,
  type BingoAnswer,
} from '../game/bingo';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BingoLineReveal } from '../components/BingoLineReveal';
import { VictoryCelebration } from '../components/VictoryCelebration';
import { PlayBackupButton } from '../components/PlayBackupButton';
import { PressableButton } from '../components/PressableButton';
import { StepSlider } from '../components/StepSlider';
import { BINGO_CATEGORY_COLOR, COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import type {
  BingoBoard,
  BingoCategoryType,
  Lobby,
  LobbyPlayer,
  RoundAnswer,
} from '../types/online';
import type { OnlineStackParamList } from '../types/navigation';

type Nav = NativeStackNavigationProp<OnlineStackParamList, 'BingoGame'>;
type BingoRoute = RouteProp<OnlineStackParamList, 'BingoGame'>;

/** Grace before any client fires the deadline resolve (absorbs clock skew). */
const RESOLVE_GRACE_MS = 1000;

/** Cell/category colors: shared with the win-line reveal (see colors.ts). */
const CATEGORY_COLOR = BINGO_CATEGORY_COLOR;

function BingoGrid({
  board,
  size,
  selectable,
  onPickCell,
}: {
  board: BingoBoard;
  size: number;
  /** Indices the owner may tap during the pick window (glowing "+" cells). */
  selectable?: number[];
  onPickCell?: (index: number) => void;
}) {
  const rows = Array.from({ length: size }, (_, r) =>
    board.slice(r * size, (r + 1) * size)
  );
  return (
    <View style={styles.grid}>
      {rows.map((cells, r) => (
        <View key={`row-${r}`} style={styles.gridRow}>
          {cells.map((cell, c) => {
            const idx = r * size + c;
            const color = CATEGORY_COLOR[cell.color];
            const pickable = !!onPickCell && !!selectable?.includes(idx);
            if (pickable) {
              return (
                <PressableButton
                  key={`cell-${r}-${c}`}
                  style={[styles.cell, { borderColor: color }, glow(color, { radius: 10, opacity: 0.9 })]}
                  onPress={() => onPickCell(idx)}
                >
                  <Text style={[styles.cellPick, { color }]}>+</Text>
                </PressableButton>
              );
            }
            return (
              <View
                key={`cell-${r}-${c}`}
                style={[
                  styles.cell,
                  { borderColor: color },
                  cell.marked && { backgroundColor: color, ...glow(color, { radius: 8, opacity: 0.8 }) },
                ]}
              >
                {cell.marked && <Text style={styles.cellCheck}>✓</Text>}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/**
 * The 3x4 spin wheel ("digitale Discokugel"). Layout and landing tiles are
 * FIXED constants, so every client shows the identical animation: the
 * highlight races through the tiles, decelerates (ease-out on the shared
 * spinStartedAt timestamp) and stops on the pre-drawn category's landing
 * tile. Pure cosmetics - the category was drawn server-side at round start.
 */
const SPIN_LAYOUT: BingoCategoryType[] = [
  'decade', 'before_after_2000', 'year_guess', 'title_artist',
  'year_guess', 'title_artist', 'decade', 'before_after_2000',
  'before_after_2000', 'decade', 'title_artist', 'year_guess',
];
const SPIN_LANDING: Record<BingoCategoryType, number> = {
  decade: 6,
  before_after_2000: 7,
  title_artist: 10,
  year_guess: 11,
};
/** The wheel keeps glowing on the result this long before onDone fires. */
const SPIN_HOLD_MS = 700;

function SpinWheel({
  startedAt,
  category,
  onDone,
}: {
  /** Shared trigger timestamp; null renders the wheel idle (pre-spin). */
  startedAt: number | null;
  category?: BingoCategoryType;
  onDone?: () => void;
}) {
  const [highlight, setHighlight] = useState<number | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (startedAt == null || !category) {
      setHighlight(null);
      return;
    }
    const landing = SPIN_LANDING[category];
    const totalSteps = 2 * SPIN_LAYOUT.length + landing; // two full laps + stop
    const animMs = BINGO_SPIN_MS - SPIN_HOLD_MS;
    let doneFired = false;
    const iv = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= BINGO_SPIN_MS) {
        setHighlight(landing);
        if (!doneFired) {
          doneFired = true;
          clearInterval(iv);
          onDoneRef.current?.();
        }
        return;
      }
      if (elapsed >= animMs) {
        setHighlight(landing); // hold on the result
        return;
      }
      const p = elapsed / animMs;
      const steps = Math.floor(totalSteps * (1 - Math.pow(1 - p, 2.2)));
      setHighlight(steps % SPIN_LAYOUT.length);
    }, 50);
    return () => clearInterval(iv);
  }, [startedAt, category]);

  const rows = [0, 1, 2].map((r) => SPIN_LAYOUT.slice(r * 4, r * 4 + 4));
  return (
    <View style={styles.spinGrid}>
      {rows.map((tiles, r) => (
        <View key={`spinrow-${r}`} style={styles.gridRow}>
          {tiles.map((t, c) => {
            const idx = r * 4 + c;
            const color = CATEGORY_COLOR[t];
            const lit = highlight === idx;
            return (
              <View
                key={`spintile-${r}-${c}`}
                style={[
                  styles.spinTile,
                  { borderColor: color },
                  lit && { backgroundColor: color, ...glow(color, { radius: 12, opacity: 0.95 }) },
                ]}
              />
            );
          })}
        </View>
      ))}
    </View>
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

export default function BingoGameScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { lobbyId } = useRoute<BingoRoute>().params;

  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  // Answers are TAGGED with the round they were fetched for: lobby state and
  // answer list update in two separate renders (await between the setters), so
  // right after a round change the old round's full answer list would briefly
  // count as "everyone answered" for the NEW round - firing the early resolve
  // with zero answers and killing every second round instantly.
  const [answersFor, setAnswersFor] = useState<{
    round: number | null;
    list: RoundAnswer[];
  }>({ round: null, list: [] });
  const [error, setError] = useState<string | null>(null);
  const [showStats, setShowStats] = useState(false);
  // year_guess slider / title_artist free text (local until submitted).
  const [yearGuess, setYearGuess] = useState(1990);
  const [titleText, setTitleText] = useState('');
  // Host's local verdict map during the title_artist review (source of truth
  // on the host device; pushed as a full map on every tap).
  const [hostVerdicts, setHostVerdicts] = useState<Record<string, boolean>>({});
  const [endedHandled, setEndedHandled] = useState(false);
  const [exitConfirmVisible, setExitConfirmVisible] = useState(false);
  // Win-line interstitial shown once before the victory celebration.
  const [finaleDone, setFinaleDone] = useState(false);

  const myId = Online.getPlayerId();

  const refresh = useCallback(async () => {
    try {
      const [lb, list] = await Promise.all([
        Online.getLobby(lobbyId),
        Online.getLobbyPlayers(lobbyId),
      ]);
      if (lb.status === 'ended') {
        setLobby(lb); // ended handling in an effect (needs current state)
        return;
      }
      setLobby(lb);
      setPlayers(list);
      const round = lb.game_state?.roundNumber;
      if (round != null) {
        setAnswersFor({ round, list: await Online.getRoundAnswers(lobbyId, round) });
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [lobbyId]);

  // Lifecycle: realtime subscription (lobbies + lobby_players + round_answers)
  // with socket recovery + safety-net poll (same pattern as OnlineGameScreen).
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
  const round = gs?.bingoRound ?? null;
  const roundPhase = gs?.roundPhase ?? null;
  const size = gs?.modeConfig?.bingoGridSize ?? 4;
  // Stale-tagged answers (from a previous round) count as "none yet".
  const answers = answersFor.round === gs?.roundNumber ? answersFor.list : [];
  const iAnswered = answers.some((a) => a.player_id === myId);
  // Simultaneous multi-win is allowed; winnerIds carries everyone, winnerId is
  // only the compat field (first entry) for the shared finish contract.
  const winnerIds = gs?.winnerIds ?? (gs?.winnerId ? [gs.winnerId] : []);
  const winners = players.filter((p) => winnerIds.includes(p.player_id));
  const winnerNames = winners.map((p) => p.player_name).join(' & ');

  // ---- Cell-pick window (after resolution; see pickBingoCell) ----
  const myBoard = me?.bingo_board ?? null;
  const myExpected = gs?.expectedMarks?.[myId];
  const iWasCorrect = roundPhase === 'resolved' && gs?.roundResults?.[myId] === 'correct';
  const pickPending =
    iWasCorrect &&
    round != null &&
    myBoard != null &&
    myExpected != null &&
    countMarked(myBoard) < myExpected;
  const pickableCells =
    pickPending && myBoard && round ? freeCellIndices(myBoard, round.type) : [];
  // Correct, but the color is already full on my board: nothing to gain.
  const colorFull =
    iWasCorrect &&
    round != null &&
    myBoard != null &&
    freeCellIndices(myBoard, round.type).length === 0;

  const pickBusyRef = useRef(false);
  const onPickCell = (index: number) => {
    if (pickBusyRef.current) return;
    pickBusyRef.current = true;
    Online.pickBingoCell(lobbyId, index)
      .then(() => refresh())
      .catch((e: any) => setError(e?.message ?? String(e)))
      .finally(() => {
        pickBusyRef.current = false;
      });
  };

  // Auto-pick: a single option needs no choice UI; on timeout the own client
  // picks randomly so the earned mark isn't lost by idling.
  const pickableRef = useRef<number[]>([]);
  pickableRef.current = pickableCells;
  useEffect(() => {
    if (!pickPending) return;
    if (pickableCells.length === 1) {
      onPickCell(pickableCells[0]);
      return;
    }
    if (gs?.pickDeadline == null) return;
    const t = setTimeout(() => {
      const opts = pickableRef.current;
      if (opts.length > 0) onPickCell(opts[Math.floor(Math.random() * opts.length)]);
    }, Math.max(0, gs.pickDeadline - Date.now()));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickPending, pickableCells.length === 1, gs?.pickDeadline, gs?.roundNumber]);

  // Host gate for "Nächste Runde": everyone picked or the window is over
  // (mirrors nextBingoRound's server-side check).
  const [pickWindowOver, setPickWindowOver] = useState(false);
  useEffect(() => {
    if (roundPhase !== 'resolved' || gs?.pickDeadline == null) {
      setPickWindowOver(true);
      return;
    }
    const remaining = gs.pickDeadline - Date.now();
    if (remaining <= 0) {
      setPickWindowOver(true);
      return;
    }
    setPickWindowOver(false);
    const t = setTimeout(() => setPickWindowOver(true), remaining);
    return () => clearTimeout(t);
  }, [roundPhase, gs?.pickDeadline, gs?.roundNumber]);
  const allPicked =
    players.length > 0 &&
    players.every(
      (p) => countMarked(p.bingo_board) >= (gs?.expectedMarks?.[p.player_id] ?? 0)
    );
  const nextReady = allPicked || pickWindowOver;
  const someoneHasBingo = players.some(
    (p) => p.bingo_board && hasBingo(p.bingo_board, size)
  );

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

  // Deadline resolve trigger - armed on ALL clients (foundation requirement:
  // a host disconnect must never strand the round; the claim dedupes).
  useEffect(() => {
    if (roundPhase !== 'collecting' || gs?.roundDeadline == null) return;
    const wait = Math.max(0, gs.roundDeadline + RESOLVE_GRACE_MS - Date.now());
    const t = setTimeout(() => {
      Online.resolveBingoRound(lobbyId).catch((e: any) => setError(e?.message ?? String(e)));
    }, wait);
    return () => clearTimeout(t);
  }, [roundPhase, gs?.roundDeadline, gs?.roundNumber, lobbyId]);

  // Early resolve as soon as EVERYONE answered (any client may fire; deduped).
  useEffect(() => {
    if (roundPhase !== 'collecting' || players.length === 0) return;
    if (answers.length >= players.length) {
      Online.resolveBingoRound(lobbyId).catch((e: any) => setError(e?.message ?? String(e)));
    }
  }, [roundPhase, answers.length, players.length, lobbyId]);

  // Stuck-resolving watchdog: if the claim winner died before the final write,
  // any client may re-claim after RESOLVE_STALE_MS (atomic in the service).
  useEffect(() => {
    if (roundPhase !== 'resolving') return;
    const claimedAt = gs?.resolveClaimedAt ?? gs?.roundDeadline ?? Date.now();
    const wait = Math.max(
      0,
      claimedAt + Online.RESOLVE_STALE_MS + RESOLVE_GRACE_MS - Date.now()
    );
    const t = setTimeout(() => {
      Online.resolveBingoRound(lobbyId).catch((e: any) => setError(e?.message ?? String(e)));
    }, wait);
    return () => clearTimeout(t);
  }, [roundPhase, gs?.resolveClaimedAt, gs?.roundDeadline, gs?.roundNumber, lobbyId]);

  // ---- Spin stage (before the answer window) ----
  const [spinFinished, setSpinFinished] = useState(false);
  const [spinOpenForAll, setSpinOpenForAll] = useState(false);

  // Reset the per-round inputs for each new round.
  useEffect(() => {
    setYearGuess(1990);
    setTitleText('');
    setHostVerdicts({});
    setSpinFinished(false);
  }, [gs?.roundNumber]);
  const spinnerId = gs?.spinnerId ?? null;
  const spinnerName =
    players.find((p) => p.player_id === spinnerId)?.player_name ?? '—';
  // After the grace window the button opens for everyone (absent spinner must
  // never stall the game); mirrors the server-side guard in triggerBingoSpin.
  useEffect(() => {
    if (roundPhase !== 'spinning' || gs?.spinArmedAt == null) {
      setSpinOpenForAll(false);
      return;
    }
    const remaining = gs.spinArmedAt + BINGO_SPIN_OPEN_ALL_MS - Date.now();
    if (remaining <= 0) {
      setSpinOpenForAll(true);
      return;
    }
    setSpinOpenForAll(false);
    const t = setTimeout(() => setSpinOpenForAll(true), remaining);
    return () => clearTimeout(t);
  }, [roundPhase, gs?.spinArmedAt, gs?.roundNumber]);
  const canSpin =
    roundPhase === 'spinning' && (spinnerId === myId || spinOpenForAll);
  // While true, the wheel animation replaces the answer UI (all clients replay
  // it from the same shared timestamp; late joiners past the end skip it).
  const spinRunning =
    roundPhase === 'collecting' &&
    gs?.spinStartedAt != null &&
    !spinFinished &&
    Date.now() - gs.spinStartedAt < BINGO_SPIN_MS;
  const onSpin = () =>
    Online.triggerBingoSpin(lobbyId)
      .then(() => refresh())
      .catch((e: any) => setError(e?.message ?? String(e)));

  // Entering the review: seed the host's local verdicts from the synced state
  // (relevant when the host re-opens the app mid-review).
  useEffect(() => {
    if (roundPhase === 'reviewing') setHostVerdicts(gs?.reviewVerdicts ?? {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundPhase === 'reviewing', gs?.roundNumber]);

  // Review deadline resolve - armed on ALL clients (an absent host must never
  // strand the round; unjudged answers fall back to the honor rule).
  useEffect(() => {
    if (roundPhase !== 'reviewing' || gs?.reviewDeadline == null) return;
    const wait = Math.max(0, gs.reviewDeadline + RESOLVE_GRACE_MS - Date.now());
    const t = setTimeout(() => {
      Online.resolveBingoRound(lobbyId).catch((e: any) => setError(e?.message ?? String(e)));
    }, wait);
    return () => clearTimeout(t);
  }, [roundPhase, gs?.reviewDeadline, gs?.roundNumber, lobbyId]);

  // Host taps ✓/✕: update local map, push the full map, and resolve as soon
  // as every submitted answer has a verdict (await order avoids racing the
  // resolve against the last verdict write).
  const onVerdict = (playerId: string, correct: boolean) => {
    const next = { ...hostVerdicts, [playerId]: correct };
    setHostVerdicts(next);
    Online.setBingoVerdicts(lobbyId, next)
      .then(() => {
        const done =
          answers.length > 0 &&
          answers.every((a) => typeof next[a.player_id] === 'boolean');
        return done ? Online.resolveBingoRound(lobbyId) : undefined;
      })
      .catch((e: any) => setError(e?.message ?? String(e)));
  };

  const submit = (answer: BingoAnswer) => {
    setError(null);
    Online.submitRoundAnswer(lobbyId, myId, answer)
      .then(() => refresh())
      .catch((e: any) => setError(e?.message ?? String(e)));
  };

  const onNextRound = () =>
    Online.nextBingoRound(lobbyId).catch((e: any) => setError(e?.message ?? String(e)));

  // Exit (same split as LobbyScreen): host ends the lobby for everyone,
  // a non-host only removes himself - the rest keeps playing.
  const onExit = () => setExitConfirmVisible(true);
  const confirmExit = async () => {
    setExitConfirmVisible(false);
    if (isHost) {
      setEndedHandled(true); // suppress our own "host ended" alert
      try {
        await Online.endLobby(lobbyId);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        navigation.navigate('OnlineHome');
      }
    } else {
      try {
        await Online.leaveLobby(lobbyId);
      } catch {
        // ignore - leaving anyway
      }
      navigation.navigate('OnlineHome');
    }
  };

  const markedCount = useMemo(
    () => (b?: BingoBoard | null) => (b ?? []).filter((c) => c.marked).length,
    []
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
    // First the automatic interstitial: the winning line is traced on each
    // winner's board (sequentially on multi-win). Skipped defensively when no
    // winner board is available yet (e.g. players list still loading).
    if (gs.winnerId && !finaleDone) {
      const revealWinners = winners
        .filter((p) => p.bingo_board && p.bingo_board.length > 0)
        .map((p) => ({ name: p.player_name, board: p.bingo_board! }));
      if (revealWinners.length > 0) {
        return (
          <BingoLineReveal
            winners={revealWinners}
            size={size}
            onDone={() => setFinaleDone(true)}
          />
        );
      }
    }
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
        <Text style={styles.trophy}>🎉</Text>
        <Text style={styles.sectionLabel}>
          {winnerIds.length > 1
            ? 'DOPPEL-BINGO! GEMEINSAMER SIEG'
            : gs.winnerId
              ? 'BINGO!'
              : 'KEINE KARTEN MEHR — UNENTSCHIEDEN'}
        </Text>
        {gs.winnerId && <Text style={styles.winnerName}>{winnerNames || '—'}</Text>}
        <Text style={styles.sectionLabel}>FELDER</Text>
        {[...players]
          .sort((a, b) => markedCount(b.bingo_board) - markedCount(a.bingo_board))
          .map((p) => (
            <View key={p.id} style={styles.scoreRow}>
              <Text style={styles.scoreName} numberOfLines={1}>
                {winnerIds.includes(p.player_id) ? '🏆 ' : ''}
                {p.player_name}
                {p.player_id === myId ? ' (du)' : ''}
              </Text>
              <Text style={styles.scoreVal}>
                {markedCount(p.bingo_board)} / {size * size} markiert
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

  const categoryColor = round ? CATEGORY_COLOR[round.type] : COLORS.border;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
      // The title_artist text input: submitting must work with the keyboard open.
      keyboardShouldPersistTaps="handled"
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <Text style={styles.title}>BINGO</Text>
        <View style={styles.roundPill}>
          <Text style={styles.roundPillText}>Runde {gs.roundNumber ?? 1}</Text>
        </View>
        <View style={styles.deckPill}>
          <Text style={styles.deckCount}>{gs.deck.length}</Text>
          <Text style={styles.deckLabel}>im Deck</Text>
        </View>
        {/* Backup play: only the host's device plays audio. */}
        {isHost && <PlayBackupButton uri={card?.trackUri ?? null} onError={setError} />}
        <PressableButton style={styles.iconBtn} onPress={onExit} hitSlop={8}>
          <Text style={styles.iconBtnText}>✕</Text>
        </PressableButton>
      </View>

      {/* ---- spinning: idle wheel + round-robin trigger button ---- */}
      {roundPhase === 'spinning' && (
        <View style={styles.spinBox}>
          <Text style={styles.categoryLabel}>KATEGORIE-ZIEHUNG</Text>
          <SpinWheel startedAt={null} />
          {canSpin ? (
            <PressableButton style={[styles.spinBtn, styles.spinBtnActive]} onPress={onSpin}>
              <Text style={styles.spinBtnText}>🪩 DREHEN!</Text>
            </PressableButton>
          ) : (
            <View style={[styles.spinBtn, styles.spinBtnLocked]}>
              <Text style={styles.spinBtnTextLocked}>🪩 DREHEN!</Text>
            </View>
          )}
          <Text style={styles.spinHint}>
            {canSpin
              ? spinnerId === myId
                ? 'Du bist dran — dreh die Kugel!'
                : `${spinnerName} reagiert nicht — jeder darf jetzt drehen!`
              : `${spinnerName} ist mit Drehen dran…`}
          </Text>
        </View>
      )}

      {/* ---- collecting, wheel still turning: everyone watches the draw ---- */}
      {roundPhase === 'collecting' && round && spinRunning && (
        <View style={styles.spinBox}>
          <Text style={styles.categoryLabel}>KATEGORIE-ZIEHUNG</Text>
          <SpinWheel
            startedAt={gs.spinStartedAt ?? null}
            category={round.type}
            onDone={() => setSpinFinished(true)}
          />
        </View>
      )}

      {/* ---- collecting: mystery song + category + input ---- */}
      {roundPhase === 'collecting' && round && !spinRunning && (
        <>
          <View style={styles.mysteryBox}>
            <Text style={styles.mysteryGlyph}>💿</Text>
            <Text style={styles.mysteryText}>Song läuft… hör genau hin!</Text>
            {gs.roundDeadline != null && <RoundCountdown deadlineMs={gs.roundDeadline} />}
          </View>

          <View style={[styles.categoryBox, { borderColor: categoryColor }]}>
            <Text style={styles.categoryLabel}>KATEGORIE</Text>
            <Text style={[styles.categoryName, { color: categoryColor }]}>
              {BINGO_CATEGORY_LABEL[round.type]}
            </Text>

            {iAnswered ? (
              <Text style={styles.answeredHint}>Antwort gespeichert ✓ — warte auf die anderen…</Text>
            ) : (
              <>
                {round.type === 'decade' && (
                  <View style={styles.choiceWrap}>
                    {/* Pool-span options (up to 8) -> compact buttons, 4/row. */}
                    {(round.decadeOptions ?? []).map((d) => (
                      <PressableButton
                        key={d}
                        style={[styles.choiceBtn, styles.choiceBtnDecade]}
                        onPress={() => submit({ kind: 'decade', decade: d })}
                      >
                        <Text style={[styles.choiceText, styles.choiceTextDecade]}>
                          {d}er
                        </Text>
                      </PressableButton>
                    ))}
                  </View>
                )}
                {round.type === 'before_after_2000' && (
                  <View style={styles.choiceWrap}>
                    <PressableButton
                      style={styles.choiceBtn}
                      onPress={() => submit({ kind: 'before_after_2000', after2000: false })}
                    >
                      <Text style={styles.choiceText}>Vor 2000</Text>
                    </PressableButton>
                    <PressableButton
                      style={styles.choiceBtn}
                      onPress={() => submit({ kind: 'before_after_2000', after2000: true })}
                    >
                      <Text style={styles.choiceText}>2000 oder später</Text>
                    </PressableButton>
                  </View>
                )}
                {round.type === 'year_guess' && (
                  <>
                    <View style={styles.yearHeader}>
                      <Text style={styles.hint}>Dein Tipp:</Text>
                      <Text style={styles.yearValue}>{yearGuess}</Text>
                    </View>
                    <StepSlider
                      value={yearGuess}
                      min={BINGO_YEAR_MIN}
                      max={BINGO_YEAR_MAX}
                      milestones={[1960, 1980, 2000, 2020]}
                      onChange={setYearGuess}
                    />
                    <PressableButton
                      style={styles.submitBtn}
                      onPress={() => submit({ kind: 'year_guess', year: yearGuess })}
                    >
                      <Text style={styles.submitBtnText}>Jahr einloggen</Text>
                    </PressableButton>
                  </>
                )}
                {round.type === 'title_artist' && (
                  <>
                    <Text style={styles.hint}>
                      Schreib auf, was du hörst — Titel + Interpret. Danach bewertet
                      der Host alle Antworten.
                    </Text>
                    <TextInput
                      style={styles.titleInput}
                      placeholder="Titel + Interpret"
                      placeholderTextColor={COLORS.textMuted}
                      value={titleText}
                      onChangeText={setTitleText}
                      autoCorrect={false}
                    />
                    <PressableButton
                      style={[styles.submitBtn, !titleText.trim() && styles.submitBtnDisabled]}
                      disabled={!titleText.trim()}
                      onPress={() => submit({ kind: 'title_artist', text: titleText.trim() })}
                    >
                      <Text style={styles.submitBtnText}>Antwort einloggen</Text>
                    </PressableButton>
                  </>
                )}
              </>
            )}
          </View>

          <Text style={styles.answeredCount}>
            {answers.length}/{players.length} haben geantwortet
          </Text>
        </>
      )}

      {/* ---- reviewing: everyone sees all texts, ONLY the host grades ---- */}
      {roundPhase === 'reviewing' && round && (
        <>
          <View style={[styles.categoryBox, { borderColor: categoryColor }]}>
            <Text style={styles.categoryLabel}>HOST-BEWERTUNG</Text>
            <Text style={[styles.categoryName, { color: categoryColor }]}>
              {BINGO_CATEGORY_LABEL[round.type]}
            </Text>
            <Text style={styles.hint}>
              {isHost
                ? 'Besprecht knappe Fälle kurz — du entscheidest pro Spieler.'
                : 'Alle Antworten liegen auf dem Tisch — der Host entscheidet.'}
            </Text>
            {/* Only the host gets the truth here; everyone else sees it at the reveal. */}
            {isHost && card && (
              <Text style={styles.reviewTruth}>
                Richtig wäre: {card.title} — {card.artist}
              </Text>
            )}
            {gs.reviewDeadline != null && <RoundCountdown deadlineMs={gs.reviewDeadline} />}
          </View>

          {players.map((p) => {
            const ans = answers.find((a) => a.player_id === p.player_id);
            const text = ans ? titleAnswerText(ans.answer) : null;
            const verdicts = isHost ? hostVerdicts : (gs.reviewVerdicts ?? {});
            const verdict = verdicts[p.player_id];
            return (
              <View key={p.id} style={styles.reviewRow}>
                <View style={styles.reviewTextWrap}>
                  <Text style={styles.scoreName} numberOfLines={1}>
                    {p.player_name}
                    {p.player_id === myId ? ' (du)' : ''}
                  </Text>
                  <Text
                    style={text != null ? styles.reviewAnswer : styles.reviewNoAnswer}
                    numberOfLines={2}
                  >
                    {text ?? '— keine Antwort'}
                  </Text>
                </View>
                {text != null &&
                  (isHost ? (
                    <View style={styles.verdictBtns}>
                      <PressableButton
                        style={[styles.verdictBtn, verdict === true && styles.verdictYesOn]}
                        onPress={() => onVerdict(p.player_id, true)}
                        hitSlop={4}
                      >
                        <Text style={styles.verdictBtnText}>✓</Text>
                      </PressableButton>
                      <PressableButton
                        style={[styles.verdictBtn, verdict === false && styles.verdictNoOn]}
                        onPress={() => onVerdict(p.player_id, false)}
                        hitSlop={4}
                      >
                        <Text style={styles.verdictBtnText}>✕</Text>
                      </PressableButton>
                    </View>
                  ) : (
                    <Text
                      style={[
                        styles.verdictChip,
                        {
                          color:
                            verdict === true
                              ? COLORS.correct
                              : verdict === false
                                ? COLORS.incorrect
                                : COLORS.textMuted,
                        },
                      ]}
                    >
                      {verdict === true ? '✓' : verdict === false ? '✕' : '…'}
                    </Text>
                  ))}
              </View>
            );
          })}
        </>
      )}

      {/* ---- resolving (transient) ---- */}
      {roundPhase === 'resolving' && <Text style={styles.hint}>Runde wird aufgelöst…</Text>}

      {/* ---- resolved: reveal + outcomes + host next ---- */}
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

          <Text style={styles.sectionLabel}>ERGEBNIS</Text>
          {players.map((p) => {
            const outcome = gs.roundResults?.[p.player_id] ?? 'missed';
            const label =
              outcome === 'correct' ? '✓ richtig' : outcome === 'incorrect' ? '✕ falsch' : '— keine Antwort';
            const color =
              outcome === 'correct' ? COLORS.correct : outcome === 'incorrect' ? COLORS.incorrect : COLORS.textMuted;
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

          {/* ---- cell-pick window ---- */}
          {pickPending && pickableCells.length > 1 && (
            <View style={[styles.pickBox, { borderColor: categoryColor }]}>
              <Text style={[styles.pickTitle, { color: categoryColor }]}>
                ✓ Richtig! Such dir dein Feld aus
              </Text>
              <Text style={styles.hint}>
                Tippe unten auf deinem Board ein leuchtendes „+"-Feld an.
              </Text>
              {gs.pickDeadline != null && <RoundCountdown deadlineMs={gs.pickDeadline} />}
            </View>
          )}
          {colorFull && (
            <Text style={styles.hint}>
              ✓ Richtig — aber alle Felder dieser Farbe sind auf deinem Board schon
              markiert. Nichts mehr zu holen.
            </Text>
          )}

          {isHost ? (
            <PressableButton
              style={[styles.primaryBtn, !nextReady && styles.primaryBtnDisabled]}
              onPress={onNextRound}
              disabled={!nextReady}
            >
              <Text style={styles.primaryBtnText}>
                {!nextReady
                  ? 'Warte auf Feld-Auswahl…'
                  : someoneHasBingo
                    ? '🎉 BINGO! Ergebnis anzeigen'
                    : 'Nächste Runde'}
              </Text>
            </PressableButton>
          ) : (
            <Text style={styles.hint}>Warte auf den Host…</Text>
          )}
        </>
      )}

      {/* ---- own board + legend ---- */}
      <Text style={styles.sectionLabel}>DEIN BOARD</Text>
      {me?.bingo_board ? (
        <BingoGrid
          board={me.bingo_board}
          size={size}
          selectable={pickPending && pickableCells.length > 1 ? pickableCells : undefined}
          onPickCell={pickPending && pickableCells.length > 1 ? onPickCell : undefined}
        />
      ) : (
        <Text style={styles.muted}>Board wird geladen…</Text>
      )}
      <View style={styles.legend}>
        {(Object.keys(BINGO_CATEGORY_LABEL) as BingoCategoryType[]).map((t) => (
          <View key={t} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: CATEGORY_COLOR[t] }]} />
            <Text style={styles.legendText}>{BINGO_CATEGORY_LABEL[t]}</Text>
          </View>
        ))}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      <ConfirmDialog
        visible={exitConfirmVisible}
        title="Spiel wirklich verlassen?"
        message={
          isHost
            ? 'Du bist der Host — die Lobby wird für alle Mitspieler beendet.'
            : 'Die anderen spielen ohne dich weiter.'
        }
        confirmLabel={isHost ? 'Beenden' : 'Verlassen'}
        isDestructive
        onConfirm={confirmExit}
        onCancel={() => setExitConfirmVisible(false)}
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
  hint: { color: COLORS.textMuted, fontSize: 14, fontStyle: 'italic' },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: {
    flex: 1,
    fontSize: 28,
    fontWeight: '900',
    color: COLORS.primary,
    letterSpacing: 2,
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
  deckPill: {
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.border,
    borderWidth: 2,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 6,
    alignItems: 'center',
  },
  deckCount: { color: COLORS.secondary, fontWeight: '900', fontSize: 18 },
  deckLabel: { color: COLORS.textMuted, fontWeight: '700', fontSize: 10, letterSpacing: 1 },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnText: { color: COLORS.textMuted, fontSize: 18, fontWeight: '900' },

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
  mysteryText: { color: COLORS.textMuted, fontSize: 14, fontWeight: '700' },
  countdown: { color: COLORS.secondary, fontSize: 22, fontWeight: '900' },
  countdownUrgent: { color: COLORS.incorrect },

  spinBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: COLORS.primary,
    padding: 16,
    alignItems: 'center',
    gap: 12,
    ...glow(COLORS.primary, { radius: 16, opacity: 0.6 }),
  },
  spinGrid: { gap: 6, alignSelf: 'center' },
  spinTile: {
    width: 62,
    height: 46,
    borderRadius: 10,
    borderWidth: 3,
    backgroundColor: COLORS.background,
  },
  spinBtn: {
    alignSelf: 'stretch',
    minHeight: 64,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spinBtnActive: {
    backgroundColor: COLORS.primary,
    ...glow(COLORS.primary, { radius: 18, opacity: 0.9 }),
  },
  spinBtnLocked: {
    backgroundColor: COLORS.background,
    borderWidth: 2,
    borderColor: COLORS.border,
    opacity: 0.6,
  },
  spinBtnText: { color: COLORS.text, fontSize: 21, fontWeight: '900', letterSpacing: 1.5 },
  spinBtnTextLocked: {
    color: COLORS.textMuted,
    fontSize: 21,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
  spinHint: { color: COLORS.textMuted, fontSize: 13, fontWeight: '700', textAlign: 'center' },

  categoryBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 20,
    borderWidth: 2,
    padding: 16,
    gap: 10,
  },
  categoryLabel: { color: COLORS.textMuted, fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  categoryName: { fontSize: 24, fontWeight: '900' },
  answeredHint: { color: COLORS.correct, fontSize: 15, fontWeight: '800' },

  choiceWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  choiceBtn: {
    flexGrow: 1,
    flexBasis: '40%',
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: COLORS.background,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  choiceText: { color: COLORS.text, fontSize: 16, fontWeight: '900', textAlign: 'center' },
  // Decade MC can show up to 8 pool decades -> narrower buttons, 4 per row.
  choiceBtnDecade: { flexBasis: '21%', minHeight: 48 },
  choiceTextDecade: { fontSize: 14 },

  titleInput: {
    minHeight: 52,
    backgroundColor: COLORS.background,
    borderColor: COLORS.border,
    borderWidth: 2,
    borderRadius: 14,
    paddingHorizontal: 14,
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
  },

  yearHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  yearValue: { color: COLORS.accent, fontSize: 26, fontWeight: '900' },
  submitBtn: {
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: COLORS.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnText: { color: COLORS.background, fontSize: 16, fontWeight: '900' },
  submitBtnDisabled: { opacity: 0.5 },

  reviewTruth: {
    color: COLORS.accent,
    fontSize: 13,
    fontWeight: '800',
    fontStyle: 'italic',
  },
  reviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  reviewTextWrap: { flex: 1, gap: 2 },
  reviewAnswer: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
  reviewNoAnswer: { color: COLORS.textMuted, fontSize: 14, fontStyle: 'italic' },
  verdictBtns: { flexDirection: 'row', gap: 8 },
  verdictBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: COLORS.background,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verdictYesOn: { backgroundColor: COLORS.correct, borderColor: COLORS.correct },
  verdictNoOn: { backgroundColor: COLORS.incorrect, borderColor: COLORS.incorrect },
  verdictBtnText: { color: COLORS.text, fontSize: 18, fontWeight: '900' },
  verdictChip: { fontSize: 22, fontWeight: '900' },

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
  cover: { width: 140, height: 140, borderRadius: 14, marginBottom: 6 },
  coverFallback: { backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },
  revealTitle: { color: COLORS.text, fontSize: 20, fontWeight: '900', textAlign: 'center' },
  revealArtist: { color: COLORS.textMuted, fontSize: 14, fontWeight: '600' },
  revealYear: {
    color: COLORS.accent,
    fontSize: 34,
    fontWeight: '900',
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12,
  },

  sectionLabel: { fontSize: 13, fontWeight: '800', color: COLORS.secondary, letterSpacing: 2, marginTop: 10 },

  grid: { gap: 6, alignSelf: 'center' },
  gridRow: { flexDirection: 'row', gap: 6 },
  cell: {
    width: 56,
    height: 56,
    borderRadius: 12,
    borderWidth: 3,
    backgroundColor: COLORS.backgroundAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellCheck: { color: COLORS.background, fontSize: 26, fontWeight: '900' },
  cellPick: { fontSize: 26, fontWeight: '900' },

  pickBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 16,
    borderWidth: 2,
    padding: 14,
    gap: 6,
    alignItems: 'center',
  },
  pickTitle: { fontSize: 17, fontWeight: '900', textAlign: 'center' },

  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 12, height: 12, borderRadius: 999 },
  legendText: { color: COLORS.textMuted, fontSize: 11, fontWeight: '700' },

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
    fontSize: 36,
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
  primaryBtnDisabled: { opacity: 0.5 },
});
