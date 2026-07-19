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
  InteractionManager,
  Linking,
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
  bandAnswerGroup,
  bingoCategoryLabel,
  BINGO_CATEGORIES,
  BINGO_COUNTDOWN_MS,
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
import * as MusicBrainz from '../services/musicbrainz';
import { buildPlayerBingoStats } from '../game/stats';
import { BingoCountdown } from '../components/BingoCountdown';
import { BingoGrid } from '../components/BingoGrid';
import { CategoryWheel } from '../components/CategoryWheel';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BingoLineReveal } from '../components/BingoLineReveal';
import { VictoryCelebration } from '../components/VictoryCelebration';
import { HeaderMenu } from '../components/HeaderMenu';
import { PlayerBingoStatsAccordion } from '../components/PlayerStatsAccordion';
import { ReportSongDialog, type ReportSongTarget } from '../components/ReportSongDialog';
import { PressableButton } from '../components/PressableButton';
import { StepSlider } from '../components/StepSlider';
import { useSpotifyReconnect } from '../hooks/useSpotifyReconnect';
import { BINGO_CATEGORY_COLOR, COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import type {
  BingoBoard,
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

/** Local per-second countdown from the synced round deadline (cosmetic). */
function RoundCountdown({ deadlineMs }: { deadlineMs: number }) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.ceil((deadlineMs - Online.serverNow()) / 1000))
  );
  useEffect(() => {
    const iv = setInterval(() => {
      const r = Math.max(0, Math.ceil((deadlineMs - Online.serverNow()) / 1000));
      setRemaining(r);
      if (r <= 0) clearInterval(iv);
    }, 250);
    setRemaining(Math.max(0, Math.ceil((deadlineMs - Online.serverNow()) / 1000)));
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
  // MusicBrainz Person/Group suggestion for the band_or_solo review (host
  // device only). 'pending' until the lookup settles; null = no usable hint,
  // the review then shows the manual search link instead.
  const [mbSuggestion, setMbSuggestion] = useState<MusicBrainz.ArtistKind | null | 'pending'>(
    'pending'
  );
  const [endedHandled, setEndedHandled] = useState(false);
  const [exitConfirmVisible, setExitConfirmVisible] = useState(false);
  // Win-line interstitial shown once before the victory celebration.
  const [finaleDone, setFinaleDone] = useState(false);
  // "Song melden": snapshot taken when the dialog opens (live: the revealed
  // card; stats view: the tapped history item), so an advancing round can
  // never swap the reported song underneath it.
  const [reportCard, setReportCard] = useState<ReportSongTarget | null>(null);

  const myId = Online.getPlayerId();

  // One-time server-clock sync: the simultaneous-round timestamps
  // (roundDeadline etc.) are written and compared via serverNow(), so each
  // device corrects its own clock skew once per game (see services/supabase).
  useEffect(() => {
    Online.syncServerClock();
  }, []);

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
  // Year-guess slider range: the pool's real span (synced at game start);
  // fallback constants only for games started before the bounds existed.
  const yearMin = gs?.bingoYearMin ?? BINGO_YEAR_MIN;
  const yearMax = gs?.bingoYearMax ?? BINGO_YEAR_MAX;
  const me = players.find((p) => p.player_id === myId);
  const isHost = !!me?.is_host;
  // Host plays audio -> silently reconnect Spotify after a background/foreground.
  useSpotifyReconnect(isHost);
  const card = gs?.currentCard ?? null;
  const round = gs?.bingoRound ?? null;
  const roundPhase = gs?.roundPhase ?? null;
  const size = gs?.modeConfig?.bingoGridSize ?? 4;
  // Difficulty only changes LABELS here - the question mechanics live in the
  // synced round spec (tolerance), see drawBingoRound.
  const difficulty = gs?.modeConfig?.bingoDifficulty ?? 'easy';
  // Hard pink variant: the spec carries a tolerance -> the question is a
  // numeric year guess (same input + payload as year_guess).
  const yearInput =
    round?.type === 'year_guess' ||
    (round?.type === 'before_after_2000' && round?.tolerance != null);
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
    }, Math.max(0, gs.pickDeadline - Online.serverNow()));
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
    const remaining = gs.pickDeadline - Online.serverNow();
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

  // Rematch: the host reopened the lobby (status back to 'waiting') -> every
  // connected device returns to the waiting room automatically (same code, no
  // re-join). Navigate exactly once.
  const rematchRef = useRef(false);
  useEffect(() => {
    if (lobby?.status !== 'waiting' || rematchRef.current) return;
    rematchRef.current = true;
    navigation.navigate('Lobby', { lobbyId, code: lobby.code });
  }, [lobby?.status, lobby?.code, lobbyId, navigation]);

  // Host-only audio. The round's song starts only AFTER the wheel lands AND the
  // 3-2-1 countdown ends (spinStartedAt + spin + countdown), so the PREVIOUS song
  // keeps playing through the draw and the new song never changes before the
  // category is revealed. Scheduled off the shared spinStartedAt, so a host who
  // (re)joins mid-round starts it at the right moment (or immediately if already
  // past). Round 1 needs no special case: there is simply no previous song, so
  // the wheel + countdown play over silence and the song starts at the same beat.
  useEffect(() => {
    if (!isHost) return;
    if (gs?.phase === 'finished') {
      Spotify.pause().catch(() => {});
      return;
    }
    if (roundPhase !== 'collecting' || !card || gs?.spinStartedAt == null) return;
    // Run the play AFTER the current interactions/render settle. The song starts
    // at the same instant the answer phase appears, and playUriGuarded's Spotify
    // App Remote calls run on the iOS main queue (RCTExecuteOnMainQueue) - the
    // same thread that paints the UI. Deferring keeps that native work off the
    // transition frame, so the host's answer timer paints in sync with everyone
    // else's (which derive purely from the shared roundDeadline) instead of
    // waiting behind the connectivity check. Audio delay is imperceptible.
    const play = () =>
      InteractionManager.runAfterInteractions(() => {
        Spotify.playUriGuarded(card.trackUri).catch((e: any) => setError(e?.message ?? String(e)));
      });
    const wait = gs.spinStartedAt + BINGO_SPIN_MS + BINGO_COUNTDOWN_MS - Online.serverNow();
    if (wait <= 0) {
      play();
      return;
    }
    const t = setTimeout(play, wait);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id, roundPhase, gs?.spinStartedAt, gs?.phase, isHost]);

  // Deadline resolve trigger - armed on ALL clients (foundation requirement:
  // a host disconnect must never strand the round; the claim dedupes).
  useEffect(() => {
    if (roundPhase !== 'collecting' || gs?.roundDeadline == null) return;
    const wait = Math.max(0, gs.roundDeadline + RESOLVE_GRACE_MS - Online.serverNow());
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
    const claimedAt = gs?.resolveClaimedAt ?? gs?.roundDeadline ?? Online.serverNow();
    const wait = Math.max(
      0,
      claimedAt + Online.RESOLVE_STALE_MS + RESOLVE_GRACE_MS - Online.serverNow()
    );
    const t = setTimeout(() => {
      Online.resolveBingoRound(lobbyId).catch((e: any) => setError(e?.message ?? String(e)));
    }, wait);
    return () => clearTimeout(t);
  }, [roundPhase, gs?.resolveClaimedAt, gs?.roundDeadline, gs?.roundNumber, lobbyId]);

  // ---- Spin stage (before the answer window) ----
  const [spinFinished, setSpinFinished] = useState(false);
  // The 3-2-1 countdown (after the wheel) has run out on this client.
  const [countdownFinished, setCountdownFinished] = useState(false);
  const [spinOpenForAll, setSpinOpenForAll] = useState(false);

  // Reset the per-round inputs for each new round.
  useEffect(() => {
    // Fresh round -> park the slider mid-range of the pool's visible span.
    setYearGuess(Math.round((yearMin + yearMax) / 2));
    setTitleText('');
    setHostVerdicts({});
    setSpinFinished(false);
    setCountdownFinished(false);
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
    const remaining = gs.spinArmedAt + BINGO_SPIN_OPEN_ALL_MS - Online.serverNow();
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
    Online.serverNow() - gs.spinStartedAt < BINGO_SPIN_MS;
  // After the wheel and before the song: the 3-2-1 countdown (also shared-clock
  // driven, so late joiners land on the right beat and skip it if already past).
  const countdownRunning =
    roundPhase === 'collecting' &&
    gs?.spinStartedAt != null &&
    !spinRunning &&
    !countdownFinished &&
    Online.serverNow() - gs.spinStartedAt < BINGO_SPIN_MS + BINGO_COUNTDOWN_MS;
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
    const wait = Math.max(0, gs.reviewDeadline + RESOLVE_GRACE_MS - Online.serverNow());
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

  // Host taps the band_or_solo truth (Gruppe/Solo): write it, then resolve -
  // same await order as onVerdict so the resolve never races the truth write.
  const onTruth = (group: boolean) => {
    Online.setBingoTruth(lobbyId, group)
      .then(() => Online.resolveBingoRound(lobbyId))
      .catch((e: any) => setError(e?.message ?? String(e)));
  };

  // Review assist for band_or_solo: ONE targeted MusicBrainz lookup for the
  // current song's first credited artist, fired on the HOST device as soon as
  // the round's category is known - the result is long settled when the review
  // opens. Only a hint (the host's one-tap truth decides); any failure just
  // means the review shows the manual search link instead. Never blocks.
  useEffect(() => {
    if (!isHost || round?.type !== 'band_or_solo' || !card) return;
    let live = true;
    setMbSuggestion('pending');
    MusicBrainz.lookupArtistKind(card.artist).then(
      (kind) => {
        if (live) setMbSuggestion(kind);
      },
      () => {
        if (live) setMbSuggestion(null);
      }
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, round?.type, card?.id]);

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

  // Shared between the playing view AND the finished stats view (both are
  // separate returns): one dialog, one snapshot state, one submit.
  const reportDialog = (
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
          mode: 'bingo',
          lobbyId,
        })
      }
    />
  );

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
            <PlayerBingoStatsAccordion
              key={p.id}
              name={`${p.player_name}${p.player_id === myId ? ' (du)' : ''}`}
              isWinner={winnerIds.includes(p.player_id)}
              headerRight={`${markedCount(p.bingo_board)} / ${size * size} markiert`}
              stats={buildPlayerBingoStats(gs.bingoStatsHistory ?? [], p.player_id)}
              board={p.bingo_board ? { cells: p.bingo_board, size } : undefined}
              difficulty={difficulty}
              onReportSong={isHost ? setReportCard : undefined}
            />
          ))}
        {isHost && (
          <PressableButton
            style={styles.primaryBtn}
            onPress={() => Online.reopenLobby(lobbyId).catch((e: any) => setError(e?.message ?? String(e)))}
          >
            <Text style={styles.primaryBtnText}>Nochmal spielen</Text>
          </PressableButton>
        )}
        <PressableButton
          style={styles.secondaryBtn}
          onPress={() => {
            // Leaving the result screen = leaving the lobby: delete the own
            // roster row so a rematch can't deal ghost players into the next
            // game (fire-and-forget; leaveLobby clears the stored id too).
            Online.leaveLobby(lobbyId).catch(() => {});
            navigation.navigate('OnlineHome');
          }}
        >
          <Text style={styles.secondaryBtnText}>Zurück</Text>
        </PressableButton>
        {error && <Text style={styles.error}>{error}</Text>}
        {reportDialog}
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
        <Text style={styles.title} numberOfLines={1} adjustsFontSizeToFit>
          BINGO
        </Text>
        <View style={styles.roundPill}>
          <Text style={styles.roundPillText}>Runde {gs.roundNumber ?? 1}</Text>
        </View>
        {/* Single overflow: Play/Pause (host), report, lobby code, deck count,
            exit. Reveal = round resolved (the result view shows the song). */}
        <HeaderMenu
          playback={isHost ? { uri: card?.trackUri ?? null, onError: setError } : undefined}
          report={
            isHost
              ? {
                  enabled: roundPhase === 'resolved' && !!card,
                  onPress: () => setReportCard(card),
                }
              : undefined
          }
          code={lobby?.code ?? '—'}
          deckCount={gs.deck.length}
          action={{
            label: isHost ? 'Lobby beenden' : 'Lobby verlassen',
            destructive: true,
            onPress: onExit,
          }}
        />
      </View>

      {/* ---- spinning: idle wheel + round-robin trigger button ---- */}
      {roundPhase === 'spinning' && (
        <View style={styles.spinBox}>
          <Text style={styles.categoryLabel}>KATEGORIE-ZIEHUNG</Text>
          <CategoryWheel startedAt={null} />
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
                ? 'Du bist dran — dreh die Scheibe!'
                : `${spinnerName} reagiert nicht — jeder darf jetzt drehen!`
              : `${spinnerName} ist mit Drehen dran…`}
          </Text>
        </View>
      )}

      {/* ---- collecting, wheel still turning: everyone watches the draw ---- */}
      {roundPhase === 'collecting' && round && spinRunning && (
        <View style={styles.spinBox}>
          <Text style={styles.categoryLabel}>KATEGORIE-ZIEHUNG</Text>
          <CategoryWheel
            startedAt={gs.spinStartedAt ?? null}
            category={round.type}
            onDone={() => setSpinFinished(true)}
          />
        </View>
      )}

      {/* ---- wheel landed, 3-2-1 before the song (old song still playing) ---- */}
      {roundPhase === 'collecting' && round && countdownRunning && gs.spinStartedAt != null && (
        <View style={styles.spinBox}>
          <BingoCountdown
            startAt={gs.spinStartedAt + BINGO_SPIN_MS}
            category={round.type}
            difficulty={difficulty}
            onDone={() => setCountdownFinished(true)}
          />
        </View>
      )}

      {/* ---- collecting: mystery song + category + input ---- */}
      {roundPhase === 'collecting' && round && !spinRunning && !countdownRunning && (
        <>
          <View style={styles.mysteryBox}>
            <Text style={styles.mysteryGlyph}>💿</Text>
            <Text style={styles.mysteryText}>Song läuft… hör genau hin!</Text>
            {gs.roundDeadline != null && <RoundCountdown deadlineMs={gs.roundDeadline} />}
          </View>

          <View style={[styles.categoryBox, { borderColor: categoryColor }]}>
            <Text style={styles.categoryLabel}>KATEGORIE</Text>
            <Text style={[styles.categoryName, { color: categoryColor }]}>
              {bingoCategoryLabel(round.type, difficulty)}
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
                {round.type === 'before_after_2000' && round.tolerance == null && (
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
                {yearInput && (
                  <>
                    <View style={styles.yearHeader}>
                      <Text style={styles.hint}>Dein Tipp:</Text>
                      <Text style={styles.yearValue}>{yearGuess}</Text>
                    </View>
                    <StepSlider
                      value={yearGuess}
                      min={yearMin}
                      max={yearMax}
                      milestones={[yearMin, Math.round((yearMin + yearMax) / 2), yearMax]}
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
                      {difficulty === 'hard'
                        ? 'Schreib auf, was du hörst — Titel + Interpret. Danach bewertet der Host alle Antworten.'
                        : 'Schreib auf, wen du hörst — der Interpret reicht. Danach bewertet der Host alle Antworten.'}
                    </Text>
                    <TextInput
                      style={styles.titleInput}
                      placeholder={difficulty === 'hard' ? 'Titel + Interpret' : 'Interpret'}
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
                {round.type === 'band_or_solo' && (
                  <View style={styles.choiceWrap}>
                    <PressableButton
                      style={styles.choiceBtn}
                      onPress={() => submit({ kind: 'band_or_solo', group: true })}
                    >
                      <Text style={styles.choiceText}>Gruppe / Band</Text>
                    </PressableButton>
                    <PressableButton
                      style={styles.choiceBtn}
                      onPress={() => submit({ kind: 'band_or_solo', group: false })}
                    >
                      <Text style={styles.choiceText}>Solokünstler</Text>
                    </PressableButton>
                  </View>
                )}
              </>
            )}
          </View>

          <Text style={styles.answeredCount}>
            {answers.length}/{players.length} haben geantwortet
          </Text>
        </>
      )}

      {/* ---- reviewing: everyone sees all answers, ONLY the host grades.
              title_artist: per-player ✓/✕ verdicts on the free texts.
              band_or_solo: the host sets the TRUTH once (Gruppe/Solo, assisted
              by the MusicBrainz suggestion); grading follows automatically. ---- */}
      {roundPhase === 'reviewing' && round && round.type !== 'band_or_solo' && (
        <>
          <View style={[styles.categoryBox, { borderColor: categoryColor }]}>
            <Text style={styles.categoryLabel}>HOST-BEWERTUNG</Text>
            <Text style={[styles.categoryName, { color: categoryColor }]}>
              {bingoCategoryLabel(round.type, difficulty)}
            </Text>
            <Text style={styles.hint}>
              {isHost
                ? 'Besprecht knappe Fälle kurz — du entscheidest pro Spieler.'
                : 'Alle Antworten liegen auf dem Tisch — der Host entscheidet.'}
            </Text>
            {/* The truth is public during the review: the group can only
                discuss near-misses (typos etc.) when everyone knows the
                correct answer. The host still logs the final ✓/✕. */}
            {card && (
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
      {roundPhase === 'reviewing' && round && round.type === 'band_or_solo' && (
        <>
          <View style={[styles.categoryBox, { borderColor: categoryColor }]}>
            <Text style={styles.categoryLabel}>HOST-BEWERTUNG</Text>
            <Text style={[styles.categoryName, { color: categoryColor }]}>
              {bingoCategoryLabel(round.type, difficulty)}
            </Text>
            <Text style={styles.hint}>
              {isHost
                ? 'Sag an, was richtig ist — deine Wahl bewertet alle Antworten.'
                : 'Alle Antworten liegen auf dem Tisch — der Host entscheidet.'}
            </Text>
            {/* Artist is public during the review (answers are locked); the
                title reveal stays where it belongs, in the resolved view. */}
            {card && <Text style={styles.reviewTruth}>Interpret: {card.artist}</Text>}
            {isHost && card && (
              <>
                {mbSuggestion === 'person' || mbSuggestion === 'group' ? (
                  <Text style={styles.mbHint}>
                    MusicBrainz: vermutlich{' '}
                    {mbSuggestion === 'group' ? 'Gruppe/Band' : 'Solokünstler'}
                  </Text>
                ) : (
                  // Lookup failed/inconclusive (or still pending after the
                  // timeout window): the host checks manually instead.
                  <Text
                    style={styles.mbLink}
                    onPress={() => {
                      Linking.openURL(MusicBrainz.artistSearchUrl(card.artist)).catch(() => {});
                    }}
                  >
                    Auf MusicBrainz nachsehen ↗
                  </Text>
                )}
                <View style={styles.choiceWrap}>
                  <PressableButton style={styles.choiceBtn} onPress={() => onTruth(true)}>
                    <Text style={styles.choiceText}>Gruppe / Band</Text>
                  </PressableButton>
                  <PressableButton style={styles.choiceBtn} onPress={() => onTruth(false)}>
                    <Text style={styles.choiceText}>Solokünstler</Text>
                  </PressableButton>
                </View>
              </>
            )}
            {gs.reviewDeadline != null && <RoundCountdown deadlineMs={gs.reviewDeadline} />}
          </View>

          {players.map((p) => {
            const ans = answers.find((a) => a.player_id === p.player_id);
            const claim = ans ? bandAnswerGroup(ans.answer) : null;
            const text = claim == null ? null : claim ? 'Gruppe / Band' : 'Solokünstler';
            return (
              <View key={p.id} style={styles.reviewRow}>
                <View style={styles.reviewTextWrap}>
                  <Text style={styles.scoreName} numberOfLines={1}>
                    {p.player_name}
                    {p.player_id === myId ? ' (du)' : ''}
                  </Text>
                  <Text
                    style={text != null ? styles.reviewAnswer : styles.reviewNoAnswer}
                    numberOfLines={1}
                  >
                    {text ?? '— keine Antwort'}
                  </Text>
                </View>
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
        {BINGO_CATEGORIES.map((t) => (
          <View key={t} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: CATEGORY_COLOR[t] }]} />
            <Text style={styles.legendText}>{bingoCategoryLabel(t, difficulty)}</Text>
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

      {reportDialog}
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
  // MusicBrainz suggestion / manual fallback link in the band_or_solo review:
  // deliberately quiet (a hint, not a primary action).
  mbHint: { color: COLORS.textMuted, fontSize: 13, fontStyle: 'italic' },
  mbLink: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontStyle: 'italic',
    textDecorationLine: 'underline',
  },
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
  secondaryBtn: {
    marginTop: 10,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryBtnText: { color: COLORS.textMuted, fontSize: 15, fontWeight: '800' },
  primaryBtnDisabled: { opacity: 0.5 },
});
