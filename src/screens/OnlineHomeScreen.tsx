/**
 * OnlineHomeScreen - entry point for the Online mode: create or join a lobby.
 * Separate from the Hot-Seat flow. No game logic yet (Etappe 1).
 */
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Online from '../services/supabase';
import { COLORS } from '../theme/colors';
import type { OnlineStackParamList } from '../types/navigation';

type Nav = NativeStackNavigationProp<OnlineStackParamList, 'OnlineHome'>;

export default function OnlineHomeScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const configured = Online.isSupabaseConfigured();

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

      <Pressable
        style={[styles.createBtn, (!configured || busy) && styles.disabled]}
        onPress={createLobby}
        disabled={!configured || !!busy}
      >
        {busy === 'create' ? (
          <ActivityIndicator color={COLORS.background} />
        ) : (
          <Text style={styles.createBtnText}>Lobby erstellen</Text>
        )}
      </Pressable>

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
      <Pressable
        style={[styles.joinBtn, (!configured || busy) && styles.disabled]}
        onPress={joinLobby}
        disabled={!configured || !!busy}
      >
        {busy === 'join' ? (
          <ActivityIndicator color={COLORS.text} />
        ) : (
          <Text style={styles.joinBtnText}>Lobby beitreten</Text>
        )}
      </Pressable>

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
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 14,
    elevation: 8,
  },
  createBtnText: { color: COLORS.text, fontSize: 18, fontWeight: '900' },

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
