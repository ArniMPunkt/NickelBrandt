/**
 * PlaylistCheckModal - a manually-triggered diagnostic that compares each track's
 * Spotify year against MusicBrainz's original first-release year.
 *
 * It reuses Spotify.getPlaylistTracks() to load the deck, then runs the throttled
 * MusicBrainz checks (~1 req/s) with a live progress counter. Tracks whose years
 * differ by >= YEAR_DIFF_THRESHOLD are highlighted; the rest are collapsed into a
 * summary. Purely informational: nothing here changes the deck or the in-game
 * year - you decide whether to remove a song in Spotify itself.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Spotify from '../services/spotify';
import * as MusicBrainz from '../services/musicbrainz';
import { YEAR_DIFF_THRESHOLD, type TrackYearCheck } from '../services/musicbrainz';
import { COLORS } from '../theme/colors';

type Phase = 'loading' | 'checking' | 'done' | 'error';

export function PlaylistCheckModal({
  visible,
  onClose,
  playlistId,
  playlistName,
}: {
  visible: boolean;
  onClose: () => void;
  playlistId: string;
  playlistName: string;
}) {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>('loading');
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [currentTitle, setCurrentTitle] = useState('');
  const [results, setResults] = useState<TrackYearCheck[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showClean, setShowClean] = useState(false);
  const cancelledRef = useRef(false);

  const run = useCallback(async () => {
    cancelledRef.current = false;
    setPhase('loading');
    setResults([]);
    setError(null);
    setDone(0);
    setTotal(0);
    setCurrentTitle('');
    setShowClean(false);
    try {
      const tracks = await Spotify.getPlaylistTracks(playlistId);
      if (cancelledRef.current) return;
      setTotal(tracks.length);
      setPhase('checking');
      const res = await MusicBrainz.checkPlaylistYears(tracks, {
        onProgress: (d, t, card) => {
          if (cancelledRef.current) return;
          setDone(d);
          setTotal(t);
          if (card) setCurrentTitle(card.title);
        },
        isCancelled: () => cancelledRef.current,
      });
      if (cancelledRef.current) return;
      setResults(res);
      setPhase('done');
    } catch (e: any) {
      if (cancelledRef.current) return;
      setError(e?.message ?? String(e));
      setPhase('error');
    }
  }, [playlistId]);

  const close = () => {
    cancelledRef.current = true; // stop the sequential loop
    onClose();
  };

  // Split results: flagged (significant diff) vs. unremarkable (small/no diff).
  const { flagged, clean, noMatchCount } = useMemo(() => {
    const flagged = results
      .filter((r) => r.diff != null && r.diff >= YEAR_DIFF_THRESHOLD)
      .sort((a, b) => (b.diff ?? 0) - (a.diff ?? 0));
    const clean = results.filter((r) => r.diff == null || r.diff < YEAR_DIFF_THRESHOLD);
    const noMatchCount = results.filter((r) => r.mbYear == null).length;
    return { flagged, clean, noMatchCount };
  }, [results]);

  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close} onShow={run}>
      <View style={[styles.modal, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Playlist prüfen</Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {playlistName}
            </Text>
          </View>
          <Pressable style={styles.closeBtn} onPress={close} hitSlop={12}>
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
        </View>

        {/* ---- Loading tracks ---- */}
        {phase === 'loading' && (
          <View style={styles.centered}>
            <ActivityIndicator color={COLORS.secondary} size="large" />
            <Text style={styles.muted}>Lade Tracks der Playlist…</Text>
          </View>
        )}

        {/* ---- Checking (progress) ---- */}
        {phase === 'checking' && (
          <View style={styles.centered}>
            <Text style={styles.progressCount}>
              Prüfe Track {Math.min(done + 1, total)} von {total}…
            </Text>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${progressPct}%` }]} />
            </View>
            <Text style={styles.muted} numberOfLines={1}>
              {currentTitle}
            </Text>
            <Text style={styles.hint}>
              MusicBrainz erlaubt ~1 Abfrage/Sekunde – das dauert bei großen
              Playlists einen Moment.
            </Text>
          </View>
        )}

        {/* ---- Error ---- */}
        {phase === 'error' && (
          <View style={styles.centered}>
            <View style={styles.errorBox}>
              <Text style={styles.errorText} selectable>
                {error}
              </Text>
            </View>
            <Pressable style={styles.retryBtn} onPress={run}>
              <Text style={styles.retryText}>Erneut versuchen</Text>
            </Pressable>
          </View>
        )}

        {/* ---- Done ---- */}
        {phase === 'done' && (
          <ScrollView contentContainerStyle={styles.list}>
            <Text style={styles.summary}>
              {flagged.length === 0
                ? `Keine auffälligen Jahre (von ${results.length} geprüften Tracks).`
                : `${flagged.length} auffällige${flagged.length === 1 ? 'r' : ''} Track${
                    flagged.length === 1 ? '' : 's'
                  } von ${results.length} (≥ ${YEAR_DIFF_THRESHOLD} Jahre Differenz).`}
            </Text>

            {flagged.map((r) => (
              <View key={r.card.id} style={styles.flagRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.flagTitle} numberOfLines={1}>
                    {r.card.title}
                  </Text>
                  <Text style={styles.flagArtist} numberOfLines={1}>
                    {r.card.artist}
                  </Text>
                  <Text style={styles.flagYears}>
                    Spotify <Text style={styles.spotifyYear}>{r.spotifyYear}</Text>
                    {'  →  '}
                    MusicBrainz <Text style={styles.mbYear}>{r.mbYear}</Text>
                    {r.source === 'search' ? '  (Titelsuche)' : ''}
                  </Text>
                </View>
                <View style={styles.diffBadge}>
                  <Text style={styles.diffText}>
                    {r.diff != null && r.mbYear != null && r.mbYear < r.spotifyYear ? '−' : '+'}
                    {r.diff}
                  </Text>
                  <Text style={styles.diffLabel}>Jahre</Text>
                </View>
              </View>
            ))}

            {clean.length > 0 && (
              <>
                <Pressable style={styles.cleanToggle} onPress={() => setShowClean((v) => !v)}>
                  <Text style={styles.cleanToggleText}>
                    {showClean ? '▾' : '▸'} {clean.length} Tracks ohne Auffälligkeiten
                    {noMatchCount > 0 ? ` (davon ${noMatchCount} ohne MusicBrainz-Treffer)` : ''}
                  </Text>
                </Pressable>
                {showClean &&
                  clean.map((r) => (
                    <View key={r.card.id} style={styles.cleanRow}>
                      <Text style={styles.cleanTitle} numberOfLines={1}>
                        {r.card.title}
                      </Text>
                      <Text style={styles.cleanMeta} numberOfLines={1}>
                        {r.mbYear == null
                          ? `${r.spotifyYear} · kein MB-Treffer`
                          : `${r.spotifyYear} ≈ ${r.mbYear}`}
                      </Text>
                    </View>
                  ))}
              </>
            )}

            <Text style={styles.footnote}>
              Diagnose-Werkzeug: Es ändert nichts am Spiel. Fragwürdige Songs
              entfernst du bei Bedarf direkt in Spotify.
            </Text>
          </ScrollView>
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
    gap: 12,
  },
  title: { color: COLORS.primary, fontSize: 26, fontWeight: '900' },
  subtitle: { color: COLORS.textMuted, fontSize: 14, fontWeight: '700', marginTop: 2 },
  closeBtn: {
    width: 44,
    height: 44,
    borderRadius: 999,
    backgroundColor: COLORS.backgroundAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { color: COLORS.text, fontSize: 18, fontWeight: '900' },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  muted: { color: COLORS.textMuted, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  hint: { color: COLORS.textMuted, fontSize: 13, fontStyle: 'italic', textAlign: 'center' },

  progressCount: { color: COLORS.text, fontSize: 20, fontWeight: '900', textAlign: 'center' },
  barTrack: {
    width: '100%',
    height: 12,
    borderRadius: 999,
    backgroundColor: COLORS.backgroundAlt,
    overflow: 'hidden',
  },
  barFill: { height: '100%', backgroundColor: COLORS.secondary, borderRadius: 999 },

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

  list: { padding: 16, gap: 10, paddingBottom: 48 },
  summary: { color: COLORS.text, fontSize: 15, fontWeight: '800', marginBottom: 4 },

  flagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: COLORS.accent,
    padding: 12,
  },
  flagTitle: { color: COLORS.text, fontSize: 16, fontWeight: '900' },
  flagArtist: { color: COLORS.textMuted, fontSize: 13, fontWeight: '600', marginTop: 1 },
  flagYears: { color: COLORS.textMuted, fontSize: 13, fontWeight: '700', marginTop: 6 },
  spotifyYear: { color: COLORS.text, fontWeight: '900' },
  mbYear: { color: COLORS.accent, fontWeight: '900' },
  diffBadge: {
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
    minWidth: 56,
  },
  diffText: { color: COLORS.background, fontSize: 18, fontWeight: '900' },
  diffLabel: { color: COLORS.background, fontSize: 9, fontWeight: '800', letterSpacing: 1 },

  cleanToggle: {
    marginTop: 8,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  cleanToggleText: { color: COLORS.secondary, fontSize: 15, fontWeight: '800' },
  cleanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomColor: COLORS.border,
    borderBottomWidth: 1,
  },
  cleanTitle: { color: COLORS.textMuted, fontSize: 13, fontWeight: '700', flexShrink: 1 },
  cleanMeta: { color: COLORS.textMuted, fontSize: 12, fontWeight: '600' },

  footnote: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
    marginTop: 16,
    textAlign: 'center',
  },
});
