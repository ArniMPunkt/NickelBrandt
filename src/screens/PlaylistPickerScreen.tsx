/**
 * PlaylistPicker - a modal to choose the game's song source: either a connected
 * Spotify playlist OR a pre-made themed song pool (segmented control at the top).
 * Returns a DeckSource. Used by both Hot-Seat (SetupScreen) and Online (LobbyScreen).
 * Client-side name search; loading / error / empty states per mode.
 */
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import * as Spotify from '../services/spotify';
import * as Online from '../services/supabase';
import type { PlaylistSummary } from '../services/spotify';
import type { SongPool } from '../types/online';
import type { DeckSource } from '../services/deck';
import { PlaylistCheckModal } from './PlaylistCheckScreen';
import { PressableButton } from '../components/PressableButton';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';

type Mode = 'playlist' | 'pool';

export function PlaylistPicker({
  visible,
  onClose,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (source: DeckSource) => void;
}) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const [mode, setMode] = useState<Mode>('playlist');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Distinct from `error`: the user simply isn't connected to Spotify yet — a
  // normal state, not a failure. Shown as a calm cyan hint, not the red box.
  const [needsSpotify, setNeedsSpotify] = useState(false);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [pools, setPools] = useState<SongPool[]>([]);
  const [query, setQuery] = useState('');
  // The "Playlist prüfen" check can be opened for ANY row without selecting it.
  const [checkTarget, setCheckTarget] = useState<PlaylistSummary | null>(null);
  const [checkVisible, setCheckVisible] = useState(false);

  const load = useCallback(async (m: Mode) => {
    setError(null);
    setNeedsSpotify(false);
    // Pre-check the KNOWN connection status before hitting the Web API, so a
    // missing Spotify connection shows a friendly hint instead of a raw 403.
    // (Pools don't need Spotify, so this only gates playlist mode.)
    if (m === 'playlist' && !Spotify.isWebApiAuthorized()) {
      setNeedsSpotify(true);
      return; // no API call, no spinner
    }
    setLoading(true);
    try {
      if (m === 'playlist') setPlaylists(await Spotify.getUserPlaylists());
      else setPools(await Online.getSongPools());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 'Einstellungen' is a sibling tab; from this nested stack screen we hop up to
  // the tab navigator. Close the picker first so the tab is visible underneath.
  const goToSettings = () => {
    onClose();
    navigation.getParent()?.navigate('Einstellungen' as never);
  };

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    setQuery('');
    load(m);
  };

  const q = query.trim().toLowerCase();
  const filteredPlaylists = q ? playlists.filter((p) => p.name.toLowerCase().includes(q)) : playlists;
  const filteredPools = q ? pools.filter((p) => p.name.toLowerCase().includes(q)) : pools;

  const choosePlaylist = (p: PlaylistSummary) => {
    onSelect({ kind: 'playlist', playlist: p });
    onClose();
  };
  const choosePool = (p: SongPool) => {
    onSelect({ kind: 'pool', pool: p });
    onClose();
  };

  const openCheck = (p: PlaylistSummary) => {
    setCheckTarget(p);
    setCheckVisible(true);
  };

  const renderPlaylist = ({ item }: { item: PlaylistSummary }) => (
    <PressableButton style={styles.row} onPress={() => choosePlaylist(item)}>
      {item.imageUrl ? (
        <Image source={{ uri: item.imageUrl }} style={styles.cover} />
      ) : (
        <View style={[styles.cover, styles.coverFallback]}>
          <Text style={styles.coverGlyph}>💿</Text>
        </View>
      )}
      <View style={styles.rowText}>
        <Text style={styles.rowName} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {item.trackCount} Songs{item.ownerName ? ` · ${item.ownerName}` : ''}
        </Text>
      </View>
      {/* Separate tap target: opens the year check WITHOUT selecting the row. */}
      <PressableButton style={styles.checkBtn} onPress={() => openCheck(item)} hitSlop={8}>
        <Text style={styles.checkIcon}>🔍</Text>
      </PressableButton>
    </PressableButton>
  );

  const renderPool = ({ item }: { item: SongPool }) => (
    <PressableButton style={styles.row} onPress={() => choosePool(item)}>
      <View style={[styles.cover, styles.coverFallback]}>
        <Text style={styles.coverGlyph}>🎵</Text>
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowName} numberOfLines={1}>
          {item.name}
        </Text>
        {!!item.description && (
          <Text style={styles.rowMeta} numberOfLines={2}>
            {item.description}
          </Text>
        )}
      </View>
    </PressableButton>
  );

  const renderList = () => {
    if (needsSpotify) {
      return (
        <View style={styles.centered}>
          <Text style={styles.hintGlyph}>🎧</Text>
          <View style={styles.hintBox}>
            <Text style={styles.hintTitle}>Noch nicht mit Spotify verbunden</Text>
            <Text style={styles.hintText}>
              Zum Auswählen einer Playlist verbinde dich einmal mit Spotify. Themen-Pools
              kannst du auch ohne Verbindung nutzen.
            </Text>
          </View>
          <PressableButton style={styles.connectBtn} onPress={goToSettings}>
            <Text style={styles.connectBtnText}>Zu den Einstellungen</Text>
          </PressableButton>
        </View>
      );
    }
    if (loading) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator color={COLORS.secondary} size="large" />
          <Text style={styles.muted}>{mode === 'playlist' ? 'Lade deine Playlists…' : 'Lade Themen-Pools…'}</Text>
        </View>
      );
    }
    if (error) {
      return (
        <View style={styles.centered}>
          <View style={styles.errorBox}>
            <Text style={styles.errorText} selectable>
              {error}
            </Text>
          </View>
          {mode === 'playlist' && (
            <Text style={styles.muted}>Nicht verbunden? Verbinde dich im Tab „Einstellungen".</Text>
          )}
          <PressableButton style={styles.retryBtn} onPress={() => load(mode)}>
            <Text style={styles.retryText}>Erneut versuchen</Text>
          </PressableButton>
        </View>
      );
    }
    if (mode === 'playlist') {
      if (playlists.length === 0) {
        return (
          <View style={styles.centered}>
            <Text style={styles.emptyGlyph}>💿</Text>
            <Text style={styles.muted}>
              Keine Playlists gefunden. Erstelle eine in Spotify und versuche es erneut.
            </Text>
          </View>
        );
      }
      if (filteredPlaylists.length === 0) {
        return (
          <View style={styles.centered}>
            <Text style={styles.muted}>Keine Playlist passt zu „{query}".</Text>
          </View>
        );
      }
      return (
        <FlatList
          data={filteredPlaylists}
          keyExtractor={(item) => item.id}
          renderItem={renderPlaylist}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
        />
      );
    }
    // pool mode
    if (pools.length === 0) {
      return (
        <View style={styles.centered}>
          <Text style={styles.emptyGlyph}>🎵</Text>
          <Text style={styles.muted}>Keine Themen-Pools verfügbar.</Text>
        </View>
      );
    }
    if (filteredPools.length === 0) {
      return (
        <View style={styles.centered}>
          <Text style={styles.muted}>Kein Pool passt zu „{query}".</Text>
        </View>
      );
    }
    return (
      <FlatList
        data={filteredPools}
        keyExtractor={(item) => item.id}
        renderItem={renderPool}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
      />
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      onShow={() => {
        setMode('playlist');
        setQuery('');
        load('playlist');
      }}
    >
      <View style={[styles.modal, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Songs wählen</Text>
          <PressableButton style={styles.closeBtn} onPress={onClose} hitSlop={12}>
            <Text style={styles.closeText}>✕</Text>
          </PressableButton>
        </View>

        {/* Segmented control: Spotify playlist vs. themed pool */}
        <View style={styles.segment}>
          <PressableButton
            style={[styles.segmentBtn, mode === 'playlist' && styles.segmentBtnActive]}
            onPress={() => switchMode('playlist')}
          >
            <Text style={[styles.segmentText, mode === 'playlist' && styles.segmentTextActive]}>
              Spotify-Playlist
            </Text>
          </PressableButton>
          <PressableButton
            style={[styles.segmentBtn, mode === 'pool' && styles.segmentBtnActive]}
            onPress={() => switchMode('pool')}
          >
            <Text style={[styles.segmentText, mode === 'pool' && styles.segmentTextActive]}>
              Themen-Pool
            </Text>
          </PressableButton>
        </View>

        <TextInput
          style={styles.search}
          placeholder={mode === 'playlist' ? 'Playlist suchen…' : 'Pool suchen…'}
          placeholderTextColor={COLORS.textMuted}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />

        {renderList()}

        {checkTarget && (
          <PlaylistCheckModal
            visible={checkVisible}
            onClose={() => setCheckVisible(false)}
            playlistId={checkTarget.id}
            playlistName={checkTarget.name}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modal: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  title: { color: COLORS.primary, fontSize: 28, fontWeight: '900' },
  closeBtn: {
    width: 44,
    height: 44,
    borderRadius: 999,
    backgroundColor: COLORS.backgroundAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { color: COLORS.text, fontSize: 18, fontWeight: '900' },

  segment: {
    flexDirection: 'row',
    marginHorizontal: 20,
    marginBottom: 10,
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 4,
    gap: 4,
  },
  segmentBtn: {
    flex: 1,
    minHeight: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentBtnActive: { backgroundColor: COLORS.secondary },
  segmentText: { color: COLORS.textMuted, fontSize: 14, fontWeight: '800' },
  segmentTextActive: { color: COLORS.background },

  search: {
    marginHorizontal: 20,
    marginBottom: 8,
    minHeight: 48,
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.border,
    borderWidth: 2,
    borderRadius: 14,
    paddingHorizontal: 16,
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '600',
  },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  muted: { color: COLORS.textMuted, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  emptyGlyph: { fontSize: 64, color: COLORS.border },

  errorBox: {
    alignSelf: 'stretch',
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.incorrect,
    borderWidth: 2,
    borderRadius: 14,
    padding: 14,
  },
  errorText: { color: COLORS.incorrect, fontSize: 13, fontWeight: '700' },

  // "Not connected" hint — calm/cyan, deliberately NOT the red error style.
  hintGlyph: { fontSize: 56 },
  hintBox: {
    alignSelf: 'stretch',
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.secondary,
    borderWidth: 2,
    borderRadius: 14,
    padding: 16,
    gap: 8,
  },
  hintTitle: { color: COLORS.secondary, fontSize: 16, fontWeight: '900' },
  hintText: { color: COLORS.text, fontSize: 14, fontWeight: '600', lineHeight: 20 },
  connectBtn: {
    minHeight: 52,
    paddingHorizontal: 28,
    borderRadius: 14,
    backgroundColor: COLORS.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    ...glow(COLORS.secondary, { radius: 14, opacity: 0.7 }),
  },
  connectBtnText: { color: COLORS.background, fontSize: 16, fontWeight: '900', letterSpacing: 0.5 },
  retryBtn: {
    minHeight: 48,
    paddingHorizontal: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: COLORS.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryText: { color: COLORS.secondary, fontSize: 15, fontWeight: '800' },

  list: { padding: 16, gap: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 12,
  },
  cover: { width: 56, height: 56, borderRadius: 10 },
  coverFallback: {
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverGlyph: { fontSize: 28, color: COLORS.border },
  rowText: { flex: 1 },
  rowName: { color: COLORS.text, fontSize: 17, fontWeight: '800' },
  rowMeta: { color: COLORS.textMuted, fontSize: 13, fontWeight: '600', marginTop: 2 },

  checkBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkIcon: { fontSize: 18 },
});
