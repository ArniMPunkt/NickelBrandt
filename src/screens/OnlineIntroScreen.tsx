/**
 * OnlineIntroScreen - per-device "your start card" reveal shown once after
 * startGame, before the first OnlineGameScreen. Unlike the Hot-Seat IntroScreen
 * (which cycles through all players sequentially on one device), here each player
 * sees only THEIR OWN start card, in parallel on their own device. Auto-advances
 * after a few seconds, or tap to skip.
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Online from '../services/supabase';
import { COLORS } from '../theme/colors';
import type { OnlineStackParamList } from '../types/navigation';
import type { GameCard } from '../types/online';

type Nav = NativeStackNavigationProp<OnlineStackParamList, 'OnlineIntro'>;
type IntroRoute = RouteProp<OnlineStackParamList, 'OnlineIntro'>;

const DWELL_MS = 2600;
const CARD_DELAY_MS = 280;

export default function OnlineIntroScreen() {
  const navigation = useNavigation<Nav>();
  const { lobbyId } = useRoute<IntroRoute>().params;

  const [name, setName] = useState<string>('');
  const [card, setCard] = useState<GameCard | null>(null);

  const anim = useRef(new Animated.Value(0)).current;
  const cardAnim = useRef(new Animated.Value(0)).current;

  const goToGame = () => navigation.replace('OnlineGame', { lobbyId });

  // Load this device's own player + start card.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const players = await Online.getLobbyPlayers(lobbyId);
        const me = players.find((p) => p.player_id === Online.getPlayerId());
        if (cancelled) return;
        setName(me?.player_name ?? '');
        setCard(me?.timeline[0] ?? null);
      } catch {
        if (!cancelled) goToGame();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobbyId]);

  // Animate in + auto-advance once the card is loaded.
  useEffect(() => {
    if (!card) return;
    anim.setValue(0);
    cardAnim.setValue(0);
    const a = Animated.spring(anim, { toValue: 1, friction: 6, tension: 60, useNativeDriver: true });
    const c = Animated.spring(cardAnim, {
      toValue: 1,
      friction: 7,
      tension: 55,
      delay: CARD_DELAY_MS,
      useNativeDriver: true,
    });
    a.start();
    c.start();
    const timer = setTimeout(goToGame, DWELL_MS);
    return () => {
      clearTimeout(timer);
      a.stop();
      c.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card]);

  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] });
  const glowOpacity = anim.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0.5, 0.9] });
  const cardScale = cardAnim.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] });
  const cardTranslateY = cardAnim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] });

  return (
    <Pressable style={styles.screen} onPress={goToGame}>
      <Animated.View style={[styles.nameWrap, { opacity: anim, transform: [{ scale }, { translateY }] }]}>
        <Animated.View style={[styles.glow, { opacity: glowOpacity }]} />
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{(name || '?').charAt(0).toUpperCase()}</Text>
        </View>
        <Text style={styles.name} numberOfLines={2} adjustsFontSizeToFit>
          {name || 'Du'}
        </Text>
      </Animated.View>

      {card && (
        <Animated.View
          style={[
            styles.startCard,
            { opacity: cardAnim, transform: [{ scale: cardScale }, { translateY: cardTranslateY }] },
          ]}
        >
          <Text style={styles.startLabel}>DEINE STARTKARTE</Text>
          {card.coverUrl ? (
            <Image source={{ uri: card.coverUrl }} style={styles.cover} />
          ) : (
            <View style={[styles.cover, styles.coverFallback]}>
              <Text style={styles.coverGlyph}>♫</Text>
            </View>
          )}
          <Text style={styles.cardTitle} numberOfLines={1}>
            {card.title}
          </Text>
          <Text style={styles.cardArtist} numberOfLines={1}>
            {card.artist}
          </Text>
          <Text style={styles.cardYear}>{card.year}</Text>
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
  nameWrap: { alignItems: 'center', justifyContent: 'center' },
  glow: {
    position: 'absolute',
    width: 200,
    height: 200,
    borderRadius: 999,
    backgroundColor: COLORS.primary,
  },
  badge: {
    width: 88,
    height: 88,
    borderRadius: 999,
    borderWidth: 4,
    borderColor: COLORS.primary,
    backgroundColor: COLORS.backgroundAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  badgeText: { fontSize: 44, fontWeight: '900', color: COLORS.primary },
  name: {
    fontSize: 44,
    lineHeight: 48,
    fontWeight: '900',
    color: COLORS.primary,
    textAlign: 'center',
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 22,
  },

  startCard: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: COLORS.accent,
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
  coverFallback: { backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },
  coverGlyph: { fontSize: 48, color: COLORS.border },
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

  hint: { position: 'absolute', bottom: 40, fontSize: 14, fontWeight: '600', color: COLORS.textMuted },
});
