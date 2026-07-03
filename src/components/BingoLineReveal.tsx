/**
 * BingoLineReveal - automatic interstitial before the bingo victory screen
 * (same principle as FinalCardReveal in the hitster mode): the winner's board
 * is shown, the cells of the winning line flash up one after another, then a
 * glowing neon line sweeps across them. Fixed duration, no tap required.
 *
 * Multiple winners are shown SEQUENTIALLY (one board after the other, ~2s
 * each): two 4x4/5x5 boards side by side would shrink the cells to
 * unreadable size on a phone, and the sequence keeps the "wow" moment per
 * person. If a board has several completed lines at once, the first is traced
 * (the reveal is a flourish, not a scoreboard).
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { winningLines } from '../game/bingo';
import { BINGO_CATEGORY_COLOR, COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import type { BingoBoard } from '../types/online';

const CELL = 56;
const GAP = 6;
const PULSE_STAGGER_MS = 110;
const PULSE_MS = 260;
const LINE_MS = 550;
const HOLD_MS = 800;

export interface BingoRevealWinner {
  name: string;
  board: BingoBoard;
}

export function BingoLineReveal({
  winners,
  size,
  onDone,
}: {
  winners: BingoRevealWinner[];
  size: number;
  onDone: () => void;
}) {
  const [wi, setWi] = useState(0);
  const winner = winners[wi];
  if (!winner) return null; // defensive; the caller guards non-empty
  return (
    // key remounts the inner reveal per winner -> fresh animation values.
    <SingleWinnerReveal
      key={wi}
      winner={winner}
      size={size}
      onDone={() => (wi + 1 < winners.length ? setWi(wi + 1) : onDone())}
    />
  );
}

function SingleWinnerReveal({
  winner,
  size,
  onDone,
}: {
  winner: BingoRevealWinner;
  size: number;
  onDone: () => void;
}) {
  const line = winningLines(winner.board, size)[0] ?? [];
  const pulses = useRef(line.map(() => new Animated.Value(0))).current;
  const sweep = useRef(new Animated.Value(0)).current;

  // Mount-only sequence with full cleanup, so onDone can never fire after
  // unmount (FinalCardReveal pattern).
  useEffect(() => {
    const seq = Animated.sequence([
      Animated.stagger(
        PULSE_STAGGER_MS,
        pulses.map((v) =>
          Animated.timing(v, { toValue: 1, duration: PULSE_MS, useNativeDriver: true })
        )
      ),
      Animated.timing(sweep, { toValue: 1, duration: LINE_MS, useNativeDriver: true }),
    ]);
    seq.start();
    const total =
      PULSE_STAGGER_MS * Math.max(0, line.length - 1) + PULSE_MS + LINE_MS + HOLD_MS;
    const t = setTimeout(onDone, total);
    return () => {
      seq.stop();
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const W = size * CELL + (size - 1) * GAP;
  const rows = Array.from({ length: size }, (_, r) =>
    winner.board.slice(r * size, (r + 1) * size)
  );

  // The glowing line: a bar through the centers of first and last line cell,
  // rotated to the line's angle, growing from the start cell (scaleX pivots
  // at the center, so a translateX of (s-1)*len/2 pins the start edge).
  let bar = null;
  if (line.length >= 2) {
    const pos = (i: number) => ({
      x: (i % size) * (CELL + GAP) + CELL / 2,
      y: Math.floor(i / size) * (CELL + GAP) + CELL / 2,
    });
    const a = pos(line[0]);
    const b = pos(line[line.length - 1]);
    const len = Math.hypot(b.x - a.x, b.y - a.y) + CELL * 0.75;
    const angleDeg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    const translateX = Animated.multiply(Animated.subtract(sweep, 1), len / 2);
    bar = (
      <Animated.View
        pointerEvents="none"
        style={[
          styles.lineBar,
          glow(COLORS.text, { radius: 14, opacity: 0.9 }),
          {
            width: len,
            left: (a.x + b.x) / 2 - len / 2,
            top: (a.y + b.y) / 2 - 5,
            transform: [{ rotate: `${angleDeg}deg` }, { translateX }, { scaleX: sweep }],
          },
        ]}
      />
    );
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>🎉 BINGO!</Text>
      <Text style={styles.winnerName}>{winner.name}</Text>
      <View style={{ width: W, height: W }}>
        <View style={styles.grid}>
          {rows.map((cells, r) => (
            <View key={`row-${r}`} style={styles.gridRow}>
              {cells.map((cell, c) => {
                const idx = r * size + c;
                const color = BINGO_CATEGORY_COLOR[cell.color];
                const li = line.indexOf(idx);
                const pulse = li >= 0 ? pulses[li] : null;
                return (
                  <Animated.View
                    key={`cell-${r}-${c}`}
                    style={[
                      styles.cell,
                      { borderColor: color },
                      cell.marked && {
                        backgroundColor: color,
                        ...glow(color, { radius: 8, opacity: 0.8 }),
                      },
                      pulse && {
                        transform: [
                          {
                            scale: pulse.interpolate({
                              inputRange: [0, 0.6, 1],
                              outputRange: [1, 1.3, 1.12],
                            }),
                          },
                        ],
                      },
                    ]}
                  >
                    {cell.marked && <Text style={styles.cellCheck}>✓</Text>}
                    {pulse && (
                      <Animated.View
                        pointerEvents="none"
                        style={[
                          StyleSheet.absoluteFillObject,
                          styles.cellFlash,
                          {
                            opacity: pulse.interpolate({
                              inputRange: [0, 0.5, 1],
                              outputRange: [0, 0.9, 0.45],
                            }),
                          },
                        ]}
                      />
                    )}
                  </Animated.View>
                );
              })}
            </View>
          ))}
        </View>
        {bar}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    padding: 24,
  },
  title: {
    fontSize: 40,
    fontWeight: '900',
    color: COLORS.accent,
    letterSpacing: 2,
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 16,
  },
  winnerName: {
    fontSize: 26,
    fontWeight: '900',
    color: COLORS.primary,
    textAlign: 'center',
    marginBottom: 10,
    textShadowColor: COLORS.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 14,
  },
  grid: { gap: GAP },
  gridRow: { flexDirection: 'row', gap: GAP },
  cell: {
    width: CELL,
    height: CELL,
    borderRadius: 12,
    borderWidth: 3,
    backgroundColor: COLORS.backgroundAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellCheck: { color: COLORS.background, fontSize: 26, fontWeight: '900' },
  cellFlash: { backgroundColor: COLORS.text, borderRadius: 9 },
  lineBar: {
    position: 'absolute',
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.text,
  },
});
