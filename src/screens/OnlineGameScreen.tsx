/**
 * OnlineGameScreen - synced round play with the distributed Hitster mechanism.
 *
 * Phase flow (all synced via game_state):
 *   card_drawn  -> active player places ([+])            -> placeCard
 *   hitster_window -> 5s; other players with Nickel may  -> callHitster (atomic)
 *   hitster_resolving -> caller places in active's       -> resolveHitsterPlacement
 *                        timeline (active's slot blocked)
 *   awaiting_host_confirmation -> card revealed; host     -> confirmGuess
 *                        answers "title+artist?"
 *   finished    -> result message; host draws next        -> drawNextCard
 *
 * The HOST owns the 5s window timeout (closeHitsterWindow). Only the host plays audio.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Online from '../services/supabase';
import * as Spotify from '../services/spotify';
import { COLORS } from '../theme/colors';
import type { GameCard, Lobby, LobbyPlayer } from '../types/online';
import type { OnlineStackParamList } from '../types/navigation';

type Nav = NativeStackNavigationProp<OnlineStackParamList, 'OnlineGame'>;
type GameRoute = RouteProp<OnlineStackParamList, 'OnlineGame'>;

const STEAL_WINDOW_MS = 5000;
const STEAL_GRACE_MS = 700;

function TimelineStrip({
  timeline,
  onInsert,
  isSlotEnabled,
}: {
  timeline: GameCard[];
  onInsert?: (i: number) => void;
  isSlotEnabled?: (i: number) => boolean;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.timelineRow}>
      {Array.from({ length: timeline.length + 1 }).map((_, slot) => {
        const enabled = isSlotEnabled ? isSlotEnabled(slot) : true;
        return (
          <View key={`slot-${slot}`} style={styles.slotWrap}>
            {onInsert ? (
              <Pressable
                style={[styles.insertBtn, !enabled && styles.insertBtnDisabled]}
                onPress={enabled ? () => onInsert(slot) : undefined}
                disabled={!enabled}
              >
                <Text style={styles.insertText}>+</Text>
              </Pressable>
            ) : (
              <View style={styles.insertSpacer} />
            )}
            {slot < timeline.length && (
              <View style={styles.tlCard}>
                <Text style={styles.tlYear}>{timeline[slot].year}</Text>
                <Text style={styles.tlTitle} numberOfLines={2}>
                  {timeline[slot].title}
                </Text>
              </View>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

export default function OnlineGameScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { lobbyId } = useRoute<GameRoute>().params;

  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const myId = Online.getPlayerId();
  const barAnim = useRef(new Animated.Value(1)).current;

  const refresh = useCallback(async () => {
    try {
      const [lb, list] = await Promise.all([
        Online.getLobby(lobbyId),
        Online.getLobbyPlayers(lobbyId),
      ]);
      setLobby(lb);
      setPlayers(list);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [lobbyId]);

  useEffect(() => {
    refresh();
    const unsubscribe = Online.subscribeToGameState(lobbyId, refresh);
    const poll = setInterval(refresh, 5000);
    return () => {
      unsubscribe();
      clearInterval(poll);
    };
  }, [lobbyId, refresh]);

  const gs = lobby?.game_state ?? null;
  const me = players.find((p) => p.player_id === myId);
  const isHost = !!me?.is_host;
  const phase = gs?.phase;
  const activePlayer = gs ? players.find((p) => p.player_id === gs.activePlayerId) : undefined;
  const isActive = !!gs && gs.activePlayerId === myId;
  const card = gs?.currentCard ?? null;
  const isRevealed = phase === 'awaiting_host_confirmation' || phase === 'finished';
  const concealed = !!gs?.hideCoverUntilRevealed && !isRevealed;
  const myTimeline = me?.timeline ?? [];
  const activeTimeline = activePlayer?.timeline ?? [];
  // Non-active players see the active player's timeline (read-only) the whole
  // round, so they have time to plan a possible steal. The card shrinks to fit.
  const showActiveTimeline =
    !isActive && (phase === 'card_drawn' || phase === 'hitster_window');
  const compactCard = showActiveTimeline;

  // Host plays the current track when a new card is drawn; pause when finished.
  useEffect(() => {
    if (!isHost) return;
    if (phase === 'card_drawn' && card) Spotify.playUri(card.trackUri).catch(() => {});
    if (phase === 'finished') Spotify.pause().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id, phase, isHost]);

  // Cosmetic countdown bar while the steal window is open (each device animates).
  useEffect(() => {
    if (phase === 'hitster_window') {
      barAnim.setValue(1);
      const anim = Animated.timing(barAnim, {
        toValue: 0,
        duration: STEAL_WINDOW_MS,
        useNativeDriver: false,
      });
      anim.start();
      return () => anim.stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, gs?.currentCard?.id]);

  // The HOST is the authority that closes the window after the timeout.
  useEffect(() => {
    if (!isHost || phase !== 'hitster_window') return;
    const t = setTimeout(() => {
      Online.closeHitsterWindow(lobbyId).catch((e: any) => setError(e?.message ?? String(e)));
    }, STEAL_WINDOW_MS + STEAL_GRACE_MS);
    return () => clearTimeout(t);
  }, [isHost, phase, lobbyId]);

  // Clear the transient notice when the round/phase moves on.
  useEffect(() => {
    setNotice(null);
  }, [phase, gs?.currentCard?.id]);

  // Stable playful line for the "both wrong" outcome, per card.
  const bothWrongMessage = useMemo(() => {
    const variants = [
      'Tja, das war wohl nix für beide! 🙈',
      'Daneben! Beide haben sich verzockt. 🎲',
      'Doppelt vorbei – die Karte fliegt raus! 😅',
    ];
    return variants[Math.floor(Math.random() * variants.length)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gs?.currentCard?.id]);

  if (!gs) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <Text style={styles.muted}>Lade Spielzustand…</Text>
        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    );
  }

  // --- Handlers ---
  const onPlace = (i: number) =>
    Online.placeCard(lobbyId, i).catch((e: any) => setError(e?.message ?? String(e)));
  const onHitster = async () => {
    setError(null);
    const won = await Online.callHitster(lobbyId, myId).catch((e: any) => {
      setError(e?.message ?? String(e));
      return false;
    });
    if (!won) setNotice('Jemand anderes war schneller beim Hitster-Ruf.');
  };
  const onStealPlace = (i: number) =>
    Online.resolveHitsterPlacement(lobbyId, i).catch((e: any) => setError(e?.message ?? String(e)));
  const hostConfirm = (wasCorrect: boolean) =>
    Online.confirmGuess(lobbyId, wasCorrect).catch((e: any) => setError(e?.message ?? String(e)));
  const hostNext = () =>
    Online.drawNextCard(lobbyId).catch((e: any) => setError(e?.message ?? String(e)));

  // --- Reveal-derived values ---
  const steal = gs.hitsterCallerId
    ? { id: gs.hitsterCallerId, result: gs.stealResult }
    : null;
  const stealerName = steal ? players.find((p) => p.player_id === steal.id)?.player_name : undefined;
  const brandtSuccess = !!steal && steal.result === 'correct';
  const kept = brandtSuccess || (!brandtSuccess && gs.lastResult === 'correct');

  let resultMsg = '';
  if (isRevealed) {
    if (brandtSuccess) {
      resultMsg = `🔥 ${stealerName} hat einen Brandt gemacht!`;
    } else if (steal && steal.result === 'incorrect') {
      resultMsg =
        gs.lastResult === 'correct'
          ? `${activePlayer?.player_name} hatte recht! Die Karte bleibt.`
          : bothWrongMessage;
    } else {
      resultMsg = gs.lastResult === 'correct' ? '✓  RICHTIG platziert' : '✕  FALSCH platziert';
    }
  }

  const barWidth = barAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  // ----- Finished: game over (winner) -----
  if (phase === 'finished' && gs.winnerId) {
    const winner = players.find((p) => p.player_id === gs.winnerId);
    return (
      <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingTop: insets.top + 24 }]}>
        <Text style={styles.trophy}>🏆</Text>
        <Text style={styles.winnerLabel}>GEWINNER</Text>
        <Text style={styles.winnerName}>{winner ? winner.player_name : '-'}</Text>
        <Text style={styles.sectionLabel}>ERGEBNIS</Text>
        {[...players]
          .sort((a, b) => b.score - a.score)
          .map((p) => (
            <View key={p.id} style={styles.scoreRow}>
              <Text style={styles.scoreName} numberOfLines={1}>
                {p.player_name}
              </Text>
              <Text style={styles.scoreVal}>
                {p.score} Pkt · 🔥 {p.brandts_count}
              </Text>
            </View>
          ))}
        <Pressable style={styles.primaryBtn} onPress={() => navigation.navigate('OnlineHome')}>
          <Text style={styles.primaryBtnText}>Zurück</Text>
        </Pressable>
      </ScrollView>
    );
  }

  // ----- Playing -----
  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.activeName} numberOfLines={1}>
            {isActive ? 'Du bist dran' : `${activePlayer?.player_name ?? '—'} ist dran`}
          </Text>
          <Text style={styles.subLine}>{me ? `${me.score} Pkt · 🪙 ${me.chips}` : ''}</Text>
        </View>
        <View style={styles.deckPill}>
          <Text style={styles.deckCount}>{gs.deck.length}</Text>
          <Text style={styles.deckLabel}>im Deck</Text>
        </View>
      </View>

      {/* Card */}
      {card && (
        <View style={[styles.cardBox, compactCard && styles.cardBoxCompact]}>
          {concealed ? (
            <View style={[styles.cover, compactCard && styles.coverCompact, styles.coverFallback]}>
              <Text style={[styles.coverGlyph, compactCard && styles.coverGlyphCompact]}>💿</Text>
            </View>
          ) : card.coverUrl ? (
            <Image source={{ uri: card.coverUrl }} style={[styles.cover, compactCard && styles.coverCompact]} />
          ) : (
            <View style={[styles.cover, compactCard && styles.coverCompact, styles.coverFallback]}>
              <Text style={[styles.coverGlyph, compactCard && styles.coverGlyphCompact]}>♫</Text>
            </View>
          )}
          {!compactCard && (
            <>
              <Text style={styles.cardTitle} numberOfLines={2}>
                {concealed ? '????' : card.title}
              </Text>
              <Text style={styles.cardArtist} numberOfLines={1}>
                {concealed ? '????' : card.artist}
              </Text>
            </>
          )}
          <Text style={[styles.cardYear, compactCard && styles.cardYearCompact]}>
            {isRevealed ? card.year : '????'}
          </Text>
        </View>
      )}

      {/* Reveal result */}
      {isRevealed && !!resultMsg && (
        <View
          style={[
            brandtSuccess ? styles.brandtBox : styles.feedback,
            !brandtSuccess && { backgroundColor: kept ? COLORS.correct : COLORS.incorrect },
          ]}
        >
          <Text style={brandtSuccess ? styles.brandtText : styles.feedbackText}>{resultMsg}</Text>
        </View>
      )}

      {/* ---- card_drawn: active places; others watch both timelines ---- */}
      {phase === 'card_drawn' && (
        <>
          {isActive ? (
            <>
              <Text style={styles.sectionLabel}>DEINE ZEITLINIE</Text>
              <TimelineStrip timeline={myTimeline} onInsert={onPlace} />
              <Text style={styles.hint}>Tippe ein „+", um den Track einzuordnen.</Text>
            </>
          ) : (
            <>
              <Text style={styles.sectionLabel}>
                ZEITLINIE VON {activePlayer?.player_name?.toUpperCase() ?? '—'}
              </Text>
              <TimelineStrip timeline={activeTimeline} />
              <Text style={styles.sectionLabel}>DEINE ZEITLINIE</Text>
              <TimelineStrip timeline={myTimeline} />
              <Text style={styles.hint}>{activePlayer?.player_name} ordnet gerade ein…</Text>
            </>
          )}
        </>
      )}

      {/* ---- hitster_window: 5s steal window ---- */}
      {phase === 'hitster_window' && (
        <>
          <View style={styles.stealBox}>
            <Text style={styles.stealTitle}>Karte eingeordnet!</Text>
            <View style={styles.barTrack}>
              <Animated.View style={[styles.barFill, { width: barWidth }]} />
            </View>
            {isActive ? (
              <Text style={styles.hint}>Mitspieler können jetzt „Hitster!" rufen…</Text>
            ) : me && me.chips >= 1 ? (
              <Pressable style={styles.hitsterBtn} onPress={onHitster}>
                <Text style={styles.hitsterText}>HITSTER! 🎯</Text>
              </Pressable>
            ) : (
              <Text style={styles.hint}>Du hast keine 🪙 zum Klauen.</Text>
            )}
          </View>
          {!isActive && (
            <>
              <Text style={styles.sectionLabel}>
                ZEITLINIE VON {activePlayer?.player_name?.toUpperCase() ?? '—'}
              </Text>
              <TimelineStrip timeline={activeTimeline} />
            </>
          )}
        </>
      )}

      {/* ---- hitster_resolving: caller places in active's timeline ---- */}
      {phase === 'hitster_resolving' && (
        <View>
          {gs.hitsterCallerId === myId ? (
            <>
              <Text style={styles.sectionLabel}>
                {activePlayer?.player_name?.toUpperCase()} — WO GEHÖRT SIE HIN?
              </Text>
              <TimelineStrip
                timeline={activePlayer?.timeline ?? []}
                onInsert={onStealPlace}
                isSlotEnabled={(i) => i !== gs.pendingInsertIndex}
              />
              <Text style={styles.hint}>
                Der bereits gewählte Slot ist gesperrt — 1 🪙 wird eingesetzt.
              </Text>
            </>
          ) : (
            <Text style={styles.hint}>
              {stealerName ?? 'Jemand'} versucht zu klauen…
            </Text>
          )}
        </View>
      )}

      {/* ---- awaiting_host_confirmation: reveal shown; host answers ---- */}
      {phase === 'awaiting_host_confirmation' &&
        (isHost ? (
          <View style={styles.hostBox}>
            <Text style={styles.hostTitle}>Titel + Interpret richtig erkannt?</Text>
            <View style={styles.hostRow}>
              <Pressable style={[styles.hostBtn, styles.hostYes]} onPress={() => hostConfirm(true)}>
                <Text style={styles.hostYesText}>Ja, Nickel! 🪙</Text>
              </Pressable>
              <Pressable style={[styles.hostBtn, styles.hostNo]} onPress={() => hostConfirm(false)}>
                <Text style={styles.hostNoText}>Nein</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Text style={styles.hint}>Warte auf Host-Bestätigung…</Text>
        ))}

      {/* ---- finished (round, not game): host draws next ---- */}
      {phase === 'finished' &&
        (isHost ? (
          <Pressable style={styles.primaryBtn} onPress={hostNext}>
            <Text style={styles.primaryBtnText}>Nächste Karte ziehen</Text>
          </Pressable>
        ) : (
          <Text style={styles.hint}>Warte auf den Host…</Text>
        ))}

      {notice && <Text style={styles.notice}>{notice}</Text>}

      {/* Players */}
      <Text style={styles.sectionLabel}>SPIELER</Text>
      {players.map((p) => (
        <View key={p.id} style={styles.scoreRow}>
          <Text style={styles.scoreName} numberOfLines={1}>
            {p.player_name}
            {p.player_id === gs.activePlayerId ? ' ▶' : ''}
            {p.player_id === myId ? ' (du)' : ''}
          </Text>
          <Text style={styles.scoreVal}>
            {p.score} Pkt · {p.timeline.length} Karten · 🪙 {p.chips}
          </Text>
        </View>
      ))}

      {error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  content: { padding: 20, paddingBottom: 48, gap: 12 },
  muted: { color: COLORS.textMuted, fontSize: 16 },
  error: { color: COLORS.incorrect, fontSize: 13, fontWeight: '700' },
  notice: { color: COLORS.accent, fontSize: 14, fontWeight: '700', textAlign: 'center' },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  activeName: {
    fontSize: 26,
    fontWeight: '900',
    color: COLORS.primary,
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12,
  },
  subLine: { fontSize: 14, fontWeight: '700', color: COLORS.textMuted, marginTop: 2 },
  deckPill: {
    backgroundColor: COLORS.backgroundAlt,
    borderColor: COLORS.border,
    borderWidth: 2,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: 'center',
    minWidth: 64,
  },
  deckCount: { color: COLORS.secondary, fontWeight: '900', fontSize: 22 },
  deckLabel: { color: COLORS.textMuted, fontWeight: '700', fontSize: 10, letterSpacing: 1 },

  cardBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 24,
    padding: 20,
    alignItems: 'center',
    gap: 6,
    borderWidth: 2,
    borderColor: COLORS.primary,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 20,
    elevation: 10,
  },
  cardBoxCompact: { padding: 12, gap: 2 },
  cover: { width: 200, height: 200, borderRadius: 16, marginBottom: 8 },
  coverCompact: { width: 72, height: 72, borderRadius: 10, marginBottom: 0 },
  coverFallback: { backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },
  coverGlyph: { fontSize: 64, color: COLORS.border },
  coverGlyphCompact: { fontSize: 32 },
  cardYearCompact: { fontSize: 24, textShadowRadius: 8 },
  cardTitle: { fontSize: 22, fontWeight: '900', color: COLORS.text, textAlign: 'center' },
  cardArtist: { fontSize: 15, color: COLORS.textMuted, fontWeight: '600' },
  cardYear: {
    fontSize: 46,
    fontWeight: '900',
    color: COLORS.accent,
    marginTop: 4,
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 14,
  },

  feedback: { borderRadius: 16, paddingVertical: 14, paddingHorizontal: 12 },
  feedbackText: { color: COLORS.background, fontWeight: '900', fontSize: 17, textAlign: 'center', letterSpacing: 0.5 },
  brandtBox: {
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: COLORS.accent,
    backgroundColor: COLORS.backgroundAlt,
  },
  brandtText: {
    color: COLORS.accent,
    fontSize: 18,
    fontWeight: '900',
    textAlign: 'center',
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 14,
  },

  sectionLabel: { fontSize: 13, fontWeight: '800', color: COLORS.secondary, letterSpacing: 2, marginTop: 10 },
  hint: { color: COLORS.textMuted, fontSize: 14, fontStyle: 'italic' },

  timelineRow: { alignItems: 'center', paddingVertical: 8 },
  slotWrap: { flexDirection: 'row', alignItems: 'center' },
  insertBtn: {
    width: 48,
    height: 84,
    borderRadius: 14,
    backgroundColor: COLORS.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 5,
  },
  insertBtnDisabled: { backgroundColor: COLORS.border, opacity: 0.35 },
  insertText: { color: COLORS.background, fontSize: 30, fontWeight: '900' },
  insertSpacer: { width: 10 },
  tlCard: {
    width: 108,
    height: 96,
    borderRadius: 16,
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 2,
    borderColor: COLORS.accent,
    padding: 10,
    justifyContent: 'center',
  },
  tlYear: { color: COLORS.accent, fontSize: 26, fontWeight: '900' },
  tlTitle: { color: COLORS.textMuted, fontSize: 12, fontWeight: '600' },

  stealBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: COLORS.secondary,
    padding: 20,
    alignItems: 'center',
    gap: 10,
  },
  stealTitle: { color: COLORS.text, fontSize: 20, fontWeight: '900' },
  barTrack: {
    width: '100%',
    height: 12,
    borderRadius: 999,
    backgroundColor: COLORS.background,
    overflow: 'hidden',
  },
  barFill: { height: '100%', backgroundColor: COLORS.secondary, borderRadius: 999 },
  hitsterBtn: {
    minHeight: 60,
    alignSelf: 'stretch',
    backgroundColor: COLORS.primary,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 16,
    elevation: 10,
  },
  hitsterText: { color: COLORS.text, fontSize: 22, fontWeight: '900', letterSpacing: 1 },

  hostBox: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: COLORS.accent,
    padding: 16,
    gap: 12,
  },
  hostTitle: { color: COLORS.text, fontSize: 17, fontWeight: '900', textAlign: 'center' },
  hostRow: { flexDirection: 'row', gap: 12 },
  hostBtn: { flex: 1, minHeight: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  hostYes: { backgroundColor: COLORS.accent },
  hostYesText: { color: COLORS.background, fontSize: 15, fontWeight: '900' },
  hostNo: { backgroundColor: COLORS.background, borderWidth: 2, borderColor: COLORS.border },
  hostNoText: { color: COLORS.textMuted, fontSize: 16, fontWeight: '800' },

  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  scoreName: { color: COLORS.text, fontWeight: '800', fontSize: 15, flexShrink: 1 },
  scoreVal: { color: COLORS.textMuted, fontWeight: '600', fontSize: 12 },

  trophy: { fontSize: 64, textAlign: 'center' },
  winnerLabel: { fontSize: 14, fontWeight: '800', color: COLORS.secondary, letterSpacing: 3, textAlign: 'center' },
  winnerName: {
    fontSize: 40,
    fontWeight: '900',
    color: COLORS.primary,
    textAlign: 'center',
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },

  primaryBtn: {
    marginTop: 16,
    minHeight: 58,
    backgroundColor: COLORS.secondary,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: { color: COLORS.background, fontSize: 18, fontWeight: '900', letterSpacing: 1 },
});
