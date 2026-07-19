/**
 * BingoGrid - the bingo board visualization (category-colored bordered cells,
 * marked = filled + check). Extracted from BingoGameScreen so the post-game
 * statistics accordions can show every player's final board too.
 *
 * Interaction is opt-in (selectable/onPickCell for the in-game pick window),
 * so the display-only statistics use needs no separate variant. cellSize
 * scales the cells (default = in-game size; the accordions use a smaller one
 * so a 5x5 board fits inside the padded card).
 */
import { StyleSheet, Text, View } from 'react-native';
import { PressableButton } from './PressableButton';
import { BINGO_CATEGORY_COLOR, COLORS } from '../theme/colors';
import { glow } from '../theme/glow';
import type { BingoBoard } from '../types/online';

const DEFAULT_CELL = 56;

export function BingoGrid({
  board,
  size,
  cellSize = DEFAULT_CELL,
  selectable,
  onPickCell,
}: {
  board: BingoBoard;
  size: number;
  /** Cell edge length in px (glyphs scale along). */
  cellSize?: number;
  /** Indices the owner may tap during the pick window (glowing "+" cells). */
  selectable?: number[];
  onPickCell?: (index: number) => void;
}) {
  const cellDims = { width: cellSize, height: cellSize };
  const glyphSize = { fontSize: Math.round(cellSize * 0.46) };
  const rows = Array.from({ length: size }, (_, r) =>
    board.slice(r * size, (r + 1) * size)
  );
  return (
    <View style={styles.grid}>
      {rows.map((cells, r) => (
        <View key={`row-${r}`} style={styles.gridRow}>
          {cells.map((cell, c) => {
            const idx = r * size + c;
            const color = BINGO_CATEGORY_COLOR[cell.color];
            const pickable = !!onPickCell && !!selectable?.includes(idx);
            if (pickable) {
              return (
                <PressableButton
                  key={`cell-${r}-${c}`}
                  style={[styles.cell, cellDims, { borderColor: color }, glow(color, { radius: 10, opacity: 0.9 })]}
                  onPress={() => onPickCell(idx)}
                >
                  <Text style={[styles.cellPick, glyphSize, { color }]}>+</Text>
                </PressableButton>
              );
            }
            return (
              <View
                key={`cell-${r}-${c}`}
                style={[
                  styles.cell,
                  cellDims,
                  { borderColor: color },
                  cell.marked && { backgroundColor: color, ...glow(color, { radius: 8, opacity: 0.8 }) },
                ]}
              >
                {cell.marked && <Text style={[styles.cellCheck, glyphSize]}>✓</Text>}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { gap: 6, alignSelf: 'center' },
  gridRow: { flexDirection: 'row', gap: 6 },
  cell: {
    borderRadius: 12,
    borderWidth: 3,
    backgroundColor: COLORS.backgroundAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellCheck: { color: COLORS.background, fontWeight: '900' },
  cellPick: { fontWeight: '900' },
});
