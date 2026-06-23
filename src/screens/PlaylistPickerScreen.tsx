/**
 * PlaylistPicker - a modal that lists the connected user's Spotify playlists and
 * returns the chosen one. Uses Spotify.getUserPlaylists() (existing PKCE token);
 * no new auth flow. Client-side name search; loading / error / empty states.
 */
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Spotify from '../services/spotify';
import type { PlaylistSummary } from '../services/spotify';
import { PlaylistCheckModal } from './PlaylistCheckScreen';
import { COLORS } from '../theme/colors';

export function PlaylistPicker({
  visible,
  onClose,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (playlist: PlaylistSummary) => void;
}) {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [query, setQuery] = useState('');
  // The "Playlist prüfen" check can be opened for ANY row without selecting it.
  const [checkTarget, setCheckTarget] = useState<PlaylistSummary | null>(null);
  const [checkVisible, setCheckVisible] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPlaylists(await Spotify.getUserPlaylists());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? playlists.filter((p) => p.name.toLowerCase().includes(q))
    : playlists;

  const choose = (p: PlaylistSummary) => {
    onSelect(p);
    onClose();
  };

  const openCheck = (p: PlaylistSummary) => {
    setCheckTarget(p);
    setCheckVisible(true);
  };

  const renderItem = ({ item }: { item: PlaylistSummary }) => (
    <Pressable style={styles.row} onPress={() => choose(item)}>
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
      <Pressable
        style={styles.checkBtn}
        onPress={() => openCheck(item)}
        hitSlop={8}
      >
        <Text style={styles.checkIcon}>🔍</Text>
      </Pressable>
    </Pressable>
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      onShow={() => {
        setQuery('');
        load();
      }}
    >
      <View style={[styles.modal, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Playlist wählen</Text>
          <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={12}>
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
        </View>

        <TextInput
          style={styles.search}
          placeholder="Playlist suchen…"
          placeholderTextColor={COLORS.textMuted}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={COLORS.secondary} size="large" />
            <Text style={styles.muted}>Lade deine Playlists…</Text>
          </View>
        ) : error ? (
          <View style={styles.centered}>
            <View style={styles.errorBox}>
              <Text style={styles.errorText} selectable>
                {error}
              </Text>
            </View>
            <Text style={styles.muted}>
              Nicht verbunden? Verbinde dich im Spotify-Tab oder im ⚙️-Menü.
            </Text>
            <Pressable style={styles.retryBtn} onPress={load}>
              <Text style={styles.retryText}>Erneut versuchen</Text>
            </Pressable>
          </View>
        ) : playlists.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyGlyph}>💿</Text>
            <Text style={styles.muted}>
              Keine Playlists gefunden. Erstelle eine in Spotify und versuche es erneut.
            </Text>
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.muted}>Keine Playlist passt zu „{query}".</Text>
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
          />
        )}

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
