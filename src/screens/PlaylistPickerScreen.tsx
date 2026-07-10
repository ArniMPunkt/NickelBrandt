/**
 * PlaylistPicker - a modal to choose the game's song source: a pre-made themed
 * song pool (Supabase). Returns a DeckSource. Used by both Hot-Seat
 * (SetupScreen) and Online (LobbyScreen). Client-side name search;
 * loading / error / empty states.
 *
 * Historical note (also explains the file/component name): this used to offer
 * Spotify playlists as a second source behind a tab switcher. That path was
 * removed deliberately - Spotify's Development-Mode restrictions (5-user cap,
 * "not registered" 403s, playlist-ownership limits since Feb 2026) made it a
 * recurring support burden, while pools live in Supabase and need no
 * user-specific Spotify access at all.
 */
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Online from '../services/supabase';
import * as PoolProgress from '../services/poolProgress';
import type { SongPool } from '../types/online';
import type { DeckSource } from '../services/deck';
import { PoolIcon } from '../components/PoolIcon';
import { PressableButton } from '../components/PressableButton';
import { COLORS } from '../theme/colors';

export function PlaylistPicker({
  visible,
  onClose,
  onSelect,
  showPoolProgress = false,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (source: DeckSource) => void;
  /**
   * Show "X/Y verbleibend" + reset per pool (device-local play progress).
   * Hot-Seat only - the Online deck build does not exclude played songs, so
   * the counter would be misleading there.
   */
  showPoolProgress?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pools, setPools] = useState<SongPool[]>([]);
  const [query, setQuery] = useState('');
  // Per-pool progress (total songs + locally played), loaded lazily and only
  // when showPoolProgress is on. Missing entry -> row simply omits the counter.
  const [poolStats, setPoolStats] = useState<
    Record<string, { total: number; played: number }>
  >({});

  const loadPoolStats = useCallback(async (poolList: SongPool[]) => {
    try {
      const entries = await Promise.all(
        poolList.map(async (p) => {
          const [total, playedSet] = await Promise.all([
            Online.getPoolSongCount(p.id),
            PoolProgress.getPlayedIds(p.id),
          ]);
          return [p.id, { total, played: playedSet.size }] as const;
        })
      );
      setPoolStats(Object.fromEntries(entries));
    } catch {
      // non-fatal: rows just show without the counter
    }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const poolList = await Online.getSongPools();
      setPools(poolList);
      if (showPoolProgress) loadPoolStats(poolList); // fire & forget
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [showPoolProgress, loadPoolStats]);

  const q = query.trim().toLowerCase();
  const filteredPools = q ? pools.filter((p) => p.name.toLowerCase().includes(q)) : pools;

  const choosePool = (p: SongPool) => {
    onSelect({ kind: 'pool', pool: p });
    onClose();
  };

  // Reset the played-progress of exactly one pool (with confirmation).
  const confirmPoolReset = (p: SongPool) => {
    Alert.alert(
      'Pool zurücksetzen?',
      `Der gemerkte Fortschritt für „${p.name}" wird gelöscht — alle Songs gelten wieder als ungespielt.`,
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: 'Zurücksetzen',
          style: 'destructive',
          onPress: async () => {
            await PoolProgress.resetPlayed(p.id);
            setPoolStats((prev) =>
              prev[p.id] ? { ...prev, [p.id]: { ...prev[p.id], played: 0 } } : prev
            );
          },
        },
      ]
    );
  };

  const renderPool = ({ item }: { item: SongPool }) => {
    const stats = showPoolProgress ? poolStats[item.id] : undefined;
    const remaining = stats ? Math.max(0, stats.total - stats.played) : null;
    return (
      <PressableButton style={styles.row} onPress={() => choosePool(item)}>
        <PoolIcon iconUrl={item.icon_url} size={56} />
        <View style={styles.rowText}>
          <Text style={styles.rowName} numberOfLines={1}>
            {item.name}
          </Text>
          {!!item.description && (
            <Text style={styles.rowMeta} numberOfLines={2}>
              {item.description}
            </Text>
          )}
          {stats && (
            <Text style={styles.rowRemaining}>
              {remaining}/{stats.total} verbleibend
            </Text>
          )}
        </View>
        {/* Separate tap target: resets ONLY this pool, without selecting it. */}
        {stats && stats.played > 0 && (
          <PressableButton
            style={styles.resetBtn}
            onPress={() => confirmPoolReset(item)}
            hitSlop={8}
          >
            <Text style={styles.resetIcon}>↺</Text>
          </PressableButton>
        )}
      </PressableButton>
    );
  };

  const renderList = () => {
    if (loading) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator color={COLORS.secondary} size="large" />
          <Text style={styles.muted}>Lade Themen-Pools…</Text>
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
          <PressableButton style={styles.retryBtn} onPress={load}>
            <Text style={styles.retryText}>Erneut versuchen</Text>
          </PressableButton>
        </View>
      );
    }
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
        setQuery('');
        load();
      }}
    >
      <View style={[styles.modal, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Themen-Pool wählen</Text>
          <PressableButton style={styles.closeBtn} onPress={onClose} hitSlop={12}>
            <Text style={styles.closeText}>✕</Text>
          </PressableButton>
        </View>

        <TextInput
          style={styles.search}
          placeholder="Pool suchen…"
          placeholderTextColor={COLORS.textMuted}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />

        {renderList()}
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
  rowText: { flex: 1 },
  rowName: { color: COLORS.text, fontSize: 17, fontWeight: '800' },
  rowMeta: { color: COLORS.textMuted, fontSize: 13, fontWeight: '600', marginTop: 2 },
  rowRemaining: { color: COLORS.secondary, fontSize: 12, fontWeight: '800', marginTop: 3 },

  resetBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resetIcon: { fontSize: 18 },
});
