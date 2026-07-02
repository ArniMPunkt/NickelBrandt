/**
 * GameScreen - the active player places the current track into their timeline,
 * with the optional chip / "Hitster!" steal layer on top.
 *
 * Flow (chipsEnabled):
 *   placing -> [active picks slot] -> stealWindow (5s + grace, others with chips
 *   may call "Hitster!") -> if called: stealSelect -> stealPlace -> reveal,
 *   else: auto reveal. After reveal: optional "chip earned?" question -> Weiter.
 *
 * All timer logic lives here (side-effect); the reducer stays pure. Animations
 * use the built-in Animated API only.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useGame } from '../context/GameContext';
import * as Spotify from '../services/spotify';
import { STEAL_WINDOW_MS } from '../game/constants';
import { FinalCardReveal } from '../components/FinalCardReveal';
import { PressableButton } from '../components/PressableButton';
import { TurnCountdown } from '../components/TurnCountdown';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import { MAX_CHIPS, type GameCard, type LastPlacement, type Player } from '../types/game';
import type { GameStackParamList } from '../types/navigation';

type Nav = NativeStackNavigationProp<GameStackParamList, 'Game'>;
type LocalPhase =
  | 'placing'
  | 'noStealNotice'
  | 'stealWindow'
  | 'stealSelect'
  | 'stealPlace';

const STEAL_GRACE_MS = 700;

function yearRange(timeline: GameCard[]): string {
  if (timeline.length === 0) return '-';
  const years = timeline.map((c) => c.year);
  const min = Math.min(...years);
  const max = Math.max(...years);
  return min === max ? `${min}` : `${min}–${max}`;
}

/** Whether the card ends up kept (placed) by someone after a placement/steal. */
function placementKept(lp: LastPlacement): boolean {
  if (lp.steal) return lp.steal.result === 'correct' || lp.result === 'correct';
  return lp.result === 'correct';
}

/** Year display that flips from "????" to the real year on reveal. */
function FlipYear({ revealed, year }: { revealed: boolean; year: number }) {
  const flip = useRef(new Animated.Value(revealed ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(flip, {
      toValue: revealed ? 1 : 0,
      duration: 500,
      useNativeDriver: true,
    }).start();
  }, [revealed, flip]);

  const frontRotate = flip.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  const backRotate = flip.interpolate({ inputRange: [0, 1], outputRange: ['180deg', '360deg'] });
  const frontOpacity = flip.interpolate({ inputRange: [0, 0.49, 0.5, 1], outputRange: [1, 1, 0, 0] });
  const backOpacity = flip.interpolate({ inputRange: [0, 0.5, 0.51, 1], outputRange: [0, 0, 1, 1] });

  return (
    <View style={styles.flipWrap}>
      <Animated.Text
        style={[styles.cardYear, styles.flipFace, styles.cardYearHidden, { opacity: frontOpacity, transform: [{ perspective: 800 }, { rotateY: frontRotate }] }]}
      >
        ????
      </Animated.Text>
      <Animated.Text
        style={[styles.cardYear, styles.flipFace, { opacity: backOpacity, transform: [{ perspective: 800 }, { rotateY: backRotate }] }]}
      >
        {year}
      </Animated.Text>
    </View>
  );
}

/** One timeline card; the freshly placed card animates in (scale + slide). */
function TimelineCard({ card, isNew }: { card: GameCard; isNew: boolean }) {
  const a = useRef(new Animated.Value(isNew ? 0 : 1)).current;
  useEffect(() => {
    if (isNew) {
      Animated.spring(a, { toValue: 1, friction: 6, tension: 70, useNativeDriver: true }).start();
    }
  }, [a, isNew]);
  const scale = a.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });
  const translateY = a.interpolate({ inputRange: [0, 1], outputRange: [-26, 0] });
  return (
    <Animated.View style={[styles.timelineCard, { opacity: a, transform: [{ scale }, { translateY }] }]}>
      <Text style={styles.timelineYear}>{card.year}</Text>
      <Text style={styles.timelineTitle} numberOfLines={2}>
        {card.title}
      </Text>
    </Animated.View>
  );
}

/** Horizontal timeline; if onInsert is given, shows tappable [+] slots. */
function TimelineStrip({
  timeline,
  onInsert,
  newCardId,
  isSlotEnabled,
}: {
  timeline: GameCard[];
  onInsert?: (i: number) => void;
  newCardId?: string | null;
  /** Optional per-slot gate; disabled slots render greyed and untappable. */
  isSlotEnabled?: (i: number) => boolean;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.timelineRow}>
      {Array.from({ length: timeline.length + 1 }).map((_, slot) => {
        const enabled = isSlotEnabled ? isSlotEnabled(slot) : true;
        return (
        <View key={`slot-${slot}`} style={styles.slotWrap}>
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
            <TimelineCard
              key={timeline[slot].id}
              card={timeline[slot]}
              isNew={timeline[slot].id === newCardId}
            />
          )}
        </View>
        );
      })}
    </ScrollView>
  );
}

export default function GameScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { state, dispatch } = useGame();
  const [playError, setPlayError] = useState<string | null>(null);

  const chipsEnabled = state.settings.chipsEnabled;
  const player: Player | undefined = state.players[state.currentPlayerIndex];
  const lastPlacement = state.lastPlacement;
  const isRevealed = !!lastPlacement;
  const shownCard: GameCard | null = lastPlacement?.card ?? state.currentCard;
  const concealed = state.settings.hideCoverUntilRevealed && !isRevealed;

  // --- Chip / steal local flow state (side-effects live here, not the reducer) ---
  const [localPhase, setLocalPhase] = useState<LocalPhase>('placing');
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const [stealerId, setStealerId] = useState<string | null>(null);
  const [chipAnswered, setChipAnswered] = useState(false);
  // The automatic final-card interstitial has run (guards against re-showing it
  // when this screen re-renders below the Victory route).
  const [finaleDone, setFinaleDone] = useState(false);
  // Absolute deadline (epoch ms) for the music timer of the current card, or
  // null when the timer setting is off / no card is playing.
  const [musicDeadline, setMusicDeadline] = useState<number | null>(null);
  const barAnim = useRef(new Animated.Value(1)).current;

  // Card feedback animation values.
  const cardScale = useRef(new Animated.Value(1)).current;
  const cardShake = useRef(new Animated.Value(0)).current;
  const cardOpacity = useRef(new Animated.Value(1)).current;
  const flashOpacity = useRef(new Animated.Value(0)).current;
  const brandtAnim = useRef(new Animated.Value(0)).current;

  const others = state.players.filter((_, i) => i !== state.currentPlayerIndex);
  const eligibleStealers = others.filter((p) => p.chips >= 1);
  const stealer = stealerId ? state.players.find((p) => p.id === stealerId) ?? null : null;

  // A playful line for the "both guessed wrong" reveal, stable per placement.
  const bothWrongMessage = useMemo(() => {
    const variants = [
      'Tja, das war wohl nix für beide! 🙈',
      'Daneben! Beide haben sich verzockt. 🎲',
      'Doppelt vorbei – die Karte fliegt raus! 😅',
    ];
    return variants[Math.floor(Math.random() * variants.length)];
  }, [lastPlacement]);

  // Start playback when a fresh card arrives (drawn during handoff).
  useEffect(() => {
    if (!state.currentCard || isRevealed) return;
    const card = state.currentCard;
    setPlayError(null);
    Spotify.playUri(card.trackUri)
      .then(() => Spotify.markTrackPlayed(card.id))
      .catch((e: any) => setPlayError(e?.message ?? String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentCard?.id]);

  // Reset per-card local + animation state whenever a new placing card appears
  // (also runs on reveal, when currentCard becomes null - harmless).
  useEffect(() => {
    setLocalPhase('placing');
    setPendingIndex(null);
    setStealerId(null);
    setChipAnswered(false);
    setFinaleDone(false);
    cardScale.setValue(1);
    cardShake.setValue(0);
    cardOpacity.setValue(1);
    flashOpacity.setValue(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentCard?.id]);

  // Run feedback animation when a placement result arrives.
  useEffect(() => {
    if (!lastPlacement) return;
    const kept = placementKept(lastPlacement);
    Animated.sequence([
      Animated.timing(flashOpacity, { toValue: 0.45, duration: 180, useNativeDriver: true }),
      Animated.timing(flashOpacity, { toValue: 0, duration: 420, useNativeDriver: true }),
    ]).start();
    if (kept) {
      Animated.sequence([
        Animated.spring(cardScale, { toValue: 1.08, friction: 4, tension: 140, useNativeDriver: true }),
        Animated.spring(cardScale, { toValue: 1, friction: 5, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.sequence([
        Animated.timing(cardShake, { toValue: 1, duration: 50, useNativeDriver: true }),
        Animated.timing(cardShake, { toValue: -1, duration: 50, useNativeDriver: true }),
        Animated.timing(cardShake, { toValue: 1, duration: 50, useNativeDriver: true }),
        Animated.timing(cardShake, { toValue: -1, duration: 50, useNativeDriver: true }),
        Animated.timing(cardShake, { toValue: 0, duration: 50, useNativeDriver: true }),
      ]).start();
      Animated.timing(cardOpacity, { toValue: 0.55, duration: 450, delay: 250, useNativeDriver: true }).start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastPlacement]);

  // Steal celebration: the marker pops in on a successful steal.
  useEffect(() => {
    if (lastPlacement?.steal?.result !== 'correct') return;
    brandtAnim.setValue(0);
    Animated.spring(brandtAnim, {
      toValue: 1,
      friction: 4,
      tension: 120,
      useNativeDriver: true,
    }).start();
  }, [lastPlacement, brandtAnim]);

  // Brief "no Hitster possible" notice, then reveal as normal.
  useEffect(() => {
    if (localPhase !== 'noStealNotice' || pendingIndex === null) return;
    const t = setTimeout(() => {
      dispatch({ type: 'PLACE_CARD', payload: { insertIndex: pendingIndex } });
    }, 1300);
    return () => clearTimeout(t);
  }, [localPhase, pendingIndex, dispatch]);

  // Music timer: hard-stop the song after timerSeconds (no fade - not cleanly
  // possible with the App Remote APIs). The player keeps guessing without music.
  // Keyed on the card id, so a SKIP (new card, new song) re-arms a fresh timer
  // and placement (currentCard -> null) disarms it.
  useEffect(() => {
    if (!state.settings.timerEnabled || !state.currentCard) {
      setMusicDeadline(null);
      return;
    }
    const ms = state.settings.timerSeconds * 1000;
    setMusicDeadline(Date.now() + ms);
    const t = setTimeout(() => Spotify.pause().catch(() => {}), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentCard?.id, state.settings.timerEnabled]);

  // Blind draw: the turn ends immediately (no reveal, no steal window, no chip
  // question) - stop the song and hand over to the next player. A blind draw can
  // never win (no score), so no winner handling is needed here.
  useEffect(() => {
    if (!lastPlacement?.blind || state.winner) return;
    Spotify.pause().catch(() => {});
    dispatch({ type: 'NEXT_PLAYER' });
    navigation.navigate('Handoff');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastPlacement]);

  // The 5s steal window timer (auto-reveal after grace). Side-effect, cleaned up.
  useEffect(() => {
    if (localPhase !== 'stealWindow' || pendingIndex === null) return;
    barAnim.setValue(1);
    const bar = Animated.timing(barAnim, {
      toValue: 0,
      duration: STEAL_WINDOW_MS,
      useNativeDriver: false,
    });
    bar.start();
    const reveal = setTimeout(() => {
      dispatch({ type: 'PLACE_CARD', payload: { insertIndex: pendingIndex } });
    }, STEAL_WINDOW_MS + STEAL_GRACE_MS);
    return () => {
      bar.stop();
      clearTimeout(reveal);
    };
  }, [localPhase, pendingIndex, barAnim, dispatch]);

  if (!player) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <Text style={styles.muted}>Kein aktives Spiel.</Text>
      </View>
    );
  }

  // Someone just won: run the automatic interstitial instead of the normal reveal
  // (covers both win paths - own placement sets winner in PLACE_CARD, a steal in
  // ATTEMPT_STEAL; the winner's timeline always contains the final card). It then
  // continues to the Victory route on its own, no tap needed.
  if (state.winner && lastPlacement && !finaleDone) {
    return (
      <FinalCardReveal
        card={lastPlacement.card}
        timeline={state.winner.timeline}
        ownerName={state.winner.name}
        onDone={() => {
          setFinaleDone(true);
          Spotify.pause().catch(() => {});
          navigation.navigate('Victory');
        }}
      />
    );
  }

  // --- Handlers ---
  const onPlace = (insertIndex: number) => {
    if (!chipsEnabled) {
      // No chip layer -> place immediately as before.
      dispatch({ type: 'PLACE_CARD', payload: { insertIndex } });
      return;
    }
    setPendingIndex(insertIndex);
    if (eligibleStealers.length === 0) {
      // Nobody can steal -> skip the 5s window, but show a brief notice first so
      // it's clear WHY there's no Hitster window (deliberate, not a missing step).
      setLocalPhase('noStealNotice');
      return;
    }
    setLocalPhase('stealWindow');
  };

  const onSkip = () => dispatch({ type: 'SKIP_CARD' });
  const onBlindDraw = () => dispatch({ type: 'BLIND_DRAW' });

  const onHitster = () => {
    if (eligibleStealers.length === 1) {
      setStealerId(eligibleStealers[0].id);
      setLocalPhase('stealPlace');
    } else {
      setLocalPhase('stealSelect');
    }
  };

  const onSelectStealer = (id: string) => {
    setStealerId(id);
    setLocalPhase('stealPlace');
  };

  const onStealPlace = (insertIndex: number) => {
    if (stealerId === null || pendingIndex === null) return;
    dispatch({
      type: 'ATTEMPT_STEAL',
      payload: { stealerId, stealerInsertIndex: insertIndex, activeInsertIndex: pendingIndex },
    });
  };

  const awardChip = () => {
    dispatch({ type: 'AWARD_CHIP', payload: { playerId: player.id } });
    setChipAnswered(true);
  };
  const denyChip = () => setChipAnswered(true);

  const handleNext = async () => {
    await Spotify.pause().catch(() => {});
    if (state.winner) {
      navigation.navigate('Victory'); // celebration first, then Result (stats)
      return;
    }
    dispatch({ type: 'NEXT_PLAYER' });
    navigation.navigate('Handoff');
  };

  // --- Reveal-derived values ---
  const steal = lastPlacement?.steal;
  const kept = lastPlacement ? placementKept(lastPlacement) : false;
  const activeGotCard =
    lastPlacement?.result === 'correct' && (!steal || steal.result !== 'correct');
  const newCardId = isRevealed && activeGotCard ? lastPlacement!.card.id : null;
  const stealerName = steal ? state.players.find((p) => p.id === steal.stealerId)?.name : undefined;

  let feedbackMsg = '';
  if (lastPlacement) {
    if (steal) {
      // steal.result === 'correct' is shown via the steal celebration block,
      // not this bar. Here we only handle the "steal missed" outcomes.
      if (steal.result === 'correct') {
        feedbackMsg = `🎯 ${stealerName} hat geklaut — richtig eingeordnet!`;
      } else if (steal.equalYear) {
        feedbackMsg = `🎵 Gleiches Jahr, beide Plätze richtig – die Karte bleibt bei ${player.name}!`;
      } else if (lastPlacement.result === 'correct') {
        feedbackMsg = `${player.name} hatte recht! Die Karte bleibt.`;
      } else {
        feedbackMsg = bothWrongMessage;
      }
    } else {
      feedbackMsg = kept ? '✓  RICHTIG — Karte bleibt' : '✕  FALSCH — Karte abgeworfen';
    }
  }

  const showChipQuestion =
    isRevealed && chipsEnabled && player.chips < MAX_CHIPS && !chipAnswered && !state.winner;

  const shakeX = cardShake.interpolate({ inputRange: [-1, 1], outputRange: [-10, 10] });
  const barWidth = barAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  const stealSuccess = steal?.result === 'correct';
  const brandtScale = brandtAnim.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] });
  const brandtRotate = brandtAnim.interpolate({ inputRange: [0, 1], outputRange: ['-16deg', '0deg'] });
  const brandtTranslateY = brandtAnim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]}>
      {/* Header */}
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={styles.activePlayer} numberOfLines={1}>
            {player.name}
          </Text>
          <Text style={styles.scoreLine}>
            {player.score} / {state.settings.cardsToWin} richtig platziert
          </Text>
        </View>
        <View style={styles.headerRight}>
          {chipsEnabled && (
            <View style={styles.chipPill}>
              <Text style={styles.chipPillText}>🪙 {player.chips}</Text>
            </View>
          )}
          <View style={styles.deckPill}>
            <Text style={styles.deckCount}>{state.deck.length}</Text>
            <Text style={styles.deckLabel}>im Deck</Text>
          </View>
        </View>
      </View>

      {/* Current track card */}
      {shownCard && (
        <Animated.View
          style={[styles.cardBox, { opacity: cardOpacity, transform: [{ translateX: shakeX }, { scale: cardScale }] }]}
        >
          {concealed ? (
            <View style={[styles.cover, styles.coverFallback]}>
              <Text style={styles.coverFallbackText}>💿</Text>
            </View>
          ) : shownCard.coverUrl ? (
            <Image source={{ uri: shownCard.coverUrl }} style={styles.cover} />
          ) : (
            <View style={[styles.cover, styles.coverFallback]}>
              <Text style={styles.coverFallbackText}>♫</Text>
            </View>
          )}
          <Text style={styles.cardTitle} numberOfLines={2}>
            {concealed ? '????' : shownCard.title}
          </Text>
          <Text style={styles.cardArtist} numberOfLines={1}>
            {concealed ? '????' : shownCard.artist}
          </Text>
          <FlipYear revealed={isRevealed} year={shownCard.year} />
          <Animated.View
            pointerEvents="none"
            style={[styles.flash, { opacity: flashOpacity, backgroundColor: kept ? COLORS.correct : COLORS.incorrect }]}
          />
        </Animated.View>
      )}

      {playError && <Text style={styles.error}>Playback: {playError}</Text>}

      {/* Music-timer countdown (shows only in the last 10s / after the stop) */}
      {musicDeadline != null && !isRevealed && <TurnCountdown deadlineMs={musicDeadline} />}

      {/* ---------- REVEALED ---------- */}
      {isRevealed && (
        <>
          {stealSuccess ? (
            <View style={styles.brandtBox}>
              <Animated.Text
                style={[
                  styles.brandtFlame,
                  {
                    opacity: brandtAnim,
                    transform: [
                      { translateY: brandtTranslateY },
                      { rotate: brandtRotate },
                      { scale: brandtScale },
                    ],
                  },
                ]}
              >
                🎯
              </Animated.Text>
              <Text style={styles.brandtText}>
                {stealerName} hat geklaut! 🎯
              </Text>
            </View>
          ) : (
            <View style={[styles.feedback, { backgroundColor: kept ? COLORS.correct : COLORS.incorrect }]}>
              <Text style={styles.feedbackText}>{feedbackMsg}</Text>
            </View>
          )}

          <Text style={styles.sectionLabel}>{player.name.toUpperCase()} — ZEITLINIE</Text>
          <TimelineStrip timeline={player.timeline} newCardId={newCardId} />

          {others.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>ANDERE SPIELER</Text>
              {others.map((p) => (
                <View key={p.id} style={styles.otherRow}>
                  <Text style={styles.otherName} numberOfLines={1}>
                    {p.name}
                  </Text>
                  <Text style={styles.otherInfo}>
                    {p.timeline.length} Karten · {yearRange(p.timeline)} · {p.score} Pkt.
                    {chipsEnabled ? ` · 🪙 ${p.chips}` : ''}
                  </Text>
                </View>
              ))}
            </>
          )}

          {showChipQuestion ? (
            <View style={styles.chipQ}>
              <Text style={styles.chipQTitle}>Titel und Interpret richtig erkannt?</Text>
              <View style={styles.chipQRow}>
                <PressableButton style={[styles.chipBtn, styles.chipYes]} onPress={awardChip}>
                  <Text style={styles.chipYesText}>Ja, Nickel verdient! 🪙</Text>
                </PressableButton>
                <PressableButton style={[styles.chipBtn, styles.chipNo]} onPress={denyChip}>
                  <Text style={styles.chipNoText}>Nein</Text>
                </PressableButton>
              </View>
            </View>
          ) : (
            <PressableButton style={styles.nextBtn} onPress={handleNext}>
              <Text style={styles.nextBtnText}>{state.winner ? 'ERGEBNIS ANSEHEN' : 'WEITER'}</Text>
            </PressableButton>
          )}
        </>
      )}

      {/* ---------- PLACING ---------- */}
      {!isRevealed && localPhase === 'placing' && (
        <>
          <Text style={styles.sectionLabel}>DEINE ZEITLINIE</Text>
          {state.currentCard ? (
            <TimelineStrip timeline={player.timeline} onInsert={onPlace} />
          ) : (
            <TimelineStrip timeline={player.timeline} />
          )}
          {state.currentCard && (
            <Text style={styles.hint}>Tippe ein „+", um den Track einzuordnen.</Text>
          )}
          {/* Nickel actions: skip / blind draw (settings-gated, need the chip
              layer). Both are locked at match point (score >= cardsToWin - 1):
              no Nickel assists on the potentially winning card. */}
          {state.currentCard && chipsEnabled && (state.settings.skipEnabled || state.settings.blindEnabled) && (() => {
            const matchPoint = player.score >= state.settings.cardsToWin - 1;
            const skipBlocked =
              player.chips < state.settings.skipCost || state.deck.length === 0 || matchPoint;
            const blindBlocked = player.chips < state.settings.blindCost || matchPoint;
            return (
              <View style={styles.turnActionsRow}>
                {state.settings.skipEnabled && (
                  <PressableButton
                    style={[styles.turnActionBtn, skipBlocked && styles.turnActionBtnDisabled]}
                    onPress={onSkip}
                    disabled={skipBlocked}
                  >
                    <Text style={styles.turnActionText}>
                      Überspringen · {state.settings.skipCost} 🪙
                    </Text>
                  </PressableButton>
                )}
                {state.settings.blindEnabled && (
                  <PressableButton
                    style={[styles.turnActionBtn, blindBlocked && styles.turnActionBtnDisabled]}
                    onPress={onBlindDraw}
                    disabled={blindBlocked}
                  >
                    <Text style={styles.turnActionText}>
                      Ohne Raten · {state.settings.blindCost} 🪙
                    </Text>
                  </PressableButton>
                )}
              </View>
            );
          })()}
        </>
      )}

      {/* ---------- STEAL WINDOW ---------- */}
      {!isRevealed && localPhase === 'stealWindow' && (
        <View style={styles.stealBox}>
          <Text style={styles.stealTitle}>Karte eingeordnet!</Text>
          <Text style={styles.stealSub}>
            Mitspieler mit 🪙 dürfen jetzt „Hitster!" rufen
          </Text>
          <View style={styles.barTrack}>
            <Animated.View style={[styles.barFill, { width: barWidth }]} />
          </View>
          <PressableButton style={styles.hitsterBtn} onPress={onHitster}>
            <Text style={styles.hitsterText}>HITSTER! 🎯</Text>
          </PressableButton>
          <Text style={styles.hint}>Sonst wird gleich automatisch aufgedeckt…</Text>
        </View>
      )}

      {/* ---------- NO-STEAL NOTICE (skip window, brief hint) ---------- */}
      {!isRevealed && localPhase === 'noStealNotice' && (
        <Text style={styles.noStealHint}>
          Kein Hitster möglich – niemand hat einen Nickel 🪙
        </Text>
      )}

      {/* ---------- STEAL SELECT ---------- */}
      {!isRevealed && localPhase === 'stealSelect' && (
        <View>
          <Text style={styles.sectionLabel}>WER RUFT „HITSTER!"?</Text>
          {eligibleStealers.map((p) => (
            <PressableButton key={p.id} style={styles.selectRow} onPress={() => onSelectStealer(p.id)}>
              <Text style={styles.selectName} numberOfLines={1}>
                {p.name}
              </Text>
              <Text style={styles.selectChips}>🪙 {p.chips}</Text>
            </PressableButton>
          ))}
        </View>
      )}

      {/* ---------- STEAL PLACE ---------- */}
      {!isRevealed && localPhase === 'stealPlace' && stealer && (
        <View>
          <Text style={styles.sectionLabel}>
            {stealer.name.toUpperCase()}: WO IN {player.name.toUpperCase()}S ZEITLINIE?
          </Text>
          <TimelineStrip
            timeline={player.timeline}
            onInsert={onStealPlace}
            isSlotEnabled={(i) => i !== pendingIndex}
          />
          <Text style={styles.hint}>
            Der bereits gewählte Slot ist gesperrt — rate selbst. 1 🪙 wird eingesetzt.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, paddingBottom: 48, gap: 12 },
  muted: { color: COLORS.textMuted, fontSize: 16 },

  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  // The active player IS the header in Hot-Seat (no combined roster during play),
  // so its container carries the same green neon glow used for the active player
  // in the Online list.
  headerLeft: {
    flex: 1,
    borderWidth: 2,
    borderColor: COLORS.correct,
    borderRadius: 14,
    paddingVertical: 6,
    paddingHorizontal: 12,
    ...glow(COLORS.correct, { radius: 12, opacity: 0.5 }),
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  activePlayer: {
    fontSize: 32,
    fontWeight: '900',
    color: COLORS.primary,
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 14,
  },
  scoreLine: { fontSize: 14, fontWeight: '700', color: COLORS.textMuted, marginTop: 2 },
  chipPill: {
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.accent,
    borderWidth: 2,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  chipPillText: { color: COLORS.accent, fontWeight: '900', fontSize: 16 },
  deckPill: {
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.border,
    borderWidth: 2,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: 'center',
    minWidth: 64,
  },
  deckCount: { color: COLORS.secondary, fontWeight: '900', fontSize: 22 },
  deckLabel: { color: COLORS.textMuted, fontWeight: '700', fontSize: 10, letterSpacing: 1 },

  cardBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 24,
    padding: 20,
    alignItems: 'center',
    gap: 6,
    borderWidth: 2,
    borderColor: COLORS.primary,
    overflow: 'hidden',
    ...glow(COLORS.primary, { radius: 20, opacity: 0.7 }),
  },
  flash: { ...StyleSheet.absoluteFillObject, borderRadius: 24 },
  cover: { width: 220, height: 220, borderRadius: 16, marginBottom: 10 },
  coverFallback: { backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },
  coverFallbackText: { fontSize: 72, color: COLORS.border },
  cardTitle: { fontSize: 24, fontWeight: '900', color: COLORS.text, textAlign: 'center' },
  cardArtist: { fontSize: 16, color: COLORS.textMuted, fontWeight: '600' },

  flipWrap: { height: 64, width: '100%', marginTop: 4, alignItems: 'center', justifyContent: 'center' },
  flipFace: { position: 'absolute', backfaceVisibility: 'hidden', textAlign: 'center' },
  cardYear: {
    fontSize: 52,
    fontWeight: '900',
    color: COLORS.accent,
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },
  cardYearHidden: { letterSpacing: 4 },

  error: { color: COLORS.incorrect, fontSize: 13, fontWeight: '700' },

  feedback: { borderRadius: 16, paddingVertical: 16, paddingHorizontal: 12 },
  feedbackText: { color: COLORS.background, fontWeight: '900', fontSize: 18, textAlign: 'center', letterSpacing: 0.5 },

  brandtBox: {
    alignItems: 'center',
    paddingVertical: 14,
    gap: 6,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: COLORS.accent,
    backgroundColor: COLORS.backgroundAlt,
  },
  brandtFlame: { fontSize: 64 },
  brandtText: {
    color: COLORS.accent,
    fontSize: 20,
    fontWeight: '900',
    textAlign: 'center',
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 16,
  },

  sectionLabel: { fontSize: 13, fontWeight: '800', color: COLORS.secondary, letterSpacing: 2, marginTop: 8 },

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
    ...glow(COLORS.secondary, { radius: 10, opacity: 0.8 }),
  },
  insertBtnDisabled: { backgroundColor: COLORS.border, opacity: 0.35, shadowOpacity: 0, elevation: 0 },
  insertText: { color: COLORS.background, fontSize: 30, fontWeight: '900' },
  insertSpacer: { width: 10 },
  timelineCard: {
    width: 112,
    height: 100,
    borderRadius: 16,
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 2,
    borderColor: COLORS.accent,
    padding: 10,
    justifyContent: 'center',
    ...glow(COLORS.accent, { radius: 14, opacity: 0.9 }),
  },
  timelineYear: {
    color: COLORS.accent,
    fontSize: 30,
    fontWeight: '900',
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  timelineTitle: { color: COLORS.textMuted, fontSize: 12, fontWeight: '600' },
  hint: { color: COLORS.textMuted, fontSize: 14, fontStyle: 'italic' },

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

  otherRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  otherName: { color: COLORS.text, fontWeight: '800', fontSize: 16, flexShrink: 1 },
  otherInfo: { color: COLORS.textMuted, fontSize: 13, fontWeight: '600' },

  // Steal window
  stealBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: COLORS.secondary,
    padding: 20,
    alignItems: 'center',
    gap: 10,
  },
  stealTitle: { color: COLORS.text, fontSize: 22, fontWeight: '900' },
  stealSub: { color: COLORS.textMuted, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  barTrack: {
    width: '100%',
    height: 12,
    borderRadius: 999,
    backgroundColor: COLORS.background,
    overflow: 'hidden',
    marginVertical: 4,
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
  noStealHint: {
    color: COLORS.textMuted,
    fontSize: 14,
    fontWeight: '600',
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: 8,
  },

  // Steal select
  selectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 56,
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: COLORS.primary,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  selectName: { color: COLORS.text, fontSize: 18, fontWeight: '800', flexShrink: 1 },
  selectChips: { color: COLORS.accent, fontSize: 16, fontWeight: '900' },

  // Chip question
  chipQ: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: COLORS.accent,
    padding: 16,
    gap: 12,
    marginTop: 8,
  },
  chipQTitle: { color: COLORS.text, fontSize: 18, fontWeight: '900', textAlign: 'center' },
  chipQRow: { flexDirection: 'row', gap: 12 },
  chipBtn: { flex: 1, minHeight: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  chipYes: {
    backgroundColor: COLORS.accent,
    ...glow(COLORS.accent, { radius: 12, opacity: 0.8 }),
  },
  chipYesText: { color: COLORS.background, fontSize: 15, fontWeight: '900', textAlign: 'center' },
  chipNo: { backgroundColor: COLORS.background, borderWidth: 2, borderColor: COLORS.border },
  chipNoText: { color: COLORS.textMuted, fontSize: 16, fontWeight: '800' },

  nextBtn: {
    marginTop: 20,
    minHeight: 60,
    backgroundColor: COLORS.accent,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    ...glow(COLORS.accent, { radius: 16, opacity: 0.8 }),
  },
  nextBtnText: { color: COLORS.background, fontSize: 20, fontWeight: '900', letterSpacing: 1 },
});
