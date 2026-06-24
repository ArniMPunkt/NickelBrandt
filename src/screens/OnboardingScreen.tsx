/**
 * OnboardingScreen - a polished, one-time first-impression shown only on the very
 * first app launch (flag persisted in AsyncStorage). Three horizontally swipeable
 * slides in the app's neon-on-dark-purple style. Purely informational: it never
 * gates game logic.
 *
 * Paging: a native horizontal ScrollView with `pagingEnabled` (no extra native
 * dependency) gives the soft inertia + edge bounce the brief asks for. The only
 * animation is the active dot morphing its width with the scroll position - no
 * parallax, fades, or rotation.
 */
import { useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../theme/colors';

export const ONBOARDING_KEY = '@nickelbrandt/onboarding_seen';

type Slide = {
  accent: string;
  glyph: string;
  eyebrow: string;
  headline: string;
  /** Render the headline as the pink-glow "NickelBrandt" wordmark. */
  wordmark?: boolean;
  body: string;
};

const SLIDES: Slide[] = [
  {
    accent: COLORS.primary,
    glyph: '💿',
    eyebrow: 'SO GEHT’S',
    headline: 'NickelBrandt',
    wordmark: true,
    body:
      'Ein Song läuft – wann ist er erschienen? Ordne die Karte richtig in deine ' +
      'Zeitlinie ein, dann bleibt sie bei dir. Liegst du daneben, ist sie raus … ' +
      'außer ein Mitspieler ruft schnell genug „Hitster!" und schnappt sie sich.',
  },
  {
    accent: COLORS.secondary,
    glyph: '📱  📱',
    eyebrow: 'ZWEI MODI',
    headline: 'Zusammen spielen',
    body:
      'Hot-Seat: ein Gerät wandert von Hand zu Hand. Mit Freunden: jeder hat sein ' +
      'eigenes Handy – die Musik läuft bei einem von euch, der Rest spielt live mit.',
  },
  {
    accent: COLORS.secondary,
    glyph: '⚙️',
    eyebrow: 'MUSIK & MEHR',
    headline: 'Bereit?',
    body:
      'Verbinde Spotify und wähle eine Playlist oder einen fertigen Themen-Pool – ' +
      'schon kann’s losgehen. Spielregeln, Kartenanzahl und Extras findest du ' +
      'jederzeit unter „Einstellungen".',
  },
];

export default function OnboardingScreen({ onDone }: { onDone: () => void }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const scrollX = useRef(new Animated.Value(0)).current;
  const [page, setPage] = useState(0);
  const lastPage = SLIDES.length - 1;

  const finish = async () => {
    try {
      await AsyncStorage.setItem(ONBOARDING_KEY, '1');
    } catch {
      // If storage fails we still proceed; worst case the intro shows again.
    }
    onDone();
  };

  return (
    <View style={styles.screen}>
      {/* Skip (top-right) - hidden on the last slide where the CTA lives. */}
      {page < lastPage && (
        <Pressable
          style={[styles.skip, { top: insets.top + 8 }]}
          onPress={finish}
          hitSlop={12}
        >
          <Text style={styles.skipText}>Überspringen</Text>
        </Pressable>
      )}

      <Animated.ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
          useNativeDriver: false,
        })}
        scrollEventThrottle={16}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
      >
        {SLIDES.map((slide, i) => (
          <View
            key={i}
            style={[styles.slide, { width, paddingTop: insets.top + 56, paddingBottom: 180 }]}
          >
            <View
              style={[
                styles.glowCircle,
                { borderColor: slide.accent, shadowColor: slide.accent },
              ]}
            >
              <Text style={styles.glyph}>{slide.glyph}</Text>
            </View>

            <Text style={styles.eyebrow}>{slide.eyebrow}</Text>
            <Text
              style={[
                slide.wordmark ? styles.wordmark : styles.headline,
                !slide.wordmark && {
                  color: slide.accent,
                  textShadowColor: slide.accent,
                },
              ]}
              numberOfLines={2}
              adjustsFontSizeToFit
            >
              {slide.headline}
            </Text>
            <Text style={styles.body}>{slide.body}</Text>
          </View>
        ))}
      </Animated.ScrollView>

      {/* Fixed bottom bar: dots + CTA / swipe hint (reserved height = no jump). */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 20 }]}>
        <View style={styles.dots}>
          {SLIDES.map((_, i) => {
            const dotWidth = scrollX.interpolate({
              inputRange: [(i - 1) * width, i * width, (i + 1) * width],
              outputRange: [8, 24, 8],
              extrapolate: 'clamp',
            });
            return <Animated.View key={i} style={[styles.dot, { width: dotWidth }]} />;
          })}
        </View>

        <View style={styles.ctaSlot}>
          {page === lastPage ? (
            <Pressable style={styles.cta} onPress={finish}>
              <Text style={styles.ctaText}>LOS GEHT’S</Text>
            </Pressable>
          ) : (
            <Text style={styles.swipeHint}>Wische weiter →</Text>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },

  skip: { position: 'absolute', right: 16, zIndex: 10, padding: 8 },
  skipText: { color: COLORS.textMuted, fontSize: 14, fontWeight: '800' },

  slide: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, gap: 14 },

  glowCircle: {
    width: 148,
    height: 148,
    borderRadius: 999,
    borderWidth: 3,
    backgroundColor: COLORS.backgroundAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 26,
    elevation: 12,
  },
  glyph: { fontSize: 60 },

  eyebrow: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 3,
  },
  wordmark: {
    fontSize: 44,
    fontWeight: '900',
    color: COLORS.primary,
    textAlign: 'center',
    letterSpacing: 0.5,
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 20,
  },
  headline: {
    fontSize: 36,
    fontWeight: '900',
    textAlign: 'center',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },
  body: {
    color: COLORS.text,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 4,
    maxWidth: 420,
  },

  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', gap: 20 },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 8 },
  dot: { height: 8, borderRadius: 999, backgroundColor: COLORS.secondary },

  ctaSlot: { minHeight: 60, alignSelf: 'stretch', justifyContent: 'center', paddingHorizontal: 28 },
  cta: {
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
  ctaText: { color: COLORS.background, fontSize: 20, fontWeight: '900', letterSpacing: 1 },
  swipeHint: { color: COLORS.textMuted, fontSize: 14, fontWeight: '700', fontStyle: 'italic', textAlign: 'center' },
});
