/**
 * GameScreen - the active player places the current track into their timeline.
 *
 * Two sub-states:
 *  - placing: track plays, year is hidden, [+] insert points are tappable.
 *  - reveal:  after PLACE_CARD, the year is shown with correct/incorrect feedback
 *             and a "Weiter" button to hand off to the next player.
 *
 * UI only - game logic unchanged.
 */
import { useEffect, useState } from 'react';
import {
  Image,
  Pressable,
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
import { COLORS } from '../theme/colors';
import type { GameCard, Player } from '../types/game';
import type { GameStackParamList } from '../types/navigation';

type Nav = NativeStackNavigationProp<GameStackParamList, 'Game'>;

function yearRange(timeline: GameCard[]): string {
  if (timeline.length === 0) return '-';
  const years = timeline.map((c) => c.year);
  const min = Math.min(...years);
  const max = Math.max(...years);
  return min === max ? `${min}` : `${min}–${max}`;
}

export default function GameScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { state, dispatch } = useGame();
  const [playError, setPlayError] = useState<string | null>(null);

  const player: Player | undefined = state.players[state.currentPlayerIndex];
  const lastPlacement = state.lastPlacement;
  const isRevealed = !!lastPlacement;
  const shownCard: GameCard | null = lastPlacement?.card ?? state.currentCard;
  const correct = lastPlacement?.result === 'correct';

  // Start playback when a fresh card arrives (drawn during handoff). The
  // previous player never reaches this screen with the new card, so they can't
  // hear it before handing the device over.
  useEffect(() => {
    if (!state.currentCard || isRevealed) return;
    const card = state.currentCard;
    setPlayError(null);
    Spotify.playUri(card.trackUri)
      .then(() => Spotify.markTrackPlayed(card.id))
      .catch((e: any) => setPlayError(e?.message ?? String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentCard?.id]);

  if (!player) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <Text style={styles.muted}>Kein aktives Spiel.</Text>
      </View>
    );
  }

  const place = (insertIndex: number) =>
    dispatch({ type: 'PLACE_CARD', payload: { insertIndex } });

  const handleNext = async () => {
    await Spotify.pause().catch(() => {});
    if (state.winner) {
      navigation.navigate('Result');
      return;
    }
    dispatch({ type: 'NEXT_PLAYER' });
    navigation.navigate('Handoff');
  };

  const others = state.players.filter((_, i) => i !== state.currentPlayerIndex);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]}
    >
      {/* Active player header */}
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={styles.activePlayer} numberOfLines={1}>
            {player.name}
          </Text>
          <Text style={styles.scoreLine}>
            {player.score} / {state.settings.cardsToWin} richtig platziert
          </Text>
        </View>
        <View style={styles.deckPill}>
          <Text style={styles.deckCount}>{state.deck.length}</Text>
          <Text style={styles.deckLabel}>im Deck</Text>
        </View>
      </View>

      {/* Current track card */}
      {shownCard && (
        <View style={styles.cardBox}>
          {shownCard.coverUrl ? (
            <Image source={{ uri: shownCard.coverUrl }} style={styles.cover} />
          ) : (
            <View style={[styles.cover, styles.coverFallback]}>
              <Text style={styles.coverFallbackText}>♫</Text>
            </View>
          )}
          <Text style={styles.cardTitle} numberOfLines={2}>
            {shownCard.title}
          </Text>
          <Text style={styles.cardArtist} numberOfLines={1}>
            {shownCard.artist}
          </Text>
          <Text style={[styles.cardYear, !isRevealed && styles.cardYearHidden]}>
            {isRevealed ? shownCard.year : '????'}
          </Text>
        </View>
      )}

      {playError && <Text style={styles.error}>Playback: {playError}</Text>}

      {/* Reveal feedback */}
      {isRevealed && (
        <View
          style={[
            styles.feedback,
            { backgroundColor: correct ? COLORS.correct : COLORS.incorrect },
          ]}
        >
          <Text style={styles.feedbackText}>
            {correct
              ? '✓  RICHTIG — Karte bleibt'
              : '✕  FALSCH — Karte abgeworfen'}
          </Text>
        </View>
      )}

      {/* Active player's timeline with insert points */}
      <Text style={styles.sectionLabel}>DEINE ZEITLINIE</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.timelineRow}
      >
        {Array.from({ length: player.timeline.length + 1 }).map((_, slot) => (
          <View key={`slot-${slot}`} style={styles.slotWrap}>
            {!isRevealed && state.currentCard ? (
              <Pressable style={styles.insertBtn} onPress={() => place(slot)}>
                <Text style={styles.insertText}>+</Text>
              </Pressable>
            ) : (
              <View style={styles.insertSpacer} />
            )}
            {slot < player.timeline.length && (
              <View style={styles.timelineCard}>
                <Text style={styles.timelineYear}>
                  {player.timeline[slot].year}
                </Text>
                <Text style={styles.timelineTitle} numberOfLines={2}>
                  {player.timeline[slot].title}
                </Text>
              </View>
            )}
          </View>
        ))}
      </ScrollView>

      {!isRevealed && state.currentCard && (
        <Text style={styles.hint}>Tippe ein „+", um den Track einzuordnen.</Text>
      )}

      {/* Other players (compact) */}
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
              </Text>
            </View>
          ))}
        </>
      )}

      {isRevealed && (
        <Pressable style={styles.nextBtn} onPress={handleNext}>
          <Text style={styles.nextBtnText}>
            {state.winner ? 'ERGEBNIS ANSEHEN' : 'WEITER'}
          </Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, paddingBottom: 48, gap: 12 },
  muted: { color: COLORS.textMuted, fontSize: 16 },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerLeft: { flex: 1 },
  activePlayer: {
    fontSize: 32,
    fontWeight: '900',
    color: COLORS.primary,
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 14,
  },
  scoreLine: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.textMuted,
    marginTop: 2,
  },
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
  deckLabel: {
    color: COLORS.textMuted,
    fontWeight: '700',
    fontSize: 10,
    letterSpacing: 1,
  },

  cardBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 24,
    padding: 20,
    alignItems: 'center',
    gap: 6,
    borderWidth: 2,
    borderColor: COLORS.primary,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 20,
    elevation: 10,
  },
  cover: { width: 220, height: 220, borderRadius: 16, marginBottom: 10 },
  coverFallback: {
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverFallbackText: { fontSize: 72, color: COLORS.border },
  cardTitle: {
    fontSize: 24,
    fontWeight: '900',
    color: COLORS.text,
    textAlign: 'center',
  },
  cardArtist: { fontSize: 16, color: COLORS.textMuted, fontWeight: '600' },
  cardYear: {
    fontSize: 52,
    fontWeight: '900',
    color: COLORS.accent,
    marginTop: 4,
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },
  cardYearHidden: { letterSpacing: 4 },

  error: { color: COLORS.incorrect, fontSize: 13, fontWeight: '700' },

  feedback: {
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 12,
  },
  feedbackText: {
    color: COLORS.background,
    fontWeight: '900',
    fontSize: 18,
    textAlign: 'center',
    letterSpacing: 1,
  },

  sectionLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 2,
    marginTop: 8,
  },

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
    shadowColor: COLORS.secondary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 10,
    elevation: 6,
  },
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
    // Stronger accent glow on timeline cards.
    shadowColor: COLORS.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 14,
    elevation: 10,
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

  nextBtn: {
    marginTop: 20,
    minHeight: 60,
    backgroundColor: COLORS.accent,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 16,
    elevation: 10,
  },
  nextBtnText: {
    color: COLORS.background,
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 1,
  },
});
