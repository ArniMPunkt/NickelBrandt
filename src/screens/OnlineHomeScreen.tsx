/**
 * OnlineHomeScreen - entry point for the Online mode: create or join a lobby.
 * Separate from the Hot-Seat flow. No game logic yet (Etappe 1).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
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

export default function OnlineHomeScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Resume your lobby" suggestion, computed once at app start (initResumableLobby).
  const [resumable, setResumable] = useState<Lobby | null>(Online.getResumableLobby());
  // Spotify Web-API auth gates ONLY "Lobby erstellen" (the host needs Spotify);
  // joining a lobby does not. Re-checked on focus so connecting in the
  // Einstellungen tab and returning enables the button automatically.
  const [spotifyAuthorized, setSpotifyAuthorized] = useState(Spotify.isWebApiAuthorized());

  const configured = Online.isSupabaseConfigured();

  useFocusEffect(
    useCallback(() => {
      setSpotifyAuthorized(Spotify.isWebApiAuthorized());
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
    console.log(`[LobbyDebug] resume tapped code=${resumable.code} status=${resumable.status}`);
    if (resumable.status === 'playing') {
      navigation.navigate('OnlineGame', { lobbyId: resumable.id });
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
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 24 }]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Online spielen</Text>
      <Text style={styles.subtitle}>Erstelle eine Lobby oder tritt einer bei.</Text>

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

      <PressableButton
        style={[styles.createBtn, (!configured || busy || !spotifyAuthorized) && styles.disabled]}
        onPress={createLobby}
        disabled={!configured || !!busy || !spotifyAuthorized}
      >
        {busy === 'create' ? (
          <ActivityIndicator color={COLORS.background} />
        ) : (
          <Text style={styles.createBtnText}>Lobby erstellen</Text>
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

      <Text style={styles.label}>LOBBY-CODE</Text>
      <TextInput
        style={[styles.input, styles.codeInput]}
        placeholder="ABC123"
        placeholderTextColor={COLORS.textMuted}
        value={code}
        onChangeText={(v) => setCode(v.toUpperCase())}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={6}
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

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 24, gap: 12 },
  title: { fontSize: 34, fontWeight: '900', color: COLORS.primary },
  subtitle: { fontSize: 15, color: COLORS.textMuted, fontWeight: '600', marginBottom: 8 },

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
  codeInput: { letterSpacing: 6, fontSize: 24, textAlign: 'center', fontWeight: '900' },

  createBtn: {
    marginTop: 16,
    minHeight: 60,
    backgroundColor: COLORS.primary,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    ...glow(COLORS.primary, { radius: 14, opacity: 0.7 }),
  },
  createBtnText: { color: COLORS.text, fontSize: 18, fontWeight: '900' },
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

  joinBtn: {
    marginTop: 12,
    minHeight: 56,
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
