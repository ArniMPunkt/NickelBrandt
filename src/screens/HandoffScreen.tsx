/**
 * HandoffScreen - pass-the-device gate.
 *
 * Shows whose turn is next and waits for "Bereit" before drawing + playing the
 * track. UI only - game logic unchanged.
 */
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useGame } from '../context/GameContext';
import { PressableButton } from '../components/PressableButton';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import type { GameStackParamList } from '../types/navigation';

type Nav = NativeStackNavigationProp<GameStackParamList, 'Handoff'>;

export default function HandoffScreen() {
  const navigation = useNavigation<Nav>();
  const { state, dispatch } = useGame();

  const player = state.players[state.currentPlayerIndex];
  const deckEmpty = state.deck.length === 0;

  // Gentle pulse on the "Bereit" button.
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1.06,
          duration: 750,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 750,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const ready = () => {
    dispatch({ type: 'DRAW_CARD' });
    navigation.navigate('Game');
  };

  const endGame = () => navigation.navigate('Result');

  if (!player) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <Text style={styles.muted}>Kein aktives Spiel.</Text>
      </View>
    );
  }

  if (deckEmpty) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <Text style={styles.endTitle}>Deck leer</Text>
        <Text style={styles.handoff}>Das Spiel ist zu Ende.</Text>
        <PressableButton style={styles.btn} onPress={endGame}>
          <Text style={styles.btnText}>ERGEBNIS ANSEHEN</Text>
        </PressableButton>
      </View>
    );
  }

  return (
    <View style={[styles.screen, styles.centered]}>
      <Text style={styles.sub}>WEITER ZU</Text>
      <Text style={styles.name} numberOfLines={2} adjustsFontSizeToFit>
        {player.name}
      </Text>
      <Text style={styles.handoff}>📱  Gerät weitergeben</Text>

      <Animated.View
        style={[styles.btnWrap, { transform: [{ scale: pulse }] }]}
      >
        <PressableButton style={styles.btn} onPress={ready}>
          <Text style={styles.btnText}>BEREIT</Text>
        </PressableButton>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  muted: { color: COLORS.textMuted, fontSize: 16 },

  sub: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 4,
  },
  name: {
    fontSize: 72,
    lineHeight: 78,
    fontWeight: '900',
    color: COLORS.primary,
    textAlign: 'center',
    marginVertical: 12,
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 24,
  },
  handoff: { fontSize: 18, color: COLORS.textMuted, marginTop: 4 },

  endTitle: {
    fontSize: 40,
    fontWeight: '900',
    color: COLORS.primary,
    textAlign: 'center',
    marginBottom: 8,
  },

  btnWrap: { marginTop: 48 },
  btn: {
    minHeight: 64,
    backgroundColor: COLORS.secondary,
    paddingVertical: 18,
    paddingHorizontal: 64,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    ...glow(COLORS.secondary, { radius: 20, opacity: 0.9 }),
  },
  btnText: {
    color: COLORS.background,
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 2,
  },
});
