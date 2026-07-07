/**
 * PlayerStatsAccordion - one expandable per-player card for the post-game
 * statistics, shared by BOTH code worlds (Pass & Play ResultScreen + Party >
 * Hitster end view). Tap the header to expand the five stat categories with
 * song details; `children` (e.g. the Pass & Play timeline line) stays visible
 * in the collapsed state too.
 *
 * Pure presentation: aggregation lives in game/stats.ts, name resolution is
 * injected (the worlds use different player-id schemes).
 */
import { useRef, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import type { StatsSong } from '../types/game';
import type { PlayerMatchStats, StealEntry } from '../game/stats';
import { isEmptyStats } from '../game/stats';
import { PressableButton } from './PressableButton';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';

function SongRow({ song, subline }: { song: StatsSong; subline?: string }) {
  return (
    <View style={styles.songRow}>
      <View style={styles.songMain}>
        <Text style={styles.songTitle} numberOfLines={1}>
          {song.title}
        </Text>
        <Text style={styles.songArtist} numberOfLines={1}>
          {song.artist}
        </Text>
        {!!subline && <Text style={styles.songSub}>{subline}</Text>}
      </View>
      <Text style={styles.songYear}>{song.year}</Text>
    </View>
  );
}

function Section({
  icon,
  label,
  count,
  children,
}: {
  icon: string;
  label: string;
  count: number;
  children?: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        {icon} {label} <Text style={styles.sectionCount}>({count})</Text>
      </Text>
      {count === 0 ? <Text style={styles.emptyLine}>Keine</Text> : children}
    </View>
  );
}

export function PlayerStatsAccordion({
  name,
  isWinner,
  headerRight,
  stats,
  resolveName,
  children,
}: {
  name: string;
  isWinner?: boolean;
  /** Short right-aligned header info, e.g. "7 Pkt · 🔥 3er-Streak". */
  headerRight?: string;
  stats: PlayerMatchStats;
  /** Maps a player id from the stats (steal victims) to a display name. */
  resolveName: (playerId: string) => string;
  /** Always-visible content under the header (e.g. the timeline years). */
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const chevronAnim = useRef(new Animated.Value(0)).current;

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    Animated.timing(chevronAnim, {
      toValue: next ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  };
  const chevronRotate = chevronAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '90deg'],
  });

  const stealRows = (entries: StealEntry[], subline: (victimName: string) => string) =>
    entries.map((s, i) => (
      <SongRow
        key={`${s.song.title}-${i}`}
        song={s.song}
        subline={subline(resolveName(s.victimId))}
      />
    ));

  return (
    <View style={[styles.box, isWinner && styles.boxWinner]}>
      <PressableButton onPress={toggle} style={styles.header} activeOpacity={0.7}>
        <Text style={styles.name} numberOfLines={1}>
          {isWinner ? '👑 ' : ''}
          {name}
        </Text>
        <View style={styles.headerRightWrap}>
          {!!headerRight && <Text style={styles.headerRight}>{headerRight}</Text>}
          <Animated.Text
            style={[styles.chevron, { transform: [{ rotate: chevronRotate }] }]}
          >
            ▶
          </Animated.Text>
        </View>
      </PressableButton>

      {children}

      {expanded &&
        (isEmptyStats(stats) ? (
          <Text style={styles.emptyLine}>Keine Aktionen in dieser Partie.</Text>
        ) : (
          <View style={styles.body}>
            <Section icon="✅" label="Richtig platziert" count={stats.placedCorrect.length}>
              {stats.placedCorrect.map((s, i) => (
                <SongRow key={`c-${i}`} song={s} />
              ))}
            </Section>
            <Section icon="❌" label="Falsch platziert" count={stats.placedWrong.length}>
              {stats.placedWrong.map((s, i) => (
                <SongRow key={`w-${i}`} song={s} />
              ))}
            </Section>
            <Section icon="🎯" label="Erfolgreich geklaut" count={stats.stealsWon.length}>
              {stealRows(stats.stealsWon, (n) => `Karte von ${n} geklaut`)}
            </Section>
            <Section icon="💥" label="Verbrandt (Klau daneben)" count={stats.stealsFailed.length}>
              {stealRows(stats.stealsFailed, (n) => `Karte von ${n}`)}
            </Section>
            <Section icon="🪙" label="Erhaltene Nickel" count={stats.nickels.length}>
              {stats.nickels.map((s, i) =>
                s ? (
                  <SongRow key={`n-${i}`} song={s} subline="Titel + Interpret erkannt" />
                ) : (
                  <Text key={`n-${i}`} style={styles.songSub}>
                    🪙 Nickel erhalten
                  </Text>
                )
              )}
            </Section>
          </View>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 16,
    padding: 14,
    borderWidth: 2,
    borderColor: COLORS.border,
    gap: 6,
  },
  boxWinner: {
    borderColor: COLORS.accent,
    ...glow(COLORS.accent, { radius: 12, opacity: 0.6 }),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  name: { color: COLORS.text, fontWeight: '900', fontSize: 18, flexShrink: 1 },
  headerRightWrap: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerRight: { color: COLORS.textMuted, fontWeight: '700', fontSize: 13 },
  chevron: { color: COLORS.secondary, fontSize: 13, fontWeight: '900' },

  body: { gap: 12, marginTop: 4 },
  section: { gap: 6 },
  sectionTitle: {
    color: COLORS.secondary,
    fontWeight: '800',
    fontSize: 13,
    letterSpacing: 1,
  },
  sectionCount: { color: COLORS.textMuted, fontWeight: '800' },
  emptyLine: { color: COLORS.textMuted, fontSize: 13, fontStyle: 'italic' },

  songRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: COLORS.background,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  songMain: { flex: 1 },
  songTitle: { color: COLORS.text, fontWeight: '800', fontSize: 14 },
  songArtist: { color: COLORS.textMuted, fontWeight: '600', fontSize: 12 },
  songSub: { color: COLORS.textMuted, fontSize: 12, fontStyle: 'italic', marginTop: 2 },
  songYear: { color: COLORS.accent, fontWeight: '900', fontSize: 16 },
});
