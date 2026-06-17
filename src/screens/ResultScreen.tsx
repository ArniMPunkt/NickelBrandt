/**
 * ResultScreen - winner + all timelines, then start a new game.
 *
 * UI only - game logic unchanged.
 */
import { useEffect, useRef } from 'react';
import {
  Animated,
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
import type { GameStackParamList } from '../types/navigation';

type Nav = NativeStackNavigationProp<GameStackParamList, 'Result'>;

const CONFETTI_COLORS = [
  COLORS.primary,
  COLORS.secondary,
  COLORS.accent,
  COLORS.correct,
];

/** Lightweight confetti: colored dots that fall + fade on a loop. */
function Confetti() {
  const dots = useRef(
    Array.from({ length: 16 }).map((_, i) => ({
      anim: new Animated.Value(0),
      left: `${Math.round((i / 16) * 100)}%`,
      delay: Math.round(Math.random() * 2000),
      duration: 2200 + Math.round(Math.random() * 1500),
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      size: 8 + Math.round(Math.random() * 8),
    }))
  ).current;

  useEffect(() => {
    const loops = dots.map((d) =>
      Animated.loop(
        Animated.timing(d.anim, {
          toValue: 1,
          duration: d.duration,
          delay: d.delay,
          useNativeDriver: true,
        })
      )
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [dots]);

  return (
    <View pointerEvents="none" style={styles.confettiLayer}>
      {dots.map((d, i) => {
        const translateY = d.anim.interpolate({
          inputRange: [0, 1],
          outputRange: [-20, 240],
        });
        const opacity = d.anim.interpolate({
          inputRange: [0, 0.1, 0.85, 1],
          outputRange: [0, 1, 1, 0],
        });
        return (
          <Animated.View
            key={i}
            style={[
              styles.confettiDot,
              {
                left: d.left as `${number}%`,
                width: d.size,
                height: d.size,
                backgroundColor: d.color,
                opacity,
                transform: [{ translateY }],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

export default function ResultScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { state, dispatch } = useGame();

  // Winner is set when someone reaches the target; otherwise (deck ran out) fall
  // back to the highest score as the leader.
  const leader =
    state.winner ??
    [...state.players].sort((a, b) => b.score - a.score)[0] ??
    null;

  const newGame = async () => {
    await Spotify.pause().catch(() => {});
    dispatch({ type: 'RESET' });
    navigation.navigate('Setup');
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 8 }]}
    >
      <View style={styles.hero}>
        <Confetti />
        <Text style={styles.trophy}>🏆</Text>
        <Text style={styles.label}>
          {state.winner ? 'GEWINNER' : 'SPITZENREITER'}
        </Text>
        <Text style={styles.winner} numberOfLines={2} adjustsFontSizeToFit>
          {leader ? leader.name : '-'}
        </Text>
        {leader && (
          <Text style={styles.winnerScore}>
            {leader.score} Karten korrekt platziert
          </Text>
        )}
      </View>

      <Text style={styles.sectionLabel}>ZEITLINIEN</Text>
      {state.players.map((p) => {
        const isWinner = leader?.id === p.id;
        return (
          <View
            key={p.id}
            style={[styles.playerBox, isWinner && styles.playerBoxWinner]}
          >
            <View style={styles.playerHeader}>
              <Text style={styles.playerName} numberOfLines={1}>
                {isWinner ? '👑 ' : ''}
                {p.name}
              </Text>
              <Text style={styles.playerScore}>{p.score} Pkt.</Text>
            </View>
            <Text style={styles.timeline}>
              {p.timeline.map((c) => c.year).join('   ·   ')}
            </Text>
          </View>
        );
      })}

      <Pressable style={styles.btn} onPress={newGame}>
        <Text style={styles.btnText}>NEUES SPIEL</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 20, paddingBottom: 48, gap: 10 },

  hero: {
    alignItems: 'center',
    paddingTop: 24,
    paddingBottom: 16,
    overflow: 'hidden',
  },
  confettiLayer: {
    ...StyleSheet.absoluteFillObject,
    height: 240,
  },
  confettiDot: {
    position: 'absolute',
    top: 0,
    borderRadius: 999,
  },
  trophy: { fontSize: 72, marginBottom: 4 },
  label: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 4,
  },
  winner: {
    fontSize: 56,
    lineHeight: 60,
    fontWeight: '900',
    color: COLORS.primary,
    textAlign: 'center',
    marginTop: 4,
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 22,
  },
  winnerScore: {
    fontSize: 15,
    color: COLORS.textMuted,
    fontWeight: '600',
    marginTop: 6,
  },

  sectionLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 2,
    marginTop: 12,
  },

  playerBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 16,
    padding: 14,
    borderWidth: 2,
    borderColor: COLORS.border,
  },
  playerBoxWinner: {
    borderColor: COLORS.accent,
    shadowColor: COLORS.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 12,
    elevation: 6,
  },
  playerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  playerName: { color: COLORS.text, fontWeight: '900', fontSize: 18, flexShrink: 1 },
  playerScore: { color: COLORS.primary, fontWeight: '900', fontSize: 15 },
  timeline: { color: COLORS.textMuted, fontSize: 14, fontWeight: '600' },

  btn: {
    marginTop: 28,
    minHeight: 60,
    backgroundColor: COLORS.secondary,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.secondary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 16,
    elevation: 10,
  },
  btnText: {
    color: COLORS.background,
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 1,
  },
});
