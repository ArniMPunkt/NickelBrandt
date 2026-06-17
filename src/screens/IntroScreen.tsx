/**
 * IntroScreen - one animated "player reveal" card per player before the game
 * starts (Mario-Kart-style). Shows the player's name/avatar and the random
 * start card START_GAME already dealt them (revealed, since it stays visible in
 * their timeline). Auto-advances after a short delay, or tap to skip.
 *
 * UI only - reads players (and their timeline[0]) from state; no reducer logic.
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useGame } from '../context/GameContext';
import { COLORS } from '../theme/colors';
import type { GameStackParamList } from '../types/navigation';

type Nav = NativeStackNavigationProp<GameStackParamList, 'Intro'>;

const PLAYER_COLORS = [COLORS.primary, COLORS.secondary, COLORS.accent];
const PER_CARD_MS = 2300;
const CARD_DELAY_MS = 280;

export default function IntroScreen() {
  const navigation = useNavigation<Nav>();
  const { state } = useGame();
  const players = state.players;
  const [index, setIndex] = useState(0);

  const anim = useRef(new Animated.Value(0)).current;
  const cardAnim = useRef(new Animated.Value(0)).current;
  const player = players[index];
  const color = PLAYER_COLORS[index % PLAYER_COLORS.length];
  const startCard = player?.timeline[0];

  const advance = () => {
    if (index + 1 < players.length) setIndex(index + 1);
    else navigation.navigate('Handoff');
  };

  useEffect(() => {
    if (players.length === 0) {
      navigation.navigate('Handoff');
      return;
    }
    anim.setValue(0);
    cardAnim.setValue(0);
    const nameAnimation = Animated.spring(anim, {
      toValue: 1,
      friction: 6,
      tension: 60,
      useNativeDriver: true,
    });
    // Card enters slightly after the name so it doesn't all "explode" at once.
    const cardAnimation = Animated.spring(cardAnim, {
      toValue: 1,
      friction: 7,
      tension: 55,
      delay: CARD_DELAY_MS,
      useNativeDriver: true,
    });
    nameAnimation.start();
    cardAnimation.start();
    const timer = setTimeout(() => {
      if (index + 1 < players.length) setIndex(index + 1);
      else navigation.navigate('Handoff');
    }, PER_CARD_MS);
    return () => {
      clearTimeout(timer);
      nameAnimation.stop();
      cardAnimation.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, players.length]);

  if (!player) {
    return <View style={styles.screen} />;
  }

  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [60, 0] });
  const glowOpacity = anim.interpolate({
    inputRange: [0, 0.6, 1],
    outputRange: [0, 0.5, 0.9],
  });
  const cardScale = cardAnim.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] });
  const cardTranslateY = cardAnim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] });

  return (
    <Pressable style={styles.screen} onPress={advance}>
      <Text style={styles.counter}>
        SPIELER {index + 1} / {players.length}
      </Text>

      <Animated.View
        style={[styles.nameWrap, { opacity: anim, transform: [{ scale }, { translateY }] }]}
      >
        <Animated.View
          style={[styles.glow, { backgroundColor: color, opacity: glowOpacity }]}
        />
        <View style={[styles.badge, { borderColor: color }]}>
          <Text style={[styles.badgeText, { color }]}>
            {player.name.charAt(0).toUpperCase()}
          </Text>
        </View>
        <Text
          style={[styles.name, { color, textShadowColor: color }]}
          numberOfLines={2}
          adjustsFontSizeToFit
        >
          {player.name}
        </Text>
      </Animated.View>

      {startCard && (
        <Animated.View
          style={[
            styles.startCard,
            { borderColor: color, opacity: cardAnim, transform: [{ scale: cardScale }, { translateY: cardTranslateY }] },
          ]}
        >
          <Text style={styles.startLabel}>STARTKARTE</Text>
          {startCard.coverUrl ? (
            <Image source={{ uri: startCard.coverUrl }} style={styles.cover} />
          ) : (
            <View style={[styles.cover, styles.coverFallback]}>
              <Text style={styles.coverFallbackText}>♫</Text>
            </View>
          )}
          <Text style={styles.cardTitle} numberOfLines={1}>
            {startCard.title}
          </Text>
          <Text style={styles.cardArtist} numberOfLines={1}>
            {startCard.artist}
          </Text>
          <Text style={styles.cardYear}>{startCard.year}</Text>
        </Animated.View>
      )}

      <Text style={styles.hint}>Tippen zum Überspringen</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 20,
  },
  counter: {
    position: 'absolute',
    top: 56,
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.textMuted,
    letterSpacing: 3,
  },

  nameWrap: { alignItems: 'center', justifyContent: 'center' },
  glow: { position: 'absolute', width: 200, height: 200, borderRadius: 999 },
  badge: {
    width: 88,
    height: 88,
    borderRadius: 999,
    borderWidth: 4,
    backgroundColor: COLORS.backgroundAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  badgeText: { fontSize: 44, fontWeight: '900' },
  name: {
    fontSize: 44,
    lineHeight: 48,
    fontWeight: '900',
    textAlign: 'center',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 22,
  },

  startCard: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 20,
    borderWidth: 2,
    paddingVertical: 16,
    paddingHorizontal: 20,
    alignItems: 'center',
    gap: 4,
    width: '78%',
  },
  startLabel: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 3,
    color: COLORS.textMuted,
    marginBottom: 6,
  },
  cover: { width: 128, height: 128, borderRadius: 12, marginBottom: 6 },
  coverFallback: {
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverFallbackText: { fontSize: 48, color: COLORS.border },
  cardTitle: { fontSize: 16, fontWeight: '800', color: COLORS.text, textAlign: 'center' },
  cardArtist: { fontSize: 13, fontWeight: '600', color: COLORS.textMuted },
  cardYear: {
    fontSize: 30,
    fontWeight: '900',
    color: COLORS.accent,
    marginTop: 2,
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12,
  },

  hint: {
    position: 'absolute',
    bottom: 40,
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textMuted,
  },
});
