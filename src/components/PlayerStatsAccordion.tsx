/**
 * Expandable per-player cards for the post-game statistics, shared by the
 * three stat surfaces (Pass & Play ResultScreen, Party > Hitster end view,
 * Party > Bingo end view). Tap the header to expand the stat categories with
 * song details; `children` (e.g. the Pass & Play timeline line) stays visible
 * in the collapsed state too.
 *
 * Pure presentation: aggregation lives in game/stats.ts, name resolution is
 * injected (the worlds use different player-id schemes).
 */
import { useRef, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import type { StatsSong } from '../types/game';
import type {
  PlayerBingoStats,
  PlayerMatchStats,
  PlayerQuizStats,
  BingoStatEntry,
  StealEntry,
} from '../game/stats';
import { isEmptyBingoStats, isEmptyQuizStats, isEmptyStats } from '../game/stats';
import { bingoCategoryLabel } from '../game/bingo';
import { BingoGrid } from './BingoGrid';
import type { BingoBoard, BingoDifficulty } from '../types/online';
import { PressableButton } from './PressableButton';
import { BINGO_CATEGORY_COLOR, COLORS } from '../theme/colors';
import { glow } from '../theme/glow';

/** Called with a song that VERIFIABLY carries a trackUri (report insert needs it). */
export type ReportStatsSong = (song: StatsSong & { trackUri: string }) => void;

function SongRow({
  song,
  subline,
  sublineColor,
  onReportSong,
}: {
  song: StatsSong;
  subline?: string;
  /** Optional subline accent (e.g. the bingo category color); default muted. */
  sublineColor?: string;
  /** Renders the small 🚩 report flag (host / device holder only). */
  onReportSong?: ReportStatsSong;
}) {
  // The flag needs a trackUri for the report row; histories logged before the
  // field existed simply don't offer it.
  const trackUri = song.trackUri;
  const report = onReportSong && trackUri ? () => onReportSong({ ...song, trackUri }) : null;
  return (
    <View style={styles.songRow}>
      <View style={styles.songMain}>
        <Text style={styles.songTitle} numberOfLines={1}>
          {song.title}
        </Text>
        <Text style={styles.songArtist} numberOfLines={1}>
          {song.artist}
        </Text>
        {!!subline && (
          <Text style={[styles.songSub, sublineColor ? { color: sublineColor, fontStyle: 'normal', fontWeight: '800' } : null]}>
            {subline}
          </Text>
        )}
      </View>
      <View style={styles.songRight}>
        {report && (
          <PressableButton style={styles.flagBtn} onPress={report} hitSlop={8}>
            <Text style={styles.flagText}>🚩</Text>
          </PressableButton>
        )}
        <Text style={styles.songYear}>{song.year}</Text>
      </View>
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

/** Shared card shell: tappable header, always-visible children, expandable body. */
function StatsAccordionShell({
  name,
  isWinner,
  headerRight,
  children,
  body,
}: {
  name: string;
  isWinner?: boolean;
  headerRight?: string;
  children?: ReactNode;
  /** Rendered only while expanded. */
  body: ReactNode;
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

      {expanded && body}
    </View>
  );
}

// --- Hitster / Pass & Play ----------------------------------------------------

export function PlayerStatsAccordion({
  name,
  isWinner,
  headerRight,
  stats,
  resolveName,
  onReportSong,
  children,
}: {
  name: string;
  isWinner?: boolean;
  /** Short right-aligned header info, e.g. "7 Pkt · 🔥 3er-Streak". */
  headerRight?: string;
  stats: PlayerMatchStats;
  /** Maps a player id from the stats (steal victims) to a display name. */
  resolveName: (playerId: string) => string;
  /** "Song melden" flag on every song item (host / device holder only). */
  onReportSong?: ReportStatsSong;
  /** Always-visible content under the header (e.g. the timeline years). */
  children?: ReactNode;
}) {
  const stealRows = (entries: StealEntry[], subline: (victimName: string) => string) =>
    entries.map((s, i) => (
      <SongRow
        key={`${s.song.title}-${i}`}
        song={s.song}
        subline={subline(resolveName(s.victimId))}
        onReportSong={onReportSong}
      />
    ));

  const body = isEmptyStats(stats) ? (
    <Text style={styles.emptyLine}>Keine Aktionen in dieser Partie.</Text>
  ) : (
    <View style={styles.body}>
      <Section icon="✅" label="Richtig platziert" count={stats.placedCorrect.length}>
        {stats.placedCorrect.map((s, i) => (
          <SongRow key={`c-${i}`} song={s} onReportSong={onReportSong} />
        ))}
      </Section>
      <Section icon="❌" label="Falsch platziert" count={stats.placedWrong.length}>
        {stats.placedWrong.map((s, i) => (
          <SongRow key={`w-${i}`} song={s} onReportSong={onReportSong} />
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
            <SongRow
              key={`n-${i}`}
              song={s}
              subline="Titel + Interpret erkannt"
              onReportSong={onReportSong}
            />
          ) : (
            <Text key={`n-${i}`} style={styles.songSub}>
              🪙 Nickel erhalten
            </Text>
          )
        )}
      </Section>
    </View>
  );

  return (
    <StatsAccordionShell
      name={name}
      isWinner={isWinner}
      headerRight={headerRight}
      body={body}
    >
      {children}
    </StatsAccordionShell>
  );
}

// --- Bingo ---------------------------------------------------------------------

/** "● Jahrzehnt" subline in the category's cell color. */
const bingoRows = (
  entries: BingoStatEntry[],
  difficulty?: BingoDifficulty,
  onReportSong?: ReportStatsSong
) =>
  entries.map((e, i) => (
    <SongRow
      key={`${e.song.title}-${i}`}
      song={e.song}
      subline={`● ${bingoCategoryLabel(e.category, difficulty)}`}
      sublineColor={BINGO_CATEGORY_COLOR[e.category]}
      onReportSong={onReportSong}
    />
  ));

export function PlayerBingoStatsAccordion({
  name,
  isWinner,
  headerRight,
  stats,
  board,
  difficulty,
  onReportSong,
}: {
  name: string;
  isWinner?: boolean;
  /** Short right-aligned header info, e.g. "9 / 16 markiert". */
  headerRight?: string;
  stats: PlayerBingoStats;
  /** THIS player's final board, shown above the category list when expanded. */
  board?: { cells: BingoBoard; size: number };
  /** Game difficulty - two categories label differently in 'hard'. */
  difficulty?: BingoDifficulty;
  /** "Song melden" flag on every song item (host only). */
  onReportSong?: ReportStatsSong;
}) {
  const body = (
    <View style={styles.body}>
      {/* Display-only board (smaller cells than in-game, so 5x5 fits the
          padded card width). */}
      {board && (
        <View style={styles.boardWrap}>
          <BingoGrid board={board.cells} size={board.size} cellSize={44} />
        </View>
      )}
      {isEmptyBingoStats(stats) ? (
        <Text style={styles.emptyLine}>Keine Runden in dieser Partie.</Text>
      ) : (
        <>
          <Section icon="✅" label="Erfüllt" count={stats.fulfilled.length}>
            {bingoRows(stats.fulfilled, difficulty, onReportSong)}
          </Section>
          <Section icon="❌" label="Nicht erfüllt" count={stats.missed.length}>
            {bingoRows(stats.missed, difficulty, onReportSong)}
          </Section>
        </>
      )}
    </View>
  );

  return (
    <StatsAccordionShell
      name={name}
      isWinner={isWinner}
      headerRight={headerRight}
      body={body}
    />
  );
}

// --- Timeline-Quiz ---------------------------------------------------------------

export function PlayerQuizStatsAccordion({
  name,
  isWinner,
  headerRight,
  stats,
  onReportSong,
}: {
  name: string;
  isWinner?: boolean;
  /** Short right-aligned header info, e.g. "7 / 15 richtig". */
  headerRight?: string;
  stats: PlayerQuizStats;
  /** "Song melden" flag on every song item (host only). */
  onReportSong?: ReportStatsSong;
}) {
  const rows = (songs: typeof stats.correct, prefix: string) =>
    songs.map((s, i) => (
      <SongRow key={`${prefix}-${i}`} song={s} onReportSong={onReportSong} />
    ));

  const body = isEmptyQuizStats(stats) ? (
    <Text style={styles.emptyLine}>Keine Runden in dieser Partie.</Text>
  ) : (
    <View style={styles.body}>
      <Section icon="✅" label="Richtig geschätzt" count={stats.correct.length}>
        {rows(stats.correct, 'c')}
      </Section>
      <Section icon="❌" label="Falsch geschätzt" count={stats.wrong.length}>
        {rows(stats.wrong, 'w')}
      </Section>
    </View>
  );

  return (
    <StatsAccordionShell
      name={name}
      isWinner={isWinner}
      headerRight={headerRight}
      body={body}
    />
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
  boardWrap: { alignItems: 'center', paddingVertical: 4 },
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
  songRight: { alignItems: 'flex-end', gap: 2 },
  flagBtn: { paddingHorizontal: 2 },
  flagText: { fontSize: 12 },
  songYear: { color: COLORS.accent, fontWeight: '900', fontSize: 16 },
});
