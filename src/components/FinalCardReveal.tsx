/**
 * FinalCardReveal - automatic interstitial between the winning placement and the
 * VictoryCelebration (shared by Hot-Seat and Online, like VictoryCelebration).
 *
 * Fixed-duration sequence, no tap required:
 *   1. the final card is revealed big (year flips ???? -> year)
 *   2. it hands over into its slot in the WINNER's timeline (auto-centered)
 *   3. the whole row pulses once left-to-right
 *   4. short hold, then onDone() (caller transitions to the victory screen)
 *
 * The timeline is frozen at mount: in Online the 'finished' phase can arrive
 * BEFORE the winner's timeline row update (closeHitsterWindow writes the phase
 * first), so the card is inserted locally (year-sorted) when it is missing.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { insertAt, sortedInsertIndex } from '../game/cards';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import type { GameCard } from '../types/game';

const FLIP_DELAY_MS = 300;
const FLIP_MS = 550;
const HANDOVER_MS = 600;
const SWEEP_STEP_MS = 90;
const SWEEP_PULSE_MS = 340;
const HOLD_MS = 500;

export function FinalCardReveal({
  card,
  timeline,
  ownerName,
  onDone,
}: {
  /** The winning (final) card. */
  card: GameCard;
  /** The winner's timeline; may still lack the final card (Online write race). */
  timeline: GameCard[];
  ownerName: string;
  onDone: () => void;
}) {
  // Freeze the display timeline at mount - the interstitial is a fixed cinematic
  // and must not reflow when a late realtime refresh delivers new props.
  const [cards] = useState<GameCard[]>(() =>
    timeline.some((c) => c.id === card.id)
      ? timeline
      : insertAt(timeline, card, sortedInsertIndex(timeline, card.year))
  );
  const newIndex = cards.findIndex((c) => c.id === card.id);

  const flip = useRef(new Animated.Value(0)).current;
  const bigOut = useRef(new Animated.Value(0)).current;
  const slotIn = useRef(new Animated.Value(0)).current;
  const sweep = useRef(cards.map(() => new Animated.Value(0))).current;

  // Center the final card's slot BEFORE the handover so it lands in view.
  const scrollRef = useRef<ScrollView>(null);
  const viewportW = useRef(0);
  const targetCenterX = useRef<number | null>(null);
  const centerOnTarget = () => {
    if (targetCenterX.current == null || viewportW.current === 0) return;
    const x = Math.max(0, targetCenterX.current - viewportW.current / 2);
    scrollRef.current?.scrollTo({ x, animated: false });
  };

  // One fixed cinematic per mount; cleanup stops everything so onDone can never
  // fire after the caller has already moved on.
  useEffect(() => {
    let doneTimer: ReturnType<typeof setTimeout> | null = null;
    const seq = Animated.sequence([
      Animated.timing(flip, {
        toValue: 1,
        duration: FLIP_MS,
        delay: FLIP_DELAY_MS,
        useNativeDriver: true,
      }),
      Animated.parallel([
        Animated.timing(bigOut, {
          toValue: 1,
          duration: HANDOVER_MS - 150,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(slotIn, {
          toValue: 1,
          duration: HANDOVER_MS,
          easing: Easing.out(Easing.back(1.6)),
          useNativeDriver: true,
        }),
      ]),
      Animated.stagger(
        SWEEP_STEP_MS,
        sweep.map((v) =>
          Animated.sequence([
            Animated.timing(v, {
              toValue: 1,
              duration: SWEEP_PULSE_MS / 2,
              useNativeDriver: true,
            }),
            Animated.timing(v, {
              toValue: 0,
              duration: SWEEP_PULSE_MS / 2,
              useNativeDriver: true,
            }),
          ])
        )
      ),
    ]);
    seq.start(({ finished }) => {
      if (finished) {
        doneTimer = setTimeout(onDone, HOLD_MS);
      }
    });
    return () => {
      seq.stop();
      if (doneTimer) clearTimeout(doneTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Big-card year flip faces.
  const frontRotate = flip.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  const backRotate = flip.interpolate({ inputRange: [0, 1], outputRange: ['180deg', '360deg'] });
  const frontOpacity = flip.interpolate({ inputRange: [0, 0.49, 0.5, 1], outputRange: [1, 1, 0, 0] });
  const backOpacity = flip.interpolate({ inputRange: [0, 0.5, 0.51, 1], outputRange: [0, 0, 1, 1] });

  // Big card hands over: fade + shrink toward the row.
  const bigOpacity = bigOut.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const bigScale = bigOut.interpolate({ inputRange: [0, 1], outputRange: [1, 0.6] });
  const bigTranslateY = bigOut.interpolate({ inputRange: [0, 1], outputRange: [0, 48] });

  // Slot card springs in.
  const slotScale = slotIn.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] });
  const slotTranslateY = slotIn.interpolate({ inputRange: [0, 1], outputRange: [-44, 0] });

  return (
    <View style={styles.screen}>
      <Text style={styles.headline}>LETZTE KARTE</Text>

      <Animated.View
        style={[
          styles.bigCard,
          { opacity: bigOpacity, transform: [{ translateY: bigTranslateY }, { scale: bigScale }] },
        ]}
      >
        {card.coverUrl ? (
          <Image source={{ uri: card.coverUrl }} style={styles.cover} />
        ) : (
          <View style={[styles.cover, styles.coverFallback]}>
            <Text style={styles.coverGlyph}>♫</Text>
          </View>
        )}
        <Text style={styles.bigTitle} numberOfLines={2}>
          {card.title}
        </Text>
        <Text style={styles.bigArtist} numberOfLines={1}>
          {card.artist}
        </Text>
        <View style={styles.flipWrap}>
          <Animated.Text
            style={[
              styles.bigYear,
              styles.flipFace,
              { opacity: frontOpacity, transform: [{ perspective: 800 }, { rotateY: frontRotate }] },
            ]}
          >
            ????
          </Animated.Text>
          <Animated.Text
            style={[
              styles.bigYear,
              styles.flipFace,
              { opacity: backOpacity, transform: [{ perspective: 800 }, { rotateY: backRotate }] },
            ]}
          >
            {card.year}
          </Animated.Text>
        </View>
      </Animated.View>

      <Text style={styles.sectionLabel}>ZEITLINIE VON {ownerName.toUpperCase()}</Text>
      <ScrollView
        ref={scrollRef}
        onLayout={(e) => {
          viewportW.current = e.nativeEvent.layout.width;
          centerOnTarget();
        }}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.timelineRow}
        scrollEnabled={false}
      >
        {cards.map((c, i) => {
          const isNew = i === newIndex;
          const pulseOpacity = sweep[i].interpolate({ inputRange: [0, 1], outputRange: [0, 0.45] });
          const pulseScale = sweep[i].interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] });
          return (
            <View
              key={c.id}
              style={styles.slotWrap}
              onLayout={
                isNew
                  ? (e) => {
                      targetCenterX.current =
                        e.nativeEvent.layout.x + e.nativeEvent.layout.width / 2;
                      centerOnTarget();
                    }
                  : undefined
              }
            >
              <Animated.View
                style={[
                  styles.tlCard,
                  isNew && styles.tlCardNew,
                  isNew
                    ? {
                        // Entry spring AND sweep pulse share the scale slot.
                        transform: [
                          { translateY: slotTranslateY },
                          { scale: Animated.multiply(slotScale, pulseScale) },
                        ],
                        opacity: slotIn,
                      }
                    : { transform: [{ scale: pulseScale }] },
                ]}
              >
                <Text style={[styles.tlYear, isNew && styles.tlYearNew]}>{c.year}</Text>
                <Text style={styles.tlTitle} numberOfLines={2}>
                  {c.title}
                </Text>
                <Animated.View
                  pointerEvents="none"
                  style={[styles.pulseOverlay, { opacity: pulseOpacity }]}
                />
              </Animated.View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    gap: 14,
  },
  headline: {
    fontSize: 15,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 4,
  },

  bigCard: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 24,
    padding: 18,
    alignItems: 'center',
    gap: 4,
    borderWidth: 2,
    borderColor: COLORS.primary,
    alignSelf: 'stretch',
    ...glow(COLORS.primary, { radius: 20, opacity: 0.7 }),
  },
  cover: { width: 150, height: 150, borderRadius: 14, marginBottom: 6 },
  coverFallback: { backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },
  coverGlyph: { fontSize: 52, color: COLORS.border },
  bigTitle: { fontSize: 20, fontWeight: '900', color: COLORS.text, textAlign: 'center' },
  bigArtist: { fontSize: 14, color: COLORS.textMuted, fontWeight: '600' },
  flipWrap: { height: 52, width: '100%', alignItems: 'center', justifyContent: 'center' },
  flipFace: { position: 'absolute', backfaceVisibility: 'hidden', textAlign: 'center' },
  bigYear: {
    fontSize: 42,
    fontWeight: '900',
    color: COLORS.accent,
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 16,
  },

  sectionLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 2,
    marginTop: 8,
    alignSelf: 'flex-start',
  },
  timelineRow: { alignItems: 'center', paddingVertical: 10 },
  slotWrap: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 5 },
  tlCard: {
    width: 112,
    height: 100,
    borderRadius: 16,
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 2,
    borderColor: COLORS.accent,
    padding: 10,
    justifyContent: 'center',
    overflow: 'hidden',
    ...glow(COLORS.accent, { radius: 12, opacity: 0.7 }),
  },
  tlCardNew: {
    borderColor: COLORS.primary,
    ...glow(COLORS.primary, { radius: 16, opacity: 0.9 }),
  },
  tlYear: { color: COLORS.accent, fontSize: 28, fontWeight: '900' },
  tlYearNew: { color: COLORS.primary },
  tlTitle: { color: COLORS.textMuted, fontSize: 12, fontWeight: '600' },
  pulseOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.accent,
    borderRadius: 14,
  },
});
