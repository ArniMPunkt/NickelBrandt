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
  BingoDifficulty,
  BingoRoundSpec,
} from '../types/online';

/** Active category rotation = the five cell colors. */
export const BINGO_CATEGORIES: BingoCategoryType[] = [
  'decade',
  'before_after_2000',
  'year_guess',
  'title_artist',
  'band_or_solo',
];

/**
 * Default answer window per round (all clients arm the resolve trigger on
 * this). Configurable per game via the lobby's Song-Zeit slider
 * (mode_config.bingoSongSeconds); this constant doubles as the fallback for
 * game_state rows written before the setting existed.
 */
export const BINGO_ROUND_SECONDS = 30;

/** Song-Zeit slider bounds (lobby config). */
export const BINGO_SONG_SECONDS_MIN = 30;
export const BINGO_SONG_SECONDS_MAX = 75;

/**
 * Window after resolution in which correct players PICK the cell to mark
 * (strategic choice instead of the old random mark). Long enough to read the
 * reveal + tap a cell, short enough that one idle player can't stall the
 * round; on timeout the player's own client auto-picks a random free cell.
 */
export const BINGO_PICK_SECONDS = 15;

/** Layout cap for decade multiple-choice buttons (2 rows of 4). */
export const BINGO_DECADE_OPTIONS_MAX = 8;

/** Allowed deviation for the year-guess category (easy difficulty). */
export const BINGO_YEAR_TOLERANCE = 3;
/** Hard difficulty: before_after_2000 becomes a numeric year guess with this
 *  tolerance (the binary question would be too easy for a hard game). */
export const BINGO_HARD_EPOCH_TOLERANCE = 2;

/**
 * Fallback slider bounds for the year-guess input - only used for games whose
 * game_state predates the pool-derived bounds (bingoYearMin/Max, see
 * yearBounds). New games always show the pool's real min/max year instead.
 */
export const BINGO_YEAR_MIN = 1950;
export const BINGO_YEAR_MAX = 2025;

/**
 * Min/max song year of a card set - the year-guess slider's VISIBLE range,
 * computed once at game start and synced via game_state (same idea as
 * decadeRange: a scale reaching back to the 1950s is pointless/misleading on
 * a 1995+ pool). Display only - the ±tolerance grading in evaluateBingoAnswer
 * is untouched by these bounds.
 */
export function yearBounds(cards: GameCard[]): { min: number; max: number } {
  if (cards.length === 0) return { min: BINGO_YEAR_MIN, max: BINGO_YEAR_MAX };
  let min = Infinity;
  let max = -Infinity;
  for (const c of cards) {
    if (c.year < min) min = c.year;
    if (c.year > max) max = c.year;
  }
  return { min, max };
}

/**
 * Category display name, difficulty-aware: two slots ask a different question
 * in 'hard' (pink -> year ±2, orange -> exact year) and the green slot relaxes
 * to artist-only in 'easy'. Every display site (round header, review, legend,
 * stats) goes through this so labels always match what was actually asked.
 */
export function bingoCategoryLabel(
  type: BingoCategoryType,
  difficulty: BingoDifficulty = 'easy'
): string {
  const hard = difficulty === 'hard';
  switch (type) {
    case 'decade':
      return 'Jahrzehnt';
    case 'before_after_2000':
      return hard ? `Jahr schätzen (±${BINGO_HARD_EPOCH_TOLERANCE})` : 'Vor oder ab 2000?';
    case 'year_guess':
      return hard ? 'Genaues Jahr' : `Jahr schätzen (±${BINGO_YEAR_TOLERANCE})`;
    case 'title_artist':
      return hard ? 'Titel + Interpret' : 'Interpret';
    case 'band_or_solo':
      return 'Gruppe oder Solo?';
  }
}

/** The answer payloads stored in round_answers.answer (jsonb). */
export type BingoAnswer =
  | { kind: 'decade'; decade: number }
  | { kind: 'before_after_2000'; after2000: boolean }
  // Also submitted for the HARD before_after_2000 variant (the question IS a
  // year guess there; grading keys off the round spec, not the kind).
  | { kind: 'year_guess'; year: number }
  // Free text (what the player believes title/artist are); graded by the
  // HOST in the review phase, not automatically.
  | { kind: 'title_artist'; text: string }
  // Binary claim (true = Gruppe/Band); graded against the host's one-tap
  // truth in the review phase.
  | { kind: 'band_or_solo'; group: boolean };

/**
 * Total duration of the spin stage animation ("digitale Discokugel"): the
 * wheel decelerates for most of it and holds on the landed color at the end.
 * The answer deadline is set to spin start + this + BINGO_ROUND_SECONDS, so
 * the full answer window only begins once the wheel has stopped.
 */
export const BINGO_SPIN_MS = 6200;

/**
 * The 3-2-1 "get ready" beat between the wheel landing on the category and the
 * new song starting. The previous song keeps playing through the wheel AND this
 * countdown, then is replaced by the round's song exactly when it ends - so the
 * song only ever changes AFTER the category is revealed. The answer deadline
 * includes this (spin + countdown + BINGO_ROUND_SECONDS), so it costs no answer
 * time. Shared by the screen (UI + host playback trigger) and the server-side
 * deadline in triggerBingoSpin, so both agree on the timing.
 */
export const BINGO_COUNTDOWN_MS = 3000;

/**
 * If the designated spinner hasn't pressed within this window, the button
 * opens for EVERYONE (an absent player must never stall the game - same
 * philosophy as the review/pick timeouts).
 */
export const BINGO_SPIN_OPEN_ALL_MS = 20000;

/**
 * Host grading window for title_artist free texts. Long enough for a short
 * group discussion of edge cases (typos, half-right answers), short enough
 * that an absent host can't stall the game: after the deadline ANY client
 * resolves, unjudged answers fall back to the honor rule (see supabase.ts).
 */
export const BINGO_REVIEW_SECONDS = 45;

/** Defensive text extraction from a title_artist answer payload (jsonb). */
export function titleAnswerText(answer: unknown): string {
  const t = (answer as { text?: unknown } | null)?.text;
  return typeof t === 'string' ? t : '';
}

/** Defensive claim extraction from a band_or_solo answer payload (jsonb);
 *  null when the payload is missing/malformed (counts as no answer). */
export function bandAnswerGroup(answer: unknown): boolean | null {
  const g = (answer as { group?: unknown } | null)?.group;
  return typeof g === 'boolean' ? g : null;
}

/**
 * One individually randomized board: the five colors repeated to fill size²
 * cells (25 -> exactly 5 each; 16 -> 4/3/3/3/3), then shuffled. The category
 * ORDER is shuffled per board first, so on 4×4 which color gets the fourth
 * cell differs from player to player instead of always favoring the same one.
 */
export function generateBingoBoard(size: 4 | 5): BingoBoard {
  const order = shuffle([...BINGO_CATEGORIES]);
  const pool: BingoCategoryType[] = [];
  for (let i = 0; i < size * size; i++) {
    pool.push(order[i % order.length]);
  }
  return shuffle(pool).map((color) => ({ color, marked: false }));
}

/** The decade (start year) a card belongs to, e.g. 1997 -> 1990. */
export function decadeOf(year: number): number {
  return Math.floor(year / 10) * 10;
}

/**
 * The decades that ACTUALLY occur in a card set, sorted ascending. Computed
 * once at game start and stored in game_state, so every round offers the
 * same, pool-matched choices.
 *
 * Deliberately no longer gap-filled: the old contiguous min..max range avoided
 * leaking "this decade has no songs", but on pools with sparse decades (e.g.
 * one 1949 outlier in a 90s/00s pool) most options were dead - the category
 * felt pointless. Only real decades show now; pools are curated to contain at
 * least 4 distinct ones, so no padding/minimum logic is needed.
 */
export function decadeRange(cards: GameCard[]): number[] {
  const present = new Set<number>();
  for (const c of cards) present.add(decadeOf(c.year));
  return [...present].sort((a, b) => a - b);
}

/**
 * The decade multiple-choice options for one round. With a pool list the
 * options are ALL decades actually present in the pool, chronological (stable
 * across rounds); above the layout cap a random contiguous window that
 * contains the correct decade is cut out (random offset, so the correct one
 * doesn't always sit in the middle). Without a list (defensive fallback) the
 * old behavior: correct + 3 nearby distractors, shuffled.
 */
function decadeOptionsFor(correct: number, decadePool?: number[]): number[] {
  if (decadePool && decadePool.length >= 2) {
    let range = decadePool.includes(correct)
      ? [...decadePool]
      : [...decadePool, correct].sort((a, b) => a - b);
    if (range.length > BINGO_DECADE_OPTIONS_MAX) {
      const ci = range.indexOf(correct);
      const minStart = Math.max(0, ci - (BINGO_DECADE_OPTIONS_MAX - 1));
      const maxStart = Math.min(ci, range.length - BINGO_DECADE_OPTIONS_MAX);
      const start = minStart + Math.floor(Math.random() * (maxStart - minStart + 1));
      range = range.slice(start, start + BINGO_DECADE_OPTIONS_MAX);
    }
    return range;
  }
  const candidates: number[] = [];
  for (let d = correct - 40; d <= correct + 40; d += 10) {
    if (d !== correct && d >= 1920 && d <= 2020) candidates.push(d);
  }
  return shuffle([correct, ...shuffle(candidates).slice(0, 3)]);
}

/**
 * Draw the round's category for a card. For 'decade' the multiple-choice
 * options are generated here and synced via game_state, so every client shows
 * the same choices. `decadePool` is the game's pool decade span (decadeRange).
 * The difficulty is baked into the spec as a tolerance (hard: pink becomes a
 * year guess ±2, orange demands the exact year), so answer UI and grading key
 * off the synced spec alone - a mid-game version skew can't split the rules.
 */
export function drawBingoRound(
  card: GameCard,
  decadePool?: number[],
  difficulty: BingoDifficulty = 'easy'
): BingoRoundSpec {
  const type = BINGO_CATEGORIES[Math.floor(Math.random() * BINGO_CATEGORIES.length)];
  if (type === 'decade') {
    return { type, decadeOptions: decadeOptionsFor(decadeOf(card.year), decadePool) };
  }
  if (type === 'before_after_2000' && difficulty === 'hard') {
    return { type, tolerance: BINGO_HARD_EPOCH_TOLERANCE };
  }
  if (type === 'year_guess') {
    return { type, tolerance: difficulty === 'hard' ? 0 : BINGO_YEAR_TOLERANCE };
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
      // Hard variant (spec carries a tolerance): the question was a numeric
      // year guess, graded exactly like year_guess.
      if (round.tolerance != null) {
        const y = (a as { year?: unknown }).year;
        return typeof y === 'number' && Math.abs(y - card.year) <= round.tolerance;
      }
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
      // Not auto-gradable anymore (host review decides); this fallback mirrors
      // the honor rule and is only hit when a title round bypasses the review.
      return titleAnswerText(a).trim().length > 0;
    case 'band_or_solo':
      // Same situation: the host's truth decides in resolveBingoRound; this
      // honor fallback only fires when a band round bypasses the review.
      return bandAnswerGroup(a) != null;
  }
}

/** Indices of all FREE cells of one color (the pickable cells after a win). */
export function freeCellIndices(board: BingoBoard, color: BingoCategoryType): number[] {
  return board
    .map((cell, i) => (!cell.marked && cell.color === color ? i : -1))
    .filter((i) => i >= 0);
}

/** Immutably mark one cell. */
export function markCell(board: BingoBoard, index: number): BingoBoard {
  return board.map((cell, i) => (i === index ? { ...cell, marked: true } : cell));
}

/** Number of marked cells ("picked" detection compares this to expectedMarks). */
export function countMarked(board?: BingoBoard | null): number {
  return (board ?? []).filter((c) => c.marked).length;
}

/**
 * All completed lines (rows, columns, diagonals) as cell-index arrays, each in
 * draw order (left->right / top->bottom). Used by the win-line reveal to trace
 * the winning line; hasBingo stays the cheap boolean check.
 */
export function winningLines(board: BingoBoard, size: number): number[][] {
  const isMarked = (i: number) => !!board[i]?.marked;
  const lines: number[][] = [];
  for (let r = 0; r < size; r++) {
    const line = Array.from({ length: size }, (_, c) => r * size + c);
    if (line.every(isMarked)) lines.push(line);
  }
  for (let c = 0; c < size; c++) {
    const line = Array.from({ length: size }, (_, r) => r * size + c);
    if (line.every(isMarked)) lines.push(line);
  }
  const d1 = Array.from({ length: size }, (_, i) => i * size + i);
  if (d1.every(isMarked)) lines.push(d1);
  const d2 = Array.from({ length: size }, (_, i) => i * size + (size - 1 - i));
  if (d2.every(isMarked)) lines.push(d2);
  return lines;
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
