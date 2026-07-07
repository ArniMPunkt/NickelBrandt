/**
 * OnlineHomeScreen - home of the "Party" mode (the app's MAIN mode): create or
 * join a lobby. Carries the big NickelBrandt headline (moved here from the
 * Hot-Seat setup) plus a subtle looping equalizer so the screen feels like the
 * flagship entry of the app, not a form. Functionality is unchanged: name,
 * create (Spotify-gated), join via code, resume banner.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Online from '../services/supabase';
import * as Spotify from '../services/spotify';
import { PressableButton } from '../components/PressableButton';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import type { OnlineStackParamList } from '../types/navigation';
import type { Lobby } from '../types/online';

type Nav = NativeStackNavigationProp<OnlineStackParamList, 'OnlineHome'>;

// Client-side convenience only (not an account): remember the last name the
// player actually used, so they don't retype it every game. Same AsyncStorage
// approach as the onboarding flag.
const PLAYER_NAME_KEY = '@nickelbrandt/player_name';

const EQ_COLORS = [
  COLORS.primary,
  COLORS.secondary,
  COLORS.accent,
  COLORS.primary,
  COLORS.secondary,
  COLORS.accent,
  COLORS.primary,
];

/**
 * Subtle looping equalizer under the headline ("hier läuft Musik"). Pure
 * scaleY transforms on the native driver; per-bar durations are slightly
 * different so the phases drift and the motion stays organic, not metronomic.
 */
function EqualizerBars() {
  const bars = useRef(EQ_COLORS.map(() => new Animated.Value(0.3))).current;

  useEffect(() => {
    const loops = bars.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, {
            toValue: 1,
            duration: 380 + ((i * 97) % 220),
            useNativeDriver: true,
          }),
          Animated.timing(v, {
            toValue: 0.25,
            duration: 340 + ((i * 61) % 180),
            useNativeDriver: true,
          }),
        ])
      )
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.eqRow}>
      {bars.map((v, i) => (
        <Animated.View
          key={`bar-${i}`}
          style={[
            styles.eqBar,
            { backgroundColor: EQ_COLORS[i], transform: [{ scaleY: v }] },
          ]}
        />
      ))}
    </View>
  );
}

export default function OnlineHomeScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Resume your lobby" suggestion, computed once at app start (initResumableLobby).
  const [resumable, setResumable] = useState<Lobby | null>(Online.getResumableLobby());
  // Spotify gates ONLY "Lobby erstellen" (the host needs Spotify); joining a
  // lobby does not. Gated on the FULL readiness (Web-API token AND a confirmed
  // App-Remote connection), not just the web authorization: on a failed connect
  // the PKCE web step may have succeeded while the app-to-app connection was
  // refused - the button must stay locked then. Re-checked on focus so
  // connecting in the Einstellungen tab and returning enables it automatically.
  const [spotifyAuthorized, setSpotifyAuthorized] = useState(Spotify.isReadyToPlay());

  const configured = Online.isSupabaseConfigured();

  useFocusEffect(
    useCallback(() => {
      setSpotifyAuthorized(Spotify.isReadyToPlay());
      // Between-games heal: the App Remote routinely drops after a finished
      // Partie (idle unbind / background teardown). Probe + silently reconnect
      // so the screen doesn't demand a manual reconnect; no-op if never
      // connected, never an interactive app switch.
      Spotify.ensureReadyToPlay()
        .then((ready) => setSpotifyAuthorized(ready))
        .catch(() => {});
    }, [])
  );

  // Keep in sync with the service holder (it may resolve after first render, and
  // gets cleared on leave/end).
  useEffect(() => {
    const unsub = Online.subscribeResumableLobby(() => setResumable(Online.getResumableLobby()));
    setResumable(Online.getResumableLobby());
    return unsub;
  }, []);

  // Prefill the name field once on first mount with the last-used name (empty on
  // first ever visit). Mount-only so it never clobbers what the user is typing.
  useEffect(() => {
    AsyncStorage.getItem(PLAYER_NAME_KEY)
      .then((saved) => {
        if (saved) setName(saved);
      })
      .catch(() => {});
  }, []);

  // Persist the name only after a lobby is actually created/joined (not on every
  // keystroke): that's the moment it's confirmed valid + intentionally used, and
  // it keeps storage writes to one per game instead of one per character.
  const persistName = (playerName: string) => {
    AsyncStorage.setItem(PLAYER_NAME_KEY, playerName).catch(() => {});
  };

  const resumeLobby = () => {
    if (!resumable) return;
    if (resumable.status === 'playing') {
      // Route by mode - the simultaneous modes resume into their own screens.
      const mode = resumable.game_mode ?? 'hitster';
      if (mode === 'bingo') {
        navigation.navigate('BingoGame', { lobbyId: resumable.id });
      } else if (mode === 'timeline_quiz') {
        navigation.navigate('TimelineQuiz', { lobbyId: resumable.id });
      } else {
        navigation.navigate('OnlineGame', { lobbyId: resumable.id });
      }
    } else {
      navigation.navigate('Lobby', { lobbyId: resumable.id, code: resumable.code });
    }
  };

  const ignoreResume = () => {
    Online.dismissResumableLobby();
  };

  const requireName = (): string | null => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Bitte einen Namen eingeben.');
      return null;
    }
    return trimmed;
  };

  const createLobby = async () => {
    setError(null);
    const playerName = requireName();
    if (!playerName) return;
    setBusy('create');
    try {
      const lobby = await Online.createLobby(playerName);
      persistName(playerName);
      navigation.navigate('Lobby', { lobbyId: lobby.id, code: lobby.code });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const joinLobby = async () => {
    setError(null);
    const playerName = requireName();
    if (!playerName) return;
    if (!code.trim()) {
      setError('Bitte einen Lobby-Code eingeben.');
      return;
    }
    setBusy('join');
    try {
      const lobby = await Online.joinLobby(playerName, code);
      persistName(playerName);
      navigation.navigate('Lobby', { lobbyId: lobby.id, code: lobby.code });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    // Keyboard handling: the code input sits in the bottom third, so the
    // keyboard covered it. The KAV shrinks/pads the scroll area ('padding' on
    // iOS, 'height' on Android per RN recommendation) and the code input
    // additionally scrolls itself into view on focus - the KAV alone only
    // makes room, it never scrolls.
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
    <ScrollView
      ref={scrollRef}
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 24 }]}
      keyboardShouldPersistTaps="handled"
    >
      {/* Hero: the app headline lives here now - Party is the main mode. */}
      <View style={styles.hero}>
        <EqualizerBars />
        <Text style={styles.title}>NickelBrandt</Text>
        <Text style={styles.tagline}>● MUSIC-PARTY MIT FREUNDEN ●</Text>
      </View>

      {resumable && (
        <View style={styles.resumeBox}>
          <Text style={styles.resumeLabel}>DU WARST IN EINER LOBBY</Text>
          <PressableButton style={styles.resumeBtn} onPress={resumeLobby}>
            <Text style={styles.resumeBtnText}>
              {resumable.status === 'playing' ? '▶ Zurück ins Spiel' : '↩ Zurück zur Lobby'}{' '}
              {resumable.code}
            </Text>
          </PressableButton>
          <PressableButton onPress={ignoreResume} hitSlop={8}>
            <Text style={styles.resumeIgnore}>Ignorieren</Text>
          </PressableButton>
        </View>
      )}

      {!configured && (
        <View style={styles.warnBox}>
          <Text style={styles.warnText}>
            Supabase ist nicht konfiguriert. Trage EXPO_PUBLIC_SUPABASE_URL und
            EXPO_PUBLIC_SUPABASE_ANON_KEY in .env ein und starte Metro mit „-c" neu.
          </Text>
        </View>
      )}

      <Text style={styles.label}>DEIN NAME</Text>
      <TextInput
        style={styles.input}
        placeholder="Name"
        placeholderTextColor={COLORS.textMuted}
        value={name}
        onChangeText={setName}
        maxLength={20}
      />

      {/* Hero action: creating the party gets the visual weight. */}
      <PressableButton
        style={[styles.createBtn, (!configured || busy || !spotifyAuthorized) && styles.disabled]}
        onPress={createLobby}
        disabled={!configured || !!busy || !spotifyAuthorized}
      >
        {busy === 'create' ? (
          <ActivityIndicator color={COLORS.text} />
        ) : (
          <>
            <Text style={styles.createBtnText}>🎉  Party starten</Text>
            <Text style={styles.createBtnSub}>Lobby erstellen — du bist Host, deine Musik läuft</Text>
          </>
        )}
      </PressableButton>
      {configured && !spotifyAuthorized && (
        <Text style={styles.spotifyGateHint}>
          Zum Erstellen zuerst mit Spotify verbinden (siehe Tab „Einstellungen"). Zum
          Beitreten ist das nicht nötig.
        </Text>
      )}

      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>ODER</Text>
        <View style={styles.dividerLine} />
      </View>

      {/* Join card: secondary weight, own surface. */}
      <View style={styles.joinCard}>
        <Text style={styles.joinCardLabel}>PARTY BEITRETEN</Text>
        <Text style={styles.joinCardHint}>Gib den Code vom Host ein:</Text>
        <TextInput
          style={[styles.input, styles.codeInput]}
          placeholder="ABC123"
          placeholderTextColor={COLORS.textMuted}
          value={code}
          onChangeText={(v) => setCode(v.toUpperCase())}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={6}
          onFocus={() => {
            // Delay until the KAV has made room, then bring the join card
            // (input + button, the end of the content) above the keyboard.
            setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
          }}
        />
        <PressableButton
          style={[styles.joinBtn, (!configured || busy) && styles.disabled]}
          onPress={joinLobby}
          disabled={!configured || !!busy}
        >
          {busy === 'join' ? (
            <ActivityIndicator color={COLORS.text} />
          ) : (
            <Text style={styles.joinBtnText}>Lobby beitreten</Text>
          )}
        </PressableButton>
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 24, gap: 12 },

  hero: { alignItems: 'center', marginTop: 4, marginBottom: 8, gap: 4 },
  eqRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 34,
    marginBottom: 6,
  },
  eqBar: { width: 7, height: 30, borderRadius: 4 },
  title: {
    fontSize: 46,
    fontWeight: '900',
    color: COLORS.primary,
    letterSpacing: 0.5,
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },
  tagline: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 3,
  },

  warnBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.accent,
    borderWidth: 2,
    borderRadius: 14,
    padding: 14,
  },
  warnText: { color: COLORS.accent, fontSize: 13, fontWeight: '700' },

  resumeBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.secondary,
    borderWidth: 2,
    borderRadius: 16,
    padding: 14,
    gap: 10,
    marginTop: 4,
    ...glow(COLORS.secondary, { radius: 12, opacity: 0.5 }),
  },
  resumeLabel: { color: COLORS.secondary, fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  resumeBtn: {
    minHeight: 52,
    backgroundColor: COLORS.secondary,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  resumeBtnText: { color: COLORS.background, fontSize: 17, fontWeight: '900', letterSpacing: 1 },
  resumeIgnore: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
    textDecorationLine: 'underline',
  },

  label: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 2,
    marginTop: 12,
  },
  input: {
    minHeight: 52,
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.border,
    borderWidth: 2,
    borderRadius: 14,
    paddingHorizontal: 16,
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700',
  },
  codeInput: {
    letterSpacing: 6,
    fontSize: 24,
    textAlign: 'center',
    fontWeight: '900',
    // Sits inside the joinCard (backgroundAlt), so it needs the darker bg.
    backgroundColor: COLORS.background,
  },

  createBtn: {
    marginTop: 16,
    minHeight: 76,
    backgroundColor: COLORS.primary,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 16,
    ...glow(COLORS.primary, { radius: 18, opacity: 0.85 }),
  },
  createBtnText: { color: COLORS.text, fontSize: 21, fontWeight: '900', letterSpacing: 0.5 },
  createBtnSub: { color: COLORS.text, fontSize: 12, fontWeight: '700', opacity: 0.85 },
  spotifyGateHint: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: '700',
    fontStyle: 'italic',
    marginTop: 8,
  },

  divider: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 12 },
  dividerLine: { flex: 1, height: 2, backgroundColor: COLORS.border, borderRadius: 2 },
  dividerText: { color: COLORS.textMuted, fontWeight: '800', fontSize: 13, letterSpacing: 2 },

  joinCard: {
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
    gap: 10,
  },
  joinCardLabel: { color: COLORS.secondary, fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  joinCardHint: { color: COLORS.textMuted, fontSize: 13, fontWeight: '600' },
  joinBtn: {
    minHeight: 54,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: COLORS.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  joinBtnText: { color: COLORS.secondary, fontSize: 17, fontWeight: '900' },

  disabled: { opacity: 0.5 },

  errorBox: {
    marginTop: 12,
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.incorrect,
    borderWidth: 2,
    borderRadius: 14,
    padding: 14,
  },
  errorText: { color: COLORS.incorrect, fontSize: 14, fontWeight: '700' },
});
