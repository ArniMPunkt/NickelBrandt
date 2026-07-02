/**
 * Pure Bingo-mode logic (no React, no IO - like cards.ts). Board generation,
 * the per-round category draw ("digitale Discokugel"), answer grading, cell
 * marking and win detection. The Online service (supabase.ts) and the
 * BingoGameScreen build on these; grading runs on whichever client wins the
 * resolve claim, so everything here must be deterministic given its inputs
 * (the only randomness is in generate/draw/mark, which run exactly once).
 */
import { shuffle } from './cards';
import type { GameCard } from '../types/game';
import type {
  BingoBoard,
  BingoCategoryType,
  BingoRoundSpec,
} from '../types/online';

/** Active category rotation = the four cell colors. See BingoCategoryType for
 *  why 'band_or_solo' is not (yet) part of it. */
export const BINGO_CATEGORIES: BingoCategoryType[] = [
  'decade',
  'before_after_2000',
  'year_guess',
  'title_artist',
];

/** Answer window per round (all clients arm the resolve trigger on this). */
export const BINGO_ROUND_SECONDS = 30;

/** Allowed deviation for the year-guess category. */
export const BINGO_YEAR_TOLERANCE = 3;

/** Slider bounds for the year-guess input. */
export const BINGO_YEAR_MIN = 1950;
export const BINGO_YEAR_MAX = 2025;

export const BINGO_CATEGORY_LABEL: Record<BingoCategoryType, string> = {
  decade: 'Jahrzehnt',
  before_after_2000: 'Vor oder ab 2000?',
  year_guess: `Jahr schätzen (±${BINGO_YEAR_TOLERANCE})`,
  title_artist: 'Titel + Interpret',
};

/** The answer payloads stored in round_answers.answer (jsonb). */
export type BingoAnswer =
  | { kind: 'decade'; decade: number }
  | { kind: 'before_after_2000'; after2000: boolean }
  | { kind: 'year_guess'; year: number }
  | { kind: 'title_artist'; claim: boolean };

/**
 * One individually randomized board: the four colors repeated to fill size²
 * cells (16 -> exactly 4 each; 25 -> 6/6/6/7), then shuffled.
 */
export function generateBingoBoard(size: 4 | 5): BingoBoard {
  const pool: BingoCategoryType[] = [];
  for (let i = 0; i < size * size; i++) {
    pool.push(BINGO_CATEGORIES[i % BINGO_CATEGORIES.length]);
  }
  return shuffle(pool).map((color) => ({ color, marked: false }));
}

/** The decade (start year) a card belongs to, e.g. 1997 -> 1990. */
export function decadeOf(year: number): number {
  return Math.floor(year / 10) * 10;
}

/**
 * Draw the round's category for a card. For 'decade' the multiple-choice
 * options are generated here (correct decade + 3 nearby distractors, shuffled)
 * and synced via game_state, so every client shows the same choices.
 */
export function drawBingoRound(card: GameCard): BingoRoundSpec {
  const type = BINGO_CATEGORIES[Math.floor(Math.random() * BINGO_CATEGORIES.length)];
  if (type === 'decade') {
    const correct = decadeOf(card.year);
    // Candidate decades around the correct one (clamped to a sane range).
    const candidates: number[] = [];
    for (let d = correct - 40; d <= correct + 40; d += 10) {
      if (d !== correct && d >= 1920 && d <= 2020) candidates.push(d);
    }
    const distractors = shuffle(candidates).slice(0, 3);
    return { type, decadeOptions: shuffle([correct, ...distractors]) };
  }
  if (type === 'year_guess') {
    return { type, tolerance: BINGO_YEAR_TOLERANCE };
  }
  return { type };
}

/**
 * Grade one submitted answer against the card. Answers come from jsonb, so the
 * payload is defensively type-checked. title_artist follows the Nickel honor
 * pattern: the player's own claim counts directly.
 */
export function evaluateBingoAnswer(
  round: BingoRoundSpec,
  card: GameCard,
  answer: unknown
): boolean {
  const a = answer as Partial<BingoAnswer & Record<string, unknown>> | null;
  if (!a || typeof a !== 'object') return false;
  switch (round.type) {
    case 'decade':
      return (a as { decade?: unknown }).decade === decadeOf(card.year);
    case 'before_after_2000': {
      const v = (a as { after2000?: unknown }).after2000;
      return typeof v === 'boolean' && v === (card.year >= 2000);
    }
    case 'year_guess': {
      const v = (a as { year?: unknown }).year;
      return (
        typeof v === 'number' &&
        Math.abs(v - card.year) <= (round.tolerance ?? BINGO_YEAR_TOLERANCE)
      );
    }
    case 'title_artist':
      return (a as { claim?: unknown }).claim === true;
  }
}

/**
 * Mark one random FREE cell of the round's color. Returns the new board and
 * which index was marked, or markedIndex null when no free cell of that color
 * is left (correct answer, but nothing to gain).
 */
export function markRandomFreeCell(
  board: BingoBoard,
  color: BingoCategoryType
): { board: BingoBoard; markedIndex: number | null } {
  const free = board
    .map((cell, i) => (!cell.marked && cell.color === color ? i : -1))
    .filter((i) => i >= 0);
  if (free.length === 0) return { board, markedIndex: null };
  const idx = free[Math.floor(Math.random() * free.length)];
  return {
    board: board.map((cell, i) => (i === idx ? { ...cell, marked: true } : cell)),
    markedIndex: idx,
  };
}

/** True when any full row, column or diagonal is marked. */
export function hasBingo(board: BingoBoard, size: number): boolean {
  const marked = (r: number, c: number) => !!board[r * size + c]?.marked;
  for (let r = 0; r < size; r++) {
    if (Array.from({ length: size }, (_, c) => marked(r, c)).every(Boolean)) return true;
  }
  for (let c = 0; c < size; c++) {
    if (Array.from({ length: size }, (_, r) => marked(r, c)).every(Boolean)) return true;
  }
  if (Array.from({ length: size }, (_, i) => marked(i, i)).every(Boolean)) return true;
  if (Array.from({ length: size }, (_, i) => marked(i, size - 1 - i)).every(Boolean)) return true;
  return false;
}
